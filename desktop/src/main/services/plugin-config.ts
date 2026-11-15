import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { resolveExecutable, type Executable } from "./providers";
import { expandBundleDefault, validateBundleValue, type BundleValue } from "./bundle-config";

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
  literalHeaders?: Record<string, string>;
  bearerTokenEnvVar?: string;
  isBundle?: boolean;
  bundleType?: "node" | "python" | "binary";
  bundleArchivePath?: string;
  bundleFingerprint?: string;
  bundleFieldScope?: string;
  bundleRoot?: string;
  bundleDataDir?: string;
  bundleRuntime?: { name: "node" | "python"; range: string };
  bundleFields?: import("./bundle-config").BundleDefinition[];
  authMode?: "none" | "bearer" | "oauth" | "mixed";
  oauthSettings?: import("./plugin-oauth").OAuthSettings;
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
  if (root.$schema !== undefined && (typeof root.$schema !== "string" || root.$schema.length > 2048)) throw new Error("Invalid plugin MCP schema reference.");
  if (root.mcpServers !== undefined && Object.keys(root).some((key) => key !== "$schema" && key !== "mcpServers")) throw new Error("The plugin MCP manifest has unrecognized top-level settings.");
  const servers = record(root.mcpServers ?? Object.fromEntries(Object.entries(root).filter(([key]) => key !== "$schema")), "plugin MCP servers");
  const entries = Object.entries(servers);
  if ((!entries.length && !options.allowEmpty) || entries.length > 32) throw new Error("A plugin must define between 1 and 32 MCP servers.");
  return entries.map(([name, raw]) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new Error("A plugin MCP server has an unsupported name.");
    const value = record(raw, "plugin MCP server");
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("Invalid plugin server enabled setting.");
    const command = value.command === undefined ? undefined : text(value.command, "plugin command");
    const url = value.url === undefined ? undefined : text(value.url, "plugin URL");
    if (!!command === !!url) throw new Error("A plugin server must have exactly one command or URL.");
    const configuredType = value.type === undefined ? (url ? "http" : "stdio") : text(value.type, "plugin transport", 30);
    const type = configuredType === "streamable-http" ? "http" : configuredType;
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
    let literalHeaders: Record<string, string> | undefined;
    let bearerTokenEnvVar: string | undefined;
    let authMode: "none" | "bearer" | "oauth" | "mixed" | undefined;
    let oauthSettings: import("./plugin-oauth").OAuthSettings | undefined;
    if (type !== "stdio") {
      let endpoint: URL;
      try { endpoint = new URL(url!); } catch { throw new Error("Invalid plugin URL."); }
      if (url!.includes("${") || endpoint.username || endpoint.password || endpoint.hash || !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname)))) throw new Error("Remote plugins require HTTPS or a loopback HTTP URL without embedded credentials.");
      if (args.length || cwd || Object.keys(env).length || envVars.length) unsupported.push("Local process settings cannot be applied to a remote server.");
      const readHeaders = (source: unknown): Record<string, string> => {
        const result: Record<string, string> = Object.create(null);
        for (const [key, rawHeader] of Object.entries(record(source, "HTTP headers"))) {
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key) || /^(?:host|origin|content-length|connection|transfer-encoding|accept|content-type|mcp-session-id|mcp-protocol-version)$/i.test(key) || typeof rawHeader !== "string" || rawHeader.length > 4096 || /[\0\r\n]/.test(rawHeader)) throw new Error("Invalid plugin HTTP header.");
          if (Object.keys(result).some((entry) => entry.toLowerCase() === key.toLowerCase())) throw new Error("Duplicate plugin HTTP header.");
          result[key] = rawHeader;
        }
        if (Object.keys(result).length > 32) throw new Error("Too many plugin HTTP headers.");
        return result;
      };
      if (value.headers !== undefined) headers = readHeaders(value.headers);
      if (value.http_headers !== undefined) literalHeaders = readHeaders(value.http_headers);
      if (Object.keys(headers ?? {}).some((key) => Object.keys(literalHeaders ?? {}).some((other) => other.toLowerCase() === key.toLowerCase()))) throw new Error("Duplicate plugin HTTP header.");
      if (value.bearer_token_env_var !== undefined) {
        bearerTokenEnvVar = text(value.bearer_token_env_var, "bearer token environment variable", 128);
        if (!namePattern.test(bearerTokenEnvVar) || [...Object.keys(headers ?? {}), ...Object.keys(literalHeaders ?? {})].some((key) => key.toLowerCase() === "authorization")) throw new Error("Invalid or conflicting bearer token configuration.");
      }
    } else if (value.headers !== undefined || value.http_headers !== undefined || value.bearer_token_env_var !== undefined) unsupported.push("HTTP headers cannot be applied to a local server.");
    if (value.extensions !== undefined) {
      const extensions = record(value.extensions, "plugin server extensions");
      for (const [extensionName, extensionValue] of Object.entries(extensions)) {
        if (extensionName !== "com.openai") { unsupported.push("This server has an unsupported host extension."); continue; }
        const extension = record(extensionValue, "OpenAI server extension");
        if (Object.keys(extension).some((key) => key !== "auth")) unsupported.push("This server has unsupported host extension settings.");
        if (extension.auth !== undefined) {
          const auth = record(extension.auth, "plugin authentication");
          const fields = Object.keys(auth);
          if (auth.type === "none" && fields.every((field) => field === "type")) authMode = "none";
          else if (type !== "stdio" && auth.type === "api_key" && auth.headerScheme === "bearer" && fields.every((field) => field === "type" || field === "headerScheme")) authMode = "bearer";
          else if (type !== "stdio" && (auth.type === "oauth" || auth.type === "mixed")) {
            const allowed = new Set(["type", "client", "baseScopes", "defaultScopes"]);
            if (fields.some((field) => !allowed.has(field))) unsupported.push("This server uses unsupported OAuth endpoint or identity overrides.");
            let clientId: string | undefined;
            if (auth.client !== undefined) {
              const client = record(auth.client, "OAuth client");
              if (client.mode === "provided" && typeof client.clientId === "string" && client.clientId.length > 0 && client.clientId.length <= 2048 && !/[\0\r\n]/.test(client.clientId) && (client.tokenEndpointAuthMethod === undefined || client.tokenEndpointAuthMethod === "none") && Object.keys(client).every((key) => ["mode", "clientId", "tokenEndpointAuthMethod"].includes(key))) clientId = client.clientId;
              else if (!(client.mode === "dcr" && Object.keys(client).every((key) => key === "mode"))) unsupported.push("This server requires an unsupported OAuth client registration method.");
            }
            const scopeParts = [...list(auth.baseScopes, "OAuth base scopes", 100), ...list(auth.defaultScopes, "OAuth default scopes", 100)];
            if (scopeParts.some((scope) => /\s/.test(scope))) throw new Error("Invalid OAuth scope.");
            oauthSettings = { ...(clientId ? { clientId } : {}), ...((auth.baseScopes !== undefined || auth.defaultScopes !== undefined) ? { scopes: [...new Set(scopeParts)] } : {}) };
            authMode = auth.type;
          } else unsupported.push("This server requires an unsupported authentication configuration.");
        }
      }
    }
    if (authMode === "none" && (bearerTokenEnvVar || [...Object.keys(headers ?? {}), ...Object.keys(literalHeaders ?? {})].some((key) => key.toLowerCase() === "authorization"))) unsupported.push("The declared unauthenticated server has conflicting authorization settings.");
    if ((authMode === "oauth" || authMode === "mixed") && (bearerTokenEnvVar || [...Object.keys(headers ?? {}), ...Object.keys(literalHeaders ?? {})].some((key) => key.toLowerCase() === "authorization"))) unsupported.push("The OAuth server has conflicting authorization settings.");
    if (value.oauth !== undefined || value.oauth_resource !== undefined || value.scopes !== undefined || value.auth !== undefined) unsupported.push("This server requires provider-specific authentication.");
    if (value.env_http_headers !== undefined || value.headersHelper !== undefined || value.http_headers_helper !== undefined || value.bearer_token !== undefined) unsupported.push("HTTP authentication or headers require explicit connection setup.");
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
    const known = new Set(["type", "command", "args", "cwd", "url", "extensions", "env", "env_vars", "enabled", "required", "startup_timeout_sec", "startup_timeout_ms", "tool_timeout_sec", "enabled_tools", "disabled_tools", "omit_tools_from", "default_tools_approval_mode", "tools", "supports_parallel_tool_calls", "tool_input_schema_max_bytes", "startup_readiness", "oauth", "oauth_resource", "scopes", "auth", "http_headers", "env_http_headers", "headers", "headersHelper", "http_headers_helper", "bearer_token", "bearer_token_env_var", "environment_id", "timeout", "alwaysLoad"]);
    const unknown = Object.keys(value).filter((key) => !known.has(key));
    if (unknown.length) unsupported.push("This server has unrecognized settings that Nova cannot safely honor.");
    return { name, transport: type as PluginServerConfig["transport"], enabled: value.enabled !== false, ...(command ? { command } : {}), args, ...(cwd ? { cwd } : {}), ...(url ? { url } : {}), ...(headers ? { headers } : {}), ...(literalHeaders ? { literalHeaders } : {}), ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}), ...(authMode ? { authMode } : {}), ...(oauthSettings ? { oauthSettings } : {}), env, envVars: [...new Set(envVars)], ...(enabledTools ? { enabledTools } : {}), disabledTools, omitToolsFrom, ...(startupTimeoutMs ? { startupTimeoutMs } : {}), ...(toolTimeoutMs ? { toolTimeoutMs } : {}), unsupported: [...new Set(unsupported)] };
  });
}

