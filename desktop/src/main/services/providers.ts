import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type {
  ProviderId,
  ProviderStatus,
  RunMode,
  Settings,
} from "../../shared/types";
import { normalizeProviderLine, type NormalizedEvent } from "./provider-events";

export interface Executable {
  command: string;
  prefix: string[];
  env?: Record<string, string>;
}
export interface ProviderCommand extends Executable {
  args: string[];
}
export interface ProcessResult {
  cancelled: boolean;
  error?: string;
  completed: boolean;
  terminationUnconfirmed?: boolean;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Resolve a real executable before entering an untrusted repository. Never run a shell shim. */
export async function resolveExecutable(
  input: string,
  platform = process.platform,
  searchPath = process.env.PATH ?? "",
): Promise<Executable> {
  if (!input || /[\0\r\n]/.test(input))
    throw new Error("Invalid CLI executable path.");
  const candidates: string[] = [];
  if (path.isAbsolute(input)) candidates.push(input);
  else if (input.includes("/") || input.includes("\\"))
    throw new Error("Use an absolute executable path or a command on PATH.");
  else {
    const extensions = platform === "win32" ? [".exe", ".cmd", ""] : [""];
    for (const directory of searchPath.split(
      platform === "win32" ? ";" : path.delimiter,
    )) {
      if (!directory || !path.isAbsolute(directory)) continue;
      for (const extension of extensions)
        candidates.push(
          path.join(
            directory,
            input.endsWith(extension) ? input : `${input}${extension}`,
          ),
        );
    }
  }
  for (const candidate of candidates) {
    if (!(await isFile(candidate))) continue;
    const file = await realpath(candidate);
    const extension = path.extname(file).toLowerCase();
    if (extension === ".cmd" || extension === ".bat") {
      // The official npm shims have known JS entry points; do not interpret .cmd contents.
      const name = path.basename(candidate, extension).toLowerCase();
      const entry =
        name === "codex"
          ? "node_modules/@openai/codex/bin/codex.js"
          : name === "claude"
            ? "node_modules/@anthropic-ai/claude-code/cli.js"
            : undefined;
      if (entry && (await isFile(path.join(path.dirname(candidate), entry)))) {
        return {
          command: process.execPath,
          prefix: [await realpath(path.join(path.dirname(candidate), entry))],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        };
      }
      continue;
    }
    if ([".js", ".cjs", ".mjs"].includes(extension)) {
      return {
        command: process.execPath,
        prefix: [file],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
    }
    if (platform === "win32" && extension !== ".exe") continue;
    await access(file, platform === "win32" ? constants.F_OK : constants.X_OK);
    return { command: file, prefix: [] };
  }
  throw new Error(
    `Cannot find ${input}. Install the official CLI or select its native executable / JavaScript entry point in Settings. Shell scripts ending in .cmd or .bat are not executed.`,
  );
}

const execFileAsync = promisify(execFile);
const ownedProcesses = new WeakMap<
  ChildProcess,
  { startedAt: number; exitedAt?: number }
>();
const terminationTasks = new WeakMap<ChildProcess, Promise<boolean>>();
type TerminationFailureCode =
  | "windows-inventory-timeout"
  | "windows-inventory-output-limit"
  | "windows-inventory-unavailable"
  | "windows-inventory-exit-failure"
  | "windows-inventory-invalid"
  | "windows-identity-ambiguous"
  | "windows-leader-pid-reused-after-exit"
  | "windows-exited-leader-pid-observed"
  | "windows-cleanup-deadline"
  | "windows-process-limit"
  | "worker-lifetime-unavailable"
  | "posix-cleanup-unconfirmed"
  | "unexpected-cleanup-error"
  | "output-pipes-still-open";
const terminationFailures = new WeakMap<ChildProcess, TerminationFailureCode>();

export class CleanupFailure extends Error {
  constructor(
    readonly code: TerminationFailureCode,
    message: string = code,
  ) {
    super(message);
  }
}

/** Fixed diagnostic codes only: never expose commands, process output or env. */
export function terminationDiagnostic(
  child: ChildProcess,
): TerminationFailureCode {
  return terminationFailures.get(child) ?? "output-pipes-still-open";
}

export function classifyWindowsInventoryFailure(
  error: unknown,
): TerminationFailureCode {
  const value =
    error && typeof error === "object"
      ? (error as { code?: unknown; killed?: unknown })
      : {};
  if (value.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return "windows-inventory-output-limit";
  if (value.killed === true) return "windows-inventory-timeout";
  if (
    value.code === "ENOENT" ||
    value.code === "EACCES" ||
    value.code === "EPERM"
  )
    return "windows-inventory-unavailable";
  return "windows-inventory-exit-failure";
}

/** Cold CIM startup gets up to 5s, always inside the same 8s cleanup deadline. */
export function windowsInventoryTimeout(
  deadline: number,
  now = Date.now(),
): number {
  return Math.max(0, Math.min(5_000, Math.floor(deadline - now)));
}
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Register immediately after spawning, before any asynchronous work. */
export function trackOwnedProcess(
  child: ChildProcess,
  startedAt: number,
): void {
  const lifetime = { startedAt, exitedAt: undefined as number | undefined };
  ownedProcesses.set(child, lifetime);
  child.once("exit", () => {
    lifetime.exitedAt = Date.now();
  });
}

async function processGroupState(
  pid: number,
): Promise<"alive" | "gone" | "unknown"> {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "gone"
      : "unknown";
  }
  try {
    // kill(group, 0) also sees orphan zombies awaiting the OS reaper. They
    // cannot execute or write, so distinguish them from runnable descendants.
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-A", "-o", "pgid=", "-o", "stat="],
      {
        shell: false,
        encoding: "utf8",
        timeout: 300,
        maxBuffer: 1_048_576,
      },
    );
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
      if (!match) {
        if (line.trim()) return "unknown";
        continue;
      }
      if (Number(match[1]) === pid && !/^[ZX]/.test(match[2])) return "alive";
    }
    return "gone";
  } catch {
    return "unknown";
  }
}

