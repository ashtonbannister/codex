import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { emptyWorkspace, type Run } from "../src/shared/types";
import { buildRunContext } from "../src/main/services/context";
import {
  providerArguments,
  resolveExecutable,
  runProvider,
} from "../src/main/services/providers";
import {
  WorkspaceService,
  validateWorkspaceState,
} from "../src/main/services/workspace-service";
import {
  validateCodexHistoryQuery,
  validateCodexMemoryImportRequest,
  validateCodexResourceRequest,
  validateSettings,
} from "../src/main/services/validation";

const SOURCE_ID = "01900000-0000-7000-8000-000000000001";
const fakeCli = `
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
if(process.argv.includes('--version')){console.log('compatibility-fixture 1');process.exit(0)}
if(process.argv.includes('--help')){console.log('--json --sandbox --skip-git-repo-check --ignore-user-config --safe-mode --restricted --permission-prompts --output-format --tools --stdio --strict-config');process.exit(0)}
if(process.argv.includes('--print-startup-config')){console.log(JSON.stringify({appServerVersion:'fixture',configRequirements:{requirements:null}}));process.exit(0)}
const file=path.join(process.env.CODEX_HOME||path.dirname(new URL(import.meta.url).pathname),'native-fixture.json');
if(!process.argv.includes('app-server')){
  if(process.argv.includes('exec')){
    let folder=process.cwd(),git=false;
    for(;;){if(fs.existsSync(path.join(folder,'.git'))){git=true;break}const parent=path.dirname(folder);if(parent===folder)break;folder=parent;}
    if(!git&&!process.argv.includes('--skip-git-repo-check')){console.log(JSON.stringify({type:'turn.failed',error:{message:'GIT_GUARD_REQUIRES_FLAG'}}));process.exit(1)}
  }
  let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>prompt+=chunk);
  process.stdin.on('end',()=>{
    if(process.argv.includes('--safe-mode')){console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:prompt}]}}));console.log(JSON.stringify({type:'result',subtype:'success',result:prompt}));}
    else {console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:prompt}}));console.log(JSON.stringify({type:'turn.completed'}));}
  });
}else{
  const lines=readline.createInterface({input:process.stdin});
  let active;
  const send=value=>console.log(JSON.stringify(value));
  const summary=thread=>{const {turns,pages,...value}=thread;return value};
  lines.on('line',line=>{
    const request=JSON.parse(line);if(request.id===undefined)return;
    const data=JSON.parse(fs.readFileSync(file,'utf8'));
    data.calls.push({method:request.method,params:request.params});
    const params=request.params||{};
    const thread=data.threads.find(entry=>entry.id===params.threadId);
    let result={};
    if(request.method==='initialize')result={userAgent:'fake-codex'};
    else if(request.method==='thread/list')result={data:data.threads.filter(entry=>entry.visible!==false&&(!params.cwd||entry.cwd===params.cwd)).map(summary),nextCursor:null};
    else if(request.method==='thread/read')result={thread:summary(thread)};
    else if(request.method==='thread/turns/list')result={data:params.cursor?thread.turns.slice(1):thread.turns.slice(0,thread.pages?1:undefined),nextCursor:!params.cursor&&thread.pages?'older':null};
    else if(request.method==='config/read')result={config:{mcp_servers:{}}};
    else if(request.method==='thread/start'){
      const target={id:randomUUID(),name:'New native thread',preview:'',cwd:params.cwd,modelProvider:'openai',createdAt:1700000100,updatedAt:1700000100,source:'appServer',status:{type:'notLoaded'},turns:[]};
      data.threads.push(target);
      result={thread:summary(target),modelProvider:'openai',cwd:params.cwd,approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}};
    }else if(request.method==='thread/name/set')thread.name=params.name;
    else if(request.method==='thread/inject_items'){
      const saved=JSON.parse(fs.readFileSync(data.workspaceFile,'utf8'));
      const receipt=saved.threads.find(entry=>entry.codexHandoff?.nativeThreadId===params.threadId)?.codexHandoff;
      if(!receipt||receipt.state!=='pending')throw Error('Handoff receipt not durably pending before injection');
      if(data.failInjection){fs.writeFileSync(file,JSON.stringify(data));send({id:request.id,error:{code:-32603,message:'PRIVATE_FIXTURE_ERROR_DO_NOT_EXPOSE'}});return;}
      thread.injectedItems=params.items;
    }
    else if(request.method==='thread/fork'||request.method==='thread/resume'){
      const target=request.method==='thread/fork'?{...thread,id:randomUUID(),cwd:params.cwd}:thread;
      if(request.method==='thread/fork')data.threads.push(target);
      target.cwd=params.cwd;
      const write=params.sandbox==='workspace-write';
      result={thread:summary(target),modelProvider:'openai',cwd:params.cwd,approvalPolicy:'never',approvalsReviewer:'user',sandbox:write?{type:'workspaceWrite',writableRoots:[params.cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:false}};
    }else if(request.method==='turn/start'){
      const saved=JSON.parse(fs.readFileSync(data.workspaceFile,'utf8'));
      const savedRun=saved.runs.find(entry=>entry.providerSessionId===params.threadId&&entry.status==='running');
      if(!savedRun)throw Error('Native ID was not durably saved before turn/start');
      const prompt=params.input[0].text;
      active={threadId:params.threadId,turnId:randomUUID()};
      result={turn:{id:active.turnId,status:'inProgress'}};
      if(prompt.includes('WRITE_NATIVE'))fs.writeFileSync(path.join(params.cwd,'native-change.txt'),'isolated native change');
      fs.writeFileSync(file,JSON.stringify(data));send({id:request.id,result});
      if(prompt.includes('WAIT_NATIVE'))return;
      send({method:'item/completed',params:{...active,item:{type:'agentMessage',id:randomUUID(),text:'Native continuation finished.'}}});
      send({method:'turn/completed',params:{threadId:active.threadId,turn:{id:active.turnId,status:'completed'}}});return;
    }else if(request.method==='turn/interrupt'){
      if(active)send({method:'turn/completed',params:{threadId:active.threadId,turn:{id:active.turnId,status:'interrupted'}}});
    }else throw Error('Unexpected RPC '+request.method);
    fs.writeFileSync(file,JSON.stringify(data));send({id:request.id,result});
  });
}
`;

