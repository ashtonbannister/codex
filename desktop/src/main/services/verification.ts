import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { VerificationProfile } from "../../shared/types";
import {
  disconnectChild,
  terminateTree,
  trackOwnedProcess,
  type Executable,
} from "./providers";

export interface VerificationCommandResult {
  exitCode?: number;
  output: string;
  truncated: boolean;
  error?: string;
  cancelled: boolean;
  terminationUnconfirmed?: boolean;
}

export function verificationExecutableCandidates(
  input: string,
  platform = process.platform,
  searchPath = process.env.PATH ?? "",
): string[] {
  const api = platform === "win32" ? path.win32 : path.posix;
  if (
    typeof input !== "string" ||
    !input ||
    input.length > 2_000 ||
    /[\0\r\n]/.test(input)
  )
    throw new Error("Invalid verification executable.");
  const absolute = (value: string) =>
    api.isAbsolute(value) &&
    (platform !== "win32" ||
      /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value));
  if (absolute(input)) return [input];
  if (input.includes("/") || input.includes("\\"))
    throw new Error(
      "Use an absolute verification executable path or a command on PATH.",
    );
  const extensions = platform === "win32" ? [".exe", ".cmd", ""] : [""];
  return searchPath.split(platform === "win32" ? ";" : ":").flatMap((entry) => {
    const directory =
      entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    if (!absolute(directory) || /[\0\r\n]/.test(directory)) return [];
    return extensions.map((extension) =>
      api.join(
        directory,
        input.toLowerCase().endsWith(extension)
          ? input
          : `${input}${extension}`,
      ),
    );
  });
}

/** Resolves before entering the worktree; never executes a .cmd/.bat shim. */
export async function resolveVerificationExecutable(
  input: string,
  platform = process.platform,
  searchPath = process.env.PATH ?? "",
): Promise<Executable> {
  for (const candidate of verificationExecutableCandidates(
    input,
    platform,
    searchPath,
  )) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      const file = await realpath(candidate);
      const extension = path.extname(file).toLowerCase();
      if (extension === ".cmd" || extension === ".bat") {
        // npm's official Windows shim points at a known JS entry. We resolve
        // that file directly, without reading or interpreting shim contents.
        if (
          path
            .basename(candidate)
            .replace(/\.(cmd|bat)$/i, "")
            .toLowerCase() !== "npm"
        )
          continue;
        const entry = path.join(
          path.dirname(file),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        );
        if (!(await stat(entry)).isFile()) continue;
        return {
          command: process.execPath,
          prefix: [await realpath(entry)],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        };
      }
      if ([".js", ".cjs", ".mjs"].includes(extension))
        return {
          command: process.execPath,
          prefix: [file],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        };
      if (platform === "win32" && extension !== ".exe") continue;
      await access(
        file,
        platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      return { command: file, prefix: [] };
    } catch {
      /* Try another explicit PATH candidate. */
    }
  }
  throw new Error(
    "Verification executable was not found. Select a native executable, a JavaScript entry point, or an installed npm command. Batch shims are not executed.",
  );
}

/**
 * Runs only a saved, explicitly user-approved verification command. This is not
 * an OS sandbox; the native confirmation must explain that commands can modify
 * the worktree and access resources allowed to the user's account.
 */
