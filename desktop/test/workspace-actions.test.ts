import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { emptyWorkspace } from "../src/shared/types";
import { createIsolatedWorktree } from "../src/main/services/git";
import { WorkspaceService } from "../src/main/services/workspace-service";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});

async function fixture(t: TestContext, recovery = false) {
  // Windows temp paths can contain an 8.3 alias (RUNNER~1). Persist canonical
  // paths like real project selection, including the fixture's storage paths.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "nova-actions-")));
  const repo = path.join(root, "project");
  const dataDir = path.join(root, "state");
  await mkdir(repo);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Nova fixture");
  git(repo, "config", "user.email", "nova@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  await writeFile(path.join(repo, "README.md"), "initial\n");
  await writeFile(path.join(repo, ".gitignore"), "generated.txt\n");
  git(repo, "add", ".");
  git(repo, "-c", "commit.gpgSign=false", "commit", "-m", "fixture baseline");
  const projectId = randomUUID();
  const threadId = randomUUID();
  const runId = randomUUID();
  const tree = await createIsolatedWorktree(repo, dataDir, threadId);
  const at = new Date().toISOString();
  const state = emptyWorkspace();
  state.settings.codexPath = "nova-actions-fixture-missing-codex";
  state.settings.claudePath = "nova-actions-fixture-missing-claude";
  state.projects.push({ id: projectId, name: "Fixture", path: repo, branch: "main", createdAt: at });
  state.threads.push({ id: threadId, projectId, title: "Finish feature", createdAt: at, updatedAt: at, ...tree });
  state.runs.push({
    id: runId, projectId, threadId, provider: "codex", model: "", mode: "build",
    prompt: "Implement the feature", status: recovery ? "interrupted" : "completed",
    createdAt: at, finishedAt: at, contextMemoryIds: [], verification: "not-run", ...tree,
    terminationUnconfirmed: recovery || undefined,
    events: [
      { id: randomUUID(), at, kind: "message", text: "Visible result" },
      { id: randomUUID(), at, kind: "tool", text: "TOOL_SECRET_NOT_EXPORTED" },
      { id: randomUUID(), at, kind: "error", text: "ERROR_SECRET_NOT_EXPORTED" },
    ],
  });
  if (recovery) state.codexRecoveryHomes = [path.join(root, "synthetic-codex")];
  state.memories.push({
    id: randomUUID(), projectId, title: "Constraint", content: "Keep the feature bounded.",
    kind: "constraint", source: "User", status: "active", createdAt: at, updatedAt: at,
  });
  await writeFile(path.join(dataDir, "workspace.json"), JSON.stringify(state));
  const service = new WorkspaceService(dataDir, () => undefined);
  await service.initialize();
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { root, repo, dataDir, service, projectId, threadId, runId, ...tree };
}

const integration = (review: Awaited<ReturnType<WorkspaceService["reviewWorktree"]>>) => ({
  runId: review.runId, expectedHead: review.head, expectedTargetHead: review.targetHead,
  expectedTargetBranch: review.targetBranch, expectedFingerprint: review.fingerprint,
  expectedTargetFingerprint: review.targetFingerprint,
});

test("reviewed commit preserves original checkout, suppresses hooks/signing and enables deliberate fast-forward", async (t) => {
  const f = await fixture(t);
  const hooks = path.join(f.root, "hooks");
  await mkdir(hooks);
  for (const hook of ["reference-transaction", "pre-commit", "post-commit", "post-merge"])
    await writeFile(path.join(hooks, hook), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  git(f.repo, "config", "core.hooksPath", hooks);
  git(f.repo, "config", "commit.gpgSign", "true");
  git(f.repo, "config", "gpg.program", "nova-nonexistent-signing-program");
  await writeFile(path.join(f.worktreePath, "README.md"), "reviewed implementation\n");
  await writeFile(path.join(f.worktreePath, "new-file.txt"), "new content\n");
  const review = await f.service.reviewWorktree(f.runId);
  assert.equal(review.canCommit, true);
  assert.equal(review.canIntegrate, false);
  const result = await f.service.commitWorktree({ runId: f.runId, message: "Implement feature", expectedHead: review.head, expectedFingerprint: review.fingerprint });
  assert.notEqual(result.commit, review.head);
  assert.equal(git(f.worktreePath, "status", "--porcelain"), "");
  assert.equal(git(f.repo, "rev-parse", "HEAD").trim(), f.baseCommit);
  assert.equal(await readFile(path.join(f.repo, "README.md"), "utf8"), "initial\n");
  const ready = await f.service.reviewWorktree(f.runId);
  assert.equal(ready.canIntegrate, true, ready.integrationReason);
  const integrated = await f.service.integrateWorktree(integration(ready));
  assert.equal(integrated.commit, result.commit);
  assert.equal(git(f.repo, "branch", "--show-current").trim(), "main");
  assert.equal(await readFile(path.join(f.repo, "new-file.txt"), "utf8"), "new content\n");
  assert.equal(git(f.worktreePath, "branch", "--show-current").trim(), f.branch);
  assert.equal((await f.service.reviewWorktree(f.runId)).canIntegrate, false);
});

test("changed reviewed bytes reject commit without advancing branch or staging files", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.worktreePath, "README.md"), "version two\n");
  const review = await f.service.reviewWorktree(f.runId);
  const indexBefore = git(f.worktreePath, "diff", "--cached");
  await writeFile(path.join(f.worktreePath, "README.md"), "version three\n");
  await assert.rejects(f.service.commitWorktree({ runId: f.runId, message: "Stale commit", expectedHead: review.head, expectedFingerprint: review.fingerprint }), /changed while confirmation/);
  assert.equal(git(f.worktreePath, "rev-parse", "HEAD").trim(), f.baseCommit);
  assert.equal(git(f.worktreePath, "diff", "--cached"), indexBefore);
  assert.equal(await readFile(path.join(f.worktreePath, "README.md"), "utf8"), "version three\n");
});

