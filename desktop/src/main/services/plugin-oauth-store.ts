import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";

export interface OAuthIdentity { id: string; fingerprint: string; server: string }
export interface OAuthRecord { tokens: StoredOAuthTokens; client?: StoredOAuthClientInformation; discovery?: OAuthDiscoveryState; expiresAt?: number }
const keyOf = (identity: OAuthIdentity) => {
  if (!/^[a-f0-9-]{36}$/i.test(identity.id) || !/^[a-f0-9]{64}$/.test(identity.fingerprint) || !/^[A-Za-z0-9_-]{1,80}$/.test(identity.server)) throw new Error("Invalid plugin authorization identity.");
  return createHash("sha256").update(JSON.stringify([identity.id, identity.fingerprint, identity.server])).digest("hex");
};
function validate(record: OAuthRecord): OAuthRecord {
  if (!record || typeof record !== "object" || !record.tokens || typeof record.tokens.access_token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(record.tokens.access_token) || typeof record.tokens.token_type !== "string" || record.tokens.token_type.toLowerCase() !== "bearer" || typeof record.tokens.issuer !== "string" || !URL.canParse(record.tokens.issuer) || (record.expiresAt !== undefined && (!Number.isFinite(record.expiresAt) || record.expiresAt < 0)) || Buffer.byteLength(JSON.stringify(record)) > 65536) throw new Error("Invalid OAuth credentials.");
  return structuredClone(record);
}
/** OAuth grants and client registrations are encrypted and bound to one immutable imported server. */
export class PluginOAuthStore {
  private readonly file: string;
  private readonly entries = new Map<string, OAuthRecord>();
  private queue: Promise<void> = Promise.resolve();
  constructor(dataDir: string, private readonly encryption: { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }) { this.file = path.join(dataDir, "plugin-oauth.bin"); }
  private async exists(): Promise<boolean> {
    try { const info = await lstat(this.file); if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 4 * 1024 * 1024) throw new Error("Invalid store."); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new Error("Nova's plugin sign-in store is unavailable or redirected."); }
  }
  async load(): Promise<void> {
    if (!await this.exists()) return;
    if (!this.encryption.isEncryptionAvailable()) throw new Error("OS encryption is unavailable; Nova cannot read plugin sign-ins.");
    try {
      const parsed: unknown = JSON.parse(this.encryption.decryptString(await readFile(this.file)));
      if (!Array.isArray(parsed) || parsed.length > 100) throw new Error("Invalid store.");
      for (const item of parsed) { if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !/^[a-f0-9]{64}$/.test(item[0])) throw new Error("Invalid store."); this.entries.set(item[0], validate(item[1] as OAuthRecord)); }
    } catch { this.entries.clear(); throw new Error("Nova could not decrypt or validate plugin sign-ins."); }
  }
  get(identity: OAuthIdentity): OAuthRecord | undefined { const value = this.entries.get(keyOf(identity)); return value && structuredClone(value); }
  has(identity: OAuthIdentity): boolean { return this.entries.has(keyOf(identity)); }
  set(identity: OAuthIdentity, value?: OAuthRecord): Promise<void> {
    const key = keyOf(identity), checked = value && validate(value);
    const task = this.queue.then(async () => {
      if (!this.encryption.isEncryptionAvailable()) throw new Error("OS encryption is unavailable; Nova did not save the sign-in.");
      await this.exists(); const next = new Map(this.entries); if (checked) next.set(key, checked); else next.delete(key);
      if (next.size > 100) throw new Error("Too many plugin sign-ins are stored.");
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, this.encryption.encryptString(JSON.stringify([...next])), { mode: 0o600, flag: "wx" }); await this.exists(); await rename(temporary, this.file); }
      finally { await unlink(temporary).catch(() => undefined); }
      this.entries.clear(); for (const [entry, data] of next) this.entries.set(entry, data);
    });
    this.queue = task.catch(() => undefined); return task;
  }
}
