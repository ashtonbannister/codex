import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateBundleValue, type BundleDefinition, type BundleValue } from "./bundle-config";
export interface BundleIdentity { id: string; fingerprint: string; server?: string }
const keyOf = (value: BundleIdentity) => {
  if (!/^[a-f0-9-]{36}$/i.test(value.id) || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw new Error("Invalid bundle configuration identity.");
  if (value.server !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(value.server)) throw new Error("Invalid bundle server identity.");
  return createHash("sha256").update(JSON.stringify(value.server ? [value.id, value.fingerprint, value.server] : [value.id, value.fingerprint])).digest("hex");
};
export class BundleConfigStore {
  private readonly file: string; private readonly entries = new Map<string, Record<string, BundleValue>>(); private queue: Promise<void> = Promise.resolve();
  constructor(dataDir: string, private readonly encryption: { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }) { this.file = path.join(dataDir, "bundle-settings.bin"); }
  private async exists(): Promise<boolean> { try { const info = await lstat(this.file); if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 4 * 1024 * 1024) throw new Error("Invalid store."); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new Error("Nova's bundle settings are unavailable or redirected."); } }
  async load(): Promise<void> {
    if (!await this.exists()) return;
    if (!this.encryption.isEncryptionAvailable()) throw new Error("OS encryption is unavailable; bundle settings cannot be read.");
    try {
      const data: unknown = JSON.parse(this.encryption.decryptString(await readFile(this.file)));
      if (!Array.isArray(data) || data.length > 100) throw new Error("Invalid store.");
      for (const pair of data) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !/^[a-f0-9]{64}$/.test(pair[0]) || !pair[1] || typeof pair[1] !== "object" || Array.isArray(pair[1]) || Object.keys(pair[1]).length > 50 || Buffer.byteLength(JSON.stringify(pair[1])) > 131072) throw new Error("Invalid store.");
        this.entries.set(pair[0], pair[1] as Record<string, BundleValue>);
      }
    } catch { this.entries.clear(); throw new Error("Nova could not decrypt its bundle settings."); }
  }
  get(identity: BundleIdentity): Record<string, BundleValue> { return structuredClone(this.entries.get(keyOf(identity)) ?? {}); }
  set(identity: BundleIdentity, field: BundleDefinition, value: unknown): Promise<void> {
    const key = keyOf(identity), checked = value === null ? undefined : validateBundleValue(field, value);
    const task = this.queue.then(async () => {
      if (!this.encryption.isEncryptionAvailable()) throw new Error("OS encryption is unavailable; bundle settings were not saved.");
      await this.exists(); const next = new Map(this.entries); const values = { ...(next.get(key) ?? {}) };
      if (checked === undefined) delete values[field.key]; else values[field.key] = checked;
      if (Object.keys(values).length) next.set(key, values); else next.delete(key);
      if (next.size > 100 || Buffer.byteLength(JSON.stringify([...next])) > 3 * 1024 * 1024) throw new Error("Too many bundle settings are stored.");
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await writeFile(temp, this.encryption.encryptString(JSON.stringify([...next])), { mode: 0o600, flag: "wx" }); await this.exists(); await rename(temp, this.file); }
      finally { await unlink(temp).catch(() => undefined); }
      this.entries.clear(); for (const [entry, data] of next) this.entries.set(entry, data);
    }); this.queue = task.catch(() => undefined); return task;
  }
}
