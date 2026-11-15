import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
export interface PermissionFileIdentity { path: string; dev: number; ino: number; size: number; mtimeMs: number }
/** Hash a stable external executable or script before remembering permission for it. */
export async function verifiedPermissionFileDigest(file: PermissionFileIdentity): Promise<string> {
  if (file.size > 512 * 1024 * 1024) throw new Error("Executable is too large to remember safely.");
  const same = (item: { dev: number; ino: number; size: number; mtimeMs: number }) => file.dev === item.dev && file.ino === item.ino && file.size === item.size && file.mtimeMs === item.mtimeMs;
  const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat(); if (!before.isFile() || !same(before)) throw new Error("Executable changed.");
    const hash = createHash("sha256"); const stream = handle.createReadStream({ autoClose: false }); let size = 0;
    for await (const chunk of stream) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > file.size) throw new Error("Executable changed."); hash.update(bytes); }
    const after = await handle.stat(); if (size !== file.size || !same(after) || before.ctimeMs !== after.ctimeMs) throw new Error("Executable changed.");
    return hash.digest("hex");
  } finally { await handle.close(); }
}
