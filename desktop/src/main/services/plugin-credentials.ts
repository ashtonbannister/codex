import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

interface Identity { id: string; fingerprint: string; server: string }
const identityKey = ({ id, fingerprint, server }: Identity): string => {
  if (!/^[a-f0-9-]{36}$/i.test(id) || !/^[a-f0-9]{64}$/.test(fingerprint) || !/^[A-Za-z0-9_-]{1,80}$/.test(server)) throw new Error("Invalid plugin credential identity.");
  return createHash("sha256").update(JSON.stringify([id, fingerprint, server])).digest("hex");
};

/** Tokens never leave the main process after being saved; the package fingerprint binds them to the exact server configuration. */
export class PluginCredentialStore {
  private readonly keys = new Map<string, string>();
  private readonly file: string;
  private queue: Promise<void> = Promise.resolve();
  constructor(dataDir: string, private readonly encryption: { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }) {
    this.file = path.join(dataDir, "plugin-credentials.bin");
  }
  private async exists(): Promise<boolean> {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 1024 * 1024) throw new Error("Invalid store.");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error("Nova's plugin credential store is unavailable or redirected.");
    }
  }
  async load(): Promise<void> {
    if (!await this.exists()) return;
    if (!this.encryption.isEncryptionAvailable()) throw new Error("OS encryption is unavailable; Nova cannot read plugin credentials.");
    try {
      const entries: unknown = JSON.parse(this.encryption.decryptString(await readFile(this.file)));
      if (!Array.isArray(entries) || entries.length > 1000) throw new Error("Invalid store.");
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !/^[a-f0-9]{64}$/.test(entry[0]) || typeof entry[1] !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(entry[1])) throw new Error("Invalid store.");
        this.keys.set(entry[0], entry[1]);
      }
    } catch { this.keys.clear(); throw new Error("Nova could not decrypt or validate its plugin credential store."); }
  }
  get(identity: Identity): string | undefined { return this.keys.get(identityKey(identity)); }
  has(identity: Identity): boolean { return this.keys.has(identityKey(identity)); }
  set(identity: Identity, token: string): Promise<void> {
    if (typeof token !== "string" || (token !== "" && !/^[\x21-\x7e]{1,4096}$/.test(token))) throw new Error("Enter a bearer token without spaces or control characters.");
    const key = identityKey(identity);
    const action = this.queue.then(async () => {
      if (!this.encryption.isEncryptionAvailable()) throw new Error("OS encryption is unavailable; Nova did not save the credential.");
      await this.exists();
      const next = new Map(this.keys);
      if (token) next.set(key, token); else next.delete(key);
      if (next.size > 1000) throw new Error("Too many plugin credentials are stored.");
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, this.encryption.encryptString(JSON.stringify([...next])), { mode: 0o600, flag: "wx" });
        await this.exists(); await rename(temporary, this.file);
      } finally { await unlink(temporary).catch(() => undefined); }
      this.keys.clear(); for (const [entry, value] of next) this.keys.set(entry, value);
    });
    this.queue = action.catch(() => undefined); return action;
  }
}