async function fixture(
  t: TestContext,
  options: { folder?: boolean; archived?: boolean; pages?: boolean } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-compatibility-"));
  const project = path.join(root, "project");
  const cwd = path.join(project, "nested");
  const home = path.join(root, "codex-home");
  const dataDir = path.join(root, "nova");
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(home),
    mkdir(dataDir),
  ]);
  await writeFile(path.join(project, "README.md"), "source fixture\n");
  await writeFile(path.join(cwd, "local.txt"), "native working folder\n");
  if (!options.folder) {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", project, ...args], { stdio: "ignore" });
    git("init", "--initial-branch=main");
    git("config", "user.name", "Nova fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "core.autocrlf", "false");
    git("add", ".");
    git("commit", "-m", "initial fixture");
  }
  const executable = path.join(root, "fake-cli.mjs");
  await writeFile(executable, fakeCli);
  const state = emptyWorkspace();
  state.settings = {
    ...state.settings,
    codexPath: executable,
    claudePath: executable,
    codexHome: home,
    localModel: "fixture-local",
  };
  await writeFile(path.join(dataDir, "workspace.json"), JSON.stringify(state));
  const nativeFile = path.join(home, "native-fixture.json");
  await writeFile(
    nativeFile,
    JSON.stringify({
      workspaceFile: path.join(dataDir, "workspace.json"),
      calls: [],
      threads: [
        {
          id: SOURCE_ID,
          name: "Existing Codex work",
          preview: "Preserve my work",
          cwd: await realpath(cwd),
          modelProvider: "openai",
          createdAt: 1_700_000_000,
          updatedAt: 1_700_000_001,
          source: "appServer",
          status: { type: "notLoaded" },
          pages: options.pages,
          turns: [
            {
              id: "turn-new",
              items: [
                {
                  type: "userMessage",
                  id: "new-u",
                  content: [
                    {
                      type: "text",
                      text: "Keep the original design requirement.",
                    },
                  ],
                },
                {
                  type: "agentMessage",
                  id: "new-a",
                  text: "Current visible native answer.",
                },
                {
                  type: "reasoning",
                  id: "private",
                  text: "PRIVATE_REASONING_SENTINEL",
                },
              ],
            },
            {
              id: "turn-old",
              items: [
                {
                  type: "userMessage",
                  id: "old-u",
                  content: [{ type: "text", text: "Earlier visible request." }],
                },
                {
                  type: "agentMessage",
                  id: "old-a",
                  text: "Earlier visible answer.",
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const service = new WorkspaceService(dataDir, () => undefined);
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await service.initialize();
  const connection = { home: await realpath(home), codexPath: executable };
  const importThread = () =>
    service.importCodexThread(
      { threadId: SOURCE_ID, archived: options.archived },
      connection,
    );
  const nativeState = async () =>
    JSON.parse(await readFile(nativeFile, "utf8"));
  return {
    root,
    project: await realpath(project),
    cwd: await realpath(cwd),
    home: connection.home,
    dataDir,
    executable,
    nativeFile,
    nativeState,
    service,
    connection,
    importThread,
  };
}

async function finish(service: WorkspaceService, id: string): Promise<Run> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const run = (await service.snapshot()).state.runs.find(
      (entry) => entry.id === id,
    )!;
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Fixture run did not finish within its bounded wait.");
}

test("refresh native history sees official-app changes and preserves Nova turns and project notes", async (t) => {
  const f = await fixture(t, { pages: true });
  const thread = await f.importThread();
  await f.service.saveMemory({ projectId: thread.projectId, title: "Nova decision", content: "Preserve the user's constraints.", kind: "decision", source: "User" });
  const run = await f.service.startRun({ projectId: thread.projectId, threadId: thread.id, provider: "claude", mode: "plan", prompt: "Continue with the current project." });
  assert.equal((await finish(f.service, run.id)).status, "completed");
  const before = (await f.service.snapshot()).state;
  const native = await f.nativeState();
  native.threads[0].updatedAt += 60;
  native.threads[0].turns.unshift({ id: "official-new", items: [{ type: "agentMessage", id: "official-answer", text: "New answer from the official Codex app." }] });
  await writeFile(f.nativeFile, JSON.stringify(native));
  const refreshed = await f.service.refreshCodexThread(thread.id, f.connection);
  assert.ok(refreshed.codex?.history.some((message) => message.id === "official-answer"));
  assert.equal(refreshed.codex?.history.length, 5);
  const after = (await f.service.snapshot()).state;
  assert.deepEqual(after.runs, before.runs);
  assert.deepEqual(after.memories, before.memories);
  const listCall = (await f.nativeState()).calls.find((call: any) => call.method === "thread/list");
  assert.equal(listCall.params.currentAccountOnly, true);
  assert.equal(listCall.params.cwd, f.cwd);
});

test("refresh rejects threads outside the current account catalog without reading or replacing their snapshots", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  const native = await f.nativeState();
  native.calls = [];
  native.threads[0].visible = false;
  await writeFile(f.nativeFile, JSON.stringify(native));
  await assert.rejects(f.service.refreshCodexThread(thread.id, f.connection), /not in the current account/);
  assert.deepEqual((await f.service.snapshot()).state.threads[0], thread);
  assert.ok((await f.nativeState()).calls.every((call: any) => call.method !== "thread/turns/list"));
});

test("native handoff publishes Claude-visible context and memory with durable receipt, new native identity and idempotence", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  const memory = await f.service.saveMemory({ projectId: thread.projectId, title: "Shared engineering decision", content: "Preserve the same geometry across providers.", kind: "decision", source: "User" });
  const run = await f.service.startRun({ projectId: thread.projectId, threadId: thread.id, provider: "claude", mode: "plan", prompt: "Review the shared engineering decision." });
  assert.equal((await finish(f.service, run.id)).status, "completed");
  const original = structuredClone((await f.nativeState()).threads[0]);
  const review = await f.service.reviewCodexHandoff(thread.id, f.connection);
  const published = await f.service.publishCodexHandoff(thread.id, review.fingerprint, f.connection);
  assert.equal(published.unchanged, false);
  assert.notEqual(published.nativeThreadId, SOURCE_ID);
  const state = (await f.service.snapshot()).state;
  const linked = state.threads.find((entry) => entry.id === thread.id)!;
  assert.equal(linked.codexHandoff?.state, "published");
  assert.equal(linked.codexHandoff?.nativeThreadId, published.nativeThreadId);
  assert.equal(linked.codex?.sourceThreadId, SOURCE_ID);
  assert.equal(linked.codex?.forkedThreadId, published.nativeThreadId);
  assert.ok(state.memories.some((entry) => entry.id === memory.id));
  assert.ok(state.runs.some((entry) => entry.id === run.id));
  const native = await f.nativeState();
  assert.deepEqual(native.threads[0], original);
  const copy = native.threads.find((entry: any) => entry.id === published.nativeThreadId);
  assert.deepEqual(copy.turns, original.turns, "native-owned history stays in the native fork");
  assert.match(copy.injectedItems[0].content[0].text, /Preserve the same geometry across providers/);
  assert.match(copy.injectedItems[0].content[0].text, /Current visible native answer/);
  assert.match(copy.injectedItems[0].content[0].text, /claude/);
  assert.doesNotMatch(copy.injectedItems[0].content[0].text, /PRIVATE_REASONING_SENTINEL/);
  assert.equal(native.calls.filter((call: any) => call.method === "turn/start").length, 0);
  const nextReview = await f.service.reviewCodexHandoff(thread.id, f.connection);
  assert.equal(nextReview.unchanged, true);
  const again = await f.service.publishCodexHandoff(thread.id, nextReview.fingerprint, f.connection);
  assert.equal(again.unchanged, true);
  assert.equal(again.nativeThreadId, published.nativeThreadId);
  assert.equal((await f.nativeState()).calls.filter((call: any) => call.method === "thread/start" || call.method === "thread/fork").length, 1);
});

test("a Nova-only Claude conversation receives a real OEM thread link after explicit publishing", async (t) => {
  const f = await fixture(t);
  const imported = await f.importThread();
  const run = await f.service.startRun({ projectId: imported.projectId, provider: "claude", mode: "plan", prompt: "Start a Nova-only conversation." });
  assert.equal((await finish(f.service, run.id)).status, "completed");
  const before = (await f.service.snapshot()).state.threads.find((entry) => entry.id === run.threadId)!;
  assert.equal(before.codex, undefined);
  const review = await f.service.reviewCodexHandoff(before.id, f.connection);
  const published = await f.service.publishCodexHandoff(before.id, review.fingerprint, f.connection);
  const after = (await f.service.snapshot()).state.threads.find((entry) => entry.id === run.threadId)!;
  assert.equal(after.codex?.sourceThreadId, published.nativeThreadId);
  assert.equal(after.codex?.home, f.home);
  assert.equal(after.codexHandoff?.state, "published");
  assert.equal((await f.nativeState()).calls.filter((call: any) => call.method === "thread/start").length, 1);
  assert.equal((await f.nativeState()).calls.filter((call: any) => call.method === "turn/start").length, 0);
});

test("native handoff refuses stale context and retains failed creation receipts without exposing provider diagnostics", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  const review = await f.service.reviewCodexHandoff(thread.id, f.connection);
  await f.service.saveMemory({ projectId: thread.projectId, title: "New note", content: "Changed after review.", kind: "note", source: "User" });
  await assert.rejects(f.service.publishCodexHandoff(thread.id, review.fingerprint, f.connection), /changed|preview|review/i);
  assert.equal((await f.nativeState()).calls.filter((call: any) => call.method === "thread/start" || call.method === "thread/fork").length, 0);
  const current = await f.service.reviewCodexHandoff(thread.id, f.connection);
  const native = await f.nativeState();
  const original = structuredClone(native.threads[0]);
  native.failInjection = true;
  await writeFile(f.nativeFile, JSON.stringify(native));
  let failure: unknown;
  try { await f.service.publishCodexHandoff(thread.id, current.fingerprint, f.connection); }
  catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  assert.doesNotMatch(failure.message, /PRIVATE_FIXTURE_ERROR_DO_NOT_EXPOSE/);
  const saved = (await f.service.snapshot()).state.threads.find((entry) => entry.id === thread.id)!;
  assert.equal(saved.codexHandoff?.state, "failed");
  assert.ok(saved.codexHandoff?.nativeThreadId);
  assert.equal(saved.codex?.forkedThreadId, undefined);
  assert.deepEqual((await f.nativeState()).threads[0], original);
  const persisted = JSON.parse(await readFile(path.join(f.dataDir, "workspace.json"), "utf8"));
  assert.equal(persisted.threads.find((entry: any) => entry.id === thread.id).codexHandoff.state, "failed");
  assert.equal((await f.nativeState()).calls.filter((call: any) => call.method === "turn/start").length, 0);
});

test("account operation lease is durable before launch, blocks agents, rejects stale finish and clears only its exact marker", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  const operation = await f.service.beginAccountOperation("codex", f.home);
  const persisted = JSON.parse(await readFile(path.join(f.dataDir, "workspace.json"), "utf8"));
  assert.equal(persisted.accountOperation.id, operation);
  assert.equal(persisted.accountOperation.provider, "codex");
  assert.equal(persisted.accountOperation.home, f.home);
  const beforeCalls = (await f.nativeState()).calls;
  await assert.rejects(f.service.startRun({ projectId: thread.projectId, threadId: thread.id, provider: "claude", mode: "plan", prompt: "Must not start during login." }), /provider account cleanup/);
  await assert.rejects(f.service.finishAccountOperation("stale-operation"), /marker was preserved/);
  assert.equal((await f.service.snapshot()).state.accountOperation?.id, operation);
  assert.equal(JSON.parse(await readFile(path.join(f.dataDir, "workspace.json"), "utf8")).accountOperation.id, operation);
  assert.deepEqual((await f.nativeState()).calls, beforeCalls);
  assert.equal((await f.service.snapshot()).state.runs.length, 0);
  await f.service.finishAccountOperation(operation);
  assert.equal((await f.service.snapshot()).state.accountOperation, undefined);
  assert.equal(JSON.parse(await readFile(path.join(f.dataDir, "workspace.json"), "utf8")).accountOperation, undefined);
  const failed = await f.service.beginAccountOperation("claude", f.home);
  await f.service.recordAccountRecovery("claude", f.home);
  await assert.rejects(f.service.finishAccountOperation(failed), /marker was preserved/);
  const recovered = JSON.parse(await readFile(path.join(f.dataDir, "workspace.json"), "utf8"));
  assert.equal(recovered.accountOperation, undefined);
  assert.equal(recovered.accountRecovery.provider, "claude");
});

test("orphan account lease becomes durable recovery on restart without probes and requires acknowledgement then explicit tool refresh", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  const operation = await f.service.beginAccountOperation("claude", f.home);
  await f.service.dispose();
  const probeFile = path.join(f.root, "restart-probes.txt");
  const instrumented = fakeCli.replace("import fs from 'node:fs';", `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(probeFile)}, 'invoked\\n');`);
  await writeFile(f.executable, instrumented);
  const restarted = new WorkspaceService(f.dataDir, () => undefined);
  try {
    await restarted.initialize();
    const snapshot = await restarted.snapshot();
    assert.equal(snapshot.state.accountOperation, undefined);
    assert.equal(snapshot.state.accountRecovery?.provider, "claude");
    assert.equal(snapshot.state.accountRecovery?.home, f.home);
    assert.ok(snapshot.providers.every((provider) => !provider.available));
    await assert.rejects(readFile(probeFile), { code: "ENOENT" });
    const durable = JSON.parse(await readFile(path.join(f.dataDir, "workspace.json"), "utf8"));
    assert.equal(durable.accountOperation, undefined);
    assert.equal(durable.accountRecovery.provider, "claude");
    await assert.rejects(restarted.finishAccountOperation(operation), /marker was preserved/);
    await assert.rejects(restarted.startRun({ projectId: thread.projectId, threadId: thread.id, provider: "claude", mode: "plan", prompt: "Must remain blocked." }), /provider account cleanup/);
    const recovery = (await restarted.listRecoveryItems()).find((entry) => entry.id === "provider-accounts")!;
    assert.equal(recovery.kind, "accounts");
    await assert.rejects(restarted.acknowledgeRecovery({ id: recovery.id, token: "0".repeat(64) }), /Recovery state changed/);
    await restarted.acknowledgeRecovery({ id: recovery.id, token: recovery.token });
    assert.equal((await restarted.snapshot()).state.accountRecovery, undefined);
    await assert.rejects(readFile(probeFile), { code: "ENOENT" });
    assert.ok((await restarted.snapshot()).providers.every((provider) => !provider.available), "Acknowledgement does not claim successful redetection");
    await assert.rejects(restarted.startRun({ projectId: thread.projectId, threadId: thread.id, provider: "claude", mode: "plan", prompt: "Detection must be refreshed first." }), /refresh tool detection/);
    const refreshed = await restarted.refreshProviderStatus();
    assert.ok(refreshed.providers.find((provider) => provider.id === "codex")?.available);
    assert.match(await readFile(probeFile, "utf8"), /invoked/);
  } finally { await restarted.dispose(); }
});

test("compatibility inputs stay bounded and legacy workspaces retain their defaults", () => {
  const legacy = validateWorkspaceState(emptyWorkspace());
  assert.equal(legacy.codexRecoveryHomes, undefined);
  assert.equal(legacy.settings.codexHome, undefined);
  assert.throws(
    () => validateSettings({ ...legacy.settings, codexHome: "relative" }),
    /absolute/,
  );
  assert.throws(
    () => validateCodexHistoryQuery({ threadId: "--bad" }),
    /invalid/,
  );
  assert.throws(
    () =>
      validateCodexResourceRequest({
        section: "memories",
        path: "../auth.json",
      }),
    /selected section/,
  );
  assert.throws(
    () =>
      validateCodexResourceRequest({ section: "credentials", path: "note.md" }),
    /allowed/,
  );
  assert.throws(
    () =>
      validateCodexMemoryImportRequest({
        projectId: "p",
        section: "memories",
        path: "note.md",
        expectedSha256: "wrong",
      }),
    /SHA-256/,
  );
});

test("native import retains paginated visible history, excludes private items, deduplicates and survives restart", async (t) => {
  const f = await fixture(t, { pages: true });
  const page = await f.service.listCodexThreads({}, f.connection);
  assert.equal(page.threads[0].id, SOURCE_ID);
  const thread = await f.importThread();
  assert.deepEqual(
    thread.codex?.history.map((message) => message.id),
    ["old-u", "old-a", "new-u", "new-a"],
  );
  assert.equal(thread.codex?.historyTruncated, false);
  assert.ok(!JSON.stringify(thread).includes("PRIVATE_REASONING_SENTINEL"));
  assert.equal((await f.importThread()).id, thread.id);
  assert.equal((await f.service.snapshot()).state.threads.length, 1);
  assert.equal((await f.service.snapshot()).state.projects[0].path, f.project);
  assert.equal(thread.codex?.sourceCwd, f.cwd);
  await f.service.dispose();
  const restored = new WorkspaceService(f.dataDir, () => undefined);
  try {
    await restored.initialize();
    assert.deepEqual(
      (await restored.snapshot()).state.threads[0].codex,
      thread.codex,
    );
  } finally {
    await restored.dispose();
  }
});

test("nested native Plan uses project-root memory provenance without changing its execution cwd", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  const memory = await f.service.saveMemory({
    projectId: thread.projectId,
    title: "Project-root requirement",
    content: "Retain the project-root README requirement.",
    kind: "constraint",
    source: "Reviewed root README",
    filePath: "README.md",
  });
  const request = {
    projectId: thread.projectId,
    threadId: thread.id,
    provider: "codex" as const,
    mode: "plan" as const,
    prompt: "Continue with the reviewed project-root requirement",
  };
  const preview = await f.service.previewContext(request);
  assert.equal(
    preview.memories.find((entry) => entry.id === memory.id)?.freshness,
    "current",
  );
  assert.ok(preview.includedMemoryIds.includes(memory.id));
  const run = await f.service.startRun(request, f.connection);
  const result = await finish(f.service, run.id);
  assert.equal(result.status, "completed", result.error);
  assert.ok(result.contextMemoryIds.includes(memory.id));
  const native = await f.nativeState();
  const resume = native.calls.find(
    (call: any) => call.method === "thread/resume",
  );
  const started = native.calls.find(
    (call: any) => call.method === "turn/start",
  );
  assert.equal(resume.params.cwd, f.cwd);
  assert.equal(started.params.cwd, f.cwd);
  assert.equal(started.params.input[0].text, preview.prompt);
  assert.match(
    started.params.input[0].text,
    /Retain the project-root README requirement/,
  );
  assert.equal(native.threads[0].cwd, f.cwd);
});

test("native Plan resumes the original folder, Build forks before execution and reuses its pinned worktree", async (t) => {
  const f = await fixture(t);
  const imported = await f.importThread();
  const base = {
    projectId: imported.projectId,
    threadId: imported.id,
    provider: "codex" as const,
  };
  const plan = await f.service.startRun(
    { ...base, mode: "plan", prompt: "Continue the existing conversation" },
    f.connection,
  );
  assert.equal((await finish(f.service, plan.id)).status, "completed");
  let native = await f.nativeState();
  assert.equal(
    native.calls.find((call: any) => call.method === "thread/resume").params
      .cwd,
    f.cwd,
  );
  assert.equal(native.threads[0].cwd, f.cwd);
  const storage = path.join(f.root, "redirected-storage");
  await f.service.updateSettings({
    ...(await f.service.snapshot()).state.settings,
    worktreeStoragePath: storage,
  });
  const build = await f.service.startRun(
    { ...base, mode: "build", prompt: "WRITE_NATIVE" },
    f.connection,
  );
  const result = await finish(f.service, build.id);
  assert.equal(result.status, "completed", result.error);
  const thread = (await f.service.snapshot()).state.threads[0];
  assert.equal(thread.worktreeStoragePath, await realpath(storage));
  assert.equal(thread.codex?.forkedCwd, thread.worktreePath);
  assert.notEqual(thread.codex?.forkedThreadId, SOURCE_ID);
  assert.equal(
    await readFile(
      path.join(thread.worktreePath!, "native-change.txt"),
      "utf8",
    ),
    "isolated native change",
  );
  await assert.rejects(
    readFile(path.join(f.project, "native-change.txt")),
    /ENOENT/,
  );
  native = await f.nativeState();
  assert.equal(
    native.threads[0].cwd,
    f.cwd,
    "the source native thread was never repointed",
  );
  assert.equal(
    native.calls.filter((call: any) => call.method === "thread/fork").length,
    1,
  );
  await f.service.updateSettings({
    ...(await f.service.snapshot()).state.settings,
    worktreeStoragePath: path.join(f.root, "different-storage"),
  });
  await f.service.dispose();
  const reopened = new WorkspaceService(f.dataDir, () => undefined);
  try {
    await reopened.initialize();
    const next = await reopened.startRun(
      { ...base, mode: "plan", prompt: "Continue the managed worktree" },
      f.connection,
    );
    assert.equal((await finish(reopened, next.id)).status, "completed");
    assert.equal(
      (await reopened.snapshot()).state.threads[0].worktreePath,
      thread.worktreePath,
    );
    assert.equal(
      (await reopened.snapshot()).state.threads[0].codex?.forkedThreadId,
      thread.codex?.forkedThreadId,
    );
  } finally {
    await reopened.dispose();
  }
  native = await f.nativeState();
  assert.equal(
    native.calls.filter((call: any) => call.method === "thread/fork").length,
    1,
  );
  assert.equal(
    native.calls.filter((call: any) => call.method === "thread/resume").at(-1)
      .params.threadId,
    thread.codex?.forkedThreadId,
  );
});

test("archived native Plan forks without unarchiving and a later Build forks its continued history", async (t) => {
  const f = await fixture(t);
  const original = await f.importThread();
  const thread = await f.service.importCodexThread({
    threadId: SOURCE_ID,
    archived: true,
  });
  assert.equal(
    thread.id,
    original.id,
    "an explicit Archived reimport keeps the same Nova thread",
  );
  assert.equal(thread.codex?.sourceArchived, true);
  const request = {
    projectId: thread.projectId,
    threadId: thread.id,
    provider: "codex" as const,
  };
  const plan = await f.service.startRun({
    ...request,
    mode: "plan",
    prompt: "Continue archived context safely",
  });
  assert.equal((await finish(f.service, plan.id)).status, "completed");
  const planFork = (await f.service.snapshot()).state.threads[0].codex!
    .forkedThreadId;
  const build = await f.service.startRun({
    ...request,
    mode: "build",
    prompt: "Prepare a separate build",
  });
  assert.equal((await finish(f.service, build.id)).status, "completed");
  const native = await f.nativeState();
  const forks = native.calls.filter(
    (call: any) => call.method === "thread/fork",
  );
  assert.equal(forks.length, 2);
  assert.equal(forks[1].params.threadId, planFork);
  assert.equal(
    native.calls.some((call: any) => call.method === "thread/unarchive"),
    false,
  );
  assert.equal(native.threads[0].cwd, f.cwd);
});

test("folder conversations support native Plan and visible provider handoff but refuse Build", async (t) => {
  const f = await fixture(t, { folder: true });
  const thread = await f.importThread();
  const project = (await f.service.snapshot()).state.projects[0];
  assert.equal(project.kind, "folder");
  assert.equal(project.path, f.cwd);
  const guarded = await runProvider({
    command: {
      ...(await resolveExecutable(f.executable)),
      args: providerArguments("codex", f.cwd, "plan", ""),
    },
    provider: "codex",
    cwd: f.cwd,
    prompt: "A repository guard must reject this fixture invocation",
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    maxBytes: 64 * 1024,
    onEvent: () => undefined,
  });
  assert.equal(guarded.completed, false);
  assert.match(guarded.error || "", /GIT_GUARD_REQUIRES_FLAG/);
  const request = {
    projectId: project.id,
    threadId: thread.id,
    mode: "plan" as const,
    prompt: "Continue from the imported requirements",
  };
  const plan = await f.service.startRun({ ...request, provider: "codex" });
  assert.equal((await finish(f.service, plan.id)).status, "completed");
  const claude = await f.service.startRun({ ...request, provider: "claude" });
  const claudeResult = await finish(f.service, claude.id);
  assert.equal(claudeResult.status, "completed", claudeResult.error);
  const text = claudeResult.events
    .filter((event) => event.kind === "message")
    .map((event) => event.text)
    .join("\n");
  assert.match(text, /original design requirement/);
  assert.match(text, /Native continuation finished/);
  assert.ok(!text.includes("PRIVATE_REASONING_SENTINEL"));
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ models: [{ name: "fixture-local" }] }), {
        status: 200,
      }),
  );
  const local = await f.service.startRun({ ...request, provider: "ollama" });
  assert.equal((await finish(f.service, local.id)).status, "completed");
  const fresh = await f.service.startRun({
    projectId: project.id,
    provider: "codex",
    mode: "plan",
    prompt: "Start a fresh Codex Plan in this folder",
  });
  const freshResult = await finish(f.service, fresh.id);
  assert.equal(freshResult.status, "completed", freshResult.error);
  assert.equal(
    (await f.service.snapshot()).state.threads.find(
      (entry) => entry.id === fresh.threadId,
    )?.codex,
    undefined,
  );
  await assert.rejects(
    f.service.startRun({ ...request, provider: "codex", mode: "build" }),
    /committed Git/,
  );
  assert.equal(
    (await f.service.snapshot()).state.threads[0].worktreePath,
    undefined,
  );
  await f.service.dispose();
  const restored = new WorkspaceService(f.dataDir, () => undefined);
  try {
    await restored.initialize();
    assert.equal((await restored.snapshot()).state.projects[0].kind, "folder");
    assert.equal((await restored.snapshot()).state.runs.length, 4);
  } finally {
    await restored.dispose();
  }
});

