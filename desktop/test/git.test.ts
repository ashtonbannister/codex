import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createIsolatedWorktree,
  getWorkspaceDiff,
  gitExecutableCandidates,
  inspectRepository,
  parsePorcelain,
  resolveGitExecutable,
  runGit,
} from "../src/main/services/git";

const exec = promisify(execFile);

test("Git executable resolution ignores cwd, relative and drive-relative PATH entries", async () => {
  assert.deepEqual(
    gitExecutableCandidates(":.:relative:/usr/bin:/opt/git/bin", "linux"),
    ["/usr/bin/git", "/opt/git/bin/git"],
  );
  assert.deepEqual(
    gitExecutableCandidates(
      ';.;relative;C:tools;\\tools;C:\\Program Files\\Git\\cmd;"D:\\Tools";\\\\server\\share\\bin',
      "win32",
    ),
    [
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "D:\\Tools\\git.exe",
      "\\\\server\\share\\bin\\git.exe",
    ],
  );
  await assert.rejects(resolveGitExecutable(""), /absolute PATH entry/);
  assert.ok(path.isAbsolute(await resolveGitExecutable()));
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "nova-git-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project with spaces");
  await mkdir(root);
  await exec("git", ["init", "--initial-branch=main"], { cwd: root });
  await runGit(root, ["config", "user.name", "Nova tests"]);
  await runGit(root, ["config", "user.email", "nova-tests@example.invalid"]);
  await writeFile(path.join(root, "hello.txt"), "hello\n");
  await runGit(root, ["add", "--", "hello.txt"]);
  await runGit(root, ["commit", "-m", "fixture"]);
  return { temporary, root, dataDir: path.join(temporary, "data") };
}

test("repository selection resolves nested directories to a canonical root", async (t) => {
  const { root } = await fixture(t);
  const nested = path.join(root, "nested");
  await mkdir(nested);
  const info = await inspectRepository(nested);
  assert.equal(info.path, root);
  assert.equal(info.name, "project with spaces");
  assert.equal(info.branch, "main");
  assert.equal(info.clean, true);
  assert.match(info.head, /^[0-9a-f]{40}$/);
  await assert.rejects(inspectRepository(""), /valid local repository/);
  await assert.rejects(inspectRepository("x\0y"), /valid local repository/);
});

test("worktrees require clean source and reject unsafe thread identifiers", async (t) => {
  const { root, dataDir } = await fixture(t);
  await assert.rejects(
    createIsolatedWorktree(root, dataDir, "../../outside"),
    /Invalid thread/,
  );
  await writeFile(path.join(root, "untracked.txt"), "keep me");
  await assert.rejects(
    createIsolatedWorktree(root, dataDir, randomUUID()),
    /clean repository/,
  );
  assert.equal(
    await readFile(path.join(root, "untracked.txt"), "utf8"),
    "keep me",
  );
});

test("isolated changes leave source intact and diff includes tracked plus untracked files", async (t) => {
  const { root, dataDir } = await fixture(t);
  const worktree = await createIsolatedWorktree(root, dataDir, randomUUID());
  await writeFile(path.join(worktree.worktreePath, "hello.txt"), "changed\n");
  await writeFile(
    path.join(worktree.worktreePath, "new ; file.txt"),
    "new content\n",
  );
  await writeFile(
    path.join(worktree.worktreePath, ".env.local"),
    "SHOULD_NOT_RENDER=secret\n",
  );
  const diff = await getWorkspaceDiff(
    worktree.worktreePath,
    worktree.baseCommit,
    worktree.branch,
  );
  assert.equal(await readFile(path.join(root, "hello.txt"), "utf8"), "hello\n");
  assert.equal((await inspectRepository(root)).clean, true);
  assert.ok(diff.changes.some((change) => change.path === "hello.txt"));
  assert.ok(diff.changes.some((change) => change.path === "new ; file.txt"));
  assert.match(diff.diff, /\+changed/);
  assert.match(diff.diff, /\+new content/);
  assert.match(diff.diff, /potential credentials/);
  assert.doesNotMatch(diff.diff, /SHOULD_NOT_RENDER/);
  assert.equal(diff.truncated, false);
  await assert.rejects(
    getWorkspaceDiff(
      worktree.worktreePath,
      "--output=outside",
      worktree.branch,
    ),
    /baseline/,
  );
});

