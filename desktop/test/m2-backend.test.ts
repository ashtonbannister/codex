import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  emptyWorkspace,
  type Run,
  type Thread,
  type VerificationResult,
} from "../src/shared/types";
import { buildRunContext } from "../src/main/services/context";
import {
  captureMemoryFingerprint,
  normalizeMemoryFilePath,
} from "../src/main/services/memory-source";
import {
  validateThreadUpdate,
  validateVerificationProfileInput,
} from "../src/main/services/validation";
import {
  validateWorkspaceState,
  WorkspaceService,
} from "../src/main/services/workspace-service";

const fakeCli = `
if(process.argv.includes('--version')){console.log('fake-cli 1');process.exit(0)}
if(process.argv.includes('--help')){console.log('--json --sandbox --ignore-user-config --safe-mode --restricted --permission-prompts --output-format --tools');process.exit(0)}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',value=>input+=value);
process.stdin.on('end',()=>{const request=input.split('CURRENT USER REQUEST:').at(-1);console.log(JSON.stringify({type:'thread.started',thread_id:'fake-session'}));if(request.includes('WAIT_FOR_CANCEL')){setInterval(()=>{},1000);return}if(request.includes('NUL_ERROR')){console.log(JSON.stringify({type:'turn.failed',error:{message:'failure'+String.fromCharCode(0)+'details'}}));return}if(request.includes('NUL_OUTPUT')){const raw='visible'+String.fromCharCode(0)+'output';console.log(JSON.stringify({type:'thread.started',thread_id:'session'+String.fromCharCode(0)+'x'.repeat(300)}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:raw}}));console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'fixture',aggregated_output:raw,exit_code:0}}));}else console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:request.includes('ECHO_PROMPT')?input:'Done'}}));console.log(JSON.stringify({type:'turn.completed'}))});
`;

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-m2-"));
  const repo = path.join(root, "project");
  await mkdir(repo);
  execFileSync("git", ["init", "--initial-branch=main", repo], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", repo, "config", "user.name", "Nova test"], {
    stdio: "ignore",
  });
  execFileSync(
    "git",
    ["-C", repo, "config", "user.email", "nova-test@example.invalid"],
    { stdio: "ignore" },
  );
  // Digest assertions should not inherit a runner's checkout newline policy.
  execFileSync("git", ["-C", repo, "config", "core.autocrlf", "false"], {
    stdio: "ignore",
  });
  await writeFile(path.join(repo, "README.md"), "source version one\n");
  execFileSync("git", ["-C", repo, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "initial fixture"], {
    stdio: "ignore",
  });
  const executable = path.join(root, "fake-cli.mjs");
  await writeFile(executable, fakeCli);
  const dataDir = path.join(root, "state");
  const service = new WorkspaceService(dataDir, () => undefined);
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await service.initialize();
  await service.updateSettings({
    ...DEFAULT_SETTINGS,
    codexPath: executable,
    claudePath: executable,
  });
  const project = await service.addProject(repo);
  return { service, project, repo, root, dataDir };
}

async function finishRun(service: WorkspaceService, id: string): Promise<Run> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = (await service.snapshot()).state.runs.find(
      (entry) => entry.id === id,
    )!;
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Fake agent did not finish.");
}

async function finishCheck(
  service: WorkspaceService,
  id: string,
): Promise<VerificationResult> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const check = (await service.snapshot()).state.verifications.find(
      (entry) => entry.id === id,
    )!;
    if (check.status !== "running") return check;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Fake check did not finish.");
}

async function build(
  service: WorkspaceService,
  projectId: string,
): Promise<Run> {
  const run = await service.startRun({
    projectId,
    provider: "codex",
    mode: "build",
    prompt: "Prepare a worktree",
  });
  const finished = await finishRun(service, run.id);
  assert.equal(finished.status, "completed");
  return finished;
}

test("legacy schema one loads empty verification collections without dropping existing data", () => {
  const {
    verificationProfiles: _profiles,
    verifications: _checks,
    ...legacy
  } = emptyWorkspace();
  const restored = validateWorkspaceState(legacy);
  assert.deepEqual(restored.verificationProfiles, []);
  assert.deepEqual(restored.verifications, []);
  assert.throws(
    () => validateWorkspaceState({ ...legacy, verifications: null }),
    /Invalid saved/,
  );
});

