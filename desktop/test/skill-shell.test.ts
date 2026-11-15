import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { SkillPackageStore } from "../src/main/services/skill-packages";
import { authorizeThreadPermission, ThreadPermissionStore, type PermissionContext } from "../src/main/services/thread-permissions";
import { renderSkillWithShell } from "../src/main/services/skill-shell";

test("skill shell commands require review and do not rescan inserted arguments or output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-skill-shell-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, "source"); await mkdir(source); const marker = path.join(root, "ran");
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const script = shell === "powershell" ? `New-Item -ItemType File -Path '${marker}' | Out-Null; Write-Output 'synthetic context'` : `touch '${marker}'; printf 'synthetic context'`;
  await writeFile(path.join(source, "SKILL.md"), `---\nname: shell-skill\ndescription: "Fixture !\`must-not-run\`"\nshell: ${shell}\n---\nResult: !\`${script}\`\nInput: $ARGUMENTS\n`);
  const store = new SkillPackageStore(path.join(root, "data")); const preview = await store.preview(source);
  assert.equal(preview.skills[0]!.requiresShell, true); assert.equal(preview.skills[0]!.disableModelInvocation, true); await store.install(source, preview.fingerprint);
  const automatic = await store.prepareRun("ordinary", "codex"); assert.deepEqual(automatic.review, []); await automatic.dispose();
  const run = await store.prepareRun('/shell-skill !`do-not-run`', "codex"); const item = run.invoked[0]!; const approvals: string[] = [];
  await assert.rejects(renderSkillWithShell(item, root, "codex", async (request) => { approvals.push(request.detail); return false; }, new AbortController().signal, run.verify), /declined/);
  await assert.rejects(readFile(marker), { code: "ENOENT" }); assert.match(approvals[0]!, /synthetic context/);
  const rendered = await renderSkillWithShell(item, root, "codex", async () => true, new AbortController().signal, run.verify);
  assert.match(rendered.content, /Result: synthetic context/); assert.match(rendered.content, /Input: !`do-not-run`/); await readFile(marker);
  await rm(marker); await assert.rejects(renderSkillWithShell(item, root, "codex", async () => { await writeFile(item.path, "changed"); return true; }, new AbortController().signal, run.verify), /changed after/);
  await assert.rejects(readFile(marker), { code: "ENOENT" }); await run.dispose();
});


test("plugin skill shell context uses reviewed settings without exposing sensitive values", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-shell-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, "source"); await mkdir(path.join(source, "skills", "shell"), { recursive: true });
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "fixture", userConfig: { label: { type: "string", title: "Label", description: "Label", required: true }, token: { type: "string", title: "Token", description: "Secret", sensitive: true } } }));
  const shell = process.platform === "win32" ? "powershell" : "bash"; const command = shell === "powershell" ? "Write-Output '${user_config.label}'" : "printf '${user_config.label}'";
  await writeFile(path.join(source, "skills", "shell", "SKILL.md"), `---\nname: shell\ndescription: Fixture\nshell: ${shell}\n---\nContext: !\`${command}\`\nSecret: ${"${user_config.token}"}\n`);
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source); const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true);
  const run = await store.prepareRun("/fixture:shell", "codex", { values: () => ({ label: "synthetic-label", token: "synthetic-secret" }), paths: {} }, root);
  const detail: string[] = []; const rendered = await renderSkillWithShell(run.invoked[0]!, root, "codex", async (request) => { detail.push(request.detail); return true; }, new AbortController().signal, run.verifyProviders);
  assert.match(rendered.content, /synthetic-label/); assert.match(rendered.content, /sensitive setting withheld/); assert.doesNotMatch(rendered.content + detail.join(""), /synthetic-secret/); await run.dispose();
});


test("a remembered skill command is scoped to the same chat and verified package", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-skill-permission-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, "source"); await mkdir(source); const shell = process.platform === "win32" ? "powershell" : "bash"; const command = shell === "powershell" ? "Write-Output 'synthetic'" : "printf synthetic";
  await writeFile(path.join(source, "SKILL.md"), `---\nname: task\ndescription: Fixture\nshell: ${shell}\n---\nResult: !\`${command}\`\n`);
  const skills = new SkillPackageStore(path.join(root, "data")); const preview = await skills.preview(source); await skills.install(source, preview.fingerprint);
  const encryption = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text, "utf8"), decryptString: (data: Buffer) => data.toString("utf8") }; const grants = new ThreadPermissionStore(root, encryption); await grants.load();
  const context: PermissionContext = { threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", provider: "codex", model: "fixture", mode: "plan", worker: "parent" }; let prompts = 0;
  const approve = (request: { scope?: unknown }) => authorizeThreadPermission(grants, context, request.scope, async () => { prompts++; return 2; });
  for (let i = 0; i < 2; i++) { const run = await skills.prepareRun("/task", "codex"); assert.match((await renderSkillWithShell(run.invoked[0]!, root, "codex", approve, new AbortController().signal, run.verify)).content, /synthetic/); await run.dispose(); }
  assert.equal(prompts, 1); await grants.clear(context.threadId);
  const run = await skills.prepareRun("/task", "codex"); await renderSkillWithShell(run.invoked[0]!, root, "codex", approve, new AbortController().signal, run.verify); await run.dispose(); assert.equal(prompts, 2);
});
