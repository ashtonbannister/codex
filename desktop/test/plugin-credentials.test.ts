import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginCredentialStore } from "../src/main/services/plugin-credentials";

const identity = { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", fingerprint: "a".repeat(64), server: "service" };
const encryption = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 0xa5)), decryptString: (data: Buffer) => Buffer.from(data.map((byte) => byte ^ 0xa5)).toString("utf8") };

test("saved plugin tokens are encrypted, isolated by package fingerprint and removable", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-credentials-"));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const store = new PluginCredentialStore(root, encryption); await store.load();
  await store.set(identity, "synthetic-token");
  assert.doesNotMatch((await readFile(path.join(root, "plugin-credentials.bin"))).toString(), /synthetic-token/);
  assert.equal(store.get(identity), "synthetic-token");
  assert.equal(store.get({ ...identity, fingerprint: "b".repeat(64) }), undefined);
  assert.equal(store.get({ ...identity, server: "other" }), undefined);
  const reloaded = new PluginCredentialStore(root, encryption); await reloaded.load();
  assert.equal(reloaded.has(identity), true); await reloaded.set(identity, ""); assert.equal(reloaded.has(identity), false);
  await assert.rejects(async () => reloaded.set(identity, "invalid token"), /without spaces/);
  const unavailable = new PluginCredentialStore(root, { ...encryption, isEncryptionAvailable: () => false });
  await assert.rejects(unavailable.load(), /encryption is unavailable/);
});
