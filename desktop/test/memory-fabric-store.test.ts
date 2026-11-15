import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FabricPacketReceipt, FabricSource, FabricSourceInput } from "../src/shared/memory-fabric";
import { MemoryFabricStore } from "../src/main/services/memory-fabric/store";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "nova-memory-")));
  const store = await MemoryFabricStore.open(root);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store };
}

function source(text: string, overrides: Partial<FabricSourceInput> = {}): FabricSourceInput {
  return { key: "run-a:user", projectId: "project-a", threadId: "thread-a", runId: "run-a", kind: "user",
    title: "User request", text, observedAt: "2026-11-15T01:00:00.000Z",
    coverage: { status: "complete", omissions: [], retainedCharacters: text.length }, ...overrides };
}

function receipt(value: FabricSource): FabricPacketReceipt {
  const content = JSON.stringify({ source: value.id });
  return { projectId: value.projectId, runId: "run-b", packet: {
    version: 1, id: randomUUID(), projectId: value.projectId, watermark: 1, createdAt: new Date().toISOString(),
    mode: "compact", obligations: [], omittedSourceIds: [], warnings: [], content,
    sha256: createHash("sha256").update(content).digest("hex"), characters: content.length,
    estimatedTokens: Math.ceil(content.length / 4), candidateCharacters: 1, selectedCharacters: 1,
    items: [{ sourceId: value.id, sourceKey: value.key, title: value.title, kind: value.kind, status: value.status,
      observedAt: value.observedAt, sha256: value.sha256, coverage: value.coverage, spans: [], expanded: false, omittedCharacters: 0 }],
  } };
}

test("Fabric retains exact authorized text, hashes and coverage and survives reopening", async (t) => {
  const { root, store } = await fixture(t);
  const text = "Keep 007 and −3.5°, not −1.5°.\nUnicode 🛠️; literal null \0; exact ID A-009.\n".repeat(100);
  const input = source(text, { kind: "import", coverage: { status: "legacy", omissions: ["Older history was not imported."], retainedCharacters: text.length } });
  const [saved] = store.ingest([input]);
  assert.equal(saved.sha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(saved.coverage.status, "legacy");
  assert.deepEqual(saved.coverage.omissions, input.coverage.omissions);
  assert.ok(saved.compressedBytes < Buffer.byteLength(text));
  assert.equal(store.read({ projectId: "project-a", id: saved.id }).text, text);
  store.close();
  const reopened = await MemoryFabricStore.open(root);
  try { assert.equal(reopened.read({ projectId: "project-a", id: saved.id }).text, text); }
  finally { reopened.close(); }
});

test("Fabric raw FTS finds evidence omitted by the capsule and returns exact paged spans", async (t) => {
  const { store } = await fixture(t);
  const text = "Routine build notes and repeated context. ".repeat(3_000) + "The rare NyquistLighthouse token is at the end: 01234.";
  const [saved] = store.ingest([source(text)]);
  const result = store.search({ projectId: "project-a", query: "NyquistLighthouse" });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].source.id, saved.id);
  assert.ok(result.items[0].excerpt.includes("NyquistLighthouse"));
  assert.equal(result.items[0].excerpt, text.slice(result.items[0].start, result.items[0].end));
  const candidates = store.candidates({ projectId: "project-a", prompt: "What was NyquistLighthouse?" });
  assert.equal(candidates.candidates[0].text, text);
  const first = store.read({ projectId: "project-a", id: saved.id, limit: 64_000 });
  assert.equal(first.text, text.slice(0, 64_000));
  assert.equal(first.nextOffset, 64_000);
  const second = store.read({ projectId: "project-a", id: saved.id, offset: first.nextOffset, limit: 64_000 });
  assert.equal(first.text + second.text, text);
});

test("Fabric isolates project scope and quotes all FTS syntax", async (t) => {
  const { store } = await fixture(t);
  const [a, b] = store.ingest([source("secretword belongs to project A"), source("secretword belongs to project B", { projectId: "project-b" })]);
  assert.deepEqual(store.search({ projectId: "project-a", query: "secretword" }).items.map((item) => item.source.id), [a.id]);
  assert.throws(() => store.read({ projectId: "project-a", id: b.id }), /unavailable/);
  assert.throws(() => store.correct({ projectId: "project-a", id: b.id, text: "wrong scope" }), /unavailable/);
  assert.throws(() => store.forget({ projectId: "project-a", id: b.id }), /unavailable/);
  assert.doesNotThrow(() => store.search({ projectId: "project-a", query: '" OR * NEAR(secretword) - AND {x}:', limit: 10 }));
  assert.throws(() => store.search({ projectId: "project-a", limit: 10_000 }), /budget/);
  assert.throws(() => store.read({ projectId: "project-a", id: a.id, offset: -1 }), /budget/);
});

