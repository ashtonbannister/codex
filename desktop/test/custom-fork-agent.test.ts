import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillPackageStore } from "../src/main/services/skill-packages";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { renderExplicitSkill } from "../src/main/services/skill-selection";

test("custom fork agents use verified package files and enforce supported tool limits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-custom-agent-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, "source"); await mkdir(path.join(source, "agents"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\ndescription: Review\ncontext: fork\nagent: reviewer\n---\nInspect $ARGUMENTS\n");
  await writeFile(path.join(source, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Safe review\ntools: Read, Grep, Glob\nmodel: inherit\n---\nReview accurately.\n");
  const store = new SkillPackageStore(path.join(root, "data")); const preview = await store.preview(source); assert.deepEqual(preview.skills[0]!.unsupported, []); assert.equal(preview.skills[0]!.forkAgentReadOnly, true);
  await store.install(source, preview.fingerprint); const denied = await store.prepareRun("/review file", "codex"); await assert.rejects(renderExplicitSkill(denied.invoked[0]!, root, "codex"), /requires Claude/); await denied.dispose();
  const run = await store.prepareRun("/review file", "claude"); assert.equal(run.invoked[0]!.agentPrompt, "Review accurately.\n"); assert.match((await renderExplicitSkill(run.invoked[0]!, root, "claude")).content, /Inspect file/);
  await writeFile(path.join(run.invoked[0]!.root, "agents", "reviewer.md"), "changed"); await assert.rejects(run.verify(), /changed after/); await run.dispose();
});

test("plugin agent declarations select only the declared files and reject unsupported restrictions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-agent-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, "source"); await mkdir(path.join(source, "skills", "review"), { recursive: true }); await mkdir(path.join(source, "custom")); await mkdir(path.join(source, "agents"));
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "fixture", agents: ["./custom/reviewer.md"] }));
  await writeFile(path.join(source, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review\ncontext: fork\nagent: fixture:reviewer\n---\nReview $ARGUMENTS\n");
  await writeFile(path.join(source, "custom", "reviewer.md"), "---\nname: reviewer\ndescription: Selected\n---\nSelected instructions.\n");
  await writeFile(path.join(source, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Unselected\n---\nUnselected instructions.\n");
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source); assert.equal(preview.skills[0]!.forkAgentPath, "custom/reviewer.md");
  const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true); const run = await store.prepareRun("/fixture:review ECHO_PROMPT", "codex");
  assert.equal(run.invoked[0]!.agentPrompt, "Selected instructions.\n"); await run.verifyProviders(); await run.dispose();
  await writeFile(path.join(source, "custom", "reviewer.md"), "---\nname: reviewer\ndescription: Unsupported\ndisallowedTools: Bash\n---\nDo not run.\n");
  const unsupported = await store.preview(source); assert.match(unsupported.skills[0]!.unsupported!.join(" "), /unavailable or unsupported/);
});


test("agent overrides cannot silently discard restrictions and nested plugin agents resolve by scope", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-agent-scope-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, "source"); await mkdir(path.join(source, "agents"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: test\ndescription: Test\ncontext: fork\nagent: Explore\n---\nInspect.\n");
  await writeFile(path.join(source, "agents", "custom.md"), "---\nname: Explore\ndescription: Restricted\ndisallowedTools: Bash\n---\nAgent instructions.\n");
  const store = new SkillPackageStore(path.join(root, "data")); const blocked = await store.preview(source); assert.match(blocked.skills[0]!.unsupported!.join(" "), /unavailable or unsupported/);
  await writeFile(path.join(source, "agents", "custom.md"), "---\nname: Explore\ndescription: Override\n---\nCustom Explore instructions.\n");
  const allowed = await store.preview(source); assert.equal(allowed.skills[0]!.forkAgentPath, "agents/custom.md"); assert.deepEqual(allowed.skills[0]!.unsupported, []);
  const plugin = path.join(root, "plugin"); await mkdir(path.join(plugin, "skills", "task"), { recursive: true }); await mkdir(path.join(plugin, "agents", "review"), { recursive: true });
  await writeFile(path.join(plugin, "plugin.json"), JSON.stringify({ name: "fixture" }));
  await writeFile(path.join(plugin, "skills", "task", "SKILL.md"), "---\nname: task\ndescription: Task\ncontext: fork\nagent: fixture:review:security\n---\nInspect.\n");
  await writeFile(path.join(plugin, "agents", "review", "security.md"), "---\nname: security-reviewer\ndescription: Review\n---\nNested instructions.\n");
  const plugins = new PluginPackageStore(path.join(root, "data")); const preview = await plugins.preview(plugin); assert.equal(preview.skills[0]!.forkAgentPath, "agents/review/security.md");
});


test("custom agent model overrides require Claude and skill-level inherit wins", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-agent-model-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, "source"); await mkdir(path.join(source, "agents"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: task\ndescription: Task\ncontext: fork\nagent: reviewer\n---\nInspect.\n");
  await writeFile(path.join(source, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Review\nmodel: sonnet\n---\nReview.\n");
  const store = new SkillPackageStore(path.join(root, "data")); const preview = await store.preview(source); assert.equal(preview.skills[0]!.forkAgentModel, "sonnet");
  await store.install(source, preview.fingerprint); const run = await store.prepareRun("/task", "codex"); await assert.rejects(renderExplicitSkill(run.invoked[0]!, root, "codex"), /requires Claude/); await run.dispose();
  await writeFile(path.join(source, "SKILL.md"), "---\nname: task\ndescription: Task\ncontext: fork\nagent: reviewer\nmodel: inherit\n---\nInspect.\n");
  const inherited = await store.preview(source); assert.equal(inherited.skills[0]!.forkAgentModel, undefined);
});
