import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  emptyWorkspace,
  DEFAULT_SETTINGS,
  type Thread,
} from "../src/shared/types";
import { buildRunContext } from "../src/main/services/context";
import { normalizeProviderLine } from "../src/main/services/provider-events";
import {
  providerArguments,
  resolveExecutable,
  runProvider,
} from "../src/main/services/providers";
import {
  validateMemoryInput,
  validateRunRequest,
  validateSettings,
} from "../src/main/services/validation";
import {
  validateWorkspaceState,
  WorkspaceService,
} from "../src/main/services/workspace-service";

const fakeCli = `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('test-cli 1.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--json --sandbox --ignore-user-config --safe-mode --restricted --permission-prompts --output-format --tools'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  input = input.split('CURRENT USER REQUEST:').at(-1);
  console.log(JSON.stringify({type:'thread.started', thread_id:'fake-session'}));
  if (input.includes('WINDOWS_PROCESS_TREE')) {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);process.send({pid:process.pid});'], {stdio:['ignore','ignore','ignore','ipc']});
    child.on('message', message => console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'TREE_DESCENDANT_READY:'+message.pid}})));
    fs.writeFileSync('tree-pids.json', JSON.stringify([process.pid,child.pid]));
    setInterval(()=>{},1000);
    return;
  }
  if (input.includes('ORPHAN_PIPES')) {
    const descendant = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);const ready=()=>console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"ORPHAN_DESCENDANT_READY:"+process.pid}}));if(process.connected)process.once("disconnect",ready);else ready();';
    const child = spawn(process.execPath, ['-e', descendant], {stdio:['ignore','inherit','inherit','ipc'],detached:input.includes('DETACHED_ORPHAN')});
    fs.writeFileSync('orphan.pid', String(child.pid));
    child.unref();
    console.log(JSON.stringify({type:'turn.completed'}));
    process.exit(0);
  }
  if (input.includes('REPEATED_EVENTS')) { setInterval(() => console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Still working'}})), 50); return; }
  if (input.includes('WAIT_FOR_CANCEL')) { setInterval(() => {}, 1000); return; }
  if (input.includes('FAIL_TERMINAL')) { console.log(JSON.stringify({type:'turn.failed',error:{message:'Expected test failure'}})); return; }
  if (input.includes('TOO_MUCH_OUTPUT')) { console.log('x'.repeat(80_000)); setInterval(() => {}, 1000); return; }
  if (input.includes('WRITE_TEST_FILE')) fs.writeFileSync('agent-change.txt','An isolated test change.');
  if (process.argv.includes('--safe-mode')) {
    console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'One visible answer.'}]}}));
    console.log(JSON.stringify({type:'result',subtype:'success',result:'One visible answer.',usage:{input_tokens:4,output_tokens:3}}));
    return;
  }
  const message = Buffer.from(JSON.stringify({type:'item.completed',item:{id:'m',type:'agent_message',text:'A résumé of the result.'}})+'\\n');
  const split = message.indexOf(Buffer.from('é')) + 1;
  process.stdout.write(message.subarray(0,split));
  setTimeout(() => { process.stdout.write(message.subarray(split)); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:6,cached_input_tokens:2}})); }, 20);
});
`;

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-backend-"));
  const repo = path.join(root, "repo with spaces");
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
  await writeFile(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "test fixture"], {
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
  return { root, repo, executable, dataDir, service, project };
}

