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
  updateThread: (input: ThreadUpdate) =>
    ipcRenderer.invoke("thread:update", input),
  previewContext: (request: RunRequest) =>
    ipcRenderer.invoke("context:preview", request),
  chooseProject: () => ipcRenderer.invoke("project:choose"),
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
