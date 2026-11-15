import assert from "node:assert/strict";
import test from "node:test";
import type { FabricSourceInput } from "../src/shared/memory-fabric";
import { emptyWorkspace, type MemoryEntry, type Run, type Thread, type VerificationResult } from "../src/shared/types";
import { WorkspaceMemory, redactMemoryText } from "../src/main/services/memory-fabric/capture";
import type { MemoryFabricService } from "../src/main/services/memory-fabric/service";

function backend(onIngest?: (inputs: FabricSourceInput[]) => Promise<void>) {
  const sources: FabricSourceInput[] = [];
  const retired: Array<{ projectId: string; key: string; notesOnly?: boolean }> = [];
  let disposed = false;
  const service = {
    async ingest(inputs: FabricSourceInput[]) { await onIngest?.(inputs); sources.push(...inputs); return []; },
    async retire(input: { projectId: string; key: string; notesOnly?: boolean }) { retired.push(input); },
    async dispose() { disposed = true; },
  } as unknown as MemoryFabricService;
  return { service, sources, retired, isDisposed: () => disposed };
}

function run(overrides: Partial<Run> = {}): Run {
  return { id: "run-a", projectId: "project-a", threadId: "thread-a", provider: "claude", model: "selected-model",
    mode: "plan", prompt: "Keep the signed value −3.2° and do not guess.", status: "completed",
    createdAt: "2026-11-15T12:00:00.000Z", finishedAt: "2026-11-15T12:01:00.000Z",
    contextMemoryIds: [], events: [], verification: "not-run", baseCommit: "abc123", ...overrides };
}

function note(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id: "note-a", projectId: "project-a", title: "Constraint", content: "Do not modify OEM state.",
    kind: "constraint", source: "User note", status: "active", createdAt: "2026-11-15T12:00:00.000Z",
    updatedAt: "2026-11-15T12:00:00.000Z", ...overrides };
}

test("capture construction is inert until owned-workspace initialization", async () => {
  const memory = new WorkspaceMemory("/unvalidated-oem-location-must-not-be-opened");
  assert.throws(() => memory.service, /not been initialized/);
  assert.equal(memory.migrationPending, false);
  await memory.dispose();
  assert.throws(() => memory.initialize(emptyWorkspace()), /shutting down/);
});

test("recognizable secrets are filtered before retention with explicit coverage", () => {
  const text = 'api_key="super-secret-value"\npassword=hunter2\nBearer abcdefghijklmnopqrstuvwxyz\n'
    + "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n"
    + "-----BEGIN RSA PRIVATE KEY-----\nprivate_material\n-----END RSA PRIVATE KEY-----\n"
    + "https://ashton:secret@example.test/path\nKeep −3.2° unchanged unless approved.";
  const result = redactMemoryText(text);
  assert.ok(result.redacted);
  assert.equal(result.originalCharacters, text.length);
  assert.match(result.omissions.join(" "), /not a complete secret detector/);
  for (const secret of ["super-secret-value", "hunter2", "abcdefghijklmnopqrstuvwxyz", "private_material", "ashton:secret"])
    assert.ok(!result.text.includes(secret), `secret remained: ${secret}`);
  assert.match(result.text, /Keep −3.2° unchanged unless approved/);
});

test("source character and UTF-8 byte caps disclose omission without broken Unicode", () => {
  const oversized = redactMemoryText("中".repeat(2 * 1024 * 1024 + 10));
  assert.ok(oversized.text.length <= 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(oversized.text) <= 4 * 1024 * 1024);
  assert.ok(!oversized.text.includes("\uFFFD"));
  assert.match(oversized.omissions.join(" "), /UTF-16/);
  assert.match(oversized.omissions.join(" "), /UTF-8/);
  const malformed = redactMemoryText("bad isolated \uD800 value");
  assert.match(malformed.omissions.join(" "), /isolated UTF-16/);
});

test("migration retains scoped visible sources, flags legacy coverage, and retires archived notes", async () => {
  const fake = backend();
  const memory = new WorkspaceMemory("unused", fake.service);
  const state = emptyWorkspace();
  state.memories.push(note(), note({ id: "archived-a", status: "archived" }));
  state.runs.push(run({ events: [
    { id: "message-a", at: "2026-11-15T12:00:01.000Z", kind: "message", text: "Visible answer." },
    { id: "tool-a", at: "2026-11-15T12:00:02.000Z", kind: "tool", text: "Command exited 0." },
    { id: "thinking-a", at: "2026-11-15T12:00:00.000Z", kind: "thinking", text: "Not portable reasoning." },
    { id: "usage-a", at: "2026-11-15T12:00:00.000Z", kind: "usage", text: "Usage-only data." },
  ] }));
  const imported: Thread = { id: "imported-thread", projectId: "project-b", title: "Imported topic",
    createdAt: "2026-11-15T11:00:00.000Z", updatedAt: "2026-11-15T12:00:00.000Z", codex: {
      home: "/never/open/this/oem/home", sourceThreadId: "native-id", sourceCwd: "/never/adopt/this/cwd",
      importedAt: "2026-11-15T12:00:00.000Z", sourceArchived: false, historyTruncated: true, warnings: [],
      history: [{ id: "m1", turnId: "t1", role: "user", text: "Imported visible user instruction." }],
    } };
  state.threads.push(imported);
  memory.initialize(state);
  assert.equal(memory.migrationPending, true);
  memory.initialize(state);
  await memory.idle();
  assert.equal(memory.migrationPending, false);
  assert.equal(fake.sources.filter((input) => input.key === "note:note-a").length, 1);
  assert.ok(fake.sources.every((input) => input.coverage.status === "legacy"));
  assert.ok(fake.sources.some((input) => input.key === "run:run-a:event:message-a"));
  assert.ok(fake.sources.some((input) => input.key === "run:run-a:event:tool-a"));
  assert.ok(!fake.sources.some((input) => /thinking|usage-a/.test(input.key)));
  assert.ok(!fake.sources.some((input) => /Not portable reasoning|never\/open/.test(input.text)));
  const importedSource = fake.sources.find((input) => input.key === "import:imported-thread:m1:t1")!;
  assert.equal(importedSource.projectId, "project-b");
  assert.match(importedSource.coverage.omissions.join(" "), /message time was unavailable/);
  assert.deepEqual(fake.retired, [{ projectId: "project-a", key: "note:archived-a", notesOnly: true }]);
  await memory.dispose();
  assert.ok(fake.isDisposed());
});

