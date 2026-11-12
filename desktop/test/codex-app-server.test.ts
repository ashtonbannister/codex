import assert from "node:assert/strict";
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
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/shared/types";
import {
  CodexAppServerError,
  CodexStdioClient,
  codexAppServerArguments,
  listCodexThreads,
  publishNativeHandoff,
  readCodexHistory,
  runNativeCodex,
  type NativeCodexOptions,
} from "../src/main/services/codex-app-server";
import { resolveExecutable } from "../src/main/services/providers";
import type { NormalizedEvent } from "../src/main/services/provider-events";

const SOURCE_ID = "019a0000-0000-7000-8000-000000000001";
const FORK_ID = "019a0000-0000-7000-8000-000000000002";

// This process only implements fixture RPCs. No installed Codex, model, network,
// account or authentication file is touched by these tests.
const fakeServer = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const home = process.env.CODEX_HOME;
const config = JSON.parse(fs.readFileSync(path.join(home, 'fixture.json'), 'utf8'));
const log = value => fs.appendFileSync(path.join(home, 'rpc.jsonl'), JSON.stringify(value)+'\n');
if(process.argv.includes('--print-startup-config')){
 log({kind:'preflight',args:process.argv.slice(2)});
 if(config.preflightWait){setTimeout(()=>process.exit(2),30000);}
 else if(config.preflightUnsupported){process.stderr.write('SECRET_STARTUP_DIAGNOSTIC');process.exit(1)}
 else if(config.preflightError){console.log(JSON.stringify({error:{message:'SECRET_STARTUP_DIAGNOSTIC'}}));process.exit(0)}
 else {console.log(JSON.stringify({appServerVersion:'fixture-1',configRequirements:{requirements:config.requiredFeatures?{featureRequirements:config.requiredFeatures}:null}}));process.exit(0)}
} else {
log({kind:'startup',args:process.argv.slice(2),remoteDisabled:process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED,cwd:process.cwd()});
let initialized = false;
let selected;
const sourceId = '019a0000-0000-7000-8000-000000000001';
const forkId = '019a0000-0000-7000-8000-000000000002';
const metadata = (id=sourceId,cwd=process.cwd()) => ({
 id,sessionId:id,forkedFromId:id===forkId?sourceId:null,parentThreadId:null,
 preview:'Existing conversation',name:'Native conversation',modelProvider:config.provider??'openai',model:'fixture-model',
 createdAt:1700000000,updatedAt:1700000100,status:{type:config.active?'active':'notLoaded'},
 cwd,source:'appServer',turns:[],path:'engine-only-private-path',
});
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const reply = (request,result) => send({id:request.id,result});
const notify = (method,params) => send({method,params});
const complete = request => {
 const turn = {id:'turn-new',status:config.failed?'failed':'completed',items:[],error:null};
 notify('item/completed',{threadId:selected,turnId:'turn-new',item:{id:'native-message',type:'agentMessage',text:'Native answer 🌲'}});
 notify('item/completed',{threadId:selected,turnId:'turn-new',item:{id:'native-message',type:'agentMessage',text:'Native answer 🌲'}});
 notify('item/completed',{threadId:selected,turnId:'turn-new',item:{id:'reasoning-private',type:'reasoning',summary:['PRIVATE_REASONING'],content:['PRIVATE_REASONING']}});
 notify('thread/tokenUsage/updated',{threadId:selected,turnId:'turn-new',tokenUsage:{last:{inputTokens:12,outputTokens:8,cachedInputTokens:3},total:{}}});
 notify('turn/completed',{threadId:selected,turn});
 if(config.earlyEvents) reply(request,{turn});
};
const input = readline.createInterface({input:process.stdin});
input.on('line', line => {
 const req=JSON.parse(line);log(req);
 if(req.method==='initialized'){initialized=true;return}
 if(!req.method){if(req.id==='approval-request'){log({kind:'denial',denied:!!req.error})}return}
 if(req.method==='initialize'){
  if(config.badJson){process.stdout.write('not JSON\n');return}
  if(config.badUtf8){process.stdout.write(Buffer.from([0xff,10]));return}
  if(config.bigLine){process.stdout.write('x'.repeat(2*1048576+1));return}
  if(config.stderrFlood){process.stderr.write('secret-diagnostic'.repeat(20000));return}
  if(config.waitInitialize)return;
  if(config.initializeError){send({id:req.id,error:{code:-32601,message:'SECRET_RPC_VALUE',data:{token:'SECRET_RPC_VALUE'}}});return}
  if(config.invalidError){send({id:req.id,error:'SECRET_RPC_VALUE'});return}
  if(config.wrongResponseId){send({id:req.id+999,result:{}});return}
  reply(req,{userAgent:'fixture-only',platformFamily:process.platform});return;
 }
 if(!initialized){send({id:req.id,error:{code:-32002,message:'initialize first'}});return}
 if(req.method==='thread/list'){
  if(config.waitList)return;
  if(config.rpcError){send({id:req.id,error:{code:-32001,message:'SECRET_RPC_VALUE',data:{token:'SECRET_RPC_VALUE'}}});return}
  reply(req,{data:[metadata()],nextCursor:'next-thread-page',backwardsCursor:null});return;
 }
 if(req.method==='thread/read'){reply(req,{thread:metadata(req.params.threadId,config.wrongSourceCwd?home:process.cwd())});return}
 if(req.method==='thread/turns/list'){
  const text=config.largeHistory?'z'.repeat(30000):'Newest response 🌲';
  const newest={id:'turn-newest',status:'completed',items:[
   {id:'u-new',type:'userMessage',content:[{type:'text',text:'Recent request',text_elements:[]},{type:'image',url:'private-image'}]},
   {id:'a-new',type:'agentMessage',text},
   {id:'r-new',type:'reasoning',summary:['PRIVATE_REASONING'],content:['PRIVATE_REASONING']},
   {id:'t-new',type:'commandExecution',command:'PRIVATE_TOOL_COMMAND',aggregatedOutput:'PRIVATE_TOOL_OUTPUT'},
  ],error:null};
  const older={id:'turn-older',status:'completed',items:[
   {id:'u-old',type:'userMessage',content:[{type:'text',text:'Older question',text_elements:[]}]},
   {id:'a-old',type:'agentMessage',text:'Older answer'},
  ],error:null};
  reply(req,{data:config.emptyHistory?[]:[newest,older],nextCursor:config.noMoreHistory?null:'older-page',backwardsCursor:null});return;
 }
 if(req.method==='config/read'){
  if(config.configUnsupported){send({id:req.id,error:{code:-32601,message:'unknown'}});return}
  const servers={'literal.dot':{command:'PRIVATE_TOOL_COMMAND',env:{TOKEN:'SECRET_CONFIG_VALUE'}},normal:{url:'https://example.invalid',headers:{Authorization:'SECRET_CONFIG_VALUE'}}};
  reply(req,{config:{mcp_servers:servers,api_key:'SECRET_CONFIG_VALUE'},origins:{},layers:null});return;
 }
 if(req.method==='thread/resume'||req.method==='thread/fork'||req.method==='thread/start'){
  if(config.archivedAfterRead&&req.method==='thread/resume'){send({id:req.id,error:{code:-32600,message:'session is archived; unarchive it first'}});return}
  selected=req.method==='thread/resume'?sourceId:forkId;
  const cwd=config.wrongCwd?home:req.params.cwd;
  const sandbox=req.params.sandbox==='read-only'?{type:'readOnly',networkAccess:false}:{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
  if(config.unsafeSandbox)sandbox.networkAccess=true;
  reply(req,{thread:metadata(config.sameFork?sourceId:selected,cwd),cwd,modelProvider:config.sessionProvider??'openai',model:'fixture-model',approvalPolicy:'never',approvalsReviewer:'user',sandbox});return;
 }
 if(req.method==='thread/name/set'){reply(req,{});return}
 if(req.method==='thread/inject_items'){
  if(config.requirePersist&&!fs.existsSync(path.join(home,'persisted')))throw new Error('injection before persist');
  if(config.injectError){send({id:req.id,error:{code:-32601,message:'SECRET_RPC_VALUE'}});return}
  reply(req,{});return;
 }
 if(req.method==='turn/start'){
  if(config.requirePersist&&!fs.existsSync(path.join(home,'persisted')))throw new Error('turn started before persist');
  if(config.serverRequest)send({id:'approval-request',method:'account/chatgptAuthTokens/refresh',params:{reason:'fixture'}});
  if(!config.earlyEvents)reply(req,{turn:{id:'turn-new',status:'inProgress',items:[],error:null}});
  if(config.waitTurn){notify('item/started',{threadId:selected,turnId:'turn-new',item:{id:'waiting',type:'commandExecution',command:'fixture-wait'}});return}
  if(config.outputFlood){notify('item/completed',{threadId:selected,turnId:'turn-new',item:{id:'huge',type:'agentMessage',text:'z'.repeat(20000)}});return}
  if(config.noTerminal){notify('item/completed',{threadId:selected,turnId:'turn-new',item:{id:'answer',type:'agentMessage',text:'No terminal'}});return}
  setTimeout(()=>complete(req),config.serverRequest?40:0);return;
 }
 if(req.method==='turn/interrupt'){reply(req,{});notify('turn/completed',{threadId:selected,turn:{id:'turn-new',status:'interrupted',items:[],error:null}});return}
 if(req.method==='test/wait')return;
 send({id:req.id,error:{code:-32601,message:'unknown fixture method'}});
});
input.on('close',()=>{log({kind:'eof'});process.exit(0)});
setTimeout(()=>process.exit(2),30000).unref();
}
`;

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  config: Record<string, unknown> = {},
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "nova-app-server-")),
  );
  const home = path.join(root, "engine home");
  const cwd = path.join(root, "project with spaces");
  await mkdir(home);
  await mkdir(cwd);
  const executable = path.join(root, "fake-codex.mjs");
  await writeFile(executable, fakeServer);
  await writeFile(path.join(home, "fixture.json"), JSON.stringify(config));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const options = {
    settings: { ...DEFAULT_SETTINGS, codexPath: executable },
    home,
    cwd,
  };
  const requests = async () => {
    let text: string;
    try {
      text = await readFile(path.join(home, "rpc.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // Polling can race the fixture's single append; read only complete records.
    return text
      .slice(0, text.lastIndexOf("\n") + 1)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
  };
  return { ...options, options, requests, executable };
}

async function waitForRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  predicate: (request: Record<string, any>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await f.requests()).some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Fake app-server did not reach the expected RPC checkpoint.");
}

function nativeOptions(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<NativeCodexOptions> = {},
): NativeCodexOptions {
  return {
    ...f.options,
    mode: "plan",
    model: "",
    threadId: SOURCE_ID,
    fork: false,
    prompt: "Continue the existing work",
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    maxBytes: 1_048_576,
    onEvent: () => undefined,
    onThreadReady: async () => undefined,
    ...overrides,
  };
}

test("publishes a bounded native context handoff without inference or changing an original thread", async (t) => {
  const f = await fixture(t, { requirePersist: true });
  const result = await publishNativeHandoff({ ...f.options,
    title: "Nova · shared work", text: "Visible user and Claude/local reference only.",
    onThreadCreated: async (id) => {
      assert.equal(id, FORK_ID);
      await writeFile(path.join(f.home, "persisted"), id);
    },
  });
  assert.equal(result.nativeThreadId, FORK_ID);
  const requests = await f.requests();
  assert.ok(requests.some((entry) => entry.method === "thread/start" && entry.params.ephemeral === false));
  assert.ok(requests.some((entry) => entry.method === "thread/name/set" && entry.params.threadId === FORK_ID));
  const injection = requests.find((entry) => entry.method === "thread/inject_items");
  assert.deepEqual(injection?.params.items, [{ type: "message", role: "user", content: [{ type: "input_text", text: "Visible user and Claude/local reference only." }] }]);
  assert.ok(!requests.some((entry) => ["turn/start", "thread/resume", "thread/fork"].includes(entry.method)));
  assert.ok(!JSON.stringify(result).includes("SECRET_CONFIG_VALUE"));
});

test("handoff records the native ID before an unsupported injection fails and never starts a turn", async (t) => {
  const f = await fixture(t, { injectError: true });
  let retainedId: string | undefined;
  await assert.rejects(publishNativeHandoff({ ...f.options, title: "Handoff", text: "Reference",
    onThreadCreated: async (id) => { retainedId = id; },
  }), (error: unknown) => error instanceof CodexAppServerError && !error.message.includes("SECRET_RPC_VALUE"));
  assert.equal(retainedId, FORK_ID);
  assert.ok(!(await f.requests()).some((entry) => entry.method === "turn/start"));
});

test("handoff aborts before injection if its receipt cannot be saved", async (t) => {
  const f = await fixture(t);
  await assert.rejects(publishNativeHandoff({ ...f.options, title: "Handoff", text: "Reference",
    onThreadCreated: async () => { throw new Error("receipt disk failure"); },
  }), /receipt disk failure/);
  assert.ok(!(await f.requests()).some((entry) => ["thread/inject_items", "turn/start"].includes(entry.method)));
});

test("app-server flags constrain supported worker features without pretending empty MCP clears config", () => {
  const args = codexAppServerArguments("win32");
  for (const flag of [
    "--stdio",
    "--strict-config",
    "features.hooks=false",
    "features.plugins=false",
    "features.goals=false",
    "memories.generate_memories=false",
    'windows.sandbox="unelevated"',
  ])
    assert.ok(args.includes(flag));
  assert.ok(!args.includes("--ignore-user-config"));
  assert.ok(!args.some((arg) => arg.startsWith("mcp_servers=")));
  assert.ok(!args.some((arg) => arg.includes("danger-full-access")));
});

test("native history listing initializes in order, uses all interactive native sources, and exposes no engine path", async (t) => {
  const f = await fixture(t);
  const result = await listCodexThreads(f.options, {
    archived: true,
    search: "native",
    cursor: "opaque-cursor",
  });
  assert.equal(result.threads[0].id, SOURCE_ID);
  assert.equal(result.threads[0].archived, true);
  assert.equal(result.threads[0].source, "appServer");
  assert.equal(result.threads[0].createdAt, "2023-11-14T22:13:20.000Z");
  assert.equal(result.nextCursor, "next-thread-page");
  assert.ok(!JSON.stringify(result).includes("engine-only-private-path"));
  const requests = await f.requests();
  assert.deepEqual(
    requests.filter((r) => r.method).map((r) => r.method),
    ["initialize", "initialized", "thread/list"],
  );
  const params = requests.find((r) => r.method === "thread/list")!.params;
  assert.deepEqual(params.sourceKinds, [
    "cli",
    "vscode",
    "exec",
    "appServer",
    "unknown",
  ]);
  assert.equal(params.useStateDbOnly, true);
  assert.equal(params.currentAccountOnly, true);
  assert.equal(params.cursor, "opaque-cursor");
  assert.equal(requests[0].kind, "preflight");
  assert.ok(requests[0].args.includes("--print-startup-config"));
  assert.ok(!requests[0].args.includes("--stdio"));
  assert.equal(requests.find((r) => r.kind === "startup")!.remoteDisabled, "1");
  assert.ok(requests.some((r) => r.kind === "eof"));
});

test("visible history gets newest page, returns chronological order, and omits hidden/tool/attachment data", async (t) => {
  const f = await fixture(t);
  const result = await readCodexHistory(f.options, {
    threadId: SOURCE_ID,
    cursor: "older-cursor",
  });
  assert.deepEqual(
    result.messages.map((m) => m.id),
    ["u-old", "a-old", "u-new", "a-new"],
  );
  assert.equal(result.messages.at(-1)!.text, "Newest response 🌲");
  assert.equal(result.nextCursor, "older-page");
  assert.equal(result.truncated, true);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  assert.ok(!JSON.stringify(result).includes("private-image"));
  const params = (await f.requests()).find(
    (r) => r.method === "thread/turns/list",
  )!.params;
  assert.equal(params.itemsView, "full");
  assert.equal(params.sortDirection, "desc");
  assert.equal(params.cursor, "older-cursor");
});

test("visible history bounds long text and marks omission instead of pretending full transfer", async (t) => {
  const f = await fixture(t, { largeHistory: true });
  const result = await readCodexHistory(f.options, { threadId: SOURCE_ID });
  assert.equal(result.messages.at(-1)!.text.length, 16_000);
  assert.equal(result.truncated, true);
  assert.match(result.warnings.join(" "), /shortened/);
});

test("native Plan resumes source and persists ready ID before turn, with only per-server disable overrides", async (t) => {
  const f = await fixture(t, {
    requirePersist: true,
    serverRequest: true,
    earlyEvents: true,
  });
  const events: NormalizedEvent[] = [];
  const result = await runNativeCodex(
    nativeOptions(f, {
      onThreadReady: async (id) => {
        assert.equal(id, SOURCE_ID);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeFile(path.join(f.home, "persisted"), id);
      },
      onEvent: (event) => events.push(event),
    }),
  );
  assert.deepEqual(result, { completed: true, cancelled: false });
  const requests = await f.requests();
  const resume = requests.find((r) => r.method === "thread/resume")!.params;
  assert.equal(resume.threadId, SOURCE_ID);
  assert.equal(resume.cwd, f.cwd);
  assert.equal(resume.sandbox, "read-only");
  assert.deepEqual(resume.config.mcp_servers, {
    "literal.dot": { enabled: false },
    "normal": { enabled: false },
  });
  assert.equal(resume.config["memories.generate_memories"], false);
  assert.equal(
    requests.find((r) => r.method === "config/read")!.params.includeLayers,
    false,
  );
  assert.ok(!JSON.stringify(resume).includes("SECRET_"));
  assert.ok(requests.some((r) => r.kind === "denial" && r.denied));
  assert.equal(
    events.flatMap((e) => e.events).filter((e) => e.kind === "message").length,
    1,
  );
  assert.equal(events.find((e) => e.usage)?.usage?.inputTokens, 12);
  assert.ok(!JSON.stringify(events).includes("PRIVATE_"));
  assert.ok(!JSON.stringify(events).includes("SECRET_"));
});

test("isolated native Build forks history, uses target cwd, and never resumes/unarchives source", async (t) => {
  const f = await fixture(t, { requirePersist: true });
  const result = await runNativeCodex(
    nativeOptions(f, {
      mode: "build",
      fork: true,
      onThreadReady: async (id) => {
        assert.equal(id, FORK_ID);
        await writeFile(path.join(f.home, "persisted"), id);
      },
    }),
  );
  assert.equal(result.completed, true);
  const requests = await f.requests();
  assert.ok(
    !requests.some((r) =>
      ["thread/resume", "thread/unarchive"].includes(r.method),
    ),
  );
  const fork = requests.find((r) => r.method === "thread/fork")!.params;
  assert.equal(fork.threadId, SOURCE_ID);
  assert.equal(fork.sandbox, "workspace-write");
  const turn = requests.find((r) => r.method === "turn/start")!.params;
  assert.equal(turn.threadId, FORK_ID);
  assert.deepEqual(turn.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [f.cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
});

test("native archived Plan can fork without auto-unarchiving", async (t) => {
  const f = await fixture(t);
  const result = await runNativeCodex(nativeOptions(f, { fork: true }));
  assert.equal(result.completed, true);
  const requests = await f.requests();
  assert.equal(
    requests.find((r) => r.method === "thread/fork")!.params.sandbox,
    "read-only",
  );
  assert.ok(!requests.some((r) => r.method === "thread/unarchive"));
});

for (const [label, config, expected] of [
  ["active source", { active: true }, /active/],
  ["native provider mismatch", { provider: "ollama" }, /different provider/],
  [
    "effective provider mismatch",
    { sessionProvider: "ollama" },
    /different provider/,
  ],
  [
    "unexpected writable/sandbox permissions",
    { unsafeSandbox: true },
    /restricted sandbox/,
  ],
  ["wrong native cwd", { wrongCwd: true }, /working directory/],
  ["unsupported safe config", { configUnsupported: true }, /rejected/],
] as const) {
  test(`native turn refuses ${label} before any model request`, async (t) => {
    const f = await fixture(t, config);
    const result = await runNativeCodex(nativeOptions(f));
    assert.equal(result.completed, false);
    assert.match(result.error!, expected);
    assert.ok(!(await f.requests()).some((r) => r.method === "turn/start"));
  });
}

test("fork ID persistence failure never starts a turn or mutates source", async (t) => {
  const f = await fixture(t);
  const result = await runNativeCodex(
    nativeOptions(f, {
      fork: true,
      onThreadReady: async () => {
        throw new Error("SECRET_STORAGE_VALUE");
      },
    }),
  );
  assert.equal(result.completed, false);
  assert.ok(!result.error!.includes("SECRET_"));
  assert.ok(!(await f.requests()).some((r) => r.method === "turn/start"));
});

test("cancellation during native ID persistence prevents turn/start", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const result = await runNativeCodex(
    nativeOptions(f, {
      signal: controller.signal,
      onThreadReady: async () => {
        controller.abort();
      },
    }),
  );
  assert.equal(result.completed, false);
  assert.equal(result.cancelled, true);
  assert.ok(!result.terminationUnconfirmed);
  assert.ok(!(await f.requests()).some((r) => r.method === "turn/start"));
});

test("native cancellation sends interrupt and waits for confirmed process cleanup", async (t) => {
  const f = await fixture(t, { waitTurn: true });
  const controller = new AbortController();
  const result = await runNativeCodex(
    nativeOptions(f, {
      signal: controller.signal,
      onEvent: (event) => {
        if (
          event.events.some(
            (entry) => entry.text === "Native Codex turn started.",
          )
        )
          controller.abort();
      },
    }),
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.completed, false);
  assert.ok(!result.terminationUnconfirmed);
  assert.ok((await f.requests()).some((r) => r.method === "turn/interrupt"));
  assert.ok((await f.requests()).some((r) => r.kind === "eof"));
});

test("native timeout without terminal event is failure, never inferred success", async (t) => {
  const f = await fixture(t, { noTerminal: true });
  const result = await runNativeCodex(
    nativeOptions(f, { timeoutMs: process.platform === "win32" ? 6_000 : 500 }),
  );
  assert.equal(result.completed, false);
  assert.equal(result.cancelled, false);
  assert.match(result.error!, /time limit/);
});

test("native output cap terminates worker and fails without discarding the safety bound", async (t) => {
  const f = await fixture(t, { outputFlood: true });
  const result = await runNativeCodex(nativeOptions(f, { maxBytes: 2_000 }));
  assert.equal(result.completed, false);
  assert.match(result.error!, /output exceeded/);
});

for (const [label, config, expected] of [
  ["malformed JSON", { badJson: true }, /invalid JSON/],
  ["malformed UTF-8", { badUtf8: true }, /UTF-8/],
  ["oversized message", { bigLine: true }, /oversized/],
  ["diagnostic flood", { stderrFlood: true }, /diagnostics exceeded/],
  ["wrong response ID", { wrongResponseId: true }, /unexpected RPC/],
  ["malformed error envelope", { invalidError: true }, /invalid RPC error/],
  ["initialize RPC error", { initializeError: true }, /rejected/],
] as const) {
  test(`bounded transport rejects ${label} without exposing native diagnostic secrets`, async (t) => {
    const f = await fixture(t, config);
    await assert.rejects(
      () => listCodexThreads(f.options, {}),
      (error: unknown) => {
        assert.ok(error instanceof CodexAppServerError);
        assert.match(error.message, expected);
        assert.ok(!error.message.includes("SECRET_"));
        return true;
      },
    );
  });
}

test("metadata RPC errors stay sanitized and do not fall back to rollout/auth file reads", async (t) => {
  const f = await fixture(t, { rpcError: true });
  await assert.rejects(
    () => listCodexThreads(f.options, {}),
    (error: unknown) => {
      assert.ok(error instanceof CodexAppServerError);
      assert.match(error.message, /-32001/);
      assert.ok(!error.message.includes("SECRET_"));
      return true;
    },
  );
});

test("transport request timeout rejects pending requests and closes the owned worker", async (t) => {
  const f = await fixture(t);
  const client = new CodexStdioClient(
    await resolveExecutable(f.executable),
    f.options,
  );
  t.after(async () => {
    await client.close();
  });
  await client.initialize();
  await assert.rejects(client.request("test/wait", {}, 20), /time limit/);
  assert.equal(await client.close(), true);
});

test("metadata cancellation while waiting for initialize has bounded cleanup", async (t) => {
  const f = await fixture(t, { waitInitialize: true });
  const controller = new AbortController();
  const pending = listCodexThreads(
    { ...f.options, signal: controller.signal },
    {},
  );
  void pending.catch(() => undefined);
  try {
    await waitForRequest(f, (request) => request.method === "initialize");
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  } finally {
    controller.abort();
    await pending.catch(() => undefined);
  }
});

test("managed feature requirements refuse startup before app-server can initialize hooks/plugins", async (t) => {
  const f = await fixture(t, { requiredFeatures: { hooks: true } });
  await assert.rejects(
    () => listCodexThreads(f.options, {}),
    /Managed Codex policy requires a feature/,
  );
  const requests = await f.requests();
  assert.deepEqual(
    requests.map((r) => r.kind),
    ["preflight"],
  );
  assert.ok(!requests.some((r) => r.method === "initialize"));
});

test("managed legacy feature alias cannot re-enable hooks during startup", async (t) => {
  const f = await fixture(t, { requiredFeatures: { codex_hooks: true } });
  await assert.rejects(
    () => listCodexThreads(f.options, {}),
    /Managed Codex policy/,
  );
  assert.ok(!(await f.requests()).some((r) => r.kind === "startup"));
});

test("managed disabled features pass preflight without changing requirements", async (t) => {
  const f = await fixture(t, {
    requiredFeatures: { hooks: false, plugins: false },
  });
  const result = await listCodexThreads(f.options, {});
  assert.equal(result.threads[0].id, SOURCE_ID);
  assert.ok((await f.requests()).some((r) => r.kind === "startup"));
});

for (const [label, config] of [
  ["unsupported one-shot discovery", { preflightUnsupported: true }],
  ["structured startup policy error", { preflightError: true }],
] as const) {
  test(`native connection refuses ${label} without exposing diagnostics`, async (t) => {
    const f = await fixture(t, config);
    await assert.rejects(
      () => listCodexThreads(f.options, {}),
      (error: unknown) => {
        assert.ok(error instanceof CodexAppServerError);
        assert.ok(!error.message.includes("SECRET_"));
        return true;
      },
    );
    assert.ok(!(await f.requests()).some((r) => r.kind === "startup"));
  });
}

test("cancelling startup preflight closes it before launching app-server", async (t) => {
  const f = await fixture(t, { preflightWait: true });
  const controller = new AbortController();
  const pending = listCodexThreads(
    { ...f.options, signal: controller.signal },
    {},
  );
  void pending.catch(() => undefined);
  try {
    await waitForRequest(f, (request) => request.kind === "preflight");
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  } finally {
    controller.abort();
    await pending.catch(() => undefined);
  }
  assert.ok(!(await f.requests()).some((r) => r.kind === "startup"));
});

test("native run time budget includes startup preflight without an unbounded hidden launch", async (t) => {
  const f = await fixture(t, { preflightWait: true });
  const result = await runNativeCodex(nativeOptions(f, { timeoutMs: 150 }));
  assert.equal(result.completed, false);
  assert.equal(result.cancelled, false);
  assert.match(result.error!, /time limit/);
  assert.ok(!(await f.requests()).some((r) => r.kind === "startup"));
});

test("externally archived source is rejected by resume and never auto-unarchived", async (t) => {
  const f = await fixture(t, { archivedAfterRead: true });
  const result = await runNativeCodex(nativeOptions(f));
  assert.equal(result.completed, false);
  const requests = await f.requests();
  assert.ok(requests.some((r) => r.method === "thread/resume"));
  assert.ok(
    !requests.some((r) =>
      ["turn/start", "thread/unarchive"].includes(r.method),
    ),
  );
});

test("externally moved native source is not silently repointed by resume", async (t) => {
  const f = await fixture(t, { wrongSourceCwd: true });
  const result = await runNativeCodex(nativeOptions(f));
  assert.equal(result.completed, false);
  assert.match(result.error!, /current folder has changed/);
  assert.match(result.error!, /did not repoint/);
  const requests = await f.requests();
  assert.ok(requests.some((r) => r.method === "thread/read"));
  assert.ok(
    !requests.some((r) =>
      ["config/read", "thread/resume", "turn/start"].includes(r.method),
    ),
  );
});

test("explicit native fork may relocate history without repointing its source", async (t) => {
  const f = await fixture(t, { wrongSourceCwd: true });
  const result = await runNativeCodex(
    nativeOptions(f, { fork: true, mode: "build" }),
  );
  assert.equal(result.completed, true);
  const requests = await f.requests();
  assert.ok(!requests.some((r) => r.method === "thread/resume"));
  assert.equal(
    requests.find((r) => r.method === "thread/fork")!.params.cwd,
    f.cwd,
  );
  assert.equal(
    requests.find((r) => r.method === "turn/start")!.params.threadId,
    FORK_ID,
  );
});
