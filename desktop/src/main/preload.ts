import { contextBridge, ipcRenderer } from "electron";
import type {
  MemoryInput,
  RunRequest,
  Settings,
  WorkbenchAPI,
  WorkspaceState,
} from "../shared/types";

const bridge: WorkbenchAPI = {
  getSnapshot: () => ipcRenderer.invoke("workspace:snapshot"),
  refreshProviderStatus: () =>
    ipcRenderer.invoke("workspace:refresh-providers"),
  chooseProject: () => ipcRenderer.invoke("project:choose"),
  startRun: (request: RunRequest) => ipcRenderer.invoke("run:start", request),
  cancelRun: (runId: string) => ipcRenderer.invoke("run:cancel", runId),
  getDiff: (runId: string) => ipcRenderer.invoke("run:diff", runId),
  saveMemory: (input: MemoryInput) => ipcRenderer.invoke("memory:save", input),
  archiveMemory: (memoryId: string) =>
    ipcRenderer.invoke("memory:archive", memoryId),
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