test("provider NUL text and bounded opaque session metadata survive save and restart", async (t) => {
  const { service, project, dataDir } = await fixture(t);
  const run = await finishRun(
    service,
    (
      await service.startRun({
        projectId: project.id,
        provider: "codex",
        mode: "plan",
        prompt: "NUL_OUTPUT",
      })
    ).id,
  );
  const failed = await finishRun(
    service,
    (
      await service.startRun({
        projectId: project.id,
        provider: "codex",
        mode: "plan",
        prompt: "NUL_ERROR",
      })
    ).id,
  );
  assert.ok(
    run.events.some(
      (event) => event.kind === "message" && event.text.includes("\0"),
    ),
  );
  assert.ok(
    run.events.some(
      (event) => event.kind === "tool" && event.text.includes("\0"),
    ),
  );
  assert.equal(run.providerSessionId?.length, 200);
  assert.ok(failed.error?.includes("\0"));
  await service.dispose();
  const stateFile = path.join(dataDir, "workspace.json");
  const legacy = JSON.parse(await readFile(stateFile, "utf8"));
  legacy.runs.find((entry: Run) => entry.id === run.id).providerSessionId +=
    "old-uncapped-session-metadata";
  await writeFile(stateFile, JSON.stringify(legacy));
  const reopened = new WorkspaceService(dataDir, () => undefined);
  try {
    await reopened.initialize();
    const restored = (await reopened.snapshot()).state;
    assert.deepEqual(
      restored.runs.find((entry) => entry.id === run.id)?.events,
      run.events,
    );
    assert.equal(
      restored.runs.find((entry) => entry.id === run.id)?.providerSessionId,
      run.providerSessionId,
    );
    assert.equal(
      restored.runs.find((entry) => entry.id === failed.id)?.error,
      failed.error,
    );
  } finally {
    await reopened.dispose();
  }
});

test("thread and profile validation preserves literal args and rejects ambiguous command display", () => {
  assert.throws(
    () => validateThreadUpdate({ id: "t", pinned: "yes" }),
    /true or false/,
  );
  assert.throws(() => validateThreadUpdate({ id: "t" }), /field/);
  const input = {
    projectId: "p",
    name: "Tests",
    executable: process.execPath,
    args: ["", "  literal spaces  ", "line\nbreak"],
    timeoutMinutes: 1,
  };
  assert.deepEqual(validateVerificationProfileInput(input).args, input.args);
  assert.throws(
    () => validateVerificationProfileInput({ ...input, args: ["bad\0arg"] }),
    /null bytes/,
  );
  assert.throws(
    () =>
      validateVerificationProfileInput({
        ...input,
        name: "Hidden\u202ecommand",
      }),
    /bidirectional/,
  );
  assert.throws(
    () =>
      validateVerificationProfileInput({ ...input, executable: "node\nother" }),
    /control/,
  );
  assert.throws(
    () => validateVerificationProfileInput({ ...input, timeoutMinutes: 0 }),
    /timeout/,
  );
});

test("thread rename, pin, archive and restore persist while active work prevents archive", async (t) => {
  const { service, project, dataDir } = await fixture(t);
  const run = await build(service, project.id);
  await service.updateThread({
    id: run.threadId,
    title: "Engine architecture",
    pinned: true,
  });
  const active = await service.startRun({
    projectId: project.id,
    threadId: run.threadId,
    provider: "codex",
    mode: "plan",
    prompt: "WAIT_FOR_CANCEL",
  });
  await assert.rejects(
    service.updateThread({ id: run.threadId, archived: true }),
    /active/,
  );
  await service.cancelRun(active.id);
  const archived = await service.updateThread({
    id: run.threadId,
    archived: true,
  });
  assert.ok(archived.archivedAt);
  assert.equal(archived.pinned, true);
  await assert.rejects(
    service.startRun({
      projectId: project.id,
      threadId: run.threadId,
      provider: "codex",
      mode: "plan",
      prompt: "Do not run",
    }),
    /Restore/,
  );
  assert.equal(
    await readFile(path.join(run.worktreePath!, "README.md"), "utf8"),
    "source version one\n",
  );
  await service.updateThread({ id: run.threadId, archived: false });
  const saved = validateWorkspaceState(
    JSON.parse(await readFile(path.join(dataDir, "workspace.json"), "utf8")),
  );
  assert.equal(saved.threads[0].title, "Engine architecture");
  assert.equal(saved.threads[0].archivedAt, undefined);
  assert.equal(saved.threads[0].pinned, true);
});