test("Fabric revisions never let repeated capture or new external revisions undo a correction", async (t) => {
  const { store } = await fixture(t);
  const input = source("Target is 3.5 degrees.");
  const [original] = store.ingest([input]);
  const packet = receipt(original);
  store.recordPacket(packet);
  const corrected = store.correct({ projectId: "project-a", id: original.id, text: "Target is 1.5 degrees, not 3.5.", reason: "User correction" });
  assert.equal(corrected.kind, "correction");
  assert.equal(corrected.supersedesId, original.id);
  assert.equal(store.read({ projectId: "project-a", id: original.id }).source.status, "superseded");
  assert.throws(() => store.recordPacket({ ...packet, packet: { ...packet.packet, id: randomUUID() } }), /changed/);
  const [replayed] = store.ingest([input]);
  assert.equal(replayed.id, original.id);
  assert.equal(replayed.status, "superseded");
  const [changedExternal] = store.ingest([source("Imported source now says 2.0 degrees.")]);
  assert.equal(changedExternal.status, "superseded");
  assert.equal(store.search({ projectId: "project-a" }).items[0].source.id, corrected.id);
  assert.equal(store.stats("project-a").activeSources, 1);
  assert.equal(store.search({ projectId: "project-a", includeSuperseded: true }).total, 3);
  const restored = store.correct({ projectId: "project-a", id: corrected.id, text: input.text, reason: "Explicitly restoring prior value" });
  assert.equal(restored.kind, "correction");
  assert.equal(restored.status, "active");
  assert.notEqual(restored.id, original.id);
  assert.equal(store.search({ projectId: "project-a" }).items[0].source.id, restored.id);
});

test("Fabric legacy startup replay cannot replace a full pre-truncation capture", async (t) => {
  const { store } = await fixture(t);
  const text = "Full source with late evidence retained before display truncation.";
  const [full] = store.ingest([source(text)]);
  const legacy = text.slice(0, 20);
  const [replayed] = store.ingest([source(legacy, { coverage: { status: "legacy", omissions: ["Display was truncated"], retainedCharacters: legacy.length } })]);
  assert.equal(replayed.id, full.id);
  assert.equal(store.read({ projectId: "project-a", id: full.id }).text, text);
  assert.equal(store.stats("project-a").sources, 1);
});

test("Fabric explicit corrections redact recognizable credentials with truthful coverage", async (t) => {
  const { store } = await fixture(t);
  const [original] = store.ingest([source("Original note", { kind: "note" })]);
  const small = "password='x'";
  const corrected = store.correct({ projectId: "project-a", id: original.id, text: small, reason: 'api_key="synthetic-reason-secret"' });
  const page = store.read({ projectId: "project-a", id: corrected.id });
  assert.ok(page.text.includes("[REDACTED_CREDENTIAL]"));
  assert.ok(!page.text.includes("'x'"));
  assert.ok(!page.source.sourceRef?.includes("synthetic-reason-secret"));
  assert.equal(page.source.coverage.status, "bounded");
  assert.equal(page.source.coverage.redacted, true);
  assert.equal(page.source.coverage.originalCharacters, small.length);
  assert.equal(page.source.coverage.retainedCharacters, page.text.length);
  assert.ok(page.text.length > small.length);
  const privateKey = "Before\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_MATERIAL\n-----END PRIVATE KEY-----\nAfter";
  const next = store.correct({ projectId: "project-a", id: corrected.id, text: privateKey });
  const nextPage = store.read({ projectId: "project-a", id: next.id });
  assert.ok(nextPage.text.includes("[REDACTED_PRIVATE_KEY]"));
  assert.ok(!nextPage.text.includes("SYNTHETIC_PRIVATE_MATERIAL"));
  assert.equal(next.coverage.originalCharacters, privateKey.length);
  assert.equal(next.coverage.retainedCharacters, nextPage.text.length);
});

test("Fabric manual-note exclusions do not hide explicit corrections under the same origin", async (t) => {
  const { store } = await fixture(t);
  const input = source("Nyquist original note", { key: "note:curated", kind: "note" });
  const [original] = store.ingest([input]);
  const query = { projectId: "project-a", prompt: "Nyquist", excludedKeys: [input.key] };
  assert.equal(store.candidates(query).candidates.length, 0);
  const correction = store.correct({ projectId: "project-a", id: original.id, text: "Nyquist corrected note" });
  assert.deepEqual(store.candidates(query).candidates.map((candidate) => candidate.source.id), [correction.id]);
});