test("selected Codex references are digest-confirmed, idempotent, freshness-scoped and editable only as user notes", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  await mkdir(path.join(f.home, "memories"));
  const source = path.join(f.home, "memories", "MEMORY.md");
  await writeFile(source, "Keep the original wheel geometry.");
  const request = { section: "memories" as const, path: "MEMORY.md" };
  const preview = await f.service.previewCodexResource(request);
  const imported = await f.service.importCodexMemory(
    { ...request, projectId: thread.projectId, expectedSha256: preview.sha256 },
    f.home,
  );
  assert.equal(
    (
      await f.service.importCodexMemory({
        ...request,
        projectId: thread.projectId,
        expectedSha256: preview.sha256,
      })
    ).id,
    imported.id,
  );
  let context = await f.service.previewContext({
    projectId: thread.projectId,
    threadId: thread.id,
    provider: "claude",
    mode: "plan",
    prompt: "wheel geometry",
  });
  assert.ok(context.includedMemoryIds.includes(imported.id));
  await writeFile(source, "Changed wheel requirement.");
  await assert.rejects(
    f.service.importCodexMemory({
      ...request,
      projectId: thread.projectId,
      expectedSha256: preview.sha256,
    }),
    /changed after preview/,
  );
  context = await f.service.previewContext({
    projectId: thread.projectId,
    threadId: thread.id,
    provider: "ollama",
    mode: "plan",
    prompt: "wheel geometry",
  });
  assert.equal(
    context.memories.find((memory) => memory.id === imported.id)?.freshness,
    "changed",
  );
  assert.ok(context.omittedMemoryIds.includes(imported.id));
  const edited = await f.service.saveMemory({
    ...imported,
    content: "My reviewed user note",
  });
  assert.equal(edited.codexSource, undefined);
  context = await f.service.previewContext({
    projectId: thread.projectId,
    threadId: thread.id,
    provider: "claude",
    mode: "plan",
    prompt: "note",
  });
  assert.equal(
    context.memories.find((memory) => memory.id === imported.id)?.freshness,
    "unlinked",
  );
});