async function terminatePosixGroup(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  const grace = Date.now() + 150;
  do {
    if ((await processGroupState(pid)) === "gone") return true;
    await pause(25);
  } while (Date.now() < grace);
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
  }
  const deadline = Date.now() + 650;
  do {
    if ((await processGroupState(pid)) === "gone") return true;
    await pause(25);
  } while (Date.now() < deadline);
  return false;
}

interface WindowsProcess {
  pid: number;
  parent: number;
  started: number;
}

/** Pure identity filtering, shared by cleanup and PID-reuse regression tests. */
export function selectWindowsDescendants(
  rows: WindowsProcess[],
  leader: {
    pid: number;
    startedAt: number;
    exitedAt?: number;
    hasExited: boolean;
  },
  known: Map<number, number>,
): WindowsProcess[] {
  const currentLeader = rows.find((row) => row.pid === leader.pid);
  if (currentLeader && leader.hasExited)
    throw new CleanupFailure(
      leader.exitedAt !== undefined &&
      Number.isFinite(currentLeader.started) &&
      currentLeader.started > leader.exitedAt
        ? "windows-leader-pid-reused-after-exit"
        : "windows-exited-leader-pid-observed",
      "The worker PID is no longer uniquely identified.",
    );
  if (
    currentLeader &&
    (!Number.isFinite(currentLeader.started) ||
      currentLeader.started < leader.startedAt)
  )
    throw new CleanupFailure(
      "windows-identity-ambiguous",
      "The worker PID is no longer uniquely identified.",
    );
  if (currentLeader) known.set(leader.pid, currentLeader.started);
  const discovered = new Map<number, WindowsProcess>();
  if (currentLeader) discovered.set(leader.pid, currentLeader);
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of rows) {
      if (row.pid === leader.pid || discovered.has(row.pid)) continue;
      const parentStart = known.get(row.parent);
      if (parentStart === undefined) continue;
      if (!Number.isFinite(row.started))
        throw new CleanupFailure(
          "windows-identity-ambiguous",
          "Unknown descendant identity.",
        );
      // No multi-second tolerance: a process older than the owned parent's
      // recorded spawn cannot be attributed to it through a historical PPID.
      if (row.started < parentStart) continue;
      if (
        row.parent === leader.pid &&
        leader.exitedAt !== undefined &&
        row.started > leader.exitedAt
      )
        continue;
      const previouslyKnown = known.get(row.pid);
      if (
        previouslyKnown === undefined &&
        row.parent !== leader.pid &&
        !rows.some(
          (parent) =>
            parent.pid === row.parent && parent.started === parentStart,
        )
      )
        throw new CleanupFailure(
          "windows-identity-ambiguous",
          "A historical descendant parent can no longer be uniquely identified.",
        );
      if (previouslyKnown !== undefined && previouslyKnown !== row.started)
        throw new CleanupFailure(
          "windows-identity-ambiguous",
          "A descendant PID was reused.",
        );
      discovered.set(row.pid, row);
      known.set(row.pid, row.started);
      changed = true;
    }
  }
  for (const row of rows) {
    const start = known.get(row.pid);
    if (row.pid !== leader.pid && start !== undefined) {
      if (row.started !== start)
        throw new CleanupFailure(
          "windows-identity-ambiguous",
          "A descendant PID was reused.",
        );
      discovered.set(row.pid, row);
    }
  }
  return [...discovered.values()];
}

