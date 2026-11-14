import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  CodexHistoryPage, CodexHistoryQuery, CodexThreadPage, CodexThreadQuery,
  CodexThreadSummary, ImportedMessage,
} from "../../shared/compatibility";
import { resolveCodexHome } from "./codex-installation";

// This module never starts Codex, opens a database, creates locks, or writes to
// the source. Call it only for an explicit import-library action.
const MAX_FILES = 5_000;
const MAX_ENTRIES = 15_000;
const HEADER_BYTES = 256 * 1024;
const HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_VISIBLE_BYTES = 2 * 1024 * 1024;
const PAGE_BYTES = 256 * 1024;
const CACHE_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Json = Record<string, unknown>;
type File = { file: string; root: string; id: string; size: number; modified: number; stamp: string };
type Catalog = {
  home: string; archived: boolean; files: File[]; names: Map<string, string>;
  summaries: Map<string, CodexThreadSummary | null>; digest: string; at: number; warnings: string[];
};
type Transcript = { messages: ImportedMessage[]; truncated: boolean; warnings: string[]; at: number };
const catalogs = new Map<string, Promise<Catalog>>();
const transcripts = new Map<string, Transcript>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const clean = (value: unknown, limit: number) =>
  typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, limit) : "";
const stamp = (info: Awaited<ReturnType<typeof stat>>) =>
  [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return !!rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const date = (value: unknown, fallback: number) => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return new Date(Number.isFinite(parsed) ? parsed : fallback).toISOString();
};

async function safeFile(root: string, file: string) {
  if (!inside(root, file)) throw new Error("Conversation source must remain inside the selected import folder.");
  let part = root;
  for (const component of path.relative(root, file).split(path.sep)) {
    part = path.join(part, component);
    if ((await lstat(part)).isSymbolicLink()) throw new Error("Linked conversation sources are not followed.");
  }
  const canonical = await realpath(file);
  if (!inside(root, canonical)) throw new Error("Conversation source resolves outside the selected import folder.");
  const before = await stat(canonical);
  if (!before.isFile()) throw new Error("Conversation source is not a regular file.");
  return { canonical, before };
}

/** Read a bounded stable slice. O_RDONLY is the only open mode in this module. */
async function readSlice(root: string, file: string, from: number, maximum: number, expected?: string) {
  const { canonical, before } = await safeFile(root, file);
  if (expected && stamp(before) !== expected) throw new Error("The source conversation changed. Refresh the import library.");
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (stamp(await handle.stat()) !== stamp(before)) throw new Error("The source changed while opening it. Retry the import.");
    const start = Math.max(0, Math.min(from, before.size));
    const bytes = Buffer.alloc(Math.min(maximum, before.size - start));
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, start + count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (stamp(await handle.stat()) !== stamp(before) || (await realpath(file)) !== canonical)
      throw new Error("The source changed during the read. Nothing was written; retry when its work is idle.");
    return { bytes: bytes.subarray(0, count), start, size: before.size, stamp: stamp(before) };
  } finally { await handle.close(); }
}

function lines(bytes: Buffer, start: number, endIsEof: boolean, visit: (item: Json, offset: number) => void): boolean {
  let offset = start > 0 ? bytes.indexOf(10) + 1 : 0;
  if (start > 0 && !offset) return true;
  let skipped = false;
  while (offset < bytes.length) {
    let end = bytes.indexOf(10, offset);
    if (end < 0) {
      if (!endIsEof) break;
      end = bytes.length;
    }
    if (end - offset > MAX_LINE_BYTES) skipped = true;
    else if (end > offset) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end));
        const item = object(JSON.parse(text));
        if (item) visit(item, start + offset);
      } catch { skipped = true; }
    }
    offset = end + 1;
  }
  return skipped;
}

