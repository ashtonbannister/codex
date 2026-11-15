import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { crc32 } from "node:zlib";
import { fromBufferPromise } from "yauzl";
import { removeOwnedTree } from "./owned-tree";

const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_EXPANDED = 64 * 1024 * 1024;
const MAX_FILES = 2000;
const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const validComponent = (part: string) => part.length > 0 && part.length <= 255 && part !== "." && part !== ".." && !/[<>:"\\|?*\x00-\x1f\x7f]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part);

/** Extract a reviewed local bundle into a fresh private staging directory without executing it. */
export async function withBundleArchive<T>(selected: string, dataDir: string, use: (folder: string) => Promise<T>): Promise<T> {
  if (!path.isAbsolute(selected) || !/\.(?:mcpb|dxt|zip)$/i.test(selected)) throw new Error("Choose a local MCP bundle archive.");
  const before = await lstat(selected);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > MAX_ARCHIVE) throw new Error("The selected archive is linked, unavailable or too large.");
  const handle = await open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw new Error("The selected archive changed while reading.");
    bytes = await handle.readFile(); const after = await handle.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("The selected archive changed while reading.");
  } finally { await handle.close(); }
  const staging = path.join(dataDir, "bundle-staging"); await mkdir(staging, { recursive: true, mode: 0o700 });
  const info = await lstat(staging);
  if (!info.isDirectory() || info.isSymbolicLink() || key(await realpath(staging)) !== key(staging)) throw new Error("Bundle staging is unavailable or redirected.");
  const folder = path.join(staging, randomUUID()); await mkdir(folder, { mode: 0o700 });
  try {
    const zip = await fromBufferPromise(bytes, { strictFileNames: true, validateEntrySizes: true });
    try {
      const files = new Set<string>(), explicit = new Set<string>(); let total = 0, count = 0;
      for await (const entry of zip.eachEntry()) {
        if (++count > MAX_FILES || entry.generalPurposeBitFlag & 1) throw new Error("The archive has too many entries or contains encrypted files.");
        const name = entry.fileName; const directory = name.endsWith("/"); const components = (directory ? name.slice(0, -1) : name).split("/");
        if (components.length > 16 || components.some((part) => !validComponent(part))) throw new Error("The archive contains an unsafe path.");
        const relative = components.join("/"); const canonical = relative.toLowerCase();
        if (explicit.has(canonical)) throw new Error("The archive contains duplicate or case-colliding paths.");
        explicit.add(canonical);
        for (let i = 1; i < components.length; i++) if (files.has(components.slice(0, i).join("/").toLowerCase())) throw new Error("An archive file conflicts with a folder.");
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if ((unixMode && unixMode !== 0x8000 && unixMode !== 0x4000) || (entry.externalFileAttributes & 0x400) || (directory && unixMode === 0x8000) || (!directory && unixMode === 0x4000)) throw new Error("The archive contains a link or special file.");
        const target = path.join(folder, ...components);
        if (directory) { await mkdir(target, { recursive: true, mode: 0o700 }); continue; }
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > MAX_EXPANDED - total) throw new Error("The archive expands beyond the size limit.");
        total += entry.uncompressedSize; files.add(canonical);
        const stream = await zip.openReadStreamPromise(entry); const chunks: Buffer[] = []; let read = 0, checksum = 0;
        for await (const chunk of stream) { const buffer = Buffer.from(chunk); read += buffer.length; if (read > entry.uncompressedSize) throw new Error("The archive entry exceeds its declared size."); checksum = crc32(buffer, checksum); chunks.push(buffer); }
        if (read !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error("The archive entry failed its integrity check.");
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, Buffer.concat(chunks), { flag: "wx", mode: 0o600 });
      }
      if (!files.size) throw new Error("The archive is empty.");
    } finally { zip.close(); }
    return await use(folder);
  } finally { await removeOwnedTree(staging, folder); }
}
