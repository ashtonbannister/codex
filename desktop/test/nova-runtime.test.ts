import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/shared/types";
import {
  assertNovaCodexConfig,
  assertNovaCodexHome,
  assertNovaCodexRequirements,
  ensureNovaCodexHome,
  isolatedCodexEnv,
  novaCodexConfigArgs,
} from "../src/main/services/nova-runtime";
import { probeProvider, providerArguments, resolveExecutable, runProvider } from "../src/main/services/providers";
import { ProviderAuthService } from "../src/main/services/provider-auth";

// Synthetic local process only: no installed engines, provider/network calls,
// real credentials, OEM configuration or user history are accessed.
const cli = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const home = process.env.CODEX_HOME;
const args = process.argv.slice(2);
const configuration = {};
for(let i=0;i<args.length-1;i++) if(args[i]==='--config') {
 const split=args[i+1].indexOf('=');
 try { configuration[args[i+1].slice(0,split)]=JSON.parse(args[i+1].slice(split+1)); } catch {}
}
fs.appendFileSync(path.join(home,'calls.jsonl'),JSON.stringify({args,cwd:process.cwd(),configuration,
 home,sqlite:process.env.CODEX_SQLITE_HOME,thread:process.env.CODEX_THREAD_ID,
 testConfig:process.env.CODEX_APP_SERVER_TEST_USER_CONFIG_FILE,
 token:process.env.CODEX_ACCESS_TOKEN,openai:process.env.OPENAI_API_KEY})+'\n');
