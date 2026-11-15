import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { DesktopControlSession, type DesktopResult } from "./desktop-control";

const LIMIT = 64 * 1024;
const VERSION = "2025-06-18";
const tool = {
  name: "desktop",
  description: "Use a user-approved Windows window. First list and select a window, then inspect it. Use only selectors and the observation ID returned by the latest inspection. Every operation requires the user's approval. Never use this tool for authentication, password managers, terminals, system security settings, or the Nova/Codex application itself.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "select", "inspect", "screenshot", "invoke", "set-value", "click", "scroll", "type", "key"] },
      hwnd: { type: "integer", description: "Window handle returned by list; required for select." },
      observation: { type: "string", description: "Latest observation ID; required for invoke and set-value." },
      selector: { type: "string", description: "Element selector from the latest inspection." },
      operation: { type: "string", enum: ["invoke", "select", "toggle", "toggle-on", "toggle-off", "expand", "collapse"] },
      value: { type: "string", description: "Text for set-value or type." },
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      key: { type: "string", enum: ["enter", "tab", "escape", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "backspace", "delete"] },
    },
    required: ["action"], additionalProperties: false,
  },
};

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
const asObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid RPC message.");
  return value as Record<string, unknown>;
};

/** Private, per-run MCP server; it never listens beyond IPv4 loopback. */
export async function startDesktopMcp(session: DesktopControlSession, signal: AbortSignal): Promise<{
  url: string; token: string; dispose(): Promise<void>;
}> {
  signal.throwIfAborted();
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const shutdown = new AbortController();
  const combined = AbortSignal.any([signal, shutdown.signal]);
  let closed = false;
  const pending = new Map<string, AbortController>();
  const server = createServer((request, response) => {
    const auth = Buffer.from(request.headers.authorization ?? "");
    const host = request.headers.host ?? "";
    const address = server.address();
    if (closed || typeof address !== "object" || !address || host !== `127.0.0.1:${address.port}` || request.headers.origin !== undefined ||
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
        const message = asObject(await readBody(request));
        if (message.jsonrpc !== "2.0" || typeof message.method !== "string") throw new Error("Invalid RPC message.");
        if (message.id === undefined) {
          if (message.method === "notifications/cancelled") {
            const params = asObject(message.params);
            pending.get(JSON.stringify(params.requestId))?.abort();
          }
          response.writeHead(202); response.end(); return;
        }
        if (!(typeof message.id === "string" || typeof message.id === "number") || String(message.id).length > 200) throw new Error("Invalid request ID.");
        id = message.id;
        let result: unknown;
        if (message.method === "initialize") result = { protocolVersion: VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "nova-desktop", version: "1.0.0" } };
        else if (message.method === "ping") result = {};
        else if (message.method === "tools/list") result = { tools: [tool] };
        else if (message.method === "tools/call") {
          const params = asObject(message.params);
          if (params.name !== "desktop") throw new Error("Unknown desktop tool.");
          const key = JSON.stringify(id);
          if (pending.has(key)) throw new Error("Duplicate request ID.");
          pendingKey = key;
          const cancellation = new AbortController();
          pending.set(pendingKey, cancellation);
          const toolSignal = AbortSignal.any([requestSignal, cancellation.signal]);
          let outcome: DesktopResult;
          try { outcome = await session.execute(params.arguments, toolSignal); }
          catch (error) {
            if (toolSignal.aborted) { result = { content: [{ type: "text", text: "Desktop action cancelled." }], isError: true }; }
            else result = { content: [{ type: "text", text: error instanceof Error ? error.message.slice(0, 1000) : "Desktop action failed." }], isError: true };
            outcome = { text: "" };
          }
          if (result === undefined) result = { content: [{ type: "text", text: outcome.text }, ...(outcome.image ? [{ type: "image", ...outcome.image }] : [])], isError: false };
        } else {
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
          return;
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
  if (!address || typeof address === "string") { server.close(); throw new Error("Desktop MCP server could not bind to loopback."); }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, token,
    dispose: async () => {
      if (closed) return;
      closed = true; shutdown.abort(); session.close();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
