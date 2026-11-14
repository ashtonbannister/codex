import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listCodexThreads, readCodexHistory } from "../src/main/services/codex-readonly";
import { inspectCodexInstallation } from "../src/main/services/codex-installation";

const firstId = "12345678-1234-1234-1234-123456789abc";
const secondId = "abcdefab-abcd-abcd-abcd-abcdefabcdef";
const record = (type: string, payload: object) => ({ timestamp: "2026-11-13T00:00:00Z", type, payload });
const meta = (id: string) => record("session_meta", { id, timestamp: "2026-11-13T00:00:00Z", cwd: "D:\\OEM\\worktree", model_provider: "openai" });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-readonly-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "source");
  await mkdir(home);
  return { root, home: await realpath(home) };
}
async function rollout(home: string, id: string, rows: unknown[], archived = false) {
  const directory = path.join(home, archived ? "archived_sessions" : "sessions", "2026", "11", "13");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-11-13T00-00-00-${id}.jsonl`);
  await writeFile(file, [meta(id), ...rows].map((row) => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

test("import reads visible legacy messages without native startup or source modifications", async (t) => {
  const { home } = await fixture(t);
  await writeFile(path.join(home, "auth.json"), "credential-sentinel");
  await writeFile(path.join(home, "config.toml"), "config-sentinel");
  await writeFile(path.join(home, "state_5.sqlite"), "database-sentinel");
  await writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id: firstId, thread_name: "Original title" }) + "\n");
  const file = await rollout(home, firstId, [
    record("event_msg", { type: "user_message", message: "Visible question" }),
    record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Visible question" }] }),
    record("event_msg", { type: "agent_reasoning", text: "hidden-reasoning-sentinel" }),
    record("response_item", { type: "reasoning", encrypted_content: "encrypted-sentinel" }),
    record("event_msg", { type: "agent_message", message: "Visible answer" }),
    record("response_item", { type: "function_call_output", output: "tool-secret-sentinel" }),
  ]);
  const before = await readFile(file);
  const info = await stat(file);
  const names = await readdir(home);
  const listing = await listCodexThreads(home, {});
  assert.equal(listing.threads[0]?.title, "Original title");
  assert.equal(listing.threads[0]?.status, "snapshot");
  const history = await readCodexHistory(home, { threadId: firstId });
  assert.deepEqual(history.messages.map((entry) => [entry.role, entry.text]), [["user", "Visible question"], ["assistant", "Visible answer"]]);
  assert.doesNotMatch(JSON.stringify(history), /hidden-reasoning-sentinel|encrypted-sentinel|tool-secret-sentinel|credential-sentinel|config-sentinel|database-sentinel/);
  assert.deepEqual(await readFile(file), before);
  assert.equal((await stat(file)).mtimeMs, info.mtimeMs);
  assert.deepEqual(await readdir(home), names);
});

test("current paginated rollout item_completed imports only visible text and archives stay separate", async (t) => {
  const { home } = await fixture(t);
  await rollout(home, firstId, [
    record("event_msg", { type: "item_completed", turn_id: "turn-1", item: { type: "UserMessage", id: "user-1", content: [{ type: "text", text: "Modern question" }, { type: "image", image_url: "not-read" }] } }),
    record("event_msg", { type: "item_completed", turn_id: "turn-1", item: { type: "Reasoning", id: "reason-1", content: [{ type: "Text", text: "hidden-modern-reasoning" }] } }),
    record("event_msg", { type: "item_completed", turn_id: "turn-1", item: { type: "AgentMessage", id: "answer-1", phase: "final_answer", content: [{ type: "Text", text: "Modern answer" }] } }),
  ], true);
  assert.equal((await listCodexThreads(home, {})).threads.length, 0);
  assert.equal((await listCodexThreads(home, { archived: true })).threads.length, 1);
  const history = await readCodexHistory(home, { threadId: firstId, archived: true });
  assert.deepEqual(history.messages.map((entry) => entry.text), ["Modern question", "Modern answer"]);
  assert.equal(history.messages[0]?.turnId, "turn-1");
  assert.doesNotMatch(JSON.stringify(history), /hidden-modern-reasoning|not-read/);
});

test("history pagination is chronological, snapshot-bound, and refuses changed source files", async (t) => {
  const { home } = await fixture(t);
  const rows = Array.from({ length: 450 }, (_, index) =>
    record("response_item", { type: "message", role: "assistant", id: `msg-${index}`, content: [{ type: "output_text", text: `Visible ${index}` }] }));
  const file = await rollout(home, firstId, rows);
  await rollout(home, secondId, rows);
  const recent = await readCodexHistory(home, { threadId: firstId });
  assert.equal(recent.messages.length, 400);
  assert.equal(recent.messages[0]?.text, "Visible 50");
  const older = await readCodexHistory(home, { threadId: firstId, cursor: recent.nextCursor });
  assert.equal(older.messages.length, 50);
  assert.equal(older.messages[0]?.text, "Visible 0");
  assert.equal(older.nextCursor, undefined);
  await assert.rejects(readCodexHistory(home, { threadId: secondId, cursor: recent.nextCursor }), /stale|another source/);
  await writeFile(file, (await readFile(file, "utf8")) + JSON.stringify(record("event_msg", { type: "agent_message", message: "Changed" })) + "\n");
  await assert.rejects(readCodexHistory(home, { threadId: firstId, cursor: recent.nextCursor }), /source.*changed|source changed/i);
});

test("import never follows rollout links, never inventories external app folders, and reports unsupported compression", async (t) => {
  const { root, home } = await fixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  const source = await rollout(outside, firstId, [record("event_msg", { type: "agent_message", message: "Outside secret" })]);
  await mkdir(path.join(home, "sessions"));
  await writeFile(path.join(home, "sessions", "rollout-compressed.jsonl.zst"), "not-decompressed");
  try {
    await symlink(source, path.join(home, "sessions", path.basename(source)), "file");
  } catch (error) {
    if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    // Windows CI can lack file-symlink privileges; directory junctions still test containment.
    await symlink(path.dirname(source), path.join(home, "sessions", "linked"), "junction");
  }
  const listing = await listCodexThreads(home, {});
  assert.equal(listing.threads.length, 0);
  assert.match(listing.warnings.join(" "), /Compressed rollouts/);
  const inventory = await inspectCodexInstallation(home, { documents: outside, appData: outside, localAppData: outside, userProfile: outside });
  assert.equal(inventory.locations.some((entry) => entry.id === "outputs" || entry.id.startsWith("package-")), false);
  assert.equal(inventory.locations.find((entry) => entry.id === "auth.json")?.access, "excluded");
  await assert.rejects(readCodexHistory(home, { threadId: "../auth.json" }), /Choose a conversation/);
});
