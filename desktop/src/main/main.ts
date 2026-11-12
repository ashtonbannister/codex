import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  MemoryInput,
  RunRequest,
  Settings,
  WorkspaceState,
} from "../shared/types";
import { WorkspaceService } from "./services/workspace-service";
import {
  APP_URL,
  assetPath,
  CONTENT_SECURITY_POLICY,
  DEV_ORIGIN,
  isTrustedRendererUrl,
} from "./security";

app.setName("Nova Workbench");
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "nova",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let window: BrowserWindow | null = null;
let workspace: WorkspaceService | undefined;
let broadcastTimer: NodeJS.Timeout | undefined;
let latestState: WorkspaceState | undefined;
let quitting = false;
const development =
  !app.isPackaged && process.env.NOVA_DEV_SERVER_URL === DEV_ORIGIN;

function broadcast(state: WorkspaceState) {
  latestState = state;
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    if (window && !window.isDestroyed() && latestState) {
      window.webContents.send("workspace:changed", latestState);
    }
  }, 80);
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

function handle(
  name: string,
  callback: (payload: unknown) => Promise<unknown>,
) {
  ipcMain.handle(name, async (event, payload: unknown) => {
    assertSender(event);
    return callback(payload);
  });
}

function registerHandlers(service: WorkspaceService) {
  handle("workspace:snapshot", () => service.snapshot());
  handle("workspace:refresh-providers", () => service.refreshProviderStatus());
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
  handle("memory:save", (payload) =>
    service.saveMemory(objectPayload(payload) as unknown as MemoryInput),
  );
  handle("memory:archive", (value) => service.archiveMemory(identifier(value)));
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
    backgroundColor: "#181a19",
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
    void workspace.dispose().finally(() => app.quit());
  });
}