test("source-linked memory detects current, changed and missing bytes in the selected worktree", async (t) => {
  const { service, project, repo } = await fixture(t);
  const memory = await service.saveMemory({
    projectId: project.id,
    title: "Readme decision",
    content: "Preserve the source architecture",
    kind: "decision",
    source: "User review",
    filePath: "README.md",
  });
  assert.match(memory.fileSha256!, /^[a-f0-9]{64}$/);
  const run = await build(service, project.id);
  const request = {
    projectId: project.id,
    threadId: run.threadId,
    provider: "codex" as const,
    mode: "plan" as const,
    prompt: "",
  };
  assert.equal(
    (await service.previewContext(request)).memories[0].freshness,
    "current",
  );
  await writeFile(path.join(repo, "README.md"), "changed original checkout");
  assert.equal(
    (await service.previewContext(request)).memories[0].freshness,
    "current",
    "thread memory uses its worktree, not the original checkout",
  );
  const original = await service.previewContext({
    ...request,
    threadId: undefined,
  });
  assert.equal(original.memories[0].freshness, "changed");
  assert.deepEqual(original.includedMemoryIds, []);
  await rm(path.join(run.worktreePath!, "README.md"));
  const missing = await service.previewContext(request);
  assert.equal(missing.memories[0].freshness, "missing");
  assert.deepEqual(missing.omittedMemoryIds, [memory.id]);
  await assert.rejects(service.startRun(request), /Prompt is required/);
});

test("context preview is exactly the prompt launched, with honest persisted estimates", async (t) => {
  const { service, project } = await fixture(t);
  await service.saveMemory({
    projectId: project.id,
    title: "Keep scope",
    content: "No automatic merges",
    kind: "constraint",
    source: "User",
  });
  const request = {
    projectId: project.id,
    provider: "codex" as const,
    mode: "plan" as const,
    prompt: "ECHO_PROMPT",
  };
  const preview = await service.previewContext(request);
  const run = await finishRun(service, (await service.startRun(request)).id);
  assert.equal(
    run.events.find((event) => event.kind === "message")?.text,
    preview.prompt,
  );
  assert.equal(run.contextSummary?.characters, preview.prompt.length);
  assert.equal(
    run.contextSummary?.estimatedTokens,
    Math.ceil(preview.prompt.length / 4),
  );
  assert.deepEqual(run.contextMemoryIds, preview.includedMemoryIds);
  assert.ok(
    preview.warnings.some((warning) =>
      warning.includes("not been freshness-checked"),
    ),
  );
});

test("first Build previews warn that ignored local source files are absent from the future worktree", async (t) => {
  const { service, project, repo } = await fixture(t);
  await writeFile(path.join(repo, ".gitignore"), "local-source.txt\n");
  execFileSync("git", ["-C", repo, "add", ".gitignore"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "ignore local fixture"], {
    stdio: "ignore",
  });
  await writeFile(path.join(repo, "local-source.txt"), "local bytes");
  const memory = await service.saveMemory({
    projectId: project.id,
    title: "Local source",
    content: "Local note",
    kind: "note",
    source: "User",
    filePath: "local-source.txt",
  });
  const request = {
    projectId: project.id,
    provider: "codex" as const,
    mode: "build" as const,
    prompt: "Prepare isolated work",
  };
  const preview = await service.previewContext(request);
  assert.ok(
    preview.warnings.some((warning) =>
      warning.includes("Provisional Build preview"),
    ),
  );
  assert.deepEqual(preview.includedMemoryIds, [memory.id]);
  const run = await finishRun(service, (await service.startRun(request)).id);
  assert.deepEqual(run.contextMemoryIds, []);
  assert.deepEqual(run.contextSummary?.omittedMemoryIds, [memory.id]);
  assert.equal(
    (await service.previewContext({ ...request, threadId: run.threadId }))
      .memories[0].freshness,
    "missing",
  );
});