test("fresh capture excludes thinking and records full retained text before display truncation", async () => {
  const fake = backend();
  const memory = new WorkspaceMemory("unused", fake.service);
  memory.initialize(emptyWorkspace());
  await memory.idle();
  const current = run();
  const text = "visible ".repeat(40_000) + "retained tail";
  memory.captureRunPrompt(current);
  memory.captureEvent(current, { id: "visible-new", at: current.createdAt, kind: "message", text });
  memory.captureEvent(current, { id: "private-new", at: current.createdAt, kind: "thinking", text: "Do not import this." });
  memory.captureEvent(current, { id: "tool-new", at: current.createdAt, kind: "tool", text: "Observed tool status only." });
  memory.captureOutcome(current);
  await memory.idle();
  const captured = fake.sources.find((input) => input.key === "run:run-a:event:visible-new")!;
  assert.equal(captured.text, text);
  assert.equal(captured.coverage.status, "complete");
  assert.equal(captured.coverage.retainedCharacters, text.length);
  assert.equal(fake.sources.find((input) => input.key.endsWith("tool-new"))!.coverage.status, "bounded");
  assert.ok(!fake.sources.some((input) => input.key.includes("private-new")));
  assert.match(fake.sources.find((input) => input.kind === "checkpoint")!.text, /does not establish that verification passed/);
  await memory.dispose();
});

test("migration precedes live revisions of the same origin", async () => {
  const fake = backend();
  const memory = new WorkspaceMemory("unused", fake.service);
  const state = emptyWorkspace();
  state.memories.push(note({ content: "Earlier retained value." }));
  memory.initialize(state);
  memory.captureNote(note({ content: "Newly confirmed value." }));
  await memory.idle();
  assert.deepEqual(fake.sources.filter((input) => input.key === "note:note-a").map((input) => input.text),
    ["Earlier retained value.", "Newly confirmed value."]);
  await memory.dispose();
});

test("verification is a separate revision-scoped observation rather than an agent success claim", async () => {
  const fake = backend();
  const memory = new WorkspaceMemory("unused", fake.service);
  memory.initialize(emptyWorkspace());
  const result: VerificationResult = { id: "verify-a", projectId: "project-a", threadId: "thread-a", runId: "run-a",
    profileId: "profile-a", profileName: "Targeted checks", executable: "node", args: ["--test"], cwd: "/project",
    status: "passed", createdAt: "2026-11-15T12:03:00.000Z", exitCode: 0, output: "One check passed.", truncated: true,
    inputRevision: { head: "abc123", fingerprint: "input", complete: true },
    outputRevision: { head: "abc123", fingerprint: "output", complete: true },
  };
  memory.captureVerification(result);
  await memory.idle();
  const input = fake.sources.find((entry) => entry.key === "verification:verify-a")!;
  assert.equal(input.kind, "tool");
  assert.equal(input.revision, "abc123");
  assert.equal(input.coverage.status, "bounded");
  assert.equal(JSON.parse(input.text).exitCode, 0);
  assert.match(JSON.parse(input.text).scope, /recorded revision/);
  await memory.dispose();
});

test("ingestion failures are visible and idle does not pretend capture succeeded", async () => {
  const fake = backend(async () => { throw new Error("Storage offline."); });
  const memory = new WorkspaceMemory("unused", fake.service);
  const state = emptyWorkspace(); state.memories.push(note());
  memory.initialize(state);
  await assert.rejects(memory.idle(), /Storage offline/);
  assert.match(memory.captureWarning!, /capture is incomplete/);
  await assert.rejects(memory.dispose(), /Storage offline/);
  assert.ok(fake.isDisposed());
});

test("queue overflow is explicit but already accepted work still drains", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fake = backend(async () => { await gate; });
  const memory = new WorkspaceMemory("unused", fake.service);
  memory.initialize(emptyWorkspace()); await memory.idle();
  const current = run();
  for (let index = 0; index < 80; index++) memory.captureEvent(current,
    { id: `event-${index}`, at: current.createdAt, kind: "message", text: `Visible message ${index}.` });
  assert.match(memory.captureWarning!, /overflowed/);
  release();
  await assert.rejects(memory.idle(), /overflowed/);
  assert.equal(fake.sources.length, 64);
  await assert.rejects(memory.dispose(), /overflowed/);
});
