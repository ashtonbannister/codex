import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { emptyWorkspace, type Run } from "../src/shared/types";
import { buildRunContext } from "../src/main/services/context";
import { WorkspaceService, validateWorkspaceState } from "../src/main/services/workspace-service";
import {
  validateCodexHistoryQuery, validateCodexMemoryImportRequest,
  validateCodexResourceRequest, validateSettings,
} from "../src/main/services/validation";

const SOURCE_ID = "01900000-0000-7000-8000-000000000001";
const at = "2026-11-13T00:00:00.000Z";
const row = (type: string, payload: object) => ({ type, timestamp: at, payload });
const message = (id: string, role: "user" | "assistant", text: string) =>
  row("event_msg", { type: "item_completed", turn_id: "turn-" + id, item: role === "user"
    ? { type: "UserMessage", id, content: [{ type: "text", text }] }
    : { type: "AgentMessage", id, phase: "final_answer", content: [{ type: "Text", text }] } });
const visible = [
  message("old-u", "user", "Earlier visible request."),
  message("old-a", "assistant", "Earlier visible answer."),
  message("new-u", "user", "Keep the original design requirement."),
  message("new-a", "assistant", "Current visible native answer."),
  row("event_msg", { type: "item_completed", item: { type: "Reasoning", content: [{ type: "Text", text: "PRIVATE_REASONING_SENTINEL" }] } }),
];

// This fixture has no live app-server implementation. Imports must work even when
// the CLI is absent; actual independent runs use ordinary, isolated CLI exec.
const fakeCli = `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const log = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli-invocations.jsonl');
fs.appendFileSync(log, JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,cwd:process.cwd()})+'\\n');
if(process.argv.includes('--print-startup-config')){console.log(JSON.stringify({appServerVersion:'fixture',configRequirements:{requirements:null}}));process.exit(0)}
if(process.argv.includes('app-server'))throw Error('Native app-server must not be used for imported histories');
if(process.argv.includes('--version')){console.log('compatibility-fixture 1');process.exit(0)}
if(process.argv.includes('--help')){console.log('--json --sandbox --skip-git-repo-check --ignore-user-config --safe-mode --restricted --permission-prompts --output-format --tools --stdio --strict-config');process.exit(0)}
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>prompt+=chunk);
process.stdin.on('end',()=>{
  if(prompt.includes('WAIT_NOVA')){setInterval(()=>{},1000);return;}
  if(process.argv.includes('--safe-mode')){console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:prompt}]}}));console.log(JSON.stringify({type:'result',subtype:'success',result:prompt}));}
  else {console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:prompt}}));console.log(JSON.stringify({type:'turn.completed'}));}
});
`;

