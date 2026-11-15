import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { APP_VERSION } from "../../shared/types";
import { disconnectChild, terminateTree, trackOwnedProcess } from "./providers";

const MAX_LINE = 12 * 1024 * 1024;
const MAX_OUTPUT = 128 * 1024 * 1024;
const MAX_INPUT = 1024 * 1024;
const MAX_TOOLS = 1024;
const REQUEST_TIMEOUT = 30_000;
type Json = Record<string, unknown>;
export interface ImportedMcpTool {
  name: string;
  description?: string;
  inputSchema: Json;
  outputSchema?: Json;
  annotations?: Json;
  _meta?: Json;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}
const object = (value: unknown): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The plugin returned invalid MCP data.");
  return value as Json;
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export class McpProcessError extends Error {
  constructor(message: string, readonly terminationUnconfirmed = false) { super(message); this.name = "McpProcessError"; }
}

/** A single explicitly approved stdio MCP server. It never invokes a shell. */
export class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly pending = new Map<number, Pending>();
  private readonly cancelled = new Set<number>();
  private readonly closed: Promise<void>;
  private buffer = "";
  private outputBytes = 0;
  private stderrBytes = 0;
  private nextId = 1;
  private closing = false;
  private closeSeen = false;
  private failure?: McpProcessError;
  private closeTask?: Promise<boolean>;
  private abortHandler?: () => void;
  private knownTools = new Set<string>();
  private toolRevision = 0;

  constructor(options: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }) {
    if (!path.isAbsolute(options.command) || !path.isAbsolute(options.cwd) || options.args.length > 100 ||
        options.args.some((arg) => typeof arg !== "string" || arg.length > 8192 || /[\0\r\n]/.test(arg)))
      throw new McpProcessError("The selected plugin command is invalid.");
    options.signal.throwIfAborted();
    const startedAt = Date.now();
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    trackOwnedProcess(this.child, startedAt);
    this.closed = new Promise((resolve) => this.child.once("close", () => {
      this.closeSeen = true;
      if (!this.closing) this.fail("The plugin MCP process exited unexpectedly.");
      resolve();
    }));
    this.child.once("error", () => this.fail("The plugin MCP process could not be started."));
    this.child.stdin.on("error", () => { if (!this.closing) this.fail("The plugin MCP input closed unexpectedly."); });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      // Diagnostics may contain secrets and are deliberately not retained.
      if (this.stderrBytes > 128 * 1024) this.fail("The plugin produced too much diagnostic output.");
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.closing) return;
      this.outputBytes += chunk.length;
      if (this.outputBytes > MAX_OUTPUT) { this.fail("The plugin exceeded its output limit."); return; }
      try {
        this.buffer += this.decoder.decode(chunk, { stream: true });
        let index: number;
        while (!this.closing && (index = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
          if (Buffer.byteLength(line) > MAX_LINE) throw new Error("Oversized message.");
          if (line.trim()) this.consume(line);
        }
        if (Buffer.byteLength(this.buffer) > MAX_LINE) throw new Error("Oversized message.");
      } catch { this.fail("The plugin sent invalid or oversized MCP output."); }
    });
    this.child.stdout.on("end", () => {
      if (this.closing) return;
      try { this.buffer += this.decoder.decode(); if (this.buffer.trim()) this.consume(this.buffer); this.buffer = ""; }
      catch { this.fail("The plugin sent incomplete MCP output."); }
    });
    this.abortHandler = () => this.fail("The plugin operation was cancelled.");
    this.detachAbort = () => { if (this.abortHandler) options.signal.removeEventListener("abort", this.abortHandler); this.abortHandler = undefined; };
    options.signal.addEventListener("abort", this.abortHandler, { once: true });
    if (options.signal.aborted) this.abortHandler();
  }
  private readonly detachAbort: () => void;

  private send(value: Json): void {
    if (this.failure || this.closing) throw this.failure ?? new McpProcessError("The plugin is closed.");
    const message = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(message) > MAX_INPUT || this.child.stdin.writableLength > MAX_INPUT) throw new McpProcessError("The plugin request exceeds its limit.");
    this.child.stdin.write(message);
  }
  private consume(line: string): void {
    const message = object(JSON.parse(line));
    if (message.jsonrpc !== "2.0") throw new Error("Invalid RPC version.");
    if (typeof message.method === "string") {
      if (message.method === "notifications/tools/list_changed") { this.toolRevision++; this.knownTools.clear(); }
      if (Object.hasOwn(message, "id")) {
        if (!(["string", "number"].includes(typeof message.id)) || String(message.id).length > 256) throw new Error("Invalid server request ID.");
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "This plugin server request is not supported by Nova." } });
      }
      return;
    }
    if (!Number.isSafeInteger(message.id)) throw new Error("Invalid response ID.");
    const id = Number(message.id);
    const request = this.pending.get(id);
    if (!request) {
      if (this.cancelled.delete(id)) return;
      throw new Error("Unexpected response ID.");
    }
    this.pending.delete(id); clearTimeout(request.timer);
    if (request.abort) request.signal?.removeEventListener("abort", request.abort);
    if (Object.hasOwn(message, "error")) request.reject(new McpProcessError("The plugin rejected an MCP request."));
    else if (Object.hasOwn(message, "result")) request.resolve(message.result);
    else request.reject(new McpProcessError("The plugin returned an invalid MCP response."));
  }
  private request(method: string, params: unknown, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT): Promise<unknown> {
    if (this.failure || this.closing) return Promise.reject(this.failure ?? new McpProcessError("The plugin is closed."));
    if (signal?.aborted) return Promise.reject(new McpProcessError("The plugin request was cancelled."));
    if (this.pending.size >= 16) return Promise.reject(new McpProcessError("The plugin has too many pending requests."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("The plugin did not respond before its timeout."), Math.max(1, Math.min(timeoutMs, 120_000)));
      const entry: Pending = { resolve, reject, timer, signal };
      this.pending.set(id, entry);
      if (signal) {
        entry.abort = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          this.cancelled.add(id);
          if (this.cancelled.size > 1000) this.fail("Too many plugin requests were cancelled.");
          try { this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Cancelled by Nova" } }); } catch { /* closing */ }
          reject(new McpProcessError("The plugin request was cancelled; its server is stopping."));
          // MCP cancellation is advisory. Stop the server so an ignored
          // cancellation cannot keep performing the approved action unseen.
          this.fail("The plugin server stopped after a cancelled request.");
        };
        signal.addEventListener("abort", entry.abort, { once: true });
        if (signal.aborted) { entry.abort(); return; }
      }
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); if (entry.abort) signal?.removeEventListener("abort", entry.abort); reject(error as Error); }
    });
  }
  async initialize(timeoutMs = REQUEST_TIMEOUT): Promise<void> {
    const result = object(await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nova-workbench", version: APP_VERSION } }, undefined, timeoutMs));
    if (!["2024-11-05", "2025-03-26", "2025-06-18"].includes(String(result.protocolVersion)) || !object(result.capabilities).tools)
      throw new McpProcessError("This plugin does not provide a compatible MCP tool server.");
    this.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }
  async listTools(timeoutMs = REQUEST_TIMEOUT): Promise<ImportedMcpTool[]> {
    const tools: ImportedMcpTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    const revision = this.toolRevision;
    const deadline = Date.now() + timeoutMs;
    let cursor: string | undefined;
    for (let page = 0; page < 25; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new McpProcessError("The plugin tool list exceeded its timeout.");
      const result = object(await this.request("tools/list", cursor ? { cursor } : {}, undefined, remaining));
      if (!Array.isArray(result.tools) || result.tools.length + tools.length > MAX_TOOLS) throw new McpProcessError("The plugin tool list is invalid or too large.");
      for (const raw of result.tools) {
        const item = object(raw);
        if (typeof item.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(item.name) || names.has(item.name)) throw new McpProcessError("The plugin returned an invalid or duplicate tool name.");
        if (item.description !== undefined && (typeof item.description !== "string" || item.description.length > 4000)) throw new McpProcessError("The plugin tool description is invalid.");
        const inputSchema = object(item.inputSchema);
        if (inputSchema.type !== "object" || Buffer.byteLength(JSON.stringify(item)) > 256 * 1024) throw new McpProcessError("The plugin tool schema is invalid or oversized.");
        names.add(item.name);
        tools.push({ name: item.name, ...(typeof item.description === "string" ? { description: item.description } : {}), inputSchema,
          ...(item.outputSchema ? { outputSchema: object(item.outputSchema) } : {}), ...(item.annotations ? { annotations: object(item.annotations) } : {}), ...(item._meta ? { _meta: object(item._meta) } : {}) });
      }
      if (result.nextCursor == null) {
        if (this.toolRevision !== revision) throw new McpProcessError("The plugin tool list changed during discovery. Retry the run.");
        this.knownTools = names; return tools;
      }
      if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.length > 1024 || cursors.has(result.nextCursor)) throw new McpProcessError("The plugin returned an invalid tool-list cursor.");
      cursor = result.nextCursor; cursors.add(cursor);
    }
    throw new McpProcessError("The plugin tool list exceeded the page limit.");
  }
  async call(name: string, args: unknown, signal: AbortSignal, timeoutMs = 120_000): Promise<Json> {
    if (!this.knownTools.has(name)) throw new McpProcessError("The plugin tool was not in the current reviewed list.");
    const parameters = object(args);
    const result = object(await this.request("tools/call", { name, arguments: parameters }, signal, timeoutMs));
    if (!Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== "boolean")) throw new McpProcessError("The plugin returned an invalid tool result.");
    return result;
  }
  private fail(message: string): void {
    if (this.failure || this.closing) return;
    this.failure = new McpProcessError(message);
    for (const item of this.pending.values()) { clearTimeout(item.timer); if (item.abort) item.signal?.removeEventListener("abort", item.abort); item.reject(this.failure); }
    this.pending.clear();
    void this.close();
  }
  close(): Promise<boolean> {
    if (this.closeTask) return this.closeTask;
    this.closing = true; this.detachAbort();
    for (const item of this.pending.values()) { clearTimeout(item.timer); if (item.abort) item.signal?.removeEventListener("abort", item.abort); item.reject(this.failure ?? new McpProcessError("The plugin is closed.")); }
    this.pending.clear(); this.child.stdin.end();
    this.closeTask = (async () => {
      await Promise.race([this.closed, pause(150)]);
      const terminated = await terminateTree(this.child);
      await Promise.race([this.closed, pause(1500)]);
      const clean = terminated && this.closeSeen;
      disconnectChild(this.child);
      if (!clean) this.failure = new McpProcessError("Plugin termination could not be confirmed. Inspect and stop its processes before continuing.", true);
      return clean;
    })();
    return this.closeTask;
  }
  get error(): McpProcessError | undefined { return this.failure; }
}