test("diff lists committed changes relative to original baseline", async (t) => {
  const { root, dataDir } = await fixture(t);
  const worktree = await createIsolatedWorktree(root, dataDir, randomUUID());
  await writeFile(
    path.join(worktree.worktreePath, "hello.txt"),
    "committed change\n",
  );
  await runGit(worktree.worktreePath, ["add", "--", "hello.txt"]);
  await runGit(worktree.worktreePath, ["commit", "-m", "worktree change"]);
  const diff = await getWorkspaceDiff(
    worktree.worktreePath,
    worktree.baseCommit,
    worktree.branch,
  );
  assert.ok(diff.changes.some((change) => change.path === "hello.txt"));
  assert.match(diff.diff, /committed change/);
});

test("porcelain parser consumes rename source without losing following paths", () => {
  assert.deepEqual(
    parsePorcelain(
      "R  new file.txt\0old file.txt\0 M plain.txt\0?? a\nb.txt\0",
    ),
    [
      { path: "new file.txt", status: "R" },
      { path: "plain.txt", status: "M" },
      { path: "a\nb.txt", status: "??" },
    ],
  );
});

test(
  "Git worktree checkout does not run post-checkout hooks",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, dataDir, temporary } = await fixture(t);
    const marker = path.join(temporary, "hook-was-run");
    await writeFile(
      path.join(root, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\necho unsafe > '${marker}'\n`,
      { mode: 0o755 },
    );
    await createIsolatedWorktree(root, dataDir, randomUUID());
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  },
);

test(
  "Git worktree checkout does not run configured smudge filters",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, dataDir, temporary } = await fixture(t);
    await writeFile(
      path.join(root, ".gitattributes"),
      "hello.txt filter=nova_test\n",
    );
    await runGit(root, ["add", "--", ".gitattributes"]);
    await runGit(root, ["commit", "-m", "attribute fixture"]);
    const marker = path.join(temporary, "filter-was-run");
    await runGit(root, [
      "config",
      "filter.nova_test.smudge",
      `echo unsafe > '${marker}'; cat`,
    ]);
    await runGit(root, ["config", "filter.nova_test.required", "true"]);
    const worktree = await createIsolatedWorktree(root, dataDir, randomUUID());
    assert.equal(
      await readFile(path.join(worktree.worktreePath, "hello.txt"), "utf8"),
      "hello\n",
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  },
);

test("large new file previews are explicitly truncated", async (t) => {
  const { root, dataDir } = await fixture(t);
  const worktree = await createIsolatedWorktree(root, dataDir, randomUUID());
  await writeFile(
    path.join(worktree.worktreePath, "large.txt"),
    "bounded output\n".repeat(20_000),
  );
  const diff = await getWorkspaceDiff(
    worktree.worktreePath,
    worktree.baseCommit,
    worktree.branch,
  );
  assert.equal(diff.truncated, true);
  assert.match(diff.diff, /File preview truncated/);
  assert.ok(Buffer.byteLength(diff.diff) <= 256 * 1024);
});

test(
  "untracked symlinks do not reveal files outside the worktree",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, dataDir, temporary } = await fixture(t);
    const worktree = await createIsolatedWorktree(root, dataDir, randomUUID());
    const outside = path.join(temporary, "private.txt");
    await writeFile(outside, "OUTSIDE_CONTENT");
    await symlink(outside, path.join(worktree.worktreePath, "linked.txt"));
    const diff = await getWorkspaceDiff(
      worktree.worktreePath,
      worktree.baseCommit,
      worktree.branch,
    );
    assert.doesNotMatch(diff.diff, /OUTSIDE_CONTENT/);
    assert.match(diff.diff, /non-regular file/);
  },
);
