import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  DiffSnapshot,
  ContextPreview,
  MemoryEntry,
  MemoryInput,
  Project,
  ProviderStatus,
  Run,
  RunEvent,
  RunRequest,
  Settings,
  Thread,
  ThreadUpdate,
  RevisionSnapshot,
  VerificationProfile,
  VerificationProfileInput,
  VerificationReport,
  VerificationRequest,
  VerificationResult,
  WorkspaceSnapshot,
  WorkspaceState,
} from "../../shared/types";
import type {
  CodexHistoryPage,
  CodexHistoryQuery,
  CodexImportRequest,
  CodexMemoryImportRequest,
  CodexMemorySource,
  CodexResourcePage,
  CodexResourcePreview,
  CodexResourceQuery,
  CodexResourceRequest,
  CodexThreadLink,
  CodexThreadPage,
  CodexThreadQuery,
  ImportedMessage,
} from "../../shared/compatibility";
import type {
  CommitWorktreeRequest,
  ConversationExport,
  IntegrateWorktreeRequest,
  RecoveryItem,
  RecoveryRequest,
  WorktreeActionResult,
  WorktreeReview,
} from "../../shared/workspace-actions";
import type { SharedMemoryPreview, SharedMemoryRequest, SharedMemoryResult } from "../../shared/sharing";
import type { CodexHandoffReceipt, CodexHandoffResult } from "../../shared/native-handoff";
import { APP_VERSION, emptyWorkspace } from "../../shared/types";
import { buildRunContext } from "./context";
import { captureMemoryFingerprint } from "./memory-source";
import { captureRevisionSnapshot } from "./revision";
import { runVerificationCommand } from "./verification";
import {
  listCodexResources as listInstallationResources,
  previewCodexResource as previewInstallationResource,
  resolveCodexHome,
} from "./codex-installation";
import {
  listCodexThreads as listCopiedThreads,
  readCodexHistory as readCopiedHistory,
} from "./codex-readonly";
import { ensureNovaCodexHome } from "./nova-runtime";
import {
  createIsolatedWorktree,
  getWorkspaceDiff,
  inspectRepository,
  assertOrdinaryGitState,
  commitReviewedWorktree,
  fastForwardReviewedWorktree,
  isGitAncestor,
  sameGitRepository,
  runGit,
  parsePorcelain,
} from "./git";
import {
  assertLocalModelAvailable,
  prepareLocalProvider,
  probeProvider,
  providerArguments,
  resolveExecutable,
  runProvider,
} from "./providers";
import { connectionFromSettings } from "./local-models";
import { applyProjectSharedMemory, previewProjectSharedMemory } from "./workspace-sharing";
import type { NormalizedEvent } from "./provider-events";
import {
  absoluteDirectory,
  identifier,
  record,
  text,
  validateMemoryInput,
  validateRunRequest,
  validateSettings,
  validateThreadUpdate,
  validateVerificationProfileInput,
  validateVerificationRequest,
  validateCodexThreadQuery,
  validateCodexHistoryQuery,
  validateCodexImportRequest,
  validateCodexResourceQuery,
  validateCodexResourceRequest,
  validateCodexMemoryImportRequest,
} from "./validation";

const ACTIVE = new Set(["queued", "running"]);
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const samePath = (left: string, right: string) =>
  process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

function optionalText(
  value: unknown,
  name: string,
  maximum = 32_768,
): string | undefined {
  return value === undefined ? undefined : text(value, name, maximum, true);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error(`${name} must be true or false.`);
  return value as boolean | undefined;
}

/** External tool output is data, not command input: JSON can safely preserve NUL and other text. */
function displayText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum)
    throw new Error(`${name} must be text of at most ${maximum} characters.`);
  return value;
}

function optionalDisplayText(
  value: unknown,
  name: string,
  maximum: number,
): string | undefined {
  return value === undefined ? undefined : displayText(value, name, maximum);
}

function codexMemorySource(value: unknown): CodexMemorySource | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "Codex reference provenance");
  const sha256 = text(input.sha256, "Codex reference fingerprint", 64);
  if (!/^[a-f0-9]{64}$/.test(sha256))
    throw new Error("Invalid Codex reference fingerprint.");
  return {
    ...validateCodexResourceRequest(input),
    home: absoluteDirectory(input.home, "Codex reference home"),
    sha256,
  };
}

function codexThreadLink(value: unknown): CodexThreadLink | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "Codex conversation link");
  if (
    typeof input.sourceArchived !== "boolean" ||
    typeof input.historyTruncated !== "boolean" ||
    !Array.isArray(input.history) ||
    input.history.length > 2_000 ||
    !Array.isArray(input.warnings) ||
    input.warnings.length > 100
  )
    throw new Error("Invalid saved Codex conversation history.");
  let characters = 0;
  const history = input.history.map((entry): ImportedMessage => {
    const message = record(entry, "Imported message");
    if (message.role !== "user" && message.role !== "assistant")
      throw new Error(
        "Imported history must contain visible user or assistant text only.",
      );
    const content = displayText(message.text, "Imported message", 262_144);
    characters += content.length;
    if (characters > 2_000_000)
      throw new Error(
        "Imported conversation exceeds the retained history limit.",
      );
    return {
      id: text(message.id, "Imported message ID", 256),
      turnId: text(message.turnId, "Imported turn ID", 256),
      role: message.role,
      text: content,
    };
  });
  const sourceThreadId = identifier(
    input.sourceThreadId,
    "Codex source thread",
  );
  const forkedThreadId =
    input.forkedThreadId === undefined
      ? undefined
      : identifier(input.forkedThreadId, "Codex fork thread");
  const forkedCwd =
    input.forkedCwd === undefined
      ? undefined
      : absoluteDirectory(input.forkedCwd, "Codex fork directory");
  if (
    Boolean(forkedThreadId) !== Boolean(forkedCwd) ||
    forkedThreadId === sourceThreadId
  )
    throw new Error("Invalid saved Codex fork ownership.");
  return {
    home: absoluteDirectory(input.home, "Codex home"),
    sourceThreadId,
    sourceCwd: text(input.sourceCwd, "Codex source directory", 32_768, true),
    copyOnly: optionalBoolean(input.copyOnly, "Copy-only conversation"),
    importedAt: text(input.importedAt, "Import date", 80),
    sourceArchived: input.sourceArchived,
    forkedThreadId,
    forkedCwd,
    history,
    historyTruncated: input.historyTruncated,
    warnings: input.warnings.map((warning) =>
      displayText(warning, "Import warning", 2_000),
    ),
  };
}

function revision(value: unknown): RevisionSnapshot | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "Source revision");
  if (typeof input.complete !== "boolean")
    throw new Error("Invalid source revision completeness.");
  const head = text(input.head, "Source revision", 64, true);
  const fingerprint = text(input.fingerprint, "Source fingerprint", 64);
  if (
    (head && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) ||
    (input.complete && !head) ||
    !/^[a-f0-9]{64}$/.test(fingerprint)
  )
    throw new Error("Invalid source revision fingerprint.");
  return {
    head,
    fingerprint,
    complete: input.complete,
    reason: optionalDisplayText(input.reason, "Snapshot reason", 4_000),
  };
}

function contextSummary(value: unknown): Run["contextSummary"] {
  if (value === undefined) return undefined;
  const input = record(value, "Context summary");
  if (
    !Number.isInteger(input.characters) ||
    Number(input.characters) < 0 ||
    Number(input.characters) > 2_000_000 ||
    !Number.isInteger(input.estimatedTokens) ||
    Number(input.estimatedTokens) < 0 ||
    Number(input.estimatedTokens) > 2_000_000 ||
    !Array.isArray(input.omittedMemoryIds) ||
    input.omittedMemoryIds.length > 20_000 ||
    !Array.isArray(input.warnings) ||
    input.warnings.length > 100
  )
    throw new Error("Invalid saved context summary.");
  return {
    characters: input.characters as number,
    estimatedTokens: input.estimatedTokens as number,
    omittedMemoryIds: input.omittedMemoryIds.map((id) => identifier(id)),
    warnings: input.warnings.map((warning) =>
      text(warning, "Context warning", 2_000),
    ),
  };
}

/** A broken state file is reported and preserved, never silently replaced by empty state. */
function handoffReceipt(value: unknown): CodexHandoffReceipt | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "Codex handoff receipt");
  const fingerprint = text(input.fingerprint, "Handoff fingerprint", 64);
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || !["pending", "published", "failed"].includes(String(input.state)))
    throw new Error("Invalid saved Codex handoff receipt.");
  return {
    nativeThreadId: identifier(input.nativeThreadId, "Native handoff thread"),
    home: absoluteDirectory(input.home, "Handoff Codex home"),
    cwd: absoluteDirectory(input.cwd, "Handoff working folder"),
    fingerprint,
    createdAt: text(input.createdAt, "Handoff date", 80),
    state: input.state as CodexHandoffReceipt["state"],
  };
}