test("Fabric forgetting purges the entire origin, dependent packets and indexes and prevents resurrection", async (t) => {
  const { store } = await fixture(t);
  const input = source("old deletion-canary");
  const [original] = store.ingest([input]);
  store.recordPacket(receipt(original));
  const corrected = store.correct({ projectId: "project-a", id: original.id, text: "new deletion-canary" });
  store.recordPacket(receipt(corrected));
  store.ingest([source("unrelated evidence", { key: "other-origin" })]);
  const result = store.forget({ projectId: "project-a", id: original.id });
  assert.equal(result.forgottenSources, 2);
  assert.equal(result.invalidatedPackets, 2);
  assert.equal(store.search({ projectId: "project-a", query: "deletion-canary", includeSuperseded: true }).total, 0);
  assert.equal(store.stats("project-a").packets, 0);
  assert.equal(store.stats("project-a").sources, 1);
  assert.throws(() => store.read({ projectId: "project-a", id: corrected.id }), /unavailable/);
  assert.deepEqual(store.ingest([input, source("Different content on the same forgotten origin")]), []);
});

test("Fabric retirement hides active notes and replay does not reactivate them", async (t) => {
  const { store } = await fixture(t);
  const input = source("Archived note", { key: "note-a", kind: "note" });
  const [saved] = store.ingest([input]);
  const packet = receipt(saved);
  store.recordPacket(packet);
  store.retire({ projectId: "project-a", key: "note-a" });
  assert.equal(store.search({ projectId: "project-a" }).total, 0);
  assert.equal(store.search({ projectId: "project-a", includeSuperseded: true }).total, 1);
  assert.equal(store.ingest([input])[0].status, "superseded");
  assert.throws(() => store.recordPacket({ ...packet, packet: { ...packet.packet, id: randomUUID() } }), /changed/);
  assert.equal(store.read({ projectId: "project-a", id: saved.id }).text, input.text);
  // Retirement is not forgetting: an explicit correction remains possible.
  assert.equal(store.correct({ projectId: "project-a", id: saved.id, text: "User-restored note" }).status, "active");
});

test("Fabric archived-note bootstrap retirement preserves an explicit correction across restart", async (t) => {
  const { root, store } = await fixture(t);
  const input = source("Original manual note", { key: "note:restart-note", kind: "note" });
  const [saved] = store.ingest([input]);
  const corrected = store.correct({ projectId: "project-a", id: saved.id, text: "Explicitly corrected manual note" });
  store.close();
  const restarted = await MemoryFabricStore.open(root);
  try {
    restarted.ingest([input]);
    restarted.retire({ projectId: "project-a", key: input.key, notesOnly: true });
    assert.equal(restarted.read({ projectId: "project-a", id: corrected.id }).source.status, "active");
    assert.equal(restarted.search({ projectId: "project-a" }).items[0].source.id, corrected.id);
    const [ordinary] = restarted.ingest([source("Archived without correction", { key: "note:ordinary", kind: "note" })]);
    restarted.retire({ projectId: "project-a", key: ordinary.key, notesOnly: true });
    assert.equal(restarted.read({ projectId: "project-a", id: ordinary.id }).source.status, "superseded");
  } finally { restarted.close(); }
});

test("Fabric duplicate ingestion is idempotent and pagination and excluded keys are bounded", async (t) => {
  const { store } = await fixture(t);
  const input = source("One source, one origin.");
  const [first] = store.ingest([input, input]);
  const [again] = store.ingest([input]);
  assert.equal(again.id, first.id);
  assert.equal(store.stats("project-a").sources, 1);
  store.ingest(Array.from({ length: 5 }, (_, index) => source(`Item ${index}`, { key: `origin-${index}` })));
  assert.equal(store.search({ projectId: "project-a", offset: 2, limit: 2 }).items.length, 2);
  assert.equal(store.search({ projectId: "project-a", offset: 2, limit: 2 }).total, 6);
  const result = store.candidates({ projectId: "project-a", prompt: "One source", excludedKeys: [input.key] });
  assert.ok(result.candidates.every((candidate) => candidate.source.key !== input.key));
  assert.throws(() => store.ingest([source("invalid manifest", { coverage: { status: "complete", omissions: [], retainedCharacters: 1 } })]), /coverage/);
});

test("Fabric refuses redirected owned storage instead of following it", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "nova-memory-links-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const data = path.join(root, "nova");
  const elsewhere = path.join(root, "elsewhere");
  await mkdir(data); await mkdir(elsewhere);
  await symlink(elsewhere, path.join(data, "memory-fabric"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(MemoryFabricStore.open(data), /redirected/);
});
