import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CodexHistoryPage,
  CodexHistoryQuery,
  CodexThreadPage,
  CodexThreadQuery,
  CodexThreadSummary,
  ImportedMessage,
} from "../../shared/compatibility";
import { APP_VERSION, type RunMode, type Settings } from "../../shared/types";
import { classifyCodexStartupFailure, isUnknownUserCodexSetting } from "./codex-startup-diagnostics";
import type { NormalizedEvent } from "./provider-events";
import {
  disconnectChild,
  resolveExecutable,
  terminateTree,
  terminationDiagnostic,
  trackOwnedProcess,
  type Executable,
  type ProcessResult,
} from "./providers";

type JsonObject = Record<string, unknown>;
const META_BYTES = 8 * 1_048_576;
const LINE_BYTES = 2 * 1_048_576;
const REQUEST_TIMEOUT = 20_000;
const HISTORY_BYTES = 256 * 1_024;
const HISTORY_MESSAGES = 400;
const HISTORY_TEXT = 16_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface CodexServerOptions {
  settings: Settings;
  home: string;
  cwd: string;
  signal?: AbortSignal;
}

/** Errors never carry native config, stderr, authentication or RPC error data. */
export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly terminationUnconfirmed = false,
    readonly unknownUserSetting = false,
  ) {
    super(message);
    this.name = "CodexAppServerError";
  }
}

const invalid = (field = "response") =>
  new CodexAppServerError(
    `Installed Codex returned an invalid ${field}. Update Codex if its app-server protocol is incompatible.`,
  );

function record(value: unknown, field?: string): JsonObject {
  if (!isObject(value)) throw invalid(field);
  return value;
}

function boundedString(
  value: unknown,
  max: number,
  field: string,
  empty = false,
): string {
  if (
    typeof value !== "string" ||
    (!empty && !value) ||
    value.length > max ||
    value.includes("\0")
  )
    throw invalid(field);
  return value;
}

function cursor(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return boundedString(value, 4_096, "history cursor");
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new CodexAppServerError("Codex operation was cancelled.");
}

/**
 * These are ordinary supported config overrides, not requirement bypasses.
 * There is no app-server --ignore-user-config flag. In particular, an empty
 * mcp_servers table does NOT clear inherited servers: TOML tables deep-merge.
 * MCP names are inspected internally and disabled individually before loading
 * a thread. Existing memory content remains available; background generation
 * and goal continuation are disabled for this worker.
 */
const WORKER_CONFIG: JsonObject = {
  "approval_policy": "never",
  "approvals_reviewer": "user",
  "sandbox_mode": "read-only",
  "features.hooks": false,
  "notify": [],
  "features.plugins": false,
  "features.apps": false,
  "features.tool_suggest": false,
  "features.recommended_plugins": false,
  "features.skill_mcp_dependency_install": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.wake_on_agent_messages": false,
  "features.goals": false,
  "agents.enabled": false,
  "memories.generate_memories": false,
  "cloud.skills.enabled": false,
  "web_search": "disabled",
  "sandbox_workspace_write.network_access": false,
  "sandbox_workspace_write.writable_roots": [],
  "sandbox_workspace_write.exclude_tmpdir_env_var": true,
  "sandbox_workspace_write.exclude_slash_tmp": true,
};

function toml(value: unknown): string {
  // The fixed startup values above are booleans, strings or empty arrays.
  return JSON.stringify(value);
}

export function codexAppServerArguments(platform = process.platform, strictConfig = true): string[] {
  return [
    "app-server",
    "--stdio",
    ...(strictConfig ? ["--strict-config"] : []),
    ...Object.entries(WORKER_CONFIG).flatMap(([key, value]) => [
      "--config",
      `${key}=${toml(value)}`,
    ]),
    ...(platform === "win32"
      ? ["--config", 'windows.sandbox="unelevated"']
      : []),
  ];
}

const CLIENT_INFO = {
  name: "nova_workbench",
  title: "Nova Workbench",
  version: APP_VERSION,
};

function validateStartupRequirements(value: unknown): void {
  const result = record(value, "startup requirements");
  if (Object.hasOwn(result, "error"))
    throw new CodexAppServerError(
      "Installed Codex could not validate its startup requirements. Native connection was not started; no fallback was attempted.",
    );
  boundedString(result.appServerVersion, 256, "app-server version");
  const response = record(result.configRequirements, "startup requirements");
  if (response.requirements === null) return;
  const requirements = record(response.requirements, "startup requirements");
  const features = requirements.featureRequirements;
  if (features !== null && !isObject(features))
    throw invalid("managed feature requirements");
  if (features && Object.keys(features).length > 512)
    throw invalid("managed feature requirements");
  const disabledFeatures = new Set(
    Object.entries(WORKER_CONFIG)
      .filter(([key, value]) => key.startsWith("features.") && value === false)
      .map(([key]) => key.slice("features.".length)),
  );
  // Managed policy can use legacy aliases. They map to the same features in
  // codex-rs/features/src/legacy.rs and must not slip through this check.
  const aliases: Record<string, string> = {
    connectors: "apps",
    collab: "multi_agent",
    codex_hooks: "hooks",
  };
  for (const [name, enabled] of Object.entries(features ?? {})) {
    if (typeof enabled !== "boolean")
      throw invalid("managed feature requirements");
    if (enabled && disabledFeatures.has(aliases[name] ?? name))
      throw new CodexAppServerError(
        "Managed Codex policy requires a feature that this restricted native worker must disable. Native startup was refused; Nova does not override managed requirements.",
      );
  }
  for (const [field, expected] of [
    ["allowedApprovalPolicies", "never"],
    ["allowedSandboxModes", "read-only"],
    ["allowedWebSearchModes", "disabled"],
  ] as const) {
    const allowed = requirements[field];
    if (
      allowed !== null &&
      allowed !== undefined &&
      (!Array.isArray(allowed) || !allowed.includes(expected))
    )
      throw new CodexAppServerError(
        "Managed Codex policy does not allow Nova's restricted startup policy. Native connection was refused without changing the policy.",
      );
  }
}

