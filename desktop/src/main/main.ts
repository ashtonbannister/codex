import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type {
  MemoryInput,
  RunRequest,
  Settings,
  ThreadUpdate,
  VerificationProfileInput,
  VerificationRequest,
  WorkspaceState,
} from "../shared/types";
import { WorkspaceService } from "./services/workspace-service";
import { LocalKeyStore } from "./services/local-key-store";
import { PluginCredentialStore } from "./services/plugin-credentials";
import { BundleConfigStore } from "./services/bundle-config-store";
import { authorizeThreadPermission, ThreadPermissionStore, type PermissionContext } from "./services/thread-permissions";
import { expandBundleDefault } from "./services/bundle-config";
import { PluginOAuthStore } from "./services/plugin-oauth-store";
import { signInPluginOAuth, pluginOAuthToken, type OAuthReview } from "./services/plugin-oauth";
import { SkillPackageStore } from "./services/skill-packages";
import { PluginPackageStore } from "./services/plugin-packages";
import { DesktopControlSession, windowsAutomationRunner, windowsProcessStartTime } from "./services/desktop-control";
import { lstat } from "node:fs/promises";
import {
  inspectCodexInstallation,
  resolveCodexHome,
} from "./services/codex-installation";
import type {
  CodexHistoryQuery,
  CodexImportRequest,
  CodexMemoryImportRequest,
  CodexResourceQuery,
  CodexResourceRequest,
  CodexThreadQuery,
} from "../shared/compatibility";
import { confirmationValue } from "./confirmation";
import { listLocalModels, validateLocalConnection } from "./services/local-models";
import { resolveExecutable } from "./services/providers";
import { saveMarkdownExport } from "./services/export-file";
import { ProviderAuthService, officialLoginUrl } from "./services/provider-auth";
import { ensureNovaCodexHome } from "./services/nova-runtime";
import type { AccountProvider } from "../shared/provider-auth";
import type {
  CommitWorktreeRequest,
  IntegrateWorktreeRequest,
  RecoveryRequest,
} from "../shared/workspace-actions";
import type { SharedMemoryRequest } from "../shared/sharing";
import type { FabricCorrectionRequest, FabricReadRequest, FabricSearchQuery } from "../shared/memory-fabric";
import {
  APP_URL,
  assetPath,
  CONTENT_SECURITY_POLICY,
  DEV_ORIGIN,
  isTrustedRendererUrl,
} from "./security";

app.setName("Nova Workbench");
app.enableSandbox();
// The CI smoke test uses an explicit temporary profile, never the user's real workspace.
// This switch has no effect in packaged releases.
if (!app.isPackaged && process.argv.includes("--nova-smoke-test")) {
  const smokeDirectory = process.env.NOVA_TEST_USER_DATA;
  if (!smokeDirectory || !path.isAbsolute(smokeDirectory)) {
    throw new Error(
      "The native smoke test requires an absolute temporary user-data directory.",
    );
  }
  app.setPath("userData", smokeDirectory);
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: "nova",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let window: BrowserWindow | null = null;
let workspace: WorkspaceService | undefined;
let providerAuth: ProviderAuthService | undefined;
let accountOperationPending = false;
let engineSensitiveInFlight = 0;
let broadcastTimer: NodeJS.Timeout | undefined;
let latestState: WorkspaceState | undefined;
let quitting = false;
const development =
  !app.isPackaged && process.env.NOVA_DEV_SERVER_URL === DEV_ORIGIN;

function broadcast(state: WorkspaceState) {
  latestState = state;
  applyNativeTheme(state.settings.theme);
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    if (window && !window.isDestroyed() && latestState) {
      window.webContents.send("workspace:changed", latestState);
    }
  }, 80);
}

function applyNativeTheme(theme: Settings["theme"]) {
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
  if (!window || window.isDestroyed()) return;
  const dark = nativeTheme.shouldUseDarkColors;
  window.setTitleBarOverlay({
    color: dark ? "#181a19" : "#f1f2ef",
    symbolColor: dark ? "#d9dedb" : "#242724",
    height: 42,
  });
  window.setBackgroundColor(dark ? "#1b1d1c" : "#f7f7f5");
}

function assertSender(event: Electron.IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url, development)
  ) {
    throw new Error("This request did not come from the workbench window.");
  }
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new Error("Invalid identifier.");
  return value;
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid request.");
  return value as Record<string, unknown>;
}

// These remain usable while account sign-in is waiting on the browser or a
// previous worker needs manual recovery. Explicit read-only import operations
// never touch provider runtime state. All other IPC participates in the
// account-operation gate, including future workspace/provider handlers.
const PASSIVE_DURING_AUTH = new Set([
  "workspace:snapshot",
  "provider:help",
  "provider:login-state",
  "provider:login-cancel",
  "plugins:oauth-cancel",
  "workspace:recovery",
  "workspace:acknowledge-recovery",
  "run:cancel",
  "verification:cancel",
  "project:open",
  "run:reveal",
  "codex:installation",
  "codex:threads",
  "codex:history",
  "codex:resources",
  "codex:preview-resource",
  "codex:publish-handoff",
  "memory:fabric-search",
  "memory:fabric-read",
  "memory:fabric-stats",
]);
const ACCOUNT_OPERATIONS = new Set([
  "provider:account-status",
  "provider:codex-models",
  "skills:import",
  "skills:import-archive",
  "skills:enabled",
  "plugins:import",
  "plugins:import-bundle",
  "plugins:bundle-setting",
  "plugins:bundle-path",
  "plugins:enabled",
  "plugins:server",
  "plugins:credential",
  "plugins:oauth-start",
  "plugins:oauth-remove",
  "provider:login-start",
]);

async function assertAccountIdle(service: WorkspaceService): Promise<void> {
  const { state } = await service.snapshot();
  if (state.runs.some((run) => run.status === "queued" || run.status === "running") ||
    state.verifications.some((check) => check.status === "running"))
    throw new Error("Finish or stop active agent work and checks before changing or reading provider accounts.");
  if ((await service.listRecoveryItems()).some((item) => item.kind !== "codex-home"))
    throw new Error("Resolve the listed worker recovery items before connecting provider accounts.");
}

function accountProvider(value: unknown): AccountProvider {
  if (value !== "codex" && value !== "claude")
    throw new Error("Choose Codex or Claude Code for account sign-in.");
  return value;
}

