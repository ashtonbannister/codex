import type { Page } from "@playwright/test";
import type { LocalConnection } from "../src/shared/local-models";
import type { CommitWorktreeRequest, IntegrateWorktreeRequest, RecoveryRequest } from "../src/shared/workspace-actions";
import type {
  CodexHistoryQuery,
  CodexImportRequest,
  CodexMemoryImportRequest,
  CodexResourceRequest,
  CodexThreadQuery,
  CodexThreadSummary,
} from "../src/shared/compatibility";
import { APP_VERSION, emptyWorkspace } from "../src/shared/types";
import type {
  ContextMemory,
  MemoryInput,
  Run,
  RunRequest,
  ThreadUpdate,
  VerificationProfileInput,
  VerificationRequest,
  VerificationResult,
  WorkbenchAPI,
  WorkspaceState,
} from "../src/shared/types";

export interface FixtureCalls {
  requests: RunRequest[];
  cancellations: string[];
  refreshes: number;
  opens: string[];
  contextRequests: RunRequest[];
  threadUpdates: ThreadUpdate[];
  checks: VerificationRequest[];
  checkCancellations: string[];
  libraryQueries: CodexThreadQuery[];
  historyQueries: CodexHistoryQuery[];
  imports: CodexImportRequest[];
  resourceImports: CodexMemoryImportRequest[];
  resourcePreviews: CodexResourceRequest[];
  directoryPicks: string[];
  executablePicks: string[];
  providerHelp: string[];
  modelQueries: LocalConnection[];
  worktreeReviews: string[];
  worktreeCommits: CommitWorktreeRequest[];
  worktreeIntegrations: IntegrateWorktreeRequest[];
  recoveryAcknowledgements: RecoveryRequest[];
  exports: string[];
}
export interface FixtureControls {
  setRevision: (fingerprint: string) => void;
  appendCheckOutput: (id: string, text: string) => void;
  finishCheck: (id: string, status: "passed" | "failed") => void;
  setResourceDigest: (digest: string) => void;
  setLibraryFailure: (message: string) => void;
  setExportCancelled: (cancelled: boolean) => void;
}