async function titles(home: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const file = path.join(home, "session_index.jsonl");
    const { before } = await safeFile(home, file);
    const part = await readSlice(home, file, Math.max(0, before.size - 2 * 1024 * 1024), 2 * 1024 * 1024);
    lines(part.bytes, part.start, true, (item) => {
      if (typeof item.id === "string" && UUID.test(item.id) && typeof item.thread_name === "string") {
        const title = clean(item.thread_name, 160).replace(/\s+/g, " ").trim();
        if (title) result.set(item.id.toLowerCase(), title);
      }
    });
  } catch { /* Optional, read-only display names; never fall back to SQLite. */ }
  return result;
}

async function scan(home: string, archived: boolean): Promise<Catalog> {
  const root = path.join(home, archived ? "archived_sessions" : "sessions");
  const warnings: string[] = [];
  const files: File[] = [];
  let skipped = false, compressed = false, visited = 0;
  try {
    if ((await lstat(root)).isSymbolicLink() || path.relative(root, await realpath(root)) !== "")
      throw new Error("The session directory is linked. Select an unlinked copy for import.");
    const pending = [{ directory: root, depth: 0 }];
    while (pending.length && visited < MAX_ENTRIES && files.length < MAX_FILES) {
      const current = pending.shift()!;
      if ((await lstat(current.directory)).isSymbolicLink() ||
        (current.directory !== root && !inside(root, await realpath(current.directory)))) {
        skipped = true; continue;
      }
      const directory = await opendir(current.directory);
      for await (const entry of directory) {
        if (++visited > MAX_ENTRIES || files.length >= MAX_FILES) break;
        if (entry.isSymbolicLink()) { skipped = true; continue; }
        if (entry.name.startsWith(".")) continue;
        const file = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < 6) pending.push({ directory: file, depth: current.depth + 1 });
          else skipped = true;
        } else if (entry.isFile()) {
          if (/\.jsonl\.(?:zst|gz|br)$/i.test(entry.name)) { compressed = true; continue; }
          const match = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name);
          if (!match) { if (/\.jsonl$/i.test(entry.name)) skipped = true; continue; }
          try {
            const { before } = await safeFile(root, file);
            files.push({ file, root, id: match[1]!.toLowerCase(), size: before.size, modified: before.mtimeMs, stamp: stamp(before) });
          } catch { skipped = true; }
        }
      }
    }
    if (pending.length || visited >= MAX_ENTRIES || files.length >= MAX_FILES)
      warnings.push("The bounded source listing is incomplete: at most 5000 rollout files and 15000 directory entries are inspected.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  files.sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file));
  if (skipped) warnings.push("Linked, unavailable, deeply nested, or unsupported source paths were skipped.");
  if (compressed) warnings.push("Compressed rollouts are not imported by this read-only browser. Export or provide an uncompressed JSONL copy; Nova will not ask Codex to decompress or migrate it.");
  warnings.push("Read-only import source. No Codex worker, database, configuration, credential, or source lock is opened. Only visible text recorded in supported JSONL rollouts is copied; engine-only history may be absent.");
  return { home, archived, files, names: await titles(home), summaries: new Map(), digest: digest(JSON.stringify(files)), at: Date.now(), warnings };
}

async function catalog(input: string, archived: boolean): Promise<Catalog> {
  const home = await resolveCodexHome(input);
  const key = `${home}\0${archived}`;
  const cached = catalogs.get(key);
  if (cached) {
    const result = await cached;
    if (Date.now() - result.at < CACHE_MS) return result;
    catalogs.delete(key);
  }
  const pending = scan(home, archived);
  catalogs.set(key, pending);
  while (catalogs.size > 4) catalogs.delete(catalogs.keys().next().value!);
  try { return await pending; }
  catch (error) { catalogs.delete(key); throw error; }
}