if(args.includes('--version')) {console.log('synthetic-codex 1.0');process.exit(0)}
if(args.includes('--help')) {console.log('--json --sandbox --ignore-user-config');process.exit(0)}
if(args.includes('--print-startup-config')) {
 const file=path.join(home,'fixture-requirements.json');
 const requirements=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
 console.log(JSON.stringify({appServerVersion:'synthetic-1',configRequirements:{requirements}}));process.exit(0);
}
if(args.includes('exec') || args.includes('--safe-mode')) {
 process.stdin.resume();
 process.stdin.on('end',()=>console.log(JSON.stringify(args.includes('--safe-mode')?{type:'result',subtype:'success',result:'Fixture answer'}:{type:'turn.completed'})));
} else {
 const input=readline.createInterface({input:process.stdin});
 input.on('line',line=>{
  const request=JSON.parse(line);
  if(request.method==='initialized')return;
  const result=request.method==='initialize'?{userAgent:'synthetic'}:
   request.method==='config/read'?{config:configuration,origins:{},layers:null}:
   request.method==='account/read'?{account:null,requiresOpenaiAuth:true}:{};
  console.log(JSON.stringify({id:request.id,result}));
 });
 input.on('close',()=>process.exit(0));
}
`;

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "nova-runtime-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "oem-source");
  const data = path.join(root, "nova-data");
  await mkdir(source);
  await writeFile(path.join(source, "config.toml"), 'original = "unchanged"\n');
  await writeFile(path.join(source, "auth.json"), '{"fixture":"not-a-credential"}\n');
  const before = await Promise.all((await readdir(source)).map(async (file) => [file, await readFile(path.join(source, file), "utf8")]));
  const home = await ensureNovaCodexHome(data, source);
  return { root, source, data, home, before };
}

test("private runtime rejects OEM overlap, unissued homes and redirected owned children", async (t) => {
  const f = await fixture(t);
  await assert.rejects(ensureNovaCodexHome(f.source, f.source), /private Codex runtime/);
  await assert.rejects(ensureNovaCodexHome(path.join(os.homedir(), ".codex", "nova")), /private Codex runtime/);
  assert.throws(() => isolatedCodexEnv(f.source), /private Codex runtime/);
  assert.equal(await assertNovaCodexHome(f.home), f.home);
  await rename(path.join(f.home, "state"), path.join(f.home, "state-original"));
  await symlink(f.source, path.join(f.home, "state"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(assertNovaCodexHome(f.home), /private Codex runtime/);
  await assert.rejects(ensureNovaCodexHome(f.data, f.source), /private Codex runtime/);
  const other = path.join(f.root, "redirected-data");
  await mkdir(other);
  await symlink(f.source, path.join(other, "codex-runtime"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(ensureNovaCodexHome(other, f.source), /private Codex runtime/);
  assert.deepEqual(await Promise.all((await readdir(f.source)).map(async (file) => [file, await readFile(path.join(f.source, file), "utf8")])), f.before);
});

test("environment and config overrides isolate storage, sessions and sign-in without disabling managed policy", async (t) => {
  const { home, source } = await fixture(t);
  const environment = isolatedCodexEnv(home, {
    CODEX_HOME: source, CODEX_SQLITE_HOME: source, SQLITE_HOME: source,
    CODEX_THREAD_ID: "OEM-thread", CODEX_SESSION_ID: "OEM-session",
    CODEX_APP_SERVER_TEST_USER_CONFIG_FILE: path.join(source, "config.toml"),
    CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1", CODEX_ACCESS_TOKEN: "fixture-token",
    OPENAI_API_KEY: "fixture-api-key", CODEX_CA_CERTIFICATE: "/enterprise/ca.pem",
  });
  assert.equal(environment.CODEX_HOME, home);
  assert.equal(environment.CODEX_SQLITE_HOME, path.join(home, "state"));
  assert.equal(environment.CODEX_CA_CERTIFICATE, "/enterprise/ca.pem");
  for (const name of ["SQLITE_HOME", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_APP_SERVER_TEST_USER_CONFIG_FILE", "CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"])
    assert.equal(environment[name], undefined);
  assert.ok(novaCodexConfigArgs(home).includes('cli_auth_credentials_store="file"'));
  const effective = { sqlite_home: path.join(home, "state"), log_dir: path.join(home, "log"), cli_auth_credentials_store: "file" };
  assert.doesNotThrow(() => assertNovaCodexConfig(home, effective));
  assert.throws(() => assertNovaCodexConfig(home, { ...effective, sqlite_home: source }), /did not confirm/);
  assert.throws(() => assertNovaCodexRequirements(home, { sqliteHome: source }), /Managed Codex policy/);
  assert.throws(() => assertNovaCodexRequirements(home, { logDir: source }), /Managed Codex policy/);
  assert.throws(() => assertNovaCodexRequirements(home, { cliAuthCredentialsStore: "keyring" }), /Managed Codex policy/);
  assert.doesNotThrow(() => assertNovaCodexRequirements(home, { sqliteHome: effective.sqlite_home, logDir: effective.log_dir, cliAuthCredentialsStore: "file" }));
});

test("metadata probes, explicit worker and account access only start in Nova storage; managed external storage fails closed", async (t) => {
  const f = await fixture(t);
  const script = path.join(f.root, "synthetic-codex.mjs");
  await writeFile(script, cli);
  const settings = { ...DEFAULT_SETTINGS, codexPath: script, codexHome: f.source };
  const status = await probeProvider("codex", settings, f.data);
  assert.equal(status.available, true, status.detail);
  const executable = await resolveExecutable(script);
  const command = { ...executable, env: { ...executable.env, CODEX_HOME: f.home, CODEX_SQLITE_HOME: f.source,
    CODEX_THREAD_ID: "OEM-thread", CODEX_ACCESS_TOKEN: "fixture-token", OPENAI_API_KEY: "fixture-api-key" },
    args: providerArguments("codex", f.data, "plan", "") };
  const result = await runProvider({ command, provider: "codex", cwd: f.data, prompt: "fixture", timeoutMs: 5_000,
    maxBytes: 64_000, signal: new AbortController().signal, onEvent() {} });
  assert.equal(result.completed, true, result.error);
  const claude = await runProvider({ command: { ...command, args: providerArguments("claude", f.data, "plan", "") },
    provider: "claude", cwd: f.data, prompt: "fixture", timeoutMs: 5_000,
    maxBytes: 64_000, signal: new AbortController().signal, onEvent() {} });
  assert.equal(claude.completed, true, claude.error);
  const service = new ProviderAuthService({ openExternal: async () => { throw new Error("no browser expected"); } });
  t.after(async () => { await service.shutdown(); });
  const account = await service.read("codex", { settings, home: f.home, cwd: f.source });
  assert.equal(account.state, "signed-out", account.message);
  const calls = async () => (await readFile(path.join(f.home, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const beforePolicy = await calls();
  assert.equal(beforePolicy.filter((call) => call.args.includes("app-server") && !call.args.includes("--print-startup-config")).length, 1);
  for (const call of beforePolicy) {
    assert.equal(call.home, f.home);
    assert.equal(call.sqlite, path.join(f.home, "state"));
    assert.notEqual(call.cwd, f.source);
    assert.equal(call.thread, undefined);
    assert.equal(call.token, undefined);
    assert.equal(call.openai, undefined);
    if (call.args.includes("app-server") || call.args.includes("exec")) {
      if (call.args.includes("--help")) continue;
      assert.equal(call.configuration.sqlite_home, path.join(f.home, "state"));
      assert.equal(call.configuration.log_dir, path.join(f.home, "log"));
      assert.equal(call.configuration.cli_auth_credentials_store, "file");
    }
  }
  await writeFile(path.join(f.home, "fixture-requirements.json"), JSON.stringify({ sqliteHome: f.source }));
  await assert.rejects(runProvider({ command, provider: "codex", cwd: f.data, prompt: "fixture", timeoutMs: 5_000,
    maxBytes: 64_000, signal: new AbortController().signal, onEvent() {} }), /Managed Codex policy/);
  const denied = await service.read("codex", { settings, home: f.home, cwd: f.source });
  assert.equal(denied.state, "unavailable");
  assert.match(denied.message!, /Managed Codex policy/);
  const afterPolicy = await calls();
  assert.ok(afterPolicy.slice(beforePolicy.length).every((call) => call.args.includes("--print-startup-config")));
  assert.deepEqual(await Promise.all((await readdir(f.source)).map(async (file) => [file, await readFile(path.join(f.source, file), "utf8")])), f.before);
});