export async function runVerificationCommand(options: {
  profile: VerificationProfile;
  cwd: string;
  signal: AbortSignal;
  maxBytes: number;
  /** Receives each decoded output chunk, never cumulative output. */
  onOutput: (text: string) => void;
}): Promise<VerificationCommandResult> {
  const empty = { output: "", truncated: false, cancelled: false };
  if (options.signal.aborted) return { ...empty, cancelled: true };
  const { profile } = options;
  if (
    !Array.isArray(profile.args) ||
    profile.args.length > 64 ||
    profile.args.some(
      (arg) =>
        typeof arg !== "string" || arg.length > 4_000 || arg.includes("\0"),
    ) ||
    profile.args.reduce((total, arg) => total + arg.length, 0) > 32_000
  )
    return { ...empty, error: "Invalid verification arguments." };
  if (
    !Number.isFinite(profile.timeoutMinutes) ||
    profile.timeoutMinutes <= 0 ||
    profile.timeoutMinutes > 120 ||
    !Number.isInteger(options.maxBytes) ||
    options.maxBytes < 1_024 ||
    options.maxBytes > 4_194_304
  )
    return { ...empty, error: "Invalid verification runtime or output limit." };
  let executable: Executable;
  try {
    executable = await resolveVerificationExecutable(profile.executable);
  } catch (error) {
    return {
      ...empty,
      error:
        error instanceof Error
          ? error.message
          : "Verification executable could not be resolved.",
    };
  }
  if (options.signal.aborted) return { ...empty, cancelled: true };
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(
      executable.command,
      [...executable.prefix, ...profile.args],
      {
        cwd: options.cwd,
        env: { ...process.env, ...executable.env, NO_COLOR: "1" },
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    trackOwnedProcess(child, startedAt);
    const stdout = new StringDecoder("utf8");
    const stderr = new StringDecoder("utf8");
    let output = "";
    let bytes = 0;
    let truncated = false;
    let failure: string | undefined;
    let settled = false;
    let finishing = false;
    let termination: Promise<boolean> | undefined;
    let drain: NodeJS.Timeout | undefined;
    const append = (value: string) => {
      if (!value) return;
      output += value;
      try {
        options.onOutput(value);
      } catch {
        failure ??= "Verification output could not be recorded.";
        stop();
      }
    };
    const finish = async (
      code: number | null,
      terminationUnconfirmed = false,
      spawnError = false,
    ) => {
      if (settled || finishing) return;
      finishing = true;
      clearTimeout(timeout);
      clearTimeout(drain);
      // Closed stdout/stderr prove only that the leader exited, not that its
      // ignored-stdio descendants can no longer modify the worktree.
      terminationUnconfirmed ||= !(await (termination ??=
        terminateTree(child)));
      settled = true;
      options.signal.removeEventListener("abort", abort);
      append(stdout.end());
      append(stderr.end());
      const cancelled = options.signal.aborted && !terminationUnconfirmed;
      const error = terminationUnconfirmed
        ? "Verification process termination could not be confirmed. Inspect remaining processes before using this worktree again."
        : cancelled
          ? undefined
          : failure ||
            (spawnError
              ? "Verification command could not start. Check the executable and working directory."
              : code !== 0
                ? `Verification command exited with code ${String(code)}.`
                : undefined);
      resolve({
        output,
        truncated,
        exitCode: typeof code === "number" ? code : undefined,
        error,
        cancelled,
        ...(terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
      });
    };
    const stop = () => {
      if (termination || settled || finishing) return;
      termination = terminateTree(child);
      void termination.then(() => {
        if (settled || finishing) return;
        // Start the pipe-drain deadline after bounded tree cleanup, not while
        // taskkill or the POSIX SIGKILL escalation is still running.
        drain = setTimeout(() => {
          if (settled || finishing) return;
          disconnectChild(child);
          void finish(child.exitCode, true);
        }, 1_500);
      });
    };
    const consume = (chunk: Buffer, decoder: StringDecoder) => {
      if (settled) return;
      const remaining = options.maxBytes - bytes;
      bytes += chunk.length;
      if (remaining > 0) append(decoder.write(chunk.subarray(0, remaining)));
      if (bytes > options.maxBytes) {
        truncated = true;
        failure ??=
          "Verification output exceeded its configured limit. Existing worktree changes were preserved.";
        stop();
      }
    };
    const abort = () => stop();
    const timeout = setTimeout(() => {
      failure ??=
        "Verification timed out. Existing worktree changes were preserved.";
      stop();
    }, profile.timeoutMinutes * 60_000);
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, stdout));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, stderr));
    child.once("error", () => {
      void finish(null, false, true);
    });
    child.once("close", (code) => {
      void finish(code);
    });
    if (options.signal.aborted) abort();
  });
}
