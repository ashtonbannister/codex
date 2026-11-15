import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, chmod } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import type {
  FabricCandidate, FabricCorrectionRequest, FabricCoverage, FabricForgetRequest,
  FabricForgetResult, FabricPacketReceipt, FabricPrepareRequest, FabricReadRequest,
  FabricReadResult, FabricSearchQuery, FabricSearchResult, FabricSource,
  FabricSourceInput, FabricStats,
} from "../../../shared/memory-fabric";
import { makeCapsule } from "./codec";
import { redactMemoryMetadata, redactMemoryText } from "./redaction";

const MAX_SOURCE_CHARACTERS = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATE_CHARACTERS = 4 * 1024 * 1024;
const KINDS = new Set(["user", "assistant", "note", "tool", "import", "correction", "checkpoint"]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const tombstoneKey = (projectId: string, key: string) => digest(JSON.stringify([projectId, key]));
type Row = Record<string, unknown>;

function string(value: unknown, label: string, maximum: number, empty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim()))
    throw new Error(`Invalid memory ${label}.`);
  return value;
}
function id(value: unknown, label = "identifier"): string {
  const result = string(value, label, 100);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(result)) throw new Error(`Invalid memory ${label}.`);
  return result;
}
function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error("Invalid memory page or character budget.");
  return value;
}
function optional(value: unknown, label: string, maximum = 1_024): string | undefined {
  return value === undefined ? undefined : string(value, label, maximum);
}
function timestamp(value: unknown): string {
  const text = string(value, "timestamp", 80);
  if (!Number.isFinite(Date.parse(text))) throw new Error("Invalid memory timestamp.");
  return new Date(text).toISOString();
}
function coverage(value: FabricCoverage, text: string): FabricCoverage {
  if (!value || !["complete", "bounded", "legacy"].includes(value.status) ||
      !Array.isArray(value.omissions) || value.omissions.length > 32)
    throw new Error("Invalid memory coverage manifest.");
  const result: FabricCoverage = {
    status: value.status,
    omissions: value.omissions.map((entry) => string(entry, "omission", 2_048)),
    retainedCharacters: text.length,
  };
  if (value.originalCharacters !== undefined)
    // Redaction placeholders can be longer than the original secret.
    result.originalCharacters = integer(value.originalCharacters, text.length, 0, Number.MAX_SAFE_INTEGER);
  if (value.redacted !== undefined) {
    if (typeof value.redacted !== "boolean") throw new Error("Invalid memory redaction flag.");
    result.redacted = value.redacted;
  }
  if (value.retainedCharacters !== text.length) throw new Error("Memory coverage does not match the retained source.");
  return result;
}
function sourceInput(input: FabricSourceInput): FabricSourceInput {
  if (!input || typeof input !== "object" || !KINDS.has(input.kind)) throw new Error("Invalid memory source.");
  const text = string(input.text, "source text", MAX_SOURCE_CHARACTERS, true);
  if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) throw new Error("Memory source is too large; import it in explicit bounded pages.");
  return {
    key: string(input.key, "source key", 1_024),
    projectId: id(input.projectId, "project"),
    ...(input.threadId === undefined ? {} : { threadId: id(input.threadId, "thread") }),
    ...(input.runId === undefined ? {} : { runId: id(input.runId, "run") }),
    provider: optional(input.provider, "provider", 120),
    kind: input.kind,
    title: string(input.title, "title", 1_024),
    text,
    observedAt: timestamp(input.observedAt),
    sourceRef: optional(input.sourceRef, "source reference", 4_096),
    revision: optional(input.revision, "revision"),
    coverage: coverage(input.coverage, text),
  };
}

