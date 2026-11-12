import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

const EXPORT_LIMIT = 8 * 1024 * 1024;

async function identity(file: string): Promise<string | undefined> {
  try {
    const value = await lstat(file, { bigint: true });
    if (!value.isFile() || value.isSymbolicLink())
      throw new Error("Choose a regular Markdown file, not a link or directory.");
    return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Only call with a destination returned by the native Save dialog. */
export async function saveMarkdownExport(destination: string, content: string): Promise<string> {
  if (
    !path.isAbsolute(destination) ||
    /[\u0000-\u001f\u007f]/.test(destination) ||
    path.extname(destination).toLowerCase() !== ".md"
  ) throw new Error("Choose a Markdown export filename ending in .md.");
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > EXPORT_LIMIT)
    throw new Error("This export exceeds the 8 MiB file limit.");
  const parent = await realpath(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  const previous = await identity(target);
  const temporary = path.join(parent, `.nova-export-${randomUUID()}.tmp`);
  let ownsTemporary = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    ownsTemporary = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await identity(target)) !== previous)
      throw new Error("The destination changed while exporting. Choose a new filename and try again.");
    await rename(temporary, target);
    ownsTemporary = false;
    return target;
  } finally {
    if (ownsTemporary) await unlink(temporary).catch(() => undefined);
  }
}
