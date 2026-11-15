import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { renderExplicitSkill } from "../src/main/services/skill-selection";

test("plugin skills substitute reviewed settings in fingerprinted copies and withhold secrets", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-skill-config-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, "source"); await mkdir(path.join(source, "skills", "demo"), { recursive: true }); await mkdir(path.join(source, "skills", "invalid"), { recursive: true });
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "fixture", userConfig: {
    audience: { type: "string", title: "Audience", description: "Who", required: true },
    token: { type: "string", title: "Token", description: "Secret", sensitive: true }
  } }));
  await writeFile(path.join(source, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\nAudience ${user_config.audience}; secret ${user_config.token}; input $ARGUMENTS\n");
  await writeFile(path.join(source, "skills", "invalid", "SKILL.md"), "---\nname: invalid\ndescription: Invalid\n---\n${user_config.missing}\n");
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source);
  assert.deepEqual(preview.skills.find((item) => item.name === "demo")?.unsupported, []); assert.match(preview.skills.find((item) => item.name === "invalid")!.unsupported!.join(" "), /undeclared/);
  const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true);
  await assert.rejects(store.prepareRun("", "codex"), /Configure Audience/);
  const settings = { values: () => ({ audience: "${CLAUDE_PLUGIN_ROOT}", token: "synthetic-secret" }), paths: {} };
  const copies = await store.prepareRun("/fixture:demo hello", "codex", settings); const item = copies.packages[0]!;
  const providerFile = path.join(item.providerRoot!, "skills", "demo", "SKILL.md"); const content = await readFile(providerFile, "utf8");
  assert.match(content, /Audience \$\{CLAUDE_PLUGIN_ROOT\}/); assert.match(content, /secret \[sensitive setting withheld\]/); assert.doesNotMatch(content, /synthetic-secret/);
  assert.equal(copies.skillSettings[0]!.settings.find((entry) => entry.name === "token")!.value, "[sensitive setting withheld]"); assert.doesNotMatch(JSON.stringify(copies.skillSettings), /synthetic-secret/);
  const explicit = await renderExplicitSkill(copies.invoked[0]!, root, "codex"); assert.match(explicit.content, /Audience \$\{CLAUDE_PLUGIN_ROOT\}/); assert.match(explicit.content, /input hello/); assert.doesNotMatch(explicit.content, /synthetic-secret/);
  const previewSkill = (await store.previewInvoked("/fixture:demo hello", settings))[0]!; assert.equal((await renderExplicitSkill(previewSkill, root, "codex")).content, explicit.content);
  await copies.verifyProviders(); await writeFile(providerFile, "tampered"); await assert.rejects(copies.verifyProviders(), /changed after sharing/); await copies.dispose();
});