const ROOT_VARIABLES = new Set(["CLAUDE_PLUGIN_ROOT", "CODEX_PLUGIN_ROOT", "PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CODEX_PLUGIN_DATA", "PLUGIN_DATA", "CLAUDE_PROJECT_DIR"]);
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
export function requiredEnvironmentNames(server: PluginServerConfig): string[] {
  const names = new Set([...Object.keys(server.env), ...server.envVars, ...(server.bearerTokenEnvVar ? [server.bearerTokenEnvVar] : [])]);
  for (const value of [server.command, server.cwd, server.url, ...server.args, ...Object.values(server.env), ...Object.values(server.headers ?? {})]) {
    if (!value) continue;
    for (const match of value.matchAll(VARIABLE)) if (!ROOT_VARIABLES.has(match[1]!) && !(server.isBundle && ["HOME", "DESKTOP", "DOCUMENTS", "DOWNLOADS"].includes(match[1]!))) names.add(match[1]!);
  }
  return [...names].sort();
}
/** Only this summary may be displayed: it deliberately omits environment values and arguments. */
export function pluginServerSummary(server: PluginServerConfig): import("../../shared/plugins").PluginServerSummary {
  const remote = server.transport !== "stdio" && server.url;
  return { name: server.name, transport: server.transport, enabled: server.enabled, environmentNames: requiredEnvironmentNames(server), unsupported: server.unsupported,
    ...(remote ? { endpointOrigin: new URL(server.url!).origin, supportsCredential: !["none", "oauth", "mixed"].includes(server.authMode ?? "") && !server.bearerTokenEnvVar && ![...Object.keys(server.headers ?? {}), ...Object.keys(server.literalHeaders ?? {})].some((name) => name.toLowerCase() === "authorization") && !server.unsupported.length, supportsOAuth: !["none", "bearer"].includes(server.authMode ?? "") && !server.bearerTokenEnvVar && ![...Object.keys(server.headers ?? {}), ...Object.keys(server.literalHeaders ?? {})].some((name) => name.toLowerCase() === "authorization") && !server.unsupported.length } : {}) };
}

