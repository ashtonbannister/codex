import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type {
  AccountProvider,
  ProviderAccountStatus,
  ProviderLoginStatus,
} from "../../shared/provider-auth";
import {
  CodexAppServerError,
  connectCodexServer,
  type CodexServerOptions,
  type CodexStdioClient,
} from "./codex-app-server";
import {
  disconnectChild,
  resolveExecutable,
  terminateTree,
  trackOwnedProcess,
  type Executable,
} from "./providers";

const AUTH_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 15_000;
const OUTPUT_BYTES = 128 * 1_024;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown, limit = 300): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= limit &&
  !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : undefined;

/** No wildcard domains, URL credentials, non-HTTPS handlers, or custom ports. */
export function officialLoginUrl(
  provider: AccountProvider,
  input: unknown,
): string | undefined {
  if (typeof input !== "string" || input.length > 8_192) return undefined;
  try {
    const url = new URL(input);
    const hosts = provider === "codex"
      ? ["auth.openai.com", "chatgpt.com"]
      : ["claude.ai", "console.anthropic.com", "platform.claude.com"];
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.hash || !hosts.includes(url.hostname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export class ProviderAuthError extends Error {
  constructor(message: string, readonly terminationUnconfirmed = false) {
    super(message);
    this.name = "ProviderAuthError";
  }
}

function validateProvider(provider: AccountProvider): void {
  if (provider !== "codex" && provider !== "claude")
    throw new ProviderAuthError("Choose Codex or Claude Code for account sign-in.");
}

function parseCodexAccount(value: unknown): ProviderAccountStatus {
  const root = record(value);
  if (!root || typeof root.requiresOpenaiAuth !== "boolean")
    throw new ProviderAuthError("Codex returned an incompatible account status. Update its official CLI.");
  const base = { provider: "codex" as const, checkedAt: new Date().toISOString() };
  if (root.account === null)
    return {
      ...base,
      state: root.requiresOpenaiAuth ? "signed-out" : "unknown",
      message: root.requiresOpenaiAuth
        ? "Sign in with ChatGPT using the installed Codex engine."
        : "This Codex configuration does not require OpenAI sign-in.",
    };
  const account = record(root.account);
  if (!account || !["chatgpt", "apiKey", "amazonBedrock", "gcp"].includes(String(account.type)))
    throw new ProviderAuthError("Codex returned an incompatible account status. Update its official CLI.");
  return {
    ...base,
    state: "signed-in",
    method: String(account.type),
    ...(account.type === "chatgpt" && text(account.email)
      ? { label: text(account.email) }
      : {}),
    message: account.type === "chatgpt"
      ? "Using the installed Codex account. The official Codex app shares this configured home."
      : "Using credentials already managed by the official Codex engine.",
  };
}

function parseClaudeAccount(output: string, code: number | null): ProviderAccountStatus {
  let value: Record<string, unknown> | undefined;
  try { value = record(JSON.parse(output.replace(/^\uFEFF/, ""))); } catch { /* redacted */ }
  const methods = ["none", "claude.ai", "oauth_token", "api_key", "api_key_helper", "third_party"];
  if (!value || typeof value.loggedIn !== "boolean" ||
    !methods.includes(String(value.authMethod)) || ![0, 1].includes(code ?? -1) ||
    (code === 0) !== value.loggedIn)
    throw new ProviderAuthError("Claude Code returned an incompatible account status. Update its official CLI and retry.");
  return {
    provider: "claude",
    state: value.loggedIn ? "signed-in" : "signed-out",
    method: String(value.authMethod),
    ...(text(value.email) ? { label: text(value.email) } : {}),
    checkedAt: new Date().toISOString(),
    message: value.loggedIn
      ? "Using the account managed by Claude Code. Claude Desktop has its own session."
      : "Sign in through Claude Code to use its account in Nova.",
  };
}

/**
 * Only fixed metadata/auth subcommands are accepted by callers below. The CLI
 * owns credentials; stdout is either parsed through an allowlist or discarded.
 */
async function claudeCommand(
  executable: Executable,
  args: string[],
  options: CodexServerOptions,
  signal: AbortSignal,
  timeoutMs: number,
  capture: boolean,
  onUrl?: (url: string) => void,
): Promise<{ code: number | null; output: string }> {
  if (signal.aborted) throw new ProviderAuthError("Account operation was cancelled.");
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(executable.command, [...executable.prefix, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...executable.env, NO_COLOR: "1" },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackOwnedProcess(child, started);
    let finishing = false;
    let finished = false;
    let failure: string | undefined;
    let bytes = 0;
    let output = "";
    let tail = "";
    let closeSeen = false;
    let termination: Promise<boolean> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const decoder = new StringDecoder("utf8");
    const finish = async (code: number | null) => {
      if (finishing || finished) return;
      finishing = true;
      clearTimeout(timer);
      clearTimeout(drain);
      signal.removeEventListener("abort", abort);
      const confirmed = await (termination ??= terminateTree(child));
      disconnectChild(child);
      finished = true;
      if (!confirmed || !closeSeen)
        reject(new ProviderAuthError("Claude account process cleanup could not be confirmed. Stop remaining Claude CLI processes before restarting Nova.", true));
      else if (failure) reject(new ProviderAuthError(failure));
      else resolve({ code, output });
    };
    const stop = () => {
      if (finished || finishing || termination) return;
      termination = terminateTree(child);
      void termination.then(() => {
        if (finished || finishing) return;
        drain = setTimeout(() => { void finish(child.exitCode); }, 1_500);
      });
    };
    const abort = () => {
      failure = "Account operation was cancelled.";
      stop();
    };
    const timer = setTimeout(() => {
      failure = capture
        ? "Claude account status timed out. Check the installed CLI and retry."
        : "Claude sign-in timed out. Start sign-in again when ready.";
      stop();
    }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const data = (chunk: Buffer, isOutput: boolean) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_BYTES) {
        failure = "Claude account output exceeded its safety limit. Use the official CLI to diagnose the installation.";
        stop();
        return;
      }
      if (capture && isOutput) output += decoder.write(chunk);
      if (onUrl) {
        // Never forward diagnostics, authorization codes, or token-shaped text.
        tail = (tail + chunk.toString("utf8")).slice(-16_384);
        for (const candidate of tail.match(/https:\/\/[^\s<>"'\x1b]+/g) ?? []) {
          const url = officialLoginUrl("claude", candidate);
          if (url) onUrl(url);
        }
      }
    };
    child.stdout.on("data", (chunk: Buffer) => data(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => data(chunk, false));
    child.once("error", () => {
      failure = "Could not start Claude Code. Select its official executable in Settings.";
      // Node emits close after error, including an executable-start failure.
    });
    child.once("close", (code) => {
      closeSeen = true;
      if (capture) output += decoder.end();
      void finish(code);
    });
  });
}

interface LoginSession {
  status: ProviderLoginStatus;
  controller: AbortController;
  task: Promise<void>;
  client?: CodexStdioClient;
  loginId?: string;
}

interface AuthServiceOptions {
  openExternal: (url: string) => Promise<void>;
  /** Durable lease written before any subprocess starts; recovered after a crash. */
  onOperationStart?: (provider: AccountProvider, home: string) => Promise<string>;
  /** Clear only this lease after confirmed owned-process cleanup. */
  onOperationFinished?: (operationId: string) => Promise<void>;
  /** Persist a recovery lock without storing login output or account metadata. */
  onRecoveryRequired?: (provider: AccountProvider, home: string) => void | Promise<void>;
}

/** One transient account operation at a time; main must block concurrent work. */
export class ProviderAuthService {
  private session?: LoginSession;
  private operating = false;
  private recovery = false;
  private readController?: AbortController;
  private readTask?: Promise<ProviderAccountStatus>;

  constructor(private readonly options: AuthServiceOptions) {}

  get busy(): boolean { return this.operating || this.recovery; }
  get recoveryRequired(): boolean { return this.recovery; }
  get operationActive(): boolean { return this.operating; }

  /** Main calls only after the user's native recovery acknowledgement is saved. */
  acknowledgeRecovery(): void {
    if (this.operating)
      throw new ProviderAuthError("An account operation is still running. Finish or cancel it before acknowledging recovery.");
    this.recovery = false;
  }

  getLogin(): ProviderLoginStatus | null {
    return this.session ? { ...this.session.status } : null;
  }

  private reserve(provider: AccountProvider): void {
    validateProvider(provider);
    if (this.busy)
      throw new ProviderAuthError(this.recovery
        ? "Account process cleanup needs recovery. Stop remaining CLI processes and restart Nova."
        : "An account operation is already running. Finish or cancel it first.");
    this.operating = true;
  }

  private async markRecovery(provider: AccountProvider, home: string): Promise<void> {
    this.recovery = true;
    await this.options.onRecoveryRequired?.(provider, home);
  }

  private async beginOperation(provider: AccountProvider, options: CodexServerOptions): Promise<string | undefined> {
    if (options.signal?.aborted)
      throw new ProviderAuthError("Account operation was cancelled before starting a provider process.");
    try {
      return await this.options.onOperationStart?.(provider, options.home);
    } catch {
      // A failed reservation must not launch a child. The workspace owns any
      // ambiguous persisted reservation and its restart/recovery handling.
      throw new ProviderAuthError("Nova could not save the account operation before starting it. No provider process was started. Check local storage or Settings → Recovery before retrying.");
    }
  }

  private async finishOperation(provider: AccountProvider, home: string, operationId?: string): Promise<void> {
    if (!operationId || this.recovery) return;
    try {
      await this.options.onOperationFinished?.(operationId);
    } catch {
      // Process cleanup succeeded, but losing the crash-recovery lease is not
      // allowed. Keep the in-memory lock even if writing its recovery fails.
      try { await this.markRecovery(provider, home); } catch { /* locked */ }
      throw new ProviderAuthError("Account processes stopped, but Nova could not save cleanup confirmation. Review Settings → Recovery before continuing.");
    }
  }

  private async close(client: CodexStdioClient): Promise<void> {
    if (!(await client.close()))
      throw new ProviderAuthError("Codex account process cleanup could not be confirmed. Stop remaining Codex CLI processes before restarting Nova.", true);
  }

  private async account(provider: AccountProvider, options: CodexServerOptions): Promise<ProviderAccountStatus> {
    if (provider === "codex") {
      const client = await connectCodexServer(options);
      try {
        return parseCodexAccount(await client.request("account/read", { refreshToken: false }));
      } finally {
        await this.close(client);
      }
    }
    const executable = await resolveExecutable(options.settings.claudePath);
    const result = await claudeCommand(executable, ["--safe-mode", "auth", "status"], options,
      options.signal ?? new AbortController().signal, STATUS_TIMEOUT_MS, true);
    return parseClaudeAccount(result.output, result.code);
  }

  async read(provider: AccountProvider, options: CodexServerOptions): Promise<ProviderAccountStatus> {
    this.reserve(provider);
    const controller = new AbortController();
    this.readController = controller;
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    this.readTask = (async () => {
      let operationId: string | undefined;
      try {
        try {
          operationId = await this.beginOperation(provider, { ...options, signal });
          // Cancellation may arrive while the durable reservation is written.
          if (signal.aborted) throw new ProviderAuthError("Account operation was cancelled before starting a provider process.");
          return await this.account(provider, { ...options, signal });
        } catch (error) {
          if ((error instanceof ProviderAuthError || error instanceof CodexAppServerError) && error.terminationUnconfirmed) {
            try { await this.markRecovery(provider, options.home); } catch { /* locked */ }
            throw new ProviderAuthError("Account process cleanup could not be confirmed. Stop remaining CLI processes and review Settings → Recovery.", true);
          }
          return {
            provider,
            state: "unavailable" as const,
            checkedAt: new Date().toISOString(),
            message: error instanceof ProviderAuthError ? error.message
              : `Could not read ${provider === "codex" ? "Codex" : "Claude Code"} account status. Check the official CLI installation and configured path.`,
          };
        } finally {
          await this.finishOperation(provider, options.home, operationId);
        }
      } finally {
        this.operating = false;
        this.readController = undefined;
        this.readTask = undefined;
      }
    })();
    return this.readTask;
  }

  async start(provider: AccountProvider, options: CodexServerOptions): Promise<ProviderLoginStatus> {
    this.reserve(provider);
    const session: LoginSession = {
      status: { id: randomUUID(), provider, state: "starting", message: "Starting the official sign-in flow…" },
      controller: new AbortController(),
      task: Promise.resolve(),
    };
    this.session = session;
    const signal = options.signal
      ? AbortSignal.any([session.controller.signal, options.signal]) : session.controller.signal;
    session.task = this.runLogin(session, { ...options, signal });
    return { ...session.status };
  }

  private async runLogin(session: LoginSession, options: CodexServerOptions): Promise<void> {
    const provider = session.status.provider;
    let operationId: string | undefined;
    let result: ProviderLoginStatus;
    try {
      operationId = await this.beginOperation(provider, options);
      if (options.signal?.aborted)
        throw new ProviderAuthError("Account operation was cancelled before starting a provider process.");
      if (provider === "codex") await this.loginCodex(session, options);
      else await this.loginClaude(session, options);
      if (options.signal?.aborted) throw new ProviderAuthError("Account operation was cancelled.");
      result = {
        id: session.status.id,
        provider,
        state: "complete",
        message: provider === "codex"
          ? "Signed in through Codex. This account is shared with the official Codex app using the same home."
          : "Signed in through Claude Code. Nova will use its normal account; Claude Desktop sign-in remains separate.",
      };
    } catch (error) {
      const unconfirmed = (error instanceof ProviderAuthError || error instanceof CodexAppServerError) && error.terminationUnconfirmed;
      if (unconfirmed) {
        try { await this.markRecovery(provider, options.home); }
        catch { /* Recovery remains locked in memory if persistence failed. */ }
      }
      result = {
        id: session.status.id,
        provider,
        state: options.signal?.aborted && !unconfirmed ? "cancelled" : "failed",
        message: unconfirmed
          ? "Account process cleanup could not be confirmed. Stop remaining CLI processes before restarting Nova."
          : options.signal?.aborted
            ? "Sign-in was cancelled. No credentials were copied into Nova."
            : error instanceof ProviderAuthError ? error.message
              : `The ${provider === "codex" ? "Codex" : "Claude Code"} sign-in flow failed. Check the installed official CLI and retry.`,
      };
    }
    try {
      await this.finishOperation(provider, options.home, operationId);
    } catch {
      result = {
        id: session.status.id,
        provider,
        state: "failed",
        message: "Account processes stopped, but Nova could not save cleanup confirmation. Review Settings → Recovery before continuing.",
      };
    } finally {
      // Do not publish completion while the durable lease is still being
      // cleared. Consumers may immediately request account status on complete.
      session.status = result;
      session.client = undefined;
      session.loginId = undefined;
      this.operating = false;
    }
  }

  private async loginCodex(session: LoginSession, options: CodexServerOptions): Promise<void> {
    const client = await connectCodexServer(options);
    session.client = client;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let complete: ((success: boolean) => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    let pending: { id: string; success: boolean } | undefined;
    const wait = new Promise<boolean>((resolve, reject) => { complete = resolve; fail = reject; });
    // Attach before requesting login: immediate completion is valid.
    void wait.catch(() => undefined);
    const abort = () => fail?.(new ProviderAuthError("Account operation was cancelled."));
    options.signal?.addEventListener("abort", abort, { once: true });
    client.onFailure = () => fail?.(new ProviderAuthError("The Codex sign-in process ended unexpectedly. Retry sign-in."));
    client.onNotification = (method, params) => {
      if (method !== "account/login/completed") return;
      const value = record(params);
      const id = text(value?.loginId, 256);
      if (!id || typeof value?.success !== "boolean") return;
      if (!session.loginId) pending = { id, success: value.success };
      else if (id === session.loginId) complete?.(value.success);
    };
    try {
      const response = record(await client.request("account/login/start", { type: "chatgpt" }));
      const id = text(response?.loginId, 256);
      const url = officialLoginUrl("codex", response?.authUrl);
      if (response?.type !== "chatgpt" || !id || !url)
        throw new ProviderAuthError("Codex returned an unsupported sign-in response or non-official sign-in URL. Update the official CLI and retry.");
      session.loginId = id;
      if (pending?.id === id) complete?.(pending.success);
      session.status = { ...session.status, state: "waiting", verificationUrl: url,
        message: "Complete ChatGPT sign-in in your browser. Keep Nova open; credentials stay with Codex." };
      timer = setTimeout(() => fail?.(new ProviderAuthError("Codex sign-in timed out. Start sign-in again when ready.")), AUTH_TIMEOUT_MS);
      try { await this.options.openExternal(url); }
      catch { throw new ProviderAuthError("Could not open the official Codex sign-in page. Check your default browser and retry."); }
      if (options.signal?.aborted) abort();
      if (!(await wait)) throw new ProviderAuthError("Codex did not complete sign-in. Retry or use the official CLI to diagnose the account.");
      const status = parseCodexAccount(await client.request("account/read", { refreshToken: false }));
      if (status.state !== "signed-in") throw new ProviderAuthError("Codex finished sign-in without an active account. Check the official CLI and retry.");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // Do not trust raw upstream errors; cancellation failures are covered by
      // process shutdown, which is always awaited and fails closed.
      if (session.loginId) {
        try { await client.request("account/login/cancel", { loginId: session.loginId }, 3_000); }
        catch { /* Already finished or aborted. */ }
      }
      await this.close(client);
    }
  }

  private async loginClaude(session: LoginSession, options: CodexServerOptions): Promise<void> {
    const signal = options.signal!;
    const executable = await resolveExecutable(options.settings.claudePath);
    const help = await claudeCommand(executable, ["--safe-mode", "auth", "--help"], options,
      signal, STATUS_TIMEOUT_MS, true);
    if (help.code !== 0 || !/\blogin\b/.test(help.output) || !/\bstatus\b/.test(help.output))
      throw new ProviderAuthError("This Claude Code version does not expose the required account commands. Update the official CLI and retry.");
    session.status = { ...session.status, state: "waiting",
      message: "Complete Claude Code sign-in in the browser it opens. Credentials stay with Claude Code." };
    const result = await claudeCommand(executable, ["--safe-mode", "auth", "login"], options,
      signal, AUTH_TIMEOUT_MS, false, (url) => {
        if (session.status.state === "waiting" && !session.status.verificationUrl)
          session.status = { ...session.status, verificationUrl: url };
      });
    if (result.code !== 0)
      throw new ProviderAuthError("Claude Code did not finish browser sign-in. Retry, or run `claude auth login` in a terminal if your organization requires an interactive prompt.");
    const account = await this.account("claude", options);
    if (account.state !== "signed-in")
      throw new ProviderAuthError("Claude Code exited sign-in without an active account. Sign in using the official CLI and refresh status.");
  }

  async cancel(): Promise<void> {
    if (this.readController) this.readController.abort();
    if (this.session && ["starting", "waiting"].includes(this.session.status.state)) {
      // Request cancellation while the RPC channel is still usable, then abort
      // the client/process. Never wait for the full browser-login timeout.
      if (this.session.client && this.session.loginId) {
        try { await this.session.client.request("account/login/cancel", { loginId: this.session.loginId }, 3_000); }
        catch { /* Cleanup below remains mandatory. */ }
      }
      this.session.controller.abort();
    }
    await Promise.all([this.session?.task, this.readTask]);
  }

  async shutdown(): Promise<void> { await this.cancel(); }
}