function handle(
  name: string,
  callback: (payload: unknown) => Promise<unknown>,
) {
  ipcMain.handle(name, async (event, payload: unknown) => {
    assertSender(event);
    if (quitting) throw new Error("Nova is shutting down. Wait for owned workers to stop.");
    if (PASSIVE_DURING_AUTH.has(name)) return callback(payload);
    if (ACCOUNT_OPERATIONS.has(name)) {
      // Reserve synchronously before a dialog, snapshot, or filesystem await.
      // A status read also starts an owned provider process, so it takes the
      // same gate as login rather than racing a Nova model worker.
      if (accountOperationPending || engineSensitiveInFlight || providerAuth?.busy)
        throw new Error("Another workspace or account operation is running. Finish or cancel it before connecting an account.");
      accountOperationPending = true;
      try {
        if (!workspace) throw new Error("The workspace is not ready.");
        await assertAccountIdle(workspace);
        return await callback(payload);
      } finally {
        accountOperationPending = false;
      }
    }
    if (accountOperationPending || providerAuth?.busy || latestState?.accountRecovery)
      throw new Error("Provider account work is active or needs recovery. Finish or cancel sign-in, or review Settings → Recovery, before continuing workspace operations.");
    engineSensitiveInFlight++;
    try {
      return await callback(payload);
    } finally {
      engineSensitiveInFlight--;
    }
  });
}

let localKeyStore: LocalKeyStore;
let pluginCredentials: PluginCredentialStore;
let bundleConfigStore: BundleConfigStore;
let pluginOAuthStore: PluginOAuthStore;
let threadPermissions: ThreadPermissionStore | undefined;
let threadPermissionError: string | undefined;
let pluginOAuthController: AbortController | undefined;
const localKey = (connection: ReturnType<typeof validateLocalConnection>) => localKeyStore.get(connection);

async function reviewChatPermission(context: PermissionContext | undefined, scope: unknown | undefined, prompt: { title: string; message: string; detail: string }): Promise<boolean> {
  if (!window || window.isDestroyed() || quitting) return false;
  return authorizeThreadPermission(threadPermissions, context, scope, async (remember) => {
    if (!window || window.isDestroyed() || quitting) return 0;
    const chat = context ? latestState?.threads.find((thread) => thread.id === context.threadId) : undefined;
    const note = remember ? "Allow always applies only to the same action, verified package, target, inputs, provider, model and mode in this chat. Window contents and files referenced by commands may change. Clear saved permissions from the chat menu." : threadPermissionError ? `Saved chat permissions are unavailable: ${threadPermissionError}` : threadPermissions && !threadPermissions.available() ? "OS encryption is unavailable; this request requires approval each time." : "This request requires approval each time.";
    const result = await dialog.showMessageBox(window, { type: "question", buttons: ["Deny", "Allow once", ...(remember ? ["Allow always for this chat"] : [])], defaultId: 0, cancelId: 0, title: prompt.title, message: prompt.message, detail: `${chat ? `Chat: ${confirmationValue(chat.title)}\n\n` : ""}${prompt.detail}\n\n${note}` });
    return result.response;
  });
}