async function fixture(t: TestContext, options: {
  archived?: boolean; rows?: object[]; sourceCwd?: string; missingCli?: boolean;
} = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "nova-import-service-")));
  const cwd = path.join(root, "oem-worktree", "nested");
  const home = path.join(root, "codex-home");
  const dataDir = path.join(root, "nova");
  const sessions = path.join(home, options.archived ? "archived_sessions" : "sessions", "2026", "11", "13");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessions, { recursive: true }), mkdir(dataDir)]);
  await writeFile(path.join(cwd, "original.txt"), "Original working folder must stay independent.\n");
  await writeFile(path.join(home, "auth.json"), "CREDENTIAL_SENTINEL");
  await writeFile(path.join(home, "config.toml"), "UNSUPPORTED_OEM_CONFIG_SENTINEL");
  await writeFile(path.join(home, "state_5.sqlite"), "DATABASE_SENTINEL");
  await writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id: SOURCE_ID, thread_name: "Existing Codex work", updated_at: at }) + "\n");
  const sourceFile = path.join(sessions, `rollout-2026-11-13T00-00-00-${SOURCE_ID}.jsonl`);
  await writeFile(sourceFile, [
    row("session_meta", { id: SOURCE_ID, timestamp: at, cwd: options.sourceCwd ?? cwd, model_provider: "openai" }),
    ...(options.rows ?? visible),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const executable = path.join(root, "fake-cli.mjs");
  if (!options.missingCli) await writeFile(executable, fakeCli);
  const state = emptyWorkspace();
  state.settings = { ...state.settings, codexPath: executable, claudePath: executable, codexHome: home, localModel: "fixture-local" };
  const stateFile = path.join(dataDir, "workspace.json");
  await writeFile(stateFile, JSON.stringify(state));
  const service = new WorkspaceService(dataDir, () => undefined);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.initialize();
  const connection = { home, codexPath: executable };
  const calls = async (): Promise<Array<{ args: string[]; home: string; cwd: string }>> => {
    try { return (await readFile(path.join(root, "cli-invocations.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  return { root, cwd, home, dataDir, stateFile, sourceFile, executable, service, connection, calls,
    runtimeHome: path.join(dataDir, "codex-runtime"),
    importThread: () => service.importCodexThread({ threadId: SOURCE_ID, archived: options.archived }, connection) };
}

async function finish(service: WorkspaceService, id: string): Promise<Run> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = (await service.snapshot()).state.runs.find((entry) => entry.id === id)!;
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Fixture run did not finish within its bounded wait.");
}

/** Reject even metadata reads, not just writes, during independent Nova work. */
async function withoutSourceAccess<T>(roots: string[], action: () => Promise<T>): Promise<T> {
  type Operation = (...args: unknown[]) => unknown;
  const methods = fs.promises as unknown as Record<string, Operation>;
  const originals = new Map<string, Operation>();
  const attempts: string[] = [];
  for (const name of ["lstat", "stat", "realpath", "readFile", "readdir", "open", "opendir", "access"]) {
    const original = methods[name]!;
    originals.set(name, original);
    methods[name] = (...args) => {
      const file = String(args[0]);
      if (roots.some((root) => file === root || file.startsWith(root + path.sep))) {
        attempts.push(name + ": " + file);
        throw new Error("Unexpected OEM source filesystem access");
      }
      return original.apply(fs.promises, args);
    };
  }
  syncBuiltinESMExports();
  try {
    const result = await action();
    assert.deepEqual(attempts, [], "Copied state must not probe, refresh, or read its OEM provenance");
    return result;
  } finally {
    for (const [name, original] of originals) methods[name] = original;
    syncBuiltinESMExports();
  }
}

test("read-only import retains paginated visible history without a CLI and creates only a detached Nova project", async (t) => {
  const rows = Array.from({ length: 405 }, (_, index) => message(`m-${index}`, index % 2 ? "assistant" : "user", `Visible ${index}`));
  const f = await fixture(t, { rows: [...rows, visible[4]!], missingCli: true });
  const sourceBefore = await readFile(f.sourceFile);
  assert.equal((await f.service.listCodexThreads({}, f.connection)).threads[0]?.id, SOURCE_ID);
  const thread = await f.importThread();
  assert.equal(thread.codex?.copyOnly, true);
  assert.equal(thread.codex?.history.length, 405);
  assert.equal(thread.codex?.history[0]?.text, "Visible 0");
  assert.equal(thread.codex?.history.at(-1)?.text, "Visible 404");
  assert.equal(thread.codex?.historyTruncated, false);
  assert.doesNotMatch(JSON.stringify(thread), /PRIVATE_REASONING_SENTINEL|CREDENTIAL_SENTINEL|DATABASE_SENTINEL|UNSUPPORTED_OEM_CONFIG_SENTINEL/);
  assert.equal((await f.importThread()).id, thread.id);
  const state = (await f.service.snapshot()).state;
  assert.equal(state.threads.length, 1);
  assert.equal(state.projects[0]?.kind, "folder");
  assert.equal(state.projects[0]?.path, path.join(f.dataDir, "imported-conversations", thread.id));
  assert.equal(thread.codex?.sourceCwd, f.cwd);
  assert.equal(thread.worktreePath, undefined);
  assert.deepEqual(await readFile(f.sourceFile), sourceBefore);
  assert.deepEqual(await f.calls(), []);
  await f.service.dispose();
  const restored = new WorkspaceService(f.dataDir, () => undefined);
  try {
    await withoutSourceAccess([f.home, f.cwd], async () => {
      await restored.initialize();
      assert.deepEqual((await restored.snapshot()).state.threads[0]?.codex, thread.codex);
    });
  } finally { await restored.dispose(); }
});

test("missing and empty original working directories do not block import or copied context", async (t) => {
  for (const sourceCwd of ["", path.join(os.tmpdir(), "nova-nonexistent-original-cwd")]) {
    const f = await fixture(t, { sourceCwd, missingCli: true });
    const thread = await f.importThread();
    assert.equal(thread.codex?.sourceCwd, sourceCwd);
    const preview = await withoutSourceAccess([f.home, f.cwd], () => f.service.previewContext({
      projectId: thread.projectId, threadId: thread.id, provider: "claude", mode: "plan", prompt: "Continue the imported request",
    }));
    assert.match(preview.prompt, /original design requirement/);
  }
});

test("explicit refresh copies changed source history but preserves Nova turns and notes", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  await f.service.saveMemory({ projectId: thread.projectId, title: "Nova decision", content: "Preserve the user's constraints.", kind: "decision", source: "User" });
  const run = await f.service.startRun({ projectId: thread.projectId, threadId: thread.id, provider: "claude", mode: "plan", prompt: "Continue the current request." });
  assert.equal((await finish(f.service, run.id)).status, "completed");
  const before = (await f.service.snapshot()).state;
  await appendFile(f.sourceFile, JSON.stringify(message("official-answer", "assistant", "New visible answer from the official Codex app.")) + "\n");
  // Invalidate the old bounded snapshot without changing the retained copy.
  await assert.rejects(f.service.refreshCodexThread(thread.id, f.connection), /source.*changed/i);
  assert.deepEqual((await f.service.snapshot()).state.threads[0]?.codex, thread.codex);
  const sourceBefore = await readFile(f.sourceFile);
  const callsBefore = await f.calls();
  const refreshed = await f.service.refreshCodexThread(thread.id, f.connection);
  assert.equal(refreshed.codex?.history.length, 5);
  assert.ok(refreshed.codex?.history.some((entry) => entry.id === "official-answer"));
  const after = (await f.service.snapshot()).state;
  assert.deepEqual(after.runs, before.runs);
  assert.deepEqual(after.memories, before.memories);
  assert.deepEqual(await readFile(f.sourceFile), sourceBefore);
  assert.deepEqual(await f.calls(), callsBefore);
  await rm(f.sourceFile);
  await assert.rejects(f.service.refreshCodexThread(thread.id, f.connection));
  assert.deepEqual((await f.service.snapshot()).state.threads[0]?.codex, refreshed.codex);
});

test("native handoff and writeback are rejected while export remains a visible copy", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  const sourceBefore = await readFile(f.sourceFile);
  await assert.rejects(f.service.reviewCodexHandoff(thread.id, f.connection), /import-only|disabled/);
  await assert.rejects(f.service.publishCodexHandoff(thread.id, "0".repeat(64), f.connection), /import-only|disabled/);
  const exported = await f.service.exportConversation(thread.id);
  assert.match(exported.content, /Current visible native answer/);
  assert.doesNotMatch(exported.content, /PRIVATE_REASONING_SENTINEL|CREDENTIAL_SENTINEL/);
  assert.deepEqual(await readFile(f.sourceFile), sourceBefore);
  assert.deepEqual(await f.calls(), []);
});

test("Codex, Claude and local Plan use copied context and Nova cwd, never native resume or forks", async (t) => {
  const f = await fixture(t, { archived: true });
  const thread = await f.importThread();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ models: [{ name: "fixture-local" }] }), { status: 200 }));
  await withoutSourceAccess([f.home, f.cwd], async () => {
    for (const provider of ["codex", "claude", "ollama"] as const) {
      const run = await f.service.startRun({ projectId: thread.projectId, threadId: thread.id, provider, mode: "plan", prompt: "Continue from copied requirements." });
      const result = await finish(f.service, run.id);
      assert.equal(result.status, "completed", result.error);
      const text = result.events.filter((entry) => entry.kind === "message").map((entry) => entry.text).join("\n");
      assert.match(text, /original design requirement/);
      assert.doesNotMatch(text, /PRIVATE_REASONING_SENTINEL/);
      assert.equal(result.providerSessionId, undefined);
    }
    await assert.rejects(f.service.startRun({ projectId: thread.projectId, threadId: thread.id, provider: "codex", mode: "build", prompt: "Do not build in the original folder." }), /committed Git/);
  });
  const calls = await f.calls();
  assert.ok(calls.length >= 3);
  assert.ok(calls.filter((call) => !call.args.includes("--help") && !call.args.includes("--version")).every((call) => call.home === f.runtimeHome));
  assert.ok(calls.every((call) => !call.args.some((arg) => ["resume", "fork", SOURCE_ID].includes(arg))));
  assert.ok(calls.every((call) => !call.args.includes("app-server") || call.args.includes("--print-startup-config")));
  assert.ok(calls.filter((call) => !call.args.includes("--help") && !call.args.includes("--version")).every(
    (call) => call.cwd === path.join(f.dataDir, "imported-conversations", thread.id)));
  assert.equal((await f.service.snapshot()).state.threads[0]?.codex?.forkedThreadId, undefined);
});