/**
 * Supported one-shot discovery runs before app-server's plugin/environment
 * initialization. Ordinary config overrides alone are insufficient: managed
 * feature requirements may otherwise silently re-enable plugins or hooks.
 * No raw requirement data, diagnostic text or credentials leave this function.
 */
async function preflight(
  executable: Executable,
  options: CodexServerOptions,
  strictConfig = true,
): Promise<void> {
  checkAbort(options.signal);
  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(
      executable.command,
      [
        ...executable.prefix,
        ...codexAppServerArguments(process.platform, strictConfig).filter((arg) => arg !== "--stdio"),
        "--print-startup-config",
        "--startup-client-info",
        JSON.stringify(CLIENT_INFO),
      ],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...executable.env,
          CODEX_HOME: options.home,
          CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
          NO_COLOR: "1",
        },
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    trackOwnedProcess(child, startedAt);
    const chunks: Buffer[] = [];
    const diagnosticChunks: Buffer[] = [];
    let bytes = 0;
    let stderrBytes = 0;
    let failure: CodexAppServerError | undefined;
    let closeSeen = false;
    let exitCode: number | null = null;
    let finishing = false;
    let termination: Promise<boolean> | undefined;
    let drain: NodeJS.Timeout | undefined;
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      options.signal?.removeEventListener("abort", abort);
      const confirmed = await (termination ??= terminateTree(child));
      disconnectChild(child);
      if (!confirmed || !closeSeen) {
        reject(
          new CodexAppServerError(
            `Codex startup preflight termination could not be confirmed. Cleanup diagnostic: ${terminationDiagnostic(child)}. Inspect native Codex processes before continuing.`,
            true,
          ),
        );
        return;
      }
      if (failure) {
        reject(failure);
        return;
      }
      try {
        // Upstream emits a structured JSON error AND a nonzero exit code for
        // config/auth/policy failures. Inspect that envelope before deciding
        // that a CLI option is unsupported; never expose its raw diagnostics.
        let startup: unknown;
        try {
          startup = JSON.parse(
            new TextDecoder("utf-8", { fatal: true })
              .decode(Buffer.concat(chunks))
              .replace(/^\uFEFF/, ""),
          );
        } catch {
          if (exitCode === 0) throw invalid("startup requirements");
        }
        if (exitCode !== 0 || (isObject(startup) && Object.hasOwn(startup, "error")))
          throw new CodexAppServerError(
            classifyCodexStartupFailure(
              startup,
              Buffer.concat(diagnosticChunks).toString("utf8"),
              exitCode,
            ),
            false,
            isUnknownUserCodexSetting(startup),
          );
        validateStartupRequirements(startup);
        resolve();
      } catch (error) {
        reject(
          error instanceof CodexAppServerError
            ? error
            : invalid("startup requirements"),
        );
      }
    };
    const stop = (message: string) => {
      failure ??= new CodexAppServerError(message);
      if (!termination) {
        termination = terminateTree(child);
        void termination.then(() => {
          if (!finishing) drain = setTimeout(() => void finish(), 1_500);
        });
      }
    };
    const abort = () => stop("Codex startup preflight was cancelled.");
    const timer = setTimeout(
      () => stop("Codex startup preflight exceeded its time limit."),
      REQUEST_TIMEOUT,
    );
    child.once("error", () => stop("Could not start Codex startup discovery."));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 512 * 1_024)
        stop(
          "Codex startup requirements exceeded the bounded operation limit.",
        );
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 128 * 1_024)
        stop("Codex startup diagnostics exceeded the bounded operation limit.");
      else if (!failure) diagnosticChunks.push(chunk);
    });
    child.once("close", (code) => {
      exitCode = code;
      closeSeen = true;
      void finish();
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

/**
 * Strict parsing of the user's OEM config can reject keys the installed CLI
 * harmlessly ignores. Before retrying without strict parsing, prove that the
 * selected binary recognizes every restriction Nova applies to its worker.
 * This temporary home contains no credentials, sessions, plugins or user config.
 */
async function validateWorkerOverridesInIsolation(
  executable: Executable,
  options: CodexServerOptions,
): Promise<void> {
  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "nova-codex-config-check-"));
  try {
    await preflight(executable, { ...options, home: isolatedHome, cwd: isolatedHome }, true);
  } finally {
    try {
      await rm(isolatedHome, { recursive: true, force: true });
    } catch {
      throw new CodexAppServerError(
        "Nova could not clean up its isolated Codex configuration check. Native connection was not started.",
      );
    }
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Bounded JSON-lines transport. It never invokes a shell or accepts a server tool request. */
export class CodexStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly closed: Promise<void>;
  private nextId = 1;
  private buffer = "";
  private totalBytes = 0;
  private stderrBytes = 0;
  private outputLimit: number;
  private closing = false;
  private closeTask?: Promise<boolean>;
  private closeSeen = false;
  private failure?: CodexAppServerError;
  private abortHandler?: () => void;
  onNotification?: (method: string, params: unknown) => void;
  onFailure?: (error: CodexAppServerError) => void;

  constructor(
    executable: Executable,
    private readonly options: {
      home: string;
      cwd: string;
      signal?: AbortSignal;
      maxBytes?: number;
      strictConfig?: boolean;
    },
  ) {
    checkAbort(options.signal);
    this.outputLimit = options.maxBytes ?? META_BYTES;
    const startedAt = Date.now();
    this.child = spawn(
      executable.command,
      [...executable.prefix, ...codexAppServerArguments(process.platform, options.strictConfig ?? true)],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...executable.env,
          CODEX_HOME: options.home,
          CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
          NO_COLOR: "1",
        },
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    trackOwnedProcess(this.child, startedAt);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    this.closed = new Promise<void>((resolve) => {
      this.child.once("close", () => {
        this.closeSeen = true;
        if (!this.closing)
          this.fail("Codex app-server exited before the operation completed.");
        resolve();
      });
    });
    this.child.once("error", () =>
      this.fail("Could not start the configured Codex app-server."),
    );
    this.child.stdin.on("error", () => {
      if (!this.closing)
        this.fail("Codex app-server input closed unexpectedly.");
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.closing) return;
      this.totalBytes += chunk.length;
      if (this.totalBytes > this.outputLimit) {
        this.fail(
          "Codex app-server output exceeded the bounded operation limit.",
        );
        return;
      }
      try {
        this.buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while (!this.closing && (newline = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > LINE_BYTES)
            throw invalid("oversized RPC message");
          if (line.trim()) this.consume(line);
        }
        if (Buffer.byteLength(this.buffer) > LINE_BYTES)
          throw invalid("oversized RPC message");
      } catch (error) {
        this.fail(
          error instanceof CodexAppServerError
            ? error.message
            : "Codex app-server emitted invalid JSON or UTF-8.",
        );
      }
    });
    this.child.stdout.on("end", () => {
      if (this.closing) return;
      try {
        this.buffer += decoder.decode();
        if (this.buffer.trim()) this.consume(this.buffer);
        this.buffer = "";
      } catch {
        this.fail("Codex app-server emitted an incomplete RPC message.");
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      // Do not retain or return stderr: upstream diagnostics can contain config.
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 128 * 1_024)
        this.fail(
          "Codex app-server diagnostics exceeded the bounded operation limit.",
        );
    });
    if (options.signal) {
      this.abortHandler = () => this.fail("Codex operation was cancelled.");
      options.signal.addEventListener("abort", this.abortHandler, {
        once: true,
      });
      if (options.signal.aborted) this.abortHandler();
    }
  }

  get error(): CodexAppServerError | undefined {
    return this.failure;
  }

  detachAbortSignal(): void {
    if (this.abortHandler)
      this.options.signal?.removeEventListener("abort", this.abortHandler);
    this.abortHandler = undefined;
  }

  /** Begin a separately bounded native turn after bounded metadata/config RPCs. */
  resetOutputLimit(maxBytes: number): void {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 64 * 1_048_576
    )
      throw invalid("output limit");
    this.totalBytes = 0;
    this.outputLimit = maxBytes;
  }

  private consume(line: string): void {
    const message = record(JSON.parse(line));
    if (message.jsonrpc !== undefined && message.jsonrpc !== "2.0")
      throw invalid("RPC version");
    if (typeof message.method === "string") {
      boundedString(message.method, 200, "RPC method");
      if (Object.hasOwn(message, "id")) {
        if (
          !(
            (typeof message.id === "number" &&
              Number.isSafeInteger(message.id)) ||
            (typeof message.id === "string" && message.id.length <= 256)
          )
        )
          throw invalid("server request ID");
        // Includes approvals, user input, dynamic tools and token refresh. We
        // never hand out credentials or invent a human approval.
        this.send({
          id: message.id,
          error: {
            code: -32601,
            message:
              "Nova denies server-initiated tools, approvals and credential requests.",
          },
        });
        return;
      }
      this.onNotification?.(message.method, message.params);
      return;
    }
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id))
      throw invalid("RPC response ID");
    const pending = this.pending.get(message.id);
    if (!pending) throw invalid("unexpected RPC response ID");
    if (Object.hasOwn(message, "error")) {
      const error = record(message.error, "RPC error");
      if (Object.hasOwn(message, "result"))
        throw invalid("ambiguous RPC response");
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const code =
        typeof error.code === "number" && Number.isSafeInteger(error.code)
          ? ` (${error.code})`
          : "";
      pending.reject(
        new CodexAppServerError(
          `Installed Codex rejected an app-server request${code}. Its protocol or configured policy may not support this operation; no fallback was attempted.`,
        ),
      );
    } else if (Object.hasOwn(message, "result")) {
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message.result);
    } else {
      pending.reject(invalid("RPC result"));
      throw invalid("RPC result");
    }
  }

  private send(value: JsonObject): void {
    if (this.failure) throw this.failure;
    if (this.closing)
      throw new CodexAppServerError("Codex app-server is closed.");
    const wire = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(wire) > LINE_BYTES)
      throw invalid("oversized RPC request");
    if (this.child.stdin.writableLength > LINE_BYTES)
      throw invalid("RPC input backlog");
    this.child.stdin.write(wire);
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT,
  ): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing)
      return Promise.reject(
        new CodexAppServerError("Codex app-server is closed."),
      );
    if (this.pending.size >= 32)
      return Promise.reject(invalid("RPC concurrency"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail("Codex app-server request exceeded its time limit."),
        Math.max(1, Math.min(timeoutMs, 120_000)),
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async initialize(): Promise<void> {
    record(
      await this.request("initialize", {
        clientInfo: CLIENT_INFO,
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          explicitGatewayOauth: true,
        },
      }),
      "initialize response",
    );
    this.send({ method: "initialized", params: {} });
  }

  fail(message: string): void {
    if (this.failure || this.closing) return;
    this.failure = new CodexAppServerError(message);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
    this.onFailure?.(this.failure);
    void this.close();
  }

  close(): Promise<boolean> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.detachAbortSignal();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        this.failure ?? new CodexAppServerError("Codex app-server was closed."),
      );
    }
    this.pending.clear();
    this.child.stdin.end();
    this.closeTask = (async () => {
      // EOF lets the engine flush ordinary state. It is not proof that children
      // have stopped: always await the shared owned-process cleanup afterwards.
      await Promise.race([this.closed, sleep(150)]);
      const confirmed = await terminateTree(this.child);
      await Promise.race([this.closed, sleep(1_500)]);
      const clean = confirmed && this.closeSeen;
      disconnectChild(this.child);
      if (!clean)
        this.failure = new CodexAppServerError(
          `Codex app-server termination could not be confirmed. Cleanup diagnostic: ${terminationDiagnostic(this.child)}. Inspect native Codex processes before continuing.`,
          true,
        );
      return clean;
    })();
    return this.closeTask;
  }
}

