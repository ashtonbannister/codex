export type ProviderId = "codex" | "claude" | "ollama";
export type RunMode = "plan" | "build";
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type MemoryKind = "decision" | "constraint" | "note";

export interface Project {
  id: string;
  name: string;
  path: string;
  branch: string;
  createdAt: string;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  worktreePath?: string;
  branch?: string;
  baseCommit?: string;
}

export interface RunEvent {
  id: string;
  at: string;
  kind: "message" | "tool" | "status" | "error" | "usage";
  text: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export interface Run {
  id: string;
  projectId: string;
  threadId: string;
  provider: ProviderId;
  model: string;
  mode: RunMode;
  prompt: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  worktreePath?: string;
  branch?: string;
  baseCommit?: string;
  error?: string;
  providerSessionId?: string;
  /** Fail-closed recovery flag when the OS could not confirm worker termination. */
  terminationUnconfirmed?: boolean;
  contextMemoryIds: string[];
  events: RunEvent[];
  usage?: Usage;
  verification: "not-run";
}

export interface MemoryEntry {
  id: string;
  projectId: string;
  title: string;
  content: string;
  kind: MemoryKind;
  source: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  commit?: string;
}

export interface Settings {
  codexPath: string;
  claudePath: string;
  localModel: string;
  timeoutMinutes: number;
  maxOutputKb: number;
  theme: "dark" | "light" | "system";
}

export interface WorkspaceState {
  schemaVersion: 1;
  projects: Project[];
  threads: Thread[];
  runs: Run[];
  memories: MemoryEntry[];
  settings: Settings;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  available: boolean;
  version?: string;
  detail: string;
}

export interface WorkspaceSnapshot {
  state: WorkspaceState;
  providers: ProviderStatus[];
  appVersion: string;
  platform: string;
}

export interface RunRequest {
  projectId: string;
  threadId?: string;
  provider: ProviderId;
  model?: string;
  mode: RunMode;
  prompt: string;
}

export interface MemoryInput {
  id?: string;
  projectId: string;
  title: string;
  content: string;
  kind: MemoryKind;
  source: string;
}

export interface GitChange {
  path: string;
  status: string;
}

export interface DiffSnapshot {
  branch: string;
  changes: GitChange[];
  diff: string;
  truncated: boolean;
}

/** Narrow, validated bridge. The renderer never receives Node, IPC, or credentials. */
export interface WorkbenchAPI {
  getSnapshot(): Promise<WorkspaceSnapshot>;
  refreshProviderStatus(): Promise<WorkspaceSnapshot>;
  chooseProject(): Promise<Project | null>;
  startRun(request: RunRequest): Promise<Run>;
  cancelRun(runId: string): Promise<void>;
  getDiff(runId: string): Promise<DiffSnapshot>;
  saveMemory(input: MemoryInput): Promise<MemoryEntry>;
  archiveMemory(memoryId: string): Promise<void>;
  updateSettings(settings: Settings): Promise<Settings>;
  openProject(projectId: string): Promise<void>;
  revealWorktree(runId: string): Promise<void>;
  onStateChanged(listener: (state: WorkspaceState) => void): () => void;
}

export const DEFAULT_SETTINGS: Settings = {
  codexPath: "codex",
  claudePath: "claude",
  localModel: "",
  timeoutMinutes: 20,
  maxOutputKb: 512,
  theme: "dark",
};

export function emptyWorkspace(): WorkspaceState {
  return {
    schemaVersion: 1,
    projects: [],
    threads: [],
    runs: [],
    memories: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}
