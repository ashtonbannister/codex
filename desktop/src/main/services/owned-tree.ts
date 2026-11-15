import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (root: string, value: string) => {
  const relative = path.relative(key(root), key(value));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Remove a direct owned child only after rejecting links and redirected descendants. */
export async function removeOwnedTree(parent: string, directory: string): Promise<void> {
  if (!path.isAbsolute(parent) || !path.isAbsolute(directory) || key(path.dirname(directory)) !== key(parent)) throw new Error("Owned cleanup target is invalid; it was preserved.");
  const parentInfo = await lstat(parent);
  const rootInfo = await lstat(directory);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
      key(await realpath(parent)) !== key(parent) || key(await realpath(directory)) !== key(directory)) throw new Error("Owned cleanup target was redirected; it was preserved.");
  const pending = [directory];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (++visited > 20_000) throw new Error("Owned cleanup contains too many files; it was preserved.");
      const child = path.join(current, entry.name);
      const info = await lstat(child);
      if (info.isSymbolicLink() || !within(directory, await realpath(child)) || (!info.isDirectory() && (!info.isFile() || info.nlink > 1)))
        throw new Error("Owned cleanup contains a link or unsafe file; it was preserved.");
      if (info.isDirectory()) pending.push(child);
    }
  }
  await rm(directory, { recursive: true, force: false });
}