async function summary(source: Catalog, file: File): Promise<CodexThreadSummary | null> {
  if (source.summaries.has(file.file)) return source.summaries.get(file.file)!;
  const part = await readSlice(file.root, file.file, 0, HEADER_BYTES, file.stamp);
  let meta: Json | undefined;
  lines(part.bytes, 0, part.bytes.length === part.size, (line) => {
    if (!meta && line.type === "session_meta") meta = object(line.payload);
  });
  const id = meta && (typeof meta.id === "string" ? meta.id : meta.session_id);
  if (!meta || typeof id !== "string" || id.toLowerCase() !== file.id) {
    source.summaries.set(file.file, null);
    return null;
  }
  const value: CodexThreadSummary = {
    id: file.id, title: source.names.get(file.id) || clean(meta.title, 160) || `Codex ${file.id.slice(0, 8)}`,
    cwd: clean(meta.cwd, 4096), modelProvider: clean(meta.model_provider, 160) || "unknown",
    createdAt: date(meta.timestamp, file.modified), updatedAt: date(undefined, file.modified),
    source: "Read-only JSONL copy", status: "snapshot", archived: source.archived,
  };
  source.summaries.set(file.file, value);
  return value;
}

function cursor(value: string | undefined, fingerprint: string, maximum: number, initial: number): number {
  if (!value) return initial;
  try {
    if (value.length > 1024) throw new Error();
    const item = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (item.fingerprint !== fingerprint || !Number.isInteger(item.offset) || item.offset < 0 || item.offset > maximum) throw new Error();
    return item.offset;
  } catch { throw new Error("This import cursor is stale or belongs to another source. Refresh the import library."); }
}
const nextCursor = (fingerprint: string, offset: number) =>
  Buffer.from(JSON.stringify({ fingerprint, offset })).toString("base64url");

export async function listCodexThreads(home: string, query: CodexThreadQuery): Promise<CodexThreadPage> {
  const source = await catalog(home, !!query.archived);
  const search = clean(query.search, 256).toLowerCase().trim();
  const fingerprint = digest(`${source.home}\0${source.archived}\0${source.digest}\0${search}`);
  let offset = cursor(query.cursor, fingerprint, source.files.length, 0), examined = 0;
  const threads: CodexThreadSummary[] = [], warnings = [...source.warnings];
  while (offset < source.files.length && threads.length < 50 && examined++ < 128) {
    const file = source.files[offset++]!;
    if (search && source.names.has(file.id) && !source.names.get(file.id)!.toLowerCase().includes(search) && !file.id.includes(search)) continue;
    try {
      const item = await summary(source, file);
      if (item && (!search || `${item.title} ${item.id}`.toLowerCase().includes(search))) threads.push(item);
      if (!item) warnings.push("Some rollout headers are not supported or exceeded the bounded metadata read.");
    } catch {
      catalogs.delete(`${source.home}\0${source.archived}`);
      warnings.push("Some source files changed or could not be read. Refresh to retry.");
    }
  }
  return { threads, nextCursor: offset < source.files.length ? nextCursor(fingerprint, offset) : undefined, warnings: [...new Set(warnings)] };
}

function visibleText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    const item = object(part);
    return item && ["text", "Text", "input_text", "output_text"].includes(String(item.type)) && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

