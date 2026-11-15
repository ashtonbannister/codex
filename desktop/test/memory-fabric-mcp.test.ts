import assert from "node:assert/strict";
import test from "node:test";
import type { FabricSource } from "../src/shared/memory-fabric";
import { startMemoryMcp } from "../src/main/services/memory-fabric/mcp";
import { providerArguments } from "../src/main/services/providers";

const body = "Keep rear camber at −1.5°, not −3.2°. This is a simulation target.";
const source: FabricSource = {
  id: "source-one", key: "message-one", projectId: "project-one", kind: "user", title: "Exact constraint",
  observedAt: "2026-11-15T00:00:00Z", createdAt: "2026-11-15T00:00:00Z", sha256: "a".repeat(64),
  status: "active", compressedBytes: 60, coverage: { status: "complete", omissions: [], retainedCharacters: body.length },
  capsule: { version: 1, spans: [{ start: 0, end: body.length, text: body }], omittedRanges: [], sourceCharacters: body.length, retainedCharacters: body.length, protectedValues: ["−1.5", "−3.2"], lossy: false },
};

test("memory MCP exposes only authenticated read tools scoped to disclosed source IDs", async (t) => {
  let searches = 0;
  let reads = 0;
  let wrongProject = false;
  const gateway = await startMemoryMcp({
    projectId: "project-one",
    search: async (query) => {
      searches++;
      assert.equal(query.limit, 6);
      assert.equal((query as Record<string, unknown>).projectId, undefined);
      return { items: [{ source: wrongProject ? { ...source, projectId: "project-two" } : source, excerpt: body, start: 0, end: body.length, score: 1 }], total: 1, offset: 0, limit: 6, watermark: 1 };
    },
    read: async (request) => {
      reads++;
      assert.equal(request.id, source.id);
      const offset = request.offset ?? 0;
      const text = body.slice(offset, offset + (request.limit ?? 4_000));
      return { source, text, offset, totalCharacters: body.length, nextOffset: offset + text.length < body.length ? offset + text.length : undefined };
    },
  }, new AbortController().signal);
  t.after(() => gateway.dispose());
  const send = async (id: number, method: string, params: unknown = {}) => (await (await fetch(gateway.url, {
    method: "POST", headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  })).json()) as any;
  assert.equal((await fetch(gateway.url, { method: "POST", body: "{}" })).status, 401);
  const list = await send(1, "tools/list");
  assert.deepEqual(list.result.tools.map((tool: { name: string }) => tool.name), ["memory_search", "memory_read"]);
  assert.ok(list.result.tools.every((tool: any) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  const direct = await send(2, "tools/call", { name: "memory_read", arguments: { id: source.id } });
  assert.equal(direct.result.isError, true);
  assert.equal(reads, 0);
  const override = await send(3, "tools/call", { name: "memory_search", arguments: { query: "camber", projectId: "project-two" } });
  assert.equal(override.result.isError, true);
  assert.equal(searches, 0);
  const found = await send(4, "tools/call", { name: "memory_search", arguments: { query: "camber" } });
  assert.equal(found.result.isError, false);
  const searchResult = JSON.parse(found.result.content[0].text);
  assert.equal(searchResult.referenceDataOnly, true);
  assert.equal(searchResult.items[0].source.id, source.id);
  assert.equal(searchResult.items[0].source.capsule, undefined, "Do not transmit large storage views as tool metadata");
  const read = await send(5, "tools/call", { name: "memory_read", arguments: { id: source.id, offset: 5, limit: 20 } });
  const page = JSON.parse(read.result.content[0].text);
  assert.equal(page.text, body.slice(5, 25));
  assert.equal(page.nextOffset, 25);
  const write = await send(6, "tools/call", { name: "memory_write", arguments: {} });
  assert.equal(write.result.isError, true);
  wrongProject = true;
  const escaped = await send(7, "tools/call", { name: "memory_search", arguments: { query: "private" } });
  assert.equal(escaped.result.isError, true);
  assert.doesNotMatch(escaped.result.content[0].text, /−1\.5/);
});

test("memory MCP honors source revocation and bounds text pages", async (t) => {
  let revoked = false;
  let reads = 0;
  const gateway = await startMemoryMcp({
    projectId: source.projectId, initialSourceIds: [source.id],
    assertAvailable: () => { if (revoked) throw new Error("Memory scope was revoked."); },
    search: async () => ({ items: [], total: 0, offset: 0, limit: 6, watermark: 0 }),
    read: async () => { reads++; return { source, text: body, offset: 0, totalCharacters: body.length }; },
  }, new AbortController().signal);
  t.after(() => gateway.dispose());
  const send = async (id: number, args: unknown) => (await (await fetch(gateway.url, {
    method: "POST", headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "memory_read", arguments: args } }),
  })).json()) as any;
  assert.equal((await send(1, { id: source.id, limit: 100_000 })).result.isError, true);
  assert.equal(reads, 0);
  assert.equal((await send(2, { id: source.id })).result.isError, false);
  revoked = true;
  const rejected = await send(3, { id: source.id });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /revoked/);
  assert.equal(reads, 1);
});

test("memory provider wiring preserves explicit tools and enforced Claude safe mode", () => {
  const memoryMcpUrl = "http://127.0.0.1:43210/mcp";
  const before = process.env.CLAUDE_CODE_SAFE_MODE;
  try {
    delete process.env.CLAUDE_CODE_SAFE_MODE;
    for (const provider of ["codex", "ollama"] as const) {
      const args = providerArguments(provider, "/fixture", "plan", "", { memoryMcpUrl });
      assert.ok(args.includes(`mcp_servers.nova_memory.url="${memoryMcpUrl}"`));
      assert.ok(args.includes('mcp_servers.nova_memory.bearer_token_env_var="NOVA_MEMORY_TOKEN"'));
      assert.ok(args.includes("read-only"));
      assert.ok(args.includes("--ignore-user-config"));
    }
    const args = providerArguments("claude", "/fixture", "plan", "", { memoryMcpUrl, desktopMcpUrl: memoryMcpUrl });
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!);
    assert.deepEqual(Object.keys(config.mcpServers).sort(), ["nova_desktop", "nova_memory"]);
    assert.equal(config.mcpServers.nova_memory.headers.Authorization, "Bearer ${NOVA_MEMORY_TOKEN}");
    assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
    const allowed = args[args.indexOf("--allowedTools") + 1]!;
    assert.ok(allowed.includes("mcp__nova_memory__memory_search"));
    assert.ok(allowed.includes("mcp__nova_memory__memory_read"));
    assert.ok(!allowed.includes("mcp__nova_memory__*"));
    const unchanged = providerArguments("claude", "/fixture", "plan", "");
    assert.ok(unchanged.includes("--safe-mode"));
    assert.ok(unchanged.includes("mcp__*"));
    process.env.CLAUDE_CODE_SAFE_MODE = "1";
    const enforced = providerArguments("claude", "/fixture", "plan", "", { memoryMcpUrl });
    assert.ok(enforced.includes("--safe-mode"));
    assert.deepEqual(JSON.parse(enforced[enforced.indexOf("--mcp-config") + 1]!).mcpServers, {});
    assert.ok(!enforced.join(" ").includes("NOVA_MEMORY_TOKEN"));
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CODE_SAFE_MODE;
    else process.env.CLAUDE_CODE_SAFE_MODE = before;
  }
});