async function windowsProcessTable(timeout: number): Promise<WindowsProcess[]> {
  // Fixed OS command, no profile scripts and no model/repository text. Only
  // process identity metadata is inspected, never command lines or env vars.
  const command =
    "$ErrorActionPreference='Stop'; @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process' | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; started=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) } }) | ConvertTo-Json -Compress";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout,
        maxBuffer: 2_097_152,
      },
    ));
  } catch (error) {
    throw new CleanupFailure(classifyWindowsInventoryFailure(error));
  }
  return parseWindowsProcessTable(stdout);
}

/**
 * A cold/concurrent CIM query can time out once even when the next succeeds.
 * Retry only that transient category, once, inside the original deadline.
 * Reader/clock injection keeps the timing contract deterministic in tests.
 */
export async function readWindowsInventory(
  deadline: number,
  read: (timeout: number) => Promise<WindowsProcess[]> = windowsProcessTable,
  now: () => number = Date.now,
): Promise<WindowsProcess[]> {
  for (let attempt = 0; ; attempt += 1) {
    const timeout = windowsInventoryTimeout(deadline, now());
    if (!timeout) throw new CleanupFailure("windows-cleanup-deadline");
    try {
      const rows = await read(timeout);
      if (now() >= deadline)
        throw new CleanupFailure("windows-cleanup-deadline");
      return rows;
    } catch (error) {
      if (
        attempt === 0 &&
        error instanceof CleanupFailure &&
        error.code === "windows-inventory-timeout"
      )
        continue;
      throw error;
    }
  }
}

export function parseWindowsProcessTable(stdout: string): WindowsProcess[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  } catch {
    throw new CleanupFailure("windows-inventory-invalid");
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (!rows.length || rows.length > 50_000)
    throw new CleanupFailure("windows-inventory-invalid");
  return rows.map((value: unknown) => {
    if (!value || typeof value !== "object")
      throw new CleanupFailure("windows-inventory-invalid");
    const row = value as Record<string, unknown>;
    if (
      !Number.isInteger(row.pid) ||
      !Number.isInteger(row.parent) ||
      Number(row.pid) < 0 ||
      Number(row.parent) < 0 ||
      typeof row.started !== "string"
    )
      throw new CleanupFailure("windows-inventory-invalid");
    return {
      pid: Number(row.pid),
      parent: Number(row.parent),
      started: Date.parse(row.started),
    };
  });
}

async function terminateWindowsTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid!;
  const lifetime = ownedProcesses.get(child);
  if (!lifetime) throw new CleanupFailure("worker-lifetime-unavailable");
  const deadline = Date.now() + 8_000;
  const timeLeft = () => {
    const remaining = windowsInventoryTimeout(deadline);
    if (!remaining) throw new CleanupFailure("windows-cleanup-deadline");
    return remaining;
  };
  const kill = async (target: number) => {
    try {
      await execFileAsync(
        path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(target), "/T", "/F"],
        {
          shell: false,
          windowsHide: true,
          timeout: Math.min(3_000, timeLeft()),
          maxBuffer: 65_536,
        },
      );
    } catch {
      /* A parent can exit before taskkill observes it. Inspect below. */
    }
  };
  // Kill while the leader still exists, so taskkill can follow its live tree.
  if (child.exitCode === null && child.signalCode === null) await kill(pid);
  const known = new Map<number, number>([[pid, lifetime.startedAt]]);
  while (Date.now() < deadline) {
    const rows = await readWindowsInventory(deadline);
    if (Date.now() >= deadline)
      throw new CleanupFailure("windows-cleanup-deadline");
    const discovered = selectWindowsDescendants(
      rows,
      {
        pid,
        ...lifetime,
        hasExited:
          child.exitCode !== null ||
          child.signalCode !== null ||
          lifetime.exitedAt !== undefined,
      },
      known,
    );
    if (!discovered.length) return true;
    if (discovered.length > 256)
      throw new CleanupFailure("windows-process-limit");
    const targets = discovered.map((row) => row.pid);
    for (
      let offset = 0;
      offset < targets.length && Date.now() < deadline;
      offset += 8
    )
      await Promise.all(targets.slice(offset, offset + 8).map(kill));
  }
  throw new CleanupFailure("windows-cleanup-deadline");
}