function registerHandlers(service: WorkspaceService) {
  const plugins = new PluginPackageStore(path.join(app.getPath("userData"), "workspace"));
  handle("plugins:list", async () => (await plugins.list()).map((pkg) => {
    const folders: Record<string, string> = { HOME: app.getPath("home"), DESKTOP: app.getPath("desktop"), DOCUMENTS: app.getPath("documents"), DOWNLOADS: app.getPath("downloads") };

    return { ...pkg, servers: pkg.servers.map((server) => ({ ...server, credentialStored: pluginCredentials.has({ id: pkg.id, fingerprint: pkg.fingerprint, server: server.name }), oauthConnected: pluginOAuthStore.has({ id: pkg.id, fingerprint: pkg.fingerprint, server: server.name }) })),
      ...(pkg.bundleFields ? { bundleFields: pkg.bundleFields.map((field) => {
        const settings = bundleConfigStore.get({ id: pkg.id, fingerprint: pkg.fingerprint, ...(field.server ? { server: field.server } : {}) });
        return { ...field, ...(Object.hasOwn(settings, field.key) ? { configured: true, ...(!field.sensitive ? { value: settings[field.key] } : {}) } : !field.sensitive && field.value !== undefined ? { value: expandBundleDefault(field.value, folders) } : {}) };
      }) } : {}) };
  }));
  handle("plugins:bundle-setting", async (payload) => {
    const input = objectPayload(payload); const scope = input.server === undefined ? undefined : identifier(input.server);
    const entry = await plugins.bundleField(identifier(input.id), identifier(input.field), input.value === null, scope);
    await bundleConfigStore.set({ id: entry.id, fingerprint: entry.fingerprint, ...(entry.server ? { server: entry.server } : {}) }, entry.definition, input.value);
  });
  handle("plugins:bundle-path", async (payload) => {
    const input = objectPayload(payload); const scope = input.server === undefined ? undefined : identifier(input.server);
    const entry = await plugins.bundleField(identifier(input.id), identifier(input.field), false, scope);
    if (!["file", "directory"].includes(entry.definition.type)) throw new Error("This bundle setting is not a path.");
    const properties: Array<"openFile" | "openDirectory" | "multiSelections"> = [entry.definition.type === "file" ? "openFile" : "openDirectory"];
    if (entry.definition.multiple) properties.push("multiSelections");
    const selection = await dialog.showOpenDialog(window!, { title: entry.definition.title, properties });
    return selection.canceled ? null : entry.definition.multiple ? selection.filePaths : selection.filePaths[0] ?? null;
  });
  handle("plugins:credential", async (payload) => {
    const input = objectPayload(payload);
    if (typeof input.token !== "string") throw new Error("Invalid plugin credential.");
    const identity = await plugins.credentialIdentity(identifier(input.id), identifier(input.name), input.token === "");
    if (input.token && pluginOAuthStore.has(identity)) throw new Error("Disconnect the existing plugin sign-in before saving a bearer token.");
    await pluginCredentials.set(identity, input.token);
  });
  const reviewPluginOAuth: OAuthReview = async (request) => {
    if (!window || window.isDestroyed() || quitting) return false;
    const result = await dialog.showMessageBox(window, { type: "question", buttons: ["Cancel", "Continue"], defaultId: 0, cancelId: 0, title: "Plugin sign-in", message: request.title, detail: confirmationValue(request.detail) });
    return result.response === 1;
  };
  handle("plugins:oauth-cancel", async () => { pluginOAuthController?.abort(); });
  handle("plugins:oauth-remove", async (payload) => {
    const input = objectPayload(payload); const identity = await plugins.credentialIdentity(identifier(input.id), identifier(input.name), true);
    await pluginOAuthStore.set(identity);
  });
  handle("plugins:oauth-start", async (payload) => {
    if (pluginOAuthController) throw new Error("Another plugin sign-in is active.");
    const controller = new AbortController(); pluginOAuthController = controller;
    try {
      const input = objectPayload(payload); const id = identifier(input.id), name = identifier(input.name);
      const pluginSettings = { values: (identity: { id: string; fingerprint: string }) => bundleConfigStore.get(identity), paths: { HOME: app.getPath("home"), DESKTOP: app.getPath("desktop"), DOCUMENTS: app.getPath("documents"), DOWNLOADS: app.getPath("downloads") } };
      const connection = await plugins.oauthConnection(id, name, pluginSettings);
      if (pluginCredentials.has(connection.identity)) throw new Error("Remove the saved bearer token before connecting a plugin account.");
      if (!await reviewPluginOAuth({ title: "Connect this plugin?", detail: `Nova will contact ${new URL(connection.endpoint).origin} to discover its sign-in provider. The connection sends these configured header names: ${Object.keys(connection.resourceHeaders).join(", ") || "none"}. ${connection.settingReview?.length ? `Settings sent in headers: ${JSON.stringify(connection.settingReview)}. ` : ""}Authorization can grant access to your data. Review every destination and requested permission.` })) throw new Error("Plugin sign-in was declined.");
      controller.signal.throwIfAborted();
      await signInPluginOAuth({ ...connection, store: pluginOAuthStore, signal: controller.signal, review: reviewPluginOAuth, open: (url) => shell.openExternal(url), beforeSave: async () => {
        const current = await plugins.oauthConnection(id, name, pluginSettings);
        if (JSON.stringify(current) !== JSON.stringify(connection)) throw new Error("The plugin changed during sign-in. Import it again before retrying.");
      } });
    } finally { if (pluginOAuthController === controller) pluginOAuthController = undefined; }
  });
  const importPlugin = async (source: string) => {
    const preview = await plugins.preview(source);
    const lines = preview.servers.map((server) => `${confirmationValue(server.name)} — ${server.transport}${server.enabled ? "" : " (disabled in source)"}${server.unsupported.length ? ` — unavailable: ${server.unsupported.join(" ")}` : ""}; environment names: ${server.environmentNames.map(confirmationValue).join(", ") || "none"}`);
    const result = await dialog.showMessageBox(window!, {
      type: "question", buttons: ["Cancel", "Import disabled"], defaultId: 0, cancelId: 0,
      title: "Import this plugin package?", message: `Import ${confirmationValue(preview.name)}?`,
      detail: `Source: ${confirmationValue(source)}\n${preview.files} files · ${preview.bytes.toLocaleString()} bytes · ${preview.skills.length} skill(s) · ${preview.commands?.length ?? 0} command(s)\n${preview.bundleFields?.length ? `Bundle settings: ${preview.bundleFields.map((field) => `${confirmationValue(field.title)}${field.required ? " (required)" : ""}${field.sensitive ? " (sensitive)" : ""}`).join(", ")}\n` : ""}\n${lines.join("\n")}${preview.commands?.length ? `\n\nCommands: ${preview.commands.map((command) => `${confirmationValue(command.name)}${command.unsupported.length ? " (unavailable)" : ""}`).join(", ")}` : ""}${preview.warnings.length ? `\n\nNot loaded: ${preview.warnings.join(" ")}` : ""}\n\nThe selected package is copied into Nova and may include private configuration. It starts disabled. For each run, Nova asks before sharing selected plugin skills or an invoked command with the chosen provider. That provider can read files in the copied package. Plugin servers require a separate startup review, their discovered tool catalog requires approval before sharing, and each tool call requires approval. Plugin programs run with your user account and may access files or networks at startup. Only import packages you trust.`,
    });
    if (result.response !== 1) return null;
    return plugins.install(source, preview.fingerprint);
  };
  handle("plugins:import", async () => {
    const selected = await dialog.showOpenDialog(window!, { title: "Choose a plugin package folder", buttonLabel: "Review plugin", properties: ["openDirectory"] });
    return selected.canceled || !selected.filePaths[0] ? null : importPlugin(selected.filePaths[0]);
  });
  handle("plugins:import-bundle", async () => {
    const selected = await dialog.showOpenDialog(window!, { title: "Choose a plugin archive or MCP bundle", buttonLabel: "Review package", properties: ["openFile"], filters: [{ name: "Plugin archives and MCP bundles", extensions: ["mcpb", "dxt", "zip", "plugin"] }] });
    return selected.canceled || !selected.filePaths[0] ? null : importPlugin(selected.filePaths[0]);
  });
  handle("plugins:enabled", async (payload) => {
    const input = objectPayload(payload);
    await plugins.setEnabled(identifier(input.id), input.enabled as boolean);
  });
  handle("plugins:server", async (payload) => {
    const input = objectPayload(payload);
    await plugins.setServerEnabled(identifier(input.id), identifier(input.name), input.enabled as boolean);
  });
  const skills = new SkillPackageStore(path.join(app.getPath("userData"), "workspace"));
  handle("skills:list", () => skills.list());
  const importSkills = async (source: string) => {
    const preview = await skills.preview(source);
    const result = await dialog.showMessageBox(window!, {
      type: "question", buttons: ["Cancel", "Import skills"], defaultId: 0, cancelId: 0,
      title: "Import this skill package?",
      message: `Import ${confirmationValue(preview.name)} with ${preview.skills.length} skill(s)?`,
      detail: `Source: ${confirmationValue(source)}\n${preview.files} files · ${preview.bytes.toLocaleString()} bytes\n\nSkills:\n${preview.skills.slice(0, 30).map((item) => `• ${confirmationValue(item.name)} — ${confirmationValue(item.path)}`).join("\n")}${preview.skills.length > 30 ? "\n…additional skills" : ""}\n\nAll files in this package are copied into Nova. For each run, Nova asks before sharing the enabled skill names, descriptions and paths with the selected provider; the provider can read the copied instructions and supporting files. Skill instructions may request commands or external tools and should be trusted. MCP servers and plugin tools are not installed or enabled by this action. The source is not changed.`,
    });
    if (result.response !== 1) return null;
    return skills.install(source, preview.fingerprint);
  };
  handle("skills:import", async () => {
    const selected = await dialog.showOpenDialog(window!, { title: "Choose a skill or plugin package folder", buttonLabel: "Review package", properties: ["openDirectory"] });
    return selected.canceled || !selected.filePaths[0] ? null : importSkills(selected.filePaths[0]);
  });
  handle("skills:import-archive", async () => {
    const selected = await dialog.showOpenDialog(window!, { title: "Choose a skill archive", buttonLabel: "Review skills", properties: ["openFile"], filters: [{ name: "Skill archives", extensions: ["skill", "zip", "plugin"] }] });
    return selected.canceled || !selected.filePaths[0] ? null : importSkills(selected.filePaths[0]);
  });
  handle("skills:enabled", async (payload) => {
    const input = objectPayload(payload);
    await skills.setEnabled(identifier(input.id), input.enabled as boolean);
  });
  const accounts = new ProviderAuthService({
    openExternal: async (url) => {
      if (!officialLoginUrl("codex", url) && !officialLoginUrl("claude", url))
        throw new Error("The provider returned a non-official sign-in URL.");
      await shell.openExternal(url);
    },
    onRecoveryRequired: (provider, home) => service.recordAccountRecovery(provider, home),
    onOperationStart: (provider, home) => service.beginAccountOperation(provider, home),
    onOperationFinished: (id) => service.finishAccountOperation(id),
  });
  providerAuth = accounts;
  handle("provider:choose-executable", async (payload) => {
    if (payload !== "codex" && payload !== "claude")
      throw new Error("Choose Codex or Claude Code.");
    const selection = await dialog.showOpenDialog(window!, {
      title: `Choose the installed ${payload === "codex" ? "Codex" : "Claude Code"} executable`,
      buttonLabel: "Use executable",
      properties: ["openFile"],
      filters: [{ name: "CLI executable or JavaScript entry point", extensions: ["exe", "js", "cjs", "mjs", "cmd"] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const selected = await realpath(selection.filePaths[0]);
    await resolveExecutable(selected);
    return selected;
  });
  handle("provider:help", async (payload) => {
    const pages: Record<string, string> = {
      codex: "https://developers.openai.com/codex/cli/",
      claude: "https://code.claude.com/docs/en/setup",
      ollama: "https://docs.ollama.com/quickstart",
      lmstudio: "https://lmstudio.ai/docs/developer",
    };
    if (typeof payload !== "string" || !Object.hasOwn(pages, payload))
      throw new Error("Unknown provider documentation.");
    await shell.openExternal(pages[payload]!);
  });
  handle("provider:local-models", async (payload) => {
    const connection = validateLocalConnection(payload);
    return listLocalModels(connection, undefined, localKey(connection));
  });
  handle("provider:local-key", async (payload) => {
    const input = objectPayload(payload);
    const connection = validateLocalConnection(input.connection);
    if (typeof input.key !== "string" || input.key.length > 4096 || /[\x00-\x1f\x7f]/.test(input.key))
      throw new Error("Invalid local server key.");
    await localKeyStore.set(connection, input.key);
  });
  const approvedImportSources = new Set<string>();
  const approvedHandoffs = new Set<string>();
  let importPrompt: Promise<void> | undefined;
  const importIdentity = async () => {
    const settings = (await service.snapshot()).state.settings;
    return {
      codexPath: settings.codexPath,
      home: await resolveCodexHome(settings.codexHome),
    };
  };
  const importKey = (home: string) => process.platform === "win32" ? home.toLowerCase() : home;
  const confirmImportSource = async (): Promise<{
    codexPath: string;
    home: string;
  }> => {
    const identity = await importIdentity();
    const key = importKey(identity.home);
    if (approvedImportSources.has(key)) return identity;
    if (importPrompt) {
      await importPrompt;
      if (
        !approvedImportSources.has(key) ||
        importKey((await importIdentity()).home) !== key
      )
        throw new Error("The Codex import source changed. Read and confirm the selected source again.");
      return identity;
    }
    importPrompt = (async () => {
      const result = await dialog.showMessageBox(window!, {
        type: "question",
        buttons: ["Cancel", "Read import source"],
        defaultId: 0,
        cancelId: 0,
        title: "Read this Codex import source?",
        message: "Preview saved conversations and selected text for copying into Nova?",
        detail: `Read-only source: ${confirmationValue(identity.home)}\n\nNova reads supported conversation and reference files only. No Codex process is started, no native session is resumed, and no source files, locks, databases, credentials, or configuration are changed. There is no background sync or watcher. Selected visible text is copied into Nova's own workspace only when you import it. Nova's agents and sign-in use separate working state.`,
      });
      if (result.response !== 1)
        throw new Error(
          "Source read cancelled. No Codex process was started or source data imported.",
        );
      if (importKey((await importIdentity()).home) !== key)
        throw new Error(
          "The Codex import source changed during confirmation. Read and confirm it again.",
        );
      approvedImportSources.add(key);
    })();
    try {
      await importPrompt;
    } finally {
      importPrompt = undefined;
    }
    return identity;
  };
  const accountOptions = async (provider: AccountProvider) => {
    const settings = (await service.snapshot()).state.settings;
    const cwd = path.join(app.getPath("userData"), "workspace");
    return {
      settings,
      home: await ensureNovaCodexHome(cwd, settings.codexHome),
      // Metadata/login commands never start in the selected project. This is
      // the already-created app-owned workspace data directory, not repo code.
      cwd,
    };
  };
  const accountIdentity = (options: Awaited<ReturnType<typeof accountOptions>>) =>
    JSON.stringify([options.settings.codexPath, options.settings.claudePath, options.home]);
  handle("provider:codex-models", async () => accounts.listModels(await accountOptions("codex")));
  handle("provider:account-status", async (payload) => {
    const provider = accountProvider(payload);
    const options = await accountOptions(provider);
    await assertAccountIdle(service);
    return accounts.read(provider, options);
  });
  handle("provider:login-state", async () => accounts.getLogin());
  handle("provider:login-cancel", async () => accounts.cancel());
  handle("provider:login-start", async (payload) => {
    const provider = accountProvider(payload);
    const options = await accountOptions(provider);
    const before = accountIdentity(options);
    const executable = provider === "codex" ? options.settings.codexPath : options.settings.claudePath;
    const confirmation = await dialog.showMessageBox(window!, {
      type: "question",
      buttons: ["Cancel", "Sign in with official tool"],
      defaultId: 0,
      cancelId: 0,
      title: provider === "codex" ? "Sign in to Nova's separate Codex runtime?" : "Sign in to Claude Code?",
      message: "Let the installed official tool open its browser sign-in flow?",
      detail: `Executable: ${confirmationValue(executable)}\n${provider === "codex" ? `Nova Codex runtime: ${confirmationValue(options.home)}\n\nSign in once for Nova. The official CLI stores this sign-in in Nova's app-owned runtime, separate from the OEM Codex account and working folders. Nothing is copied from the OEM credential store; your OEM sign-in is not changed. ` : "\nThis changes the account managed by Claude Code. Claude Desktop maintains a separate sign-in session. Finish other Claude Code work before continuing. "}Credentials remain with the official tool; Nova does not read, copy, or exchange tokens. Signing in makes no model request. Provider usage limits still apply.`,
      ...(provider === "claude" ? {
        checkboxLabel: "Other Claude Code workers are idle.",
        checkboxChecked: false,
      } : {}),
    });
    if (confirmation.response !== 1 || (provider === "claude" && !confirmation.checkboxChecked))
      throw new Error("Sign-in cancelled. The official login process was not started.");
    const current = await accountOptions(provider);
    if (accountIdentity(current) !== before)
      throw new Error("Provider settings changed during confirmation. Review the current installation and sign in again.");
    await assertAccountIdle(service);
    return accounts.start(provider, current);
  });
  handle("codex:installation", async () => {
    const identity = await confirmImportSource();
    return inspectCodexInstallation(
      identity.home,
      {
        documents: app.getPath("documents"),
        appData: app.getPath("appData"),
      },
    );
  });
  handle("storage:choose", async (payload) => {
    if (payload !== "codex-home" && payload !== "worktrees")
      throw new Error("Unknown storage location.");
    const settings = (await service.snapshot()).state.settings;
    const result = await dialog.showOpenDialog(window!, {
      title:
        payload === "codex-home"
          ? "Choose the read-only Codex import source"
          : "Choose storage for new Nova worktrees",
      buttonLabel: "Use folder",
      properties: ["openDirectory"],
      defaultPath:
        (payload === "codex-home"
          ? settings.codexHome
          : settings.worktreeStoragePath) || app.getPath("documents"),
    });
    return result.canceled || !result.filePaths[0]
      ? null
      : realpath(result.filePaths[0]);
  });
  handle("codex:threads", async (payload) => {
    const query = objectPayload(payload) as unknown as CodexThreadQuery;
    const identity = await confirmImportSource();
    return service.listCodexThreads(query, identity);
  });
  handle("codex:history", async (payload) => {
    const query = objectPayload(payload) as unknown as CodexHistoryQuery;
    const identity = await confirmImportSource();
    return service.readCodexHistory(query, identity);
  });
  handle("codex:refresh-thread", async (payload) => {
    const threadId = identifier(payload);
    const identity = await confirmImportSource();
    return service.refreshCodexThread(threadId, identity);
  });
  handle("codex:publish-handoff", async () => {
    throw new Error("OEM Codex is import-only. Publishing native handoffs is disabled; export a copy instead.");
  });
  handle("codex:import-thread", async (payload) => {
    const request = objectPayload(payload) as unknown as CodexImportRequest;
    identifier(request.threadId);
    const identity = await confirmImportSource();
    const result = await dialog.showMessageBox(window!, {
      type: "question",
      buttons: ["Cancel", "Open in Nova"],
      defaultId: 0,
      cancelId: 0,
      title: "Copy this conversation into Nova?",
      message:
        "Create an independent copy of the visible conversation in Nova's own workspace?",
      detail:
        "Importing sends no model turn. Nova copies a bounded visible transcript into an app-owned folder; the recorded source working folder is not opened or adopted. Codex, Claude, and local models all use this independent copy. No native session is resumed or forked, and no hidden state, credentials, or configuration is copied. The original conversation and its archive state remain untouched. There is no automatic sync; Copy latest is another explicit read-only import.",
    });
    if (result.response !== 1)
      throw new Error("Conversation import cancelled.");
    return service.importCodexThread(request, identity);
  });
  handle("codex:resources", async (payload) => {
    await confirmImportSource();
    return service.listCodexResources(
      objectPayload(payload) as unknown as CodexResourceQuery,
    );
  });
  handle("codex:preview-resource", async (payload) => {
    await confirmImportSource();
    return service.previewCodexResource(
      objectPayload(payload) as unknown as CodexResourceRequest,
    );
  });
  handle("codex:import-memory", async (payload) => {
    await confirmImportSource();
    const request = objectPayload(
      payload,
    ) as unknown as CodexMemoryImportRequest;
    const projectId = identifier(request.projectId);
    const project = (await service.snapshot()).state.projects.find(
      (entry) => entry.id === projectId,
    );
    if (!project)
      throw new Error("Select a project before importing a reference.");
    const preview = await service.previewCodexResource(request);
    if (preview.sha256 !== request.expectedSha256)
      throw new Error(
        "This reference changed. Preview it again before importing.",
      );
    const result = await dialog.showMessageBox(window!, {
      type: "question",
      buttons: ["Cancel", "Import shared reference"],
      defaultId: 0,
      cancelId: 0,
      title: "Share this reference with the project's agents?",
      message: `Import ${confirmationValue(preview.path)} into ${confirmationValue(project.name)}?`,
      detail:
        "Nova saves up to 8000 characters of the previewed text with its source fingerprint. It can be included in later requests to Codex, Claude Code, or your selected local model for this project. Review private information before sharing. Importing a skill or instructions makes reference text available; it does not install a plugin, execute code, or grant permissions. The original file is preserved.",
    });
    if (result.response !== 1) throw new Error("Reference import cancelled.");
    return service.importCodexMemory(request, preview.home);
  });
  handle("memory:shared-preview", (payload) => service.previewSharedMemory(identifier(payload)));
  handle("memory:shared-publish", async (payload) => {
    const request = objectPayload(payload) as unknown as SharedMemoryRequest;
    identifier(request.projectId);
    if (typeof request.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(request.fingerprint))
      throw new Error("Review the shared-memory preview before publishing.");
    const preview = await service.previewSharedMemory(request.projectId);
    if (preview.fingerprint !== request.fingerprint)
      throw new Error("Shared memory or project files changed. Refresh the preview and review it again.");
    const confirmation = await dialog.showMessageBox(window!, {
      type: "question", buttons: ["Cancel", "Publish shared memory"], defaultId: 0, cancelId: 0,
      title: "Enable shared project memory?",
      message: "Write the reviewed common memory and instruction references?",
      detail: `Project: ${confirmationValue(preview.projectPath)}\n\n${preview.files.map((file) => `${confirmationValue(file.path)} — ${file.changed ? "write reviewed contents" : "unchanged"}`).join("\n")}\n\nThis writes ordinary project files, preserving text outside Nova's managed blocks. Official Codex and Claude Code can read the shared file through their project instructions. Nova includes a fresh, bounded read in future requests to your chosen cloud or local provider. Review private information before sharing. These files appear as normal Git changes; commit them before an isolated Build requiring a clean baseline. Replaced revisions are retained in ignored .nova/.memory-backups folders. No private provider database, credential file, or global instructions are edited. Pause external agents/editors: these independent tools do not share an OS-wide write transaction.`,
      checkboxLabel: "Other tools are not editing these three project files.",
      checkboxChecked: false,
    });
    if (confirmation.response !== 1 || !confirmation.checkboxChecked) throw new Error("Shared memory publication cancelled. Project files were not changed.");
    return service.publishSharedMemory(request);
  });
  handle("memory:shared-disable", (payload) => service.disableSharedMemory(identifier(payload)));
  handle("workspace:snapshot", () => service.snapshot());
  handle("workspace:refresh-providers", () => service.refreshProviderStatus());
  handle("thread:update", (payload) =>
    service.updateThread(objectPayload(payload) as unknown as ThreadUpdate),
  );
  handle("thread:clear-permissions", async (payload) => {
    const id = identifier(payload); if (!(await service.snapshot()).state.threads.some((thread) => thread.id === id)) throw new Error("Thread not found.");
    if (!threadPermissions) throw new Error(threadPermissionError || "Saved chat permissions are unavailable.");
    await threadPermissions.clear(id);
  });
  handle("thread:delete", async (payload) => {
    const id = identifier(payload);
    const thread = (await service.snapshot()).state.threads.find((item) => item.id === id);
    if (!thread) throw new Error("Thread not found.");
    const confirmation = await dialog.showMessageBox(window!, {
      type: "warning",
      buttons: ["Cancel", "Delete thread"],
      defaultId: 0,
      cancelId: 0,
      message: `Delete “${confirmationValue(thread.title)}”?`,
      detail: `This permanently removes the conversation and its run and check history from Nova.${thread.worktreePath ? `\n\nThe worktree and its files remain at: ${confirmationValue(thread.worktreePath)}` : ""}\n\nProject files and the source Codex conversation are not deleted.`,
    });
    if (confirmation.response !== 1) return false;
    if (threadPermissions?.available()) await threadPermissions.clear(id);
    await service.deleteThread(id);
    return true;
  });
  handle("context:preview", (payload) =>
    service.previewContext(objectPayload(payload) as unknown as RunRequest),
  );
  handle("project:ensure-chat", () => service.ensureChatWorkspace());
  handle("project:choose", async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: "Open a Git project",
      properties: ["openDirectory"],
      buttonLabel: "Open project",
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return service.addProject(result.filePaths[0]);
  });
  handle("run:start", async (payload) => {
    const input = objectPayload(payload) as unknown as RunRequest;
    const before = await service.snapshot();
    const linked = before.state.threads.find(
      (entry) => entry.id === input.threadId,
    )?.codex;
    if (linked) {
      const handoffKey = `${input.threadId}\0${input.provider}`;
      if (!approvedHandoffs.has(handoffKey)) {
        const result = await dialog.showMessageBox(window!, {
          type: "question",
          buttons: ["Cancel", "Continue with selected agent"],
          defaultId: 0,
          cancelId: 0,
          title: "Share this conversation's visible context?",
          message:
            input.provider === "codex"
              ? "Continue this independent Nova copy with Codex?"
              : input.provider === "claude"
                ? "Continue this independent Nova copy with Claude Code?"
                : "Continue this independent Nova copy with the configured local model?",
          detail:
            "A bounded selection of copied visible messages, Nova turns, and selected project memories will be sent to this provider when you continue. Private reasoning, credentials, native session state, and binary attachments are not transferred. The original Codex conversation and working folder remain separate: no native resume or fork occurs. The Context inspector shows Nova's reference selection and omissions.",
        });
        if (result.response !== 1)
          throw new Error("Provider handoff cancelled before execution.");
        approvedHandoffs.add(handoffKey);
      }
    }
    if (input.mode === "build") {
      const projectId = identifier(input.projectId);
      const snapshot = await service.snapshot();
      const project = snapshot.state.projects.find(
        (item) => item.id === projectId,
      );
      if (!project) throw new Error("Select a project first.");
      const confirmation = await dialog.showMessageBox(window!, {
        type: "question",
        buttons: ["Cancel", "Start isolated build"],
        defaultId: 0,
        cancelId: 0,
        title: "Allow an agent to edit its worktree?",
        message: `Start a build for ${project.name}?`,
        detail:
          "Nova will use an isolated Git worktree, never automatically merge it, and preserve it for review. " +
          "The selected CLI runs with its configured account and may incur usage. A worktree isolates file changes, " +
          "not the whole operating system. Only use projects and tools you trust.",
      });
      if (confirmation.response !== 1)
        throw new Error("Build cancelled before execution.");
    }
    return service.startRun(input);
  });
  handle("run:cancel", (value) => service.cancelRun(identifier(value)));
  handle("run:diff", (value) => service.getDiff(identifier(value)));
  handle("worktree:review", (value) => service.reviewWorktree(identifier(value)));
  handle("worktree:commit", async (payload) => {
    const request = objectPayload(payload) as unknown as CommitWorktreeRequest;
    identifier(request.runId);
    if (typeof request.message !== "string" || !request.message.trim() ||
      request.message.length > 4_000 || request.message.includes("\0"))
      throw new Error("Enter a commit message of 1–4000 characters.");
    const review = await service.reviewWorktree(request.runId);
    if (!review.canCommit) throw new Error(review.commitReason ?? "This worktree cannot be committed yet.");
    if (request.expectedHead !== review.head || request.expectedFingerprint !== review.fingerprint)
      throw new Error("The worktree changed. Refresh Changes and review it before committing.");
    const confirmation = await dialog.showMessageBox(window!, {
      type: "question",
      buttons: ["Cancel", "Commit reviewed changes"],
      defaultId: 0,
      cancelId: 0,
      title: "Commit this worktree?",
      message: `Commit ${review.changes.length} changed paths on ${confirmationValue(review.branch)}?`,
      detail: `Message: ${confirmationValue(request.message)}\nRevision: ${review.head}\n\n${review.changes.slice(0, 30).map((change) => confirmationValue(change.path)).join("\n")}${review.changes.length > 30 ? "\n…additional reviewed paths" : ""}\n\nThis commits reviewed, non-ignored changes in Nova's owned worktree. Repository hooks, filters and signing helpers are not run. Nothing is pushed or merged into the original checkout. A commit does not mean the task has been verified.`,
    });
    if (confirmation.response !== 1) throw new Error("Commit cancelled; no commit was created.");
    return service.commitWorktree(request);
  });
  handle("worktree:integrate", async (payload) => {
    const request = objectPayload(payload) as unknown as IntegrateWorktreeRequest;
    identifier(request.runId);
    const review = await service.reviewWorktree(request.runId);
    if (!review.canIntegrate) throw new Error(review.integrationReason ?? "This branch cannot be integrated yet.");
    if (request.expectedHead !== review.head || request.expectedTargetHead !== review.targetHead ||
      request.expectedTargetBranch !== review.targetBranch ||
      request.expectedFingerprint !== review.fingerprint ||
      request.expectedTargetFingerprint !== review.targetFingerprint)
      throw new Error("A branch changed. Refresh the review before integrating.");
    const confirmation = await dialog.showMessageBox(window!, {
      type: "warning",
      buttons: ["Cancel", "Fast-forward original checkout"],
      defaultId: 0,
      cancelId: 0,
      title: "Bring the committed changes into your original project?",
      message: `Update ${confirmationValue(review.targetBranch)} to ${confirmationValue(review.branch)}?`,
      detail: `Original revision: ${review.targetHead}\nWorktree revision: ${review.head}\n\nThis changes files and advances the branch in your ORIGINAL project checkout. Both checkouts must be clean and the update must be a fast-forward. Nova refuses divergent history; it does not force a reset, create a merge commit, push, or delete the worktree. Review the diff and relevant checks first.`,
    });
    if (confirmation.response !== 1) throw new Error("Integration cancelled; the original project was not updated.");
    return service.integrateWorktree(request);
  });
  handle("workspace:recovery", () => service.listRecoveryItems());
  handle("workspace:acknowledge-recovery", async (payload) => {
    const request = objectPayload(payload) as unknown as RecoveryRequest;
    const item = (await service.listRecoveryItems()).find((entry) => entry.id === request.id);
    if (!item || item.token !== request.token)
      throw new Error("The recovery state changed. Refresh Recovery before continuing.");
    const confirmation = await dialog.showMessageBox(window!, {
      type: "warning",
      buttons: ["Keep locked", "Acknowledge and unlock"],
      defaultId: 0,
      cancelId: 0,
      checkboxLabel: "I have inspected and stopped the remaining worker processes for this item.",
      checkboxChecked: false,
      title: "Confirm worker cleanup before unlocking",
      message: `Unlock ${confirmationValue(item.label)}?`,
      detail: `${confirmationValue(item.detail)}\n\nNova could not confirm that an earlier worker stopped. Close or terminate the affected CLI workers first, including any child processes. This records YOUR confirmation, not a successful automatic process inspection. The original failure remains in history. Unlocking while a worker is still active can allow competing file changes.`,
    });
    if (confirmation.response !== 1 || !confirmation.checkboxChecked)
      throw new Error("Recovery remains locked. Confirm cleanup before unlocking.");
    if (request.id === "provider-accounts" && accounts.operationActive)
      throw new Error("An account operation is still running. Cancel it before acknowledging cleanup.");
    await service.acknowledgeRecovery(request);
    if (request.id === "provider-accounts") accounts.acknowledgeRecovery();
  });
  handle("thread:export", async (payload) => {
    const exported = await service.exportConversation(identifier(payload));
    const selection = await dialog.showSaveDialog(window!, {
      title: "Export visible conversation and project memory",
      buttonLabel: "Save Markdown",
      defaultPath: path.join(app.getPath("documents"), exported.filename),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (selection.canceled || !selection.filePath) return { saved: false };
    const destination = await saveMarkdownExport(selection.filePath, exported.content);
    return { saved: true, path: destination };
  });
  handle("memory:save", (payload) =>
    service.saveMemory(objectPayload(payload) as unknown as MemoryInput),
  );
  handle("memory:fabric-search", (payload) =>
    service.memoryFabricSearch(objectPayload(payload) as unknown as FabricSearchQuery),
  );
  handle("memory:fabric-read", (payload) =>
    service.memoryFabricRead(objectPayload(payload) as unknown as FabricReadRequest),
  );
  handle("memory:fabric-stats", (payload) => service.memoryFabricStats(identifier(payload)));
  handle("memory:fabric-correct", (payload) =>
    service.memoryFabricCorrect(objectPayload(payload) as unknown as FabricCorrectionRequest),
  );
  handle("memory:fabric-forget", async (payload) => {
    const input = objectPayload(payload);
    const request = { projectId: identifier(input.projectId), id: identifier(input.id) };
    const { source } = await service.memoryFabricRead({ ...request, limit: 1 });
    const confirmation = await dialog.showMessageBox(window!, {
      type: "warning", buttons: ["Cancel", "Forget memory source"], defaultId: 0, cancelId: 0,
      title: "Forget this memory source?",
      message: `Forget ${confirmationValue(source.title)}?`,
      detail: "This removes this source lineage from Nova's memory archive and invalidates context packets derived from it. A tombstone prevents automatic migration or reimport from restoring the same source. This does not erase original conversations, manually exported project files, provider records, or backups outside the memory archive. Previously sent context cannot be recalled. Review and remove those copies separately if needed.",
    });
    if (confirmation.response !== 1) return null;
    return service.memoryFabricForget(request);
  });
  handle("memory:archive", (value) => service.archiveMemory(identifier(value)));
  handle("verification:save-profile", (payload) =>
    service.saveVerificationProfile(
      objectPayload(payload) as unknown as VerificationProfileInput,
    ),
  );
  handle("verification:delete-profile", (value) =>
    service.deleteVerificationProfile(identifier(value)),
  );
  handle("verification:report", (value) =>
    service.getVerificationReport(identifier(value)),
  );
  handle("verification:cancel", (value) =>
    service.cancelVerification(identifier(value)),
  );
  handle("verification:start", async (payload) => {
    const value = objectPayload(payload);
    const request: VerificationRequest = {
      runId: identifier(value.runId),
      profileId: identifier(value.profileId),
    };
    const report = await service.getVerificationReport(request.runId);
    const profile = report.profiles.find(
      (item) => item.id === request.profileId,
    );
    if (!profile)
      throw new Error("This verification profile is no longer available.");
    if (report.busy)
      throw new Error(
        "Wait for this project's active work to finish before running checks.",
      );
    const folder = await service.getWorktreePath(request.runId);
    const confirmation = await dialog.showMessageBox(window!, {
      type: "warning",
      buttons: ["Cancel", "Run check"],
      defaultId: 0,
      cancelId: 0,
      title: "Run this verification command?",
      message: `Run ${confirmationValue(profile.name)}?`,
      detail:
        `Program: ${confirmationValue(profile.executable)}\nArguments: ${confirmationValue(profile.args)}\nWorktree: ${confirmationValue(folder)}\nTimeout: ${profile.timeoutMinutes} minutes\n\n` +
        "This command runs under your Windows/user account, not inside the agent sandbox. It may edit files, run project scripts, or access the network. Only run commands and repositories you trust. Passing this check is not proof of all task requirements.",
    });
    if (confirmation.response !== 1)
      throw new Error("Verification cancelled before execution.");
    return service.startVerification(request, profile);
  });
  handle("settings:update", (payload) =>
    service.updateSettings(objectPayload(payload) as unknown as Settings),
  );
  handle("project:open", async (value) => {
    const folder = await service.getProjectPath(identifier(value));
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
  });
  handle("run:reveal", async (value) => {
    const folder = await service.getWorktreePath(identifier(value));
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
  });
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    title: "Nova Workbench",
    backgroundColor: "#1b1d1c",
    show: false,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#181a19", symbolColor: "#d9dedb", height: 42 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  window.setMenuBarVisibility(false);
  if (latestState) applyNativeTheme(latestState.settings.theme);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = null;
  });
  await window.loadURL(development ? DEV_ORIGIN : APP_URL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  nativeTheme.on("updated", () => {
    if (latestState) applyNativeTheme(latestState.settings.theme);
  });
  void app
    .whenReady()
    .then(async () => {
      session.defaultSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      if (!development) {
        const rendererRoot = path.resolve(__dirname, "../renderer");
        protocol.handle("nova", async (request) => {
          try {
            const file = assetPath(rendererRoot, request.url);
            const response = await net.fetch(pathToFileURL(file).toString());
            const headers = new Headers(response.headers);
            headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
            headers.set("X-Content-Type-Options", "nosniff");
            return new Response(response.body, {
              status: response.status,
              headers,
            });
          } catch {
            return new Response("Not found", { status: 404 });
          }
        });
      }
      const dataDir = path.join(app.getPath("userData"), "workspace");
      localKeyStore = new LocalKeyStore(dataDir, safeStorage);
      await localKeyStore.load();
      pluginCredentials = new PluginCredentialStore(dataDir, safeStorage);
      await pluginCredentials.load();
      bundleConfigStore = new BundleConfigStore(dataDir, safeStorage);
      await bundleConfigStore.load();
      pluginOAuthStore = new PluginOAuthStore(dataDir, safeStorage);
      await pluginOAuthStore.load();
      try { threadPermissions = new ThreadPermissionStore(dataDir, safeStorage); await threadPermissions.load(); }
      catch (error) { threadPermissions = undefined; threadPermissionError = error instanceof Error ? error.message : "Saved chat permissions could not be read."; }
      workspace = new WorkspaceService(
        dataDir,
        broadcast,
        localKey,
        async (getPermissionContext) => {
          if (process.platform !== "win32") throw new Error("Desktop control is available on Windows only.");
          const binary = app.isPackaged
            ? path.join(process.resourcesPath, "winapp", "winapp.exe")
            : path.join(app.getAppPath(), "node_modules", "@microsoft", "winappcli", "bin", "win-x64", "winapp.exe");
          const info = await lstat(binary);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("The Windows desktop-control component is unavailable. Reinstall this Nova build.");
          const executable = await realpath(binary);
          return new DesktopControlSession(windowsAutomationRunner(executable, path.join(dataDir, "winapp-cache")), async (request) => {
            const started = request.targetIdentity ? await windowsProcessStartTime(request.targetIdentity.processId) : undefined;
            const scope = request.targetIdentity && !started ? undefined : { kind: "desktop", action: request.action, target: request.target ?? null, processStarted: started ?? null, detail: request.detail };
            const approved = await reviewChatPermission(getPermissionContext(), scope, {
              title: "Nova desktop action request", message: request.action,
              detail: `${request.target ? `Window: ${confirmationValue(request.target)}\n\n` : ""}${confirmationValue(request.detail)}\n\nThis request came from the active agent. Approve only after reviewing the window and action.`,
            });
            if (approved && request.targetIdentity && started && await windowsProcessStartTime(request.targetIdentity.processId) !== started) return false;
            return approved;
          }, path.join(dataDir, "desktop-captures"));
        },
        async (request) => {
          return reviewChatPermission(request.permissionContext, request.scope, {
            title: "Nova plugin permission", message: request.title,
            detail: `${request.detail}\n\nApprove only after reviewing the plugin and requested action.`,
          });
        },
        (identity) => pluginCredentials.get(identity),
        {
          has: (identity) => pluginOAuthStore.has(identity),
          token: (identity, endpoint, settings, signal, approve) => pluginOAuthToken({ identity, endpoint, settings, signal, store: pluginOAuthStore, review: (request) => approve({ action: "start", ...request }) }),
        },
        { values: (identity) => bundleConfigStore.get(identity), paths: { HOME: app.getPath("home"), DESKTOP: app.getPath("desktop"), DOCUMENTS: app.getPath("documents"), DOWNLOADS: app.getPath("downloads") } },
      );
      await workspace.initialize();
      registerHandlers(workspace);
      await createWindow();
      app.on("activate", () => {
        if (!window) void createWindow();
      });
    })
    .catch((error: unknown) => {
      dialog.showErrorBox(
        "Nova Workbench could not start",
        error instanceof Error ? error.message : String(error),
      );
      app.exit(1);
    });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (quitting || !workspace) return;
    event.preventDefault();
    quitting = true;
    pluginOAuthController?.abort();
    if (broadcastTimer) clearTimeout(broadcastTimer);
    void (async () => {
      try { await providerAuth?.shutdown(); }
      finally { await workspace!.dispose(); }
    })().catch(() => {
      // Individual services persist cleanup locks. Never print raw provider
      // diagnostics or credentials while the application is exiting.
    }).finally(() => app.quit());
  });
}