test("integration preserves dirty targets and ignored-file collisions; staged ignored worktree files are committed", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.worktreePath, "generated.txt"), "explicitly staged feature\n");
  git(f.worktreePath, "add", "--force", "generated.txt");
  const review = await f.service.reviewWorktree(f.runId);
  const result = await f.service.commitWorktree({ runId: f.runId, message: "Add explicit artifact", expectedHead: review.head, expectedFingerprint: review.fingerprint });
  assert.equal(git(f.worktreePath, "show", `${result.commit}:generated.txt`), "explicitly staged feature\n");
  let ready = await f.service.reviewWorktree(f.runId);
  await writeFile(path.join(f.repo, "README.md"), "unsaved user edits\n");
  await assert.rejects(f.service.integrateWorktree(integration(ready)), /local changes/);
  assert.equal(await readFile(path.join(f.repo, "README.md"), "utf8"), "unsaved user edits\n");
  assert.equal(git(f.repo, "rev-parse", "HEAD").trim(), f.baseCommit);
  await writeFile(path.join(f.repo, "README.md"), "initial\n");
  await writeFile(path.join(f.repo, "generated.txt"), "original ignored user data\n");
  ready = await f.service.reviewWorktree(f.runId);
  await assert.rejects(f.service.integrateWorktree(integration(ready)), /Git .* failed/);
  assert.equal(await readFile(path.join(f.repo, "generated.txt"), "utf8"), "original ignored user data\n");
  assert.equal(git(f.repo, "rev-parse", "HEAD").trim(), f.baseCommit);
});

test("a different target branch or hidden index flags cannot reuse an integration approval", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.worktreePath, "README.md"), "next\n");
  const before = await f.service.reviewWorktree(f.runId);
  await f.service.commitWorktree({ runId: f.runId, message: "Next", expectedHead: before.head, expectedFingerprint: before.fingerprint });
  const ready = await f.service.reviewWorktree(f.runId);
  git(f.repo, "checkout", "-b", "different-target");
  await assert.rejects(f.service.integrateWorktree(integration(ready)), /changed while confirmation/);
  git(f.worktreePath, "update-index", "--assume-unchanged", "README.md");
  const blocked = await f.service.reviewWorktree(f.runId);
  assert.equal(blocked.canCommit, false);
  assert.match(blocked.commitReason!, /assume-unchanged/);
});

test("explicit recovery acknowledgement survives restart and retains original cleanup uncertainty", async (t) => {
  const f = await fixture(t, true);
  const items = await f.service.listRecoveryItems();
  assert.equal(items.length, 2);
  await assert.rejects(f.service.acknowledgeRecovery({ id: items[0]!.id, token: "0".repeat(64) }), /state changed/);
  for (const item of items) await f.service.acknowledgeRecovery({ id: item.id, token: item.token });
  assert.deepEqual(await f.service.listRecoveryItems(), []);
  const run = (await f.service.snapshot()).state.runs[0]!;
  assert.equal(run.terminationUnconfirmed, true);
  assert.ok(run.recoveryAcknowledgedAt);
  await assert.rejects(f.service.acknowledgeRecovery({ id: items[0]!.id, token: items[0]!.token }), /state changed/);
  await f.service.dispose();
  const reopened = new WorkspaceService(f.dataDir, () => undefined);
  await reopened.initialize();
  assert.deepEqual(await reopened.listRecoveryItems(), []);
  assert.ok((await reopened.snapshot()).state.runs[0]!.recoveryAcknowledgedAt);
  await reopened.dispose();
});

test("conversation export includes visible messages and memory, excludes tool/errors and redacts common credentials", async (t) => {
  const f = await fixture(t);
  await f.service.saveMemory({ projectId: f.projectId, title: "Credential-like fixture", kind: "note", source: "Synthetic", content: "Bearer abcdefghijklmnopqrstuvwxyz0123456789 and sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" });
  const exported = await f.service.exportConversation(f.threadId);
  assert.equal(exported.filename, "Nova-Finish feature.md");
  assert.match(exported.content, /Visible result/);
  assert.match(exported.content, /Keep the feature bounded/);
  assert.doesNotMatch(exported.content, /TOOL_SECRET|ERROR_SECRET|abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.match(exported.content, /redacted/);
});