/** Owned, initialized transport for narrow official account operations as well as history. */
export async function connectCodexServer(options: CodexServerOptions): Promise<CodexStdioClient> {
  checkAbort(options.signal);
  const executable = await resolveExecutable(options.settings.codexPath);
  checkAbort(options.signal);
  let strictConfig = true;
  try {
    await preflight(executable, options);
  } catch (error) {
    if (!(error instanceof CodexAppServerError) || !error.unknownUserSetting)
      throw error;
    // Do not weaken the worker just because the OEM config has a newer key.
    // First confirm restrictions in a clean home, then recheck real managed
    // requirements under normal CLI parsing. Never touch the OEM config.
    await validateWorkerOverridesInIsolation(executable, options);
    await preflight(executable, options, false);
    strictConfig = false;
  }
  checkAbort(options.signal);
  const client = new CodexStdioClient(executable, { ...options, strictConfig });
  try {
    await client.initialize();
    return client;
  } catch (error) {
    if (!(await client.close())) throw client.error;
    throw error;
  }
}

async function withClient<T>(
  options: CodexServerOptions,
  work: (client: CodexStdioClient) => Promise<T>,
): Promise<T> {
  const client = await connectCodexServer(options);
  let result: T;
  try {
    result = await work(client);
    checkAbort(options.signal);
  } finally {
    if (!(await client.close())) throw client.error;
  }
  checkAbort(options.signal);
  return result;
}