test("context selection is relevant, scoped and explicitly bounded", async () => {
  const state = emptyWorkspace();
  for (let index = 0; index < 60; index += 1)
    state.memories.push({
      id: `m${index}`,
      projectId: "p",
      title: index === 0 ? "driveshaft constraint" : `Old note ${index}`,
      content: "details ".repeat(1_000),
      kind: "note",
      source: "User",
      status: "active",
      createdAt: "now",
      updatedAt: String(index).padStart(3, "0"),
    });
  state.memories.push({
    ...state.memories[0],
    id: "other",
    projectId: "q",
    content: "OTHER_PROJECT_SECRET",
  });
  for (let index = 0; index < 5; index += 1)
    state.runs.push({
      id: `r${index}`,
      projectId: "p",
      threadId: "t",
      provider: "codex",
      mode: "plan",
      model: "",
      prompt: "x".repeat(3_000),
      status: "completed",
      createdAt: "now",
      contextMemoryIds: [],
      verification: "not-run",
      events: [
        {
          id: `e${index}`,
          at: "now",
          kind: "message",
          text: "visible ".repeat(1_000),
        },
      ],
    });
  const preview = await buildRunContext(
    state,
    { id: "t", projectId: "p" },
    "driveshaft",
  );
  assert.equal(preview.includedMemoryIds[0], "m0");
  assert.ok(preview.includedMemoryIds.length <= 12);
  assert.ok(preview.prompt.length < 35_000);
  assert.ok(!preview.prompt.includes("OTHER_PROJECT_SECRET"));
  assert.deepEqual(preview.historyRunIds, ["r2", "r3", "r4"]);
  assert.ok(preview.warnings.some((warning) => warning.includes("truncated")));
  assert.ok(preview.warnings.some((warning) => warning.includes("48")));
});

test("a concurrent first Build cannot remove an original-checkout preview warning", async (t) => {
  const { service, project } = await fixture(t);
  const plan = await finishRun(
    service,
    (
      await service.startRun({
        projectId: project.id,
        provider: "codex",
        mode: "plan",
        prompt: "Plan first",
      })
    ).id,
  );
  const internal = service as unknown as {
    getProjectPath(id: string): Promise<string>;
  };
  const original = internal.getProjectPath.bind(service);
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  internal.getProjectPath = async (id) => {
    entered();
    await gate;
    return original(id);
  };
  const request = {
    projectId: project.id,
    threadId: plan.threadId,
    provider: "codex" as const,
    mode: "build" as const,
    prompt: "Build after Plan",
  };
  const previewing = service.previewContext(request);
  await waiting;
  const run = await service.startRun(request);
  release();
  const preview = await previewing;
  assert.ok(
    preview.warnings.some((warning) =>
      warning.includes("Provisional Build preview"),
    ),
  );
  await finishRun(service, run.id);
});

test("memory fingerprints reject traversal, absolute paths, large files and outside links", async (t) => {
  const { root, repo } = await fixture(t);
  for (const name of [
    "../secret",
    "/etc/passwd",
    "C:\\secret",
    "\\\\server\\share",
    "nested/../secret",
    ".git/config",
    "file:stream",
  ])
    assert.throws(() => normalizeMemoryFilePath(name), /project|inside/);
  await writeFile(
    path.join(repo, "large.bin"),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  );
  await assert.rejects(captureMemoryFingerprint(repo, "large.bin"), /8 MiB/);
  if (process.platform !== "win32") {
    await writeFile(path.join(root, "outside.txt"), "never read into context");
    await symlink(
      path.join(root, "outside.txt"),
      path.join(repo, "outside-link"),
    );
    await assert.rejects(
      captureMemoryFingerprint(repo, "outside-link"),
      /symbolic link/,
    );
    await symlink(root, path.join(repo, "outside-dir"));
    await assert.rejects(
      captureMemoryFingerprint(repo, "outside-dir/outside.txt"),
      /outside/,
    );
  }
});

