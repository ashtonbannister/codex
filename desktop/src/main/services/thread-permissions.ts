import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PermissionContext { threadId: string; provider: string; model: string; mode: "plan" | "build"; worker: string; endpoint?: string }
type Encryption = { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string };
/** Encode disposable copy paths without conflating them with literal text. */
export function stablePermissionText(value: string, roots: Record<string, string | undefined>): Array<[string, string]> {
  const result: Array<[string, string]> = []; let offset = 0;
  while (offset < value.length) {
    const matches = Object.entries(roots).flatMap(([label, root]) => root ? [{ label, root, index: value.indexOf(root, offset) }] : []).filter((item) => item.index >= 0).sort((a, b) => a.index - b.index || b.root.length - a.root.length);
    const next = matches[0]; if (!next) { result.push(["text", value.slice(offset)]); break; }
    if (next.index > offset) result.push(["text", value.slice(offset, next.index)]); result.push(["root", next.label]); offset = next.index + next.root.length;
  }
  return result;
}
/** Persist only keyed hashes; request contents and credentials are never stored in the grant file. */
export class ThreadPermissionStore {
  private readonly file: string; private key = randomBytes(32); private entries = new Map<string, Set<string>>(); private queue: Promise<void> = Promise.resolve(); private revisions = new Map<string, number>(); private clearing = new Map<string, number>();
  constructor(dataDir: string, private readonly encryption: Encryption) { this.file = path.join(dataDir, "thread-permissions.bin"); }
  available(): boolean { return this.encryption.isEncryptionAvailable(); }
  private async exists(): Promise<boolean> {
    try { const info = await lstat(this.file); if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 4 * 1024 * 1024) throw new Error("Invalid store."); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new Error("Chat permissions are unavailable or redirected."); }
  }
  async load(): Promise<void> {
    if (!await this.exists()) return;
    if (!this.available()) throw new Error("OS encryption is unavailable; saved chat permissions cannot be read.");
    try {
      const data: unknown = JSON.parse(this.encryption.decryptString(await readFile(this.file)));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid store.");
      const value = data as { key?: unknown; entries?: unknown }; if (typeof value.key !== "string" || !/^[a-f0-9]{64}$/.test(value.key) || !Array.isArray(value.entries) || value.entries.length > 20000) throw new Error("Invalid store.");
      const entries = new Map<string, Set<string>>(); let total = 0;
      for (const item of value.entries) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(item[0]) || !Array.isArray(item[1]) || item[1].length > 200 || item[1].some((hash: unknown) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) || entries.has(item[0])) throw new Error("Invalid store.");
        total += item[1].length; if (total > 5000) throw new Error("Invalid store."); entries.set(item[0], new Set(item[1]));
      }
      this.key = Buffer.from(value.key, "hex"); this.entries = entries;
    } catch { throw new Error("Nova could not read saved chat permissions."); }
  }
  revision(threadId: string): number { return this.revisions.get(threadId) ?? 0; }
  private digest(context: PermissionContext, scope: unknown): string {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(context.threadId) || !["codex", "claude", "ollama"].includes(context.provider) || typeof context.model !== "string" || context.model.length > 256 || !["plan", "build"].includes(context.mode) || typeof context.worker !== "string" || !context.worker || context.worker.length > 300 || (context.endpoint !== undefined && (typeof context.endpoint !== "string" || context.endpoint.length > 2048))) throw new Error("Invalid chat permission context.");
    const serialized = JSON.stringify([context, scope]); if (!serialized || Buffer.byteLength(serialized) > 256 * 1024) throw new Error("This request is too large to remember safely.");
    return createHmac("sha256", this.key).update(serialized).digest("hex");
  }
  has(context: PermissionContext, scope: unknown): boolean { const hash = this.digest(context, scope); return !this.clearing.has(context.threadId) && (this.entries.get(context.threadId)?.has(hash) ?? false); }
  async grant(context: PermissionContext, scope: unknown, expectedRevision: number): Promise<void> {
    const hash = this.digest(context, scope);
    return this.mutate((entries) => { if (this.revision(context.threadId) !== expectedRevision) throw new Error("Chat permissions changed while approval was pending. Review the request again."); const values = new Set(entries.get(context.threadId) ?? []); values.add(hash); if (values.size > 200) throw new Error("Too many saved permissions for this chat."); entries.set(context.threadId, values); });
  }
  async clear(threadId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(threadId)) throw new Error("Invalid chat ID.");
    this.revisions.set(threadId, this.revision(threadId) + 1); this.clearing.set(threadId, (this.clearing.get(threadId) ?? 0) + 1);
    try { await this.mutate((entries) => { entries.delete(threadId); }); }
    finally { const remaining = (this.clearing.get(threadId) ?? 1) - 1; if (remaining) this.clearing.set(threadId, remaining); else this.clearing.delete(threadId); }
  }
  private mutate(change: (entries: Map<string, Set<string>>) => void): Promise<void> {
    const task = this.queue.then(async () => {
      if (!this.available()) throw new Error("OS encryption is unavailable; chat permissions cannot be saved.");
      await this.exists(); const next = new Map(this.entries); change(next);
      const values = [...next].map(([id, hashes]) => [id, [...hashes]]); if (values.reduce((sum, item) => sum + (item[1] as string[]).length, 0) > 5000) throw new Error("Too many saved chat permissions.");
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await writeFile(temp, this.encryption.encryptString(JSON.stringify({ key: this.key.toString("hex"), entries: values })), { mode: 0o600, flag: "wx" }); await this.exists(); await rename(temp, this.file); }
      finally { await unlink(temp).catch(() => undefined); }
      this.entries = next;
    }); this.queue = task.catch(() => undefined); return task;
  }
}

/** Remember only requests with an explicit, complete scope; all other approvals stay one-time. */
export async function authorizeThreadPermission(store: ThreadPermissionStore | undefined, context: PermissionContext | undefined, scope: unknown | undefined, show: (remember: boolean) => Promise<number>): Promise<boolean> {
  let remember = !!context && scope !== undefined && !!store?.available();
  if (remember) { try { if (store!.has(context!, scope)) return true; } catch { remember = false; } }
  const revision = remember ? store!.revision(context!.threadId) : 0;
  const choice = await show(remember);
  if (choice === 1) return true;
  if (choice === 2 && remember) { await store!.grant(context!, scope, revision); return true; }
  return false;
}
