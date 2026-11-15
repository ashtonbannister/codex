import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizeThreadPermission, ThreadPermissionStore, type PermissionContext } from "../src/main/services/thread-permissions";
import { DesktopControlSession, windowsProcessStartTime } from "../src/main/services/desktop-control";

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-desktop-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let title = "Synthetic editor";
  let processName = "fixture-editor";
  let allowed = true;
  const calls: string[][] = [];
  const approvals: string[] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "status") return JSON.stringify({ hwnd: 1234, processId: 111, processName, windowTitle: title });
    if (args[0] === "list-windows") return JSON.stringify([{ hwnd: 1234 }]);
    if (args[0] === "inspect") return JSON.stringify({ windows: [{ elements: [{ selector: "btn-save-a1", name: "Save" }, { selector: "txt-body-b2", name: "Body" }] }] });
    if (args[0] === "screenshot") { await writeFile(args[args.indexOf("--output") + 1]!, Buffer.from([137,80,78,71,13,10,26,10,0])); return "{}"; }
    return JSON.stringify({ performed: true });
  };
  const session = new DesktopControlSession(runner, async (request) => { approvals.push(request.action); return allowed; }, root);
  const signal = new AbortController().signal;
  return { session, signal, calls, approvals, setAllowed: (v: boolean) => { allowed = v; }, setTitle: (v: string) => { title = v; }, setProcess: (v: string) => { processName = v; } };
}

test("desktop actions require selection, fresh observation, and separate approvals", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.session.execute({ action: "inspect" }, f.signal), /Select a window/);
  await f.session.execute({ action: "list" }, f.signal);
  await f.session.execute({ action: "select", hwnd: 1234 }, f.signal);
  const observed = JSON.parse((await f.session.execute({ action: "inspect" }, f.signal)).text);
  await assert.rejects(f.session.execute({ action: "invoke", selector: "btn-save-a1", observation: "stale", operation: "invoke" }, f.signal), /latest observation/);
  await f.session.execute({ action: "invoke", selector: "btn-save-a1", observation: observed.observation, operation: "invoke" }, f.signal);
  await assert.rejects(f.session.execute({ action: "set-value", selector: "txt-body-b2", observation: observed.observation, value: "hello" }, f.signal), /latest observation/);
  const image = await f.session.execute({ action: "screenshot" }, f.signal);
  assert.equal(image.image?.mimeType, "image/png");
  assert.deepEqual(f.approvals, ["List windows", "Select window", "inspect", "invoke", "screenshot"]);
  assert.equal(f.calls.filter((args) => args[0] === "invoke").length, 1);
});

test("desktop control denies protected windows, declined requests, and changed targets", async (t) => {
  const f = await setup(t);
  await f.session.execute({ action: "list" }, f.signal);
  f.setProcess("powershell");
  await assert.rejects(f.session.execute({ action: "select", hwnd: 1234 }, f.signal), /protected/);
  f.setProcess("fixture-editor");
  f.setAllowed(false);
  await assert.rejects(f.session.execute({ action: "select", hwnd: 1234 }, f.signal), /declined/);
  f.setAllowed(true);
  await f.session.execute({ action: "select", hwnd: 1234 }, f.signal);
  f.setTitle("Different window");
  await assert.rejects(f.session.execute({ action: "inspect" }, f.signal), /changed/);
  f.session.close();
  await assert.rejects(f.session.execute({ action: "list" }, f.signal), /closed/);
});


test("cancelling while approval is open prevents the action", async () => {
  let release!: (value: boolean) => void;
  let invocation = 0;
  const session = new DesktopControlSession(async (args) => {
    if (args[0] === "list-windows") return JSON.stringify([{ hwnd: 9 }]);
    if (args[0] === "status") return JSON.stringify({ hwnd: 9, processId: 2, processName: "fixture", windowTitle: "Fixture" });
    if (args[0] === "inspect") return JSON.stringify({ elements: [{ selector: "btn-go" }] });
    invocation++; return "{}";
  }, async (request) => request.action === "invoke" ? new Promise<boolean>((resolve) => { release = resolve; }) : true, os.tmpdir());
  const controller = new AbortController();
  await session.execute({ action: "list" }, controller.signal);
  await session.execute({ action: "select", hwnd: 9 }, controller.signal);
  const observed = JSON.parse((await session.execute({ action: "inspect" }, controller.signal)).text);
  const action = session.execute({ action: "invoke", observation: observed.observation, selector: "btn-go", operation: "invoke" }, controller.signal);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort(); release(true);
  await assert.rejects(action, /closed/);
  assert.equal(invocation, 0);
});


test("remembered desktop approvals stay bound to the chat and exact window", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-desktop-permission-")); t.after(() => rm(root, { recursive: true, force: true }));
  const encryption = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text, "utf8"), decryptString: (data: Buffer) => data.toString("utf8") }; const store = new ThreadPermissionStore(root, encryption); await store.load();
  let hwnd = 100; let prompts = 0; const context: PermissionContext = { threadId: "test-chat", provider: "codex", model: "fixture", mode: "plan", worker: "parent" };
  const session = new DesktopControlSession(async (args) => {
    if (args[0] === "list-windows") return JSON.stringify([{ hwnd }]);
    if (args[0] === "status") return JSON.stringify({ hwnd: Number(args[args.indexOf("-w") + 1]), processId: 55, processName: "fixture", windowTitle: "Fixture" });
    if (args[0] === "inspect") return JSON.stringify({ elements: [{ selector: "button" }] }); return "{}";
  }, (request) => authorizeThreadPermission(store, context, { kind: "desktop", action: request.action, target: request.target ?? null, detail: request.detail }, async () => { prompts++; return 2; }), root);
  const signal = new AbortController().signal; await session.execute({ action: "list" }, signal); await session.execute({ action: "select", hwnd }, signal); await session.execute({ action: "inspect" }, signal); assert.equal(prompts, 3);
  await session.execute({ action: "inspect" }, signal); assert.equal(prompts, 3);
  hwnd = 101; await session.execute({ action: "list" }, signal); await session.execute({ action: "select", hwnd }, signal); await session.execute({ action: "inspect" }, signal); assert.equal(prompts, 5);
  await store.clear(context.threadId); await session.execute({ action: "inspect" }, signal); assert.equal(prompts, 6); session.close();
});


test("Windows process start identity distinguishes process lifetimes", async () => {
  assert.equal(await windowsProcessStartTime(-1), undefined);
  if (process.platform === "win32") { const first = await windowsProcessStartTime(process.pid); assert.match(first ?? "", /^\d+$/); assert.equal(await windowsProcessStartTime(process.pid), first); }
});