async function terminal(service: WorkspaceService, runId: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const run = (await service.snapshot()).state.runs.find(
      (entry) => entry.id === runId,
    )!;
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Test run did not finish.");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessesToExit(
  pids: number[],
  deadline: number,
): Promise<void> {
  while (pids.some(processExists) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function cancelReadyOrphan(
  t: { after: (fn: () => Promise<void>) => void },
  prompt: string,
) {
  let orphanPid: number | undefined;
  let orphanRoot: string | undefined;
  // Register before fixture cleanup so even a failed handshake can recover the
  // child PID from its marker before the temporary directory is removed.
  t.after(async () => {
    try {
      orphanPid ??= Number(
        await readFile(path.join(orphanRoot!, "orphan.pid"), "utf8"),
      );
      if (Number.isInteger(orphanPid) && orphanPid > 0)
        process.kill(orphanPid, "SIGKILL");
    } catch {
      /* Group shutdown already killed the fixture, or it never started. */
    }
  });
  const { executable, root } = await fixture(t);
  orphanRoot = root;
  const command = await resolveExecutable(executable);
  const controller = new AbortController();
  let readyAt: number | undefined;
  const result = await runProvider({
    command: { ...command, args: [] },
    provider: "codex",
    cwd: root,
    prompt,
    // Only a startup watchdog. The cancellation clock begins at the explicit
    // descendant-ready handshake, not at a scheduling-sensitive spawn time.
    timeoutMs: 10_000,
    maxBytes: 65_536,
    signal: controller.signal,
    onEvent: (event) => {
      const ready = event.events.find((item) =>
        item.text.startsWith("ORPHAN_DESCENDANT_READY:"),
      );
      if (!ready || readyAt !== undefined) return;
      orphanPid = Number(ready.text.split(":").at(-1));
      readyAt = Date.now();
      // IPC disconnect confirms the leader has exited; the descendant emits
      // this event only after installing its SIGTERM handler. Give Node one
      // event-loop checkpoint to deliver the leader's exit event before abort.
      setImmediate(() => controller.abort());
    },
  });
  assert.notEqual(
    readyAt,
    undefined,
    "fixture must complete its startup handshake before cancellation",
  );
  assert.ok(
    Number.isInteger(orphanPid) && orphanPid! > 0,
    "readiness must identify the descendant for cleanup",
  );
  assert.ok(
    Date.now() - readyAt! < 2_800,
    "cancellation must not wait indefinitely for inherited descendant pipes",
  );
  return result;
}

test("run request validation rejects unknown providers, shell-like models, and oversized input", () => {
  const request = {
    projectId: "p",
    provider: "codex",
    mode: "plan",
    prompt: "Inspect",
  };
  assert.equal(validateRunRequest(request).prompt, "Inspect");
  assert.throws(
    () => validateRunRequest({ ...request, provider: "other" }),
    /provider/,
  );
  assert.throws(
    () => validateRunRequest({ ...request, model: "--help" }),
    /model identifier/,
  );
  assert.throws(
    () => validateRunRequest({ ...request, prompt: "x".repeat(32_001) }),
    /32000/,
  );
  assert.throws(
    () => validateRunRequest({ ...request, threadId: "../other" }),
    /invalid/,
  );
  assert.throws(
    () => validateSettings({ ...DEFAULT_SETTINGS, timeoutMinutes: 0 }),
    /Timeout/,
  );
  assert.throws(
    () => validateSettings({ ...DEFAULT_SETTINGS, maxOutputKb: 5 }),
    /Output/,
  );
  assert.throws(
    () =>
      validateMemoryInput({
        projectId: "p",
        title: "T",
        content: "C",
        source: "",
        kind: "system",
      }),
    /kind/,
  );
});

test("provider argument lists never use bypasses or shell interpolation", () => {
  const cwd = "C:\\Projects\\a & b";
  const codex = providerArguments("codex", cwd, "plan", "gpt-test");
  assert.equal(codex[codex.indexOf("--cd") + 1], cwd);
  assert.ok(codex.includes("read-only"));
  assert.ok(codex.includes("--ignore-user-config"));
  assert.ok(codex.includes("features.hooks=false"));
  assert.ok(codex.includes("notify=[]"));
  assert.ok(!codex.some((arg) => /bypass|danger-full-access/.test(arg)));
  const local = providerArguments("ollama", cwd, "build", "local-model:8b");
  assert.ok(
    !local.includes("--oss"),
    "OSS readiness can implicitly pull models",
  );
  assert.ok(local.includes('model_provider="nova_ollama"'));
  assert.ok(
    local.includes(
      'model_providers.nova_ollama.base_url="http://127.0.0.1:11434/v1"',
    ),
  );
  const claude = providerArguments("claude", cwd, "build", "");
  assert.ok(claude.includes("--safe-mode"));
  assert.ok(claude.includes("--restricted"));
  assert.ok(claude.includes("Read,Grep,Glob,Edit,Write"));
  assert.ok(!claude.some((arg) => /Bash|skip-permissions/.test(arg)));
});

test("event normalization distinguishes terminal errors from successful process exits", () => {
  assert.equal(
    normalizeProviderLine(
      "codex",
      '{"type":"turn.failed","error":{"message":"Oops"}}',
    ).failed,
    "Oops",
  );
  assert.equal(
    normalizeProviderLine(
      "claude",
      '{"type":"result","subtype":"error_max_turns","is_error":true}',
    ).completed,
    undefined,
  );
  const success = normalizeProviderLine(
    "claude",
    '{"type":"result","subtype":"success","result":"Done","usage":{"output_tokens":10}}',
  );
  assert.equal(success.completed, true);
  assert.equal(success.usage?.outputTokens, 10);
  assert.equal(
    normalizeProviderLine("codex", "not JSON").events[0]?.kind,
    "status",
  );
});

test("shared context is scoped to one project and excludes archived notes", async () => {
  const state = emptyWorkspace();
  const thread = {
    id: "t",
    projectId: "p",
    title: "Test",
    createdAt: "now",
    updatedAt: "now",
  };
  const base = {
    title: "Constraint",
    content: "Do not change geometry",
    kind: "constraint" as const,
    source: "User",
    createdAt: "now",
    updatedAt: "now",
  };
  state.memories.push(
    { ...base, id: "yes", projectId: "p", status: "active" },
    {
      ...base,
      id: "other",
      projectId: "q",
      status: "active",
      content: "OTHER_PROJECT_SECRET",
    },
    {
      ...base,
      id: "archived",
      projectId: "p",
      status: "archived",
      content: "OLD_NOTE",
    },
  );
  const context = await buildRunContext(state, thread, "Current request");
  assert.deepEqual(context.includedMemoryIds, ["yes"]);
  assert.ok(!context.prompt.includes("OTHER_PROJECT_SECRET"));
  assert.ok(!context.prompt.includes("OLD_NOTE"));
  assert.ok(context.prompt.includes("not higher-priority instructions"));
  assert.ok(context.prompt.includes("Current request"));
});

test("state validation rejects broken schemas and duplicate identities", () => {
  assert.throws(
    () => validateWorkspaceState({ ...emptyWorkspace(), schemaVersion: 2 }),
    /version/,
  );
  const project = {
    id: "p",
    name: "P",
    path: "/tmp/p",
    branch: "main",
    createdAt: "now",
  };
  assert.throws(
    () =>
      validateWorkspaceState({
        ...emptyWorkspace(),
        projects: [project, project],
      }),
    /Duplicate/,
  );
});

test("projects and source-linked memory persist and archive without deletion", async (t) => {
  const { service, project, repo, dataDir } = await fixture(t);
  assert.equal((await service.addProject(repo)).id, project.id);
  const memory = await service.saveMemory({
    projectId: project.id,
    title: "Keep scope",
    content: "No automatic merges",
    kind: "constraint",
    source: "Ashton",
  });
  assert.match(memory.commit!, /^[0-9a-f]{40,64}$/);
  await service.archiveMemory(memory.id);
  const persisted = JSON.parse(
    await readFile(path.join(dataDir, "workspace.json"), "utf8"),
  );
  assert.equal(persisted.memories[0].status, "archived");
  assert.equal(persisted.memories[0].content, "No automatic merges");
  assert.equal(persisted.projects.length, 1);
});

test("plan streams split UTF-8, records usage, and never asserts verification", async (t) => {
  const { service, project } = await fixture(t);
  const run = await service.startRun({
    projectId: project.id,
    provider: "codex",
    mode: "plan",
    prompt: "Review the project",
  });
  const finished = await terminal(service, run.id);
  assert.equal(finished.status, "completed");
  assert.equal(finished.verification, "not-run");
  assert.equal(finished.usage?.inputTokens, 12);
  assert.ok(
    finished.events.some((event) => event.text === "A résumé of the result."),
  );
  assert.equal(finished.worktreePath, undefined);
  assert.deepEqual((await service.getDiff(run.id)).changes, []);
  assert.equal(await service.getProjectPath(project.id), project.path);
  await assert.rejects(service.getWorktreePath(run.id), /does not have/);
});

test("Claude's repeated final result is shown once", async (t) => {
  const { service, project } = await fixture(t);
  const run = await service.startRun({
    projectId: project.id,
    provider: "claude",
    mode: "plan",
    prompt: "Review the project",
  });
  const finished = await terminal(service, run.id);
  assert.equal(finished.status, "completed");
  assert.deepEqual(
    finished.events
      .filter((event) => event.kind === "message")
      .map((event) => event.text),
    ["One visible answer."],
  );
});

test("build changes stay in their worktree and are visible to subsequent turns", async (t) => {
  const { service, project, repo } = await fixture(t);
  const run = await service.startRun({
    projectId: project.id,
    provider: "codex",
    mode: "build",
    prompt: "WRITE_TEST_FILE",
  });
  const finished = await terminal(service, run.id);
  assert.equal(finished.status, "completed");
  assert.ok(finished.worktreePath && finished.worktreePath !== repo);
  assert.equal(await service.getWorktreePath(run.id), finished.worktreePath);
  await assert.rejects(readFile(path.join(repo, "agent-change.txt")), /ENOENT/);
  const diff = await service.getDiff(run.id);
  assert.ok(diff.diff.includes("An isolated test change."));
  const next = await service.startRun({
    projectId: project.id,
    threadId: run.threadId,
    provider: "codex",
    mode: "plan",
    prompt: "Review your change",
  });
  assert.equal(next.worktreePath, finished.worktreePath);
  await terminal(service, next.id);
});

test("concurrent writers and same-thread runs are rejected, cancellation frees the writer", async (t) => {
  const { service, project } = await fixture(t);
  const first = await service.startRun({
    projectId: project.id,
    provider: "codex",
    mode: "build",
    prompt: "WAIT_FOR_CANCEL",
  });
  await assert.rejects(
    service.startRun({
      projectId: project.id,
      provider: "codex",
      mode: "build",
      prompt: "Other writer",
    }),
    /one writer|build worker/i,
  );
  await assert.rejects(
    service.startRun({
      projectId: project.id,
      threadId: first.threadId,
      provider: "codex",
      mode: "plan",
      prompt: "Same thread",
    }),
    /active run/,
  );
  await service.cancelRun(first.id);
  assert.equal((await terminal(service, first.id)).status, "cancelled");
  const next = await service.startRun({
    projectId: project.id,
    threadId: first.threadId,
    provider: "codex",
    mode: "build",
    prompt: "Resume",
  });
  assert.equal((await terminal(service, next.id)).status, "completed");
});

test("dirty source refuses Build without staging or stashing user files", async (t) => {
  const { service, project, repo } = await fixture(t);
  await writeFile(path.join(repo, "user-work.txt"), "keep this");
  await assert.rejects(
    service.startRun({
      projectId: project.id,
      provider: "codex",
      mode: "build",
      prompt: "Build",
    }),
    /clean repository/,
  );
  assert.equal(
    await readFile(path.join(repo, "user-work.txt"), "utf8"),
    "keep this",
  );
});

test("protocol failure and output overflow are recorded as failures", async (t) => {
  const { service, project } = await fixture(t);
  await service.updateSettings({
    ...(await service.snapshot()).state.settings,
    maxOutputKb: 64,
  });
  const failed = await service.startRun({
    projectId: project.id,
    provider: "codex",
    mode: "plan",
    prompt: "FAIL_TERMINAL",
  });
  assert.equal((await terminal(service, failed.id)).status, "failed");
  const overflow = await service.startRun({
    projectId: project.id,
    provider: "codex",
    mode: "plan",
    prompt: "TOO_MUCH_OUTPUT",
  });
  const result = await terminal(service, overflow.id);
  assert.equal(result.status, "failed");
  assert.match(result.error!, /output exceeded/i);
});

test("process timeout kills a worker instead of leaving it waiting", async (t) => {
  const { executable, root } = await fixture(t);
  const command = await resolveExecutable(executable);
  const result = await runProvider({
    command: { ...command, args: [] },
    provider: "codex",
    cwd: root,
    prompt: "WAIT_FOR_CANCEL",
    timeoutMs: 100,
    maxBytes: 65_536,
    signal: new AbortController().signal,
    onEvent: () => undefined,
  });
  assert.equal(result.completed, false);
  assert.match(result.error!, /timed out/);
});

test(
  "an exited leader's descendant cannot hold cancellation open",
  { skip: process.platform === "win32" },
  async (t) => {
    // This reproduces POSIX process-group + inherited-pipe behavior. Windows has
    // different pipe inheritance; its live-tree taskkill contract is tested below.
    const result = await cancelReadyOrphan(t, "ORPHAN_PIPES");
    assert.equal(result.completed, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.error, undefined);
    assert.equal(result.terminationUnconfirmed, undefined);
  },
);

test(
  "Windows cancellation stops a ready process tree",
  { skip: process.platform !== "win32" },
  async (t) => {
    let pidFile: string | undefined;
    const pids: number[] = [];
    t.after(async () => {
      if (pidFile) {
        try {
          pids.push(...JSON.parse(await readFile(pidFile, "utf8")));
        } catch {
          /* No fixture process started. */
        }
      }
      for (const pid of new Set(pids)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* taskkill already stopped it. */
        }
      }
      await waitForProcessesToExit([...new Set(pids)], Date.now() + 1_000);
    });
    const { executable, root } = await fixture(t);
    pidFile = path.join(root, "tree-pids.json");
    const command = await resolveExecutable(executable);
    const controller = new AbortController();
    let readyAt: number | undefined;
    const result = await runProvider({
      command: { ...command, args: [] },
      provider: "codex",
      cwd: root,
      prompt: "WINDOWS_PROCESS_TREE",
      timeoutMs: 10_000,
      maxBytes: 65_536,
      signal: controller.signal,
      onEvent: (event) => {
        const ready = event.events.find((item) =>
          item.text.startsWith("TREE_DESCENDANT_READY:"),
        );
        if (!ready || readyAt !== undefined) return;
        pids.push(Number(ready.text.split(":").at(-1)));
        readyAt = Date.now();
        controller.abort();
      },
    });
    assert.notEqual(
      readyAt,
      undefined,
      "the descendant must confirm readiness before cancellation",
    );
    assert.equal(result.cancelled, true);
    assert.equal(result.terminationUnconfirmed, undefined);
    pids.push(...JSON.parse(await readFile(pidFile, "utf8")));
    await waitForProcessesToExit([...new Set(pids)], readyAt! + 2_800);
    for (const pid of new Set(pids)) {
      assert.throws(
        () => process.kill(pid, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
        `taskkill must stop PID ${pid}`,
      );
    }
    assert.ok(Date.now() - readyAt! < 2_800);
  },
);

test(
  "unreachable descendants produce an honest bounded termination failure",
  { skip: process.platform === "win32" },
  async (t) => {
    const result = await cancelReadyOrphan(t, "DETACHED_ORPHAN_PIPES");
    assert.equal(result.terminationUnconfirmed, true);
    assert.equal(result.completed, false);
    assert.match(result.error!, /termination could not be confirmed/);
  },
);

test("shutdown during asynchronous setup prevents a late worker launch", async (t) => {
  const { service, project, dataDir } = await fixture(t);
  const first = await service.startRun({
    projectId: project.id,
    provider: "codex",
    mode: "build",
    prompt: "Initial turn",
  });
  await terminal(service, first.id);
  // Hold the existing-worktree validation to deterministically reproduce shutdown
  // after startRun passes its first guard but before it registers a process.
  const internals = service as unknown as {
    validateWorktree: (thread: Thread) => Promise<string>;
  };
  const original = internals.validateWorktree.bind(service);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  internals.validateWorktree = async (thread) => {
    entered();
    await gate;
    return original(thread);
  };
  const starting = assert.rejects(
    service.startRun({
      projectId: project.id,
      threadId: first.threadId,
      provider: "codex",
      mode: "build",
      prompt: "WRITE_TEST_FILE WAIT_FOR_CANCEL",
    }),
    /not ready/,
  );
  await waiting;
  const stopping = service.dispose();
  release();
  await Promise.all([starting, stopping]);
  const persisted = JSON.parse(
    await readFile(path.join(dataDir, "workspace.json"), "utf8"),
  );
  assert.equal(persisted.runs.length, 1);
  await assert.rejects(
    readFile(path.join(first.worktreePath!, "agent-change.txt")),
    /ENOENT/,
  );
});

test("failed initial persistence leaves no active worker and preserves its worktree", async (t) => {
  const { service, project, dataDir } = await fixture(t);
  const file = path.join(dataDir, "workspace.json");
  await rename(file, `${file}.backup`);
  await mkdir(file);
  await assert.rejects(
    service.startRun({
      projectId: project.id,
      provider: "codex",
      mode: "build",
      prompt: "WRITE_TEST_FILE",
    }),
    /no worker was started/,
  );
  const state = (await service.snapshot()).state;
  assert.equal(state.runs.length, 0);
  assert.equal(state.threads.length, 1);
  assert.ok(state.threads[0].worktreePath);
  await assert.rejects(
    readFile(path.join(state.threads[0].worktreePath!, "agent-change.txt")),
    /ENOENT/,
  );
  await rm(file, { recursive: true });
  await rename(`${file}.backup`, file);
  await service.updateSettings(state.settings); // No stale active-map entry blocks settings.
  const next = await service.startRun({
    projectId: project.id,
    threadId: state.threads[0].id,
    provider: "codex",
    mode: "build",
    prompt: "Resume saved worktree",
  });
  assert.equal((await terminal(service, next.id)).status, "completed");
});

test("explicit provider refresh detects installation changes without making a model call", async (t) => {
  const { service, executable } = await fixture(t);
  assert.equal(
    (await service.snapshot()).providers.find(
      (provider) => provider.id === "codex",
    )?.available,
    true,
  );
  await rename(executable, `${executable}.uninstalled`);
  assert.equal(
    (await service.snapshot()).providers.find(
      (provider) => provider.id === "codex",
    )?.available,
    true,
    "normal snapshots use cached metadata",
  );
  assert.equal(
    (await service.refreshProviderStatus()).providers.find(
      (provider) => provider.id === "codex",
    )?.available,
    false,
  );
});

test("a disk failure during streaming stops the worker without an unhandled rejection", async (t) => {
  const { service, project } = await fixture(t);
  const run = await service.startRun({
    projectId: project.id,
    provider: "codex",
    mode: "plan",
    prompt: "REPEATED_EVENTS",
  });
  let sawStreaming = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (
      (await service.snapshot()).state.runs
        .find((entry) => entry.id === run.id)
        ?.events.some((event) => event.text === "Still working")
    ) {
      sawStreaming = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(
    sawStreaming,
    true,
    "inject the persistence failure only after the worker is streaming",
  );
  // Inject at the serialization boundary. Renaming the live state file and then
  // mkdir'ing its name races concurrent atomic saves, especially on Windows.
  const internals = service as unknown as { persist: () => Promise<void> };
  const originalPersist = internals.persist;
  internals.persist = async () => {
    throw Object.assign(new Error("EACCES: injected storage failure"), {
      code: "EACCES",
    });
  };
  try {
    const result = await terminal(service, run.id);
    assert.equal(result.status, "failed");
    assert.match(result.error!, /could not be saved/);
    await service.dispose();
  } finally {
    internals.persist = originalPersist;
  }
});

test("startup preserves corrupt state and marks unfinished saved runs interrupted", async (t) => {
  const { service, project, dataDir } = await fixture(t);
  const run = await service.startRun({
    projectId: project.id,
    provider: "codex",
    mode: "plan",
    prompt: "Simple",
  });
  await terminal(service, run.id);
  await service.dispose();
  const stateFile = path.join(dataDir, "workspace.json");
  const data = JSON.parse(await readFile(stateFile, "utf8"));
  data.runs[0].status = "running";
  data.runs[0].terminationUnconfirmed = true;
  await writeFile(stateFile, JSON.stringify(data));
  const reopened = new WorkspaceService(dataDir, () => undefined);
  await reopened.initialize();
  assert.equal((await reopened.snapshot()).state.runs[0].status, "interrupted");
  await assert.rejects(
    reopened.startRun({
      projectId: project.id,
      provider: "codex",
      mode: "build",
      prompt: "Do not start another writer",
    }),
    /Build is locked/,
  );
  await reopened.dispose();
  await writeFile(stateFile, "not valid JSON");
  const corrupt = new WorkspaceService(dataDir, () => undefined);
  await assert.rejects(corrupt.initialize(), /preserved/);
  assert.equal(await readFile(stateFile, "utf8"), "not valid JSON");
});
