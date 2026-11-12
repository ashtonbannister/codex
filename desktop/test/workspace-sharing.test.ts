import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { emptyWorkspace, type MemoryEntry } from "../src/shared/types";
import { buildRunContext } from "../src/main/services/context";
import { applyProjectSharedMemory, previewProjectSharedMemory, readProjectSharedMemory } from "../src/main/services/workspace-sharing";
import { WorkspaceService, validateWorkspaceState } from "../src/main/services/workspace-service";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "nova-shared-memory-")));
  const projectPath = path.join(root, "project");
  const dataDir = path.join(root, "data");
  await mkdir(projectPath);
  await mkdir(dataDir);
  const state = emptyWorkspace();
  const project = { id: "project-1", name: "Sharing fixture", path: projectPath, kind: "folder" as const, branch: "", createdAt: "2026-11-12T00:00:00.000Z" };
  state.projects.push(project);
  state.settings.codexPath = path.join(root, "no-codex-installed");
  state.settings.claudePath = path.join(root, "no-claude-installed");
  const memory: MemoryEntry = {
    id: "memory-1", projectId: project.id, title: "Project decision", content: "Retain the existing local model protocol.",
    kind: "decision", status: "active", source: "User note", createdAt: project.createdAt, updatedAt: project.createdAt,
  };
  state.memories.push(memory);
  const statePath = path.join(dataDir, "workspace.json");
  await writeFile(statePath, JSON.stringify(state));
  const service = new WorkspaceService(dataDir, () => undefined);
  await service.initialize();
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, state, project, projectPath, dataDir, statePath, service, memory };
}

test("shared publishing preserves existing instruction bytes and external notes while replacing one managed block", async (t) => {
  const f = await fixture(t);
  const agents = "\uFEFF# Existing instructions\r\nDo not modify licensing.\r\n";
  const claude = "# Existing Claude instructions\nUse the known project toolchain.\n";
  await writeFile(path.join(f.projectPath, "AGENTS.md"), agents);
  await writeFile(path.join(f.projectPath, "CLAUDE.md"), claude);
  const first = await f.service.previewSharedMemory(f.project.id);
  assert.equal(first.enabled, false);
  assert.deepEqual(first.files.map((file) => file.path), [".nova/MEMORY.md", "AGENTS.md", "CLAUDE.md"]);
  assert.equal(first.files[1].before, agents);
  const result = await f.service.publishSharedMemory({ projectId: f.project.id, fingerprint: first.fingerprint });
  assert.equal(result.enabled, true);
  assert.ok((await readFile(path.join(f.projectPath, "AGENTS.md"), "utf8")).startsWith(agents));
  assert.ok((await readFile(path.join(f.projectPath, "CLAUDE.md"), "utf8")).startsWith(claude));
  const memoryPath = path.join(f.projectPath, ".nova/MEMORY.md");
  await writeFile(memoryPath, (await readFile(memoryPath, "utf8")) + "\n## Native note\nKeep this note from the official CLI.\n");
  await f.service.saveMemory({ id: f.memory.id, projectId: f.project.id, title: f.memory.title, content: "Updated approved note.", kind: "decision", source: "User note" });
  const next = await f.service.previewSharedMemory(f.project.id);
  assert.equal(next.enabled, true);
  assert.match(next.files[0].before!, /Retain the existing/);
  assert.match(next.files[0].after, /Updated approved note/);
  assert.match(next.files[0].after, /Keep this note from the official CLI/);
  await f.service.publishSharedMemory({ projectId: f.project.id, fingerprint: next.fingerprint });
  const noChange = await f.service.previewSharedMemory(f.project.id);
  assert.ok(noChange.files.every((file) => !file.changed));
  assert.equal(noChange.files[1].after.match(/nova-workbench:shared-memory:start/g)?.length, 1);
  assert.match(noChange.files[2].after, /@\.nova\/MEMORY\.md/);
});

test("shared publishing rejects stale file and active-note previews without overwriting user changes", async (t) => {
  const f = await fixture(t);
  const preview = await f.service.previewSharedMemory(f.project.id);
  await writeFile(path.join(f.projectPath, "AGENTS.md"), "New external instructions\n");
  await assert.rejects(f.service.publishSharedMemory({ projectId: f.project.id, fingerprint: preview.fingerprint }), /changed after the preview/);
  assert.equal(await readFile(path.join(f.projectPath, "AGENTS.md"), "utf8"), "New external instructions\n");
  assert.equal(await readProjectSharedMemory(f.projectPath), null);
  const second = await f.service.previewSharedMemory(f.project.id);
  await f.service.saveMemory({ id: f.memory.id, projectId: f.project.id, title: f.memory.title, content: "Changed after preview.", kind: "decision", source: "User note" });
  await assert.rejects(f.service.publishSharedMemory({ projectId: f.project.id, fingerprint: second.fingerprint }), /changed after the preview/);
  assert.equal((await f.service.snapshot()).state.sharedMemoryProjects, undefined);
});