test("verification requires a worktree and an unchanged, explicitly confirmed profile snapshot", async (t) => {
  const { service, project } = await fixture(t);
  const profile = await service.saveVerificationProfile({
    projectId: project.id,
    name: "Node check",
    executable: process.execPath,
    args: ["-e", "console.log('passed')"],
    timeoutMinutes: 1,
  });
  const plan = await finishRun(
    service,
    (
      await service.startRun({
        projectId: project.id,
        provider: "codex",
        mode: "plan",
        prompt: "Plan only",
      })
    ).id,
  );
  assert.equal(
    (await service.getVerificationReport(plan.id)).currentRevision,
    undefined,
  );
  await assert.rejects(
    service.startVerification(
      { runId: plan.id, profileId: profile.id },
      profile,
    ),
    /no isolated worktree/,
  );
  const run = await build(service, project.id);
  await assert.rejects(
    service.startVerification(
      { runId: run.id, profileId: profile.id },
      { ...profile, args: ["-e", "other command"] },
    ),
    /changed after confirmation/,
  );
  const check = await finishCheck(
    service,
    (
      await service.startVerification(
        { runId: run.id, profileId: profile.id },
        profile,
      )
    ).id,
  );
  assert.equal(check.status, "passed");
  assert.equal(check.exitCode, 0);
  assert.ok(check.output.includes("passed"));
  assert.equal(
    check.inputRevision?.fingerprint,
    check.outputRevision?.fingerprint,
  );
  assert.equal(
    (await service.snapshot()).state.runs.find((entry) => entry.id === run.id)
      ?.verification,
    "not-run",
  );
  await service.deleteVerificationProfile(profile.id);
  const report = await service.getVerificationReport(run.id);
  assert.equal(report.profiles.length, 0);
  assert.deepEqual(
    report.results[0].args,
    profile.args,
    "historical command snapshots survive profile deletion",
  );
});

test("checks distinguish failed commands from source-changing and subsequently stale passes", async (t) => {
  const { service, project } = await fixture(t);
  const run = await build(service, project.id);
  const pass = await service.saveVerificationProfile({
    projectId: project.id,
    name: "Pass",
    executable: process.execPath,
    args: ["-e", "console.log('ok')"],
    timeoutMinutes: 1,
  });
  const passed = await finishCheck(
    service,
    (await service.startVerification({ runId: run.id, profileId: pass.id })).id,
  );
  assert.equal(passed.status, "passed");
  const mutate = await service.saveVerificationProfile({
    projectId: project.id,
    name: "Writes source",
    executable: process.execPath,
    args: [
      "-e",
      "require('node:fs').writeFileSync('README.md','changed during verification')",
    ],
    timeoutMinutes: 1,
  });
  const stale = await finishCheck(
    service,
    (await service.startVerification({ runId: run.id, profileId: mutate.id }))
      .id,
  );
  assert.equal(stale.status, "stale");
  assert.equal(stale.exitCode, 0);
  assert.equal(
    (await service.getVerificationReport(run.id)).results.find(
      (entry) => entry.id === passed.id,
    )?.status,
    "stale",
  );
  const fail = await service.saveVerificationProfile({
    projectId: project.id,
    name: "Fails",
    executable: process.execPath,
    args: ["-e", "process.exit(7)"],
    timeoutMinutes: 1,
  });
  const failed = await finishCheck(
    service,
    (await service.startVerification({ runId: run.id, profileId: fail.id })).id,
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 7);
});

