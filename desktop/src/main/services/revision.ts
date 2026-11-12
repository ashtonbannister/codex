import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import type { RevisionSnapshot } from "../../shared/types";
import { runGit } from "./git";

export interface RevisionLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDurationMs: number;
}

const LIMITS: RevisionLimits = {
  maxFiles: 20_000,
  maxFileBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxDurationMs: 15_000,
};

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function inventory(root: string, timeoutMs: number): Promise<string[]> {
  const output = await runGit(
    root,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    4 * 1024 * 1024,
    timeoutMs,
  );
  if (output.includes("\uFFFD")) {
    throw new Error(
      "A source filename could not be represented safely as UTF-8.",
    );
  }
  return [...new Set(output.split("\0").filter(Boolean))].sort();
}

/**
 * Fingerprints actual tracked + Git-unignored worktree files, including binary
 * content. Git-ignored outputs/dependencies and external symlink targets are not
 * inputs to this source snapshot. It is evidence about source, not a hermetic
 * description of a command's whole machine/network environment.
 *
 * Reading every tracked file deliberately avoids relying on git diff/status:
 * assume-unchanged flags, display truncation and binary previews cannot hide a
 * changed source file. No checkout, hooks, filters or staging occur here.
 */
export async function captureRevisionSnapshot(
  cwd: string,
  limits: RevisionLimits = LIMITS,
): Promise<RevisionSnapshot> {
  let head = "";
  const fingerprint = createHash("sha256");
  const started = Date.now();
  let bytes = 0;
  const stamps = new Map<string, string>();
  const stamp = (value: Awaited<ReturnType<typeof lstat>>) =>
    JSON.stringify([
      value.dev,
      value.ino,
      value.size,
      value.mode,
      value.mtimeMs,
      value.ctimeMs,
    ]);
  const checkBudget = () => {
    if (Date.now() - started >= limits.maxDurationMs)
      throw new Error("Source fingerprint exceeded its time budget.");
    if (bytes > limits.maxTotalBytes)
      throw new Error("Source fingerprint exceeded its total byte budget.");
  };
  const remaining = () => {
    checkBudget();
    return Math.max(
      1,
      Math.min(
        60_000,
        Math.floor(limits.maxDurationMs - (Date.now() - started)),
      ),
    );
  };
  try {
    if (
      !Object.values(limits).every(
        (value) => Number.isFinite(value) && value > 0,
      )
    )
      throw new Error("Invalid source fingerprint limits.");
    const selected = await realpath(cwd);
    const rootOutput = await runGit(
      selected,
      ["rev-parse", "--show-toplevel"],
      32_768,
      remaining(),
    );
    // A deadline can expire between a command completing and its output being
    // consumed. Never interpret partial/empty output as a filesystem path.
    checkBudget();
    if (!rootOutput.trim() || !path.isAbsolute(rootOutput.trim()))
      throw new Error("Repository did not report a valid source root.");
    const root = await realpath(rootOutput.trim());
    const headOutput = await runGit(
      root,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      256,
      remaining(),
    );
    checkBudget();
    head = headOutput.trim();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head))
      throw new Error("Repository has no valid source revision.");
    const files = await inventory(root, remaining());
    checkBudget();
    if (files.length > limits.maxFiles)
      throw new Error("Source fingerprint exceeded its file-count budget.");
    fingerprint.update(
      JSON.stringify({ version: 1, head, scope: "tracked-and-unignored" }),
    );
    for (const relative of files) {
      checkBudget();
      if (
        path.isAbsolute(relative) ||
        relative.split(/[\\/]/).includes("..") ||
        relative.includes("\0")
      )
        throw new Error("Repository reported an unsafe source path.");
      const file = path.resolve(root, relative);
      if (!inside(root, file))
        throw new Error("A source path leaves the worktree.");
      let before;
      try {
        before = await lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          fingerprint.update(JSON.stringify([relative, "missing"]));
          stamps.set(file, "missing");
          continue;
        }
        throw error;
      }
      // A parent directory can itself be a symlink. Never open a file through
      // one that escapes the canonical worktree.
      if (!inside(root, await realpath(path.dirname(file))))
        throw new Error("A source file resolves outside the worktree.");
      stamps.set(file, stamp(before));
      if (before.isSymbolicLink()) {
        const target = await readlink(file);
        const after = await lstat(file);
        if (
          !after.isSymbolicLink() ||
          before.ino !== after.ino ||
          before.mtimeMs !== after.mtimeMs
        )
          throw new Error("A source symlink changed during fingerprinting.");
        fingerprint.update(JSON.stringify([relative, "symlink", target]));
        continue;
      }
      if (!before.isFile())
        throw new Error(
          "Submodules, directories and special files are outside this source snapshot's supported scope.",
        );
      if (before.size > limits.maxFileBytes)
        throw new Error(
          "A source file exceeded the fingerprint file-size budget.",
        );
      if (!inside(root, await realpath(file)))
        throw new Error("A source file resolves outside the worktree.");
      const handle = await open(
        file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.ino !== before.ino ||
          opened.dev !== before.dev
        )
          throw new Error("A source file changed while it was being opened.");
        const content = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        for (;;) {
          const read = await handle.read(buffer, 0, buffer.length, position);
          if (read.bytesRead === 0) break;
          position += read.bytesRead;
          bytes += read.bytesRead;
          if (position > limits.maxFileBytes)
            throw new Error(
              "A source file grew beyond the fingerprint file-size budget.",
            );
          checkBudget();
          content.update(buffer.subarray(0, read.bytesRead));
        }
        const after = await handle.stat();
        if (
          position !== before.size ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          throw new Error("A source file changed during fingerprinting.");
        fingerprint.update(
          JSON.stringify([
            relative,
            "file",
            before.mode & 0o111,
            position,
            content.digest("hex"),
          ]),
        );
      } finally {
        await handle.close();
      }
    }
    checkBudget();
    const finalHead = (
      await runGit(
        root,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        256,
        remaining(),
      )
    ).trim();
    const finalFiles = await inventory(root, remaining());
    checkBudget();
    if (
      finalHead !== head ||
      JSON.stringify(finalFiles) !== JSON.stringify(files)
    )
      throw new Error(
        "The source revision or file inventory changed during fingerprinting.",
      );
    for (const [file, original] of stamps) {
      checkBudget();
      let current = "missing";
      try {
        current = stamp(await lstat(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current !== original)
        throw new Error(
          "A source file changed before its fingerprint was completed.",
        );
    }
    return { head, fingerprint: fingerprint.digest("hex"), complete: true };
  } catch (error) {
    return {
      head,
      fingerprint: fingerprint.digest("hex"),
      complete: false,
      reason: (Number.isFinite(limits.maxDurationMs) &&
      limits.maxDurationMs > 0 &&
      Date.now() - started >= limits.maxDurationMs
        ? "Source fingerprint exceeded its time budget."
        : error instanceof Error
          ? error.message
          : "The source fingerprint could not be completed."
      ).slice(0, 4_000),
    };
  }
}
