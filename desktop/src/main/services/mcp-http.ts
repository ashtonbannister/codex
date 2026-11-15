import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

const LIMIT = 64 * 1024;
const VERSION = "2025-06-18";
type Json = Record<string, unknown>;
async function readBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > LIMIT) throw new Error("Invalid request size.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > LIMIT) throw new Error("Request exceeds the size limit.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const object = (value: unknown): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid RPC message.");
  return value as Json;
};

/** Authenticated, loopback-only MCP transport shared by Nova-owned per-run tools. */
export async function startLocalMcp(options: {
  name: string;
  tools: Json[];
  signal: AbortSignal;
  execute(name: string, args: unknown, signal: AbortSignal): Promise<Json>;
  close(): void | Promise<void>;
}): Promise<{ url: string; token: string; dispose(): Promise<void> }> {
  options.signal.throwIfAborted();
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const shutdown = new AbortController();
  const combined = AbortSignal.any([options.signal, shutdown.signal]);
  const pending = new Map<string, AbortController>();
  let closed = false;
  let closeTask: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const auth = Buffer.from(request.headers.authorization ?? "");
    const address = server.address();
    if (closed || typeof address !== "object" || !address || request.headers.host !== `127.0.0.1:${address.port}` || request.headers.origin !== undefined ||
        auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      response.writeHead(401, { "Cache-Control": "no-store" }); response.end(); return;
    }
    if (request.method === "GET") { response.writeHead(405, { Allow: "POST, DELETE" }); response.end(); return; }
    if (request.method === "DELETE") { response.writeHead(204); response.end(); return; }
    if (request.method !== "POST" || request.url !== "/mcp") { response.writeHead(404); response.end(); return; }
    const disconnected = new AbortController();
    response.once("close", () => { if (!response.writableFinished) disconnected.abort(); });
    const requestSignal = AbortSignal.any([combined, disconnected.signal]);
    void (async () => {
      let id: string | number | null = null;
      let pendingKey: string | undefined;
      try {
        const message = object(await readBody(request));
        if (message.jsonrpc !== "2.0" || typeof message.method !== "string") throw new Error("Invalid RPC message.");
        if (message.id === undefined) {
          if (message.method === "notifications/cancelled") pending.get(JSON.stringify(object(message.params).requestId))?.abort();
          response.writeHead(202); response.end(); return;
        }
        if (!(typeof message.id === "string" || typeof message.id === "number") || String(message.id).length > 200) throw new Error("Invalid request ID.");
        id = message.id;
        let result: unknown;
        if (message.method === "initialize") result = { protocolVersion: VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: options.name, version: "1.0.0" } };
        else if (message.method === "ping") result = {};
        else if (message.method === "tools/list") result = { tools: options.tools };
        else if (message.method === "tools/call") {
          const params = object(message.params);
          if (typeof params.name !== "string") throw new Error("Invalid tool name.");
          const key = JSON.stringify(id);
          if (pending.has(key)) throw new Error("Duplicate request ID.");
          pendingKey = key;
          const cancellation = new AbortController(); pending.set(key, cancellation);
          const toolSignal = AbortSignal.any([requestSignal, cancellation.signal]);
          try { result = await options.execute(params.name, params.arguments, toolSignal); }
          catch (error) {
            result = { content: [{ type: "text", text: toolSignal.aborted ? "Tool action cancelled." : error instanceof Error ? error.message.slice(0, 1000) : "Tool action failed." }], isError: true };
          }
        } else {
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })); return;
        }
        if (requestSignal.aborted) return;
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch {
        if (!response.headersSent && !response.destroyed) {
          response.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } }));
        }
      } finally { if (pendingKey) pending.delete(pendingKey); }
    })();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Nova MCP server could not bind to loopback."); }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, token,
    dispose: () => {
      if (closeTask) return closeTask;
      closed = true; shutdown.abort();
      closeTask = (async () => {
        await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
        await options.close();
      })();
      return closeTask;
    },
  };
}