/** Resolve only explicitly configured headers; values stay in the main process. */
export function prepareRemotePluginHeaders(server: PluginServerConfig, inherited: NodeJS.ProcessEnv): Record<string, string> {
  const lookup = (name: string): string | undefined => {
    const key = Object.keys(inherited).find((candidate) => process.platform === "win32" ? candidate.toUpperCase() === name.toUpperCase() : candidate === name);
    return key ? inherited[key] : undefined;
  };
  const headers: Record<string, string> = { ...server.literalHeaders };
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    headers[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name: string) => {
      const resolved = lookup(name); if (resolved === undefined) throw new Error(`The plugin requires the environment variable ${name}.`); return resolved;
    });
    if (/\$\{|[\0\r\n]/.test(headers[key]!) || headers[key]!.length > 8192) throw new Error("Invalid remote plugin header value.");
  }
  if (server.bearerTokenEnvVar) {
    const name = server.bearerTokenEnvVar; const value = lookup(name);
    if (!value || !/^[\x21-\x7e]{1,4096}$/.test(value)) throw new Error(`The plugin requires a valid bearer token in the environment variable ${name}.`);
    headers.Authorization = `Bearer ${value}`;
  }
  return headers;
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
export async function preparePluginLaunch(server: PluginServerConfig, pluginRoot: string, inherited: NodeJS.ProcessEnv, locations: { dataDir?: string; projectDir?: string; bundleValues?: Record<string, BundleValue>; bundlePaths?: Record<string, string> } = {}): Promise<{
  executable: Executable; args: string[]; cwd: string; env: NodeJS.ProcessEnv; bundleReview?: Array<{ name: string; value: BundleValue | "[redacted]" }>;
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
  if (server.isBundle) for (const name of ["HOME", "DESKTOP", "DOCUMENTS", "DOWNLOADS"]) {
    const value = locations.bundlePaths?.[name]; if (value) variables[name] = value;
  }
  const bundleValues: Record<string, BundleValue> = Object.create(null);
  for (const field of server.bundleFields ?? []) {
    let value = locations.bundleValues?.[field.key] ?? field.defaultValue;
    if (value === undefined) {
      if (field.required) throw new Error(`Configure ${field.title} in Settings → Plugins before starting this bundle.`);
      bundleValues[field.key] = field.multiple ? [] : "";
      continue;
    }
    if (locations.bundleValues?.[field.key] === undefined) value = expandBundleDefault(value, locations.bundlePaths ?? {});
    bundleValues[field.key] = validateBundleValue(field, value);
  }
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
    const result = value.replace(/\$\{(user_config\.[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name: string) => {
      if (!name.startsWith("user_config.")) return resolveVariable(name);
      const fieldName = name.slice("user_config.".length);
      if (!Object.hasOwn(bundleValues, fieldName)) throw new Error(`The bundle refers to an unknown setting: ${fieldName}.`);
      const resolved = bundleValues[fieldName];
      if (Array.isArray(resolved)) throw new Error("Multiple bundle paths may only appear as a complete command argument.");
      return String(resolved);
    });
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
  if (server.bundleFields?.some((field) => field.sensitive && (server.command!.includes(`\${user_config.${field.key}}`) || server.cwd?.includes(`\${user_config.${field.key}}`)))) throw new Error("A sensitive bundle setting cannot select the executable or working directory.");
  let command = expand(server.command);
  if (!path.isAbsolute(command) && (command.includes("/") || command.includes("\\"))) {
    command = path.resolve(root, command);
    if (!contained(command)) throw new Error("A relative plugin command escapes its copied package.");
  }
  let cwd = server.cwd ? expand(server.cwd) : root;
  const sensitiveValues = (server.bundleFields ?? []).filter((field) => field.sensitive).map((field) => bundleValues[field.key]).filter((value): value is string => typeof value === "string" && !!value);
  if (sensitiveValues.some((value) => command.includes(value) || cwd.includes(value))) throw new Error("A sensitive bundle setting cannot select the executable or working directory.");
  if (!path.isAbsolute(cwd)) {
    cwd = path.resolve(root, cwd);
    if (!contained(cwd)) throw new Error("A relative plugin working directory escapes its copied package.");
  }
  const realCwd = await realpath(cwd);
  if (!(await lstat(realCwd)).isDirectory()) throw new Error("The plugin working directory is unavailable.");
  let executable: Executable;
  try { executable = await pluginExecutable(command, environment.PATH ?? ""); }
  catch (error) {
    if (server.isBundle && server.bundleType === "node" && /^(?:node|node\.exe)$/i.test(command)) executable = { command: process.execPath, prefix: [], ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}) };
    else throw error;
  }
  const args = server.args.flatMap((argument) => {
    const match = /^\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(argument);
    const value = match ? bundleValues[match[1]!] : undefined;
    return Array.isArray(value) ? value.map((item) => { if (/\$\{|[\0\r\n]/.test(item)) throw new Error("Invalid bundle path."); return item; }) : [expand(argument)];
  });
  const bundleReview = server.isBundle ? (server.bundleFields ?? []).map((field) => ({ name: field.key, value: field.sensitive ? "[redacted]" as const : bundleValues[field.key]! })) : undefined;
  return { executable, args: [...executable.prefix, ...args], cwd: realCwd, env: { ...environment, ...executable.env }, ...(bundleReview ? { bundleReview } : {}) };
}
