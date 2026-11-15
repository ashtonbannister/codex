import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { findPluginCommand } from "../src/main/services/plugin-commands";

test("command-only plugins expose explicitly invoked commands with arguments and normal permissions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-commands-")); t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const source = path.join(root, "source"); await mkdir(path.join(source, ".claude-plugin"), { recursive: true }); await mkdir(path.join(source, "commands"));
  await writeFile(path.join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fixture", commands: { review: { source: "./commands/review.md", argumentHint: "[file]", allowedTools: ["Read"] }, about: { content: "About this plugin." } } }));
  await writeFile(path.join(source, "commands", "review.md"), '---\ndescription: Review a file\n---\nReview $0 with $1. All: $ARGUMENTS. Escaped: \$2. Missing: $3. Root: ${CLAUDE_PLUGIN_ROOT}');
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source);
  assert.deepEqual(preview.servers, []); assert.equal(preview.commands!.length, 2); assert.match(preview.commands![0]!.warnings.join(" "), /not granted/);
  assert.doesNotMatch(JSON.stringify(preview.commands), /Review \$0 with/);
  const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true); const copies = await store.prepareRun('/fixture:review "two words" file');
  const command = findPluginCommand('/fixture:review "two words" file', copies.packages, root)!;
  assert.match(command.content, /Review two words with file/); assert.match(command.content, /All: "two words" file/); assert.match(command.content, /Escaped: \$2/); assert.match(command.content, /Missing: \$3/); assert.ok(command.content.includes(copies.packages[0]!.providerRoot!));
  assert.match(command.warnings.join(" "), /not granted/); assert.equal(findPluginCommand("ordinary question", copies.packages, root), undefined);
  assert.throws(() => findPluginCommand('/fixture:review "unterminated', copies.packages, root), /unterminated/);
  assert.throws(() => findPluginCommand('/fixture:missing', copies.packages, root), /No enabled plugin/);
  assert.throws(() => findPluginCommand('/fixture:review file', [copies.packages[0]!, copies.packages[0]!], root), /More than one/);
  await copies.dispose();
});

test("unsupported command execution features stay unavailable and paths cannot escape", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-commands-invalid-")); t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "source"); await mkdir(path.join(source, "commands"), { recursive: true });
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "fixture" }));
  await writeFile(path.join(source, "commands", "unsafe.md"), "---\ndescription: Unsafe\nuser-invocable: no\n---\nInspect !`some-command`\n");
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source); assert.match(preview.commands![0]!.unsupported.join(" "), /shell interpolation/); assert.match(preview.commands![0]!.unsupported.join(" "), /not user-invocable/);
  const pkg = await store.install(source, preview.fingerprint); await assert.rejects(store.setEnabled(pkg.id, true), /no supported skills, commands or selected server/i);
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "fixture", commands: "../outside.md" })); await assert.rejects(store.preview(source), /inside the selected folder/);
});


test("plugin commands expand reviewed settings without exposing sensitive values or recursively expanding input", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-command-config-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, "source"); await mkdir(source);
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "fixture", userConfig: {
    audience: { type: "string", title: "Audience", description: "Who", required: true },
    token: { type: "string", title: "Token", description: "Secret", sensitive: true },
  }, commands: { explain: { content: "Audience ${user_config.audience}; token ${user_config.token}; input $ARGUMENTS" }, invalid: { content: "${user_config.unknown}" } } }));
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source);
  assert.match(preview.commands!.find((item) => item.name === "invalid")!.unsupported.join(" "), /undeclared/);
  const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true);
  const copies = await store.prepareRun("/fixture:explain example");
  assert.throws(() => findPluginCommand("/fixture:explain example", copies.packages, root), /Configure Audience/);
  const settings = { values: () => ({ audience: "${CLAUDE_PLUGIN_ROOT}", token: "synthetic-secret" }), paths: {} };
  const command = findPluginCommand("/fixture:explain ${user_config.token}", copies.packages, root, false, settings)!;
  assert.match(command.content, /Audience \$\{CLAUDE_PLUGIN_ROOT\}/); assert.match(command.content, /token \[sensitive setting withheld\]/); assert.match(command.content, /input \$\{user_config.token\}/);
  assert.doesNotMatch(JSON.stringify(command), /synthetic-secret/); assert.equal(command.settings?.find((item) => item.name === "token")?.value, "[sensitive setting withheld]");
  const previewCommand = await store.previewCommand("/fixture:explain example", root, settings); assert.match(previewCommand!.content, /sensitive setting withheld/);
  await copies.dispose();
});
