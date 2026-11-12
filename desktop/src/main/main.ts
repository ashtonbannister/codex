import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  nativeTheme,
  protocol,
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
import type { AccountProvider } from "../shared/provider-auth";
import type {
  CommitWorktreeRequest,
  IntegrateWorktreeRequest,
  RecoveryRequest,
} from "../shared/workspace-actions";
import type { SharedMemoryRequest } from "../shared/sharing";
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
// previous worker needs manual recovery. All other IPC participates in the
// account-operation gate, including future workspace/provider handlers.
const PASSIVE_DURING_AUTH = new Set([
  "workspace:snapshot",
  "provider:help",
  "provider:login-state",
  "provider:login-cancel",
  "workspace:recovery",
  "workspace:acknowledge-recovery",
  "run:cancel",
  "verification:cancel",
  "project:open",
  "run:reveal",
]);
const ACCOUNT_OPERATIONS = new Set([
  "provider:account-status",
  "provider:login-start",
]);

async function assertAccountIdle(service: WorkspaceService): Promise<void> {
  const { state } = await service.snapshot();
  if (state.runs.some((run) => run.status === "queued" || run.status === "running") ||
    state.verifications.some((check) => check.status === "running"))
    throw new Error("Finish or stop active agent work and checks before changing or reading provider accounts.");
  if ((await service.listRecoveryItems()).length)
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
      // same gate as login rather than racing a model/history worker.
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

function registerHandlers(service: WorkspaceService) {
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
  handle("provider:local-models", async (payload) =>
    listLocalModels(validateLocalConnection(payload)),
  );
  const connectedProfiles = new Set<string>();
  const approvedHandoffs = new Set<string>();
  let connectionPrompt: Promise<void> | undefined;
  const connectionIdentity = async () => {
    const settings = (await service.snapshot()).state.settings;
    return {
      codexPath: settings.codexPath,
      home: await resolveCodexHome(settings.codexHome),
    };
  };
  const connectionKey = (identity: { codexPath: string; home: string }) =>
    `${identity.codexPath}\0${identity.home}`;
  const confirmConnection = async (): Promise<{
    codexPath: string;
    home: string;
  }> => {
    const identity = await connectionIdentity();
    const key = connectionKey(identity);
    if (connectedProfiles.has(key)) return identity;
    if (connectionPrompt) {
      await connectionPrompt;
      if (
        !connectedProfiles.has(key) ||
        connectionKey(await connectionIdentity()) !== key
      )
        throw new Error("Codex connection changed. Open the library again.");
      return identity;
    }
    connectionPrompt = (async () => {
      const result = await dialog.showMessageBox(window!, {
        type: "question",
        buttons: ["Cancel", "Connect to Codex"],
        defaultId: 0,
        cancelId: 0,
        title: "Connect to your existing Codex installation?",
        message: "Connect to Codex for account status and saved conversations?",
        detail: `Codex home: ${confirmationValue(identity.home)}\nExecutable: ${confirmationValue(identity.codexPath)}\n\nNova starts the installed Codex app-server to read account status and history. Codex manages its own authentication, logs, databases, and migrations; this is not an immutable filesystem scan. Status checks and browsing send no model turn. Nova does not copy credentials or directly edit Codex databases. Conversations and references are only added to Nova when you choose them.`,
      });
      if (result.response !== 1)
        throw new Error(
          "Codex connection cancelled. No app-server was started.",
        );
      if (connectionKey(await connectionIdentity()) !== key)
        throw new Error(
          "Codex settings changed during confirmation. Connect again.",
        );
      connectedProfiles.add(key);
    })();
    try {
      await connectionPrompt;
    } finally {
      connectionPrompt = undefined;
    }
    return identity;
  };
  const accountOptions = async (provider: AccountProvider) => {
    const settings = (await service.snapshot()).state.settings;
    const cwd = path.join(app.getPath("userData"), "workspace");
    return {
      settings,
      home: provider === "codex" ? await resolveCodexHome(settings.codexHome) : cwd,
      // Metadata/login commands never start in the selected project. This is
      // the already-created app-owned workspace data directory, not repo code.
      cwd,
    };
  };
  const accountIdentity = (options: Awaited<ReturnType<typeof accountOptions>>) =>
    JSON.stringify([options.settings.codexPath, options.settings.claudePath, options.home]);
  handle("provider:account-status", async (payload) => {
    const provider = accountProvider(payload);
    if (provider === "codex") await confirmConnection();
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
      title: provider === "codex" ? "Sign in to Codex with ChatGPT?" : "Sign in to Claude Code?",
      message: "Let the installed official tool open its browser sign-in flow?",
      detail: `Executable: ${confirmationValue(executable)}\n${provider === "codex" ? `Codex home: ${confirmationValue(options.home)}\n\nThis changes the account managed by Codex. The OEM Codex app shares the account when it uses this same home. ` : "\nThis changes the account managed by Claude Code. Claude Desktop maintains a separate sign-in session. "}Credentials remain with the official tool; Nova does not read, copy, or exchange tokens. Signing in makes no model request. Finish any Codex or Claude work running outside Nova before continuing.`,
      checkboxLabel: "Other Codex and Claude workers are idle.",
      checkboxChecked: false,
    });
    if (confirmation.response !== 1 || !confirmation.checkboxChecked)
      throw new Error("Sign-in cancelled. The official login process was not started.");
    const current = await accountOptions(provider);
    if (accountIdentity(current) !== before)
      throw new Error("Provider settings changed during confirmation. Review the current installation and sign in again.");
    await assertAccountIdle(service);
    return accounts.start(provider, current);
  });
  handle("codex:installation", async () =>
    inspectCodexInstallation(
      (await service.snapshot()).state.settings.codexHome,
      {
        documents: app.getPath("documents"),
        appData: app.getPath("appData"),
      },
    ),
  );
  handle("storage:choose", async (payload) => {
    if (payload !== "codex-home" && payload !== "worktrees")
      throw new Error("Unknown storage location.");
    const settings = (await service.snapshot()).state.settings;
    const result = await dialog.showOpenDialog(window!, {
      title:
        payload === "codex-home"
          ? "Choose the existing Codex home folder"
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
    const identity = await confirmConnection();
    return service.listCodexThreads(query, identity);
  });
  handle("codex:history", async (payload) => {
    const query = objectPayload(payload) as unknown as CodexHistoryQuery;
    const identity = await confirmConnection();
    return service.readCodexHistory(query, identity);
  });
  handle("codex:refresh-thread", async (payload) => {
    const threadId = identifier(payload);
    const identity = await confirmConnection();
    return service.refreshCodexThread(threadId, identity);
  });
  handle("codex:publish-handoff", async (payload) => {
    const threadId = identifier(payload);
    const identity = await confirmConnection();
    const review = await service.reviewCodexHandoff(threadId, identity);
    const confirmation = await dialog.showMessageBox(window!, {
      type: "question", buttons: ["Cancel", review.unchanged ? "Check existing handoff" : "Share with Codex"],
      defaultId: 0, cancelId: 0,
      title: "Publish this conversation's context to Codex?",
      message: review.unchanged ? "Check the already-published native handoff?" : `Create ${confirmationValue(review.title)} in your installed Codex?`,
      detail: `Codex home: ${confirmationValue(review.home)}\nWorking folder: ${confirmationValue(review.cwd)}\nShared reference: ${review.characters.toLocaleString()} characters\n\nNova uses the official engine to fork an existing Codex conversation or create a new one, then adds bounded visible messages and selected project memories. Codex keeps its own history; Claude/local hidden state, credentials, and binary attachments are not copied. No model turn starts now. Later Codex requests can send this context to OpenAI. Subsequent Codex work in this Nova thread uses the native handoff. The original native conversation remains untouched.\n\n${review.warnings.slice(0, 6).map((warning) => confirmationValue(warning)).join("\n")}`,
    });
    if (confirmation.response !== 1) throw new Error("Codex handoff cancelled before publishing.");
    return service.publishCodexHandoff(threadId, review.fingerprint, identity);
  });
  handle("codex:import-thread", async (payload) => {
    const request = objectPayload(payload) as unknown as CodexImportRequest;
    identifier(request.threadId);
    const identity = await confirmConnection();
    const result = await dialog.showMessageBox(window!, {
      type: "question",
      buttons: ["Cancel", "Open in Nova"],
      defaultId: 0,
      cancelId: 0,
      title: "Add this conversation to Nova?",
      message:
        "Keep a visible-history snapshot and a link to the original Codex conversation?",
      detail:
        "Importing sends no model turn. Codex Plan can continue the original native conversation; isolated Build forks native history into a Nova-owned worktree. Archived originals are forked, never automatically unarchived. Claude and local models use an explicitly bounded visible-history handoff in this Nova thread, not hidden provider state. Original conversation files are not rewritten by the importer.",
    });
    if (result.response !== 1)
      throw new Error("Conversation import cancelled.");
    return service.importCodexThread(request, identity);
  });
  handle("codex:resources", (payload) =>
    service.listCodexResources(
      objectPayload(payload) as unknown as CodexResourceQuery,
    ),
  );
  handle("codex:preview-resource", (payload) =>
    service.previewCodexResource(
      objectPayload(payload) as unknown as CodexResourceRequest,
    ),
  );
  handle("codex:import-memory", async (payload) => {
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
  handle("context:preview", (payload) =>
    service.previewContext(objectPayload(payload) as unknown as RunRequest),
  );
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
    const expectedNativeConnection =
      linked && input.provider === "codex"
        ? await confirmConnection()
        : undefined;
    if (
      linked &&
      (input.provider === "claude" || input.provider === "ollama")
    ) {
      const handoffKey = `${input.threadId}\0${input.provider}`;
      if (!approvedHandoffs.has(handoffKey)) {
        const result = await dialog.showMessageBox(window!, {
          type: "question",
          buttons: ["Cancel", "Continue with selected agent"],
          defaultId: 0,
          cancelId: 0,
          title: "Share this conversation's visible context?",
          message:
            input.provider === "claude"
              ? "Continue this Nova thread with Claude Code?"
              : "Continue this Nova thread with the configured local model?",
          detail:
            "A bounded selection of imported visible messages, Nova turns, and selected project memories will be sent to this provider when you continue. Private reasoning, credentials, native session state, and binary attachments are not transferred. Original Codex history is preserved. The Context inspector shows Nova's reference selection and omissions.",
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
    return service.startRun(input, expectedNativeConnection);
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
      workspace = new WorkspaceService(
        path.join(app.getPath("userData"), "workspace"),
        broadcast,
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