test("connection confirmation is rechecked and active native work prevents competing import, read and archive", async (t) => {
  const f = await fixture(t);
  const wrong = { ...f.connection, codexPath: `${f.executable}.different` };
  await assert.rejects(
    f.service.listCodexThreads({}, wrong),
    /connection changed/,
  );
  assert.equal((await f.nativeState()).calls.length, 0);
  const thread = await f.importThread();
  const request = {
    projectId: thread.projectId,
    threadId: thread.id,
    provider: "codex" as const,
    mode: "plan" as const,
    prompt: "WAIT_NATIVE",
  };
  await assert.rejects(
    f.service.startRun(request, wrong),
    /connection changed/,
  );
  const run = await f.service.startRun(request, f.connection);
  await assert.rejects(f.importThread(), /active Nova worker/);
  await assert.rejects(
    f.service.readCodexHistory({ threadId: SOURCE_ID }),
    /active Nova worker/,
  );
  await assert.rejects(
    f.service.updateThread({ id: thread.id, archived: true }),
    /active agent/,
  );
  await f.service.cancelRun(run.id);
  assert.equal((await finish(f.service, run.id)).status, "cancelled");
});

test("import persistence rollback preserves existing state and native recovery locks survive restart", async (t) => {
  const f = await fixture(t);
  const internals = f.service as unknown as { persist: () => Promise<void> };
  const persist = internals.persist;
  internals.persist = async () => {
    throw new Error("injected import disk failure");
  };
  await assert.rejects(f.importThread(), /import disk failure/);
  assert.equal((await f.service.snapshot()).state.projects.length, 0);
  assert.equal((await f.service.snapshot()).state.threads.length, 0);
  internals.persist = persist;
  const thread = await f.importThread();
  await f.service.dispose();
  const file = path.join(f.dataDir, "workspace.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.codexRecoveryHomes = [f.home];
  saved.threads[0].codex.history[0].text += "\0bounded visible text";
  await writeFile(file, JSON.stringify(saved));
  const restored = new WorkspaceService(f.dataDir, () => undefined);
  try {
    await restored.initialize();
    assert.deepEqual((await restored.snapshot()).state.codexRecoveryHomes, [
      f.home,
    ]);
    await assert.rejects(
      restored.listCodexThreads({}),
      /restarting Nova does not clear/,
    );
    await assert.rejects(
      restored.startRun({
        projectId: thread.projectId,
        threadId: thread.id,
        provider: "codex",
        mode: "plan",
        prompt: "Continue",
      }),
      /restarting Nova does not clear/,
    );
    assert.equal(
      (await restored.listCodexResources({ section: "memories" })).resources
        .length,
      0,
    );
  } finally {
    await restored.dispose();
  }
});

test("an interrupted Claude handoff locks project Build but not native Codex history after restart", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  const run = await f.service.startRun({
    projectId: thread.projectId,
    threadId: thread.id,
    provider: "claude",
    mode: "plan",
    prompt: "Inspect the imported requirements",
  });
  assert.equal((await finish(f.service, run.id)).status, "completed");
  await f.service.dispose();
  // Model a crash-time saved state without leaving a real fixture process alive.
  const file = path.join(f.dataDir, "workspace.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  const interrupted = saved.runs.find((entry: Run) => entry.id === run.id);
  interrupted.status = "running";
  delete interrupted.finishedAt;
  delete interrupted.terminationUnconfirmed;
  await writeFile(file, JSON.stringify(saved));
  const restored = new WorkspaceService(f.dataDir, () => undefined);
  try {
    await restored.initialize();
    const state = (await restored.snapshot()).state;
    assert.equal(
      state.runs.find((entry) => entry.id === run.id)?.status,
      "interrupted",
    );
    assert.equal(
      state.runs.find((entry) => entry.id === run.id)?.terminationUnconfirmed,
      true,
    );
    assert.deepEqual(state.codexRecoveryHomes ?? [], []);
    assert.equal(
      (await restored.listCodexThreads({}, f.connection)).threads[0].id,
      SOURCE_ID,
    );
    await assert.rejects(
      restored.startRun(
        {
          projectId: thread.projectId,
          threadId: thread.id,
          provider: "codex",
          mode: "build",
          prompt: "Build after the interrupted handoff",
        },
        f.connection,
      ),
      /Build is locked/,
    );
    assert.equal(
      (await restored.snapshot()).state.threads[0].worktreePath,
      undefined,
    );
  } finally {
    await restored.dispose();
  }
});

test("a native fork is never executed until its identity is durably saved", async (t) => {
  const f = await fixture(t);
  const thread = await f.importThread();
  const internals = f.service as unknown as {
    persist: () => Promise<void>;
    state: { runs: Run[] };
  };
  const persist = internals.persist;
  let injected = false;
  internals.persist = async () => {
    if (
      !injected &&
      internals.state.runs.some(
        (run) => run.providerSessionId && run.status === "running",
      )
    ) {
      injected = true;
      throw new Error("injected native-identity save failure");
    }
    await persist.call(f.service);
  };
  const run = await f.service.startRun({
    projectId: thread.projectId,
    threadId: thread.id,
    provider: "codex",
    mode: "build",
    prompt: "WRITE_NATIVE",
  });
  const result = await finish(f.service, run.id);
  assert.equal(injected, true);
  assert.equal(result.status, "failed");
  const native = await f.nativeState();
  assert.equal(
    native.calls.filter((call: any) => call.method === "thread/fork").length,
    1,
  );
  assert.equal(
    native.calls.some((call: any) => call.method === "turn/start"),
    false,
  );
  assert.equal(native.threads[0].cwd, f.cwd);
  const saved = (await f.service.snapshot()).state.threads[0];
  assert.ok(
    saved.codex?.forkedThreadId,
    "the unused engine-created fork remains attributable after terminal persistence",
  );
  await assert.rejects(
    readFile(path.join(saved.worktreePath!, "native-change.txt")),
    /ENOENT/,
  );
  internals.persist = persist;
});

test("shared imported context is bounded while native previews disclose retained provider context", async (t) => {
  const f = await fixture(t);
  const source = await f.nativeState();
  source.threads[0].turns = [
    {
      id: "bounded-turn",
      items: Array.from({ length: 16 }, (_, index) => ({
        type: "agentMessage",
        id: `escaped-${index}`,
        text: "\0".repeat(16_000),
      })),
    },
  ];
  await writeFile(f.nativeFile, JSON.stringify(source));
  const thread = await f.importThread();
  assert.ok(
    Buffer.byteLength(JSON.stringify(thread.codex?.history)) <= 1_048_576,
  );
  assert.equal(thread.codex?.historyTruncated, true);
  const state = (await f.service.snapshot()).state;
  state.threads[0].codex!.history = Array.from({ length: 200 }, (_, index) => ({
    id: `i-${index}`,
    turnId: `t-${index}`,
    role: index % 2 ? ("assistant" as const) : ("user" as const),
    text: `message-${index} ` + "x".repeat(16_000),
  }));
  state.threads[0].codex!.historyTruncated = true;
  const shared = await buildRunContext(state, thread, "Continue", f.cwd);
  assert.ok(shared.prompt.length < 15_000);
  assert.ok(
    shared.warnings.some((warning) =>
      warning.includes("12000-character budget"),
    ),
  );
  assert.ok(
    shared.warnings.some((warning) =>
      warning.includes("snapshot is incomplete"),
    ),
  );
  const native = await buildRunContext(state, thread, "Continue", f.cwd, {
    nativeCodex: true,
  });
  assert.ok(
    native.warnings.some((warning) =>
      warning.includes("not the full native context"),
    ),
  );
  assert.ok(!native.prompt.includes("importedCodexVisibleHistory"));
});
