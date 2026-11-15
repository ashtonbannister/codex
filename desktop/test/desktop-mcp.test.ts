import assert from "node:assert/strict";
import test from "node:test";
import { DesktopControlSession } from "../src/main/services/desktop-control";
import { startDesktopMcp } from "../src/main/services/desktop-mcp";

test("desktop MCP requires a per-run token and origin-free loopback requests", async (t) => {
  let approvals = 0;
  const session = new DesktopControlSession(async (args) => args[0] === "list-windows" ? JSON.stringify([]) : "{}", async () => { approvals++; return true; }, process.cwd());
  const bridge = await startDesktopMcp(session, new AbortController().signal);
  t.after(bridge.dispose);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const send = (headers: Record<string, string>, payload = body) => fetch(bridge.url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: payload });
  assert.equal((await send({})).status, 401);
  assert.equal((await send({ Authorization: `Bearer ${bridge.token}`, Origin: "https://attacker.invalid" })).status, 401);
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const list = await (await send(headers)).json() as { result: { tools: Array<{ name: string }> } };
  assert.equal(list.result.tools[0]?.name, "desktop");
  const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "desktop", arguments: { action: "list" } } });
  const result = await (await send(headers, call)).json() as { result: { isError: boolean } };
  assert.equal(result.result.isError, false);
  assert.equal(approvals, 1);
  await bridge.dispose();
  await assert.rejects(send(headers));
});
