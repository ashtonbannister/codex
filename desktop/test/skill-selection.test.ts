import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillPackageStore } from "../src/main/services/skill-packages";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { renderExplicitSkill, skillReferences } from "../src/main/services/skill-selection";

async function skill(root: string, name: string, frontmatter: string, body = "Synthetic instructions") {
  const dir = path.join(root, "skills", name); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n${frontmatter}---\n${body}\n`);
  await writeFile(path.join(dir, "support.txt"), `${name} supporting file`);
}

test("manual-only skills are excluded from automatic catalogs and copies but work when invoked", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-skill-selection-")); t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const source = path.join(root, "source"); await mkdir(source);
  await skill(source, "automatic", ""); await skill(source, "manual", "disable-model-invocation: yes\n", "Review $0 and $1. All: $ARGUMENTS. Directory: ${CLAUDE_SKILL_DIR}");
  await skill(source, "model-only", "user-invocable: no\n"); await skill(source, "forked", "context: fork\n"); await skill(source, "custom-fork", "context: fork\nagent: custom-agent\n");
  const store = new SkillPackageStore(path.join(root, "data")); const preview = await store.preview(source);
  assert.equal(preview.skills.find((item) => item.name === "manual")!.disableModelInvocation, true); assert.equal(preview.skills.find((item) => item.name === "model-only")!.userInvocable, false); assert.equal(preview.skills.find((item) => item.name === "forked")!.forkAgent, "general-purpose"); assert.match(preview.skills.find((item) => item.name === "custom-fork")!.unsupported!.join(" "), /custom fork agent/);
  const pkg = await store.install(source, preview.fingerprint); const automatic = await store.prepareRun("ordinary request");
  assert.deepEqual(automatic.review.map((item) => item.name).sort(), ["automatic", "model-only"]); assert.doesNotMatch(automatic.prompt, /manual description|forked description/);
  await assert.rejects(readFile(path.join(automatic.directory!, pkg.id, "skills", "manual", "SKILL.md")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(automatic.directory!, pkg.id, "skills", "manual", "support.txt")), { code: "ENOENT" }); await automatic.verify(); await automatic.dispose();
  const explicit = await store.prepareRun('/manual "two words" second'); assert.equal(explicit.invoked.length, 1);
  await assert.rejects(renderExplicitSkill({ ...explicit.invoked[0]!, verifiedContent: undefined }, root), /has not been verified/);
  const rendered = await renderExplicitSkill(explicit.invoked[0]!, root); assert.match(rendered.content, /Review two words and second/); assert.match(rendered.content, /All: "two words" second/); assert.ok(rendered.content.includes(path.dirname(explicit.invoked[0]!.path)));
  assert.match(explicit.prompt, /manual description/); await explicit.verify(); await explicit.dispose();
  const named = await store.prepareRun("Please use $manual"); assert.equal(named.invoked.length, 1); await named.dispose();
  const modelOnly = await store.prepareRun("/model-only"); await assert.rejects(renderExplicitSkill(modelOnly.invoked[0]!, root), /cannot be invoked directly/); await modelOnly.dispose();
  const forked = await store.prepareRun("/forked"); assert.equal(forked.invoked[0]!.descriptor.forkAgent, "general-purpose"); assert.match((await renderExplicitSkill(forked.invoked[0]!, root)).content, /Synthetic/); await forked.dispose();
  assert.equal(skillReferences('/manual "two words" second')[0]!.args, '"two words" second');
});

test("plugin provider copies omit manual-only skills until explicitly invoked", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-skill-selection-")); t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const source = path.join(root, "source"); await mkdir(source); await writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "fixture" }));
  await skill(source, "automatic", ""); await skill(source, "manual", "disable-model-invocation: true\n");
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source); const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true);
  const automatic = await store.prepareRun("ordinary request"); const entry = automatic.packages[0]!;
  assert.deepEqual(entry.skills.map((item) => item.name), ["automatic"]); assert.doesNotMatch(automatic.prompt, /manual description/); assert.ok(automatic.providerDirectory);
  await assert.rejects(readFile(path.join(entry.providerRoot!, "skills", "manual", "SKILL.md")), { code: "ENOENT" }); assert.ok(await readFile(path.join(entry.root, "skills", "manual", "SKILL.md")));
  await automatic.verifyProviders(); await automatic.dispose();
  const explicit = await store.prepareRun("/fixture:manual"); assert.equal(explicit.invoked.length, 1); assert.match(explicit.prompt, /manual description/); assert.match((await renderExplicitSkill(explicit.invoked[0]!, root)).content, /Synthetic instructions/); await explicit.verifyProviders(); await explicit.dispose();
});

test("invalid invocation flags and modified packages fail closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-skill-flags-")); t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "source"); await mkdir(source); await skill(source, "bad", "disable-model-invocation: maybe\n");
  const store = new SkillPackageStore(path.join(root, "data")); await assert.rejects(store.preview(source), /Invalid skill invocation setting/);
  await skill(source, "bad", "disable-model-invocation: true\n"); const preview = await store.preview(source); const pkg = await store.install(source, preview.fingerprint);
  await writeFile(path.join(root, "data", "skill-packages", pkg.id, "files", "skills", "bad", "SKILL.md"), "changed");
  const list = await store.list(); assert.equal(list[0]!.skills.length, 0); assert.match(list[0]!.unavailable!, /could not be verified/); await store.setEnabled(pkg.id, false);
});


test("OpenAI skill policy restricts implicit invocation and eligible providers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-openai-skill-policy-")); t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const source = path.join(root, "source"); await mkdir(source); await skill(source, "policy-manual", ""); await skill(source, "codex-only", ""); await skill(source, "chat-only", "");
  for (const [name, policy] of [["policy-manual", "policy:\n  allow_implicit_invocation: false\n"], ["codex-only", "policy:\n  products: [CODEX]\n"], ["chat-only", "policy:\n  products: [CHAT]\n"]]) {
    await mkdir(path.join(source, "skills", name, "agents")); await writeFile(path.join(source, "skills", name, "agents", "openai.yaml"), policy);
  }
  const store = new SkillPackageStore(path.join(root, "data")); const preview = await store.preview(source);
  assert.equal(preview.skills.find((item) => item.name === "policy-manual")!.disableModelInvocation, true); assert.deepEqual(preview.skills.find((item) => item.name === "codex-only")!.allowedProviders, ["codex", "ollama"]); assert.deepEqual(preview.skills.find((item) => item.name === "chat-only")!.allowedProviders, []);
  await store.install(source, preview.fingerprint); const codex = await store.prepareRun("ordinary", "codex"); assert.deepEqual(codex.review.map((item) => item.name), ["codex-only"]); await codex.dispose();
  const claude = await store.prepareRun("ordinary", "claude"); assert.deepEqual(claude.review, []); await claude.dispose();
  const manual = await store.prepareRun("$policy-manual", "codex"); assert.equal(manual.invoked.length, 1); assert.match((await renderExplicitSkill(manual.invoked[0]!, root, "codex")).content, /Synthetic/); await manual.dispose();
  const restricted = await store.prepareRun("/codex-only", "claude"); await assert.rejects(renderExplicitSkill(restricted.invoked[0]!, root, "claude"), /not available for the selected provider/); await restricted.dispose();
  const unspecified = await store.prepareRun("ordinary"); assert.deepEqual(unspecified.review, []); await unspecified.dispose();
});


test("provider copies omit uninvoked command instructions even when a skill is enabled", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-command-visibility-")); t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const source = path.join(root, "source"); await mkdir(path.join(source, "commands"), { recursive: true });
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "fixture", commands: { review: { source: "./commands/review.md" }, inline: { content: "PRIVATE_UNINVOKED_INLINE" } } }));
  await writeFile(path.join(source, "commands", "review.md"), "PRIVATE_UNINVOKED_COMMAND"); await skill(source, "automatic", "");
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source); const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true);
  const ordinary = await store.prepareRun("ordinary", "codex"); const entry = ordinary.packages[0]!;
  await assert.rejects(readFile(path.join(entry.providerRoot!, "commands", "review.md")), { code: "ENOENT" }); await assert.rejects(readFile(path.join(entry.providerRoot!, "plugin.json")), { code: "ENOENT" });
  assert.match(await readFile(path.join(entry.root, "commands", "review.md"), "utf8"), /PRIVATE_UNINVOKED_COMMAND/); await ordinary.verifyProviders(); await ordinary.dispose();
  const selected = await store.prepareRun("/fixture:review", "codex"); assert.match(await readFile(path.join(selected.packages[0]!.providerRoot!, "commands", "review.md"), "utf8"), /PRIVATE_UNINVOKED_COMMAND/);
  await assert.rejects(readFile(path.join(selected.packages[0]!.providerRoot!, "plugin.json")), { code: "ENOENT" }); await selected.verifyProviders(); await selected.dispose();
});


test("named skill arguments expand once for direct and plugin imports", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-named-skill-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, "source"); await mkdir(source);
  await skill(source, "named", "arguments: [issue, branch, missing]\ndisable-model-invocation: true\n", String.raw`Issue $issue; branch $branch; missing <$missing>; escaped \$issue; unknown $other; indexed $ARGUMENTS[0].`);
  await skill(source, "invalid", "arguments: [issue, issue]\n");
  const store = new SkillPackageStore(path.join(root, "data")); const preview = await store.preview(source);
  assert.deepEqual(preview.skills.find((item) => item.name === "named")!.namedArguments, ["issue", "branch", "missing"]); assert.match(preview.skills.find((item) => item.name === "invalid")!.unsupported!.join(" "), /Invalid named/);
  await store.install(source, preview.fingerprint); const run = await store.prepareRun('/named "two words" "$issue"');
  const rendered = (await renderExplicitSkill(run.invoked[0]!, root)).content;
  assert.match(rendered, /Issue two words; branch \$issue; missing <>; escaped \$issue; unknown \$other; indexed two words/); assert.doesNotMatch(rendered, /ARGUMENTS: /); await run.dispose();
  const pluginSource = path.join(root, "plugin"); await mkdir(pluginSource); await writeFile(path.join(pluginSource, "plugin.json"), JSON.stringify({ name: "fixture" }));
  await skill(pluginSource, "named", "arguments: issue branch\ndisable-model-invocation: true\n", "Issue $issue, branch $branch.");
  const plugins = new PluginPackageStore(path.join(root, "data")); const plugin = await plugins.preview(pluginSource); const pkg = await plugins.install(pluginSource, plugin.fingerprint); await plugins.setEnabled(pkg.id, true);
  const copied = await plugins.prepareRun('/fixture:named 42'); assert.match((await renderExplicitSkill(copied.invoked[0]!, root)).content, /Issue 42, branch \./); await copied.dispose();
});


test("skill model overrides require explicit Claude invocation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-skill-model-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, "source"); await mkdir(source); await skill(source, "modelled", "model: sonnet\n"); await skill(source, "invalid-model", "model: '../bad model'\n");
  const store = new SkillPackageStore(path.join(root, "data")); const preview = await store.preview(source);
  assert.equal(preview.skills.find((item) => item.name === "modelled")!.skillModel, "sonnet"); assert.equal(preview.skills.find((item) => item.name === "modelled")!.disableModelInvocation, true); assert.match(preview.skills.find((item) => item.name === "invalid-model")!.unsupported!.join(" "), /invalid model/);
  await store.install(source, preview.fingerprint); const automatic = await store.prepareRun("ordinary", "claude"); assert.equal(automatic.review.length, 0); await automatic.dispose();
  const unsupported = await store.prepareRun("/modelled", "codex"); await assert.rejects(renderExplicitSkill(unsupported.invoked[0]!, root, "codex"), /requires Claude/); await unsupported.dispose();
  const supported = await store.prepareRun("/modelled", "claude"); assert.match((await renderExplicitSkill(supported.invoked[0]!, root, "claude")).content, /Synthetic/); await supported.dispose();
});
