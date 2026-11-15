import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalKeyStore } from "../src/main/services/local-key-store";
import { validateLocalConnection } from "../src/main/services/local-models";

test("encrypted local keys persist, remain scoped, and can be replaced or removed", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nova-key-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secret = randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secret, iv);
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(value: Buffer) {
      const decipher = createDecipheriv("aes-256-gcm", secret, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
  const a = validateLocalConnection({ kind: "custom", baseUrl: "http://127.0.0.1:8080/v1", protocol: "chat-completions" });
  const b = validateLocalConnection({ ...a, baseUrl: "http://127.0.0.1:8081/v1" });
  const store = new LocalKeyStore(dir, encryption);
  await store.load();
  await store.set(a, "synthetic-secret");
  assert.equal((await readFile(path.join(dir, "local-server-keys.bin"))).includes(Buffer.from("synthetic-secret")), false);
  const reopened = new LocalKeyStore(dir, encryption);
  await reopened.load();
  assert.equal(reopened.get(a), "synthetic-secret");
  assert.equal(reopened.get(b), undefined);
  await reopened.set(a, "replacement");
  const updated = new LocalKeyStore(dir, encryption);
  await updated.load();
  assert.equal(updated.get(a), "replacement");
  await updated.set(a, "");
  const removed = new LocalKeyStore(dir, encryption);
  await removed.load();
  assert.equal(removed.get(a), undefined);
});
