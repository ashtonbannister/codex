import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { DEFAULT_SETTINGS } from "../src/shared/types";
import type { LocalConnection } from "../src/shared/local-models";
import {
  assertLocalModelAvailable,
  connectionFromSettings,
  listLocalModels,
  prepareLocalProvider,
  validateLocalConnection,
} from "../src/main/services/local-models";
import { responsesToChat, startLocalChatBridge } from "../src/main/services/local-chat-bridge";
import { providerArguments } from "../src/main/services/providers";

type Json = Record<string, any>;
async function localServer(t: TestContext, handle: (path: string, body: Json, response: ServerResponse) => void) {
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    handle(request.url ?? "", text ? JSON.parse(text) : {}, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/v1`;
}
function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
function stream(response: ServerResponse, chunks: Json[], done = true) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end(done ? "data: [DONE]\n\n" : "");
}
function events(text: string): Json[] {
  return text.split("\n\n").map((entry) => entry.split("\n").find((line) => line.startsWith("data: "))?.slice(6)).filter(Boolean).map((data) => JSON.parse(data!));
}
const connection = (baseUrl: string, kind: LocalConnection["kind"] = "custom"): LocalConnection => ({ kind, baseUrl, protocol: "chat-completions" });

test("local endpoints validate scope, canonicalize localhost, and retain provider defaults", () => {
  assert.equal(validateLocalConnection(connection("http://localhost:1234/v1/")).baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(connectionFromSettings({ ...DEFAULT_SETTINGS, localProvider: "lmstudio", localBaseUrl: undefined, localProtocol: undefined }).baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(validateLocalConnection(connection("http://[::1]:1234/v1")).baseUrl, "http://[::1]:1234/v1");
  for (const url of ["https://example.com/v1", "http://0.0.0.0:8000/v1", "http://localhost.evil/v1", "http://user:secret@127.0.0.1/v1", "http://127.0.0.1/v1?key=x", "http://127.0.0.1/v1#x", "file:///tmp/model", "http://127.0.0.1/v1/chat/completions", "http://127.0.0.1/%2Fv1"])
    assert.throws(() => validateLocalConnection(connection(url)));
});

test("local model discovery only lists metadata and excludes remote Ollama entries", async (t) => {
  const paths: string[] = [];
  const base = await localServer(t, (path, _body, response) => {
    paths.push(path);
    json(response, path === "/api/tags"
      ? { models: [{ name: "tiny:latest" }, { name: "remote:cloud" }, { name: "external", remote_host: "remote.example" }] }
      : { data: [{ id: "local-a" }, { id: "local-a" }, { id: "local-b" }] });
  });
  const ollama = await listLocalModels(connection(base, "ollama"));
  assert.deepEqual(ollama.models, [{ id: "tiny:latest" }]);
  assert.ok(ollama.warnings.some((warning) => warning.includes("2 remote")));
  const custom = await listLocalModels(connection(base));
  assert.deepEqual(custom.models, [{ id: "local-a" }, { id: "local-b" }]);
  await assertLocalModelAvailable("tiny", { ...DEFAULT_SETTINGS, localBaseUrl: base });
  await assert.rejects(assertLocalModelAvailable("not-installed", { ...DEFAULT_SETTINGS, localBaseUrl: base }), /not listed/);
  assert.ok(paths.every((path) => path === "/api/tags" || path === "/v1/models"));
});

test("model discovery rejects redirects and malformed catalogs", async (t) => {
  let mode = "redirect";
  const base = await localServer(t, (_path, _body, response) => {
    if (mode === "redirect") { response.writeHead(302, { Location: "https://example.com" }); response.end(); }
    else json(response, { data: [{ id: 42 }] });
  });
  await assert.rejects(listLocalModels(connection(base)), /not reachable/);
  mode = "bad";
  await assert.rejects(listLocalModels(connection(base)), /invalid model identifier/);
});

test("Responses translation preserves text, namespace/custom tools and tool-result history", () => {
  const converted = responsesToChat({
    model: "tiny",
    instructions: "system rule",
    input: [
      { role: "developer", content: [{ type: "input_text", text: "project rule" }] },
      { role: "user", content: "change it" },
      { type: "custom_tool_call", namespace: "functions", name: "apply_patch", call_id: "call_a", input: "*** Begin Patch" },
      { type: "custom_tool_call_output", call_id: "call_a", output: [{ type: "input_text", text: "Done" }] },
    ],
    tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "apply_patch", description: "Patch files", format: { type: "grammar", syntax: "lark", definition: 'start: "*** Begin Patch"' } }] }],
  }, "tiny");
  const messages = converted.body.messages as Json[];
  assert.deepEqual(messages.map((entry) => entry.role), ["system", "system", "user", "assistant", "tool"]);
  assert.deepEqual(JSON.parse(messages[3].tool_calls[0].function.arguments), { input: "*** Begin Patch" });
  assert.equal(messages[4].content, "Done");
  const alias = (converted.body.tools as Json[])[0].function.name;
  assert.match((converted.body.tools as Json[])[0].function.description, /start: "\*\*\* Begin Patch"/);
  assert.equal(messages[3].tool_calls[0].function.name, alias);
  assert.deepEqual(converted.tools.get(alias), { name: "apply_patch", namespace: "functions", custom: true });
  assert.throws(() => responsesToChat({ model: "tiny", input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,x" }] }] }, "tiny"), /text only/);
  assert.throws(() => responsesToChat({ model: "tiny", previous_response_id: "secret-native", input: "x" }, "tiny"), /full visible input/);
  assert.throws(() => responsesToChat({ model: "other", input: "x" }, "tiny"), /different/);
});

test("chat bridge streams text and function calls, then accepts a tool-result follow-up", async (t) => {
  const received: Json[] = [];
  const base = await localServer(t, (_path, body, response) => {
    received.push(body);
    if (received.length === 1) {
      stream(response, [
        { choices: [{ index: 0, delta: { content: "Reading…" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } },
      ]);
    } else stream(response, [{ choices: [{ index: 0, delta: { content: "The résumé is ready." }, finish_reason: "stop" }] }]);
  });
  const controller = new AbortController();
  const bridge = await startLocalChatBridge(connection(base), "tiny", controller.signal, { timeoutMs: 5000, maxBytes: 100000 });
  t.after(bridge.dispose);
  const request = { model: "tiny", input: [{ role: "user", content: "Read README" }], tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } }] };
  const send = (body: Json) => fetch(`${bridge.baseUrl}/responses`, { method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const first = events(await (await send(request)).text());
  assert.equal(first[0].type, "response.created");
  const completed = first.find((entry) => entry.type === "response.completed");
  assert.ok(completed);
  assert.deepEqual(completed.response.usage, { input_tokens: 12, output_tokens: 8, total_tokens: 20 });
  const tool = completed.response.output.find((entry: Json) => entry.type === "function_call");
  assert.equal(tool.name, "read_file");
  assert.equal(tool.arguments, '{"path":"README.md"}');
  const second = events(await (await send({ ...request, input: [...request.input, tool, { type: "function_call_output", call_id: "call_1", output: "A README" }] })).text());
  assert.ok(second.some((entry) => entry.type === "response.output_text.delta" && entry.delta.includes("résumé")));
  assert.ok(second.some((entry) => entry.type === "response.completed"));
  assert.equal(received[1].messages.at(-1).role, "tool");
  assert.equal(received[1].messages.at(-1).content, "A README");
});

test("chat bridge returns a custom namespace tool with raw text input", async (t) => {
  const base = await localServer(t, (_path, body, response) => {
    stream(response, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "patch_1", type: "function", function: { name: body.tools[0].function.name, arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }) } }] }, finish_reason: "tool_calls" }] }]);
  });
  const bridge = await startLocalChatBridge(connection(base), "tiny", new AbortController().signal, { timeoutMs: 5000, maxBytes: 100000 });
  t.after(bridge.dispose);
  const response = await fetch(`${bridge.baseUrl}/responses`, { method: "POST", headers: { Authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ model: "tiny", input: "patch", stream: false, tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "apply_patch" }] }] }) });
  const result = await response.json() as Json;
  assert.equal(result.status, "completed");
  assert.equal(result.output[0].type, "custom_tool_call");
  assert.equal(result.output[0].namespace, "functions");
  assert.equal(result.output[0].input, "*** Begin Patch\n*** End Patch");
});

test("chat bridge refuses unauthorized callers, unoffered tools and incomplete output", async (t) => {
  let upstreamCalls = 0;
  let mode = "tool";
  const base = await localServer(t, (_path, _body, response) => {
    upstreamCalls++;
    if (mode === "tool") stream(response, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "x", type: "function", function: { name: "not_offered", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }]);
    else stream(response, [{ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "length" }] }]);
  });
  const bridge = await startLocalChatBridge(connection(base), "tiny", new AbortController().signal, { timeoutMs: 5000, maxBytes: 100000 });
  t.after(bridge.dispose);
  const endpoint = `${bridge.baseUrl}/responses`;
  const body = JSON.stringify({ model: "tiny", input: "x" });
  const unauthorized = await fetch(endpoint, { method: "POST", body });
  assert.equal(unauthorized.status, 401);
  assert.equal(upstreamCalls, 0);
  const headers = { Authorization: `Bearer ${bridge.token}` };
  const forbiddenOrigin = await fetch(endpoint, { method: "POST", headers: { ...headers, Origin: "https://example.com" }, body });
  assert.equal(forbiddenOrigin.status, 401);
  for (const state of ["tool", "length"]) {
    mode = state;
    const response = await fetch(endpoint, { method: "POST", headers, body });
    const output = events(await response.text());
    assert.ok(output.some((entry) => entry.type === "response.failed"));
    assert.ok(!output.some((entry) => entry.type === "response.completed"));
  }
});

test("bridge cancellation closes listener and aborts its in-flight upstream", async (t) => {
  let upstreamStarted!: () => void;
  const started = new Promise<void>((resolve) => { upstreamStarted = resolve; });
  const base = await localServer(t, (_path, _body, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"index":0,"delta":{"content":"working"},"finish_reason":null}]}\n\n');
    upstreamStarted();
  });
  const abort = new AbortController();
  const bridge = await startLocalChatBridge(connection(base), "tiny", abort.signal, { timeoutMs: 5000, maxBytes: 100000 });
  t.after(bridge.dispose);
  const pending = fetch(`${bridge.baseUrl}/responses`, { method: "POST", headers: { Authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ model: "tiny", input: "x" }) }).then((response) => response.text()).catch(() => "cancelled");
  await started;
  abort.abort();
  await bridge.dispose();
  await pending;
  await assert.rejects(fetch(`${bridge.baseUrl}/responses`));
});

test("provider preparation does not run inference and keeps ephemeral auth out of argv", async (t) => {
  let completions = 0;
  const base = await localServer(t, (path, _body, response) => {
    if (path === "/v1/models") json(response, { data: [{ id: "tiny" }] });
    else { completions++; json(response, {}); }
  });
  const settings = { ...DEFAULT_SETTINGS, localProvider: "custom" as const, localBaseUrl: base, localProtocol: "chat-completions" as const };
  const prepared = await prepareLocalProvider(settings, "tiny", new AbortController().signal);
  t.after(prepared.dispose);
  assert.equal(completions, 0);
  assert.ok(prepared.env?.NOVA_LOCAL_BRIDGE_AUTH?.startsWith("Bearer "));
  assert.ok(!prepared.configArgs.join(" ").includes(prepared.env!.NOVA_LOCAL_BRIDGE_AUTH));
  const args = providerArguments("ollama", "/synthetic/repo", "plan", "tiny", { localConfigArgs: prepared.configArgs });
  assert.ok(args.includes('model_provider="nova_local"'));
  assert.ok(!args.some((arg) => arg.includes("11434")));
  assert.ok(args.includes("read-only"));
  const direct = await prepareLocalProvider({ ...settings, localProtocol: "responses" }, "tiny", new AbortController().signal);
  assert.equal(direct.env, undefined);
  assert.ok(direct.configArgs.includes(`model_providers.nova_local.base_url=${JSON.stringify(base)}`));
  await direct.dispose();
});