test("active checks exclude concurrent writers and can be cancelled without deleting their worktree", async (t) => {
  const { service, project } = await fixture(t);
  const run = await build(service, project.id);
  const profile = await service.saveVerificationProfile({
    projectId: project.id,
    name: "Wait",
    executable: process.execPath,
    args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
    timeoutMinutes: 1,
  });
  const check = await service.startVerification({
    runId: run.id,
    profileId: profile.id,
  });
  await assert.rejects(
    service.startVerification({ runId: run.id, profileId: profile.id }),
    /already using/,
  );
  await assert.rejects(
    service.startRun({
      projectId: project.id,
      provider: "codex",
      mode: "build",
      prompt: "Do not overlap",
    }),
    /verification/,
  );
  await assert.rejects(
    service.startRun({
      projectId: project.id,
      threadId: run.threadId,
      provider: "codex",
      mode: "plan",
      prompt: "Do not overlap this thread",
    }),
    /verification/,
  );
  await assert.rejects(
    service.updateThread({ id: run.threadId, archived: true }),
    /active/,
  );
  await service.cancelVerification(check.id);
  assert.equal((await finishCheck(service, check.id)).status, "cancelled");
  assert.equal(await service.getWorktreePath(run.id), run.worktreePath);
});

test("a failed verification save launches no process and leaves no stale lock", async (t) => {
  const { service, project } = await fixture(t);
  const run = await build(service, project.id);
  const profile = await service.saveVerificationProfile({
    projectId: project.id,
    name: "Marker",
    executable: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync('should-not-exist','bad')"],
    timeoutMinutes: 1,
  });
  const internal = service as unknown as { persist: () => Promise<void> };
  const original = internal.persist;
  internal.persist = async () => {
    throw new Error("Injected disk failure");
  };
  try {
    await assert.rejects(
      service.startVerification({ runId: run.id, profileId: profile.id }),
      /command was not started/,
    );
  } finally {
    internal.persist = original;
  }
  assert.equal((await service.snapshot()).state.verifications.length, 0);
  await assert.rejects(
    readFile(path.join(run.worktreePath!, "should-not-exist")),
    /ENOENT/,
  );
  await service.updateSettings((await service.snapshot()).state.settings);
});

test("shutdown during verification setup prevents late command launch", async (t) => {
  const { service, project, dataDir } = await fixture(t);
  const run = await build(service, project.id);
  const profile = await service.saveVerificationProfile({
    projectId: project.id,
    name: "Wait",
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    timeoutMinutes: 1,
  });
  const internal = service as unknown as {
    validateWorktree(thread: Thread): Promise<string>;
  };
  const original = internal.validateWorktree.bind(service);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  internal.validateWorktree = async (thread) => {
    entered();
    await gate;
    return original(thread);
  };
  const starting = assert.rejects(
    service.startVerification({ runId: run.id, profileId: profile.id }),
    /not ready/,
  );
  await waiting;
  const closing = service.dispose();
  release();
  await Promise.all([starting, closing]);
  assert.equal(
    JSON.parse(await readFile(path.join(dataDir, "workspace.json"), "utf8"))
      .verifications.length,
    0,
  );
});

test("restarting an unfinished check preserves its snapshot and locks further writers", async (t) => {
  const { service, project, dataDir } = await fixture(t);
  const run = await build(service, project.id);
  const profile = await service.saveVerificationProfile({
    projectId: project.id,
    name: "Pass",
    executable: process.execPath,
    args: ["-e", "console.log('done')"],
    timeoutMinutes: 1,
  });
  const check = await finishCheck(
    service,
    (await service.startVerification({ runId: run.id, profileId: profile.id }))
      .id,
  );
  await service.dispose();
  const file = path.join(dataDir, "workspace.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.verifications[0].status = "running";
  await writeFile(file, JSON.stringify(saved));
  const reopened = new WorkspaceService(dataDir, () => undefined);
  t.after(async () => {
    await reopened.dispose();
  });
  await reopened.initialize();
  const restored = (await reopened.snapshot()).state.verifications[0];
  assert.equal(restored.id, check.id);
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.terminationUnconfirmed, true);
  await assert.rejects(
    reopened.startVerification({ runId: run.id, profileId: profile.id }),
    /locked/,
  );
  await assert.rejects(
    reopened.startRun({
      projectId: project.id,
      provider: "codex",
      mode: "build",
      prompt: "No new writer",
    }),
    /locked/,
  );
});