test("source selection is confirmed independently of the CLI and active Nova runs do not lock read-only history", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.listCodexThreads({}, { ...f.connection, home: path.join(f.root, "different-source") }), /import source changed/);
  assert.equal((await f.service.listCodexThreads({}, { ...f.connection, codexPath: "unused-for-import" })).threads.length, 1);
  const thread = await f.importThread();
  const run = await f.service.startRun({ projectId: thread.projectId, threadId: thread.id, provider: "codex", mode: "plan", prompt: "WAIT_NOVA" });
  try {
    assert.equal((await f.service.readCodexHistory({ threadId: SOURCE_ID })).messages.length, 4);
    assert.equal((await f.importThread()).id, thread.id);
    await assert.rejects(f.service.updateThread({ id: thread.id, archived: true }), /active agent/);
  } finally { await f.service.cancelRun(run.id); }
  assert.equal((await finish(f.service, run.id)).status, "cancelled");
});

test("imported memory remains an independent snapshot when its source changes or disappears", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  await mkdir(path.join(f.home, "memories"));
  const source = path.join(f.home, "memories", "MEMORY.md");
  await writeFile(source, "Keep the original wheel geometry.");
  const request = { section: "memories" as const, path: "MEMORY.md" };
  const preview = await f.service.previewCodexResource(request);
  const imported = await f.service.importCodexMemory({ ...request, projectId: thread.projectId, expectedSha256: preview.sha256 }, f.home);
  assert.equal((await f.service.importCodexMemory({ ...request, projectId: thread.projectId, expectedSha256: preview.sha256 })).id, imported.id);
  await writeFile(source, "Changed OEM requirement must not replace the imported copy.");
  await assert.rejects(f.service.importCodexMemory({ ...request, projectId: thread.projectId, expectedSha256: preview.sha256 }), /changed after preview/);
  await rm(source);
  await withoutSourceAccess([f.home, f.cwd], async () => {
    const context = await f.service.previewContext({ projectId: thread.projectId, threadId: thread.id, provider: "ollama", mode: "plan", prompt: "wheel geometry" });
    assert.equal(context.memories.find((entry) => entry.id === imported.id)?.freshness, "unlinked");
    assert.ok(context.includedMemoryIds.includes(imported.id));
    assert.match(context.prompt, /Keep the original wheel geometry/);
    assert.doesNotMatch(context.prompt, /Changed OEM requirement/);
    const sharing = await f.service.previewSharedMemory(thread.projectId);
    assert.match(sharing.files[0]?.after ?? "", /Keep the original wheel geometry/);
  });
  const edited = await f.service.saveMemory({ ...imported, content: "My reviewed user note" });
  assert.equal(edited.codexSource, undefined);
});

