import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rmdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DiffSnapshot, GitChange } from "../../shared/types";

const execFileAsync = promisify(execFile);
const DIFF_LIMIT = 256 * 1024;
const STATUS_LIMIT = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/** Never let Windows resolve `git.exe` from the selected repository cwd. */
export function gitExecutableCandidates(
  searchPath: string,
  platform = process.platform,
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return searchPath.split(platform === "win32" ? ";" : ":").flatMap((entry) => {
    const directory =
      entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    if (
      !directory ||
      /[\0\r\n]/.test(directory) ||
      !pathApi.isAbsolute(directory)
    )
      return [];
    // Windows root-relative paths (\foo) depend on the current drive and are
    // not explicit absolute entries. Require a drive root or a UNC share.
    if (
      platform === "win32" &&
      !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(directory)
    )
      return [];
    return [pathApi.join(directory, platform === "win32" ? "git.exe" : "git")];
  });
}

export async function resolveGitExecutable(
  searchPath = process.env.PATH ?? "",
): Promise<string> {
  for (const candidate of gitExecutableCandidates(searchPath)) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(
        candidate,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      return await realpath(candidate);
    } catch {
      /* Try the next explicit PATH entry. */
    }
  }
  throw new Error(
    "Git was not found on an absolute PATH entry. Install Git for Windows and restart Nova Workbench.",
  );
}

function validatePath(value: string): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 32_768 ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error("Choose a valid local repository directory.");
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  // Parent shells can set GIT_DIR/WORK_TREE/INDEX_FILE and redirect otherwise
  // well-formed commands to another repository. Our selected cwd owns the target.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
  );
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
}

async function executeGit(
  cwd: string,
  args: string[],
  maxBytes = STATUS_LIMIT,
  allowTruncation = false,
  timeoutMs = 60_000,
): Promise<{ output: string; truncated: boolean }> {
  validatePath(cwd);
  if (
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    throw new Error("Invalid Git arguments.");
  }
  // Even `git status` can invoke a configured clean/process filter. Discover
  // names through a config-only read and override conversion commands for all
  // content-sensitive operations. The config read does not recurse here.
  const contentArgs = args.some((arg) =>
    ["status", "diff", "worktree"].includes(arg),
  )
    ? await disabledFilterArgs(cwd)
    : [];
  const executable = await resolveGitExecutable();
  try {
    const { stdout } = await execFileAsync(
      executable,
      [
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        ...contentArgs,
        ...args,
      ],
      {
        cwd,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        env: gitEnvironment(),
        maxBuffer: maxBytes,
        timeout: timeoutMs,
      },
    );
    return { output: stdout, truncated: false };
  } catch (cause) {
    const error = cause as Error & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (allowTruncation && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return {
        output: Buffer.from(error.stdout ?? "")
          .subarray(0, maxBytes)
          .toString("utf8"),
        truncated: true,
      };
    }
    if (error.code === "ENOENT")
      throw new Error(
        "Git was not found. Install Git for Windows and restart Nova Workbench.",
      );
    if (error.killed)
      throw new Error(
        "Git did not finish within its time budget. No automatic rollback or deletion was performed.",
      );
    // Do not copy command strings or arbitrary gitconfig content into app errors.
    throw new Error(
      `Git ${args.find((arg) => ["status", "diff", "worktree", "rev-parse", "branch", "config"].includes(arg)) ?? "operation"} failed. Check that the repository is accessible and Git is configured.`,
      { cause },
    );
  }
}

export async function runGit(
  cwd: string,
  args: string[],
  maxBytes = STATUS_LIMIT,
  timeoutMs = 60_000,
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
    throw new Error("Invalid Git time budget.");
  return (await executeGit(cwd, args, maxBytes, false, timeoutMs)).output;
}

export interface RepositoryInfo {
  path: string;
  name: string;
  branch: string;
  head: string;
  clean: boolean;
}

