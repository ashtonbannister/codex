import type {
  CodexHistoryPage,
  CodexHistoryQuery,
  CodexImportRequest,
  CodexInstallation,
  CodexMemoryImportRequest,
  CodexMemorySource,
  CodexResourcePage,
  CodexResourcePreview,
  CodexResourceQuery,
  CodexResourceRequest,
  CodexThreadLink,
  CodexThreadPage,
  CodexThreadQuery,
} from "./compatibility";
import type {
  LocalConnection,
  LocalModelCatalog,
  LocalProtocol,
  LocalProviderKind,
} from "./local-models";
import type {
  CodexRecoveryAcknowledgement,
  CommitWorktreeRequest,
  IntegrateWorktreeRequest,
  RecoveryItem,
  RecoveryRequest,
  WorktreeActionResult,
  WorktreeReview,
} from "./workspace-actions";
import type { ProviderAccountStatus, ProviderLoginStatus } from "./provider-auth";
import type { SharedMemoryPreview, SharedMemoryRequest, SharedMemoryResult } from "./sharing";
import type { CodexHandoffReceipt, CodexHandoffResult } from "./native-handoff";

export type ProviderId = "codex" | "claude" | "ollama";
export const APP_VERSION = "0.5.1";
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
  /** Legacy projects are Git repositories. Folder projects support Plan only. */
  kind?: "git" | "folder";
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
  pinned?: boolean;
  archivedAt?: string;
  codex?: CodexThreadLink;
  codexHandoff?: CodexHandoffReceipt;
  /** Canonical storage base containing worktrees/<thread-id>. Pinned per thread. */
  worktreeStoragePath?: string;
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
  /** User-confirmed recovery, not an assertion that Nova observed OS cleanup. */
  recoveryAcknowledgedAt?: string;
  contextMemoryIds: string[];
  events: RunEvent[];
  usage?: Usage;
  verification: "not-run";
  contextSummary?: {
    characters: number;
    estimatedTokens: number;
    omittedMemoryIds: string[];
    warnings: string[];
  };
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
  /** Optional project-relative source; only its digest is captured automatically. */
  filePath?: string;
  fileSha256?: string;
  codexSource?: CodexMemorySource;
}

export interface Settings {
  codexPath: string;
  claudePath: string;
  localModel: string;
  localProvider?: LocalProviderKind;
  localBaseUrl?: string;
  localProtocol?: LocalProtocol;
  timeoutMinutes: number;
  maxOutputKb: number;
  theme: "dark" | "light" | "system";
  /** Empty uses the installed CLI's normal CODEX_HOME/default. */
  codexHome?: string;
  /** Storage base for NEW Nova worktrees; never relocates existing worktrees. */
  worktreeStoragePath?: string;
}

export interface WorkspaceState {
  schemaVersion: 1;
  projects: Project[];
  threads: Thread[];
  runs: Run[];
  memories: MemoryEntry[];
  settings: Settings;
  /** Explicit per-project permission to include the common Markdown reference. */
  sharedMemoryProjects?: string[];
  /** Global lock retained when an account subprocess could not be confirmed stopped. */
  accountRecovery?: { provider: "codex" | "claude"; home: string; recordedAt: string };
  /** Cleared only after observed account-process cleanup; a crash becomes a recovery lock. */
  accountOperation?: { id: string; provider: "codex" | "claude"; home: string; startedAt: string };
  verificationProfiles: VerificationProfile[];
  verifications: VerificationResult[];
  /** Native history workers whose exit could not be confirmed; no automatic retry. */
  codexRecoveryHomes?: string[];
  codexRecoveryAcknowledgements?: CodexRecoveryAcknowledgement[];
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
  filePath?: string;
}

export interface ThreadUpdate {
  id: string;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
}

export type MemoryFreshness =
  | "current"
  | "changed"
  | "missing"
  | "unlinked"
  | "unavailable";

export interface ContextMemory {
  id: string;
  title: string;
  kind: MemoryKind;
  source: string;
  filePath?: string;
  freshness: MemoryFreshness;
  included: boolean;
  reason?: string;
}

export interface ContextPreview {
  projectId: string;
  threadId?: string;
  prompt: string;
  characters: number;
  /** Approximation only, not the selected model's actual tokenizer or billing. */
  estimatedTokens: number;
  memories: ContextMemory[];
  includedMemoryIds: string[];
  omittedMemoryIds: string[];
  historyRunIds: string[];
  warnings: string[];
}

export interface VerificationProfileInput {
  id?: string;
  projectId: string;
  name: string;
  executable: string;
  args: string[];
  timeoutMinutes: number;
}

export interface VerificationProfile extends VerificationProfileInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface RevisionSnapshot {
  head: string;
  fingerprint: string;
  complete: boolean;
  reason?: string;
}