export function validateWorkspaceState(value: unknown): WorkspaceState {
  const state = record(value, "Saved workspace");
  if (state.schemaVersion !== 1)
    throw new Error(
      "Unsupported workspace version. Keep the original data and use a compatible app version.",
    );
  for (const key of ["projects", "threads", "runs", "memories"]) {
    if (!Array.isArray(state[key]) || (state[key] as unknown[]).length > 20_000)
      throw new Error(`Invalid saved ${key}.`);
  }
  const projects = (state.projects as unknown[]).map((entry): Project => {
    const item = record(entry);
    if (
      item.kind !== undefined &&
      item.kind !== "git" &&
      item.kind !== "folder"
    )
      throw new Error("Invalid saved project kind.");
    return {
      id: identifier(item.id),
      name: text(item.name, "Project name", 500),
      path: text(item.path, "Project path", 32_768),
      branch: text(item.branch, "Branch", 1_000, item.kind === "folder"),
      createdAt: text(item.createdAt, "Date", 80),
      kind: item.kind as Project["kind"],
    };
  });
  const projectsById = new Map(
    projects.map((project) => [project.id, project]),
  );
  if (projectsById.size !== projects.length)
    throw new Error("Duplicate saved project IDs.");
  const threads = (state.threads as unknown[]).map((entry): Thread => {
    const item = record(entry);
    const projectId = identifier(item.projectId);
    if (!projectsById.has(projectId))
      throw new Error("A saved thread has no project.");
    return {
      id: identifier(item.id),
      projectId,
      title: text(item.title, "Thread title", 160),
      createdAt: text(item.createdAt, "Date", 80),
      updatedAt: text(item.updatedAt, "Date", 80),
      worktreePath: optionalText(item.worktreePath, "Worktree"),
      branch: optionalText(item.branch, "Branch", 1_000),
      baseCommit: optionalText(item.baseCommit, "Commit", 80),
      pinned: optionalBoolean(item.pinned, "Thread pin"),
      archivedAt: optionalText(item.archivedAt, "Archive date", 80),
      codex: codexThreadLink(item.codex),
      codexHandoff: handoffReceipt(item.codexHandoff),
      worktreeStoragePath:
        item.worktreeStoragePath === undefined
          ? undefined
          : absoluteDirectory(item.worktreeStoragePath, "Worktree storage"),
    };
  });
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  if (threadsById.size !== threads.length)
    throw new Error("Duplicate saved thread IDs.");
  const runs = (state.runs as unknown[]).map((entry): Run => {
    const item = record(entry);
    const request = validateRunRequest(item);
    if (
      !request.threadId ||
      threadsById.get(request.threadId)?.projectId !== request.projectId
    )
      throw new Error("A saved run has an invalid thread.");
    if (
      ![
        "queued",
        "running",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ].includes(String(item.status))
    )
      throw new Error("Invalid saved run status.");
    if (!Array.isArray(item.events) || item.events.length > 5_000)
      throw new Error("Invalid saved run events.");
    const events = item.events.map((entry): RunEvent => {
      const event = record(entry);
      if (
        !["message", "tool", "status", "error", "usage"].includes(
          String(event.kind),
        )
      )
        throw new Error("Invalid saved event kind.");
      return {
        id: identifier(event.id),
        at: text(event.at, "Date", 80),
        kind: event.kind as RunEvent["kind"],
        text: displayText(event.text, "Event", 4_194_304),
      };
    });
    const usageInput =
      item.usage === undefined ? undefined : record(item.usage);
    if (
      item.terminationUnconfirmed !== undefined &&
      typeof item.terminationUnconfirmed !== "boolean"
    )
      throw new Error("Invalid worker termination state.");
    const usage = usageInput
      ? Object.fromEntries(
          Object.entries(usageInput).filter(
            ([key, count]) =>
              ["inputTokens", "outputTokens", "cachedTokens"].includes(key) &&
              typeof count === "number" &&
              Number.isFinite(count) &&
              count >= 0,
          ),
        )
      : undefined;
    return {
      ...request,
      threadId: request.threadId,
      id: identifier(item.id),
      model: request.model || "",
      status: item.status as Run["status"],
      createdAt: text(item.createdAt, "Date", 80),
      startedAt: optionalText(item.startedAt, "Date", 80),
      finishedAt: optionalText(item.finishedAt, "Date", 80),
      worktreePath: optionalText(item.worktreePath, "Worktree"),
      branch: optionalText(item.branch, "Branch", 1_000),
      baseCommit: optionalText(item.baseCommit, "Commit", 80),
      error: optionalDisplayText(item.error, "Error", 16_000),
      // Older builds did not cap this external display-only metadata at ingestion.
      providerSessionId: optionalDisplayText(
        item.providerSessionId,
        "Provider session",
        4_194_304,
      )?.slice(0, 200),
      contextMemoryIds: Array.isArray(item.contextMemoryIds)
        ? item.contextMemoryIds.map((id) => identifier(id))
        : [],
      contextSummary: contextSummary(item.contextSummary),
      events,
      usage,
      verification: "not-run",
      terminationUnconfirmed: item.terminationUnconfirmed as
        | boolean
        | undefined,
      recoveryAcknowledgedAt: optionalText(item.recoveryAcknowledgedAt, "Recovery acknowledgement", 80),
    };
  });
  if (new Set(runs.map((run) => run.id)).size !== runs.length)
    throw new Error("Duplicate saved run IDs.");
  const memories = (state.memories as unknown[]).map((entry): MemoryEntry => {
    const item = record(entry);
    const input = validateMemoryInput(item);
    if (
      !input.id ||
      !projectsById.has(input.projectId) ||
      !["active", "archived"].includes(String(item.status))
    )
      throw new Error("Invalid saved memory.");
    const fileSha256 = optionalText(
      item.fileSha256,
      "Memory source fingerprint",
      64,
    );
    if (fileSha256 && (!input.filePath || !/^[a-f0-9]{64}$/.test(fileSha256)))
      throw new Error("Invalid memory source fingerprint.");
    const codexSource = codexMemorySource(item.codexSource);
    if (codexSource && input.filePath)
      throw new Error(
        "A memory cannot combine project-file and Codex reference provenance.",
      );
    return {
      ...input,
      id: input.id,
      status: item.status as MemoryEntry["status"],
      createdAt: text(item.createdAt, "Date", 80),
      updatedAt: text(item.updatedAt, "Date", 80),
      commit: optionalText(item.commit, "Commit", 80),
      fileSha256,
      codexSource,
    };
  });
  if (new Set(memories.map((memory) => memory.id)).size !== memories.length)
    throw new Error("Duplicate saved memory IDs.");
  for (const key of ["verificationProfiles", "verifications"]) {
    if (
      state[key] !== undefined &&
      (!Array.isArray(state[key]) || (state[key] as unknown[]).length > 20_000)
    )
      throw new Error(`Invalid saved ${key}.`);
  }
  const verificationProfiles = (
    (state.verificationProfiles || []) as unknown[]
  ).map((entry): VerificationProfile => {
    const item = record(entry);
    const profile = validateVerificationProfileInput(item);
    if (!profile.id || !projectsById.has(profile.projectId))
      throw new Error("Invalid saved verification profile.");
    return {
      ...profile,
      id: profile.id,
      createdAt: text(item.createdAt, "Date", 80),
      updatedAt: text(item.updatedAt, "Date", 80),
    };
  });
  if (
    new Set(verificationProfiles.map((profile) => profile.id)).size !==
    verificationProfiles.length
  )
    throw new Error("Duplicate saved verification profiles.");
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const verifications = ((state.verifications || []) as unknown[]).map(
    (entry): VerificationResult => {
      const item = record(entry);
      const projectId = identifier(item.projectId);
      const runId = identifier(item.runId);
      const threadId = identifier(item.threadId);
      const run = runsById.get(runId);
      if (!run || run.projectId !== projectId || run.threadId !== threadId)
        throw new Error("Invalid saved verification association.");
      const profile = validateVerificationProfileInput({
        ...item,
        name: item.profileName,
        timeoutMinutes: 1,
      });
      if (
        ![
          "running",
          "passed",
          "failed",
          "cancelled",
          "error",
          "interrupted",
          "stale",
        ].includes(String(item.status)) ||
        typeof item.truncated !== "boolean" ||
        typeof item.output !== "string" ||
        item.output.length > 4_194_304 ||
        (item.exitCode !== undefined && !Number.isInteger(item.exitCode))
      )
        throw new Error("Invalid saved verification result.");
      return {
        id: identifier(item.id),
        projectId,
        threadId,
        runId,
        profileId: identifier(item.profileId),
        profileName: profile.name,
        executable: profile.executable,
        args: profile.args,
        cwd: text(item.cwd, "Check working directory", 32_768),
        status: item.status as VerificationResult["status"],
        createdAt: text(item.createdAt, "Date", 80),
        finishedAt: optionalText(item.finishedAt, "Date", 80),
        exitCode: item.exitCode as number | undefined,
        output: item.output,
        truncated: item.truncated,
        error: optionalDisplayText(item.error, "Verification error", 16_000),
        inputRevision: revision(item.inputRevision),
        outputRevision: revision(item.outputRevision),
        terminationUnconfirmed: optionalBoolean(
          item.terminationUnconfirmed,
          "Verification termination",
        ),
        recoveryAcknowledgedAt: optionalText(item.recoveryAcknowledgedAt, "Recovery acknowledgement", 80),
      };
    },
  );
  if (
    new Set(verifications.map((entry) => entry.id)).size !==
    verifications.length
  )
    throw new Error("Duplicate saved verification results.");
  for (const check of verifications) {
    if (
      check.status === "passed" &&
      (check.exitCode !== 0 ||
        !check.inputRevision?.complete ||
        !check.outputRevision?.complete ||
        check.inputRevision.fingerprint !== check.outputRevision.fingerprint ||
        check.inputRevision.head !== check.outputRevision.head)
    ) {
      check.status = "stale";
      check.error =
        "The saved result did not contain matching complete source snapshots and a successful exit code; it is not treated as a pass.";
    }
  }
  if (
    state.codexRecoveryHomes !== undefined &&
    (!Array.isArray(state.codexRecoveryHomes) ||
      state.codexRecoveryHomes.length > 20_000)
  )
    throw new Error("Invalid saved Codex recovery locks.");
  const codexRecoveryHomes =
    state.codexRecoveryHomes === undefined
      ? undefined
      : [
          ...new Set(
            (state.codexRecoveryHomes as unknown[]).map((home) =>
              absoluteDirectory(home, "Codex recovery home"),
            ),
          ),
        ];
  if (state.codexRecoveryAcknowledgements !== undefined &&
      (!Array.isArray(state.codexRecoveryAcknowledgements) || state.codexRecoveryAcknowledgements.length > 20_000))
    throw new Error("Invalid saved Codex recovery acknowledgements.");
  const codexRecoveryAcknowledgements = (state.codexRecoveryAcknowledgements as unknown[] | undefined)?.map((entry) => {
    const item = record(entry, "Codex recovery acknowledgement");
    return {
      home: absoluteDirectory(item.home, "Codex recovery home"),
      acknowledgedAt: text(item.acknowledgedAt, "Recovery acknowledgement", 80),
    };
  });
  if (state.sharedMemoryProjects !== undefined &&
    (!Array.isArray(state.sharedMemoryProjects) || state.sharedMemoryProjects.length > projects.length))
    throw new Error("Invalid shared-memory project selection.");
  const sharedMemoryProjects = (state.sharedMemoryProjects as unknown[] | undefined)?.map((entry) => {
    const id = identifier(entry, "Shared-memory project");
    if (!projectsById.has(id)) throw new Error("Shared memory refers to an unknown project.");
    return id;
  });
  if (sharedMemoryProjects && new Set(sharedMemoryProjects).size !== sharedMemoryProjects.length)
    throw new Error("Duplicate shared-memory project selection.");
  let accountRecovery: WorkspaceState["accountRecovery"];
  let accountOperation: WorkspaceState["accountOperation"];
  if (state.accountOperation !== undefined) {
    const value = record(state.accountOperation, "Provider account operation");
    if (value.provider !== "codex" && value.provider !== "claude")
      throw new Error("Invalid saved account operation provider.");
    accountOperation = { id: identifier(value.id), provider: value.provider,
      home: absoluteDirectory(value.home, "Account operation home"), startedAt: text(value.startedAt, "Account operation date", 80) };
  }
  if (state.accountRecovery !== undefined) {
    const value = record(state.accountRecovery, "Provider account recovery");
    if (value.provider !== "codex" && value.provider !== "claude")
      throw new Error("Invalid saved account provider.");
    accountRecovery = {
      provider: value.provider,
      home: absoluteDirectory(value.home, "Account recovery home"),
      recordedAt: text(value.recordedAt, "Account recovery date", 80),
    };
  }
  return {
    schemaVersion: 1,
    projects,
    threads,
    runs,
    memories,
    settings: validateSettings(state.settings),
    verificationProfiles,
    verifications,
    codexRecoveryHomes,
    codexRecoveryAcknowledgements,
    sharedMemoryProjects,
    accountRecovery,
    accountOperation,
  };
}

