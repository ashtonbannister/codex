import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyWorkspace, type RunRequest } from "../src/shared/types";
import { WorkspaceService } from "../src/main/services/workspace-service";

async function fixture(t: { after(fn: () => Promise<void>): void }, sharedExport = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-fabric-integration-"));
  const dataDir = path.join(root, "data");
  const folder = path.join(root, "project");
  await Promise.all([mkdir(dataDir), mkdir(folder)]);
  const projectId = randomUUID(), threadId = randomUUID(), runId = randomUUID(), noteId = randomUUID();
  const date = "2026-11-15T00:00:00.000Z";
  const state = emptyWorkspace();
  state.projects.push({ id: projectId, name: "Fabric fixture", path: folder, branch: "", kind: "folder", createdAt: date });
  state.threads.push({ id: threadId, projectId, title: "Retained conversation", createdAt: date, updatedAt: date });
  state.memories.push({ id: noteId, projectId, title: "Fixture constraint", content: "CONTROL_VALUE is 15.25, not 51.25.",
    kind: "constraint", source: "User", status: "active", createdAt: date, updatedAt: date });
  if (sharedExport) {
    state.sharedMemoryProjects = [projectId];
    await mkdir(path.join(folder, ".nova"));
    await writeFile(path.join(folder, ".nova", "MEMORY.md"), "CONTROL_VALUE is 15.25, not 51.25.");
  }
  state.runs.push({ id: runId, projectId, threadId, provider: "codex", model: "fixture", mode: "plan",
    prompt: "Record the PISTON_MARK specification.", status: "completed", createdAt: date, finishedAt: date,
    contextMemoryIds: [], verification: "not-run", events: [
      { id: randomUUID(), at: date, kind: "message", text: "PISTON_MARK = 87.25 Nm. This is an assistant claim, not an observed measurement." },
      { id: randomUUID(), at: date, kind: "thinking", text: "PRIVATE_THOUGHT_MUST_NOT_TRANSFER" },
    ] });
  await writeFile(path.join(dataDir, "workspace.json"), JSON.stringify(state));
  let service = new WorkspaceService(dataDir, () => undefined);
  await service.initialize();
  t.after(async () => { try { await service.dispose(); } finally { await rm(root, { recursive: true, force: true }); } });
  const request: RunRequest = { projectId, threadId, provider: "codex", mode: "plan", prompt: "What is the exact current PISTON_MARK value?" };
  return { projectId, threadId, noteId, request, get service() { return service; }, async restart() {
    await service.dispose(); service = new WorkspaceService(dataDir, () => undefined); await service.initialize();
  } };
}

test("Fabric is the single history path: correction and forgetting survive restart without legacy reintroduction", async (t) => {
  const f = await fixture(t);
  const first = await f.service.previewContext(f.request);
  assert.ok(first.memoryFabric);
  assert.match(first.prompt, /87\.25/);
  assert.doesNotMatch(first.prompt, /PRIVATE_THOUGHT_MUST_NOT_TRANSFER/);
  assert.equal(first.historyRunIds.length, 0);
  const page = await f.service.memoryFabricSearch({ projectId: f.projectId, query: "PISTON_MARK" });
  const original = page.items.find((item) => item.source.kind === "assistant")!.source;
  assert.equal(original.coverage.status, "legacy");
  const corrected = await f.service.memoryFabricCorrect({ projectId: f.projectId, id: original.id,
    text: "PISTON_MARK = 90.75 Nm. User-supplied corrected specification.", reason: "Correction fixture" });
  const revised = await f.service.previewContext(f.request);
  assert.match(revised.prompt, /90\.75/);
  assert.doesNotMatch(revised.prompt, /87\.25/);
  await f.restart();
  const afterRestart = await f.service.previewContext(f.request);
  assert.match(afterRestart.prompt, /90\.75/);
  assert.doesNotMatch(afterRestart.prompt, /87\.25/);
  const deleted = await f.service.memoryFabricForget({ projectId: f.projectId, id: corrected.id });
  assert.ok(deleted.forgottenSources >= 2);
  await f.restart();
  const forgotten = await f.service.previewContext(f.request);
  assert.doesNotMatch(forgotten.prompt, /87\.25|90\.75/);
  const history = await f.service.memoryFabricSearch({ projectId: f.projectId, query: "90.75", includeSuperseded: true });
  assert.equal(history.total, 0);
});

test("correcting a curated note removes its stale projection without retiring the correction on restart", async (t) => {
  const f = await fixture(t, true);
  const request = { ...f.request, prompt: "What is the exact current CONTROL_VALUE constraint?" };
  await f.service.previewContext(request);
  const page = await f.service.memoryFabricSearch({ projectId: f.projectId, query: "CONTROL_VALUE" });
  const original = page.items.find((item) => item.source.key === `note:${f.noteId}`)!.source;
  await f.service.memoryFabricCorrect({ projectId: f.projectId, id: original.id, text: "CONTROL_VALUE is 22.5." });
  assert.equal((await f.service.snapshot()).state.memories.find((item) => item.id === f.noteId)!.status, "archived");
  assert.equal((await f.service.snapshot()).state.sharedMemoryProjects?.includes(f.projectId), false,
    "an older compatibility export cannot silently reintroduce the corrected note");
  await f.restart();
  const preview = await f.service.previewContext(request);
  assert.match(preview.prompt, /22\.5/);
  assert.doesNotMatch(preview.prompt, /15\.25|51\.25/);
});

test("deleting a conversation purges its archive while preserving independent project notes", async (t) => {
  const f = await fixture(t);
  await f.service.previewContext(f.request);
  await f.service.deleteThread(f.threadId);
  const threadSources = await f.service.memoryFabricSearch({ projectId: f.projectId, threadId: f.threadId, includeSuperseded: true });
  assert.equal(threadSources.total, 0);
  const notes = await f.service.memoryFabricSearch({ projectId: f.projectId, query: "CONTROL_VALUE" });
  assert.equal(notes.total, 1);
  assert.equal((await f.service.snapshot()).state.threads.length, 0);
});
