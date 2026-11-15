import { contextBridge, ipcRenderer } from "electron";
import type {
  MemoryInput,
  RunRequest,
  Settings,
  ThreadUpdate,
  VerificationProfileInput,
  VerificationRequest,
  WorkbenchAPI,
  WorkspaceState,
} from "../shared/types";

const bridge: WorkbenchAPI = {
  listPluginPackages: () => ipcRenderer.invoke("plugins:list"),
  importPluginPackage: () => ipcRenderer.invoke("plugins:import"),
  importPluginBundle: () => ipcRenderer.invoke("plugins:import-bundle"),
  setBundleSetting: (id, field, value) => ipcRenderer.invoke("plugins:bundle-setting", { id, field, value }),
  chooseBundlePath: (id, field) => ipcRenderer.invoke("plugins:bundle-path", { id, field }),
  setPluginPackageEnabled: (id, enabled) => ipcRenderer.invoke("plugins:enabled", { id, enabled }),
  setPluginServerEnabled: (id, name, enabled) => ipcRenderer.invoke("plugins:server", { id, name, enabled }),
  setPluginCredential: (id, name, token) => ipcRenderer.invoke("plugins:credential", { id, name, token }),
  connectPluginOAuth: (id, name) => ipcRenderer.invoke("plugins:oauth-start", { id, name }),
  cancelPluginOAuth: () => ipcRenderer.invoke("plugins:oauth-cancel"),
  disconnectPluginOAuth: (id, name) => ipcRenderer.invoke("plugins:oauth-remove", { id, name }),
  listSkillPackages: () => ipcRenderer.invoke("skills:list"),
  importSkillPackage: () => ipcRenderer.invoke("skills:import"),
  setSkillPackageEnabled: (id, enabled) => ipcRenderer.invoke("skills:enabled", { id, enabled }),
  getAccountStatus: (provider) => ipcRenderer.invoke("provider:account-status", provider),
  startProviderLogin: (provider) => ipcRenderer.invoke("provider:login-start", provider),
  getProviderLogin: () => ipcRenderer.invoke("provider:login-state"),
  cancelProviderLogin: () => ipcRenderer.invoke("provider:login-cancel"),
  previewSharedMemory: (projectId) => ipcRenderer.invoke("memory:shared-preview", projectId),
  publishSharedMemory: (request) => ipcRenderer.invoke("memory:shared-publish", request),
  disableSharedMemory: (projectId) => ipcRenderer.invoke("memory:shared-disable", projectId),
  refreshCodexThread: (threadId) => ipcRenderer.invoke("codex:refresh-thread", threadId),
  publishCodexHandoff: (threadId) => ipcRenderer.invoke("codex:publish-handoff", threadId),
  chooseExecutable: (provider) => ipcRenderer.invoke("provider:choose-executable", provider),
  openProviderHelp: (provider) => ipcRenderer.invoke("provider:help", provider),
  listCodexModels: () => ipcRenderer.invoke("provider:codex-models"),
  listLocalModels: (connection) => ipcRenderer.invoke("provider:local-models", connection),
  setLocalServerKey: (connection, key) => ipcRenderer.invoke("provider:local-key", { connection, key }),
  reviewWorktree: (runId) => ipcRenderer.invoke("worktree:review", runId),
  commitWorktree: (request) => ipcRenderer.invoke("worktree:commit", request),
  integrateWorktree: (request) => ipcRenderer.invoke("worktree:integrate", request),
  listRecoveryItems: () => ipcRenderer.invoke("workspace:recovery"),
  acknowledgeRecovery: (request) => ipcRenderer.invoke("workspace:acknowledge-recovery", request),
  exportConversation: (threadId) => ipcRenderer.invoke("thread:export", threadId),
  inspectCodexInstallation: () => ipcRenderer.invoke("codex:installation"),
  chooseStorageDirectory: (kind) => ipcRenderer.invoke("storage:choose", kind),
  listCodexThreads: (query) => ipcRenderer.invoke("codex:threads", query),
  readCodexHistory: (query) => ipcRenderer.invoke("codex:history", query),
  importCodexThread: (request) =>
    ipcRenderer.invoke("codex:import-thread", request),
  listCodexResources: (query) => ipcRenderer.invoke("codex:resources", query),
  previewCodexResource: (request) =>
    ipcRenderer.invoke("codex:preview-resource", request),
  importCodexMemory: (request) =>
    ipcRenderer.invoke("codex:import-memory", request),
  getSnapshot: () => ipcRenderer.invoke("workspace:snapshot"),
  refreshProviderStatus: () =>
    ipcRenderer.invoke("workspace:refresh-providers"),
  deleteThread: (threadId) => ipcRenderer.invoke("thread:delete", threadId),
  updateThread: (input: ThreadUpdate) =>
    ipcRenderer.invoke("thread:update", input),
  previewContext: (request: RunRequest) =>
    ipcRenderer.invoke("context:preview", request),
  chooseProject: () => ipcRenderer.invoke("project:choose"),
  ensureChatWorkspace: () => ipcRenderer.invoke("project:ensure-chat"),
  startRun: (request: RunRequest) => ipcRenderer.invoke("run:start", request),
  cancelRun: (runId: string) => ipcRenderer.invoke("run:cancel", runId),
  getDiff: (runId: string) => ipcRenderer.invoke("run:diff", runId),
  saveMemory: (input: MemoryInput) => ipcRenderer.invoke("memory:save", input),
  archiveMemory: (memoryId: string) =>
    ipcRenderer.invoke("memory:archive", memoryId),
  saveVerificationProfile: (input: VerificationProfileInput) =>
    ipcRenderer.invoke("verification:save-profile", input),
  deleteVerificationProfile: (profileId: string) =>
    ipcRenderer.invoke("verification:delete-profile", profileId),
  getVerificationReport: (runId: string) =>
    ipcRenderer.invoke("verification:report", runId),
  startVerification: (request: VerificationRequest) =>
    ipcRenderer.invoke("verification:start", request),
  cancelVerification: (id: string) =>
    ipcRenderer.invoke("verification:cancel", id),
  updateSettings: (settings: Settings) =>
    ipcRenderer.invoke("settings:update", settings),
  openProject: (projectId: string) =>
    ipcRenderer.invoke("project:open", projectId),
  revealWorktree: (runId: string) => ipcRenderer.invoke("run:reveal", runId),
  onStateChanged(listener: (state: WorkspaceState) => void) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: WorkspaceState,
    ) => listener(state);
    ipcRenderer.on("workspace:changed", handler);
    return () => ipcRenderer.removeListener("workspace:changed", handler);
  },
};

contextBridge.exposeInMainWorld("workbench", bridge);
