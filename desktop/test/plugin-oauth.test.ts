import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginOAuthStore } from "../src/main/services/plugin-oauth-store";
import { signInPluginOAuth, pluginOAuthToken } from "../src/main/services/plugin-oauth";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { startPluginMcp } from "../src/main/services/plugin-mcp";

const encryption = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xa5)), decryptString: (value: Buffer) => Buffer.from(value.map((byte) => byte ^ 0xa5)).toString("utf8") };

test("OAuth sign-in validates state, uses PKCE, encrypts the grant, and refreshes it", async (t) => {
  let challenge = ""; let redirect = ""; let exchange = 0; let refresh = 0; let origin = ""; let authenticatedRequests = 0; let registrations = 0;
  const server = createServer(async (request, response) => {
    const endpoint = new URL(request.url!, origin); let data = ""; for await (const part of request) data += part;
    if (endpoint.pathname === "/mcp") {
      assert.equal(request.headers["x-resource"], "synthetic-tenant");
      if (request.headers.authorization === "Bearer synthetic-access") {
        if (request.method !== "POST") { response.writeHead(405).end(); return; }
        authenticatedRequests++; const message = JSON.parse(data);
        if (message.id === undefined) { response.writeHead(202).end(); return; }
        const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } } : message.method === "tools/call" ? { content: [{ type: "text", text: "authenticated result" }] } : { tools: [{ name: "read", inputSchema: { type: "object" } }] };
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); return;
      }
      response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end(); return;
    }
    if (endpoint.pathname === "/.well-known/oauth-protected-resource/mcp") { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] })); return; }
    if (endpoint.pathname === "/.well-known/oauth-authorization-server") { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true })); return; }
    if (endpoint.pathname === "/register") { registrations++; assert.equal(request.headers["x-resource"], undefined); const config = JSON.parse(data); redirect = config.redirect_uris[0]; response.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ ...config, client_id: "synthetic-client", token_endpoint_auth_method: "none" })); return; }
    if (endpoint.pathname === "/token") {
      const form = new URLSearchParams(data);
      if (form.get("grant_type") === "authorization_code") { exchange++; assert.equal(form.get("code"), "synthetic-code"); assert.equal(form.get("redirect_uri"), redirect); assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), challenge); }
      else { refresh++; assert.equal(form.get("refresh_token"), "synthetic-refresh"); }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ access_token: refresh ? "synthetic-refreshed" : "synthetic-access", token_type: "Bearer", refresh_token: "synthetic-refresh", expires_in: 3600 })); return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test port"); origin = `http://127.0.0.1:${address.port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-oauth-"));
  const source = path.join(root, "source"); await mkdir(source);
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "synthetic-oauth" }));
  await writeFile(path.join(source, "mcp.json"), JSON.stringify({ mcpServers: { remote: { type: "streamable-http", url: `${origin}/mcp`, http_headers: { "X-Resource": "synthetic-tenant" }, extensions: { "com.openai": { auth: { type: "oauth", client: { mode: "dcr" } } } } } } }));
  const packages = new PluginPackageStore(path.join(root, "data")); const preview = await packages.preview(source); const pkg = await packages.install(source, preview.fingerprint);
  const connection = await packages.oauthConnection(pkg.id, "remote"); await packages.setEnabled(pkg.id, true);
  const copies = await packages.prepareRun(); t.after(async () => { await copies.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const store = new PluginOAuthStore(root, encryption); const reviews: string[] = [];
  await signInPluginOAuth({ ...connection, store, signal: new AbortController().signal, review: async (request) => { reviews.push(request.title); return true; }, open: async (value) => {
    const url = new URL(value); challenge = url.searchParams.get("code_challenge")!; assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const callback = new URL(url.searchParams.get("redirect_uri")!); const state = url.searchParams.get("state")!;
    callback.searchParams.set("state", "wrong"); callback.searchParams.set("code", "synthetic-code"); callback.searchParams.set("iss", origin);
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set("state", state); assert.equal((await fetch(callback)).status, 200);
  } });
  assert.equal(exchange, 1); assert.ok(reviews.includes("Open the provider sign-in page?"));
  assert.doesNotMatch((await readFile(path.join(root, "plugin-oauth.bin"))).toString(), /synthetic-access|synthetic-refresh/);
  const restored = new PluginOAuthStore(root, encryption); await restored.load();
  assert.equal(restored.get(connection.identity)!.tokens.access_token, "synthetic-access");
  assert.equal(restored.get({ ...connection.identity, fingerprint: "b".repeat(64) }), undefined);
  const actions: string[] = [];
  const gateway = await startPluginMcp(copies.packages, async (request) => { actions.push(request.action); return true; }, new AbortController().signal, process.cwd(), () => undefined, {
    has: (value) => restored.has(value), token: (value, endpoint, settings, signal) => pluginOAuthToken({ endpoint, settings, identity: value, store: restored, signal, review: async () => true }),
  });
  const send = async (id: number, method: string, params: unknown = {}) => (await (await fetch(gateway.url, { method: "POST", headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json()) as any;
  const listed = await send(1, "tools/list"); const called = await send(2, "tools/call", { name: listed.result.tools[0].name, arguments: {} });
  assert.equal(called.result.content[0].text, "authenticated result");
  assert.ok(authenticatedRequests >= 3); assert.deepEqual(actions, ["start", "discover", "call"]); await gateway.dispose();
  await assert.rejects(signInPluginOAuth({ ...connection, store: restored, signal: new AbortController().signal, review: async () => true, open: async (value) => {
    const url = new URL(value); const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("code", "synthetic-code"); callback.searchParams.set("iss", "https://wrong.invalid"); await fetch(callback);
  } }));
  assert.equal(exchange, 1);
  const cancel = new AbortController();
  await assert.rejects(signInPluginOAuth({ ...connection, store: restored, signal: cancel.signal, review: async () => true, open: async () => { cancel.abort(); } }), /cancelled/);
  assert.equal(exchange, 1);
  const expired = restored.get(connection.identity)!; expired.expiresAt = Date.now() - 1; await restored.set(connection.identity, expired);
  assert.equal(await pluginOAuthToken({ ...connection, store: restored, signal: new AbortController().signal, review: async () => true }), "synthetic-refreshed");
  assert.equal(refresh, 1); assert.equal(restored.get(connection.identity)!.tokens.access_token, "synthetic-refreshed");
  const priorRegistrations = registrations; const priorExchange = exchange;
  await signInPluginOAuth({ ...connection, settings: { clientId: "provided-client" }, store: restored, signal: new AbortController().signal, review: async () => true, open: async (value) => {
    const url = new URL(value); assert.equal(url.searchParams.get("client_id"), "provided-client"); challenge = url.searchParams.get("code_challenge")!;
    redirect = url.searchParams.get("redirect_uri")!; const callback = new URL(redirect); callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("code", "synthetic-code"); callback.searchParams.set("iss", origin); await fetch(callback);
  } });
  assert.equal(registrations, priorRegistrations); assert.equal(exchange, priorExchange + 1);
});


test("OAuth does not contact an unreviewed authorization origin", async (t) => {
  let authorizationRequests = 0;
  const authServer = createServer((_request, response) => { authorizationRequests++; response.writeHead(500).end(); });
  await new Promise<void>((resolve) => authServer.listen(0, "127.0.0.1", resolve));
  const authAddress = authServer.address(); if (!authAddress || typeof authAddress === "string") throw new Error("No test port");
  const authorizationOrigin = `http://127.0.0.1:${authAddress.port}`; let resourceOrigin = "";
  const resourceServer = createServer((request, response) => {
    if (request.url === "/mcp") response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${resourceOrigin}/.well-known/oauth-protected-resource/mcp"` }).end();
    else response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ resource: `${resourceOrigin}/mcp`, authorization_servers: [authorizationOrigin] }));
  });
  await new Promise<void>((resolve) => resourceServer.listen(0, "127.0.0.1", resolve));
  const resourceAddress = resourceServer.address(); if (!resourceAddress || typeof resourceAddress === "string") throw new Error("No test port"); resourceOrigin = `http://127.0.0.1:${resourceAddress.port}`;
  t.after(() => { resourceServer.closeAllConnections(); authServer.closeAllConnections(); resourceServer.close(); authServer.close(); });
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-oauth-deny-")); t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const store = new PluginOAuthStore(root, encryption); const identity = { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", fingerprint: "a".repeat(64), server: "remote" };
  await assert.rejects(signInPluginOAuth({ endpoint: `${resourceOrigin}/mcp`, identity, settings: {}, store, signal: new AbortController().signal, review: async () => false, open: async () => { throw new Error("Browser should not open."); } }));
  assert.equal(authorizationRequests, 0); assert.equal(store.has(identity), false);
});
