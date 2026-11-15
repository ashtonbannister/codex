import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { BundleConfigStore } from "../src/main/services/bundle-config-store";
import { preparePluginLaunch } from "../src/main/services/plugin-config";
import { startPluginMcp } from "../src/main/services/plugin-mcp";

test("plugin settings are encrypted and reviewed before a local server receives them", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-config-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, "plugin"); await mkdir(source);
  await writeFile(path.join(source, "server.mjs"), await readFile(path.resolve("test/fixtures/mcp-server.mjs")));
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "fixture", userConfig: {
    token: { type: "string", title: "Token", description: "Secret", required: true, sensitive: true },
    mode: { type: "string", title: "Mode", description: "Choice", options: ["fast", "slow"], default: "fast" },
    tags: { type: "string", title: "Tags", description: "Labels", multiple: true }
  }, mcpServers: { fixture: { command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs", "${user_config.tags}"], env: { AUTH: "${user_config.token}", MODE: "${user_config.mode}" } } } }));
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source);
  assert.equal(preview.bundleFields?.length, 3); assert.deepEqual(preview.bundleFields?.find((f) => f.key === "mode")?.options, ["fast", "slow"]);
  const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true);
  const copies = await store.prepareRun();
  const identity = { id: pkg.id, fingerprint: pkg.fingerprint };
  const encryption = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(Buffer.from(text).map((x) => x ^ 0xa5)), decryptString: (data: Buffer) => Buffer.from(data.map((x) => x ^ 0xa5)).toString("utf8") };
  const settings = new BundleConfigStore(root, encryption);
  const token = (await store.bundleField(pkg.id, "token")).definition, tags = (await store.bundleField(pkg.id, "tags")).definition, mode = (await store.bundleField(pkg.id, "mode")).definition;
  await assert.rejects(startPluginMcp(copies.packages, async () => true, new AbortController().signal), /Configure Token/);
  assert.throws(() => settings.set(identity, mode, "other"), /Invalid option/);
  await settings.set(identity, token, "synthetic-secret"); await settings.set(identity, tags, ["first", "second"]);
  assert.doesNotMatch((await readFile(path.join(root, "bundle-settings.bin"))).toString(), /synthetic-secret/);
  const launch = await preparePluginLaunch(copies.packages[0]!.servers[0]!, copies.packages[0]!.root, process.env, { dataDir: copies.packages[0]!.dataDir, projectDir: root, bundleValues: settings.get(identity) });
  assert.equal(launch.env.AUTH, "synthetic-secret"); assert.equal(launch.env.MODE, "fast"); assert.deepEqual(launch.args.slice(-2), ["first", "second"]);
  const reviews: string[] = []; const gateway = await startPluginMcp(copies.packages, async (request) => { reviews.push(request.detail); return true; }, new AbortController().signal, root, undefined, undefined, { values: () => settings.get(identity), paths: {} });
  await gateway.dispose(); await copies.dispose(); assert.doesNotMatch(reviews.join(" "), /synthetic-secret/); assert.match(reviews[0]!, /\[redacted\]/); assert.match(reviews[0]!, /fast/);
});
