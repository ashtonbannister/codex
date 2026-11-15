import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifiedPermissionFileDigest } from "../src/main/services/verified-permission-file";
import { authorizeThreadPermission, stablePermissionText, ThreadPermissionStore, type PermissionContext } from "../src/main/services/thread-permissions";

const encryption = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 0xa5)), decryptString: (data: Buffer) => Buffer.from(data.map((byte) => byte ^ 0xa5)).toString("utf8") };
const context: PermissionContext = { threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", provider: "codex", model: "model-a", mode: "plan", worker: "parent" };
const scope = { kind: "plugin-tool", server: "fixture", arguments: { message: "synthetic-private-value" } };

test("always grants persist only for the exact chat, provider, model, mode, worker, and inputs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-permissions-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ThreadPermissionStore(root, encryption); await store.load(); let prompts = 0;
  assert.equal(await authorizeThreadPermission(store, context, scope, async (remember) => { prompts++; assert.equal(remember, true); return 2; }), true);
  assert.equal(await authorizeThreadPermission(store, context, scope, async () => { prompts++; return 0; }), true); assert.equal(prompts, 1);
  const data = await readFile(path.join(root, "thread-permissions.bin")); assert.doesNotMatch(data.toString(), /synthetic-private-value/);
  const loaded = new ThreadPermissionStore(root, encryption); await loaded.load(); assert.equal(loaded.has(context, scope), true);
  for (const changed of [{ ...context, threadId: "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff" }, { ...context, provider: "claude" }, { ...context, model: "model-b" }, { ...context, mode: "build" as const }, { ...context, worker: "fork:task" }]) assert.equal(loaded.has(changed, scope), false);
  assert.equal(loaded.has(context, { ...scope, arguments: { message: "different" } }), false);
  const credentialScope = { kind: "plugin-tool", authority: { bearer: "synthetic-token-one" }, arguments: { secret: "synthetic-secret-one" } };
  await loaded.grant(context, credentialScope, loaded.revision(context.threadId));
  assert.equal(loaded.has(context, { ...credentialScope, authority: { bearer: "synthetic-token-two" } }), false);
  assert.equal(loaded.has(context, { ...credentialScope, arguments: { secret: "synthetic-secret-two" } }), false);
  assert.doesNotMatch((await readFile(path.join(root, "thread-permissions.bin"))).toString(), /synthetic-token-one|synthetic-secret-one/);
  const clear = loaded.clear(context.threadId); assert.equal(loaded.has(context, scope), false); await clear; assert.equal(loaded.has(context, scope), false);
});

test("one-time and denied requests are not saved, and a pending approval cannot undo a clear", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-permissions-")); t.after(() => rm(root, { recursive: true, force: true })); const store = new ThreadPermissionStore(root, encryption); await store.load();
  assert.equal(await authorizeThreadPermission(store, context, scope, async () => 1), true); assert.equal(store.has(context, scope), false);
  assert.equal(await authorizeThreadPermission(store, context, scope, async () => 0), false); assert.equal(store.has(context, scope), false);
  assert.equal(await authorizeThreadPermission(store, context, undefined, async (remember) => { assert.equal(remember, false); return 2; }), false);
  assert.equal(await authorizeThreadPermission(undefined, context, scope, async (remember) => { assert.equal(remember, false); return 1; }), true);
  assert.equal(await authorizeThreadPermission(store, context, { huge: "x".repeat(300000) }, async (remember) => { assert.equal(remember, false); return 1; }), true);
  await assert.rejects(authorizeThreadPermission(store, context, scope, async () => { await store.clear(context.threadId); return 2; }), /changed while approval was pending/); assert.equal(store.has(context, scope), false);
});


test("temporary copy paths normalize without colliding with literal text", () => {
  assert.deepEqual(stablePermissionText("C:/run-a/file", { package: "C:/run-a" }), stablePermissionText("C:/run-b/file", { package: "C:/run-b" }));
  assert.notDeepEqual(stablePermissionText("C:/run-a/file", { package: "C:/run-a" }), stablePermissionText("<package>/file", { package: "C:/run-a" }));
});


test("external executable changes alter the remembered permission scope", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-permission-file-")); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "fixture.bin"); await writeFile(file, "first-version"); const before = await lstat(file); const first = await verifiedPermissionFileDigest({ path: file, dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs });
  await writeFile(file, "other-version"); const after = await lstat(file); const second = await verifiedPermissionFileDigest({ path: file, dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs }); assert.notEqual(first, second);
});
