import readline from "node:readline";
import fs from "node:fs";
if (process.env.NOVA_SYNTH_MARKER) fs.writeFileSync(process.env.NOVA_SYNTH_MARKER, "started");
const mode = process.argv[2] || "normal";
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let denied = false;
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === "server-request") { denied = !!request.error; return; }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } } });
  } else if (request.method === "notifications/initialized") {
    send({ jsonrpc: "2.0", id: "server-request", method: "sampling/createMessage", params: {} });
  } else if (request.method === "tools/list") {
    if (mode === "many") {
      const offset = Number(request.params?.cursor ?? 0);
      const names = Array.from({ length: Math.min(50, 474 - offset) }, (_, i) => `tool_${offset + i}`);
      send({ jsonrpc: "2.0", id: request.id, result: { tools: names.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })), nextCursor: offset + names.length < 474 ? String(offset + names.length) : null } });
      return;
    }
    if (mode === "change-during-list" && !request.params?.cursor) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} });
    if (mode === "long") { send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "a".repeat(100), inputSchema: { type: "object" } }] } }); return; }
    if (mode === "invalid") { send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "bad/name", inputSchema: { type: "object" } }] } }); return; }
    const second = !!request.params?.cursor;
    const names = second ? ["slow", "invalidate"] : ["echo"];
    send({ jsonrpc: "2.0", id: request.id, result: { tools: names.map((name) => ({ name, description: "Synthetic tool", inputSchema: { type: "object", properties: {} } })), nextCursor: second ? null : "second" } });
  } else if (request.method === "tools/call") {
    if (request.params.name === "slow") { setTimeout(() => send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "late" }] } }), 40); return; }
    if (request.params.name === "invalidate") send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} });
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: denied ? "server request denied" : "missing denial" }] } });
  }
});
