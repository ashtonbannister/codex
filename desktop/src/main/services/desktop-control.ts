import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const blockedProcesses = /^(?:cmd|powershell|pwsh|windowsterminal|openconsole|conhost|wt|regedit|taskmgr|mmc|credentialui|lockapp|logonui|consent|chatgpt|codex)$/i;
const blockedTitles = /(?:sign[ -]?in|log[ -]?in|password|credential|security|authentication|verification code|user account control|nova workbench)/i;

type Json = Record<string, unknown>;
type Runner = (args: string[], signal: AbortSignal) => Promise<string>;
export type DesktopApproval = (request: { action: string; target?: string; detail: string }) => Promise<boolean>;
export type DesktopRequest =
  | { action: "list" }
  | { action: "select"; hwnd: number }
  | { action: "inspect" }
  | { action: "screenshot" }
  | { action: "invoke"; observation: string; selector: string; operation: "invoke" | "select" | "toggle" | "toggle-on" | "toggle-off" | "expand" | "collapse" }
  | { action: "set-value" | "type"; observation: string; selector: string; value: string }
  | { action: "click"; observation: string; selector: string }
  | { action: "scroll"; observation: string; selector: string; direction: "up" | "down" | "left" | "right" }
  | { action: "key"; observation: string; selector: string; key: "enter" | "tab" | "escape" | "up" | "down" | "left" | "right" | "home" | "end" | "pageup" | "pagedown" | "backspace" | "delete" };
export type DesktopResult = { text: string; image?: { data: string; mimeType: "image/png" } };
type WindowIdentity = { hwnd: number; processId: number; processName: string; windowTitle: string };

function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid desktop control request.");
  return value as Json;
}
function safeText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value) || value.startsWith("-"))
    throw new Error(`Invalid ${label}.`);
  return value;
}
function identity(value: unknown, expected: number): WindowIdentity {
  const result = record(value);
  if (result.hwnd !== expected || !Number.isSafeInteger(result.processId) || Number(result.processId) <= 0 ||
      typeof result.processName !== "string" || typeof result.windowTitle !== "string") throw new Error("The target window could not be identified safely.");
  const processName = result.processName.replace(/\.exe$/i, "");
  if (!processName || processName.toLowerCase() === "unknown" || !result.windowTitle || blockedProcesses.test(processName) || blockedTitles.test(result.windowTitle)) throw new Error("Desktop control is not available for this protected window.");
  return { hwnd: expected, processId: Number(result.processId), processName, windowTitle: result.windowTitle };
}
function sameWindow(a: WindowIdentity, b: WindowIdentity): boolean {
  return a.hwnd === b.hwnd && a.processId === b.processId && a.processName === b.processName && a.windowTitle === b.windowTitle;
}
function selectors(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { for (const item of value) selectors(item, out); }
  else if (value && typeof value === "object") {
    const item = value as Json;
    if (typeof item.selector === "string" && item.selector.length <= 300) out.add(item.selector);
    for (const nested of Object.values(item)) if (nested && typeof nested === "object") selectors(nested, out);
  }
  return out;
}

async function ownedDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error("Desktop storage path is invalid.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (!info.isDirectory() || info.isSymbolicLink() || normalize(await realpath(directory)) !== normalize(directory))
    throw new Error("Desktop storage is unavailable or redirected.");
}

/** Run the pinned CLI directly, never a shell or model-supplied executable. */
export function windowsAutomationRunner(executable: string, cache: string): Runner {
  return async (args, signal) => {
    if (process.platform !== "win32" || !path.isAbsolute(executable)) throw new Error("Windows desktop control is unavailable.");
    await ownedDirectory(cache);
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "COMSPEC"]) {
      const match = Object.keys(process.env).find((name) => name.toUpperCase() === key.toUpperCase());
      if (match) environment[match] = process.env[match];
    }
    try {
      const result = await exec(executable, ["ui", ...args, "--json"], {
        windowsHide: true, timeout: 20_000, maxBuffer: MAX_OUTPUT, signal,
        env: { ...environment, WINAPP_CLI_TELEMETRY_OPTOUT: "1", WINAPP_CLI_UPDATE_CHECK: "0", WINAPP_CLI_CACHE_DIRECTORY: cache },
      });
      return result.stdout;
    } catch {
      throw new Error(signal.aborted ? "Desktop action was cancelled." : "Windows automation could not complete the requested action. Inspect the window again.");
    }
  };
}