async function transcript(file: File): Promise<Transcript> {
  const key = `${file.file}\0${file.stamp}`;
  const cached = transcripts.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    if (stamp((await safeFile(file.root, file.file)).before) !== file.stamp) throw new Error("The source changed. Refresh before copying.");
    return cached;
  }
  const part = await readSlice(file.root, file.file, Math.max(0, file.size - HISTORY_BYTES), HISTORY_BYTES, file.stamp);
  const events: ImportedMessage[] = [], responses: ImportedMessage[] = [];
  const totals = new Map<ImportedMessage[], number>();
  let truncated = part.start > 0;
  const add = (target: ImportedMessage[], role: ImportedMessage["role"], text: string, offset: number, turn?: unknown, id?: unknown) => {
    if (!text) return;
    if (text.length > 16_000) truncated = true;
    const value: ImportedMessage = { id: clean(id, 200) || `copy-${offset}`, turnId: clean(turn, 200) || `copy-turn-${offset}`, role, text: clean(text, 16_000) };
    target.push(value);
    let bytes = (totals.get(target) ?? 0) + Buffer.byteLength(JSON.stringify(value));
    while (target.length > 2_000 || bytes > MAX_VISIBLE_BYTES) {
      bytes -= Buffer.byteLength(JSON.stringify(target.shift()!)); truncated = true;
    }
    totals.set(target, bytes);
  };
  const skipped = lines(part.bytes, part.start, true, (line, offset) => {
    const payload = object(line.payload);
    if (!payload) return;
    if (line.type === "event_msg") {
      if (payload.type === "user_message" && typeof payload.message === "string")
        add(events, "user", payload.message, offset, payload.turn_id, payload.id);
      else if (payload.type === "agent_message" && typeof payload.message === "string")
        add(events, "assistant", payload.message, offset, payload.turn_id, payload.id);
      else if (payload.type === "item_completed") {
        const item = object(payload.item);
        if (item?.type === "UserMessage") add(events, "user", visibleText(item.content), offset, payload.turn_id, item.id);
        else if (item?.type === "AgentMessage" && item.phase !== "analysis" && item.phase !== "reasoning")
          add(events, "assistant", visibleText(item.content), offset, payload.turn_id, item.id);
      }
    } else if (line.type === "response_item" && payload.type === "message" &&
      ["user", "assistant"].includes(String(payload.role)) && !["analysis", "reasoning"].includes(String(payload.channel ?? payload.phase))) {
      add(responses, payload.role as ImportedMessage["role"], visibleText(payload.content), offset, payload.turn_id, payload.id);
    }
  });
  // UI events are authoritative when present; response items otherwise duplicate
  // them and can include extra model-facing context. Never copy both.
  const messages = events.length ? events : responses;
  const warnings: string[] = [];
  if (skipped) { truncated = true; warnings.push("Malformed, incomplete, or oversized JSONL records were skipped; only complete supported visible messages were copied."); }
  if (truncated) warnings.push("This snapshot is bounded to the latest 8 MiB of source JSONL and 2000 visible messages / 2 MiB. Older or oversized content was omitted.");
  if (!messages.length) warnings.push("No supported visible user/assistant messages were found. Database-only history, compressed content, and unsupported schemas are not imported.");
  const result = { messages, truncated, warnings, at: Date.now() };
  transcripts.set(key, result);
  while (transcripts.size > 4) transcripts.delete(transcripts.keys().next().value!);
  return result;
}

export async function readCodexHistory(home: string, query: CodexHistoryQuery): Promise<CodexHistoryPage> {
  if (!UUID.test(query.threadId)) throw new Error("Choose a conversation from the read-only import library.");
  const source = await catalog(home, !!query.archived);
  const matches = source.files.filter((item) => item.id === query.threadId.toLowerCase());
  if (matches.length !== 1) throw new Error(matches.length ? "This source has duplicate conversation IDs. Select a clean copy for import." : "This conversation is absent from the bounded source listing. Refresh the import library.");
  const file = matches[0]!;
  let thread: CodexThreadSummary | null;
  let result: Transcript;
  try { thread = await summary(source, file); result = await transcript(file); }
  catch (error) {
    // A source may be actively written by the official app. Fail this snapshot
    // without locking it, and let the next explicit refresh scan again.
    catalogs.delete(`${source.home}\0${source.archived}`);
    throw error;
  }
  if (!thread) throw new Error("This rollout metadata format is not supported by the read-only importer.");
  const fingerprint = digest(`${source.home}\0${source.archived}\0${file.file}\0${file.stamp}`);
  const end = cursor(query.cursor, fingerprint, result.messages.length, result.messages.length);
  let begin = end, bytes = 0;
  while (begin > 0 && end - begin < 400) {
    const size = Buffer.byteLength(JSON.stringify(result.messages[begin - 1]));
    if (bytes + size > PAGE_BYTES) break;
    bytes += size; begin--;
  }
  return { thread, messages: result.messages.slice(begin, end),
    nextCursor: begin > 0 ? nextCursor(fingerprint, begin) : undefined,
    truncated: result.truncated, warnings: [...source.warnings, ...result.warnings] };
}