test("legacy imported threads detach during startup without using original folders or losing previous evidence", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  const note = await f.service.saveMemory({ projectId: thread.projectId, title: "Retained note", content: "Do not lose the reviewed decision.", kind: "decision", source: "User" });
  await f.service.dispose();
  const saved = JSON.parse(await readFile(f.stateFile, "utf8"));
  saved.projects[0].path = f.cwd;
  saved.threads[0].codex.copyOnly = false;
  saved.threads[0].codex.forkedThreadId = "01900000-0000-7000-8000-000000000002";
  saved.threads[0].codex.forkedCwd = f.cwd;
  saved.threads[0].worktreePath = f.cwd;
  saved.threads[0].worktreeStoragePath = f.home;
  saved.threads[0].branch = "old-native-branch";
  saved.threads[0].baseCommit = "a".repeat(40);
  saved.codexRecoveryHomes = [f.home];
  saved.accountRecovery = { provider: "codex", home: f.home, recordedAt: at };
  await writeFile(f.stateFile, JSON.stringify(saved));
  const restored = new WorkspaceService(f.dataDir, () => undefined);
  try {
    await withoutSourceAccess([f.home, f.cwd], async () => {
      await restored.initialize();
      const state = (await restored.snapshot()).state;
      const copied = state.threads.find((entry) => entry.id === thread.id)!;
      assert.equal(copied.codex?.copyOnly, true);
      assert.equal(copied.worktreePath, undefined);
      assert.equal(state.projects.find((entry) => entry.id === copied.projectId)?.path, path.join(f.dataDir, "imported-conversations", thread.id));
      assert.deepEqual(copied.codex?.history, thread.codex?.history);
      assert.ok(state.memories.some((entry) => entry.id === note.id && entry.content === note.content));
      assert.equal(state.accountRecovery, undefined);
      assert.deepEqual(state.codexRecoveryHomes, [f.home]);
      assert.ok((await restored.listRecoveryItems()).some((entry) => entry.kind === "codex-home"));
      const preview = await restored.previewContext({ projectId: copied.projectId, threadId: copied.id, provider: "codex", mode: "plan", prompt: "Continue the independent copy" });
      assert.match(preview.prompt, /original design requirement/);
    });
    assert.equal((await restored.listCodexThreads({})).threads.length, 1);
  } finally { await restored.dispose(); }
});