export async function inspectRepository(
  inputPath: string,
): Promise<RepositoryInfo> {
  validatePath(inputPath);
  const selected = await realpath(inputPath);
  if (!(await stat(selected)).isDirectory())
    throw new Error("Choose a directory, not a file.");
  if (
    (await runGit(selected, ["rev-parse", "--is-inside-work-tree"])).trim() !==
    "true"
  ) {
    throw new Error(
      "Choose a Git working tree. Bare repositories are not supported.",
    );
  }
  const root = await realpath(
    (await runGit(selected, ["rev-parse", "--show-toplevel"])).trim(),
  );
  const head = (
    await runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"])
  ).trim();
  if (!SHA.test(head))
    throw new Error(
      "The repository needs an initial commit before it can be opened.",
    );
  const branch =
    (await runGit(root, ["branch", "--show-current"])).trim() ||
    "(detached HEAD)";
  const statusOutput = await runGit(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return {
    path: root,
    name: path.basename(root),
    branch,
    head,
    clean: statusOutput.length === 0,
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function disabledFilterArgs(root: string): Promise<string[]> {
  let names: string;
  try {
    names = await runGit(root, [
      "config",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(process|smudge|clean|required)$",
    ]);
  } catch (error) {
    // git config returns 1 when no matching keys exist. No checkout filters are
    // configured in that case; actual checkout errors still fail closed below.
    if (
      ((error as Error).cause as { code?: number | string } | undefined)
        ?.code === 1
    )
      names = "";
    else throw error;
  }
  const args: string[] = [];
  for (const name of new Set(names.trim().split(/\r?\n/).filter(Boolean))) {
    // Git configuration is repository data, not argument syntax. Reject keys
    // whose subsection could become an option or escape our exact override.
    if (!/^filter\.[a-z0-9_-]+\.(process|smudge|clean|required)$/i.test(name)) {
      throw new Error(
        "This repository has an unsupported Git filter name. Hydrate or simplify its filters before creating a build worktree.",
      );
    }
    args.push("-c", `${name}=${name.endsWith(".required") ? "false" : ""}`);
  }
  return args;
}

export async function createIsolatedWorktree(
  projectRoot: string,
  dataDir: string,
  threadId: string,
): Promise<{ worktreePath: string; branch: string; baseCommit: string }> {
  if (!UUID.test(threadId)) throw new Error("Invalid thread identifier.");
  validatePath(dataDir);
  const before = await inspectRepository(projectRoot);
  if (!before.clean)
    throw new Error(
      "Build needs a clean repository. Commit or stash your changes, including untracked files, then retry. Nova will not change them for you.",
    );
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const storageRoot = await realpath(dataDir);
  const parent = path.join(storageRoot, "worktrees");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (
    (await lstat(parent)).isSymbolicLink() ||
    (await realpath(parent)) !== parent
  ) {
    throw new Error("Worktree storage must be a real directory, not a link.");
  }
  const worktreePath = path.join(parent, threadId);
  try {
    await lstat(worktreePath);
    throw new Error(
      "A worktree already exists for this thread. It has been preserved; choose a new thread.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const branch = `nova/${threadId}`;
  const filterArgs = await disabledFilterArgs(before.path);
  const hooksDir = await mkdtemp(path.join(storageRoot, "git-no-hooks-"));
  try {
    // --no-checkout would produce an unusable project. Suppress checkout hooks
    // and filter commands explicitly instead. Git LFS files remain pointers.
    await runGit(before.path, [
      "-c",
      `core.hooksPath=${hooksDir}`,
      ...filterArgs,
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      before.head,
    ]);
  } finally {
    await rmdir(hooksDir).catch(() => undefined);
  }
  const after = await inspectRepository(before.path);
  if (after.head !== before.head || !after.clean) {
    throw new Error(
      `The source repository changed while the worktree was created. No agent was started. The isolated worktree is preserved at ${worktreePath}.`,
    );
  }
  return { worktreePath, branch, baseCommit: before.head };
}

/** Porcelain v1 -z puts the destination first and consumes a second path for renames. */
export function parsePorcelain(output: string): GitChange[] {
  const parts = output.split("\0");
  const changes: GitChange[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    changes.push({ path: record.slice(3), status: code.trim() });
    if (/[RC]/.test(code)) index += 1;
  }
  return changes;
}

function sensitiveUntrackedPath(filePath: string): boolean {
  return filePath
    .split(/[\\/]/)
    .some(
      (part) =>
        /^\.env(?:\.|$)/i.test(part) ||
        /^(?:credentials|secrets|auth)(?:\.|$)/i.test(part) ||
        /^id_(?:rsa|ed25519|ecdsa)(?:\.|$)/i.test(part) ||
        /\.(?:pem|key|p12|pfx)$/i.test(part),
    );
}

async function untrackedPreview(
  root: string,
  name: string,
  remaining: number,
): Promise<{ text: string; truncated: boolean }> {
  const label = JSON.stringify(name);
  const preview = (text: string, truncated = false) => ({ text, truncated });
  if (sensitiveUntrackedPath(name))
    return preview(
      `\nUntracked ${label}: preview omitted (potential credentials).\n`,
    );
  const target = path.resolve(root, name);
  if (!isInside(root, target))
    return preview(
      `\nUntracked ${label}: preview omitted (outside worktree).\n`,
    );
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    return preview(`\nUntracked ${label}: non-regular file preview omitted.\n`);
  if (!isInside(root, await realpath(path.dirname(target))))
    return preview(`\nUntracked ${label}: preview omitted (linked parent).\n`);
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const size = Math.min(
      metadata.size,
      64 * 1024,
      Math.max(0, remaining - 300),
    );
    if (size === 0 && metadata.size > 0)
      return preview(
        `\nUntracked ${label}: preview omitted (output limit).\n`,
        true,
      );
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    const data = buffer.subarray(0, bytesRead);
    if (data.includes(0))
      return preview(
        `\nUntracked ${label}: binary file (${metadata.size} bytes).\n`,
      );
    const lines = data.toString("utf8").split("\n");
    const truncation =
      metadata.size > bytesRead ? "\n[File preview truncated]" : "";
    return preview(
      `\ndiff --git ${JSON.stringify(`a/${name}`)} ${JSON.stringify(`b/${name}`)}\nnew file mode 100644\n--- /dev/null\n+++ ${JSON.stringify(`b/${name}`)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}${truncation}\n`,
      metadata.size > bytesRead,
    );
  } finally {
    await handle.close();
  }
}

export async function getWorkspaceDiff(
  worktreePath: string,
  baseCommit: string,
  branch: string,
): Promise<DiffSnapshot> {
  validatePath(worktreePath);
  if (!SHA.test(baseCommit)) throw new Error("Invalid worktree baseline.");
  const root = await realpath(worktreePath);
  const actualRoot = await realpath(
    (await runGit(root, ["rev-parse", "--show-toplevel"])).trim(),
  );
  if (actualRoot !== root)
    throw new Error(
      "The recorded worktree no longer points to a repository root.",
    );
  const current = parsePorcelain(
    await runGit(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
  );
  const baselineStatus = (
    await runGit(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-status",
      "-z",
      baseCommit,
      "--",
    ])
  ).split("\0");
  const byPath = new Map<string, GitChange>();
  for (let index = 0; index + 1 < baselineStatus.length; index += 2) {
    const status = baselineStatus[index];
    const name = baselineStatus[index + 1];
    if (status && name) byPath.set(name, { path: name, status });
  }
  for (const change of current) byPath.set(change.path, change);
  const result = await executeGit(
    root,
    ["diff", "--no-ext-diff", "--no-textconv", "--no-color", baseCommit, "--"],
    DIFF_LIMIT,
    true,
  );
  let diff = result.output;
  let truncated = result.truncated;
  for (const change of current.filter((item) => item.status === "??")) {
    const remaining = DIFF_LIMIT - Buffer.byteLength(diff, "utf8");
    if (remaining < 300) {
      truncated = true;
      break;
    }
    try {
      const preview = await untrackedPreview(root, change.path, remaining);
      diff += preview.text;
      truncated ||= preview.truncated;
    } catch {
      diff += `\nUntracked ${JSON.stringify(change.path)}: preview unavailable (file changed or access denied).\n`;
    }
    if (Buffer.byteLength(diff, "utf8") > DIFF_LIMIT) {
      diff = Buffer.from(diff).subarray(0, DIFF_LIMIT).toString("utf8");
      truncated = true;
      break;
    }
  }
  return { branch, changes: [...byPath.values()], diff, truncated };
}