export type VerificationStatus =
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "error"
  | "interrupted"
  | "stale";

export interface VerificationResult {
  id: string;
  projectId: string;
  threadId: string;
  runId: string;
  profileId: string;
  profileName: string;
  executable: string;
  args: string[];
  cwd: string;
  status: VerificationStatus;
  createdAt: string;
  finishedAt?: string;
  exitCode?: number;
  output: string;
  truncated: boolean;
  error?: string;
  inputRevision?: RevisionSnapshot;
  outputRevision?: RevisionSnapshot;
  terminationUnconfirmed?: boolean;
  recoveryAcknowledgedAt?: string;
}

export interface VerificationRequest {
  runId: string;
  profileId: string;
}

export interface VerificationReport {
  profiles: VerificationProfile[];
  results: VerificationResult[];
  currentRevision?: RevisionSnapshot;
  busy: boolean;
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
  getAccountStatus(provider: "codex" | "claude"): Promise<ProviderAccountStatus>;
  startProviderLogin(provider: "codex" | "claude"): Promise<ProviderLoginStatus>;
  getProviderLogin(): Promise<ProviderLoginStatus | null>;
  cancelProviderLogin(): Promise<void>;
  previewSharedMemory(projectId: string): Promise<SharedMemoryPreview>;
  publishSharedMemory(request: SharedMemoryRequest): Promise<SharedMemoryResult>;
  disableSharedMemory(projectId: string): Promise<void>;
  refreshCodexThread(threadId: string): Promise<Thread>;
  publishCodexHandoff(threadId: string): Promise<CodexHandoffResult>;
  chooseExecutable(provider: "codex" | "claude"): Promise<string | null>;
  openProviderHelp(provider: ProviderId | "lmstudio"): Promise<void>;
  listLocalModels(connection: LocalConnection): Promise<LocalModelCatalog>;
  reviewWorktree(runId: string): Promise<WorktreeReview>;
  commitWorktree(request: CommitWorktreeRequest): Promise<WorktreeActionResult>;
  integrateWorktree(request: IntegrateWorktreeRequest): Promise<WorktreeActionResult>;
  listRecoveryItems(): Promise<RecoveryItem[]>;
  acknowledgeRecovery(request: RecoveryRequest): Promise<void>;
  exportConversation(threadId: string): Promise<{ saved: boolean; path?: string }>;
  inspectCodexInstallation(): Promise<CodexInstallation>;
  chooseStorageDirectory(
    kind: "codex-home" | "worktrees",
  ): Promise<string | null>;
  listCodexThreads(query: CodexThreadQuery): Promise<CodexThreadPage>;
  readCodexHistory(query: CodexHistoryQuery): Promise<CodexHistoryPage>;
  importCodexThread(request: CodexImportRequest): Promise<Thread>;
  listCodexResources(query: CodexResourceQuery): Promise<CodexResourcePage>;
  previewCodexResource(
    request: CodexResourceRequest,
  ): Promise<CodexResourcePreview>;
  importCodexMemory(request: CodexMemoryImportRequest): Promise<MemoryEntry>;
  getSnapshot(): Promise<WorkspaceSnapshot>;
  refreshProviderStatus(): Promise<WorkspaceSnapshot>;
  updateThread(input: ThreadUpdate): Promise<Thread>;
  previewContext(request: RunRequest): Promise<ContextPreview>;
  chooseProject(): Promise<Project | null>;
  startRun(request: RunRequest): Promise<Run>;
  cancelRun(runId: string): Promise<void>;
  getDiff(runId: string): Promise<DiffSnapshot>;
  saveMemory(input: MemoryInput): Promise<MemoryEntry>;
  archiveMemory(memoryId: string): Promise<void>;
  saveVerificationProfile(
    input: VerificationProfileInput,
  ): Promise<VerificationProfile>;
  deleteVerificationProfile(profileId: string): Promise<void>;
  getVerificationReport(runId: string): Promise<VerificationReport>;
  startVerification(request: VerificationRequest): Promise<VerificationResult>;
  cancelVerification(id: string): Promise<void>;
  updateSettings(settings: Settings): Promise<Settings>;
  openProject(projectId: string): Promise<void>;
  revealWorktree(runId: string): Promise<void>;
  onStateChanged(listener: (state: WorkspaceState) => void): () => void;
}

export const DEFAULT_SETTINGS: Settings = {
  codexPath: "codex",
  claudePath: "claude",
  localModel: "",
  localProvider: "ollama",
  localBaseUrl: "http://127.0.0.1:11434/v1",
  localProtocol: "responses",
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
    verificationProfiles: [],
    verifications: [],
  };
}