test("import rollback preserves workspace state and a failed run save starts no execution worker", async (t) => {
  const f = await fixture(t);
  const internals = f.service as unknown as { persist: () => Promise<void> };
  const persist = internals.persist;
  internals.persist = async () => { throw new Error("injected disk failure"); };
  try {
    await assert.rejects(f.importThread(), /disk failure/);
    assert.equal((await f.service.snapshot()).state.threads.length, 0);
    assert.equal((await f.service.snapshot()).state.projects.length, 0);
  } finally { internals.persist = persist; }
  const thread = await f.importThread();
  const callsBefore = await f.calls();
  internals.persist = async () => { throw new Error("injected disk failure"); };
  try {
    await assert.rejects(f.service.startRun({ projectId: thread.projectId, threadId: thread.id, provider: "codex", mode: "plan", prompt: "No process until save" }), /no worker was started/);
    assert.equal((await f.service.snapshot()).state.runs.length, 0);
    assert.deepEqual((await f.calls()).filter((call) => !call.args.includes("--help") && !call.args.includes("--version")), callsBefore);
  } finally { internals.persist = persist; }
});

test("private-runtime account operation lease is durable, blocks agents and requires its exact finish marker", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  const operation = await f.service.beginAccountOperation("codex", f.runtimeHome);
  const persisted = JSON.parse(await readFile(f.stateFile, "utf8"));
  assert.equal(persisted.accountOperation.id, operation);
  assert.equal(persisted.accountOperation.home, f.runtimeHome);
  await assert.rejects(f.service.startRun({ projectId: thread.projectId, threadId: thread.id, provider: "claude", mode: "plan", prompt: "Must not start during login" }), /provider account cleanup/);
  await assert.rejects(f.service.finishAccountOperation("stale-operation"), /marker was preserved/);
  assert.equal((await f.service.snapshot()).state.accountOperation?.id, operation);
  await f.service.finishAccountOperation(operation);
  assert.equal((await f.service.snapshot()).state.accountOperation, undefined);
  const failed = await f.service.beginAccountOperation("claude", f.runtimeHome);
  await f.service.recordAccountRecovery("claude", f.runtimeHome);
  await assert.rejects(f.service.finishAccountOperation(failed), /marker was preserved/);
  assert.equal((await f.service.snapshot()).state.accountRecovery?.provider, "claude");
  assert.deepEqual(await f.calls(), []);
});

