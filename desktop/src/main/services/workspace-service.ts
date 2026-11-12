import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  DiffSnapshot,
  MemoryEntry,
  MemoryInput,
  Project,
  ProviderStatus,
  Run,
  RunEvent,
  RunRequest,
  Settings,
  Thread,
  WorkspaceSnapshot,
  WorkspaceState,
} from "../../shared/types";
import { emptyWorkspace } from "../../shared/types";
import { buildRunContext } from "./context";
import {
  createIsolatedWorktree,
  getWorkspaceDiff,
  inspectRepository,
} from "./git";
import {
  assertLocalModelAvailable,
  probeProvider,
  providerArguments,
  resolveExecutable,
  runProvider,
} from "./providers";
import type { NormalizedEvent } from "./provider-events";
import {
  identifier,
  record,
  text,
  validateMemoryInput,
  validateRunRequest,
  validateSettings,
} from "./validation";

const ACTIVE = new Set(["queued", "running"]);
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);

function optionalText(
  value: unknown,
  name: string,
  maximum = 32_768,
): string | undefined {
  return value === undefined ? undefined : text(value, name, maximum, true);
}

/** A broken state file is reported and preserved, never silently replaced by empty state. */
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
    return {
      id: identifier(item.id),
      name: text(item.name, "Project name", 500),
      path: text(item.path, "Project path", 32_768),
      branch: text(item.branch, "Branch", 1_000),
      createdAt: text(item.createdAt, "Date", 80),
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
        text: text(event.text, "Event", 4_194_304, true),
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
      error: optionalText(item.error, "Error", 16_000),
      providerSessionId: optionalText(
        item.providerSessionId,
        "Provider session",
        200,
      ),
      contextMemoryIds: Array.isArray(item.contextMemoryIds)
        ? item.contextMemoryIds.map((id) => identifier(id))
        : [],
      events,
      usage,
      verification: "not-run",
      terminationUnconfirmed: item.terminationUnconfirmed as
        | boolean
        | undefined,
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
    return {
      ...input,
      id: input.id,
      status: item.status as MemoryEntry["status"],
      createdAt: text(item.createdAt, "Date", 80),
      updatedAt: text(item.updatedAt, "Date", 80),
      commit: optionalText(item.commit, "Commit", 80),
    };
  });
  if (new Set(memories.map((memory) => memory.id)).size !== memories.length)
    throw new Error("Duplicate saved memory IDs.");
  return {
    schemaVersion: 1,
    projects,
    threads,
    runs,
    memories,
    settings: validateSettings(state.settings),
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
      }
      this.initialized = true;
      await this.refreshProviders();
      await this.persist();
    });
  }

  private async refreshProviders(): Promise<void> {
    this.providers = await Promise.all(
      (["codex", "claude", "ollama"] as const).map((provider) =>
        probeProvider(provider, this.state.settings, this.dataDir),
      ),
    );
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    this.ready();
    // Provider probes are cached; streaming events do not relaunch the CLIs.
    return {
      state: clone(this.state),
      providers: clone(this.providers),
      appVersion: "0.1.0",
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

  async addProject(inputPath: string): Promise<Project> {
    this.ready();
    return this.exclusive(async () => {
      const repository = await inspectRepository(
        text(inputPath, "Project path", 32_768),
      );
      const existing = this.state.projects.find((project) =>
        process.platform === "win32"
          ? project.path.toLowerCase() === repository.path.toLowerCase()
          : project.path === repository.path,
      );
      if (existing) {
        existing.branch = repository.branch;
        await this.persist();
        return clone(existing);
      }
      const project: Project = {
        id: randomUUID(),
        name: repository.name,
        path: repository.path,
        branch: repository.branch,
        createdAt: now(),
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

  private async validateWorktree(thread: Thread): Promise<string> {
    if (!thread.worktreePath || !thread.branch || !thread.baseCommit)
      throw new Error("Thread has no isolated worktree.");
    const expected = path.join(
      await realpath(this.dataDir),
      "worktrees",
      thread.id,
    );
    const actual = await realpath(thread.worktreePath);
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
    const repository = await inspectRepository(project.path);
    if (repository.path !== project.path)
      throw new Error(
        "The selected repository path changed. Open the project again.",
      );
    return repository.path;
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

  async startRun(value: RunRequest): Promise<Run> {
    this.ready();
    const request = validateRunRequest(value);
    return this.exclusive(async () => {
      this.ready();
      const project = this.getProject(request.projectId);
      if (
        request.mode === "build" &&
        this.state.runs.some(
          (run) => run.projectId === project.id && run.terminationUnconfirmed,
        )
      )
        throw new Error(
          "Build is locked because a previous worker's termination could not be confirmed. Inspect and stop remaining CLI processes first. This milestone has no automatic unlock or cleanup; the recovery flag remains in workspace.json until deliberately cleared after cleanup.",
        );
      const providerStatus = this.providers.find(
        (provider) => provider.id === request.provider,
      );
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
      if (request.provider === "ollama") await assertLocalModelAvailable(model);
      const executable = await resolveExecutable(
        request.provider === "claude"
          ? this.state.settings.claudePath
          : this.state.settings.codexPath,
      );
      const source = await inspectRepository(project.path);
      if (source.path !== project.path)
        throw new Error(
          "The selected repository path changed. Open the project again.",
        );
      project.branch = source.branch;
      if (request.mode === "build" && !thread.worktreePath)
        Object.assign(
          thread,
          await createIsolatedWorktree(project.path, this.dataDir, thread.id),
        );
      const cwd = thread.worktreePath
        ? await this.validateWorktree(thread)
        : project.path;
      this.ready(); // Shutdown may have started during Git / provider preparation.
      const context = buildRunContext(this.state, thread, request.prompt);
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
        branch: thread.branch || project.branch,
        baseCommit: thread.baseCommit || source.head,
        contextMemoryIds: context.memoryIds,
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
          const result = await runProvider({
            command: {
              ...executable,
              args: providerArguments(
                request.provider,
                cwd,
                request.mode,
                model,
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
              run.error = persistenceFailure || result.error;
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
            run.error =
              persistenceFailure ||
              (error instanceof Error ? error.message : "Worker failed.");
            this.addEvent(run, { kind: "error", text: run.error });
            try {
              await this.persist();
            } catch {
              run.error = `${run.error} The latest status could not be saved. Worktree files are preserved.`;
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
    if (event.sessionId) run.providerSessionId = event.sessionId;
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
      const repository = await inspectRepository(project.path);
      const existing = input.id
        ? this.state.memories.find((memory) => memory.id === input.id)
        : undefined;
      if (input.id && (!existing || existing.projectId !== project.id))
        throw new Error("Memory does not belong to this project.");
      const memory: MemoryEntry = {
        ...input,
        id: existing?.id || randomUUID(),
        status: "active",
        createdAt: existing?.createdAt || now(),
        updatedAt: now(),
        commit: repository.head,
      };
      if (existing) Object.assign(existing, memory);
      else this.state.memories.push(memory);
      await this.persist();
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
      memory.status = "archived";
      memory.updatedAt = now();
      await this.persist();
    });
  }

  async updateSettings(value: Settings): Promise<Settings> {
    this.ready();
    const settings = validateSettings(value);
    return this.exclusive(async () => {
      if (this.active.size)
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
    for (const worker of this.active.values()) worker.controller.abort();
    // Drain any in-flight startup before taking the final worker snapshot.
    // startRun checks closing again after asynchronous Git preparation.
    await this.queue;
    for (const worker of this.active.values()) worker.controller.abort();
    await Promise.allSettled(
      [...this.active.values()].map((worker) => worker.done),
    );
    await this.queue;
  }
}
