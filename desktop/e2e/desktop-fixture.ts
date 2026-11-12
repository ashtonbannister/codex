import type { Page } from "@playwright/test";
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
}
export interface FixtureControls {
  setRevision: (fingerprint: string) => void;
  appendCheckOutput: (id: string, text: string) => void;
  finishCheck: (id: string, status: "passed" | "failed") => void;
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
      };
      let available = config.available !== false;
      let fingerprint = "fixture-current";
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
            const freshness = !entry.filePath
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
          const prompt = [
            "FIXTURE EXACT REQUEST",
            ...entries
              .filter((entry) => includedMemoryIds.includes(entry.id))
              .map((entry) => `${entry.title}: ${entry.content}`),
            ...history.map((run) => `History: ${run.prompt}`),
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
          return { branch: "main", changes: [], diff: "", truncated: false };
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