export class WorkspaceService {
  private state: WorkspaceState = emptyWorkspace();
  private providers: ProviderStatus[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<
    string,
    { controller: AbortController; done?: Promise<void> }
  >();
  private readonly activeVerifications = new Map<
    string,
    { controller: AbortController; done?: Promise<void> }
  >();
  private readonly compatibilityControllers = new Set<AbortController>();
  private initialized = false;
  private closing = false;
  private readonly statePath: string;

  constructor(
    private readonly dataDir: string,
    private readonly onChange: (state: WorkspaceState) => void,
  ) {
    this.statePath = path.join(dataDir, "workspace.json");
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private ready(): void {
    if (!this.initialized || this.closing)
      throw new Error("Workspace is not ready.");
  }

  private publish(): void {
    try {
      this.onChange(clone(this.state));
    } catch {
      /* A closing renderer must not break durable writes or worker cleanup. */
    }
  }

  private async persist(): Promise<void> {
    const serialized = JSON.stringify(this.state, null, 2);
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024)
      throw new Error(
        "Workspace history exceeds 64 MiB. Back up workspace.json before reducing saved history; automatic deletion is disabled.",
      );
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.statePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    this.publish();
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      if (this.initialized) return;
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      try {
        if ((await stat(this.statePath)).size > 64 * 1024 * 1024)
          throw new Error("Workspace file is too large to load safely.");
        this.state = validateWorkspaceState(
          JSON.parse(await readFile(this.statePath, "utf8")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error(
            "The saved workspace could not be loaded. Its file has been preserved; do not overwrite it.",
            { cause: error },
          );
      }
      for (const run of this.state.runs) {
        if (ACTIVE.has(run.status)) {
          delete run.recoveryAcknowledgedAt;
          if (run.status === "running") run.terminationUnconfirmed = true;
          run.status = "interrupted";
          run.finishedAt = now();
          run.error =
            "The app stopped before this run finished. No work was resumed automatically; its worktree is preserved.";
          run.events.push({
            id: randomUUID(),
            at: now(),
            kind: "status",
            text: run.error,
          });
        }
        if (run.terminationUnconfirmed && !run.recoveryAcknowledgedAt && run.provider === "codex") {
          const home = this.state.threads.find(
            (thread) => thread.id === run.threadId,
          )?.codex?.home;
          if (home) this.markCodexRecovery(home);
        }
      }
      for (const check of this.state.verifications) {
        if (check.status === "running") {
          delete check.recoveryAcknowledgedAt;
          check.status = "interrupted";
          check.finishedAt = now();
          check.terminationUnconfirmed = true;
          check.error =
            "The app stopped during this check. Inspect and stop remaining processes before clearing the recovery flag; no check was resumed automatically.";
        }
      }
      for (const thread of this.state.threads) {
        if (thread.codexHandoff?.state === "pending") {
          this.markCodexRecovery(thread.codexHandoff.home);
          thread.codexHandoff.state = "failed";
        }
      }
      if (this.state.accountOperation) {
        const pending = this.state.accountOperation;
        this.state.accountRecovery ??= { provider: pending.provider, home: pending.home, recordedAt: pending.startedAt };
        delete this.state.accountOperation;
      }
      const runtimeHome = await ensureNovaCodexHome(this.dataDir, this.state.settings.codexHome);
      if (this.state.accountRecovery?.provider === "codex" && !samePath(this.state.accountRecovery.home, runtimeHome)) {
        // Retain the old cleanup warning, but it no longer locks an unrelated Nova runtime.
        this.markCodexRecovery(this.state.accountRecovery.home);
        delete this.state.accountRecovery;
      }
      await this.detachLegacyCodexConversations();
      this.initialized = true;
      await this.refreshProviders(false);
      await this.persist();
    });
  }

  private async refreshProviders(probe = true): Promise<void> {
    if (this.state.accountRecovery) {
      this.providers = (["codex", "claude", "ollama"] as const).map((id) => ({
        id, name: id === "codex" ? "Codex" : id === "claude" ? "Claude Code" : "Local models",
        available: false, detail: "Resolve provider account cleanup in Settings → Recovery, then refresh tool detection.",
      }));
      return;
    }
    // Ollama uses the same Codex executable/capabilities. Share that result
    // instead of launching duplicate metadata processes and cleanup queries.
    const [codex, claude] = await Promise.all(
      (["codex", "claude"] as const).map((provider) =>
        probe
          ? probeProvider(provider, this.state.settings, this.dataDir)
          : resolveExecutable(provider === "codex" ? this.state.settings.codexPath : this.state.settings.claudePath)
            .then(() => ({ id: provider, name: provider === "codex" ? "Codex" : "Claude Code", available: true,
              detail: "Executable found. No process started; compatibility is checked on your first run." } as ProviderStatus))
            .catch(() => ({ id: provider, name: provider === "codex" ? "Codex" : "Claude Code", available: false,
              detail: "Select the installed CLI in Settings." } as ProviderStatus)),
      ),
    );
    const ollama: ProviderStatus = {
      ...codex,
      id: "ollama",
      name: `Local · ${connectionFromSettings(this.state.settings).kind === "lmstudio" ? "LM Studio" : connectionFromSettings(this.state.settings).kind === "custom" ? "Custom" : "Ollama"}`,
    };
    if (codex.available) {
      ollama.available = Boolean(this.state.settings.localModel);
      ollama.detail = this.state.settings.localModel
        ? "Codex bridge ready; the selected local server and exact model are checked before running."
        : "Select an installed model from your local server in Settings. No model is downloaded automatically.";
    }
    this.providers = [codex, claude, ollama];
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    this.ready();
    // Provider probes are cached; streaming events do not relaunch the CLIs.
    return {
      state: clone(this.state),
      providers: clone(this.providers),
      appVersion: APP_VERSION,
      platform: process.platform,
    };
  }

  async refreshProviderStatus(): Promise<WorkspaceSnapshot> {
    this.ready();
    return this.exclusive(async () => {
      this.ready();
      await this.refreshProviders();
      return this.snapshot();
    });
  }

  private markCodexRecovery(home: string): void {
    const homes = (this.state.codexRecoveryHomes ??= []);
    if (!homes.some((entry) => samePath(entry, home))) homes.push(home);
  }

  /** Explicit read-only import operation. It never starts a native engine or takes its locks. */
  private async codexImportOperation<T>(
    action: (options: { home: string }) => Promise<T>,
    expectedConnection?: { home: string; codexPath: string },
  ): Promise<T> {
    this.ready();
    const home = await resolveCodexHome(this.state.settings.codexHome);
    if (expectedConnection && !samePath(expectedConnection.home, home))
      throw new Error("The import source changed. Review and confirm the selected source again.");
    return action({ home });
  }

  /** A copied conversation never adopts the source's recorded working folder. */
  private async copiedConversationProject(threadId: string, title: string): Promise<Project> {
    const base = await realpath(this.dataDir);
    let parent = base;
    for (const component of ["imported-conversations", identifier(threadId)]) {
      const candidate = path.join(parent, component);
      let metadata;
      try { metadata = await lstat(candidate); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(candidate, { mode: 0o700 });
        metadata = await lstat(candidate);
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(await realpath(candidate), candidate))
        throw new Error("Nova's imported-conversation folder was redirected. No original Codex folder was opened.");
      parent = candidate;
    }
    const existing = this.state.projects.find((project) => samePath(project.path, parent));
    if (existing) return existing;
    const project: Project = {
      id: randomUUID(), name: ("Imported · " + title).slice(0, 160),
      path: parent, branch: "", kind: "folder", createdAt: now(),
    };
    this.state.projects.unshift(project);
    return project;
  }

  private async detachLegacyCodexConversations(): Promise<void> {
    for (const thread of this.state.threads) {
      if (!thread.codex || thread.codex.copyOnly) continue;
      const project = await this.copiedConversationProject(thread.id, thread.title);
      thread.projectId = project.id;
      thread.codex.copyOnly = true;
      thread.codex.warnings = [...thread.codex.warnings,
        "This is now an independent Nova copy. Original Codex files and previous working folders were not moved or deleted. Native resume and write-back are disabled.",
      ].slice(-100);
      delete thread.worktreePath;
      delete thread.worktreeStoragePath;
      delete thread.branch;
      delete thread.baseCommit;
      // Preserve old run/check evidence, but never reuse its previous source worktree.
      for (const run of this.state.runs) if (run.threadId === thread.id) run.projectId = project.id;
      for (const check of this.state.verifications) if (check.threadId === thread.id) check.projectId = project.id;
    }
  }

  async listCodexThreads(
    value: CodexThreadQuery,
    expectedConnection?: { home: string; codexPath: string },
  ): Promise<CodexThreadPage> {
    this.ready();
    const query = validateCodexThreadQuery(value);
    return this.exclusive(() =>
      this.codexImportOperation(
        (options) => listCopiedThreads(options.home, query),
        expectedConnection,
      ),
    );
  }

  async readCodexHistory(
    value: CodexHistoryQuery,
    expectedConnection?: { home: string; codexPath: string },
  ): Promise<CodexHistoryPage> {
    this.ready();
    const query = validateCodexHistoryQuery(value);
    return this.exclusive(() =>
      this.codexImportOperation(async (options) => {
        return readCopiedHistory(options.home, query);
      }, expectedConnection),
    );
  }

  async importCodexThread(
    value: CodexImportRequest,
    expectedConnection?: { home: string; codexPath: string },
  ): Promise<Thread> {
    this.ready();
    const request = validateCodexImportRequest(value);
    return this.exclusive(() =>
      this.codexImportOperation(async (options) => {
        const existing = this.state.threads.find(
          (thread) =>
            thread.codex &&
            samePath(thread.codex.home, options.home) &&
            thread.codex.sourceThreadId === request.threadId,
        );
        if (existing) {
          // Archive status is copied as provenance, never changed in Codex.
          if (request.archived && !existing.codex!.sourceArchived) {
            const before = {
              sourceArchived: existing.codex!.sourceArchived,
              updatedAt: existing.updatedAt,
            };
            existing.codex!.sourceArchived = true;
            existing.updatedAt = now();
            try {
              await this.persist();
            } catch (error) {
              existing.codex!.sourceArchived = before.sourceArchived;
              existing.updatedAt = before.updatedAt;
              throw error;
            }
          }
          return clone(existing);
        }
        let page = await readCopiedHistory(options.home, request);
        if (page.thread.id !== request.threadId)
          throw new Error(
            "The native engine returned a different conversation; nothing was imported.",
          );
        if (page.thread.status === "active")
          throw new Error(
            "This Codex conversation is active. Stop its current work before importing it.",
          );
        const summary = page.thread;
        const sourceCwd = text(summary.cwd, "Codex source folder", 32_768, true);
        let history: ImportedMessage[] = [];
        let bytes = 2;
        let truncated = page.truncated;
        const warnings = [...page.warnings];
        // JSON escaping can expand bounded visible text (for example NUL)
        // substantially. Bound the retained representation, not just text.
        for (const message of [...page.messages].reverse()) {
          const size = Buffer.byteLength(JSON.stringify(message)) + 1;
          if (history.length >= 2_000 || bytes + size > 1_048_576) {
            truncated = true;
            continue;
          }
          history.unshift(message);
          bytes += size;
        }
        if (history.length < page.messages.length)
          warnings.push(
            "Some visible messages exceeded the retained transcript budget and were omitted.",
          );
        const cursors = new Set<string>();
        for (let count = 1; page.nextCursor && count < 8; count += 1) {
          if (cursors.has(page.nextCursor))
            throw new Error(
              "Codex history repeated a page cursor; nothing was imported.",
            );
          cursors.add(page.nextCursor);
          this.ready();
          page = await readCopiedHistory(options.home, {
            ...request,
            cursor: page.nextCursor,
          });
          if (
            page.thread.id !== request.threadId ||
            page.thread.cwd !== summary.cwd ||
            page.thread.status === "active"
          )
            throw new Error(
              "The Codex conversation changed while importing. Retry after its current work stops.",
            );
          const known = new Set(
            history.map((message) => `${message.turnId}\0${message.id}`),
          );
          const older = page.messages.filter(
            (message) => !known.has(`${message.turnId}\0${message.id}`),
          );
          const addition = Buffer.byteLength(JSON.stringify(older));
          if (
            history.length + older.length > 2_000 ||
            bytes + addition > 1_048_576
          ) {
            truncated = true;
            warnings.push(
              "Only the bounded recent transcript was retained; older source pages remain in Codex.",
            );
            break;
          }
          history = [...older, ...history];
          bytes += addition;
          truncated ||= page.truncated;
          warnings.push(...page.warnings);
        }
        if (page.nextCursor) {
          truncated = true;
          warnings.push(
            "Import stopped at its bounded page/message budget. Use the source browser to inspect older history.",
          );
        }
        this.ready();
        const link = codexThreadLink({
          copyOnly: true,
          home: options.home,
          sourceThreadId: request.threadId,
          sourceCwd,
          importedAt: now(),
          sourceArchived: Boolean(request.archived || summary.archived),
          history,
          historyTruncated: truncated,
          warnings: [...new Set(warnings)]
            .slice(0, 100)
            .map((warning) => warning.slice(0, 2_000)),
        });
        const previousProjects = [...this.state.projects];
        const localThreadId = randomUUID();
        const project = await this.copiedConversationProject(localThreadId, summary.title);
        const thread: Thread = {
          id: localThreadId,
          projectId: project.id,
          title:
            summary.title
              .replace(/[\u0000-\u001f\u007f]/g, " ")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 160) || "Imported Codex conversation",
          createdAt: summary.createdAt,
          updatedAt: now(),
          codex: link,
        };
        this.state.threads.push(thread);
        try {
          await this.persist();
        } catch (error) {
          this.state.threads = this.state.threads.filter(
            (entry) => entry.id !== thread.id,
          );
          this.state.projects = previousProjects;
          throw error;
        }
        return clone(thread);
      }, expectedConnection),
    );
  }