test("shared context requires opt-in, rereads original project changes, bounds content and can be disabled without deleting native references", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.projectPath, ".nova"));
  await writeFile(path.join(f.projectPath, ".nova/MEMORY.md"), "External shared note before opt-in.");
  const thread = { id: "thread-1", projectId: f.project.id };
  const unapproved = await buildRunContext(f.state, thread, "Inspect the project", f.projectPath);
  assert.doesNotMatch(unapproved.prompt, /External shared note/);
  const preview = await f.service.previewSharedMemory(f.project.id);
  await f.service.publishSharedMemory({ projectId: f.project.id, fingerprint: preview.fingerprint });
  let state = (await f.service.snapshot()).state;
  const otherWorktree = path.join(f.root, "isolated-worktree");
  await mkdir(otherWorktree);
  const initial = await buildRunContext(state, thread, "Inspect the project", otherWorktree);
  assert.match(initial.prompt, /External shared note before opt-in/);
  await writeFile(path.join(f.projectPath, ".nova/MEMORY.md"), "Fresh note from official Codex.\n" + "x".repeat(20_000));
  const fresh = await buildRunContext(state, thread, "Continue", otherWorktree);
  assert.match(fresh.prompt, /Fresh note from official Codex/);
  assert.ok(fresh.warnings.some((warning) => /16000/.test(warning)));
  assert.ok(fresh.memories.find((memory) => memory.id === `shared-memory-${f.project.id}`)?.included);
  await f.service.disableSharedMemory(f.project.id);
  state = (await f.service.snapshot()).state;
  assert.deepEqual(state.sharedMemoryProjects, []);
  const disabled = await buildRunContext(state, thread, "Continue", f.projectPath);
  assert.doesNotMatch(disabled.prompt, /Fresh note from official Codex/);
  assert.match(await readFile(path.join(f.projectPath, "AGENTS.md"), "utf8"), /Read .nova\/MEMORY.md/);
  assert.match(await readFile(path.join(f.projectPath, ".nova/MEMORY.md"), "utf8"), /Fresh note from official Codex/);
});

test("sharing excludes stale linked sources and prevents note text from manufacturing managed markers", async (t) => {
  const f = await fixture(t);
  const stale = { ...f.memory, id: "stale-1", title: "Missing linked source", filePath: "missing.txt", fileSha256: "0".repeat(64) };
  const marker = { ...f.memory, content: "<!-- nova-workbench:notes:end -->\n```\nAn embedded note marker." };
  const preview = await previewProjectSharedMemory(f.project, [marker, stale], false);
  assert.ok(preview.warnings.some((warning) => warning.includes(stale.title)));
  assert.doesNotMatch(preview.files[0].after, /stale-1/);
  assert.equal(preview.files[0].after.match(/<!-- nova-workbench:notes:end -->/g)?.length, 1);
  assert.match(preview.files[0].after, /\\u003c/);
  await applyProjectSharedMemory(preview);
  const retry = await previewProjectSharedMemory(f.project, [marker], true);
  assert.equal(retry.files[0].changed, false);
});

test("sharing refuses malformed markers, linked files and redirected .nova directories", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.projectPath, "AGENTS.md"), "<!-- nova-workbench:shared-memory:start -->\nUnfinished user edit.");
  await assert.rejects(f.service.previewSharedMemory(f.project.id), /incomplete or duplicate/);
  await rm(path.join(f.projectPath, "AGENTS.md"));
  const externalFile = path.join(f.root, "outside.md");
  await writeFile(externalFile, "Private outside file");
  await link(externalFile, path.join(f.projectPath, "AGENTS.md"));
  await assert.rejects(f.service.previewSharedMemory(f.project.id), /regular, unlinked/);
  await rm(path.join(f.projectPath, "AGENTS.md"));
  const externalDirectory = path.join(f.root, "outside");
  await mkdir(externalDirectory);
  try { await symlink(externalDirectory, path.join(f.projectPath, ".nova"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Filesystem does not permit the symlink fixture."); return; }
    throw error;
  }
  await assert.rejects(f.service.previewSharedMemory(f.project.id), /ordinary .nova directory/);
  assert.equal(await readFile(externalFile, "utf8"), "Private outside file");
});

