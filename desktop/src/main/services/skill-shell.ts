import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { disconnectChild, resolveExecutable, terminateTree, trackOwnedProcess } from "./providers";
import { McpProcessError } from "./mcp-stdio";
import type { PluginApproval } from "./plugin-mcp";
import { renderPluginCommand } from "./plugin-commands";
import { renderExplicitSkill, type SelectedSkill } from "./skill-selection";

/** Execute only the original skill's placeholders, after reviewing their fully expanded commands. */
export async function renderSkillWithShell(selected: SelectedSkill, project: string, provider: "codex" | "claude" | "ollama", approve: PluginApproval, signal: AbortSignal, verify: () => Promise<void>): Promise<Awaited<ReturnType<typeof renderExplicitSkill>>> {
  if (!selected.descriptor.requiresShell) return renderExplicitSkill(selected, project, provider);
  if (!selected.verifiedContent || !selected.reference) throw new Error("The selected skill was not verified.");
  const commands: Array<{ marker: string; script: string }> = [];
  const pattern = /(^|[ \t\r\n])!`([^`\r\n]+)`|^```![ \t]*\r?\n([\s\S]*?)^```[ \t]*(?=\r?$)/gm;
  const sourceBody = selected.verifiedContent.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const header = selected.verifiedContent.slice(0, selected.verifiedContent.length - sourceBody.length);
  const raw = header + sourceBody.replace(pattern, (_whole, prefix: string | undefined, inline: string | undefined, block: string | undefined) => {
    const script = inline ?? block ?? ""; if (!script.trim() || script.length > 8192 || commands.length >= 12) throw new Error("Skill shell commands exceed the supported limits.");
    const marker = `NOVA_SKILL_SHELL_${randomUUID().replace(/-/g, "")}_END`; commands.push({ marker, script }); return `${prefix ?? ""}${marker}`;
  });
  if (!commands.length) throw new Error("Skill shell commands could not be parsed.");
  const rendered = await renderExplicitSkill({ ...selected, verifiedContent: raw }, project, provider);
  const location = { root: selected.root, data: selected.data, project, skillDir: path.dirname(selected.path), config: selected.config, appendUnused: false };
  for (const command of commands) command.script = renderPluginCommand({ name: selected.name, description: "", unsupported: [], warnings: [], namedArguments: selected.descriptor.namedArguments, body: command.script }, selected.reference.args, location);
  const shellName = selected.descriptor.shell ?? (process.platform === "win32" ? "powershell" : "bash");
  const executable = await resolveExecutable(shellName, process.platform, process.env.PATH ?? "");
  const shellInfo = await lstat(executable.command); const directoryInfo = await lstat(project);
  if (!shellInfo.isFile() || shellInfo.isSymbolicLink() || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("The skill shell or working directory is unavailable.");
  const detail = JSON.stringify({ skill: selected.name, source: selected.package, shell: executable.command, workingDirectory: project, commands: commands.map((item) => item.script), note: "These commands run under your user account, outside the agent sandbox, and can change files or access the network. Output is separately reviewed before sharing with the provider." }, null, 2).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (detail.length > 32000) throw new Error("Skill commands are too large to review.");
  signal.throwIfAborted(); if (!await approve({ action: "skill-shell", title: "Run these skill commands?", detail })) throw new Error("Skill command execution was declined.");
  for (const command of commands) {
    signal.throwIfAborted(); await verify();
    const now = await lstat(executable.command), cwd = await lstat(project);
    if (!now.isFile() || now.isSymbolicLink() || now.dev !== shellInfo.dev || now.ino !== shellInfo.ino || now.size !== shellInfo.size || now.mtimeMs !== shellInfo.mtimeMs || !cwd.isDirectory() || cwd.isSymbolicLink() || cwd.dev !== directoryInfo.dev || cwd.ino !== directoryInfo.ino) throw new Error("The reviewed shell or working directory changed.");
    const output = await capture(executable.command, executable.prefix, shellName, command.script, project, selected, signal);
    if (!rendered.content.includes(command.marker)) throw new Error("Skill command placeholder changed.");
    rendered.content = rendered.content.replace(command.marker, () => output);
  }
  await verify(); return rendered;
}
async function capture(executable: string, prefix: string[], shell: "bash" | "powershell", script: string, cwd: string, selected: SelectedSkill, signal: AbortSignal): Promise<string> {
  const names = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "LANG"];
  const env: NodeJS.ProcessEnv = Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  Object.assign(env, { CLAUDE_PLUGIN_ROOT: selected.root, CLAUDE_PLUGIN_DATA: selected.data, CLAUDE_PROJECT_DIR: cwd, CLAUDE_SKILL_DIR: path.dirname(selected.path) });
  const args = shell === "powershell" ? ["-NoProfile", "-NonInteractive", "-Command", script] : ["--noprofile", "--norc", "-c", script];
  return new Promise((resolve, reject) => {
    const started = Date.now(); const child = spawn(executable, [...prefix, ...args], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }); trackOwnedProcess(child, started);
    const chunks: Buffer[] = []; let size = 0, failure = "", finishing = false; let termination: Promise<boolean> | undefined; let drain: NodeJS.Timeout | undefined;
    const finish = async (code: number | null, unconfirmed = false) => {
      if (finishing) return; finishing = true; clearTimeout(timeout); clearTimeout(drain); signal.removeEventListener("abort", abort);
      const complete = await (termination ?? terminateTree(child)); if (unconfirmed || !complete) { disconnectChild(child); reject(new McpProcessError("Skill command termination could not be confirmed.", true)); return; }
      if (failure || code !== 0) { reject(new Error(failure || "Skill command failed; its output was not shared.")); return; }
      try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { reject(new Error("Skill command returned invalid UTF-8 output.")); }
    };
    const stop = (message: string) => { if (!failure) failure = message; if (termination) return; termination = terminateTree(child); void termination.then(() => { if (!finishing) drain = setTimeout(() => { disconnectChild(child); void finish(child.exitCode, true); }, 1500); }); };
    const timeout = setTimeout(() => stop("Skill command timed out."), 120000); const abort = () => stop("Skill command was cancelled."); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const data = (part: Buffer) => { size += part.length; if (size > 24000) stop("Skill command output is too large to review."); else chunks.push(part); };
    child.stdout.on("data", data); child.stderr.on("data", data); child.once("error", () => stop("Skill command could not start.")); child.once("close", (code) => { void finish(code); });
  });
}
