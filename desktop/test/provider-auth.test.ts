import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/shared/types";
import {
  ProviderAuthService,
  officialLoginUrl,
} from "../src/main/services/provider-auth";

// Synthetic CLI/RPC only. Tests never start installed tools, read credentials,
// open a browser, contact a provider, or issue model requests.
const fake = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const cwd = process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(cwd,'fixture.json'),'utf8'));
const log = value => fs.appendFileSync(path.join(cwd,'calls.jsonl'),JSON.stringify(value)+'\n');
const args = process.argv.slice(2);
log({args});
process.once('exit',()=>log({kind:'exit'}));
const signed = () => config.signedIn || fs.existsSync(path.join(cwd,'signed-in'));
if(args.includes('--print-startup-config')){
 console.log(JSON.stringify({appServerVersion:'fixture-only',configRequirements:{requirements:null}}));
} else if(args.includes('auth')) {
 if(!args.includes('--safe-mode')) process.exit(8);
 if(args.includes('--help')) { console.log('Commands: login, logout, status'); }
 else if(args.includes('status')) {
  if(config.invalidStatus){console.log('SECRET_DIAGNOSTIC');process.exit(1)}
  console.log(JSON.stringify({loggedIn:signed(),authMethod:signed()?'claude.ai':'none',email:signed()?'fixture@example.invalid':null,configDirectory:'SECRET_CONFIGURATION_PATH',accessToken:'SECRET_CREDENTIAL'}));
  process.exit(signed()?0:1);
 } else if(args.includes('login')) {
  console.error('SECRET_DIAGNOSTIC https://attacker.invalid/oauth?token=SECRET_CREDENTIAL');
  console.log('https://claude.ai/oauth/authorize?state=synthetic-login');
  if(config.failLogin) process.exit(2);
  const timer=setInterval(()=>{
   if(fs.existsSync(path.join(cwd,'finish-login'))){
    fs.writeFileSync(path.join(cwd,'signed-in'),'yes');clearInterval(timer);process.exit(0);
   }
  },40);
 }
} else {
 const send = value => process.stdout.write(JSON.stringify(value)+'\n');
 const reply = (req,result) => send({id:req.id,result});
 const input=readline.createInterface({input:process.stdin});
 input.on('line',line=>{
  const req=JSON.parse(line);log(req);
  if(req.method==='initialize'){reply(req,{userAgent:'fixture-only'});return}
  if(req.method==='initialized')return;
  if(req.method==='account/read'){
   reply(req,{account:signed()?{type:'chatgpt',email:'fixture@example.invalid',planType:'pro',workspaceName:'Synthetic workspace',accessToken:'SECRET_CREDENTIAL'}:null,requiresOpenaiAuth:true,userId:'DO_NOT_EXPOSE'});return;
  }
  if(req.method==='account/login/start'){
   reply(req,{type:'chatgpt',loginId:'fixture-login',authUrl:config.unsafeUrl?'https://auth.openai.com.attacker.invalid/oauth':'https://auth.openai.com/oauth/authorize?state=synthetic-login'});
   if(!config.waitLogin)setTimeout(()=>{
    fs.writeFileSync(path.join(cwd,'signed-in'),'yes');
    send({method:'account/login/completed',params:{loginId:'fixture-login',success:true,error:'SECRET_DIAGNOSTIC'}});
   },30);
   return;
  }
  if(req.method==='account/login/cancel'){reply(req,{status:'canceled'});return}
  send({id:req.id,error:{code:-32601,message:'SECRET_DIAGNOSTIC'}});
 });
 input.on('close',()=>process.exit(0));
}
setTimeout(()=>process.exit(9),30000).unref();
`;

type OperationHooks = Pick<ConstructorParameters<typeof ProviderAuthService>[0],
  "onOperationStart" | "onOperationFinished" | "onRecoveryRequired">;

async function fixture(t: { after(fn: () => Promise<void>): void }, config = {}, hooks: OperationHooks = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "nova-account-")));
  const home = path.join(root, "codex home");
  await mkdir(home);
  const executable = path.join(root, "official-fixture.mjs");
  await writeFile(executable, fake);
  await writeFile(path.join(root, "fixture.json"), JSON.stringify(config));
  const urls: string[] = [];
  const service = new ProviderAuthService({ openExternal: async (url) => { urls.push(url); }, ...hooks });
  t.after(async () => {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const calls = async () => {
    let data: string;
    try { data = await readFile(path.join(root, "calls.jsonl"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return data.slice(0, data.lastIndexOf("\n") + 1).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  return {
    root, home, urls, calls, service,
    options: {
      settings: { ...DEFAULT_SETTINGS, codexPath: executable, claudePath: executable },
      home,
      cwd: root,
    },
  };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Synthetic account operation did not reach its checkpoint.");
}

test("account URLs reject lookalikes, credentials, alternate handlers and ports", () => {
  assert.equal(officialLoginUrl("codex", "https://auth.openai.com/oauth?state=fixture"), "https://auth.openai.com/oauth?state=fixture");
  assert.equal(officialLoginUrl("claude", "https://claude.ai/oauth/authorize"), "https://claude.ai/oauth/authorize");
  for (const url of ["http://auth.openai.com/", "javascript:alert(1)", "https://auth.openai.com.attacker.invalid/", "https://me:secret@auth.openai.com/", "https://auth.openai.com:8443/", "https://auth.openai.com/#secret", "https://claude.ai/"])
    assert.equal(officialLoginUrl("codex", url), undefined);
});

test("Codex account status is metadata-only and exposes only whitelisted fields", async (t) => {
  const f = await fixture(t, { signedIn: true });
  const status = await f.service.read("codex", f.options);
  assert.equal(status.state, "signed-in");
  assert.equal(status.method, "chatgpt");
  assert.equal(status.label, "fixture@example.invalid");
  assert.doesNotMatch(JSON.stringify(status), /SECRET|DO_NOT_EXPOSE/);
  const calls = await f.calls();
  assert.equal(calls.find((x) => x.method === "account/read").params.refreshToken, false);
  assert.ok(!calls.some((x) => /^(thread|turn)\//.test(x.method ?? "")));
  assert.equal(f.service.busy, false);
});

test("Codex login opens its official URL, waits for completion and checks account", async (t) => {
  const f = await fixture(t);
  const start = await f.service.start("codex", f.options);
  assert.equal(start.state, "starting");
  assert.equal(f.service.busy, true);
  await assert.rejects(f.service.read("claude", f.options), /already running/);
  await until(() => !f.service.busy);
  assert.equal(f.service.getLogin()?.state, "complete");
  assert.deepEqual(f.urls, ["https://auth.openai.com/oauth/authorize?state=synthetic-login"]);
  const calls = await f.calls();
  assert.deepEqual(calls.find((x) => x.method === "account/login/start").params, { type: "chatgpt" });
  assert.ok(calls.some((x) => x.method === "account/read"));
  assert.doesNotMatch(JSON.stringify(f.service.getLogin()), /SECRET|authUrl|verificationUrl/);
});

test("Codex rejects a non-official login URL without opening it", async (t) => {
  const finished: string[] = [];
  const f = await fixture(t, { unsafeUrl: true, waitLogin: true }, {
    onOperationStart: async () => "lease-invalid-login",
    onOperationFinished: async (id) => { finished.push(id); },
  });
  await f.service.start("codex", f.options);
  await until(() => !f.service.busy);
  assert.equal(f.service.getLogin()?.state, "failed");
  assert.match(f.service.getLogin()!.message, /non-official/);
  assert.deepEqual(f.urls, []);
  assert.deepEqual(finished, ["lease-invalid-login"]);
});

test("cancel requests official login cancellation and awaits owned-process cleanup", async (t) => {
  const finished: string[] = [];
  const f = await fixture(t, { waitLogin: true }, {
    onOperationStart: async () => "lease-active-cancel",
    onOperationFinished: async (id) => { finished.push(id); },
  });
  await f.service.start("codex", f.options);
  await until(() => f.service.getLogin()?.state === "waiting");
  await f.service.cancel();
  assert.equal(f.service.busy, false);
  assert.equal(f.service.getLogin()?.state, "cancelled");
  assert.ok((await f.calls()).some((x) => x.method === "account/login/cancel"));
  assert.deepEqual(finished, ["lease-active-cancel"]);
});

test("Claude status and browser sign-in use official commands without sharing credentials", async (t) => {
  const f = await fixture(t);
  const initial = await f.service.read("claude", f.options);
  assert.equal(initial.state, "signed-out");
  await f.service.start("claude", f.options);
  await until(() => !!f.service.getLogin()?.verificationUrl);
  const pending = f.service.getLogin()!;
  assert.equal(pending.verificationUrl, "https://claude.ai/oauth/authorize?state=synthetic-login");
  assert.doesNotMatch(JSON.stringify(pending), /SECRET|attacker/);
  await writeFile(path.join(f.root, "finish-login"), "yes");
  await until(() => !f.service.busy);
  assert.equal(f.service.getLogin()?.state, "complete");
  const status = await f.service.read("claude", f.options);
  assert.equal(status.state, "signed-in");
  assert.doesNotMatch(JSON.stringify(status), /SECRET|configDirectory|accessToken/);
  assert.deepEqual(f.urls, []); // The official Claude CLI owns browser launch.
  const commands = (await f.calls()).filter((x) => x.args).map((x) => x.args);
  assert.ok(commands.some((args) => JSON.stringify(args) === JSON.stringify(["--safe-mode", "auth", "login"])));
  assert.ok(commands.every((args) => args.includes("--safe-mode")));
});

test("Claude malformed account output is redacted and cannot become sign-in success", async (t) => {
  const f = await fixture(t, { invalidStatus: true });
  const status = await f.service.read("claude", f.options);
  assert.equal(status.state, "unavailable");
  assert.match(status.message!, /incompatible/);
  assert.doesNotMatch(JSON.stringify(status), /SECRET/);
});

test("durable account leases precede children and finish only after process exit", async (t) => {
  const events: string[] = [];
  let root = "";
  const f = await fixture(t, {}, {
    onOperationStart: async (provider, home) => {
      root = path.dirname(home);
      await assert.rejects(readFile(path.join(root, "calls.jsonl")), { code: "ENOENT" });
      events.push(`start:${provider}`);
      return "lease-login";
    },
    onOperationFinished: async (id) => {
      const lines = (await readFile(path.join(root, "calls.jsonl"), "utf8")).trim().split("\n");
      assert.equal(JSON.parse(lines.at(-1)!).kind, "exit");
      events.push(`finish:${id}`);
    },
  });
  await f.service.start("codex", f.options);
  await until(() => !f.service.busy);
  assert.equal(f.service.getLogin()?.state, "complete");
  assert.deepEqual(events, ["start:codex", "finish:lease-login"]);
});

test("a rejected status response clears its durable lease after confirmed cleanup", async (t) => {
  const events: string[] = [];
  let root = "";
  const f = await fixture(t, { invalidStatus: true }, {
    onOperationStart: async (provider, home) => {
      root = path.dirname(home);
      await assert.rejects(readFile(path.join(root, "calls.jsonl")), { code: "ENOENT" });
      events.push(`start:${provider}`);
      return "lease-status";
    },
    onOperationFinished: async (id) => {
      const lines = (await readFile(path.join(root, "calls.jsonl"), "utf8")).trim().split("\n");
      assert.equal(JSON.parse(lines.at(-1)!).kind, "exit");
      events.push(`finish:${id}`);
    },
  });
  assert.equal((await f.service.read("claude", f.options)).state, "unavailable");
  assert.deepEqual(events, ["start:claude", "finish:lease-status"]);
});

test("cancel during lease creation starts no child and clears only its own lease", async (t) => {
  let release: ((id: string) => void) | undefined;
  const ended: string[] = [];
  const f = await fixture(t, {}, {
    onOperationStart: () => new Promise<string>((resolve) => { release = resolve; }),
    onOperationFinished: async (id) => { ended.push(id); },
  });
  await f.service.start("codex", f.options);
  const cancelling = f.service.cancel();
  assert.equal(f.service.busy, true);
  release!("lease-cancelled-before-launch");
  await cancelling;
  assert.equal(f.service.getLogin()?.state, "cancelled");
  assert.equal(f.service.busy, false);
  assert.deepEqual(ended, ["lease-cancelled-before-launch"]);
  assert.deepEqual(await f.calls(), []);
});

test("failure to persist a lease launches nothing and permits a later clean retry", async (t) => {
  let starts = 0;
  const ended: string[] = [];
  const f = await fixture(t, { signedIn: true }, {
    onOperationStart: async () => {
      if (++starts === 1) throw new Error("SECRET_STORAGE_DIAGNOSTIC");
      return "lease-retry";
    },
    onOperationFinished: async (id) => { ended.push(id); },
  });
  const failed = await f.service.read("claude", f.options);
  assert.equal(failed.state, "unavailable");
  assert.match(failed.message!, /No provider process was started/);
  assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
  assert.deepEqual(await f.calls(), []);
  assert.deepEqual(ended, []);
  assert.equal(f.service.busy, false);
  assert.equal((await f.service.read("claude", f.options)).state, "signed-in");
  assert.deepEqual(ended, ["lease-retry"]);
});

test("failure to clear a completed login lease fails closed instead of reporting success", async (t) => {
  const recovery: string[] = [];
  const f = await fixture(t, {}, {
    onOperationStart: async () => "lease-finish-failure",
    onOperationFinished: async () => { throw new Error("SECRET_STORAGE_DIAGNOSTIC"); },
    onRecoveryRequired: async (provider) => { recovery.push(provider); },
  });
  await f.service.start("codex", f.options);
  await until(() => !f.service.operationActive);
  assert.equal(f.service.getLogin()?.state, "failed");
  assert.match(f.service.getLogin()!.message, /could not save cleanup confirmation/);
  assert.doesNotMatch(JSON.stringify(f.service.getLogin()), /SECRET/);
  assert.equal(f.service.recoveryRequired, true);
  assert.equal(f.service.busy, true);
  assert.deepEqual(recovery, ["codex"]);
  await assert.rejects(f.service.read("codex", f.options), /needs recovery/);
  f.service.acknowledgeRecovery();
  assert.equal(f.service.busy, false);
});

test("status lease cleanup persistence errors remain redacted and locked even if recovery saving fails", async (t) => {
  const f = await fixture(t, { signedIn: true }, {
    onOperationStart: async () => "lease-status-cleanup",
    onOperationFinished: async () => { throw new Error("SECRET_STORAGE_DIAGNOSTIC"); },
    onRecoveryRequired: async () => { throw new Error("SECRET_RECOVERY_DIAGNOSTIC"); },
  });
  await assert.rejects(f.service.read("claude", f.options), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /could not save cleanup confirmation/);
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  });
  assert.equal(f.service.operationActive, false);
  assert.equal(f.service.recoveryRequired, true);
  assert.equal(f.service.busy, true);
});