test("an orphan Nova account lease becomes durable recovery without startup probes", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  const operation = await f.service.beginAccountOperation("codex", f.runtimeHome);
  await f.service.dispose();
  const restarted = new WorkspaceService(f.dataDir, () => undefined);
  try {
    await restarted.initialize();
    const snapshot = await restarted.snapshot();
    assert.equal(snapshot.state.accountOperation, undefined);
    assert.equal(snapshot.state.accountRecovery?.home, f.runtimeHome);
    assert.ok(snapshot.providers.every((provider) => !provider.available));
    assert.deepEqual(await f.calls(), []);
    await assert.rejects(restarted.finishAccountOperation(operation), /marker was preserved/);
    await assert.rejects(restarted.startRun({ projectId: thread.projectId, threadId: thread.id, provider: "claude", mode: "plan", prompt: "Must remain blocked" }), /provider account cleanup/);
    const recovery = (await restarted.listRecoveryItems()).find((entry) => entry.id === "provider-accounts")!;
    await assert.rejects(restarted.acknowledgeRecovery({ id: recovery.id, token: "0".repeat(64) }), /Recovery state changed/);
    await restarted.acknowledgeRecovery({ id: recovery.id, token: recovery.token });
    assert.equal((await restarted.snapshot()).state.accountRecovery, undefined);
    assert.deepEqual(await f.calls(), []);
    assert.ok((await restarted.snapshot()).providers.every((provider) => !provider.available));
    const refreshed = await restarted.refreshProviderStatus();
    assert.ok(refreshed.providers.find((provider) => provider.id === "codex")?.available);
    assert.ok((await f.calls()).length > 0);
  } finally { await restarted.dispose(); }
});

test("all providers get the same bounded imported context, never implicit native history", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  const state = (await f.service.snapshot()).state;
  state.threads[0]!.codex!.history = Array.from({ length: 200 }, (_, index) => ({
    id: `i-${index}`, turnId: `t-${index}`, role: index % 2 ? "assistant" as const : "user" as const,
    text: `message-${index} ` + "x".repeat(16_000),
  }));
  state.threads[0]!.codex!.historyTruncated = true;
  const preview = await withoutSourceAccess([f.home, f.cwd], () => buildRunContext(state, thread, "Continue", path.join(f.dataDir, "imported-conversations", thread.id)));
  assert.ok(preview.prompt.length < 15_000);
  assert.match(preview.prompt, /importedCodexVisibleHistory/);
  assert.ok(preview.warnings.some((warning) => warning.includes("12000-character budget")));
  assert.ok(preview.warnings.some((warning) => warning.includes("snapshot is incomplete")));
});

test("compatibility inputs stay bounded and legacy workspaces retain their defaults", () => {
  const legacy = validateWorkspaceState(emptyWorkspace());
  assert.equal(legacy.codexRecoveryHomes, undefined);
  assert.equal(legacy.settings.codexHome, undefined);
  assert.throws(() => validateSettings({ ...legacy.settings, codexHome: "relative" }), /absolute/);
  assert.throws(() => validateCodexHistoryQuery({ threadId: "--bad" }), /invalid/);
  assert.throws(() => validateCodexResourceRequest({ section: "memories", path: "../auth.json" }), /selected section/);
  assert.throws(() => validateCodexResourceRequest({ section: "credentials", path: "note.md" }), /allowed/);
  assert.throws(() => validateCodexMemoryImportRequest({ projectId: "p", section: "memories", path: "note.md", expectedSha256: "wrong" }), /SHA-256/);
});