function timestamp(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw invalid("thread timestamp");
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.getTime())) throw invalid("thread timestamp");
  return date.toISOString();
}

function threadSummary(value: unknown, archived: boolean): CodexThreadSummary {
  const thread = record(value, "thread");
  const status = record(thread.status, "thread status");
  const source =
    typeof thread.source === "string"
      ? thread.source
      : isObject(thread.source)
        ? Object.keys(thread.source)[0]
        : "unknown";
  return {
    id: boundedString(thread.id, 256, "thread ID"),
    title:
      (typeof thread.name === "string" && thread.name
        ? thread.name
        : typeof thread.preview === "string"
          ? thread.preview
          : "Codex conversation"
      )
        .replace(/\0/g, "")
        .slice(0, 300) || "Codex conversation",
    cwd: boundedString(thread.cwd, 4_096, "thread directory"),
    modelProvider: boundedString(thread.modelProvider, 100, "model provider"),
    createdAt: timestamp(thread.createdAt),
    updatedAt: timestamp(thread.updatedAt),
    source: boundedString(source ?? "unknown", 100, "thread source"),
    status: boundedString(status.type, 100, "thread status"),
    archived,
  };
}

const STARTUP_WARNING =
  "The installed Codex engine manages its normal state during startup; history browsing does not request a model turn.";