/**
 * Resolves only after owned process-group/tree cleanup, never at leader close.
 * This is lifecycle management, not a sandbox: deliberately detached POSIX
 * processes and Windows ancestry already lost through exited intermediates
 * require stronger OS containment (for example a Windows Job Object).
 */
export function terminateTree(child: ChildProcess): Promise<boolean> {
  const existing = terminationTasks.get(child);
  if (existing) return existing;
  const task = (
    !child.pid
      ? Promise.resolve(true)
      : process.platform === "win32"
        ? terminateWindowsTree(child)
        : terminatePosixGroup(child.pid)
  )
    .then((confirmed) => {
      if (!confirmed)
        terminationFailures.set(child, "posix-cleanup-unconfirmed");
      return confirmed;
    })
    .catch((error: unknown) => {
      terminationFailures.set(
        child,
        error instanceof CleanupFailure
          ? error.code
          : "unexpected-cleanup-error",
      );
      return false;
    });
  terminationTasks.set(child, task);
  return task;
}

export function disconnectChild(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

/** Metadata-only probe. Output is not logged or persisted; there are no model requests here. */
export async function captureCommand(
  executable: Executable,
  args: string[],
  cwd: string,
  maximum = 128_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(executable.command, [...executable.prefix, ...args], {
      cwd,
      env: { ...process.env, ...executable.env, NO_COLOR: "1" },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackOwnedProcess(child, startedAt);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure = "";
    let settled = false;
    let finishing = false;
    let termination: Promise<boolean> | undefined;
    let drain: NodeJS.Timeout | undefined;
    const finish = async (
      code: number | null,
      unconfirmed = false,
      spawnError = false,
    ) => {
      if (settled || finishing) return;
      finishing = true;
      clearTimeout(timeout);
      clearTimeout(drain);
      unconfirmed ||= !(await (termination ??= terminateTree(child)));
      settled = true;
      if (unconfirmed)
        reject(
          new Error(
            `${failure ? `${failure} ` : ""}CLI descendant termination could not be confirmed; inspect running CLI processes. Cleanup diagnostic: ${terminationDiagnostic(child)}.`,
          ),
        );
      else if (failure || spawnError || code !== 0)
        reject(
          new Error(
            failure ||
              (spawnError
                ? "The CLI could not be started. Check its executable path."
                : "CLI metadata probe failed. Run the official CLI in a terminal to diagnose installation."),
          ),
        );
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const stop = () => {
      if (termination || settled || finishing) return;
      termination = terminateTree(child);
      void termination.then(() => {
        if (settled || finishing) return;
        drain = setTimeout(() => {
          if (settled || finishing) return;
          disconnectChild(child);
          void finish(child.exitCode, true);
        }, 1_500);
      });
    };
    const timeout = setTimeout(() => {
      failure = "CLI metadata probe timed out.";
      stop();
    }, 5_000);
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) {
        failure = "CLI metadata exceeds the safe size limit.";
        stop();
      } else chunks.push(chunk);
    };
    child.stdout.on("data", data);
    child.stderr.on("data", data);
    child.on("error", () => {
      void finish(null, false, true);
    });
    child.on("close", (code) => {
      void finish(code);
    });
  });
}

