import { Client, SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { APP_VERSION } from "../../shared/types";
import { McpProcessError, type ImportedMcpTool } from "./mcp-stdio";

const MAX_OUTPUT = 128 * 1024 * 1024;
const MAX_MESSAGE = 12 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpProcessError("The remote plugin returned invalid MCP data.");
  return value as Record<string, unknown>;
};

/** One explicitly reviewed remote MCP connection. No redirect or cross-origin request is permitted. */
export class McpRemoteClient {
  private readonly client = new Client({ name: "nova-workbench", version: APP_VERSION }, { capabilities: {} });
  private readonly controller = new AbortController();
  private readonly detach: () => void;
  private readonly transport: SSEClientTransport | StreamableHTTPClientTransport;
  private outputBytes = 0;
  private revision = 0;
  private tools = new Set<string>();
  private closed = false;

  constructor(endpoint: URL, transport: "http" | "sse", headers: Record<string, string>, signal: AbortSignal) {
    signal.throwIfAborted();
    const abort = () => this.controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.detach = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
    const boundedFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== endpoint.origin || url.username || url.password || url.hash) throw new Error("Remote plugin requested an unreviewed origin.");
      const response = await fetch(input, { ...init, redirect: "error", credentials: "omit", signal: AbortSignal.any([this.controller.signal, ...(init?.signal ? [init.signal] : [])]) });
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_MESSAGE) throw new Error("Remote plugin response exceeds its limit.");
      if (!response.body) return response;
      let bytes = 0;
      const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, controller) => {
        bytes += chunk.byteLength; this.outputBytes += chunk.byteLength;
        if (bytes > MAX_MESSAGE || this.outputBytes > MAX_OUTPUT) { this.controller.abort(); throw new Error("Remote plugin exceeded its output limit."); }
        controller.enqueue(chunk);
      } }));
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const options = { fetch: boundedFetch, requestInit: { headers, redirect: "error" as const }, redirectPolicy: "same-origin" as const };
    this.transport = transport === "http" ? new StreamableHTTPClientTransport(endpoint, options) : new SSEClientTransport(endpoint, options);
    this.client.setNotificationHandler("notifications/tools/list_changed", () => { this.revision++; this.tools.clear(); });
  }
  async initialize(timeout = 30_000): Promise<void> {
    try {
      await this.client.connect(this.transport, { signal: this.controller.signal, timeout });
      if (!this.client.getServerCapabilities()?.tools) throw new Error("Missing tools capability.");
    } catch { await this.close(); throw new McpProcessError("The remote plugin connection failed or is incompatible. Check its address and authentication."); }
  }
  async listTools(timeout = 30_000): Promise<ImportedMcpTool[]> {
    const deadline = Date.now() + timeout, revision = this.revision;
    const tools: ImportedMcpTool[] = [], names = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 25; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new McpProcessError("The remote plugin tool list exceeded its timeout.");
      const result = await this.client.listTools({ ...(cursor ? { cursor } : {}) }, { signal: this.controller.signal, timeout: remaining, cacheMode: "bypass" });
      if (!Array.isArray(result.tools) || result.tools.length + tools.length > 1024) throw new McpProcessError("The remote plugin tool list is invalid or too large.");
      for (const raw of result.tools) {
        const item = object(raw);
        if (typeof item.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(item.name) || names.has(item.name) || (item.description !== undefined && (typeof item.description !== "string" || item.description.length > 4000))) throw new McpProcessError("The remote plugin returned an invalid tool.");
        const inputSchema = object(item.inputSchema);
        if (inputSchema.type !== "object" || Buffer.byteLength(JSON.stringify(item)) > 256 * 1024) throw new McpProcessError("The remote plugin tool schema is invalid or oversized.");
        names.add(item.name);
        tools.push({ name: item.name, ...(typeof item.description === "string" ? { description: item.description } : {}), inputSchema, ...(item.outputSchema ? { outputSchema: object(item.outputSchema) } : {}), ...(item.annotations ? { annotations: object(item.annotations) } : {}), ...(item._meta ? { _meta: object(item._meta) } : {}) });
      }
      if (result.nextCursor == null) {
        if (this.revision !== revision) throw new McpProcessError("The remote plugin tool list changed during discovery.");
        this.tools = names; return tools;
      }
      if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.length > 1024 || cursors.has(result.nextCursor)) throw new McpProcessError("The remote plugin returned an invalid tool-list cursor.");
      cursor = result.nextCursor; cursors.add(cursor);
    }
    throw new McpProcessError("The remote plugin tool list exceeded the page limit.");
  }
  async call(name: string, args: unknown, signal: AbortSignal, timeout = 120_000): Promise<Record<string, unknown>> {
    if (!this.tools.has(name)) throw new McpProcessError("The remote plugin tool was not in the reviewed list.");
    try {
      const result = object(await this.client.callTool({ name, arguments: object(args) }, { signal: AbortSignal.any([signal, this.controller.signal]), timeout }));
      if (!Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== "boolean")) throw new Error("Invalid result.");
      return result;
    } catch { if (signal.aborted) await this.close(); throw new McpProcessError("The remote plugin call failed or was cancelled. The remote service may continue processing it."); }
  }
  async close(): Promise<boolean> {
    if (this.closed) return true;
    this.closed = true; this.detach(); this.controller.abort();
    try { await this.client.close(); } catch { /* Remote termination cannot be confirmed. */ }
    return true;
  }
}