test("failed durable opt-in rolls the project files back without losing prior instructions", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.projectPath, "AGENTS.md"), "Original user instructions\n");
  const preview = await f.service.previewSharedMemory(f.project.id);
  const saved = path.join(f.dataDir, "workspace-backup.json");
  await rename(f.statePath, saved);
  await mkdir(f.statePath);
  try {
    await assert.rejects(f.service.publishSharedMemory({ projectId: f.project.id, fingerprint: preview.fingerprint }));
    assert.equal(await readFile(path.join(f.projectPath, "AGENTS.md"), "utf8"), "Original user instructions\n");
    assert.equal(await readProjectSharedMemory(f.projectPath), null);
    assert.equal((await f.service.snapshot()).state.sharedMemoryProjects, undefined);
  } finally {
    await rm(f.statePath, { recursive: true });
    await rename(saved, f.statePath);
  }
});

test("workspace validation rejects fabricated shared-memory project selections", async (t) => {
  const f = await fixture(t);
  assert.throws(() => validateWorkspaceState({ ...f.state, sharedMemoryProjects: ["unknown"] }), /unknown project/);
  assert.throws(() => validateWorkspaceState({ ...f.state, sharedMemoryProjects: [f.project.id, f.project.id] }), /selection/);
  assert.deepEqual(validateWorkspaceState({ ...f.state, sharedMemoryProjects: [f.project.id] }).sharedMemoryProjects, [f.project.id]);
});

test("publishing retains ignored revisions and late open-handle writes while exclusive installation never clobbers a competing writer", async (t) => {
  const f = await fixture(t);
  execFileSync("git", ["init", "--initial-branch=main", f.projectPath], { stdio: "ignore" });
  const target = path.join(f.projectPath, "AGENTS.md");
  await writeFile(target, "Original native instructions\n");
  const held = await open(target, "r+");
  try {
    const preview = await f.service.previewSharedMemory(f.project.id);
    const transaction = await applyProjectSharedMemory(preview);
    assert.ok(transaction.backupDirectory);
    const stored = transaction.backupPaths.find((entry) => entry.endsWith("/AGENTS.md"))!;
    assert.ok(stored);
    assert.equal(await readFile(path.join(f.projectPath, stored), "utf8"), "Original native instructions\n");
    await held.truncate(0);
    await held.writeFile("Late write through the original open handle\n");
    await held.sync();
    assert.equal(await readFile(path.join(f.projectPath, stored), "utf8"), "Late write through the original open handle\n");
    assert.match(await readFile(target, "utf8"), /nova-workbench:shared-memory:start/);
    assert.doesNotMatch(await readFile(target, "utf8"), /Late write/);
    assert.equal(await readFile(path.join(f.projectPath, transaction.backupDirectory!, ".gitignore"), "utf8"), "*\n");
    assert.ok(execFileSync("git", ["-C", f.projectPath, "check-ignore", stored], { encoding: "utf8" }).trim());
  } finally { await held.close(); }

  const conflict = await fixture(t);
  const conflictTarget = path.join(conflict.projectPath, "AGENTS.md");
  await writeFile(conflictTarget, "Recover this original revision\n");
  const conflictPreview = await conflict.service.previewSharedMemory(conflict.project.id);
  const originalLink = fs.promises.link;
  let injected = false;
  // Deterministically emulate a non-cooperating editor recreating the exact
  // destination after the original inode moved but before exclusive install.
  fs.promises.link = async (existingPath, newPath) => {
    if (!injected && String(newPath) === conflictTarget) {
      injected = true;
      await writeFile(conflictTarget, "Newer content from a competing editor\n", { flag: "wx" });
    }
    return originalLink(existingPath, newPath);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(applyProjectSharedMemory(conflictPreview), /retained revisions|Retained revisions/);
  } finally {
    fs.promises.link = originalLink;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.equal(await readFile(conflictTarget, "utf8"), "Newer content from a competing editor\n");
  const backupRoot = path.join(conflict.projectPath, ".nova/.memory-backups");
  const retained = (await readdir(backupRoot, { recursive: true })).filter((entry) => entry.endsWith("AGENTS.md"));
  assert.equal(retained.length, 1);
  assert.equal(await readFile(path.join(backupRoot, retained[0]), "utf8"), "Recover this original revision\n");
});
