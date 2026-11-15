import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateLocalConnection } from "./local-models";

type Connection = ReturnType<typeof validateLocalConnection>;
const connectionId = (connection: Connection) => JSON.stringify(connection);

/** Keys stay outside workspace JSON and are bound to a validated local connection. */
export class LocalKeyStore {
  private readonly keys = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(dataDir: string, private readonly encryption: {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
  }) {
    this.file = path.join(dataDir, "local-server-keys.bin");
  }

  private async checkFile(): Promise<boolean> {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 1024 * 1024)
        throw new Error("Invalid key store.");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error("Nova's local server key store is unavailable or redirected.");
    }
  }

  async load(): Promise<void> {
    if (!await this.checkFile()) return;
    if (!this.encryption.isEncryptionAvailable()) throw new Error("OS encryption is unavailable; Nova cannot read the local server key store.");
    try {
      const decoded: unknown = JSON.parse(this.encryption.decryptString(await readFile(this.file)));
      if (!Array.isArray(decoded) || decoded.length > 100) throw new Error("Invalid key store.");
      for (const entry of decoded) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string" ||
          !entry[1] || entry[1].length > 4096 || /[\x00-\x1f\x7f]/.test(entry[1])) throw new Error("Invalid key store.");
        const connection = validateLocalConnection(JSON.parse(entry[0]));
        if (connectionId(connection) !== entry[0]) throw new Error("Invalid key store.");
        this.keys.set(entry[0], entry[1]);
      }
    } catch {
      this.keys.clear();
      throw new Error("Nova could not decrypt or validate its local server key store.");
    }
  }

  get(connection: Connection): string | undefined {
    return this.keys.get(connectionId(connection));
  }

  set(connection: Connection, key: string): Promise<void> {
    const operation = this.queue.then(async () => {
      if (!this.encryption.isEncryptionAvailable()) throw new Error("OS encryption is unavailable; Nova did not save the key.");
      await this.checkFile();
      const next = new Map(this.keys);
      if (key) next.set(connectionId(connection), key);
      else next.delete(connectionId(connection));
      const encrypted = this.encryption.encryptString(JSON.stringify([...next]));
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
        await this.checkFile();
        await rename(temporary, this.file);
      } finally { await unlink(temporary).catch(() => undefined); }
      this.keys.clear();
      for (const [id, value] of next) this.keys.set(id, value);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
