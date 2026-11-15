import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { disconnectChild, resolveExecutable, terminateTree, trackOwnedProcess } from "./providers";
import { McpProcessError } from "./mcp-stdio";
import { verifiedPermissionFileDigest } from "./verified-permission-file";
import { stablePermissionText } from "./thread-permissions";
import { renderPluginCommand } from "./plugin-commands";
import type { PluginApproval } from "./plugin-mcp";
import type { SelectedSkill } from "./skill-selection";

interface Plan { packageId?: string; packageFingerprint?: string; source: string; skill: string; server: string; tool: string; command: string; timeoutMs: number; shell: "bash" | "powershell"; root: string; data: string; skillDir: string }
export function prepareSkillMcpHooks(skills: SelectedSkill[], project: string): Plan[] {
  const plans: Plan[] = [];
  for (const skill of skills) for (const hook of skill.descriptor.mcpHooks ?? []) {
    if (!skill.reference || !skill.verifiedContent) throw new Error("The hook skill was not verified.");
    const command = renderPluginCommand({ name: skill.name, description: "", unsupported: [], warnings: [], namedArguments: skill.descriptor.namedArguments, body: hook.command }, skill.reference.args, { root: skill.root, data: skill.data, project, skillDir: path.dirname(skill.path), config: skill.config, appendUnused: false });
    plans.push({ packageId: skill.packageId, packageFingerprint: skill.packageFingerprint, source: skill.source, skill: skill.name, server: hook.server, tool: hook.tool, command, timeoutMs: hook.timeoutMs, shell: skill.descriptor.shell ?? (process.platform === "win32" ? "powershell" : "bash"), root: skill.root, data: skill.data, skillDir: path.dirname(skill.path) });
    if (plans.length > 24) throw new Error("Too many active skill hooks.");
  }
  return plans;
}
export function skillMcpHookRunner(plans: Plan[], project: string, session: string, approve: PluginApproval, verify: () => Promise<void>, abortRun: () => void) {
  let unsafe = false; const pending = new Set<Promise<void>>();
  const execute = async (call: { server: string; tool: string; alias: string; args: unknown }, signal: AbortSignal) => {
      for (const plan of plans) {
        const matchServer = plan.server === call.server || plan.server === "nova_plugins";
        const tool = plan.server === "nova_plugins" ? call.alias : call.tool;
        if (!matchServer || (plan.tool !== ".*" && plan.tool !== tool)) continue;
        signal.throwIfAborted(); await verify();
        const executable = await resolveExecutable(plan.shell, process.platform, process.env.PATH ?? ""); const shellInfo = await lstat(executable.command), cwdInfo = await lstat(project);
        if (!shellInfo.isFile() || shellInfo.isSymbolicLink() || !cwdInfo.isDirectory() || cwdInfo.isSymbolicLink()) throw new Error("The hook shell or working directory is unavailable.");
        const shellDigest = await verifiedPermissionFileDigest({ path: executable.command, dev: shellInfo.dev, ino: shellInfo.ino, size: shellInfo.size, mtimeMs: shellInfo.mtimeMs }).catch(() => undefined);
        const environmentNames = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "LANG"];
        const hostEnvironment: NodeJS.ProcessEnv = Object.fromEntries(environmentNames.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
        const input = { session_id: session, cwd: project, hook_event_name: "PreToolUse", tool_name: `mcp__${call.server}__${call.tool}`, tool_input: call.args ?? {}, tool_use_id: randomUUID() };
        const serialized = JSON.stringify(input); const detail = JSON.stringify({ skill: plan.skill, shell: executable.command, command: plan.command, workingDirectory: project, input, note: "This command runs under your user account and may change files or access the network. It receives the exact tool input shown here. The hook cannot bypass Nova's tool-call approval." }, null, 2).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
        if (detail.length > 32000 || serialized.length > 24000) throw new Error("The hook input is too large to review.");
        if (!await approve({ action: "skill-hook", title: "Run this skill hook?", detail, ...(plan.packageId && plan.packageFingerprint && shellDigest ? { scope: { kind: "skill-hook", source: plan.source, packageId: plan.packageId, fingerprint: plan.packageFingerprint, shell: executable.command, shellDigest, project, data: stablePermissionText(plan.data, { package: plan.root }), hostEnvironment, command: stablePermissionText(plan.command, { package: plan.root }), server: call.server, tool: call.tool, arguments: call.args ?? {} } } : {}) })) throw new Error("Skill hook execution was declined.");
        signal.throwIfAborted(); await verify(); const now = await lstat(executable.command), cwd = await lstat(project);
        if (!now.isFile() || now.isSymbolicLink() || now.dev !== shellInfo.dev || now.ino !== shellInfo.ino || now.size !== shellInfo.size || now.mtimeMs !== shellInfo.mtimeMs || !cwd.isDirectory() || cwd.isSymbolicLink() || cwd.dev !== cwdInfo.dev || cwd.ino !== cwdInfo.ino) throw new Error("The reviewed hook shell or working directory changed.");
        const result = await runHook(executable.command, executable.prefix, plan, project, serialized, hostEnvironment, signal);
        if (result.unconfirmed) { unsafe = true; abortRun(); throw new McpProcessError("Skill hook termination could not be confirmed.", true); }
        if (result.cancelled) throw new Error("Skill hook was cancelled.");
        if (result.code === 2) throw new Error("Skill hook blocked this tool call.");
        if (result.code !== 0) throw new Error("Skill hook failed; the tool call was blocked.");
        if (result.stdout.trim()) {
          let value: unknown; try { value = JSON.parse(result.stdout); } catch { throw new Error("Unsupported skill hook output; the tool call was blocked."); }
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid skill hook output; the tool call was blocked.");
          const output = value as Record<string, unknown>;
          if (Object.keys(output).some((key) => !["hookSpecificOutput", "suppressOutput"].includes(key)) || (output.suppressOutput !== undefined && typeof output.suppressOutput !== "boolean")) throw new Error("Unsupported skill hook output; the tool call was blocked.");
          if (output.hookSpecificOutput !== undefined) {
            const specific = output.hookSpecificOutput;
            if (!specific || typeof specific !== "object" || Array.isArray(specific)) throw new Error("Invalid skill hook output; the tool call was blocked.");
            const data = specific as Record<string, unknown>;
            if (Object.keys(data).some((key) => !["hookEventName", "permissionDecision", "permissionDecisionReason"].includes(key)) || data.hookEventName !== "PreToolUse" || (data.permissionDecision !== undefined && (typeof data.permissionDecision !== "string" || !["allow", "ask", "deny"].includes(data.permissionDecision))) || (data.permissionDecisionReason !== undefined && typeof data.permissionDecisionReason !== "string")) throw new Error("Unsupported skill hook decision; the tool call was blocked.");
            if (data.permissionDecision === "deny") throw new Error("Skill hook blocked this tool call.");
            if (data.permissionDecision === "ask") {
              const askDetail = JSON.stringify({ skill: plan.skill, tool: input.tool_name, input: input.tool_input, reason: data.permissionDecisionReason ?? "The hook requests another confirmation." }, null, 2).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
              if (askDetail.length > 32000) throw new Error("Hook-requested confirmation is too large to review.");
              if (!await approve({ action: "call", title: "Confirm tool call requested by hook?", detail: askDetail })) throw new Error("Hook-requested tool confirmation was declined.");
              signal.throwIfAborted();
            }
          }
        }
        await verify();
      }
  };
  return {
    async beforeCall(call: { server: string; tool: string; alias: string; args: unknown }, signal: AbortSignal) {
      const task = execute(call, signal); pending.add(task); try { await task; } finally { pending.delete(task); }
    },
    async settle() {
      if (pending.size) {
        let timer: NodeJS.Timeout | undefined;
        const done = await Promise.race([Promise.allSettled([...pending]).then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5000); })]);
        clearTimeout(timer); if (!done) { unsafe = true; abortRun(); }
      }
      if (unsafe) throw new McpProcessError("A skill hook process could not be confirmed stopped. Inspect it before continuing.", true);
    },
  };
}
async function runHook(executable: string, prefix: string[], plan: Plan, cwd: string, input: string, hostEnvironment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ code: number | null; stdout: string; cancelled: boolean; unconfirmed: boolean }> {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = { ...hostEnvironment };
  Object.assign(env, { CLAUDE_PLUGIN_ROOT: plan.root, CLAUDE_PLUGIN_DATA: plan.data, CLAUDE_PROJECT_DIR: cwd, CLAUDE_SKILL_DIR: plan.skillDir });
  const powershellCommand = `${plan.command}\n$__novaSucceeded = $?; $__novaExit = $LASTEXITCODE; if (-not $__novaSucceeded) { if ($null -ne $__novaExit -and $__novaExit -ne 0) { exit $__novaExit }; exit 1 }`;
  const args = plan.shell === "powershell" ? ["-NoProfile", "-NonInteractive", "-Command", powershellCommand] : ["--noprofile", "--norc", "-c", plan.command];
  return new Promise((resolve) => {
    const started = Date.now(); const child = spawn(executable, [...prefix, ...args], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] }); trackOwnedProcess(child, started);
    const stdout: Buffer[] = []; let size = 0, failed = false, finished = false; let termination: Promise<boolean> | undefined, drain: NodeJS.Timeout | undefined;
    const finish = async (code: number | null, unconfirmed = false) => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(drain); signal.removeEventListener("abort", abort);
      const complete = await (termination ?? terminateTree(child)); if (!complete || unconfirmed) disconnectChild(child);
      let text = ""; try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)); } catch { failed = true; }
      resolve({ code: failed ? -1 : code, stdout: text, cancelled: signal.aborted, unconfirmed: unconfirmed || !complete });
    };
    const stop = () => { if (termination) return; termination = terminateTree(child); void termination.then(() => { if (!finished) drain = setTimeout(() => { disconnectChild(child); void finish(child.exitCode, true); }, 1500); }); };
    const abort = () => stop(); const timer = setTimeout(() => { failed = true; stop(); }, plan.timeoutMs); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    child.stdout.on("data", (part: Buffer) => { size += part.length; if (size > 16000) { failed = true; stop(); } else stdout.push(part); });
    child.stderr.on("data", (part: Buffer) => { size += part.length; if (size > 16000) { failed = true; stop(); } });
    child.stdin.on("error", () => { failed = true; }); child.once("error", () => { failed = true; stop(); }); child.once("close", (code) => { void finish(code); }); child.stdin.end(input);
  });
}