/** Per-run window selection and fresh-observation discipline. No action is auto-approved. */
export class DesktopControlSession {
  private target?: WindowIdentity;
  private observation?: { id: string; selectors: Set<string> };
  private windows?: { handles: Set<number>; observedAt: number };
  private active = false;
  private closed = false;
  constructor(private readonly runner: Runner, private readonly approve: DesktopApproval, private readonly captures: string) {}
  close(): void { this.closed = true; this.target = undefined; this.observation = undefined; this.windows = undefined; }
  private async call(args: string[], signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const output = await this.runner(args, signal);
    if (Buffer.byteLength(output) > MAX_OUTPUT) throw new Error("Desktop output exceeded its limit.");
    try { return JSON.parse(output); } catch { throw new Error("Windows automation returned invalid JSON."); }
  }
  private async status(hwnd: number, signal: AbortSignal): Promise<WindowIdentity> {
    return identity(await this.call(["status", "-w", String(hwnd)], signal), hwnd);
  }
  private async confirm(action: string, target: WindowIdentity | undefined, detail: string, signal: AbortSignal): Promise<void> {
    if (this.closed || signal.aborted) throw new Error("Desktop control session is closed.");
    if (!(await this.approve({ action, target: target ? `${target.windowTitle} (${target.processName}, PID ${target.processId})` : undefined, detail })))
      throw new Error("Desktop action was declined.");
    if (this.closed || signal.aborted) throw new Error("Desktop control session is closed.");
  }
  async execute(value: unknown, signal: AbortSignal): Promise<DesktopResult> {
    if (this.active || this.closed) throw new Error("Desktop control is busy or closed.");
    this.active = true;
    try {
      const input = record(value);
      const action = input.action;
      if (action === "list") {
        await this.confirm("List windows", undefined, "Share the names and identifiers of visible windows with the selected agent.", signal);
        const result = await this.call(["list-windows"], signal);
        if (!Array.isArray(result) || result.length > 2000) throw new Error("Windows automation returned an invalid window list.");
        const handles = new Set<number>();
        for (const item of result) {
          const value = record(item);
          if (Number.isSafeInteger(value.hwnd) && Number(value.hwnd) > 0) handles.add(Number(value.hwnd));
        }
        this.windows = { handles, observedAt: Date.now() };
        return { text: JSON.stringify(result) };
      }
      if (action === "select") {
        const hwnd = input.hwnd;
        if (!Number.isSafeInteger(hwnd) || Number(hwnd) <= 0 || !this.windows?.handles.has(Number(hwnd)) || Date.now() - this.windows.observedAt > 60_000) throw new Error("Choose a window handle from a recent window list.");
        const before = await this.status(Number(hwnd), signal);
        await this.confirm("Select window", before, "Allow this run to request observations and actions in this window. Each request requires approval.", signal);
        const after = await this.status(Number(hwnd), signal);
        if (!sameWindow(before, after)) throw new Error("The selected window changed; select it again.");
        this.target = after;
        this.observation = undefined;
        return { text: JSON.stringify({ selected: after }) };
      }
      const target = this.target;
      if (!target) throw new Error("Select a window before requesting desktop control.");
      if (!sameWindow(target, await this.status(target.hwnd, signal))) throw new Error("The selected window changed; select it again.");
      const selector = ["invoke", "set-value", "click", "scroll", "type", "key"].includes(String(action)) ? safeText(input.selector, "element selector", 300) : undefined;
      if (selector && (input.observation !== this.observation?.id || !this.observation?.selectors.has(selector)))
        throw new Error("Inspect the window again and use a selector from the latest observation.");
      let args: string[];
      let detail: string;
      if (action === "inspect") { args = ["inspect", "-w", String(target.hwnd), "--depth", "16"]; detail = "Read this window's accessible interface and share it with the selected agent."; }
      else if (action === "screenshot") { args = []; detail = "Capture this window and its owned dialogs and share the image with the selected agent."; }
      else if (action === "invoke") {
        if (!["invoke", "select", "toggle", "toggle-on", "toggle-off", "expand", "collapse"].includes(String(input.operation))) throw new Error("Invalid element action.");
        args = ["invoke", selector!, "-w", String(target.hwnd), "--action", String(input.operation)];
        detail = `${input.operation} element: ${selector}`;
      } else if (action === "set-value" || action === "type") {
        if (typeof input.value !== "string" || !input.value || input.value.length > 2000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(input.value) || input.value.startsWith("-")) throw new Error("Invalid element value.");
        const value = input.value;
        args = action === "set-value" ? ["set-value", selector!, value, "-w", String(target.hwnd)] : ["send-keys", value, "-w", String(target.hwnd), "--target", selector!, "--via", "send-input", "--verbatim"];
        detail = `${action === "type" ? "Type into" : "Set"} ${selector}:\n${value}`;
      } else if (action === "click") {
        args = ["click", selector!, "-w", String(target.hwnd)];
        detail = `Click element: ${selector}`;
      } else if (action === "scroll") {
        if (!["up", "down", "left", "right"].includes(String(input.direction))) throw new Error("Invalid scroll direction.");
        args = ["scroll", selector!, "-w", String(target.hwnd), "--direction", String(input.direction)];
        detail = `Scroll ${selector} ${input.direction}`;
      } else if (action === "key") {
        if (!["enter", "tab", "escape", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "backspace", "delete"].includes(String(input.key))) throw new Error("Unsupported key.");
        args = ["send-keys", String(input.key), "-w", String(target.hwnd), "--target", selector!, "--via", "send-input"];
        detail = `Press ${input.key} on ${selector}`;
      } else throw new Error("Unsupported desktop action.");
      await this.confirm(String(action), target, detail, signal);
      if (!sameWindow(target, await this.status(target.hwnd, signal))) throw new Error("The selected window changed before the action.");
      if (action === "screenshot") {
        await ownedDirectory(this.captures);
        const file = path.join(this.captures, `${randomUUID()}.png`);
        try {
          await this.call(["screenshot", "-w", String(target.hwnd), "--output", file], signal);
          const info = await lstat(file);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > MAX_IMAGE || path.dirname(await realpath(file)).toLowerCase() !== (await realpath(this.captures)).toLowerCase())
            throw new Error("The captured image was redirected or exceeds its size limit.");
          const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          let data: Buffer;
          try {
            const opened = await handle.stat();
            if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error("The captured image changed before it was read.");
            data = await handle.readFile();
            const after = await handle.stat();
            if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || data.length !== info.size) throw new Error("The captured image changed while it was read.");
          } finally { await handle.close(); }
          if (!data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("Desktop capture was not a PNG image.");
          return { text: "Window screenshot captured.", image: { data: data.toString("base64"), mimeType: "image/png" } };
        } finally { await rm(file, { force: true }); }
      }
      if (action !== "inspect") this.observation = undefined;
      const result = await this.call(args, signal);
      if (action === "inspect") {
        const id = randomUUID();
        this.observation = { id, selectors: selectors(result) };
        return { text: JSON.stringify({ observation: id, result }) };
      }
      return { text: JSON.stringify(result) };
    } finally { this.active = false; }
  }
}