export async function listCodexThreads(
  options: CodexServerOptions,
  query: CodexThreadQuery & { cwd?: string },
): Promise<CodexThreadPage> {
  return withClient(options, async (client) => {
    const result = record(
      await client.request("thread/list", {
        currentAccountOnly: true,
        limit: 50,
        sortKey: "updated_at",
        sortDirection: "desc",
        modelProviders: [],
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
        archived: query.archived === true,
        useStateDbOnly: true,
        ...(query.cwd ? { cwd: boundedString(query.cwd, 4_096, "thread directory filter") } : {}),
        ...(query.cursor
          ? { cursor: boundedString(query.cursor, 4_096, "history cursor") }
          : {}),
        ...(query.search
          ? { searchTerm: boundedString(query.search, 300, "history search") }
          : {}),
      }),
      "thread list",
    );
    if (!Array.isArray(result.data) || result.data.length > 50)
      throw invalid("thread list");
    return {
      threads: result.data.map((value) =>
        threadSummary(value, query.archived === true),
      ),
      nextCursor: cursor(result.nextCursor),
      warnings: [STARTUP_WARNING],
    };
  });
}

/** Direct thread/read is not account-scoped upstream; verify membership before exposing history. */
async function assertCurrentAccountThread(
  client: CodexStdioClient,
  thread: CodexThreadSummary,
  archived: boolean,
): Promise<void> {
  let next: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 8; page += 1) {
    const result = record(await client.request("thread/list", {
      currentAccountOnly: true, cwd: thread.cwd, archived,
      modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      limit: 50, sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true,
      ...(next ? { cursor: next } : {}),
    }), "account-scoped thread list");
    if (!Array.isArray(result.data) || result.data.length > 50) throw invalid("account-scoped thread list");
    if (result.data.some((entry) => record(entry, "thread").id === thread.id)) return;
    next = cursor(result.nextCursor);
    if (!next || seen.has(next)) break;
    seen.add(next);
  }
  throw new CodexAppServerError(
    "This conversation is not in the current account's bounded folder history. It may belong to a different account, have been archived, or need reopening in official Codex to refresh its index. No transcript or model turn was transferred.",
  );
}

export async function readCodexHistory(
  options: CodexServerOptions,
  query: CodexHistoryQuery,
): Promise<CodexHistoryPage> {
  const id = boundedString(query.threadId, 256, "thread ID");
  return withClient(options, async (client) => {
    const result = record(
      await client.request("thread/read", {
        threadId: id,
        includeTurns: false,
      }),
      "thread read",
    );
    const thread = threadSummary(result.thread, query.archived === true);
    if (thread.id !== id) throw invalid("mismatched thread ID");
    await assertCurrentAccountThread(client, thread, query.archived === true);
    const history = record(
      await client.request("thread/turns/list", {
        threadId: id,
        limit: 50,
        sortDirection: "desc",
        itemsView: "full",
        ...(query.cursor
          ? { cursor: boundedString(query.cursor, 4_096, "history cursor") }
          : {}),
      }),
      "turn history",
    );
    if (!Array.isArray(history.data) || history.data.length > 50)
      throw invalid("turn history");
    const nextCursor = cursor(history.nextCursor);
    const messages: ImportedMessage[] = [];
    const warnings = [STARTUP_WARNING];
    let bytes = 0;
    let truncated = false;
    let omittedAttachments = false;
    // Start with newest turns so bounded imports retain recent work. Return each
    // page in chronological order; a subsequent cursor page is prepended by UI.
    for (const value of history.data) {
      const turn = record(value, "turn");
      const turnId = boundedString(turn.id, 256, "turn ID");
      if (!Array.isArray(turn.items) || turn.items.length > 10_000)
        throw invalid("turn items");
      const turnMessages: ImportedMessage[] = [];
      for (const entry of [...turn.items].reverse()) {
        const item = record(entry, "thread item");
        if (item.type !== "userMessage" && item.type !== "agentMessage")
          continue;
        let text: string;
        if (item.type === "agentMessage") {
          if (typeof item.text !== "string") throw invalid("assistant message");
          text = item.text;
        } else {
          if (!Array.isArray(item.content) || item.content.length > 1_000)
            throw invalid("user message");
          text = item.content
            .flatMap((part) => {
              const input = record(part, "user content");
              if (input.type === "text" && typeof input.text === "string")
                return [input.text];
              omittedAttachments = true;
              return [];
            })
            .join("\n");
        }
        if (!text) continue;
        if (text.length > HISTORY_TEXT) {
          text = text.slice(0, HISTORY_TEXT);
          truncated = true;
        }
        const size = Buffer.byteLength(text);
        if (
          bytes + size > HISTORY_BYTES ||
          messages.length + turnMessages.length >= HISTORY_MESSAGES
        ) {
          truncated = true;
          continue;
        }
        bytes += size;
        turnMessages.unshift({
          id: boundedString(item.id, 256, "message ID"),
          turnId,
          role: item.type === "userMessage" ? "user" : "assistant",
          text,
        });
      }
      messages.unshift(...turnMessages);
    }
    if (truncated)
      warnings.push(
        "Some visible text was omitted or shortened by the per-page safety limits.",
      );
    if (omittedAttachments) {
      truncated = true;
      warnings.push(
        "Non-text attachments are not transferred. Only visible user and assistant text is shared with other providers.",
      );
    }
    if (nextCursor)
      warnings.push(
        "Older conversation pages remain available; this page is not the complete native history.",
      );
    return { thread, messages, nextCursor, truncated, warnings };
  });
}

