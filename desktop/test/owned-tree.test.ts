import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeOwnedTree } from "../src/main/services/owned-tree";

test("owned cleanup refuses junctions and preserves their targets", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-owned-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = path.join(root, "copies"), child = path.join(parent, "owned"), outside = path.join(root, "outside");
  await mkdir(child, { recursive: true }); await mkdir(outside);
  await writeFile(path.join(outside, "keep.txt"), "preserve");
  const link = path.join(child, "redirect");
  try { await symlink(outside, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Directory links unavailable"); return; } throw error; }
  await assert.rejects(removeOwnedTree(parent, child), /link|unsafe/);
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "preserve");
  await unlink(link);
  await removeOwnedTree(parent, child);
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "preserve");
});
