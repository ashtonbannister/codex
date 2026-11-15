import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopControlSession, windowsAutomationRunner } from "../src/main/services/desktop-control";

// Explicitly invoked Windows acceptance check. All actions target an app created here.
test("native Windows control observes and invokes a disposable Electron window", { skip: process.platform !== "win32" || process.env.NOVA_DESKTOP_NATIVE_TEST !== "1", timeout: 60000 }, async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "nova-desktop-native-"));
  const electron = path.resolve("node_modules/electron/dist/electron.exe");
  const winapp = path.resolve("node_modules/@microsoft/winappcli/bin/win-x64/winapp.exe");
  const child = spawn(electron, [path.resolve("test/desktop-window-fixture.cjs")], { env: { ...process.env, NOVA_DESKTOP_FIXTURE_DATA: temp }, stdio: "ignore", windowsHide: false });
  t.after(async () => { if (child.exitCode === null) child.kill(); await rm(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); });
  const raw = windowsAutomationRunner(winapp, path.join(temp, "cache"));
  const runner = (args: string[], signal: AbortSignal) => raw(args[0] === "list-windows" ? [...args, "-a", String(child.pid)] : args, signal);
  const session = new DesktopControlSession(runner, async () => true, path.join(temp, "captures"));
  const signal = new AbortController().signal;
  let hwnd = 0;
  for (let attempt = 0; attempt < 20 && !hwnd; attempt++) {
    const list = JSON.parse((await session.execute({ action: "list" }, signal)).text) as Array<{ hwnd: number; title: string; processId: number }>;
    hwnd = list.find((item) => item.title === "Nova Desktop Synthetic Fixture" && item.processId === child.pid)?.hwnd ?? 0;
    if (!hwnd) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.ok(hwnd, "Fixture window not found");
  await session.execute({ action: "select", hwnd }, signal);
  const observed = JSON.parse((await session.execute({ action: "inspect" }, signal)).text);
  const find = (value: any): string | undefined => {
    if (!value || typeof value !== "object") return undefined;
    if (value.name === "Test button" && typeof value.selector === "string") return value.selector;
    for (const nested of Object.values(value)) { const found = find(nested); if (found) return found; }
    return undefined;
  };
  const selector = find(observed.result);
  assert.ok(selector, `Fixture button not found in UI Automation tree: ${JSON.stringify(observed.result).slice(0, 3000)}`);
  const image = await session.execute({ action: "screenshot" }, signal);
  assert.equal(image.image?.mimeType, "image/png");
  const findInput = (value: any): string | undefined => {
    if (!value || typeof value !== "object") return undefined;
    if (value.name === "Fixture note" && typeof value.selector === "string") return value.selector;
    for (const nested of Object.values(value)) { const found = findInput(nested); if (found) return found; }
    return undefined;
  };
  const input = findInput(observed.result);
  assert.ok(input, "Fixture text field not found");
  await session.execute({ action: "set-value", observation: observed.observation, selector: input, value: "Synthetic note" }, signal);
  const edited = JSON.parse((await session.execute({ action: "inspect" }, signal)).text);
  assert.match(JSON.stringify(edited.result), /Synthetic note/);
  await session.execute({ action: "type", observation: edited.observation, selector: input, value: " typed" }, signal);
  const typed = JSON.parse((await session.execute({ action: "inspect" }, signal)).text);
  assert.match(JSON.stringify(typed.result), /typed/);
  await session.execute({ action: "key", observation: typed.observation, selector: input, key: "backspace" }, signal);
  const keyed = JSON.parse((await session.execute({ action: "inspect" }, signal)).text);
  assert.match(JSON.stringify(keyed.result), /type/);
  await session.execute({ action: "click", observation: keyed.observation, selector }, signal);
  const after = await session.execute({ action: "inspect" }, signal);
  assert.match(after.text, /Clicked/);
  session.close();
});