export async function probeProvider(
  provider: ProviderId,
  settings: Settings,
  cwd: string,
): Promise<ProviderStatus> {
  const name =
    provider === "claude"
      ? "Claude Code"
      : provider === "ollama"
        ? "Local · Ollama"
        : "Codex";
  try {
    const executable = await resolveExecutable(
      provider === "claude" ? settings.claudePath : settings.codexPath,
    );
    const version = (
      await captureCommand(executable, ["--version"], cwd, 8_192)
    )
      .trim()
      .slice(0, 160);
    const help = await captureCommand(
      executable,
      provider === "claude" ? ["--help"] : ["exec", "--help"],
      cwd,
    );
    const required =
      provider === "claude"
        ? [
            "--safe-mode",
            "--restricted",
            "--permission-prompts",
            "--output-format",
            "--tools",
          ]
        : ["--json", "--sandbox", "--ignore-user-config"];
    if (!required.every((flag) => help.includes(flag)))
      throw new Error(
        `Update ${provider === "claude" ? "Claude Code" : "Codex"}: this build lacks the safe noninteractive flags required by Nova Workbench.`,
      );
    if (provider === "ollama" && !settings.localModel)
      return {
        id: provider,
        name,
        available: false,
        version,
        detail:
          "Set the name of an already-installed Ollama model in Settings. No model is downloaded automatically.",
      };
    return {
      id: provider,
      name,
      available: true,
      version,
      detail:
        provider === "ollama"
          ? "Codex bridge ready; local Ollama server/model availability is checked only when you run."
          : "CLI detected. Authentication and account limits remain with the official CLI; no model call has been made.",
    };
  } catch (error) {
    return {
      id: provider,
      name,
      available: false,
      detail:
        error instanceof Error ? error.message : "Provider is unavailable.",
    };
  }
}

export function providerArguments(
  provider: ProviderId,
  cwd: string,
  mode: RunMode,
  model: string,
  options: { allowNonGit?: boolean } = {},
): string[] {
  if (provider === "claude") {
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--safe-mode",
      "--restricted",
      "--permission-prompts",
      "none",
      "--permission-mode",
      mode === "plan" ? "plan" : "acceptEdits",
      "--tools",
      mode === "plan" ? "Read,Grep,Glob" : "Read,Grep,Glob,Edit,Write",
      "--settings",
      JSON.stringify({ disableAllHooks: true }),
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
      "--disallowedTools",
      "mcp__*",
      ...(model ? ["--model", model] : []),
    ];
  }
  return [
    "exec",
    "--json",
    "--color",
    "never",
    "--sandbox",
    mode === "plan" ? "read-only" : "workspace-write",
    "--cd",
    cwd,
    // This only relaxes exec's repository-presence check for explicit folder
    // Plan tasks. Sandbox/approval restrictions remain unchanged.
    ...(options.allowNonGit && mode === "plan"
      ? ["--skip-git-repo-check"]
      : []),
    "--ignore-user-config",
    "--config",
    'approval_policy="never"',
    "--config",
    'approvals_reviewer="user"',
    "--config",
    "features.hooks=false",
    "--config",
    "notify=[]",
    "--config",
    "features.plugins=false",
    "--config",
    "features.apps=false",
    "--config",
    'web_search="disabled"',
    "--config",
    "agents.enabled=false",
    "--config",
    "features.multi_agent=false",
    "--config",
    "features.multi_agent_v2=false",
    ...(process.platform === "win32"
      ? ["--config", 'windows.sandbox="unelevated"']
      : []),
    // Deliberately do NOT use --oss: Codex's OSS readiness path pulls missing models.
    ...(provider === "ollama"
      ? [
          "--config",
          'model_provider="nova_ollama"',
          "--config",
          'model_providers.nova_ollama.name="Ollama (local)"',
          "--config",
          'model_providers.nova_ollama.base_url="http://127.0.0.1:11434/v1"',
          "--config",
          'model_providers.nova_ollama.wire_api="responses"',
          "--config",
          "model_providers.nova_ollama.requires_openai_auth=false",
        ]
      : []),
    ...(model ? ["--model", model] : []),
    "-",
  ];
}

/** Only consult the fixed loopback server. No remote fallback, key, or model pull. */
export async function assertLocalModelAvailable(model: string): Promise<void> {
  if (!model || /(?:[:/-]cloud)(?:$|[:/])/i.test(model))
    throw new Error(
      "Choose an already-installed local model, not an Ollama cloud model.",
    );
  let response: Response;
  try {
    response = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(4_000),
      redirect: "error",
    });
  } catch {
    throw new Error(
      "Local Ollama is not reachable at 127.0.0.1:11434. Start Ollama and install your chosen model before running.",
    );
  }
  if (!response.ok || !response.body)
    throw new Error("Ollama could not list its local models.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1_048_576)
        throw new Error("Ollama returned an oversized model list.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  let data: {
    models?: Array<{
      name?: string;
      remote_host?: unknown;
      remote_model?: unknown;
    }>;
  };
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Ollama returned an invalid model list.");
  }
  const selected = Array.isArray(data.models)
    ? data.models.find(
        (entry) => entry?.name === model || entry?.name === `${model}:latest`,
      )
    : undefined;
  if (!selected)
    throw new Error(
      `Model ${model} is not installed locally. Nova does not download models; install it in Ollama first.`,
    );
  if (selected.remote_host || selected.remote_model)
    throw new Error(
      "This Ollama model forwards to a remote provider. Choose a local model for Local mode.",
    );
}