function nativeConfig(value: unknown): JsonObject {
  const configuration = record(
    record(value, "effective configuration").config,
    "effective configuration",
  );
  const servers = configuration.mcp_servers;
  if (servers !== undefined && !isObject(servers))
    throw invalid("MCP configuration");
  const names = Object.keys(servers ?? {});
  if (names.length > 256)
    throw new CodexAppServerError(
      "Too many configured MCP servers to isolate this native worker safely.",
    );
  const disabled: JsonObject = Object.create(null) as JsonObject;
  for (const name of names) {
    if (!name || name.length > 200 || /[\0\r\n]/.test(name))
      throw invalid("MCP server name");
    // A nested table preserves literal names containing dots. Passing a dotted
    // path would address the wrong TOML key. No command/env/header is copied.
    disabled[name] = { enabled: false };
  }
  return { ...WORKER_CONFIG, mcp_servers: disabled };
}

async function sameDirectory(
  actual: unknown,
  expected: string,
): Promise<boolean> {
  if (typeof actual !== "string" || !path.isAbsolute(actual)) return false;
  try {
    const [a, b] = await Promise.all([realpath(actual), realpath(expected)]);
    return process.platform === "win32"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  } catch {
    return false;
  }
}

function sandbox(mode: RunMode, cwd: string): JsonObject {
  return mode === "plan"
    ? { type: "readOnly", networkAccess: false }
    : {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
}

async function validateNativeSession(
  response: JsonObject,
  options: Pick<NativeCodexOptions, "fork" | "threadId" | "mode" | "cwd">,
): Promise<string> {
  const thread = threadSummary(response.thread, false);
  if (
    (options.fork && thread.id === options.threadId) ||
    (!options.fork && thread.id !== options.threadId)
  )
    throw invalid("resumed/forked thread ID");
  if (response.modelProvider !== "openai" || thread.modelProvider !== "openai")
    throw new CodexAppServerError(
      "This native conversation uses a different provider. Select its matching provider or use a visible-history handoff; Nova did not fall back to a cloud model.",
    );
  if (
    !(await sameDirectory(response.cwd, options.cwd)) ||
    !(await sameDirectory(thread.cwd, options.cwd))
  )
    throw new CodexAppServerError(
      "Codex did not accept the requested working directory. No model turn was started.",
    );
  if (
    response.approvalPolicy !== "never" ||
    response.approvalsReviewer !== "user"
  )
    throw new CodexAppServerError(
      "Codex did not confirm Nova's no-escalation approval policy. No model turn was started.",
    );
  const effective = record(response.sandbox, "effective sandbox policy");
  if (
    effective.networkAccess !== false ||
    effective.type !== (options.mode === "plan" ? "readOnly" : "workspaceWrite")
  )
    throw new CodexAppServerError(
      "Codex did not confirm the requested restricted sandbox. No model turn was started.",
    );
  if (options.mode === "build") {
    if (
      !Array.isArray(effective.writableRoots) ||
      effective.writableRoots.length > 1 ||
      effective.excludeTmpdirEnvVar !== true ||
      effective.excludeSlashTmp !== true
    )
      throw new CodexAppServerError(
        "Codex returned unexpected writable roots. No model turn was started.",
      );
    for (const root of effective.writableRoots)
      if (!(await sameDirectory(root, options.cwd)))
        throw new CodexAppServerError(
          "Codex returned an unrelated writable root. No model turn was started.",
        );
  }
  return thread.id;
}

export interface NativeCodexOptions extends CodexServerOptions {
  mode: RunMode;
  model: string;
  threadId: string;
  fork: boolean;
  sourceArchived?: boolean;
  prompt: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  onEvent: (event: NormalizedEvent) => void;
  onThreadReady: (threadId: string) => Promise<void>;
}

export interface NativeHandoffOptions extends CodexServerOptions {
  title: string;
  text: string;
  sourceThreadId?: string;
  sourceArchived?: boolean;
  /** Persist the new engine ID before submitting context, so ambiguous failures remain inspectable. */
  onThreadCreated: (threadId: string) => Promise<void>;
}

/**
 * Publish a provider-neutral reference to a NEW native thread through the
 * installed engine. No turn/start, model request, credential copying or direct
 * rollout/database writes are involved. The original thread is never changed.
 */
export async function publishNativeHandoff(
  options: NativeHandoffOptions,
): Promise<{ nativeThreadId: string; warnings: string[] }> {
  const title = boundedString(options.title, 160, "handoff title");
  const text = boundedString(options.text, 100_000, "handoff context");
  if (Buffer.byteLength(text, "utf8") > 256 * 1_024)
    throw new CodexAppServerError("The shared context exceeds the native handoff limit. Shorten the context and try again.");
  if (!path.isAbsolute(options.cwd)) throw invalid("handoff directory");
  return withClient(options, async (client) => {
    if (options.sourceThreadId) {
      const source = record(await client.request("thread/read", {
        threadId: boundedString(options.sourceThreadId, 256, "handoff source ID"), includeTurns: false,
      }), "handoff source");
      const summary = threadSummary(source.thread, options.sourceArchived === true);
      if (summary.id !== options.sourceThreadId) throw invalid("handoff source ID");
      await assertCurrentAccountThread(client, summary, options.sourceArchived === true);
      if (summary.modelProvider !== "openai" || !["idle", "notLoaded"].includes(summary.status))
        throw new CodexAppServerError("The linked native conversation is active or uses a different provider. No handoff was created.");
    }
    const config = nativeConfig(await client.request("config/read", {
      includeLayers: false,
      cwd: options.cwd,
    }));
    const response = record(await client.request(options.sourceThreadId ? "thread/fork" : "thread/start", {
      ...(options.sourceThreadId ? { threadId: options.sourceThreadId, excludeTurns: true } : { ephemeral: false }),
      cwd: options.cwd,
      modelProvider: "openai",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      config,
    }), "new handoff thread");
    const nativeThreadId = await validateNativeSession(response, {
      cwd: options.cwd, mode: "plan", fork: true, threadId: options.sourceThreadId ?? "",
    });
    await options.onThreadCreated(nativeThreadId);
    checkAbort(options.signal);
    await client.request("thread/name/set", { threadId: nativeThreadId, name: title });
    await client.request("thread/inject_items", {
      threadId: nativeThreadId,
      items: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      }],
    });
    return {
      nativeThreadId,
      warnings: [
        options.sourceThreadId
          ? "A new native Codex fork retains its provider-owned history and the bounded shared handoff. No model turn was started; the original conversation was not rewritten."
          : "A new native Codex conversation contains the bounded visible-context handoff. No model turn was started; no existing conversation was rewritten.",
        "Codex persists injected context for subsequent model requests. Its desktop transcript presentation depends on the installed version; this is not a replica of Claude's native session or hidden reasoning.",
      ],
    };
  });
}