  async refreshCodexThread(
    threadId: string,
    expectedConnection?: { home: string; codexPath: string },
  ): Promise<Thread> {
    this.ready();
    const id = identifier(threadId, "Thread");
    return this.exclusive(async () => {
      const thread = this.getThread(id);
      const link = thread.codex;
      if (!link) throw new Error("This conversation has no linked native Codex history.");
      this.assertActionsIdle(thread.projectId);
      return this.codexImportOperation(async (options) => {
        if (!samePath(options.home, link.home))
          throw new Error("Select the Codex home linked to this conversation before refreshing its history.");
        const nativeId = link.sourceThreadId;
        // Refresh is an explicit read-only copy of the original source, never a native fork.
        const archived = link.sourceArchived;
        let page = await readCopiedHistory(options.home, { threadId: nativeId, archived });
        const initial = page.thread;
        const validPage = (candidate: CodexHistoryPage) => candidate.thread.id === nativeId &&
          candidate.thread.status !== "active" &&
          candidate.thread.updatedAt === initial.updatedAt;
        if (!validPage(page))
          throw new Error("The linked Codex conversation is active or moved. No retained history was changed.");
        const warnings: string[] = [];
        const history: ImportedMessage[] = [];
        const messageIds = new Set<string>();
        const cursors = new Set<string>();
        let bytes = 2;
        let truncated = false;
        for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
          if (!validPage(page))
            throw new Error("The native conversation changed while refreshing. Retry after its work stops; the previous snapshot was preserved.");
          truncated ||= page.truncated;
          warnings.push(...page.warnings);
          for (const message of [...page.messages].reverse()) {
            const key = `${message.turnId}\0${message.id}`;
            if (messageIds.has(key)) continue;
            const size = Buffer.byteLength(JSON.stringify(message)) + 1;
            if (history.length >= 2_000 || bytes + size > 1_048_576) {
              truncated = true;
              continue;
            }
            history.unshift(message);
            messageIds.add(key);
            bytes += size;
          }
          if (!page.nextCursor) break;
          if (pageIndex === 7 || history.length >= 2_000 || bytes >= 1_048_576) {
            truncated = true;
            break;
          }
          if (cursors.has(page.nextCursor))
            throw new Error("Codex repeated a history cursor. No retained history was changed.");
          cursors.add(page.nextCursor);
          this.ready();
          page = await readCopiedHistory(options.home, { threadId: nativeId, archived, cursor: page.nextCursor });
        }
        if (truncated)
          warnings.push("Refresh retained bounded recent visible history only; inspect older pages in the source library when completeness matters.");
        warnings.push(`Copied visible history from source ${nativeId}. Nova turns and project notes were preserved. No native worker or source writes were used.`);
        const before = { codex: thread.codex, updatedAt: thread.updatedAt };
        thread.codex = codexThreadLink({
          ...link,
          sourceArchived: archived,
          sourceCwd: initial.cwd,
          copyOnly: true,
          importedAt: now(),
          history,
          historyTruncated: truncated,
          warnings: [...new Set(warnings)].slice(0, 100).map((warning) => warning.slice(0, 2_000)),
        });
        thread.updatedAt = now();
        try { await this.persist(); }
        catch (error) { Object.assign(thread, before); throw error; }
        return clone(thread);
      }, expectedConnection);
    });
  }

  async listCodexResources(
    value: CodexResourceQuery,
  ): Promise<CodexResourcePage> {
    this.ready();
    const query = validateCodexResourceQuery(value);
    return listInstallationResources(
      await resolveCodexHome(this.state.settings.codexHome),
      query,
    );
  }

  async reviewCodexHandoff(_threadId: string, _expectedConnection?: { home: string; codexPath: string }): Promise<never> {
    throw new Error("OEM Codex is import-only. Publishing native handoffs is disabled; export a copy instead.");
  }

  async publishCodexHandoff(
    _threadId: string,
    _expectedFingerprint: string,
    _expectedConnection?: { home: string; codexPath: string },
  ): Promise<CodexHandoffResult> {
    throw new Error("OEM Codex is import-only. Publishing native handoffs is disabled; export a copy instead.");
  }

  async previewCodexResource(
    value: CodexResourceRequest,
  ): Promise<CodexResourcePreview> {
    this.ready();
    const request = validateCodexResourceRequest(value);
    return previewInstallationResource(
      await resolveCodexHome(this.state.settings.codexHome),
      request,
    );
  }

  async importCodexMemory(
    value: CodexMemoryImportRequest,
    expectedHome?: string,
  ): Promise<MemoryEntry> {
    this.ready();
    const request = validateCodexMemoryImportRequest(value);
    return this.exclusive(async () => {
      this.ready();
      this.getProject(request.projectId);
      const home = await resolveCodexHome(this.state.settings.codexHome);
      if (expectedHome && !samePath(expectedHome, home))
        throw new Error(
          "The selected Codex home changed after preview. Preview and confirm the reference again.",
        );
      const resource = await previewInstallationResource(home, request);
      if (resource.sha256 !== request.expectedSha256)
        throw new Error(
          "This Codex reference changed after preview. Preview and confirm the new contents before importing.",
        );
      const content = text(
        resource.content.slice(0, 8_000),
        "Codex reference content",
        8_000,
      );
      const existing = this.state.memories.find(
        (memory) =>
          memory.projectId === request.projectId &&
          memory.codexSource &&
          samePath(memory.codexSource.home, home) &&
          memory.codexSource.section === request.section &&
          memory.codexSource.path === request.path,
      );
      const before = existing ? clone(existing) : undefined;
      const memory: MemoryEntry = {
        id: existing?.id || randomUUID(),
        projectId: request.projectId,
        title: resource.title.slice(0, 160),
        content,
        kind: "note",
        status: "active",
        source: `Codex ${request.section}/${request.path.slice(0, 350)}${resource.content.length > 8_000 ? " (first 8000 characters retained; full source fingerprinted)" : ""}`,
        createdAt: existing?.createdAt || now(),
        updatedAt: now(),
        codexSource: {
          home,
          section: request.section,
          path: request.path,
          sha256: resource.sha256,
        },
      };
      this.ready();
      if (existing) Object.assign(existing, memory);
      else this.state.memories.push(memory);
      try {
        await this.persist();
      } catch (error) {
        if (existing && before) Object.assign(existing, before);
        else
          this.state.memories = this.state.memories.filter(
            (entry) => entry.id !== memory.id,
          );
        throw error;
      }
      return clone(memory);
    });
  }

  async addProject(inputPath: string): Promise<Project> {
    this.ready();
    return this.exclusive(async () => {
      const repository = await inspectRepository(
        await this.independentPath(text(inputPath, "Project path", 32_768)),
      );
      const existing = this.state.projects.find((project) =>
        process.platform === "win32"
          ? project.path.toLowerCase() === repository.path.toLowerCase()
          : project.path === repository.path,
      );
      if (existing) {
        existing.branch = repository.branch;
        existing.kind = "git";
        await this.persist();
        return clone(existing);
      }
      const project: Project = {
        id: randomUUID(),
        name: repository.name,
        path: repository.path,
        branch: repository.branch,
        createdAt: now(),
        kind: "git",
      };
      this.state.projects.push(project);
      await this.persist();
      return clone(project);
    });
  }

  private getProject(id: string): Project {
    const project = this.state.projects.find(
      (entry) => entry.id === identifier(id, "Project"),
    );
    if (!project) throw new Error("Project not found.");
    return project;
  }

  private getRun(id: string): Run {
    const run = this.state.runs.find(
      (entry) => entry.id === identifier(id, "Run"),
    );
    if (!run) throw new Error("Run not found.");
    return run;
  }

  private getThread(id: string): Thread {
    const thread = this.state.threads.find(
      (entry) => entry.id === identifier(id, "Thread"),
    );
    if (!thread) throw new Error("Thread not found.");
    return thread;
  }

  private hasTerminationIssue(projectId: string): boolean {
    return (
      this.state.runs.some(
        (run) => run.projectId === projectId && run.terminationUnconfirmed && !run.recoveryAcknowledgedAt,
      ) ||
      this.state.verifications.some(
        (check) =>
          check.projectId === projectId && check.terminationUnconfirmed && !check.recoveryAcknowledgedAt,
      )
    );
  }

  private projectHasCheck(projectId: string): boolean {
    return this.state.verifications.some(
      (check) => check.projectId === projectId && check.status === "running",
    );
  }

  async updateThread(value: ThreadUpdate): Promise<Thread> {
    this.ready();
    const input = validateThreadUpdate(value);
    return this.exclusive(async () => {
      this.ready();
      const thread = this.getThread(input.id);
      if (
        input.archived &&
        (this.state.runs.some(
          (run) => run.threadId === thread.id && ACTIVE.has(run.status),
        ) ||
          this.state.verifications.some(
            (check) =>
              check.threadId === thread.id && check.status === "running",
          ))
      )
        throw new Error(
          "Stop this thread's active agent or verification before archiving it.",
        );
      const before = clone(thread);
      if (input.title !== undefined) thread.title = input.title;
      if (input.pinned !== undefined) thread.pinned = input.pinned;
      if (input.archived !== undefined)
        thread.archivedAt = input.archived ? now() : undefined;
      thread.updatedAt = now();
      try {
        await this.persist();
      } catch (error) {
        Object.assign(thread, before);
        thread.archivedAt = before.archivedAt;
        thread.pinned = before.pinned;
        throw error;
      }
      return clone(thread);
    });
  }

  async previewContext(value: RunRequest): Promise<ContextPreview> {
    this.ready();
    const request = validateRunRequest(value, true);
    const project = clone(this.getProject(request.projectId));
    const thread = request.threadId
      ? clone(this.getThread(request.threadId))
      : undefined;
    if (thread && thread.projectId !== project.id)
      throw new Error("Thread does not belong to this project.");
    const state = clone(this.state);
    const usesOriginalCheckout = !thread?.worktreePath;
    const cwd =
      !usesOriginalCheckout && thread
        ? await this.validateWorktree(thread)
        : await this.originalThreadCwd(project, thread);
    this.ready();
    const preview = await buildRunContext(
      state,
      thread ? clone(thread) : { id: "", projectId: project.id },
      request.prompt,
      // Linked memory paths belong to the checkout, not a native thread's
      // possibly nested execution directory. Keep those two roots separate.
      usesOriginalCheckout ? project.path : cwd,
    );
    if (project.kind === "folder" && request.mode === "build")
      preview.warnings.unshift(
        "This is a folder conversation. Build is disabled until a committed Git project is opened; Plan remains available.",
      );
    if (request.mode === "build" && usesOriginalCheckout)
      preview.warnings.unshift(
        "Provisional Build preview: this inspects the original checkout. The first Build creates a clean isolated worktree and recomputes context; ignored/local-only files and checkout conversions can change which source-linked notes are included.",
      );
    return preview;
  }

  async previewSharedMemory(projectId: string): Promise<SharedMemoryPreview> {
    this.ready();
    return this.exclusive(async () => {
      const project = this.getProject(projectId);
      return previewProjectSharedMemory(
        { ...project, path: await this.getProjectPath(project.id) },
        this.state.memories,
        this.state.sharedMemoryProjects?.includes(project.id) ?? false,
      );
    });
  }

  async publishSharedMemory(value: SharedMemoryRequest): Promise<SharedMemoryResult> {
    this.ready();
    const input = record(value, "Shared-memory publishing");
    const projectId = identifier(input.projectId, "Project");
    const fingerprint = text(input.fingerprint, "Shared-memory preview fingerprint", 64);
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid shared-memory preview fingerprint.");
    return this.exclusive(async () => {
      const project = this.getProject(projectId);
      this.assertActionsIdle(project.id);
      if (this.hasTerminationIssue(project.id))
        throw new Error("Resolve the project's worker cleanup warning before publishing shared memory.");
      const preview = await previewProjectSharedMemory(
        { ...project, path: await this.getProjectPath(project.id) },
        this.state.memories,
        this.state.sharedMemoryProjects?.includes(project.id) ?? false,
      );
      if (preview.fingerprint !== fingerprint)
        throw new Error("Project files or active notes changed after the preview. Preview shared memory again before publishing.");
      const transaction = await applyProjectSharedMemory(preview);
      const before = this.state.sharedMemoryProjects;
      this.state.sharedMemoryProjects = [...new Set([...(before ?? []), project.id])];
      try { await this.persist(); }
      catch (error) {
        this.state.sharedMemoryProjects = before;
        await transaction.rollback();
        throw error;
      }
      return {
        projectId: project.id,
        paths: transaction.paths,
        enabled: true,
        message: "Shared project memory is enabled. Nova reads .nova/MEMORY.md freshly on each run; official Codex and Claude can read it through the preserved project instructions. No provider-private database was modified." +
          (transaction.backupDirectory ? ` Replaced revisions remain recoverable in ${transaction.backupDirectory} (ignored by Git).` : ""),
      };
    });
  }

  async disableSharedMemory(projectId: string): Promise<void> {
    this.ready();
    return this.exclusive(async () => {
      const project = this.getProject(projectId);
      this.assertActionsIdle(project.id);
      const before = this.state.sharedMemoryProjects;
      this.state.sharedMemoryProjects = (before ?? []).filter((id) => id !== project.id);
      try { await this.persist(); }
      catch (error) { this.state.sharedMemoryProjects = before; throw error; }
      // Leave all project files intact. This disables Nova's direct fresh read,
      // not the user's existing native CLI instruction references.
    });
  }

  private async validateWorktree(thread: Thread): Promise<string> {
    if (!thread.worktreePath || !thread.branch || !thread.baseCommit)
      throw new Error("Thread has no isolated worktree.");
    const expected = path.join(
      await this.independentPath(thread.worktreeStoragePath || this.dataDir),
      "worktrees",
      thread.id,
    );
    const actual = await this.independentPath(thread.worktreePath);
    if (actual !== expected)
      throw new Error("Worktree path changed. No agent was started.");
    const repository = await inspectRepository(actual);
    if (repository.path !== actual || repository.branch !== thread.branch)
      throw new Error(
        "The worktree branch changed outside Nova. Start a new thread or restore its branch before continuing.",
      );
    return actual;
  }

  async getProjectPath(id: string): Promise<string> {
    this.ready();
    const project = this.getProject(id);
    const independent = await this.independentPath(project.path);
    if (project.kind === "folder") {
      const actual = independent;
      if (
        !samePath(actual, project.path) ||
        !(await stat(actual)).isDirectory()
      )
        throw new Error(
          "The conversation folder changed. Open or import the intended folder again.",
        );
      return actual;
    }
    const repository = await inspectRepository(independent);
    if (repository.path !== project.path)
      throw new Error(
        "The selected repository path changed. Open the project again.",
      );
    return repository.path;
  }

  /** Validate only the selected operation target, never scan or open an OEM source. */
  private assertIndependentPath(candidate: string): void {
    const roots = [
      path.join(os.homedir(), ".codex"),
      process.env.CODEX_HOME,
      this.state.settings.codexHome,
      ...this.state.threads.map((thread) => thread.codex?.home),
    ].filter((root): root is string => Boolean(root && path.isAbsolute(root)));
    const normalized = path.resolve(candidate);
    const inside = (root: string) => {
      const left = process.platform === "win32" ? root.toLowerCase() : root;
      const right = process.platform === "win32" ? normalized.toLowerCase() : normalized;
      const relative = path.relative(path.resolve(left), right);
      return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    };
    if (roots.some(inside))
      throw new Error("Codex source folders are import-only. Choose a separate project or Nova worktree-storage folder; no engine or project action was started.");
  }

  private async independentPath(input: string, allowMissing = false): Promise<string> {
    const candidate = absoluteDirectory(input, "Nova working folder");
    this.assertIndependentPath(candidate);
    let actual: string;
    try { actual = await realpath(candidate); }
    catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(candidate) === candidate)
        throw error;
      actual = path.join(await this.independentPath(path.dirname(candidate), true), path.basename(candidate));
    }
    this.assertIndependentPath(actual);
    return actual;
  }

  private async originalThreadCwd(
    project: Project,
    _thread?: Thread,
  ): Promise<string> {
    // sourceCwd/forkedCwd are provenance only, never execution targets.
    return this.getProjectPath(project.id);
  }

  async getWorktreePath(runId: string): Promise<string> {
    this.ready();
    const run = this.getRun(runId);
    const thread = this.state.threads.find(
      (entry) => entry.id === run.threadId && entry.projectId === run.projectId,
    );
    if (!thread?.worktreePath)
      throw new Error("This thread does not have an isolated worktree yet.");
    return this.validateWorktree(thread);
  }

  private assertActionsIdle(projectId: string): void {
    this.ready();
    if (this.state.accountRecovery || this.state.accountOperation)
      throw new Error("Resolve provider account cleanup in Settings → Recovery before changing project state.");
    if (this.compatibilityControllers.size || this.projectHasCheck(projectId) ||
        this.state.runs.some((run) => run.projectId === projectId && ACTIVE.has(run.status)))
      throw new Error("Wait for active agents, checks, and Codex history operations to finish before changing Git state or acknowledging recovery.");
  }

  private async worktreeReview(runId: string): Promise<WorktreeReview> {
    const run = this.getRun(runId);
    const thread = this.getThread(run.threadId);
    const project = this.getProject(run.projectId);
    const worktree = await this.validateWorktree(thread);
    const original = await this.getProjectPath(project.id);
    if (!(await sameGitRepository(worktree, original)))
      throw new Error("The managed worktree no longer belongs to the original repository.");
    const [source, target, status] = await Promise.all([
      inspectRepository(worktree), inspectRepository(original),
      runGit(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const changes = parsePorcelain(status);
    let blocked: string | undefined;
    try { this.assertActionsIdle(project.id); }
    catch (error) { blocked = error instanceof Error ? error.message : "The project is busy."; }
    if (this.hasTerminationIssue(project.id)) blocked = "A previous worker needs cleanup acknowledgement in Settings → Recovery.";
    for (const root of [worktree, original]) {
      try { await assertOrdinaryGitState(root); }
      catch (error) { blocked ??= error instanceof Error ? error.message : "Git is not ready for this operation."; }
    }
    const unavailable = { head: "", fingerprint: "", complete: false, reason: blocked };
    const [sourceRevision, targetRevision] = blocked
      ? [unavailable, unavailable]
      : await Promise.all([captureRevisionSnapshot(worktree), captureRevisionSnapshot(original)]);
    if (!sourceRevision.complete || sourceRevision.head !== source.head)
      blocked ??= sourceRevision.reason || "Worktree changed while preparing review. Refresh it before proceeding.";
    let integrationReason = blocked;
    if (!source.clean) integrationReason ??= "Commit all worktree changes before integration.";
    if (!target.clean) integrationReason ??= "The original checkout has local changes. Commit or stash them yourself before integration.";
    if (!targetRevision.complete || targetRevision.head !== target.head)
      integrationReason ??= targetRevision.reason || "The original checkout changed during review. Refresh before proceeding.";
    if (target.branch === "(detached HEAD)") integrationReason ??= "Check out an integration branch in the original repository first.";
    if (source.head === target.head) integrationReason ??= "The original checkout already contains this commit.";
    if (!integrationReason && !(await isGitAncestor(original, target.head, source.head)))
      integrationReason = "Branches have diverged. Integrate manually in Git; Nova only performs fast-forwards.";
    const sensitive = changes.some((change) => change.status === "??" &&
      change.path.split(/[\\/]/).some((part) => /^\.env(?:\.|$)|^(?:credentials|secrets|auth)(?:\.|$)|^id_(?:rsa|ed25519|ecdsa)(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(part)));
    const commitReason = blocked || (source.clean ? "There are no uncommitted changes." : sensitive
      ? "Potential credential files are untracked. Ignore or remove them from the commit scope in Git before committing from Nova." : undefined);
    return {
      runId: run.id, branch: source.branch, head: source.head,
      fingerprint: sourceRevision.fingerprint, changes,
      canCommit: !commitReason, commitReason,
      canIntegrate: !integrationReason, integrationReason,
      targetBranch: target.branch, targetHead: target.head, targetFingerprint: targetRevision.fingerprint,
    };
  }

  async reviewWorktree(runId: string): Promise<WorktreeReview> {
    this.ready();
    return this.exclusive(() => this.worktreeReview(identifier(runId, "Run")));
  }

  async commitWorktree(value: CommitWorktreeRequest): Promise<WorktreeActionResult> {
    const input = record(value, "Commit request");
    const runId = identifier(input.runId, "Run");
    const message = text(input.message, "Commit message", 4_000);
    const expectedHead = text(input.expectedHead, "Reviewed commit", 64);
    const expectedFingerprint = text(input.expectedFingerprint, "Reviewed fingerprint", 64);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedHead) || !/^[a-f0-9]{64}$/.test(expectedFingerprint))
      throw new Error("Refresh the worktree review before committing.");
    return this.exclusive(async () => {
      const run = this.getRun(runId);
      this.assertActionsIdle(run.projectId);
      const review = await this.worktreeReview(runId);
      if (!review.canCommit) throw new Error(review.commitReason || "This worktree cannot be committed.");
      if (review.head !== expectedHead || review.fingerprint !== expectedFingerprint)
        throw new Error("Worktree changed while confirmation was open. Review the updated changes before committing.");
      const thread = this.getThread(run.threadId);
      const worktree = await this.validateWorktree(thread);
      const commit = await commitReviewedWorktree(worktree, { branch: review.branch, head: expectedHead }, message, async () => {
        this.assertActionsIdle(run.projectId);
        const current = await inspectRepository(worktree);
        const snapshot = await captureRevisionSnapshot(worktree);
        if (current.branch !== review.branch || current.head !== expectedHead || !snapshot.complete ||
            snapshot.head !== expectedHead || snapshot.fingerprint !== expectedFingerprint)
          throw new Error("Worktree changed during commit preparation. No branch was advanced; refresh the review.");
      });
      const before = clone(run.events);
      const previousUpdated = thread.updatedAt;
      thread.updatedAt = now();
      this.addEvent(run, { kind: "status", text: `User committed reviewed changes on ${review.branch}: ${commit}. No remote push was performed.` });
      try { await this.persist(); }
      catch (error) {
        run.events = before; thread.updatedAt = previousUpdated;
        throw new Error(`Git commit ${commit} succeeded, but its Nova history entry could not be saved. Refresh before retrying; the commit was preserved.`, { cause: error });
      }
      return { commit, branch: review.branch, message: "Committed reviewed worktree changes. Nothing was pushed or merged." };
    });
  }

  async integrateWorktree(value: IntegrateWorktreeRequest): Promise<WorktreeActionResult> {
    const input = record(value, "Integration request");
    const runId = identifier(input.runId, "Run");
    const expectedHead = text(input.expectedHead, "Reviewed source commit", 64);
    const expectedTargetHead = text(input.expectedTargetHead, "Reviewed target commit", 64);
    const expectedTargetBranch = text(input.expectedTargetBranch, "Reviewed target branch", 1_000);
    const expectedFingerprint = text(input.expectedFingerprint, "Reviewed source fingerprint", 64);
    const expectedTargetFingerprint = text(input.expectedTargetFingerprint, "Reviewed target fingerprint", 64);
    if (![expectedHead, expectedTargetHead].every((sha) => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)) ||
        ![expectedFingerprint, expectedTargetFingerprint].every((sha) => /^[a-f0-9]{64}$/.test(sha)))
      throw new Error("Refresh the worktree review before integrating.");
    return this.exclusive(async () => {
      const run = this.getRun(runId);
      this.assertActionsIdle(run.projectId);
      const review = await this.worktreeReview(runId);
      if (!review.canIntegrate) throw new Error(review.integrationReason || "This branch cannot be fast-forwarded.");
      if (review.head !== expectedHead || review.targetHead !== expectedTargetHead || review.targetBranch !== expectedTargetBranch ||
          review.fingerprint !== expectedFingerprint || review.targetFingerprint !== expectedTargetFingerprint)
        throw new Error("The source or target changed while confirmation was open. Refresh the review before integration.");
      const project = this.getProject(run.projectId);
      const original = await this.getProjectPath(project.id);
      await fastForwardReviewedWorktree(original, expectedHead, this.dataDir);
      const after = await inspectRepository(original);
      if (after.head !== expectedHead || after.branch !== expectedTargetBranch)
        throw new Error("Git finished, but the original checkout changed concurrently. Inspect it before continuing; no rollback or force operation was attempted.");
      const eventsBefore = clone(run.events);
      const oldBranch = project.branch;
      project.branch = after.branch;
      this.addEvent(run, { kind: "status", text: `User fast-forwarded ${after.branch} to ${expectedHead}. Worktree preserved; nothing pushed.` });
      try { await this.persist(); }
      catch (error) {
        run.events = eventsBefore; project.branch = oldBranch;
        throw new Error(`Fast-forward to ${expectedHead} succeeded, but its Nova history entry could not be saved. Refresh before retrying; Git changes were preserved.`, { cause: error });
      }
      return { commit: after.head, branch: after.branch, message: "Original checkout fast-forwarded. The thread worktree is preserved; nothing was pushed." };
    });
  }

  private recoveryItems(): RecoveryItem[] {
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const items: RecoveryItem[] = [];
    if (this.state.accountRecovery) items.push({
      id: "provider-accounts", kind: "accounts",
      label: `${this.state.accountRecovery.provider === "codex" ? "Codex" : "Claude Code"} account worker`,
      detail: "An account subprocess could not be confirmed stopped. Stop its remaining official CLI processes before acknowledging. Credentials are still owned by the provider; this does not sign out or delete an account.",
      token: digest(this.state.accountRecovery),
    });
    for (const project of this.state.projects) {
      const runs = this.state.runs.filter((run) => run.projectId === project.id && run.terminationUnconfirmed && !run.recoveryAcknowledgedAt);
      const checks = this.state.verifications.filter((check) => check.projectId === project.id && check.terminationUnconfirmed && !check.recoveryAcknowledgedAt);
      if (!runs.length && !checks.length) continue;
      items.push({
        id: `project-${project.id}`, kind: "project", label: project.name,
        detail: `${runs.length} agent run(s) and ${checks.length} check(s) have unconfirmed cleanup. Stop their remaining processes before acknowledging. This does not restore or roll back files.`,
        token: digest([project.id, runs.map((run) => [run.id, run.finishedAt]), checks.map((check) => [check.id, check.finishedAt])]),
      });
    }
    for (const home of this.state.codexRecoveryHomes || []) {
      const nativeRuns = this.state.runs.filter((run) => run.provider === "codex" && run.terminationUnconfirmed && !run.recoveryAcknowledgedAt &&
        this.state.threads.some((thread) => thread.id === run.threadId && thread.codex && samePath(thread.codex.home, home)));
      items.push({
        id: `codex-home-${digest(home)}`, kind: "codex-home", label: home,
        detail: "A previous Nova version left an unconfirmed Codex worker. This is a retained cleanup warning, not a lock on import or Nova’s separate runtime. Check that old worker before acknowledging; Nova will not start another worker against this source or kill an OEM process.",
        token: digest([home, this.state.codexRecoveryAcknowledgements?.filter((entry) => samePath(entry.home, home)), nativeRuns.map((run) => [run.id, run.finishedAt])]),
      });
    }
    return items;
  }

  async listRecoveryItems(): Promise<RecoveryItem[]> {
    this.ready();
    return this.exclusive(async () => clone(this.recoveryItems()));
  }

  async recordAccountRecovery(provider: "codex" | "claude", home: string): Promise<void> {
    return this.exclusive(async () => {
      this.ready();
      if (provider !== "codex" && provider !== "claude") throw new Error("Invalid provider account recovery.");
      this.state.accountRecovery = { provider, home: absoluteDirectory(home, "Account recovery home"), recordedAt: now() };
      delete this.state.accountOperation;
      try { await this.persist(); }
      catch (error) { this.publish(); throw error; }
    });
  }

  async beginAccountOperation(provider: "codex" | "claude", home: string): Promise<string> {
    return this.exclusive(async () => {
      this.ready();
      if (provider !== "codex" && provider !== "claude") throw new Error("Invalid account provider.");
      if (this.state.accountOperation || this.recoveryItems().some((item) => item.kind !== "codex-home") || this.active.size || this.activeVerifications.size || this.compatibilityControllers.size)
        throw new Error("Finish active work and resolve recovery before starting an account process.");
      const id = randomUUID();
      this.state.accountOperation = { id, provider, home: absoluteDirectory(home, "Account home"), startedAt: now() };
      try { await this.persist(); }
      catch (error) { delete this.state.accountOperation; throw error; }
      return id;
    });
  }

  async finishAccountOperation(operationId: string): Promise<void> {
    return this.exclusive(async () => {
      this.ready();
      const pending = this.state.accountOperation;
      if (!pending || pending.id !== identifier(operationId) || this.state.accountRecovery)
        throw new Error("Account recovery state changed. Its operation marker was preserved.");
      delete this.state.accountOperation;
      try { await this.persist(); }
      catch (error) { this.state.accountOperation = pending; this.publish(); throw error; }
    });
  }

  async acknowledgeRecovery(value: RecoveryRequest): Promise<void> {
    const input = record(value, "Recovery acknowledgement");
    const id = text(input.id, "Recovery item", 120);
    const token = text(input.token, "Recovery token", 64);
    return this.exclusive(async () => {
      this.ready();
      if (this.active.size || this.activeVerifications.size || this.compatibilityControllers.size)
        throw new Error("Stop all active Nova agents, checks, and history operations before acknowledging cleanup.");
      const item = this.recoveryItems().find((entry) => entry.id === id && entry.token === token);
      if (!item) throw new Error("Recovery state changed. Refresh it and review the current cleanup warning.");
      const previous = clone(this.state);
      const acknowledgedAt = now();
      if (item.kind === "accounts") {
        delete this.state.accountRecovery;
      } else if (item.kind === "project") {
        const projectId = item.id.slice("project-".length);
        for (const run of this.state.runs) {
          if (run.projectId === projectId && run.terminationUnconfirmed && !run.recoveryAcknowledgedAt)
            run.recoveryAcknowledgedAt = acknowledgedAt;
        }
        for (const check of this.state.verifications) {
          if (check.projectId === projectId && check.terminationUnconfirmed && !check.recoveryAcknowledgedAt)
            check.recoveryAcknowledgedAt = acknowledgedAt;
        }
      } else {
        const home = item.label;
        this.state.codexRecoveryHomes = this.state.codexRecoveryHomes?.filter((entry) => !samePath(entry, home));
        this.state.codexRecoveryAcknowledgements = [
          ...(this.state.codexRecoveryAcknowledgements || []).filter((entry) => !samePath(entry.home, home)),
          { home, acknowledgedAt },
        ];
        for (const run of this.state.runs) {
          if (run.provider === "codex" && run.terminationUnconfirmed && !run.recoveryAcknowledgedAt &&
              this.state.threads.some((thread) => thread.id === run.threadId && thread.codex && samePath(thread.codex.home, home)))
            run.recoveryAcknowledgedAt = acknowledgedAt;
        }
      }
      try { await this.persist(); }
      catch (error) { this.state = previous; throw error; }
    });
  }

  async exportConversation(threadId: string): Promise<ConversationExport> {
    this.ready();
    return this.exclusive(async () => {
      const thread = this.getThread(threadId);
      const project = this.getProject(thread.projectId);
      // This is a selected visible transcript, never a raw workspace/config dump.
      const lines = ["# Nova Workbench conversation", "", `Project: ${project.name}`, `Conversation: ${thread.title}`, "",
        "Export contains visible messages and active project memory. Provider credentials, configuration, raw tool logs, hidden reasoning, and native provider state are not added. Common token patterns are redacted, but private details can remain in visible text; review before sharing.", ""];
      if (thread.codex) {
        lines.push("## Imported visible Codex history", "", ...(thread.codex.historyTruncated ? ["The imported history is bounded and may omit older messages.", ""] : []));
        for (const message of thread.codex.history) lines.push(`### ${message.role === "user" ? "You" : "Codex"}`, "", message.text, "");
      }
      for (const run of this.state.runs.filter((entry) => entry.threadId === thread.id)) {
        lines.push("## You", "", run.prompt, "", `## ${run.provider} · ${run.mode} · ${run.status}`, "");
        for (const event of run.events.filter((entry) => entry.kind === "message")) lines.push(event.text, "");
      }
      lines.push("## Active project memory", "", "Notes are user-maintained references, not automatically verified facts.", "");
      for (const memory of this.state.memories.filter((entry) => entry.projectId === project.id && entry.status === "active"))
        lines.push(`### ${memory.title}`, "", `Kind: ${memory.kind}`, "", memory.content, "");
      let content = lines.join("\n");
      if (Buffer.byteLength(content, "utf8") > 8 * 1024 * 1024)
        throw new Error("This visible transcript exceeds the 8 MiB export limit. Export a smaller thread; no partial export was created.");
      content = content
        .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, "[private key redacted]")
        .replace(/\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[token redacted]")
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*/gi, "Bearer [redacted]");
      const name = thread.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").slice(0, 90) || "conversation";
      return { filename: `Nova-${name}.md`, content };
    });
  }

  async startRun(
    value: RunRequest,
    _expectedNativeConnection?: { home: string; codexPath: string },
  ): Promise<Run> {
    this.ready();
    const request = validateRunRequest(value);
    return this.exclusive(async () => {
      this.ready();
      if (this.state.accountRecovery || this.state.accountOperation)
        throw new Error("Resolve provider account cleanup in Settings → Recovery before starting agents.");
      const project = this.getProject(request.projectId);
      if (request.mode === "build" && project.kind === "folder")
        throw new Error(
          "Build requires a committed Git repository. This imported folder supports browsing and Plan only; open a Git project before building.",
        );
      if (request.mode === "build" && this.hasTerminationIssue(project.id))
        throw new Error(
          "Build is locked because a previous worker's termination could not be confirmed. Inspect and stop remaining CLI processes, then acknowledge cleanup in Settings → Recovery.",
        );
      let providerStatus = this.providers.find(
        (provider) => provider.id === request.provider,
      );
      if (providerStatus?.available && !providerStatus.version) {
        // Startup is process-free. Probe required safety flags only on an
        // explicit run (or explicit detection refresh), and cache that result.
        providerStatus = await probeProvider(request.provider, this.state.settings, this.dataDir);
        this.providers = this.providers.map((provider) => provider.id === request.provider ? providerStatus! : provider);
      }
      if (!providerStatus?.available)
        throw new Error(
          providerStatus?.detail ||
            "Provider unavailable. Save Settings to refresh CLI detection.",
        );
      let thread = request.threadId
        ? this.state.threads.find((entry) => entry.id === request.threadId)
        : undefined;
      if (request.threadId && (!thread || thread.projectId !== project.id))
        throw new Error("Thread does not belong to this project.");
      if (thread?.archivedAt)
        throw new Error(
          "Restore this archived thread before starting another run.",
        );
      if (
        this.projectHasCheck(project.id) &&
        (request.mode === "build" ||
          this.state.verifications.some(
            (check) =>
              check.threadId === thread?.id && check.status === "running",
          ))
      )
        throw new Error(
          "A verification is using this worktree. Wait for it to finish before starting this agent.",
        );
      if (
        thread &&
        this.state.runs.some(
          (run) => run.threadId === thread?.id && ACTIVE.has(run.status),
        )
      )
        throw new Error("This thread already has an active run.");
      if (
        request.mode === "build" &&
        this.state.runs.some(
          (run) =>
            run.projectId === project.id &&
            run.mode === "build" &&
            ACTIVE.has(run.status),
        )
      )
        throw new Error(
          "This project already has a build worker. Only one writer per project is allowed in this milestone.",
        );
      const created = !thread;
      thread ??= {
        id: randomUUID(),
        projectId: project.id,
        title: request.prompt.replace(/\s+/g, " ").slice(0, 80),
        createdAt: now(),
        updatedAt: now(),
      };
      const model =
        request.model ||
        (request.provider === "ollama" ? this.state.settings.localModel : "");
      if (request.provider === "ollama") await assertLocalModelAvailable(model, this.state.settings);
      const executable = await resolveExecutable(
        request.provider === "claude"
          ? this.state.settings.claudePath
          : this.state.settings.codexPath,
      );
      const projectPath = await this.getProjectPath(project.id);
      const source =
        project.kind === "folder"
          ? undefined
          : await inspectRepository(projectPath);
      if (source && source.path !== project.path)
        throw new Error(
          "The selected repository path changed. Open the project again.",
        );
      if (source) project.branch = source.branch;
      if (request.mode === "build" && !thread.worktreePath) {
        const storage = await this.independentPath(this.state.settings.worktreeStoragePath || this.dataDir, true);
        await mkdir(storage, { recursive: true, mode: 0o700 });
        const canonicalStorage = await realpath(storage);
        Object.assign(
          thread,
          await createIsolatedWorktree(
            project.path,
            canonicalStorage,
            thread.id,
          ),
          { worktreeStoragePath: canonicalStorage },
        );
      }
      const cwd = thread.worktreePath
        ? await this.validateWorktree(thread)
        : await this.originalThreadCwd(project, thread);
      const workerHome = await ensureNovaCodexHome(this.dataDir, this.state.settings.codexHome);
      this.ready(); // Shutdown may have started during Git / provider preparation.
      const context = await buildRunContext(
        this.state,
        thread,
        request.prompt,
        thread.worktreePath ? cwd : project.path,
      );
      this.ready();
      const run: Run = {
        id: randomUUID(),
        projectId: project.id,
        threadId: thread.id,
        provider: request.provider,
        model,
        mode: request.mode,
        prompt: request.prompt,
        status: "queued",
        createdAt: now(),
        worktreePath: thread.worktreePath,
        branch: thread.branch || project.branch || undefined,
        baseCommit: thread.baseCommit || source?.head,
        contextMemoryIds: context.includedMemoryIds,
        contextSummary: {
          characters: context.characters,
          estimatedTokens: context.estimatedTokens,
          omittedMemoryIds: context.omittedMemoryIds,
          warnings: context.warnings,
        },
        events: [],
        verification: "not-run",
      };
      if (created) this.state.threads.push(thread);
      thread.updatedAt = now();
      this.state.runs.push(run);
      const controller = new AbortController();
      const active: { controller: AbortController; done?: Promise<void> } = {
        controller,
      };
      this.active.set(run.id, active);
      try {
        await this.persist();
      } catch (error) {
        this.active.delete(run.id);
        this.state.runs = this.state.runs.filter(
          (entry) => entry.id !== run.id,
        );
        if (created && !thread.worktreePath)
          this.state.threads = this.state.threads.filter(
            (entry) => entry.id !== thread!.id,
          );
        throw new Error(
          "The run could not be saved, so no worker was started. Any created worktree has been preserved.",
          { cause: error },
        );
      }
      const settings = clone(this.state.settings);
      let persistenceFailure: string | undefined;
      const pendingEvents: NormalizedEvent[] = [];
      let flushQueued = false;
      const receiveEvent = (event: NormalizedEvent) => {
        if (persistenceFailure) return;
        pendingEvents.push(event);
        if (flushQueued) return;
        flushQueued = true;
        void this.exclusive(async () => {
          const batch = pendingEvents.splice(0);
          flushQueued = false;
          for (const item of batch) this.applyProviderEvent(run, item);
          await this.persist();
        }).catch(() => {
          persistenceFailure =
            "Run stopped because its history could not be saved. Any worktree changes were preserved; this latest status may not be on disk.";
          controller.abort();
        });
      };
      // Launch outside the mutation queue so streaming, cancellation and other projects remain responsive.
      active.done = Promise.resolve()
        .then(async () => {
          await this.exclusive(async () => {
            if (this.closing) controller.abort();
            if (controller.signal.aborted) return;
            run.status = "running";
            run.startedAt = now();
            this.addEvent(run, {
              kind: "status",
              text:
                request.mode === "build"
                  ? "Working in an isolated branch. No automatic merge, commit, or verification."
                  : "Planning with read-only tools. No project writes requested.",
            });
            await this.persist();
          });
          if (this.closing) controller.abort();
          const local = request.provider === "ollama"
            ? await prepareLocalProvider(settings, model, controller.signal)
            : undefined;
          let result: Awaited<ReturnType<typeof runProvider>>;
          try {
            result = await runProvider({
                  command: {
                    ...executable,
                    env: {
                      ...executable.env,
                      ...local?.env,
                      CODEX_HOME: workerHome,
                    },
                    args: providerArguments(
                      request.provider,
                      cwd,
                      request.mode,
                      model,
                      {
                        allowNonGit:
                          project.kind === "folder" && request.mode === "plan",
                        localConfigArgs: local?.configArgs,
                      },
                    ),
                  },
                  provider: request.provider,
                  cwd,
                  prompt: context.prompt,
                  signal: controller.signal,
                  timeoutMs: settings.timeoutMinutes * 60_000,
                  maxBytes: settings.maxOutputKb * 1024,
                  onEvent: receiveEvent,
                });
          } finally {
            await local?.dispose();
          }
          await this.exclusive(async () => {
            run.status = persistenceFailure
              ? "failed"
              : result.cancelled
                ? "cancelled"
                : result.error
                  ? "failed"
                  : "completed";
            run.terminationUnconfirmed = result.terminationUnconfirmed;
            run.finishedAt = now();
            if (persistenceFailure || result.error) {
              run.error = (persistenceFailure || result.error)?.slice(
                0,
                16_000,
              );
              this.addEvent(run, { kind: "error", text: run.error! });
            } else
              this.addEvent(run, {
                kind: "status",
                text: result.cancelled
                  ? "Cancelled. Any worktree changes were preserved."
                  : "Agent finished. Verification has not been run by Nova; review the changes.",
              });
            await this.persist();
            this.active.delete(run.id);
          });
        })
        .catch(async (error) => {
          await this.exclusive(async () => {
            run.status = persistenceFailure
              ? "failed"
              : controller.signal.aborted
                ? "cancelled"
                : "failed";
            run.finishedAt = now();
            run.error = (
              persistenceFailure ||
              (error instanceof Error ? error.message : "Worker failed.")
            ).slice(0, 16_000);
            this.addEvent(run, { kind: "error", text: run.error });
            try {
              await this.persist();
            } catch {
              run.error =
                `${run.error} The latest status could not be saved. Worktree files are preserved.`.slice(
                  0,
                  16_000,
                );
              this.publish();
            }
            this.active.delete(run.id);
          });
        });
      return clone(run);
    });
  }

  private addEvent(run: Run, event: Pick<RunEvent, "kind" | "text">): void {
    if (!event.text.trim() || run.events.length >= 4_000) return;
    // Claude sends its final visible text in both assistant and result events.
    if (
      event.kind === "message" &&
      run.events.filter((entry) => entry.kind === "message").at(-1)?.text ===
        event.text
    )
      return;
    run.events.push({
      id: randomUUID(),
      at: now(),
      kind: event.kind,
      text: event.text.slice(0, 262_144),
    });
  }

  private applyProviderEvent(run: Run, event: NormalizedEvent): void {
    if (event.sessionId) run.providerSessionId = event.sessionId.slice(0, 200);
    if (event.usage) run.usage = event.usage;
    for (const item of event.events) this.addEvent(run, item);
  }

  async cancelRun(id: string): Promise<void> {
    this.ready();
    const run = this.getRun(id);
    const active = this.active.get(run.id);
    if (!active) return;
    active.controller.abort();
    await active.done;
  }

  async getDiff(id: string): Promise<DiffSnapshot> {
    this.ready();
    const run = this.getRun(id);
    const thread = this.state.threads.find(
      (entry) => entry.id === run.threadId,
    );
    if (!thread?.worktreePath)
      return {
        branch: run.branch || "",
        changes: [],
        diff: "This run did not create a worktree. Plan mode does not produce an editable patch.",
        truncated: false,
      };
    return getWorkspaceDiff(
      await this.validateWorktree(thread),
      thread.baseCommit!,
      thread.branch!,
    );
  }

  async saveMemory(value: MemoryInput): Promise<MemoryEntry> {
    this.ready();
    const input = validateMemoryInput(value);
    return this.exclusive(async () => {
      const project = this.getProject(input.projectId);
      const projectPath = await this.getProjectPath(project.id);
      const repository =
        project.kind === "folder"
          ? undefined
          : await inspectRepository(projectPath);
      const source = input.filePath
        ? await captureMemoryFingerprint(projectPath, input.filePath)
        : undefined;
      const existing = input.id
        ? this.state.memories.find((memory) => memory.id === input.id)
        : undefined;
      if (input.id && (!existing || existing.projectId !== project.id))
        throw new Error("Memory does not belong to this project.");
      const before = existing ? clone(existing) : undefined;
      const memory: MemoryEntry = {
        ...input,
        id: existing?.id || randomUUID(),
        status: "active",
        createdAt: existing?.createdAt || now(),
        updatedAt: now(),
        commit: repository?.head,
        filePath: source?.filePath,
        fileSha256: source?.fileSha256,
        // Editing an imported reference makes a user note; only reimport can
        // reconfirm external source bytes and retain that provenance.
        codexSource: undefined,
      };
      if (existing) Object.assign(existing, memory);
      else this.state.memories.push(memory);
      try {
        await this.persist();
      } catch (error) {
        if (existing && before) {
          Object.assign(existing, before);
          existing.filePath = before.filePath;
          existing.fileSha256 = before.fileSha256;
          existing.codexSource = before.codexSource;
        } else
          this.state.memories = this.state.memories.filter(
            (entry) => entry.id !== memory.id,
          );
        throw error;
      }
      return clone(memory);
    });
  }

  async archiveMemory(id: string): Promise<void> {
    this.ready();
    return this.exclusive(async () => {
      const memory = this.state.memories.find(
        (entry) => entry.id === identifier(id, "Memory"),
      );
      if (!memory) throw new Error("Memory not found.");
      const before = { status: memory.status, updatedAt: memory.updatedAt };
      memory.status = "archived";
      memory.updatedAt = now();
      try {
        await this.persist();
      } catch (error) {
        Object.assign(memory, before);
        throw error;
      }
    });
  }

  async saveVerificationProfile(
    value: VerificationProfileInput,
  ): Promise<VerificationProfile> {
    this.ready();
    const input = validateVerificationProfileInput(value);
    return this.exclusive(async () => {
      this.ready();
      this.getProject(input.projectId);
      const existing = input.id
        ? this.state.verificationProfiles.find((entry) => entry.id === input.id)
        : undefined;
      if (input.id && (!existing || existing.projectId !== input.projectId))
        throw new Error(
          "Verification profile does not belong to this project.",
        );
      const before = existing ? clone(existing) : undefined;
      const updatedAt = new Date(
        Math.max(
          Date.now(),
          existing ? Date.parse(existing.updatedAt) + 1 || 0 : 0,
        ),
      ).toISOString();
      const profile: VerificationProfile = {
        ...input,
        id: existing?.id || randomUUID(),
        createdAt: existing?.createdAt || now(),
        updatedAt,
      };
      if (existing) Object.assign(existing, profile);
      else this.state.verificationProfiles.push(profile);
      try {
        await this.persist();
      } catch (error) {
        if (existing && before) Object.assign(existing, before);
        else
          this.state.verificationProfiles =
            this.state.verificationProfiles.filter(
              (entry) => entry.id !== profile.id,
            );
        throw error;
      }
      return clone(profile);
    });
  }

  async deleteVerificationProfile(id: string): Promise<void> {
    this.ready();
    const profileId = identifier(id, "Profile");
    return this.exclusive(async () => {
      this.ready();
      const index = this.state.verificationProfiles.findIndex(
        (entry) => entry.id === profileId,
      );
      if (index < 0) throw new Error("Verification profile not found.");
      const [profile] = this.state.verificationProfiles.splice(index, 1);
      try {
        await this.persist();
      } catch (error) {
        this.state.verificationProfiles.splice(index, 0, profile);
        throw error;
      }
      // Historical results keep their exact executable, arguments and profile name.
    });
  }

  async getVerificationReport(runId: string): Promise<VerificationReport> {
    this.ready();
    const run = this.getRun(runId);
    const thread = this.getThread(run.threadId);
    const profiles = clone(
      this.state.verificationProfiles.filter(
        (profile) => profile.projectId === run.projectId,
      ),
    );
    const results = clone(
      this.state.verifications.filter((check) => check.runId === run.id),
    );
    if (!thread.worktreePath) return { profiles, results, busy: false };
    const currentRevision = await captureRevisionSnapshot(
      await this.validateWorktree(thread),
    );
    for (const result of results) {
      if (
        result.status === "passed" &&
        (!currentRevision.complete ||
          !result.outputRevision?.complete ||
          result.outputRevision.fingerprint !== currentRevision.fingerprint ||
          result.outputRevision.head !== currentRevision.head)
      ) {
        result.status = "stale";
        result.error =
          "This command previously passed, but its recorded source snapshot no longer matches a complete snapshot of the current worktree.";
      }
    }
    return {
      profiles,
      results,
      currentRevision,
      busy:
        this.projectHasCheck(run.projectId) ||
        this.state.runs.some(
          (entry) =>
            ACTIVE.has(entry.status) &&
            (entry.threadId === thread.id ||
              (entry.projectId === run.projectId && entry.mode === "build")),
        ),
    };
  }

  async startVerification(
    value: VerificationRequest,
    expectedProfile?: VerificationProfile,
  ): Promise<VerificationResult> {
    this.ready();
    const request = validateVerificationRequest(value);
    return this.exclusive(async () => {
      this.ready();
      if (this.state.accountRecovery || this.state.accountOperation)
        throw new Error("Resolve provider account cleanup in Settings → Recovery before running checks.");
      const run = this.getRun(request.runId);
      const thread = this.getThread(run.threadId);
      if (thread.archivedAt)
        throw new Error(
          "Restore this archived thread before starting verification.",
        );
      if (this.hasTerminationIssue(run.projectId))
        throw new Error(
          "Verification is locked because a previous worker's termination could not be confirmed. Inspect and stop remaining CLI processes, then acknowledge cleanup in Settings → Recovery.",
        );
      if (
        this.projectHasCheck(run.projectId) ||
        this.state.runs.some(
          (entry) =>
            ACTIVE.has(entry.status) &&
            (entry.threadId === thread.id ||
              (entry.projectId === run.projectId && entry.mode === "build")),
        )
      )
        throw new Error(
          "An agent or verification is already using this project. Stop it or wait before checking this worktree.",
        );
      const saved = this.state.verificationProfiles.find(
        (profile) =>
          profile.id === request.profileId &&
          profile.projectId === run.projectId,
      );
      if (!saved)
        throw new Error(
          "Verification profile does not belong to this project.",
        );
      if (
        expectedProfile &&
        (saved.id !== expectedProfile.id ||
          saved.projectId !== expectedProfile.projectId ||
          saved.name !== expectedProfile.name ||
          saved.executable !== expectedProfile.executable ||
          saved.timeoutMinutes !== expectedProfile.timeoutMinutes ||
          saved.updatedAt !== expectedProfile.updatedAt ||
          JSON.stringify(saved.args) !== JSON.stringify(expectedProfile.args))
      )
        throw new Error(
          "The verification profile changed after confirmation. Review and confirm its exact command again.",
        );
      const profile = clone(saved);
      const cwd = await this.validateWorktree(thread);
      const inputRevision = await captureRevisionSnapshot(cwd);
      this.ready();
      const check: VerificationResult = {
        id: randomUUID(),
        projectId: run.projectId,
        threadId: thread.id,
        runId: run.id,
        profileId: profile.id,
        profileName: profile.name,
        executable: profile.executable,
        args: [...profile.args],
        cwd,
        status: "running",
        createdAt: now(),
        output: "",
        truncated: false,
        inputRevision,
      };
      const controller = new AbortController();
      const active: { controller: AbortController; done?: Promise<void> } = {
        controller,
      };
      this.state.verifications.push(check);
      this.activeVerifications.set(check.id, active);
      try {
        await this.persist();
      } catch (error) {
        this.activeVerifications.delete(check.id);
        this.state.verifications = this.state.verifications.filter(
          (entry) => entry.id !== check.id,
        );
        throw new Error(
          "The verification could not be saved, so its command was not started.",
          { cause: error },
        );
      }
      const maxBytes = this.state.settings.maxOutputKb * 1024;
      let pendingOutput = "";
      let flushQueued = false;
      let persistenceFailure: string | undefined;
      const onOutput = (chunk: string) => {
        if (persistenceFailure) return;
        pendingOutput += chunk;
        if (flushQueued) return;
        flushQueued = true;
        void this.exclusive(async () => {
          check.output += pendingOutput;
          pendingOutput = "";
          flushQueued = false;
          await this.persist();
        }).catch(() => {
          persistenceFailure =
            "Verification stopped because its output could not be saved. Worktree files were preserved; the latest status may not be on disk.";
          controller.abort();
        });
      };
      active.done = Promise.resolve()
        .then(async () => {
          if (this.closing) controller.abort();
          const result = await runVerificationCommand({
            profile,
            cwd,
            codexHome: await ensureNovaCodexHome(this.dataDir, this.state.settings.codexHome),
            signal: controller.signal,
            maxBytes,
            onOutput,
          });
          const outputRevision =
            !result.cancelled && !result.terminationUnconfirmed && !this.closing
              ? await captureRevisionSnapshot(cwd)
              : undefined;
          await this.exclusive(async () => {
            check.output = result.output;
            check.truncated = result.truncated;
            check.exitCode = result.exitCode;
            check.outputRevision = outputRevision;
            check.finishedAt = now();
            check.terminationUnconfirmed = result.terminationUnconfirmed;
            check.error = (persistenceFailure || result.error)?.slice(
              0,
              16_000,
            );
            if (persistenceFailure || result.terminationUnconfirmed)
              check.status = "error";
            else if (result.cancelled || controller.signal.aborted)
              check.status = "cancelled";
            else if (
              typeof result.exitCode === "number" &&
              result.exitCode !== 0
            )
              check.status = "failed";
            else if (result.error || result.exitCode !== 0) {
              check.status = "error";
              check.error ||=
                "The verification did not return a successful exit code.";
            } else if (
              !inputRevision.complete ||
              !outputRevision?.complete ||
              inputRevision.fingerprint !== outputRevision.fingerprint ||
              inputRevision.head !== outputRevision.head
            ) {
              check.status = "stale";
              check.error =
                !inputRevision.complete || !outputRevision?.complete
                  ? `Command exited successfully, but a complete source snapshot was unavailable. ${inputRevision.reason || outputRevision?.reason || ""}`.trim()
                  : "Command exited successfully, but source files changed while it ran; the result is not a pass for an unchanged revision.";
            } else check.status = "passed";
            await this.persist();
            this.activeVerifications.delete(check.id);
          });
        })
        .catch(async (error) => {
          await this.exclusive(async () => {
            check.status = persistenceFailure
              ? "error"
              : controller.signal.aborted
                ? "cancelled"
                : "error";
            check.finishedAt = now();
            check.error = (
              persistenceFailure ||
              (error instanceof Error
                ? error.message
                : "Verification failed unexpectedly.")
            ).slice(0, 16_000);
            try {
              await this.persist();
            } catch {
              check.error =
                `${check.error} The latest status could not be saved; worktree files were preserved.`.slice(
                  0,
                  16_000,
                );
              this.publish();
            }
            this.activeVerifications.delete(check.id);
          });
        });
      return clone(check);
    });
  }

  async cancelVerification(id: string): Promise<void> {
    this.ready();
    const checkId = identifier(id, "Verification");
    if (!this.state.verifications.some((check) => check.id === checkId))
      throw new Error("Verification result not found.");
    const active = this.activeVerifications.get(checkId);
    if (!active) return;
    active.controller.abort();
    await active.done;
  }

  async updateSettings(value: Settings): Promise<Settings> {
    this.ready();
    const settings = validateSettings(value);
    return this.exclusive(async () => {
      if (this.active.size || this.activeVerifications.size)
        throw new Error(
          "Wait for active runs to finish before changing worker settings.",
        );
      this.state.settings = settings;
      await this.refreshProviders();
      await this.persist();
      return clone(settings);
    });
  }

  async dispose(): Promise<void> {
    this.closing = true;
    for (const controller of this.compatibilityControllers) controller.abort();
    for (const worker of this.active.values()) worker.controller.abort();
    for (const worker of this.activeVerifications.values())
      worker.controller.abort();
    // Drain any in-flight startup before taking the final worker snapshot.
    // startRun checks closing again after asynchronous Git preparation.
    await this.queue;
    for (const controller of this.compatibilityControllers) controller.abort();
    for (const worker of this.active.values()) worker.controller.abort();
    for (const worker of this.activeVerifications.values())
      worker.controller.abort();
    await Promise.allSettled(
      [...this.active.values(), ...this.activeVerifications.values()].map(
        (worker) => worker.done,
      ),
    );
    await this.queue;
  }
}