export async function runProvider(options: {
  command: ProviderCommand;
  provider: ProviderId;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
  onEvent: (event: NormalizedEvent) => void;
}): Promise<ProcessResult> {
  if (options.signal.aborted) return { cancelled: true, completed: false };
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(
      options.command.command,
      [...options.command.prefix, ...options.command.args],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.command.env, NO_COLOR: "1" },
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    trackOwnedProcess(child, startedAt);
    const decoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let buffer = "";
    let bytes = 0;
    let completed = false;
    let failure: string | undefined;
    let settled = false;
    let finishing = false;
    let termination: Promise<boolean> | undefined;
    let stderr = "";
    let drain: NodeJS.Timeout | undefined;
    const stop = () => {
      if (termination || settled || finishing) return;
      termination = terminateTree(child);
      void termination.then(() => {
        if (settled || finishing) return;
        drain = setTimeout(() => {
          if (settled || finishing) return;
          disconnectChild(child);
          void finish(null, false, true);
        }, 1_500);
      });
    };
    const fail = (message: string) => {
      failure ??= message;
      stop();
    };
    const emitLine = (line: string) => {
      if (!line.trim()) return;
      const event = normalizeProviderLine(options.provider, line);
      if (event.failed) failure ??= event.failed.slice(0, 4_000);
      if (event.completed) completed = true;
      options.onEvent(event);
    };
    const consume = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        fail(
          "Agent output exceeded this run's configured limit. The process was stopped; the worktree is preserved.",
        );
        return;
      }
      buffer += decoder.write(chunk);
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        emitLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > options.maxBytes)
        fail("Agent emitted an oversized JSON event.");
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        fail("Agent output exceeded this run's configured limit.");
        return;
      }
      stderr = (stderr + stderrDecoder.write(chunk)).slice(-8_000);
    });
    const abort = () => {
      stop();
    };
    options.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        fail(
          "Run timed out. The worker was stopped and its worktree was preserved.",
        ),
      options.timeoutMs,
    );
    const finish = async (
      code: number | null,
      spawnError = false,
      terminationUnconfirmed = false,
    ) => {
      if (settled || finishing) return;
      finishing = true;
      clearTimeout(timer);
      clearTimeout(drain);
      terminationUnconfirmed ||= !(await (termination ??=
        terminateTree(child)));
      settled = true;
      options.signal.removeEventListener("abort", abort);
      buffer += decoder.end();
      if (buffer && bytes <= options.maxBytes) emitLine(buffer);
      const cancelled = options.signal.aborted && !terminationUnconfirmed;
      const error = terminationUnconfirmed
        ? `Worker termination could not be confirmed. Nova disconnected its output after a bounded wait. Inspect and stop any remaining CLI processes before using this project again. Cleanup diagnostic: ${terminationDiagnostic(child)}.`
        : cancelled
          ? undefined
          : failure ||
            (spawnError
              ? "Could not launch the selected CLI. Check Settings and run the CLI in a terminal first."
              : code !== 0
                ? `CLI exited with code ${String(code)}.${stderr.trim() ? `\n${stderr.trim()}` : ""}`
                : !completed
                  ? "CLI exited without a successful terminal event. Its output format may not be compatible; no success was assumed."
                  : undefined);
      resolve({
        cancelled,
        completed: !error && !cancelled && completed,
        error,
        terminationUnconfirmed: terminationUnconfirmed || undefined,
      });
    };
    child.on("error", () => {
      void finish(null, true);
    });
    child.on("close", (code) => {
      void finish(code);
    });
    child.stdin.on("error", () => {
      /* closed stdin is handled by the child exit/result */
    });
    child.stdin.end(options.prompt);
    if (options.signal.aborted) abort();
  });
}