/** Native history stays with the official engine. No transcript is fabricated as native state. */
export async function runNativeCodex(
  options: NativeCodexOptions,
): Promise<ProcessResult> {
  if (options.signal.aborted) return { completed: false, cancelled: true };
  let client: CodexStdioClient | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let completed = false;
  let failure: string | undefined;
  let timedOut = false;
  let stopping = false;
  const deadlineController = new AbortController();
  const signal = AbortSignal.any([options.signal, deadlineController.signal]);
  let terminalResolve: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => {
    terminalResolve = resolve;
  });
  const timeout = setTimeout(
    () => {
      timedOut = true;
      failure = "Native Codex turn exceeded its configured time limit.";
      deadlineController.abort();
      terminalResolve?.();
    },
    Math.max(1, options.timeoutMs),
  );
  const emit = (event: NormalizedEvent) => options.onEvent(event);
  const abort = () => {
    if (stopping) return;
    stopping = true;
    failure ??= "Native Codex turn was cancelled.";
    if (client && threadId && turnId && !client.error) {
      void client
        .request("turn/interrupt", { threadId, turnId }, 1_000)
        .catch(() => undefined)
        .finally(() => {
          void client?.close();
          terminalResolve?.();
        });
    } else {
      void client?.close();
      terminalResolve?.();
    }
  };
  try {
    // Cancellation is routed here first to attempt turn/interrupt before EOF;
    // the transport still performs unconditional, awaited process cleanup.
    client = await connectCodexServer({ ...options, signal });
    client.detachAbortSignal();
    signal.addEventListener("abort", abort, { once: true });
    if (timedOut) throw new CodexAppServerError(failure!);
    checkAbort(signal);
    client.onFailure = (error) => {
      failure ??= error.message;
      terminalResolve?.();
    };
    const source = record(
      await client.request("thread/read", {
        threadId: boundedString(options.threadId, 256, "thread ID"),
        includeTurns: false,
      }),
      "native source thread",
    );
    const sourceThread = threadSummary(source.thread, false);
    if (sourceThread.id !== options.threadId) throw invalid("native source ID");
    await assertCurrentAccountThread(client, sourceThread, options.sourceArchived === true);
    if (sourceThread.status === "active")
      throw new CodexAppServerError(
        "This Codex conversation is active. Let its current turn finish before continuing it in Nova.",
      );
    if (!["idle", "notLoaded"].includes(sourceThread.status))
      throw new CodexAppServerError(
        "The native conversation is not in a resumable state. No model turn was started.",
      );
    if (sourceThread.modelProvider !== "openai")
      throw new CodexAppServerError(
        "This native conversation uses a different provider. Select its matching provider or use a visible-history handoff; no cloud fallback was attempted.",
      );
    if (!options.fork && !(await sameDirectory(sourceThread.cwd, options.cwd)))
      throw new CodexAppServerError(
        "The native conversation's current folder has changed. Nova did not repoint its session or start a turn; review the current source folder before continuing.",
      );
    checkAbort(signal);
    // Config is scoped to the exact target cwd. Only bounded MCP names are
    // retained; no raw config, environment values or credentials leave here.
    const config = nativeConfig(
      await client.request("config/read", {
        includeLayers: false,
        cwd: options.cwd,
      }),
    );
    config.sandbox_mode =
      options.mode === "plan" ? "read-only" : "workspace-write";
    checkAbort(signal);
    const session = record(
      await client.request(options.fork ? "thread/fork" : "thread/resume", {
        threadId: options.threadId,
        cwd: options.cwd,
        modelProvider: "openai",
        ...(options.model ? { model: options.model } : {}),
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: options.mode === "plan" ? "read-only" : "workspace-write",
        config,
        excludeTurns: true,
      }),
      "native session",
    );
    threadId = await validateNativeSession(session, options);
    await Promise.race([
      options.onThreadReady(threadId),
      terminal.then(() => {
        throw new CodexAppServerError(
          failure ??
            "Native Codex was stopped before its thread could be persisted.",
        );
      }),
    ]);
    checkAbort(signal);
    if (timedOut || client.error)
      throw client.error ?? new CodexAppServerError(failure!);
    emit({
      events: [
        {
          kind: "status",
          text: options.fork
            ? "Native Codex history forked for this workspace."
            : "Native Codex conversation resumed.",
        },
      ],
      sessionId: threadId,
    });
    client.resetOutputLimit(options.maxBytes);
    const seen = new Set<string>();
    const pendingNotifications: Array<[string, unknown]> = [];
    const handleNotification = (method: string, value: unknown) => {
      if (!isObject(value) || value.threadId !== threadId) return;
      if (!turnId) {
        if (pendingNotifications.length >= 2_000) {
          client!.fail(
            "Codex emitted too many events before acknowledging its turn.",
          );
          return;
        }
        pendingNotifications.push([method, value]);
        return;
      }
      if (method === "turn/completed") {
        const turn = record(value.turn, "completed turn");
        if (turn.id !== turnId) return;
        completed = turn.status === "completed";
        if (!completed)
          failure =
            turn.status === "interrupted"
              ? "Native Codex turn was interrupted."
              : "Native Codex reported a failed turn.";
        emit({
          events: [],
          completed,
          ...(failure ? { failed: failure } : {}),
        });
        terminalResolve?.();
      } else if (value.turnId === turnId && method === "item/completed") {
        const item = record(value.item, "completed item");
        const id = boundedString(item.id, 256, "item ID");
        if (seen.has(id)) return;
        seen.add(id);
        if (item.type === "agentMessage" && typeof item.text === "string")
          emit({ events: [{ kind: "message", text: item.text }] });
        else if (item.type === "commandExecution")
          emit({
            events: [
              {
                kind: "tool",
                text: `${typeof item.command === "string" ? item.command : "Command"}\n${typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : ""}`.trim(),
              },
            ],
          });
        else if (item.type === "fileChange")
          emit({
            events: [
              {
                kind: "tool",
                text: "Native Codex file changes completed. Review the workspace diff.",
              },
            ],
          });
      } else if (
        value.turnId === turnId &&
        method === "thread/tokenUsage/updated"
      ) {
        const usage = record(
          record(value.tokenUsage, "token usage").last,
          "token usage",
        );
        const count = (n: unknown) =>
          typeof n === "number" && Number.isSafeInteger(n) && n >= 0
            ? n
            : undefined;
        emit({
          events: [],
          usage: {
            inputTokens: count(usage.inputTokens),
            cachedTokens: count(usage.cachedInputTokens),
            outputTokens: count(usage.outputTokens),
          },
        });
      } else if (
        value.turnId === turnId &&
        method === "error" &&
        value.willRetry !== true
      ) {
        failure =
          "Native Codex reported an error; upstream diagnostic details were not copied.";
        terminalResolve?.();
      }
    };
    client.onNotification = handleNotification;
    {
      checkAbort(signal);
      const started = record(
        await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: options.prompt, text_elements: [] }],
          cwd: options.cwd,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: sandbox(options.mode, options.cwd),
          ...(options.model ? { model: options.model } : {}),
        }),
        "started turn",
      );
      turnId = boundedString(
        record(started.turn, "started turn").id,
        256,
        "turn ID",
      );
      emit({
        events: [{ kind: "status", text: "Native Codex turn started." }],
      });
      for (const [method, params] of pendingNotifications)
        handleNotification(method, params);
      pendingNotifications.length = 0;
      if (signal.aborted) abort();
      await terminal;
    }
  } catch (error) {
    failure ??=
      error instanceof CodexAppServerError
        ? error.message
        : "Native Codex could not complete the operation. No fallback was attempted.";
    if (error instanceof CodexAppServerError && error.terminationUnconfirmed)
      return {
        completed: false,
        cancelled: options.signal.aborted,
        error: failure,
        terminationUnconfirmed: true,
      };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
  if (client && !(await client.close()))
    return {
      completed: false,
      cancelled: options.signal.aborted,
      error:
        client.error?.message ??
        "Codex process termination could not be confirmed.",
      terminationUnconfirmed: true,
    };
  return {
    completed: completed && !failure && !options.signal.aborted,
    cancelled: options.signal.aborted,
    ...(failure ? { error: failure } : {}),
  };
}
