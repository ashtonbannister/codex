import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { resolveExecutable, type Executable } from "./providers";

/** Parsed plugin server configuration stays in the main process; env values are never sent to the renderer. */
export interface PluginServerConfig {
  name: string;
  transport: "stdio" | "http" | "sse";
  enabled: boolean;
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  env: Record<string, string>;
  envVars: string[];
  enabledTools?: string[];
  disabledTools: string[];
  omitToolsFrom: string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  unsupported: string[];
}
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string, max = 4096): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
};
const namePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
function list(value: unknown, label: string, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label}.`);
  return value.map((item) => text(item, label, 256));
}

/** Parse a selected .mcp.json; reject ambiguous config rather than dropping restrictions. */
export function parsePluginMcp(value: unknown, options: { allowEmpty?: boolean } = {}): PluginServerConfig[] {
  const root = record(value, "plugin MCP manifest");
  const servers = record(root.mcpServers ?? root, "plugin MCP servers");
  const entries = Object.entries(servers);
  if ((!entries.length && !options.allowEmpty) || entries.length > 32) throw new Error("A plugin must define between 1 and 32 MCP servers.");
  return entries.map(([name, raw]) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new Error("A plugin MCP server has an unsupported name.");
    const value = record(raw, "plugin MCP server");
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("Invalid plugin server enabled setting.");
    const command = value.command === undefined ? undefined : text(value.command, "plugin command");
    const url = value.url === undefined ? undefined : text(value.url, "plugin URL");
    if (!!command === !!url) throw new Error("A plugin server must have exactly one command or URL.");
    const type = value.type === undefined ? (url ? "http" : "stdio") : text(value.type, "plugin transport", 20);
    if (!["stdio", "http", "sse"].includes(type) || (type === "stdio") !== !!command) throw new Error("Unsupported or inconsistent plugin transport.");
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 100)) throw new Error("Invalid plugin arguments.");
    const args = (value.args as unknown[] | undefined ?? []).map((item) => {
      if (typeof item !== "string" || item.length > 8192 || /[\0\r\n]/.test(item)) throw new Error("Invalid plugin argument.");
      return item;
    });
    const cwd = value.cwd === undefined ? undefined : text(value.cwd, "plugin working directory");
    const env: Record<string, string> = Object.create(null);
    if (value.env !== undefined) {
      const entries = Object.entries(record(value.env, "plugin environment"));
      if (entries.length > 100) throw new Error("Too many plugin environment variables.");
      for (const [key, entry] of entries) {
        if (!namePattern.test(key) || typeof entry !== "string" || entry.length > 4096 || /[\0\r\n]/.test(entry)) throw new Error("Invalid plugin environment variable.");
        env[key] = entry;
      }
    }
    const envVars: string[] = [];
    const unsupported: string[] = [];
    if (value.env_vars !== undefined) {
      if (!Array.isArray(value.env_vars) || value.env_vars.length > 100) throw new Error("Invalid inherited environment list.");
      for (const entry of value.env_vars) {
        const variable = typeof entry === "string" ? { name: entry } : record(entry, "inherited environment variable");
        if (typeof variable.name !== "string" || !namePattern.test(variable.name)) throw new Error("Invalid inherited environment variable name.");
        if (variable.source !== undefined && variable.source !== "local") unsupported.push("Remote environment variables require their original host.");
        else envVars.push(variable.name);
      }
    }
    if (process.platform === "win32") {
      const seen = new Map<string, string>();
      for (const key of [...Object.keys(env), ...envVars]) {
        const canonical = key.toUpperCase();
        if (seen.has(canonical) && seen.get(canonical) !== key) throw new Error("Plugin environment names differ only by case.");
        seen.set(canonical, key);
      }
    }
    const enabledTools = value.enabled_tools === undefined ? undefined : list(value.enabled_tools, "enabled tool list", 1024);
    const disabledTools = list(value.disabled_tools, "disabled tool list", 1024);
    const omitToolsFrom = list(value.omit_tools_from, "tool exposure list", 3);
    if (omitToolsFrom.some((item) => !["direct", "deferred", "code_mode"].includes(item))) throw new Error("Unsupported plugin tool exposure restriction.");
    if (omitToolsFrom.includes("direct")) unsupported.push("This server forbids direct tool exposure, which Nova cannot currently honor.");
    let headers: Record<string, string> | undefined;
    if (type !== "stdio") {
      let endpoint: URL;
      try { endpoint = new URL(url!); } catch { throw new Error("Invalid plugin URL."); }
      if (url!.includes("${") || endpoint.username || endpoint.password || endpoint.hash || !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname)))) throw new Error("Remote plugins require HTTPS or a loopback HTTP URL without embedded credentials.");
      if (args.length || cwd || Object.keys(env).length || envVars.length) unsupported.push("Local process settings cannot be applied to a remote server.");
      if (value.headers !== undefined) {
        headers = Object.create(null) as Record<string, string>;
        for (const [key, rawHeader] of Object.entries(record(value.headers, "HTTP headers"))) {
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key) || /^(?:host|origin|content-length|connection|transfer-encoding|accept|content-type|mcp-session-id|mcp-protocol-version)$/i.test(key) || typeof rawHeader !== "string" || rawHeader.length > 4096 || /[\0\r\n]/.test(rawHeader)) throw new Error("Invalid plugin HTTP header.");
          if (Object.keys(headers).some((entry) => entry.toLowerCase() === key.toLowerCase())) throw new Error("Duplicate plugin HTTP header.");
          headers[key] = rawHeader;
        }
        if (Object.keys(headers).length > 32) throw new Error("Too many plugin HTTP headers.");
      }
    } else if (value.headers !== undefined) unsupported.push("HTTP headers cannot be applied to a local server.");
    if (value.oauth !== undefined || value.oauth_resource !== undefined || value.scopes !== undefined || value.auth !== undefined) unsupported.push("This server requires provider-specific authentication.");
    if (value.http_headers !== undefined || value.env_http_headers !== undefined || value.headersHelper !== undefined || value.http_headers_helper !== undefined || value.bearer_token !== undefined || value.bearer_token_env_var !== undefined) unsupported.push("HTTP authentication or headers require explicit connection setup.");
    if (value.environment_id !== undefined && value.environment_id !== "local") unsupported.push("This server targets an external execution environment.");
    if (value.tools !== undefined && Object.keys(record(value.tools, "per-tool settings")).length) unsupported.push("Per-tool plugin settings are not yet supported.");
    if (value.required === true) unsupported.push("Required-server startup semantics are not yet supported.");
    if (value.required !== undefined && typeof value.required !== "boolean") throw new Error("Invalid required-server setting.");
    if (value.startup_readiness !== undefined && value.startup_readiness !== "live") unsupported.push("This server requires unsupported startup readiness behavior.");
    const timeout = (entry: unknown, multiplier: number, label: string): number | undefined => {
      if (entry === undefined) return undefined;
      if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0 || entry * multiplier > 120_000) throw new Error(`Invalid ${label}.`);
      return Math.ceil(entry * multiplier);
    };
    if (value.startup_timeout_ms !== undefined && value.startup_timeout_sec !== undefined) throw new Error("Ambiguous plugin startup timeout.");
    const startupTimeoutMs = timeout(value.startup_timeout_ms ?? value.startup_timeout_sec, value.startup_timeout_ms === undefined ? 1000 : 1, "plugin startup timeout");
    const toolTimeoutMs = timeout(value.tool_timeout_sec ?? value.timeout, value.tool_timeout_sec === undefined ? 1 : 1000, "plugin tool timeout");
    const known = new Set(["type", "command", "args", "cwd", "url", "env", "env_vars", "enabled", "required", "startup_timeout_sec", "startup_timeout_ms", "tool_timeout_sec", "enabled_tools", "disabled_tools", "omit_tools_from", "default_tools_approval_mode", "tools", "supports_parallel_tool_calls", "tool_input_schema_max_bytes", "startup_readiness", "oauth", "oauth_resource", "scopes", "auth", "http_headers", "env_http_headers", "headers", "headersHelper", "http_headers_helper", "bearer_token", "bearer_token_env_var", "environment_id", "timeout", "alwaysLoad"]);
    const unknown = Object.keys(value).filter((key) => !known.has(key));
    if (unknown.length) unsupported.push("This server has unrecognized settings that Nova cannot safely honor.");
    return { name, transport: type as PluginServerConfig["transport"], enabled: value.enabled !== false, ...(command ? { command } : {}), args, ...(cwd ? { cwd } : {}), ...(url ? { url } : {}), ...(headers ? { headers } : {}), env, envVars: [...new Set(envVars)], ...(enabledTools ? { enabledTools } : {}), disabledTools, omitToolsFrom, ...(startupTimeoutMs ? { startupTimeoutMs } : {}), ...(toolTimeoutMs ? { toolTimeoutMs } : {}), unsupported: [...new Set(unsupported)] };
  });
}

const ROOT_VARIABLES = new Set(["CLAUDE_PLUGIN_ROOT", "CODEX_PLUGIN_ROOT", "PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CODEX_PLUGIN_DATA", "PLUGIN_DATA", "CLAUDE_PROJECT_DIR"]);
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
export function requiredEnvironmentNames(server: PluginServerConfig): string[] {
  const names = new Set([...Object.keys(server.env), ...server.envVars]);
  for (const value of [server.command, server.cwd, server.url, ...server.args, ...Object.values(server.env), ...Object.values(server.headers ?? {})]) {
    if (!value) continue;
    for (const match of value.matchAll(VARIABLE)) if (!ROOT_VARIABLES.has(match[1]!)) names.add(match[1]!);
  }
  return [...names].sort();
}
/** Only this summary may be displayed: it deliberately omits environment values and arguments. */
export function pluginServerSummary(server: PluginServerConfig): import("../../shared/plugins").PluginServerSummary {
  const remote = server.transport !== "stdio" && server.url;
  return { name: server.name, transport: server.transport, enabled: server.enabled, environmentNames: requiredEnvironmentNames(server), unsupported: server.unsupported,
    ...(remote ? { endpointOrigin: new URL(server.url!).origin, supportsCredential: !Object.keys(server.headers ?? {}).some((name) => name.toLowerCase() === "authorization") && !server.unsupported.length } : {}) };
}

/** Resolve the known npm npx shim directly through Node instead of a Windows shell. */
async function pluginExecutable(command: string, searchPath: string): Promise<Executable> {
  if (process.platform === "win32" && /^(?:npx|npx\.cmd)$/i.test(command)) {
    const directories = searchPath.split(";").filter((entry) => path.isAbsolute(entry));
    for (const directory of directories) {
      const node = path.join(directory, "node.exe");
      const shim = path.join(directory, "npx.cmd");
      const script = path.join(directory, "node_modules", "npm", "bin", "npx-cli.js");
      try {
        const [nodeInfo, shimInfo, scriptInfo] = await Promise.all([lstat(node), lstat(shim), lstat(script)]);
        if (nodeInfo.isFile() && !nodeInfo.isSymbolicLink() && shimInfo.isFile() && !shimInfo.isSymbolicLink() && scriptInfo.isFile() && !scriptInfo.isSymbolicLink())
          return { command: await realpath(node), prefix: [await realpath(script)] };
      } catch { /* Try the next PATH entry. */ }
    }
    throw new Error("The plugin requires npx, but its Node and npm entry point could not be found safely.");
  }
  return resolveExecutable(command, process.platform, searchPath);
}

/** Resolve one reviewed stdio server without a shell or exposing environment values. */
export async function preparePluginLaunch(server: PluginServerConfig, pluginRoot: string, inherited: NodeJS.ProcessEnv, locations: { dataDir?: string; projectDir?: string } = {}): Promise<{
  executable: Executable; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
}> {
  if (!server.enabled || server.transport !== "stdio" || !server.command || server.unsupported.length) throw new Error("This plugin server cannot be started with its current settings.");
  if (!path.isAbsolute(pluginRoot)) throw new Error("The plugin copy path is invalid.");
  const rootInfo = await lstat(pluginRoot);
  const root = await realpath(pluginRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("The plugin copy was redirected.");
  for (const [label, directory] of [["data", locations.dataDir], ["project", locations.projectDir]] as const) {
    if (!directory) continue;
    if (!path.isAbsolute(directory)) throw new Error(`The plugin ${label} directory is invalid.`);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform === "win32" ? (await realpath(directory)).toLowerCase() !== path.resolve(directory).toLowerCase() : await realpath(directory) !== path.resolve(directory))) throw new Error(`The plugin ${label} directory was redirected.`);
  }
  const lookup = (name: string): string | undefined => {
    const key = Object.keys(inherited).find((candidate) => process.platform === "win32" ? candidate.toUpperCase() === name.toUpperCase() : candidate === name);
    return key ? inherited[key] : undefined;
  };
  const variables: Record<string, string> = Object.create(null);
  for (const key of ["CLAUDE_PLUGIN_ROOT", "CODEX_PLUGIN_ROOT", "PLUGIN_ROOT"]) variables[key] = root;
  if (locations.dataDir) for (const key of ["CLAUDE_PLUGIN_DATA", "CODEX_PLUGIN_DATA", "PLUGIN_DATA"]) variables[key] = locations.dataDir;
  if (locations.projectDir) variables.CLAUDE_PROJECT_DIR = locations.projectDir;
  const resolving = new Set<string>();
  const resolveVariable = (name: string): string => {
    if (Object.hasOwn(variables, name)) return variables[name]!;
    if (ROOT_VARIABLES.has(name)) throw new Error(`The plugin requires an unavailable Nova location: ${name}.`);
    if (resolving.has(name)) throw new Error(`Plugin environment references form a cycle at ${name}.`);
    const configured = Object.hasOwn(server.env, name) ? server.env[name]! : undefined;
    // A variable explicitly referring to itself means inherit its host value.
    const selfReference = configured === `\${${name}}`;
    if (configured !== undefined && !selfReference) {
      resolving.add(name);
      try { return variables[name] = expand(configured); }
      finally { resolving.delete(name); }
    }
    const value = lookup(name);
    if (value === undefined) throw new Error(`The plugin requires the environment variable ${name}.`);
    return variables[name] = value;
  };
  const expand = (value: string): string => {
    const result = value.replace(VARIABLE, (_whole, name: string) => resolveVariable(name));
    if (/\$\{/.test(result) || /[\0\r\n]/.test(result) || result.length > 16_384) throw new Error("The plugin contains an unsupported or invalid variable reference.");
    return result;
  };
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "LANG"]) {
    const value = lookup(name); if (value !== undefined) environment[name] = value;
  }
  for (const name of server.envVars) environment[name] = resolveVariable(name);
  for (const name of Object.keys(server.env)) environment[name] = resolveVariable(name);
  for (const name of ROOT_VARIABLES) if (variables[name] !== undefined) environment[name] = variables[name];
  const contained = (candidate: string) => {
    const relative = path.relative(root, candidate);
    return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  let command = expand(server.command);
  if (!path.isAbsolute(command) && (command.includes("/") || command.includes("\\"))) {
    command = path.resolve(root, command);
    if (!contained(command)) throw new Error("A relative plugin command escapes its copied package.");
  }
  let cwd = server.cwd ? expand(server.cwd) : root;
  if (!path.isAbsolute(cwd)) {
    cwd = path.resolve(root, cwd);
    if (!contained(cwd)) throw new Error("A relative plugin working directory escapes its copied package.");
  }
  const realCwd = await realpath(cwd);
  if (!(await lstat(realCwd)).isDirectory()) throw new Error("The plugin working directory is unavailable.");
  const executable = await pluginExecutable(command, environment.PATH ?? "");
  return { executable, args: [...executable.prefix, ...server.args.map(expand)], cwd: realCwd, env: { ...environment, ...executable.env } };
}