/** No user input is ever parsed as FTS syntax. */
function ftsQuery(value: string): string {
  return [...new Set(value.match(/[\p{L}\p{N}_][\p{L}\p{N}_./-]{0,79}/gu) ?? [])]
    .slice(0, 24).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

/** Synchronous SQLite and compression live only in the memory worker in production. */
export class MemoryFabricStore {
  private closed = false;

  private constructor(private readonly db: DatabaseSync) {
    const version = Number((db.prepare("PRAGMA user_version").get() as Row).user_version);
    if (version > 1) throw new Error("This memory database needs a newer Nova version. It has not been overwritten.");
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 1000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS fabric_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO fabric_meta VALUES ('watermark', 0);
      CREATE TABLE IF NOT EXISTS fabric_sources (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, origin_key TEXT NOT NULL,
        thread_id TEXT, run_id TEXT, kind TEXT NOT NULL, observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL, status TEXT NOT NULL, sha256 TEXT NOT NULL,
        metadata TEXT NOT NULL, payload BLOB NOT NULL, characters INTEGER NOT NULL,
        compressed_bytes INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fabric_sources_project ON fabric_sources(project_id, status, observed_at);
      CREATE INDEX IF NOT EXISTS fabric_sources_origin ON fabric_sources(project_id, origin_key);
      CREATE INDEX IF NOT EXISTS fabric_sources_hash ON fabric_sources(project_id, origin_key, sha256);
      CREATE INDEX IF NOT EXISTS fabric_sources_thread ON fabric_sources(project_id, thread_id, observed_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS fabric_fts USING fts5(source_id UNINDEXED, title, body, tokenize = 'unicode61');
      CREATE TABLE IF NOT EXISTS fabric_tombstones (origin_hash TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fabric_packets (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
        created_at TEXT NOT NULL, receipt TEXT NOT NULL, invalidated INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS fabric_packet_sources (
        packet_id TEXT NOT NULL REFERENCES fabric_packets(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES fabric_sources(id) ON DELETE CASCADE,
        PRIMARY KEY(packet_id, source_id)
      );
      CREATE INDEX IF NOT EXISTS fabric_packet_sources_source ON fabric_packet_sources(source_id);
      PRAGMA user_version = 1;
    `);
    // FTS maintains its own segments; secure-delete also removes deleted terms there.
    db.exec("INSERT INTO fabric_fts(fabric_fts, rank) VALUES('secure-delete', 1)");
  }

  static async open(dataDir: string): Promise<MemoryFabricStore> {
    if (!path.isAbsolute(dataDir) || /[\0\r\n]/.test(dataDir)) throw new Error("Memory storage requires Nova's absolute data directory.");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const root = await realpath(dataDir);
    const directory = path.join(root, "memory-fabric");
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(directory) !== directory)
      throw new Error("Nova memory storage is redirected; it was not opened.");
    const filename = path.join(directory, "memory.sqlite");
    for (const entry of [filename, `${filename}-wal`, `${filename}-shm`]) {
      try {
        const file = await lstat(entry);
        if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1)
          throw new Error("Nova memory database is redirected or shared; it was not opened.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const db = new DatabaseSync(filename);
    try {
      const store = new MemoryFabricStore(db);
      await chmod(filename, 0o600);
      return store;
    } catch (error) { db.close(); throw error; }
  }

  private ready(): void { if (this.closed) throw new Error("Nova memory is closed."); }
  private watermark(): number {
    return Number((this.db.prepare("SELECT value FROM fabric_meta WHERE key='watermark'").get() as Row).value);
  }
  private changed(): void { this.db.exec("UPDATE fabric_meta SET value = value + 1 WHERE key='watermark'"); }
  private transaction<T>(operation: () => T): T {
    this.ready();
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private source(row: Row): FabricSource {
    const result = JSON.parse(String(row.metadata)) as FabricSource;
    result.status = row.status as FabricSource["status"];
    return result;
  }
  private decode(row: Row): string {
    const body = brotliDecompressSync(row.payload as Uint8Array, { maxOutputLength: MAX_SOURCE_BYTES }).toString("utf8");
    if (body.length !== Number(row.characters) || digest(body) !== row.sha256)
      throw new Error("Memory source integrity check failed. The record was not used.");
    return body;
  }
  private row(projectId: string, sourceId: string): Row {
    const row = this.db.prepare("SELECT * FROM fabric_sources WHERE id=? AND project_id=?").get(id(sourceId), id(projectId)) as Row | undefined;
    if (!row) throw new Error("Memory source is unavailable in this project.");
    return row;
  }
  private invalidate(sourceIds: string[]): number {
    if (!sourceIds.length) return 0;
    let count = 0;
    for (const sourceId of sourceIds)
      count += Number(this.db.prepare(`UPDATE fabric_packets SET invalidated=1 WHERE invalidated=0 AND id IN
        (SELECT packet_id FROM fabric_packet_sources WHERE source_id=?)`).run(sourceId).changes);
    return count;
  }

  ingest(inputs: FabricSourceInput[], explicitCorrection = false): FabricSource[] {
    if (!Array.isArray(inputs) || inputs.length > 64) throw new Error("Memory ingestion accepts at most 64 sources per batch.");
    const values = inputs.map(sourceInput);
    if (values.reduce((sum, value) => sum + Buffer.byteLength(value.text), 0) > MAX_BATCH_BYTES)
      throw new Error("Memory ingestion batch exceeds its bounded byte budget.");
    return this.transaction(() => values.flatMap((input) => {
      if (this.db.prepare("SELECT 1 FROM fabric_tombstones WHERE origin_hash=?").get(tombstoneKey(input.projectId, input.key))) return [];
      const sha256 = digest(input.text);
      const existing = explicitCorrection ? undefined : this.db.prepare("SELECT * FROM fabric_sources WHERE project_id=? AND origin_key=? AND sha256=? ORDER BY created_at DESC, id DESC LIMIT 1")
        .get(input.projectId, input.key, sha256) as Row | undefined;
      if (existing) return [this.source(existing)];
      const previous = this.db.prepare("SELECT * FROM fabric_sources WHERE project_id=? AND origin_key=? AND status='active' ORDER BY created_at DESC LIMIT 1")
        .get(input.projectId, input.key) as Row | undefined;
      // A startup migration may see only the old UI-truncated projection of a
      // source already captured before truncation. It is not a new revision.
      if (previous && input.coverage.status === "legacy" && this.source(previous).coverage.status !== "legacy")
        return [this.source(previous)];
      // Recapturing an external event must not silently undo a user's correction.
      const preserveCorrection = previous?.kind === "correction" && input.kind !== "correction";
      if (previous && !preserveCorrection) {
        this.db.prepare("UPDATE fabric_sources SET status='superseded' WHERE project_id=? AND origin_key=? AND status='active'")
          .run(input.projectId, input.key);
        this.invalidate([String(previous.id)]);
      }
      const payload = brotliCompressSync(Buffer.from(input.text), { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
      const { text: _text, ...metadata } = input;
      const source: FabricSource = {
        ...metadata, id: randomUUID(), sha256, createdAt: new Date().toISOString(),
        status: preserveCorrection ? "superseded" : "active",
        ...(previous && !preserveCorrection ? { supersedesId: String(previous.id) } : {}),
        compressedBytes: payload.length, capsule: makeCapsule(input.text),
      };
      this.db.prepare(`INSERT INTO fabric_sources
        (id,project_id,origin_key,thread_id,run_id,kind,observed_at,created_at,status,sha256,metadata,payload,characters,compressed_bytes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(source.id, source.projectId, source.key, source.threadId ?? null,
          source.runId ?? null, source.kind, source.observedAt, source.createdAt, source.status, sha256,
          JSON.stringify(source), payload, input.text.length, payload.length);
      this.db.prepare("INSERT INTO fabric_fts(source_id,title,body) VALUES (?,?,?)").run(source.id, source.title, input.text);
      this.changed();
      return [source];
    }));
  }

  search(query: FabricSearchQuery): FabricSearchResult {
    this.ready();
    if (!query || typeof query !== "object") throw new Error("Invalid memory query.");
    const projectId = id(query.projectId, "project");
    const offset = integer(query.offset, 0, 0, 1_000_000);
    const limit = integer(query.limit, 20, 1, 100);
    const text = string(query.query ?? "", "query", 8_192, true);
    if (query.includeSuperseded !== undefined && typeof query.includeSuperseded !== "boolean") throw new Error("Invalid memory history filter.");
    const term = ftsQuery(text);
    const params: Array<string | number> = [projectId];
    const predicates = ["s.project_id=?"];
    if (!query.includeSuperseded) predicates.push("s.status='active'");
    if (query.threadId !== undefined) { predicates.push("s.thread_id=?"); params.push(id(query.threadId, "thread")); }
    const join = term ? " JOIN fabric_fts ON fabric_fts.source_id=s.id" : "";
    if (term) { predicates.push("fabric_fts MATCH ?"); params.push(term); }
    const from = `FROM fabric_sources s${join} WHERE ${predicates.join(" AND ")}`;
    const total = Number((this.db.prepare(`SELECT count(*) AS count ${from}`).get(...params) as Row).count);
    const rows = this.db.prepare(`SELECT s.*, ${term ? "bm25(fabric_fts)" : "0"} AS rank ${from}
      ORDER BY ${term ? "rank ASC," : ""} s.observed_at DESC, s.id ASC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[];
    const terms = text.toLocaleLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_./-]{0,79}/gu) ?? [];
    return {
      items: rows.map((row) => {
        const body = this.decode(row);
        const lower = body.toLocaleLowerCase();
        const matches = terms.map((term) => lower.indexOf(term)).filter((at) => at >= 0);
        const start = Math.max(0, (matches.length ? Math.min(...matches) : 0) - 100);
        const end = Math.min(body.length, start + 700);
        return { source: this.source(row), excerpt: body.slice(start, end), start, end, score: term ? Math.max(0, -Number(row.rank)) : 0 };
      }), total, offset, limit, watermark: this.watermark(),
    };
  }

  read(request: FabricReadRequest): FabricReadResult {
    this.ready();
    const row = this.row(request.projectId, request.id);
    const body = this.decode(row);
    const offset = integer(request.offset, 0, 0, body.length);
    const limit = integer(request.limit, 64_000, 1, 64_000);
    const nextOffset = Math.min(offset + limit, body.length);
    return { source: this.source(row), text: body.slice(offset, nextOffset), offset, totalCharacters: body.length,
      ...(nextOffset < body.length ? { nextOffset } : {}) };
  }

  candidates(request: FabricPrepareRequest): { candidates: FabricCandidate[]; watermark: number; warnings: string[] } {
    this.ready();
    const projectId = id(request.projectId, "project");
    const prompt = string(request.prompt, "request", 262_144, true);
    if (request.excludedKeys && (!Array.isArray(request.excludedKeys) || request.excludedKeys.length > 2_048))
      throw new Error("Too many excluded memory keys.");
    const excluded = (request.excludedKeys ?? []).map((key) => string(key, "excluded key", 1_024));
    // Curated note origins stay on the separate freshness-checked path. A user
    // correction is a new Fabric assertion and must not inherit that exclusion.
    const notExcluded = excluded.length ? ` AND (s.origin_key NOT IN (${excluded.map(() => "?").join(",")}) OR s.kind='correction')` : "";
    const term = ftsQuery(prompt);
    let rows: Row[] = [];
    if (term) rows = this.db.prepare(`SELECT s.*, bm25(fabric_fts) AS rank FROM fabric_sources s
      JOIN fabric_fts ON fabric_fts.source_id=s.id WHERE s.project_id=? AND fabric_fts MATCH ?${notExcluded}
      ORDER BY rank ASC, s.observed_at DESC LIMIT 40`).all(projectId, term, ...excluded) as Row[];
    const recent = this.db.prepare(`SELECT s.*, 0 AS rank FROM fabric_sources s WHERE s.project_id=?${notExcluded}
      AND s.status='active' ORDER BY ${request.threadId ? "CASE WHEN s.thread_id=? THEN 0 ELSE 1 END," : ""}
      s.observed_at DESC, s.id DESC LIMIT 12`)
      .all(projectId, ...excluded, ...(request.threadId ? [id(request.threadId, "thread")] : [])) as Row[];
    const candidates: FabricCandidate[] = [];
    const seen = new Set<string>();
    const warnings: string[] = [];
    let characters = 0;
    for (const row of [...rows, ...recent]) {
      if (seen.has(String(row.id))) continue;
      seen.add(String(row.id));
      if (candidates.length >= 32 || characters + Number(row.characters) > MAX_CANDIDATE_CHARACTERS) {
        if (!warnings.length) warnings.push("Raw evidence discovery reached its bounded candidate budget; the archive may contain additional relevant sources. Search or read exact sources when completeness matters.");
        continue;
      }
      const text = this.decode(row);
      characters += text.length;
      candidates.push({ source: this.source(row), text, score: Math.max(0, -Number(row.rank)) + (request.threadId === row.thread_id ? 0.1 : 0) });
    }
    return { candidates, watermark: this.watermark(), warnings };
  }

  correct(request: FabricCorrectionRequest): FabricSource {
    this.ready();
    const row = this.row(request.projectId, request.id);
    const original = this.source(row);
    const retained = redactMemoryText(string(request.text, "correction", MAX_SOURCE_CHARACTERS));
    const reason = optional(request.reason, "correction reason", 2_048);
    const safeReason = redactMemoryMetadata(reason, 2_048);
    const title = redactMemoryMetadata(original.title, 1_024) || "Corrected memory";
    const metadataFiltered = safeReason !== reason || title !== original.title;
    const omissions = [...retained.omissions];
    if (metadataFiltered) omissions.push("Correction metadata was bounded or filtered for recognizable credentials before retention.");
    const result = this.ingest([{
      key: original.key, projectId: original.projectId, threadId: original.threadId,
      kind: "correction", title, text: retained.text, observedAt: new Date().toISOString(),
      sourceRef: `User correction of ${original.id}${safeReason ? `: ${safeReason}` : ""}`,
      coverage: { status: omissions.length ? "bounded" : "complete", omissions,
        retainedCharacters: retained.text.length, originalCharacters: retained.originalCharacters,
        ...(retained.redacted || metadataFiltered ? { redacted: true } : {}),
      },
    }], true)[0];
    if (!result) throw new Error("This memory was forgotten and cannot be corrected.");
    return result;
  }

  retire(request: { projectId: string; key: string; notesOnly?: boolean }): void {
    this.transaction(() => {
      const projectId = id(request.projectId, "project");
      const key = string(request.key, "source key", 1_024);
      if (request.notesOnly !== undefined && typeof request.notesOnly !== "boolean")
        throw new Error("Invalid memory retirement scope.");
      const noteFilter = request.notesOnly ? " AND kind='note'" : "";
      const active = this.db.prepare(`SELECT id FROM fabric_sources WHERE project_id=? AND origin_key=? AND status='active'${noteFilter}`)
        .all(projectId, key) as Row[];
      if (!active.length) return;
      this.db.prepare(`UPDATE fabric_sources SET status='superseded' WHERE project_id=? AND origin_key=? AND status='active'${noteFilter}`)
        .run(projectId, key);
      this.invalidate(active.map((row) => String(row.id)));
      this.changed();
    });
  }

  forget(request: FabricForgetRequest): FabricForgetResult {
    const result = this.transaction(() => {
      const row = this.row(request.projectId, request.id);
      const rows = this.db.prepare("SELECT id FROM fabric_sources WHERE project_id=? AND origin_key=?")
        .all(row.project_id as string, row.origin_key as string) as Row[];
      const packetIds = new Set<string>();
      for (const source of rows) {
        for (const packet of this.db.prepare("SELECT packet_id FROM fabric_packet_sources WHERE source_id=?").all(source.id as string) as Row[])
          packetIds.add(String(packet.packet_id));
      }
      for (const packetId of packetIds) this.db.prepare("DELETE FROM fabric_packets WHERE id=?").run(packetId);
      for (const source of rows) this.db.prepare("DELETE FROM fabric_fts WHERE source_id=?").run(source.id as string);
      this.db.prepare("DELETE FROM fabric_sources WHERE project_id=? AND origin_key=?").run(row.project_id as string, row.origin_key as string);
      this.db.prepare("INSERT OR REPLACE INTO fabric_tombstones(origin_hash,deleted_at) VALUES (?,?)")
        .run(tombstoneKey(String(row.project_id), String(row.origin_key)), new Date().toISOString());
      this.changed();
      return { forgottenSources: rows.length, invalidatedPackets: packetIds.size,
        warning: "Removed this origin and its revisions, search entries and dependent memory packets from Nova Memory Fabric. Previously exported files, original conversations, provider requests and external backups are not recalled. A tombstone prevents automatic reimport of this origin." };
    });
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return result;
  }

  stats(projectId: string): FabricStats {
    this.ready();
    const project = id(projectId, "project");
    const row = this.db.prepare(`SELECT count(*) AS sources,
      sum(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
      sum(CASE WHEN status='superseded' THEN 1 ELSE 0 END) AS superseded,
      sum(characters) AS characters, sum(compressed_bytes) AS bytes FROM fabric_sources WHERE project_id=?`).get(project) as Row;
    return { sources: Number(row.sources), activeSources: Number(row.active ?? 0), supersededSources: Number(row.superseded ?? 0),
      sourceCharacters: Number(row.characters ?? 0), compressedBytes: Number(row.bytes ?? 0),
      packets: Number((this.db.prepare("SELECT count(*) AS count FROM fabric_packets WHERE project_id=?").get(project) as Row).count), watermark: this.watermark() };
  }

  recordPacket(receipt: FabricPacketReceipt): void {
    this.transaction(() => {
      const projectId = id(receipt.projectId, "project");
      const runId = id(receipt.runId, "run");
      const packet = receipt.packet;
      if (!packet || packet.projectId !== projectId || !Array.isArray(packet.items) || packet.items.length > 64 ||
          packet.characters !== packet.content.length || packet.sha256 !== digest(packet.content))
        throw new Error("Invalid memory packet receipt.");
      id(packet.id, "packet");
      if (Buffer.byteLength(JSON.stringify(receipt)) > 512 * 1024) throw new Error("Memory packet receipt exceeds its budget.");
      for (const item of packet.items) {
        const row = this.row(projectId, item.sourceId);
        if (row.sha256 !== item.sha256 || row.status !== item.status)
          throw new Error("Memory evidence changed after preparation. Refresh context before launching.");
      }
      const prior = this.db.prepare("SELECT receipt FROM fabric_packets WHERE id=?").get(packet.id) as Row | undefined;
      if (prior) {
        if (prior.receipt !== JSON.stringify(receipt)) throw new Error("Memory packet IDs are immutable.");
        return;
      }
      this.db.prepare("INSERT INTO fabric_packets(id,project_id,run_id,created_at,receipt) VALUES (?,?,?,?,?)")
        .run(packet.id, projectId, runId, timestamp(packet.createdAt), JSON.stringify(receipt));
      for (const sourceId of new Set(packet.items.map((item) => item.sourceId)))
        this.db.prepare("INSERT INTO fabric_packet_sources(packet_id,source_id) VALUES (?,?)").run(packet.id, sourceId);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
    finally { this.db.close(); }
  }
}
