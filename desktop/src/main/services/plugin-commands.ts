import path from "node:path";
import { JSON_SCHEMA, load } from "js-yaml";
import type { PluginCommand, PluginPackage } from "../../shared/plugins";
import type { PackageSnapshot } from "./skill-packages";
import { parseNamedArguments } from "./skill-arguments";
import { instructionSettings, type BundleDefinition, type BundleValue } from "./bundle-config";

export interface CommandDefinition extends PluginCommand { body: string }
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plugin command definition."); return value as Record<string, unknown>; };
function relative(value: string): string {
  const result = value.replace(/^\.\//, "").replace(/\/$/, "");
  if (!result || result.length > 1024 || /[\\:\0\r\n]/.test(result) || result.startsWith("/") || result.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Plugin command paths must stay inside the selected folder.");
  return result;
}
function read(snapshot: PackageSnapshot, filename: string): string {
  const files = snapshot.files.filter((file) => file.path.toLowerCase() === filename.toLowerCase());
  if (files.length !== 1 || files[0]!.data.length > 64 * 1024) throw new Error("A plugin command file is missing, ambiguous or too large.");
  let result: string; try { result = new TextDecoder("utf-8", { fatal: true }).decode(files[0]!.data); } catch { throw new Error("Plugin command files must be UTF-8."); }
  if (result.includes("\0")) throw new Error("Plugin command files must be text."); return result;
}
function decode(name: string, text: string, file: string | undefined, overrides: Record<string, unknown> = {}): CommandDefinition {
  if (!namePattern.test(name)) throw new Error("A plugin command has an unsupported name.");
  let body = text; let metadata: Record<string, unknown> = {}; const unsupported: string[] = [], warnings: string[] = [];
  if (/^---\r?\n/.test(text)) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) unsupported.push("Command frontmatter is incomplete.");
    else {
      try { const parsed = load(match[1]!, { schema: JSON_SCHEMA }); metadata = parsed == null ? {} : object(parsed); body = text.slice(match[0].length); }
      catch { unsupported.push("Command frontmatter could not be parsed."); }
    }
  }
  const known = new Set(["description", "argument-hint", "disable-model-invocation", "user-invocable", "allowed-tools", "arguments"]);
  if (Object.keys(metadata).some((key) => !known.has(key))) unsupported.push("This command uses unsupported frontmatter settings.");
  const flag = (value: unknown): boolean | undefined => {
    if (typeof value === "boolean") return value;
    if (value === 1 || (typeof value === "string" && /^(?:true|yes|on|1)$/i.test(value))) return true;
    if (value === 0 || (typeof value === "string" && /^(?:false|no|off|0)$/i.test(value))) return false;
    return undefined;
  };
  if (metadata["user-invocable"] !== undefined && flag(metadata["user-invocable"]) === false) unsupported.push("This command is not user-invocable.");
  if (metadata["user-invocable"] !== undefined && flag(metadata["user-invocable"]) === undefined) unsupported.push("Invalid command invocation setting.");
  if (metadata["disable-model-invocation"] !== undefined && flag(metadata["disable-model-invocation"]) === undefined) unsupported.push("Invalid command invocation setting.");
  if (metadata["allowed-tools"] !== undefined || overrides.allowedTools !== undefined) warnings.push("Requested tool preapprovals are not granted; Nova's normal permissions still apply.");
  if (Object.keys(overrides).some((key) => !["description", "argumentHint", "allowedTools"].includes(key))) unsupported.push("This command declares unsupported options.");
  let namedArguments: string[] | undefined;
  try { namedArguments = parseNamedArguments(metadata.arguments); } catch { unsupported.push("Invalid named command arguments."); }
  if (/!`/.test(body)) unsupported.push("Automatic shell interpolation in commands is not supported.");
  if (/\$\{(?:CLAUDE_SESSION_ID|CLAUDE_SKILL_DIR)/.test(body)) unsupported.push("This command uses unsupported context variables.");
  const description = overrides.description ?? metadata.description ?? ""; const argumentHint = overrides.argumentHint ?? metadata["argument-hint"];
  if (typeof description !== "string" || description.length > 800 || /\0/.test(description) || (argumentHint !== undefined && (typeof argumentHint !== "string" || argumentHint.length > 300 || /\0/.test(argumentHint)))) throw new Error("Invalid plugin command metadata.");
  if (!body.trim() || body.length > 48_000) unsupported.push("Command instructions are empty or too large to review.");
  return { ...(namedArguments ? { namedArguments } : {}), name, description: description.replace(/\s+/g, " ").trim(), ...(file ? { path: file } : {}), ...(typeof argumentHint === "string" ? { argumentHint: argumentHint.replace(/\s+/g, " ").trim() } : {}), unsupported, warnings, body };
}
export function parsePluginCommands(snapshot: PackageSnapshot, declaration: unknown): CommandDefinition[] {
  const result: CommandDefinition[] = []; const names = new Set<string>();
  const add = (command: CommandDefinition) => { const key = command.name.toLowerCase(); if (names.has(key)) throw new Error("Plugin command names must be unique."); names.add(key); result.push(command); if (result.length > 100) throw new Error("A plugin has too many commands."); };
  const addPath = (input: string) => {
    const item = relative(input); const file = snapshot.files.find((entry) => entry.path.toLowerCase() === item.toLowerCase());
    if (file) { if (!/\.md$/i.test(file.path)) throw new Error("Plugin command files must be Markdown."); add(decode(path.posix.basename(file.path).replace(/\.md$/i, ""), read(snapshot, file.path), file.path)); return; }
    const prefix = `${item.toLowerCase()}/`; const files = snapshot.files.filter((entry) => entry.path.toLowerCase().startsWith(prefix) && !entry.path.slice(prefix.length).includes("/") && /\.md$/i.test(entry.path));
    if (!files.length && declaration !== undefined) throw new Error("A declared plugin command path is missing.");
    for (const command of files) add(decode(path.posix.basename(command.path).replace(/\.md$/i, ""), read(snapshot, command.path), command.path));
  };
  if (declaration === undefined) addPath("commands");
  else if (typeof declaration === "string" || Array.isArray(declaration)) {
    const entries = Array.isArray(declaration) ? declaration : [declaration]; if (entries.length > 100 || entries.some((item) => typeof item !== "string")) throw new Error("Invalid plugin command paths.");
    for (const entry of entries) addPath(entry as string);
  } else {
    for (const [name, raw] of Object.entries(object(declaration))) {
      const config = object(raw); const hasSource = typeof config.source === "string", hasContent = typeof config.content === "string";
      if ((Object.hasOwn(config, "source") && !hasSource) || (Object.hasOwn(config, "content") && !hasContent) || hasSource === hasContent) throw new Error("A plugin command must specify exactly one source or inline content.");
      const file = hasSource ? relative(config.source as string) : undefined;
      if (file && !/\.md$/i.test(file)) throw new Error("Plugin command files must be Markdown.");
      const text = file ? read(snapshot, file) : config.content as string;
      if (text.length > 64 * 1024 || text.includes("\0")) throw new Error("A plugin command is too large or invalid.");
      const { source: _source, content: _content, ...overrides } = config; add(decode(name, text, file, overrides));
    }
  }
  return result;
}
export function commandSummaries(commands: CommandDefinition[]): PluginCommand[] { return commands.map(({ body: _body, ...summary }) => summary); }

function splitArguments(input: string): string[] {
  const items: string[] = []; let current = "", quote = "", started = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote) { if (char === quote) quote = ""; else if (char === "\\" && input[index + 1] === quote) current += input[++index]; else current += char; started = true; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { items.push(current); current = ""; started = false; } }
    else { current += char; started = true; }
  }
  if (quote) throw new Error("The plugin command has an unterminated quoted argument.");
  if (started) items.push(current); return items;
}
export function renderPluginCommand(command: CommandDefinition, input: string, locations: { root: string; data: string; project: string; skillDir?: string; config?: Record<string, string> }): string {
  if (command.unsupported.length) throw new Error(`This plugin command is unavailable: ${command.unsupported.join(" ")}`);
  const args = splitArguments(input); let replaced = false;
  const roots: Record<string, string> = { CLAUDE_PLUGIN_ROOT: locations.root, CODEX_PLUGIN_ROOT: locations.root, PLUGIN_ROOT: locations.root, CLAUDE_PLUGIN_DATA: locations.data, CODEX_PLUGIN_DATA: locations.data, PLUGIN_DATA: locations.data, CLAUDE_PROJECT_DIR: locations.project, ...(locations.skillDir ? { CLAUDE_SKILL_DIR: locations.skillDir } : {}) };
  // One pass: values and arguments cannot introduce additional substitutions.
  let output = command.body.replace(/(\\*)\$(ARGUMENTS\[\d+\]|[A-Za-z_][A-Za-z0-9_]*|\d+)|\$\{(CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CODEX_PLUGIN_DATA|PLUGIN_DATA|CLAUDE_PROJECT_DIR|CLAUDE_SKILL_DIR|user_config\.[A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, slashes: string | undefined, token: string | undefined, variable: string | undefined) => {
    if (variable) {
      if (!variable.startsWith("user_config.")) return roots[variable] ?? whole;
      const key = variable.slice("user_config.".length);
      if (!locations.config || !Object.hasOwn(locations.config, key)) throw new Error(`Plugin command setting ${key} is unavailable.`);
      return locations.config[key]!;
    }
    const indexed = /^ARGUMENTS\[(\d+)\]$/.exec(token ?? "");
    const namedIndex = command.namedArguments?.indexOf(token ?? "") ?? -1;
    const known = token === "ARGUMENTS" || !!indexed || /^\d+$/.test(token ?? "") || namedIndex >= 0;
    if (!known) return whole;
    if (slashes === "\\") return whole.slice(1);
    const prefix = slashes ?? "";
    if (token === "ARGUMENTS") { replaced = true; return prefix + input; }
    if (namedIndex >= 0) { replaced = true; return prefix + (args[namedIndex] ?? ""); }
    const index = Number(indexed?.[1] ?? token); if (index >= args.length) return whole; replaced = true; return prefix + args[index]!;
  });
  if (input && !replaced) output += `\n\nARGUMENTS: ${input}`;
  if (output.length > 60_000 || output.includes("\0")) throw new Error("The expanded plugin command is too large to review.");
  return output;
}
export function looksLikePluginCommand(input: string): boolean { return /^\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}:[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\s|$)/.test(input.trim()); }
export function pluginCommandPrompt(command: { name: string; content: string }): string { return `\n\nUSER-INVOKED PLUGIN COMMAND ${JSON.stringify(command.name)} (user-selected instructions; obey higher-priority boundaries):\n${command.content}`; }
export function findPluginCommand(input: string, packages: Array<{ pkg: PluginPackage; root: string; providerRoot?: string; dataDir: string; commands: CommandDefinition[]; pluginFields?: BundleDefinition[] }>, project: string, allowMissing = false, settings?: { values(identity: { id: string; fingerprint: string }): Record<string, BundleValue>; paths: Record<string, string> }): { name: string; path?: string; warnings: string[]; content: string; settings?: Array<{ name: string; value: string }> } | undefined {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,63}):([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return undefined;
  const matches = packages.flatMap((entry) => entry.pkg.name.toLowerCase() === match[1]!.toLowerCase() ? entry.commands.filter((command) => command.name.toLowerCase() === match[2]!.toLowerCase()).map((command) => ({ entry, command })) : []);
  if (!matches.length && allowMissing) return undefined;
  if (matches.length !== 1) throw new Error(matches.length ? "More than one enabled plugin has that command name." : "No enabled plugin provides that command. Check Settings → Plugins.");
  const { entry, command } = matches[0]!; const root = entry.providerRoot ?? entry.root;
  if (command.unsupported.length) throw new Error(`This plugin command is unavailable: ${command.unsupported.join(" ")}`);
  const saved = settings?.values({ id: entry.pkg.id, fingerprint: entry.pkg.fingerprint }) ?? {};
  const { config, review } = instructionSettings(command.body, entry.pluginFields ?? [], saved, settings?.paths ?? {});
  const content = renderPluginCommand(command, match[3] ?? "", { root, data: entry.dataDir, project, config });
  return { ...(review.length ? { settings: review } : {}), name: `${entry.pkg.name}:${command.name}`, ...(command.path ? { path: path.join(root, ...command.path.split("/")) } : {}), warnings: command.warnings, content };
}
