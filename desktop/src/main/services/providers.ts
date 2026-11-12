import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
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

async function terminateTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "taskkill.exe",
      ),
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, shell: false, stdio: "ignore" },
    );
    await new Promise<void>((resolve) => {
      killer.once("error", () => {
        child.kill();
        resolve();
      });
      killer.once("close", () => resolve());
    });
    return;
  }
  // A leader can exit while its descendants still hold the inherited pipes.
  // The detached POSIX group remains addressable even after that leader exits.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 600);
  timer.unref();
  // Parent close alone is not proof that all descendants obeyed SIGTERM.
}

function disconnectChild(child: ChildProcess): void {
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
    const child = spawn(executable.command, [...executable.prefix, ...args], {
      cwd,
      env: { ...process.env, ...executable.env, NO_COLOR: "1" },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure = "";
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const stop = () => {
      if (drain || settled) return;
      void terminateTree(child);
      drain = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        disconnectChild(child);
        reject(
          new Error(
            `${failure} CLI descendant termination could not be confirmed; inspect running CLI processes.`,
          ),
        );
      }, 1_500);
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
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(drain);
      reject(
        new Error("The CLI could not be started. Check its executable path."),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(drain);
      if (failure || code !== 0)
        reject(
          new Error(
            failure ||
              "CLI metadata probe failed. Run the official CLI in a terminal to diagnose installation.",
          ),
        );
      else resolve(Buffer.concat(chunks).toString("utf8"));
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
    const decoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let buffer = "";
    let bytes = 0;
    let completed = false;
    let failure: string | undefined;
    let settled = false;
    let stderr = "";
    let drain: NodeJS.Timeout | undefined;
    const stop = () => {
      if (drain || settled) return;
      void terminateTree(child);
      drain = setTimeout(() => {
        if (settled) return;
        disconnectChild(child);
        finish(null, false, true);
      }, 1_500);
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
    const finish = (
      code: number | null,
      spawnError = false,
      terminationUnconfirmed = false,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      options.signal.removeEventListener("abort", abort);
      buffer += decoder.end();
      if (buffer && bytes <= options.maxBytes) emitLine(buffer);
      const cancelled = options.signal.aborted && !terminationUnconfirmed;
      const error = terminationUnconfirmed
        ? "Worker termination could not be confirmed. Nova disconnected its output after a bounded wait. Inspect and stop any remaining CLI processes before using this project again."
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
    child.on("error", () => finish(null, true));
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {
      /* closed stdin is handled by the child exit/result */
    });
    child.stdin.end(options.prompt);
    if (options.signal.aborted) abort();
  });
}
