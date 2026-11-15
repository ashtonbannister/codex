import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillPackageStore } from "../src/main/services/skill-packages";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(path.join(source, "skills", "sample"), { recursive: true });
  await mkdir(path.join(source, "docs"), { recursive: true });
  await writeFile(path.join(source, "skills", "sample", "SKILL.md"), "---\nname: sample\ndescription: Test skill\n---\nRead ../../docs/guide.md\n");
  await writeFile(path.join(source, "docs", "guide.md"), "Original supporting guide\n");
  return { root, source, store: new SkillPackageStore(path.join(root, "data")) };
}

test("imports complete reviewed packages and exposes enabled skill paths to all providers", async (t) => {
  const f = await fixture(t);
  const preview = await f.store.preview(f.source);
  assert.equal(preview.files, 2);
  assert.equal(preview.skills[0]?.name, "sample");
  const pkg = await f.store.install(f.source, preview.fingerprint);
  assert.equal((await f.store.list())[0]?.enabled, true);
  const prompt = await f.store.prompt();
  assert.match(prompt, /Test skill/);
  assert.match(prompt, /SKILL\.md/);
  assert.equal(await readFile(path.join(f.root, "data", "skill-packages", pkg.id, "files", "docs", "guide.md"), "utf8"), "Original supporting guide\n");
  const run = await f.store.prepareRun();
  assert.ok(run.directory);
  assert.match(run.prompt, /SKILL\.md/);
  assert.equal(await readFile(path.join(run.directory!, pkg.id, "docs", "guide.md"), "utf8"), "Original supporting guide\n");
  await writeFile(path.join(run.directory!, pkg.id, "docs", "guide.md"), "Disposable edit\n");
  assert.match(await f.store.prompt(), /sample/);
  await run.dispose();
  await f.store.setEnabled(pkg.id, false);
  assert.equal(await f.store.prompt(), "");
  await f.store.setEnabled(pkg.id, true);
  assert.match(await f.store.prompt(), /sample/);
});

test("refuses changed source and changed imported content, while allowing disable", async (t) => {
  const f = await fixture(t);
  const preview = await f.store.preview(f.source);
  await writeFile(path.join(f.source, "docs", "guide.md"), "Changed\n");
  await assert.rejects(f.store.install(f.source, preview.fingerprint), /changed/);
  const next = await f.store.preview(f.source);
  const pkg = await f.store.install(f.source, next.fingerprint);
  await writeFile(path.join(f.root, "data", "skill-packages", pkg.id, "files", "docs", "guide.md"), "Changed again\n");
  await assert.rejects(f.store.prompt(), /changed/);
  await f.store.setEnabled(pkg.id, false);
  assert.equal(await f.store.prompt(), "");
  await assert.rejects(f.store.setEnabled(pkg.id, true), /changed/);
});

test("rejects links in imported packages", async (t) => {
  const f = await fixture(t);
  try { await symlink(path.join(f.source, "docs", "guide.md"), path.join(f.source, "link.md"), "file"); }
  catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Symlinks unavailable"); return; } throw error; }
  await assert.rejects(f.store.preview(f.source), /link/);
});
