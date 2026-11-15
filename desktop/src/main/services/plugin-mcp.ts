import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { PluginPackage } from "../../shared/plugins";
import { snapshotSkillPackage } from "./skill-packages";
import { preparePluginLaunch, requiredEnvironmentNames, type PluginServerConfig } from "./plugin-config";
import { McpProcessError, McpStdioClient, type ImportedMcpTool } from "./mcp-stdio";
import { startLocalMcp } from "./mcp-http";

type Json = Record<string, unknown>;
type PreparedPackage = { pkg: PluginPackage; root: string; dataDir: string; servers: PluginServerConfig[] };
export type PluginApproval = (request: { action: "start" | "discover" | "call"; title: string; detail: string }) => Promise<boolean>;
interface Launch {
  pkg: PluginPackage; server: PluginServerConfig; root: string;
  dataDir: string;
  projectDir: string;
  directoryIdentities: Array<{ path: string; dev: number; ino: number }>;
  prepared: Awaited<ReturnType<typeof preparePluginLaunch>>;
  fileIdentities: Array<{ path: string; dev: number; ino: number; size: number; mtimeMs: number }>;
}
interface Entry { client: McpStdioClient; pkg: PluginPackage; server: PluginServerConfig; tool: ImportedMcpTool }

function redact(value: unknown, key = "", depth = 0): unknown {
  if (depth > 12) throw new Error("The plugin request is too deeply nested to review.");
  if (/(?:token|secret|password|passwd|api.?key|credential|authorization)/i.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (/\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|Bearer\s+\S+)/i.test(value) || /(?:password|token|secret|api.?key|authorization)\s*[=:]/i.test(value)) return "[redacted]";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, "", depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name, depth + 1)]));
  return value;
}
function redactedArguments(args: string[]): string[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) { redactNext = false; return "[redacted]"; }
    if (/^--?(?:token|secret|password|passwd|api[-_]?key|credential|authorization)$/i.test(arg)) { redactNext = true; return arg; }
    return String(redact(arg));
  });
}
function printable(value: unknown, max = 6000): string {
  const text = JSON.stringify(value, null, 2);
  if (!text || text.length > max) throw new Error("The plugin request is too large to review. Reduce it and retry.");
  return text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
const equalFile = (left: Omit<Launch["fileIdentities"][number], "path">, right: Omit<Launch["fileIdentities"][number], "path">) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
const summary = (launch: Launch) => ({
  plugin: launch.pkg.name, server: launch.server.name, executable: launch.prepared.executable.command,
  arguments: redactedArguments([...launch.prepared.executable.prefix, ...launch.server.args]), workingDirectory: launch.prepared.cwd,
  pluginDataDirectory: launch.dataDir, projectDirectory: launch.projectDir, environmentNames: requiredEnvironmentNames(launch.server), environmentOverrides: redact(launch.server.env),
});

/** Start only reviewed stdio servers and gate every tool call independently. */
export async function startPluginMcp(packages: PreparedPackage[], approve: PluginApproval, signal: AbortSignal, projectDir = process.cwd()): Promise<{
  url: string; token: string; dispose(): Promise<void>;
}> {
  signal.throwIfAborted();
  const launches: Launch[] = [];
  for (const entry of packages) for (const server of entry.servers) {
    const prepared = await preparePluginLaunch(server, entry.root, process.env, { dataDir: entry.dataDir, projectDir });
    const fileIdentities: Launch["fileIdentities"] = [];
    const scripts = prepared.args.filter((arg) => path.isAbsolute(arg) && /\.(?:[cm]?js|py|exe|ps1|sh|bat|cmd|jar)$/i.test(arg));
    for (const file of new Set([prepared.executable.command, ...prepared.executable.prefix, ...scripts])) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("A plugin executable or script is unavailable or redirected.");
      fileIdentities.push({ path: file, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs });
    }
    const directoryIdentities: Launch["directoryIdentities"] = [];
    for (const directory of new Set([entry.dataDir, projectDir, prepared.cwd])) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("A plugin directory is unavailable or redirected.");
      directoryIdentities.push({ path: directory, dev: info.dev, ino: info.ino });
    }
    launches.push({ pkg: entry.pkg, server, root: entry.root, dataDir: entry.dataDir, projectDir, prepared, fileIdentities, directoryIdentities });
  }
  if (!launches.length) throw new Error("No enabled plugin servers are available.");
  const startDetail = printable({ servers: launches.map(summary), note: "These programs run with your user account and can access files or networks as soon as they start. Each later tool call is separately reviewed. Sensitive-looking environment values are redacted; inherited values are not displayed." });
  if (!(await approve({ action: "start", title: "Start selected plugin servers?", detail: startDetail }))) throw new Error("Plugin startup was declined.");
  signal.throwIfAborted();
  // Revalidate reviewed package bytes and executable identities after the dialog.
  for (const entry of packages) {
    const snapshot = await snapshotSkillPackage(entry.root, { allowNoSkills: true });
    if (snapshot.fingerprint !== entry.pkg.fingerprint) throw new Error(`Plugin ${entry.pkg.name} changed after review.`);
  }
  for (const launch of launches) {
    for (const file of launch.fileIdentities) {
      const info = await lstat(file.path);
      if (!info.isFile() || info.isSymbolicLink() || !equalFile(file, info)) throw new Error("A reviewed plugin executable or script changed before startup.");
    }
    for (const directory of launch.directoryIdentities) {
      const info = await lstat(directory.path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== directory.dev || info.ino !== directory.ino || (process.platform === "win32" ? (await realpath(directory.path)).toLowerCase() !== path.resolve(directory.path).toLowerCase() : await realpath(directory.path) !== path.resolve(directory.path))) throw new Error("A reviewed plugin directory changed before startup.");
    }
  }
  const clients: McpStdioClient[] = [];
  const entries = new Map<string, Entry>();
  const definitions: Json[] = [];
  let active = false;
  let definitionBytes = 0;
  const closeClients = async () => {
    const results = await Promise.all(clients.map(async (client) => { try { return await client.close(); } catch { return false; } }));
    if (results.some((result) => !result)) throw new McpProcessError("A plugin server's termination could not be confirmed. Inspect its processes before continuing.", true);
  };
  try {
    for (const launch of launches) {
      signal.throwIfAborted();
      const snapshot = await snapshotSkillPackage(launch.root, { allowNoSkills: true });
      if (snapshot.fingerprint !== launch.pkg.fingerprint) throw new Error("A plugin package changed before its server started.");
      for (const file of launch.fileIdentities) {
        const info = await lstat(file.path);
        if (!info.isFile() || info.isSymbolicLink() || !equalFile(file, info)) throw new Error("A plugin executable or script changed before its server started.");
      }
      for (const directory of launch.directoryIdentities) {
        const info = await lstat(directory.path);
        if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== directory.dev || info.ino !== directory.ino) throw new Error("A plugin directory changed before its server started.");
      }
      const client = new McpStdioClient({ command: launch.prepared.executable.command, args: launch.prepared.args, cwd: launch.prepared.cwd, env: launch.prepared.env, signal });
      clients.push(client);
      const timeout = launch.server.startupTimeoutMs ?? 30_000;
      const deadline = Date.now() + timeout;
      await client.initialize(timeout);
      const tools = await client.listTools(Math.max(1, deadline - Date.now()));
      for (const tool of tools) {
        if (launch.server.enabledTools && !launch.server.enabledTools.includes(tool.name)) continue;
        if (launch.server.disabledTools.includes(tool.name)) continue;
        const hash = createHash("sha256").update(JSON.stringify([launch.pkg.id, launch.server.name, tool.name])).digest("hex").slice(0, 16);
        const alias = `p_${hash}_${tool.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}`;
        if (entries.has(alias)) throw new Error("Plugin tool names collided.");
        entries.set(alias, { client, pkg: launch.pkg, server: launch.server, tool });
        const definition = { name: alias, description: `[${launch.pkg.name} / ${launch.server.name}] ${tool.description ?? "Imported plugin tool."}`, inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) };
        definitionBytes += Buffer.byteLength(JSON.stringify(definition));
        if (definitions.length >= 1024 || definitionBytes > 8 * 1024 * 1024) throw new Error("The enabled plugin tool catalog exceeds Nova's size limit.");
        definitions.push(definition);
      }
    }
    if (!definitions.length) throw new Error("The enabled plugin servers exposed no allowed tools.");
    const catalog = [...entries.values()].map((entry) => `${entry.pkg.name} / ${entry.server.name} / ${entry.tool.name}`);
    const catalogDetail = printable({ note: "These tool names, descriptions, and full input schemas will be shared with the selected provider. Review the plugin source for any private metadata before allowing.", count: catalog.length, tools: catalog }, 64_000);
    if (!(await approve({ action: "discover", title: "Share discovered plugin tools?", detail: catalogDetail }))) throw new Error("Sharing plugin tool metadata was declined.");
    signal.throwIfAborted();
    return await startLocalMcp({
      name: "nova-plugins", tools: definitions, signal,
      execute: async (alias, args, requestSignal) => {
        const entry = entries.get(alias);
        if (!entry) throw new Error("Unknown plugin tool.");
        if (active) throw new Error("Another plugin action is awaiting approval or running.");
        active = true;
        try {
          const detail = printable({ plugin: entry.pkg.name, server: entry.server.name, tool: entry.tool.name, arguments: redact(args), note: "Sensitive-looking values are redacted. The plugin server runs with your user account." });
          if (!(await approve({ action: "call", title: `Run ${entry.tool.name}?`, detail }))) throw new Error("Plugin tool call was declined.");
          requestSignal.throwIfAborted();
          return await entry.client.call(entry.tool.name, args, requestSignal, entry.server.toolTimeoutMs);
        } finally { active = false; }
      },
      close: closeClients,
    });
  } catch (error) {
    await closeClients();
    throw error;
  }
}