/** Renderer-only contract fixture. It cannot invoke Node, Electron, a CLI, or a model. */
export async function installFakeDesktopBridge(
  page: Page,
  options: {
    available?: boolean;
    complete?: boolean;
    literal?: boolean;
    seed?: boolean;
    planOnly?: boolean;
    extraThreads?: number;
    libraryFailure?: string;
    finishing?: boolean;
  } = {},
) {
  const initial = emptyWorkspace();
  const now = "2026-11-12T00:00:00Z";
  initial.projects.push({
    id: "test-project",
    name: "Fixture repository",
    path: "D:\\Fixtures\\repository",
    branch: "main",
    createdAt: now,
  });
  if (options.seed) {
    initial.threads.push({
      id: "test-thread-1",
      projectId: "test-project",
      title: "Review the fixture change",
      createdAt: now,
      updatedAt: now,
      worktreePath: options.planOnly ? undefined : "D:\\Fixtures\\worktree",
    });
    initial.runs.push({
      id: "test-run-1",
      projectId: "test-project",
      threadId: "test-thread-1",
      provider: "codex",
      model: "Fixture model",
      mode: options.planOnly ? "plan" : "build",
      prompt: "Inspect the test fixture",
      status: "completed",
      createdAt: now,
      verification: "not-run",
      contextMemoryIds: ["memory-current", "memory-unlinked"],
      worktreePath: options.planOnly ? undefined : "D:\\Fixtures\\worktree",
      events: [
        {
          id: "fixture-message",
          at: now,
          kind: "message",
          text: "## Renderer test fixture\n\n**Synthetic output.** No model was invoked.\n\n- Inspect the source revision.\n- Run the named check before integrating.",
        },
      ],
    });
    initial.memories.push(
      {
        id: "memory-current",
        projectId: "test-project",
        title: "Current source decision",
        content: "Preserve this exported interface.",
        kind: "decision",
        source: "Fixture source",
        filePath: "src/current.ts",
        fileSha256: "current",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "memory-changed",
        projectId: "test-project",
        title: "Prior source decision",
        content: "This note needs review.",
        kind: "constraint",
        source: "Fixture old source",
        filePath: "src/changed.ts",
        fileSha256: "changed",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "memory-unlinked",
        projectId: "test-project",
        title: "User preference",
        content: "Keep changes focused.",
        kind: "note",
        source: "User instruction",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    );
    initial.verificationProfiles.push({
      id: "fixture-profile",
      projectId: "test-project",
      name: "Fixture typecheck",
      executable: "npm",
      args: ["run", "typecheck"],
      timeoutMinutes: 10,
      createdAt: now,
      updatedAt: now,
    });
    if (!options.planOnly)
      initial.verifications.push({
        id: "fixture-passed",
        projectId: "test-project",
        threadId: "test-thread-1",
        runId: "test-run-1",
        profileId: "fixture-profile",
        profileName: "Fixture typecheck",
        executable: "npm",
        args: ["run", "typecheck"],
        cwd: "D:\\Fixtures\\worktree",
        status: "passed",
        createdAt: now,
        finishedAt: now,
        exitCode: 0,
        output: "Synthetic test evidence. No actual command ran.",
        truncated: false,
        inputRevision: {
          head: "fixture-head",
          fingerprint: "fixture-current",
          complete: true,
        },
        outputRevision: {
          head: "fixture-head",
          fingerprint: "fixture-current",
          complete: true,
        },
      });
  }
  for (let index = 0; index < (options.extraThreads ?? 0); index++) {
    initial.threads.push({
      id: `extra-thread-${index + 1}`,
      projectId: "test-project",
      title: `Palette test thread ${String(index + 1).padStart(2, "0")}`,
      createdAt: now,
      updatedAt: now,
    });
  }
  await page.addInitScript(
    ({ initialState, config, version }) => {
      const state = initialState;
      const listeners = new Set<(value: WorkspaceState) => void>();
      const calls: FixtureCalls = {
        requests: [],
        cancellations: [],
        refreshes: 0,
        opens: [],
        contextRequests: [],
        threadUpdates: [],
        checks: [],
        checkCancellations: [],
        libraryQueries: [],
        historyQueries: [],
        imports: [],
        resourceImports: [],
        resourcePreviews: [],
        directoryPicks: [],
        executablePicks: [],
        providerHelp: [],
        modelQueries: [],
        worktreeReviews: [],
        worktreeCommits: [],
        worktreeIntegrations: [],
        recoveryAcknowledgements: [],
        exports: [],
      };
      let available = config.available !== false;
      let fingerprint = "fixture-current";
      let resourceDigest = "fixture-resource-v1";
      let libraryFailure = config.libraryFailure ?? "";
      let worktreeCommitted = false;
      let worktreeIntegrated = false;
      let recoveryAcknowledged = false;
      let exportCancelled = false;
      const codexHome = "C:\\Fixtures\\Codex";
      const libraryThreads: CodexThreadSummary[] = [
        {
          id: "fixture-codex-recent",
          title: "Existing Codex conversation",
          cwd: "D:\\Fixtures\\repository",
          modelProvider: "openai",
          source: "Synthetic Codex CLI",
          status: "idle",
          archived: false,
          createdAt: "2026-11-11T00:00:00Z",
          updatedAt: "2026-11-12T00:00:00Z",
        },
        {
          id: "fixture-codex-second",
          title: "Second Codex conversation",
          cwd: "D:\\Fixtures\\repository",
          modelProvider: "openai",
          source: "Synthetic Codex desktop",
          status: "idle",
          archived: false,
          createdAt: "2026-11-11T00:00:00Z",
          updatedAt: "2026-11-12T00:00:00Z",
        },
        {
          id: "fixture-codex-folder",
          title: "Folder notes conversation",
          cwd: "D:\\Fixtures\\notes",
          modelProvider: "openai",
          source: "Synthetic Codex CLI",
          status: "idle",
          archived: false,
          createdAt: "2026-11-11T00:00:00Z",
          updatedAt: "2026-11-12T00:00:00Z",
        },
        {
          id: "fixture-codex-archived",
          title: "Archived Codex conversation",
          cwd: "D:\\Fixtures\\repository",
          modelProvider: "openai",
          source: "Synthetic Codex archive",
          status: "idle",
          archived: true,
          createdAt: "2026-11-11T00:00:00Z",
          updatedAt: "2026-11-12T00:00:00Z",
        },
      ];
      const latestMessages = [
        {
          id: "codex-recent-user",
          turnId: "turn-recent",
          role: "user" as const,
          text: "Recent retained question from Codex.",
        },
        {
          id: "codex-recent-assistant",
          turnId: "turn-recent",
          role: "assistant" as const,
          text: "## Recent retained response\n\nThis is visible fixture history.\n\n<script>window.libraryInjected=true</script>",
        },
      ];
      const revision = () => ({
        head: "fixture-head",
        fingerprint,
        complete: true,
      });
      const publish = () =>
        listeners.forEach((callback) => callback(structuredClone(state)));
      const snapshot = () => ({
        state: structuredClone(state),
        providers: (["codex", "claude", "ollama"] as const).map((id) => ({
          id,
          name:
            id === "codex"
              ? "Codex"
              : id === "claude"
                ? "Claude Code"
                : "Local · Ollama",
          available,
          detail: "Mock runtime for renderer tests",
        })),
        appVersion: `${version}-test`,
        platform: "mock-desktop",
      });
      const bridge: WorkbenchAPI = {
        async chooseExecutable(provider) {
          calls.executablePicks.push(provider);
          return `C:\\Fixture runtimes\\${provider}.exe`;
        },
        async openProviderHelp(provider) { calls.providerHelp.push(provider); },
        async listLocalModels(connection) {
          calls.modelQueries.push(connection);
          return { connection, models: [{ id: "fixture-coder", name: "Fixture coder" }], warnings: ["Synthetic fixture catalog. No server was contacted."] };
        },
        async reviewWorktree(runId) {
          calls.worktreeReviews.push(runId);
          return { runId, branch: "nova/fixture-change", head: worktreeCommitted ? "fixture-commit" : "fixture-head", fingerprint, targetFingerprint: "fixture-target-clean", targetHead: worktreeIntegrated ? "fixture-commit" : "fixture-target", targetBranch: "main", changes: worktreeCommitted ? [] : [{ path: "src/fixture.ts", status: "M" }], canCommit: !worktreeCommitted, commitReason: worktreeCommitted ? "Worktree is clean." : undefined, canIntegrate: worktreeCommitted && !worktreeIntegrated, integrationReason: worktreeIntegrated ? "Already integrated." : !worktreeCommitted ? "Commit reviewed changes before integrating." : undefined };
        },
        async commitWorktree(request) {
          calls.worktreeCommits.push(request);
          if (request.expectedFingerprint !== fingerprint) throw new Error("Worktree changed after review.");
          worktreeCommitted = true;
          fingerprint = "fixture-committed-clean";
          return { commit: "fixture-commit", branch: "nova/fixture-change", message: "Fixture commit complete. No real Git command ran." };
        },
        async integrateWorktree(request) {
          calls.worktreeIntegrations.push(request);
          if (request.expectedFingerprint !== fingerprint || request.expectedTargetFingerprint !== "fixture-target-clean") throw new Error("Checkout changed after review.");
          worktreeIntegrated = true;
          return { commit: "fixture-commit", branch: "main", message: "Fixture fast-forward complete. No checkout was changed." };
        },
        async listRecoveryItems() {
          return config.finishing && !recoveryAcknowledged ? [{ id: "fixture-recovery", kind: "project", label: "Fixture cleanup failure", detail: "Synthetic lock, not a real background process.", token: "fixture-lock-token" }] : [];
        },
        async acknowledgeRecovery(request) { calls.recoveryAcknowledgements.push(request); recoveryAcknowledged = true; },
        async exportConversation(threadId) {
          calls.exports.push(threadId);
          return exportCancelled ? { saved: false } : { saved: true, path: "D:\\Fixtures\\conversation.md" };
        },
        async inspectCodexInstallation() {
          return {
            home: state.settings.codexHome || codexHome,
            exists: true,
            warnings: ["Fixture inventory only; no PC files were read."],
            locations: [
              {
                id: "instructions",
                name: "Instructions",
                path: `${codexHome}\\AGENTS.md`,
                exists: true,
                access: "content",
                detail: "Preview selected resources before import.",
              },
              {
                id: "sessions",
                name: "Conversations",
                path: `${codexHome}\\sessions`,
                exists: true,
                access: "engine-managed",
                detail:
                  "Normal installed Codex engine startup can manage its state; no model call is made for reads.",
              },
              {
                id: "auth",
                name: "Credentials",
                path: `${codexHome}\\auth.json`,
                exists: true,
                access: "excluded",
                detail: "Never read by this library.",
              },
            ],
          };
        },
        async chooseStorageDirectory(kind) {
          calls.directoryPicks.push(kind);
          return kind === "codex-home"
            ? "E:\\Chosen\\Codex"
            : "E:\\Chosen\\Worktrees";
        },
        async listCodexThreads(query) {
          calls.libraryQueries.push(structuredClone(query));
          if (libraryFailure) throw new Error(libraryFailure);
          const found = libraryThreads.filter(
            (thread) =>
              thread.archived === !!query.archived &&
              thread.title
                .toLowerCase()
                .includes((query.search ?? "").toLowerCase()),
          );
          const offset = query.cursor ? 2 : 0;
          return {
            threads: structuredClone(found.slice(offset, offset + 2)),
            nextCursor:
              found.length > offset + 2
                ? "fixture-next-conversations"
                : undefined,
            warnings: [],
          };
        },
        async readCodexHistory(query) {
          calls.historyQueries.push(structuredClone(query));
          const thread = libraryThreads.find(
            (item) => item.id === query.threadId,
          );
          if (!thread) throw new Error("Fixture Codex conversation missing");
          return {
            thread: structuredClone(thread),
            messages: query.cursor
              ? [
                  {
                    id: "codex-older-user",
                    turnId: "turn-older",
                    role: "user",
                    text: "Older question before the retained snapshot.",
                  },
                  {
                    id: "codex-recent-assistant",
                    turnId: "turn-older",
                    role: "assistant",
                    text: "Older visible answer in the preview.",
                  },
                ]
              : structuredClone(latestMessages),
            nextCursor: query.cursor ? undefined : "fixture-older-history",
            truncated: false,
            warnings: [],
          };
        },
        async importCodexThread(request) {
          calls.imports.push(structuredClone(request));
          const source = libraryThreads.find(
            (item) => item.id === request.threadId,
          );
          if (!source) throw new Error("Fixture Codex conversation missing");
          const existing = state.threads.find(
            (item) => item.codex?.sourceThreadId === source.id,
          );
          if (existing) return structuredClone(existing);
          const folder = source.id === "fixture-codex-folder";
          const projectId = folder ? "fixture-folder-project" : "test-project";
          if (folder && !state.projects.some((item) => item.id === projectId))
            state.projects.push({
              id: projectId,
              name: "Fixture notes folder",
              path: source.cwd,
              branch: "",
              kind: "folder",
              createdAt: "2026-11-12T00:00:00Z",
            });
          const thread = {
            id: `imported-${source.id}`,
            projectId,
            title: source.title,
            createdAt: "2026-11-12T00:00:00Z",
            updatedAt: "2026-11-12T00:00:00Z",
            codex: {
              home: state.settings.codexHome || codexHome,
              sourceThreadId: source.id,
              sourceCwd: source.cwd,
              sourceArchived: source.archived,
              importedAt: "2026-11-12T00:00:00Z",
              history: structuredClone(latestMessages),
              historyTruncated: true,
              warnings: [
                "Fixture snapshot contains recent visible messages only.",
              ],
            },
          };
          state.threads.push(thread);
          publish();
          return structuredClone(thread);
        },
        async listCodexResources(query) {
          return {
            resources: [
              {
                section: query.section,
                path: `${query.section}/guide.md`,
                title: `Fixture ${query.section} reference`,
                bytes: 96,
              },
            ],
            truncated: false,
            warnings: [],
          };
        },
        async previewCodexResource(request) {
          calls.resourcePreviews.push(structuredClone(request));
          return {
            ...request,
            title: `Fixture ${request.section} reference`,
            bytes: 96,
            home: state.settings.codexHome || codexHome,
            sha256: resourceDigest,
            content:
              "# Fixture reference\n\nKeep checks reproducible.\n<script>window.libraryInjected=true</script>",
          };
        },
        async importCodexMemory(request) {
          calls.resourceImports.push(structuredClone(request));
          if (request.expectedSha256 !== resourceDigest)
            throw new Error(
              "Resource changed since preview. Preview again before importing.",
            );
          const entry = {
            id: `fixture-imported-memory-${calls.resourceImports.length}`,
            projectId: request.projectId,
            title: `Fixture ${request.section} reference`,
            content: "Keep checks reproducible.",
            kind: "note" as const,
            source: `Codex resource: ${request.path}`,
            status: "active" as const,
            createdAt: "2026-11-12T00:00:00Z",
            updatedAt: "2026-11-12T00:00:00Z",
            codexSource: {
              home: state.settings.codexHome || codexHome,
              section: request.section,
              path: request.path,
              sha256: resourceDigest,
            },
          };
          state.memories.push(entry);
          publish();
          return structuredClone(entry);
        },
        async getSnapshot() {
          return snapshot();
        },
        async refreshProviderStatus() {
          calls.refreshes++;
          available = true;
          return snapshot();
        },
        async chooseProject() {
          return state.projects[0];
        },
        async updateThread(input: ThreadUpdate) {
          calls.threadUpdates.push(structuredClone(input));
          const thread = state.threads.find((item) => item.id === input.id);
          if (!thread) throw new Error("Fixture thread missing");
          if (input.title !== undefined) thread.title = input.title;
          if (input.pinned !== undefined) thread.pinned = input.pinned;
          if (input.archived !== undefined)
            thread.archivedAt = input.archived
              ? new Date().toISOString()
              : undefined;
          publish();
          return structuredClone(thread);
        },
        async previewContext(request: RunRequest) {
          calls.contextRequests.push(structuredClone(request));
          const entries = state.memories.filter(
            (entry) =>
              entry.projectId === request.projectId &&
              entry.status === "active",
          );
          const memories: ContextMemory[] = entries.map((entry) => {
            const freshness = entry.codexSource
              ? "current"
              : !entry.filePath
                ? "unlinked"
                : entry.fileSha256 === "current"
                  ? "current"
                  : "changed";
            return {
              id: entry.id,
              title: entry.title,
              source: entry.source,
              kind: entry.kind,
              filePath: entry.filePath,
              freshness,
              included: freshness !== "changed",
              reason:
                freshness === "changed"
                  ? "The source digest changed; review the original checkout."
                  : freshness === "unlinked"
                    ? "Unlinked note, included with warning."
                    : "Saved source bytes match.",
            };
          });
          const includedMemoryIds = memories
            .filter((entry) => entry.included)
            .map((entry) => entry.id);
          const history = state.runs.filter(
            (run) => run.threadId === request.threadId,
          );
          const imported =
            state.threads.find((thread) => thread.id === request.threadId)
              ?.codex?.history ?? [];
          const prompt = [
            "FIXTURE EXACT REQUEST",
            ...entries
              .filter((entry) => includedMemoryIds.includes(entry.id))
              .map((entry) => `${entry.title}: ${entry.content}`),
            ...history.map((run) => `History: ${run.prompt}`),
            ...imported.map(
              (message) => `Imported ${message.role}: ${message.text}`,
            ),
            `Task: ${request.prompt}`,
          ].join("\n");
          return {
            projectId: request.projectId,
            threadId: request.threadId,
            prompt,
            characters: prompt.length,
            estimatedTokens: Math.ceil(prompt.length / 4),
            memories,
            includedMemoryIds,
            omittedMemoryIds: memories
              .filter((entry) => !entry.included)
              .map((entry) => entry.id),
            historyRunIds: history.map((run) => run.id),
            warnings: ["Fixture context: synthetic data, no filesystem reads."],
          };
        },
        async startRun(request: RunRequest) {
          calls.requests.push(structuredClone(request));
          const threadId =
            request.threadId ?? `test-thread-${state.threads.length + 1}`;
          if (!state.threads.some((thread) => thread.id === threadId))
            state.threads.push({
              id: threadId,
              projectId: request.projectId,
              title: request.prompt.slice(0, 50),
              createdAt: "2026-11-12T00:00:00Z",
              updatedAt: "2026-11-12T00:00:00Z",
            });
          const run: Run = {
            id: `test-run-${state.runs.length + 1}`,
            threadId,
            projectId: request.projectId,
            provider: request.provider,
            model: request.model ?? "Provider default",
            mode: request.mode,
            prompt: request.prompt,
            status: config.complete ? "completed" : "running",
            createdAt: "2026-11-12T00:00:00Z",
            startedAt: "2026-11-12T00:00:00Z",
            verification: "not-run",
            contextMemoryIds: [],
            worktreePath:
              request.mode === "build" ? "D:\\Fixtures\\worktree" : undefined,
            events: [
              {
                id: "test-event-status",
                at: "2026-11-12T00:00:00Z",
                kind: "status",
                text: "Mock process event",
              },
              {
                id: "test-event-message",
                at: "2026-11-12T00:00:01Z",
                kind: "message",
                text: config.literal
                  ? '<img src="bad.example" onerror="window.injected=true">\n\n```html\n<script>window.injected=true</script>\n```'
                  : "A mocked response for testing the desktop bridge.",
              },
            ],
          };
          state.runs.push(run);
          publish();
          return structuredClone(run);
        },
        async cancelRun(id: string) {
          calls.cancellations.push(id);
          const run = state.runs.find((item) => item.id === id);
          if (run) run.status = "cancelled";
          publish();
        },
        async getDiff() {
          return config.finishing && !worktreeCommitted
            ? { branch: "nova/fixture-change", changes: [{ path: "src/fixture.ts", status: "M" }], diff: "@@ -1 +1 @@\n-old fixture\n+new fixture\n", truncated: false }
            : { branch: "main", changes: [], diff: "", truncated: false };
        },
        async saveMemory(input: MemoryInput) {
          const index = state.memories.findIndex(
            (entry) => entry.id === input.id,
          );
          const value = {
            ...input,
            id: input.id ?? `fixture-memory-${state.memories.length + 1}`,
            fileSha256: input.filePath ? "current" : undefined,
            status: "active" as const,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          if (index >= 0) state.memories[index] = value;
          else state.memories.push(value);
          publish();
          return structuredClone(value);
        },
        async archiveMemory(id: string) {
          const entry = state.memories.find((item) => item.id === id);
          if (entry) entry.status = "archived";
          publish();
        },
        async saveVerificationProfile(input: VerificationProfileInput) {
          const profile = {
            ...input,
            id:
              input.id ??
              `fixture-profile-${state.verificationProfiles.length + 1}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          const index = state.verificationProfiles.findIndex(
            (item) => item.id === profile.id,
          );
          if (index >= 0) state.verificationProfiles[index] = profile;
          else state.verificationProfiles.push(profile);
          publish();
          return structuredClone(profile);
        },
        async deleteVerificationProfile(id: string) {
          state.verificationProfiles = state.verificationProfiles.filter(
            (profile) => profile.id !== id,
          );
          publish();
        },
        async getVerificationReport(runId: string) {
          const run = state.runs.find((item) => item.id === runId);
          return {
            profiles: structuredClone(state.verificationProfiles),
            results: structuredClone(
              state.verifications.filter((result) => result.runId === runId),
            ),
            currentRevision: run?.worktreePath ? revision() : undefined,
            busy: state.verifications.some(
              (result) => result.status === "running",
            ),
          };
        },
        async startVerification(request: VerificationRequest) {
          calls.checks.push(structuredClone(request));
          const profile = state.verificationProfiles.find(
            (item) => item.id === request.profileId,
          );
          const run = state.runs.find((item) => item.id === request.runId);
          if (!profile || !run) throw new Error("Fixture check target missing");
          const result: VerificationResult = {
            id: `fixture-check-${calls.checks.length}`,
            runId: run.id,
            threadId: run.threadId,
            projectId: run.projectId,
            profileId: profile.id,
            profileName: profile.name,
            executable: profile.executable,
            args: profile.args,
            cwd: run.worktreePath ?? "",
            status: "running",
            createdAt: new Date().toISOString(),
            output: "Mock check started. No actual process was launched.\n",
            truncated: false,
            inputRevision: revision(),
          };
          state.verifications.push(result);
          publish();
          return structuredClone(result);
        },
        async cancelVerification(id: string) {
          calls.checkCancellations.push(id);
          const result = state.verifications.find((item) => item.id === id);
          if (result) {
            result.status = "cancelled";
            result.finishedAt = new Date().toISOString();
          }
          publish();
        },
        async updateSettings(settings: WorkspaceState["settings"]) {
          state.settings = settings;
          publish();
          return settings;
        },
        async openProject(id: string) {
          calls.opens.push(id);
        },
        async revealWorktree(id: string) {
          calls.opens.push(id);
        },
        onStateChanged(callback: (value: WorkspaceState) => void) {
          listeners.add(callback);
          return () => {
            listeners.delete(callback);
          };
        },
      };
      const controls: FixtureControls = {
        setExportCancelled(value) { exportCancelled = value; },
        setResourceDigest(value) {
          resourceDigest = value;
        },
        setLibraryFailure(value) {
          libraryFailure = value;
        },
        setRevision(value) {
          fingerprint = value;
          publish();
        },
        appendCheckOutput(id, text) {
          const result = state.verifications.find((item) => item.id === id);
          if (result) result.output += text;
          publish();
        },
        finishCheck(id, status) {
          const result = state.verifications.find((item) => item.id === id);
          if (result) {
            result.status = status;
            result.exitCode = status === "passed" ? 0 : 1;
            result.outputRevision = revision();
            result.finishedAt = new Date().toISOString();
          }
          publish();
        },
      };
      Object.assign(window, {
        workbench: bridge,
        __workbenchTest: calls,
        __workbenchFixture: controls,
      });
    },
    { initialState: initial, config: options, version: APP_VERSION },
  );
}
