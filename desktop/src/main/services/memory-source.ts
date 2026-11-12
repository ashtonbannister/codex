import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { MemoryEntry, MemoryFreshness } from "../../shared/types";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function normalizeMemoryFilePath(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > 1_024 ||
    /[\0\r\n:<>"|?*]/.test(input)
  ) {
    throw new Error("Memory source must be a project-relative file path.");
  }
  const normalized = input.trim().replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      )
  ) {
    throw new Error(
      "Memory source must stay inside the project, outside Git metadata.",
    );
  }
  return normalized;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Capture only a digest, never source contents. Do not follow links outside the selected repository. */
export async function captureMemoryFingerprint(
  root: string,
  input: string,
): Promise<{ filePath: string; fileSha256: string }> {
  const filePath = normalizeMemoryFilePath(input);
  const canonicalRoot = await realpath(root);
  const requested = path.resolve(canonicalRoot, ...filePath.split("/"));
  if (!inside(canonicalRoot, requested))
    throw new Error("Memory source is outside the project.");
  const metadata = await lstat(requested);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(
      "Memory source must be a regular file, not a symbolic link.",
    );
  const canonical = await realpath(requested);
  if (!inside(canonicalRoot, canonical))
    throw new Error("Memory source resolves outside the project.");
  if (metadata.size > MAX_FILE_BYTES)
    throw new Error("Memory source exceeds the 8 MiB fingerprint limit.");
  const handle = await open(
    canonical,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== metadata.size ||
      before.ino !== metadata.ino ||
      before.dev !== metadata.dev
    )
      throw new Error(
        "Memory source changed while it was being opened. Retry the save.",
      );
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, MAX_FILE_BYTES + 1 - size),
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_FILE_BYTES)
        throw new Error("Memory source exceeds the 8 MiB fingerprint limit.");
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const finalMetadata = await lstat(requested);
    if (
      !finalMetadata.isFile() ||
      finalMetadata.ino !== before.ino ||
      finalMetadata.dev !== before.dev ||
      finalMetadata.size !== before.size ||
      finalMetadata.mtimeMs !== before.mtimeMs ||
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      (await realpath(requested)) !== canonical
    ) {
      throw new Error(
        "Memory source changed while it was being fingerprinted. Retry the save.",
      );
    }
    return { filePath, fileSha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export interface MemoryAssessment {
  freshness: MemoryFreshness;
  reason?: string;
}

export async function assessMemoryFreshness(
  root: string | undefined,
  memory: MemoryEntry,
): Promise<MemoryAssessment> {
  if (!memory.filePath)
    return {
      freshness: "unlinked",
      reason:
        "User note without a file fingerprint; current accuracy has not been checked.",
    };
  if (!root || !memory.fileSha256)
    return {
      freshness: "unavailable",
      reason:
        "No comparable source fingerprint is available. Review and save this memory again.",
    };
  try {
    const current = await captureMemoryFingerprint(root, memory.filePath);
    return current.fileSha256 === memory.fileSha256
      ? {
          freshness: "current",
          reason:
            "Source bytes match the digest saved from the original project checkout; this does not prove the note is factually correct.",
        }
      : {
          freshness: "changed",
          reason:
            "Source bytes differ from the saved original-project digest. This note is excluded; reconcile the worktree with the reviewed original source before relinking.",
        };
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code || "",
      )
    )
      return {
        freshness: "missing",
        reason:
          "The linked source is missing in the selected working tree; this note is excluded.",
      };
    return {
      freshness: "unavailable",
      reason:
        "The linked source could not be fingerprinted safely; this note is excluded.",
    };
  }
}
