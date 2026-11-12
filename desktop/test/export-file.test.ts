import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveMarkdownExport } from "../src/main/services/export-file";

test("Markdown export writes UTF-8 atomically and replaces an explicitly selected file", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "nova-export-test-"));
  try {
    const target = path.join(folder, "Conversation — 测试.md");
    assert.equal(await saveMarkdownExport(target, "# Visible history\n\nHello 🙂\n"), target);
    assert.equal(await readFile(target, "utf8"), "# Visible history\n\nHello 🙂\n");
    await saveMarkdownExport(target, "# Updated export\n");
    assert.equal(await readFile(target, "utf8"), "# Updated export\n");
    assert.deepEqual(await readdir(folder), [path.basename(target)]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("Markdown export rejects non-document destinations and bounded content before writing", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "nova-export-test-"));
  try {
    await assert.rejects(saveMarkdownExport("relative.md", "text"), /Markdown/);
    await assert.rejects(saveMarkdownExport(path.join(folder, "auth.json"), "text"), /Markdown/);
    await assert.rejects(saveMarkdownExport(path.join(folder, "large.md"), "x".repeat(8 * 1024 * 1024 + 1)), /8 MiB/);
    assert.deepEqual(await readdir(folder), []);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("Markdown export does not follow a destination symlink", { skip: process.platform === "win32" }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "nova-export-test-"));
  try {
    const source = path.join(folder, "source.md");
    const linked = path.join(folder, "linked.md");
    await writeFile(source, "Preserve me");
    await symlink(source, linked);
    await assert.rejects(saveMarkdownExport(linked, "replacement"), /regular Markdown/);
    assert.equal(await readFile(source, "utf8"), "Preserve me");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
