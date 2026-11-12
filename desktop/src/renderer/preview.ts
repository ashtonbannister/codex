import { APP_VERSION, emptyWorkspace } from "../shared/types";
import type {
  MemoryEntry,
  ContextMemory,
  Project,
  WorkbenchAPI,
  WorkspaceState,
} from "../shared/types";

/** Browser-only sample data. This adapter never reads files or invokes a model. */
export function createPreviewAPI(seedDemo: boolean): WorkbenchAPI {
  const state = emptyWorkspace();
  const listeners = new Set<(value: WorkspaceState) => void>();
  const now = new Date().toISOString();
  const exampleProject: Project = {
    id: "preview-project",
    name: "Henday Heat",
    path: "D:\\Projects\\HendayHeat (example)",
    branch: "main",
    createdAt: now,
  };
  const publish = () =>
    listeners.forEach((listener) => listener(structuredClone(state)));
  const sampleRevision = {
    head: "synthetic-preview-head",
    fingerprint: "synthetic-current-source",
    complete: true,
  };

  if (seedDemo) {
    state.projects.push(exampleProject);
    state.threads.push({
      id: "preview-thread",
      projectId: exampleProject.id,
      title: "Plan a world-generation pipeline",
      createdAt: now,
      updatedAt: now,
      pinned: true,
      worktreePath: "D:\\ExampleWorktrees\\city-block (synthetic)",
    });
    state.memories.push(
      {
        id: "preview-memory-1",
        projectId: exampleProject.id,
        title: "Simulation comes first",
        content:
          "Prioritize believable vehicle behavior and measured performance over arcade shortcuts.",
        kind: "constraint",
        source: "Example project brief — preview data",
        status: "active",
        createdAt: now,
        updatedAt: now,
        filePath: "docs/driving-model.md",
        fileSha256: "synthetic-current-source",
      },
      {
        id: "preview-memory-2",
        projectId: exampleProject.id,
        title: "Build in isolated worktrees",
        content:
          "Keep experiments off the main checkout. Review the diff before integrating a change.",
        kind: "decision",
        source: "Example workflow decision — preview data",
        status: "active",
        createdAt: now,
        updatedAt: now,
        filePath: "src/world/generator.ts",
        fileSha256: "synthetic-changed-source",
      },
    );
    state.runs.push({
      id: "preview-run",
      projectId: exampleProject.id,
      threadId: "preview-thread",
      provider: "codex",
      model: "Provider default",
      mode: "plan",
      prompt:
        "Plan the first world-generation milestone. Keep the scope small and give us a way to test the result.",
      status: "completed",
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      contextMemoryIds: ["preview-memory-1", "preview-memory-2"],
      verification: "not-run",
      worktreePath: "D:\\ExampleWorktrees\\city-block (synthetic)",
      events: [
        {
          id: "preview-e1",
          at: now,
          kind: "status",
          text: "Illustrative conversation · no model has been run",
        },
        {
          id: "preview-e2",
          at: now,
          kind: "message",
          text: 'Start with **one complete city block**, not the whole city. A bounded area gives us a repeatable test before we scale the pipeline.\n\n### First milestone\n\n1. Import terrain and road centerlines for the test area.\n2. Generate the road surface, curbs, and simple building volumes.\n3. Check road grade, intersections, and vehicle clearance.\n4. Record a fixed camera route and performance baseline.\n\nKeep the acceptance criteria next to the implementation:\n\n```ts\nconst milestone = {\n  area: "one-city-block",\n  checks: ["load", "drive", "clearance"],\n};\n```\n\nA successful code edit alone does not prove the world behaves correctly.\n\nThis is sample content for the interface preview, not a live analysis of your project.',
        },
      ],
    });
    state.verificationProfiles.push(
      {
        id: "preview-profile-typecheck",
        projectId: exampleProject.id,
        name: "Typecheck",
        executable: "npm",
        args: ["run", "typecheck"],
        timeoutMinutes: 10,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "preview-profile-tests",
        projectId: exampleProject.id,
        name: "Unit tests",
        executable: "npm",
        args: ["test"],
        timeoutMinutes: 10,
        createdAt: now,
        updatedAt: now,
      },
    );
    state.verifications.push(
      {
        id: "preview-check-current",
        projectId: exampleProject.id,
        threadId: "preview-thread",
        runId: "preview-run",
        profileId: "preview-profile-typecheck",
        profileName: "Typecheck",
        executable: "npm",
        args: ["run", "typecheck"],
        cwd: "D:\\ExampleWorktrees\\city-block (synthetic)",
        status: "passed",
        createdAt: now,
        finishedAt: now,
        exitCode: 0,
        output:
          "SYNTHETIC PREVIEW — no command was executed.\nExample: type checking completed without diagnostics.",
        truncated: false,
        inputRevision: sampleRevision,
        outputRevision: sampleRevision,
      },
      {
        id: "preview-check-stale",
        projectId: exampleProject.id,
        threadId: "preview-thread",
        runId: "preview-run",
        profileId: "preview-profile-tests",
        profileName: "Unit tests",
        executable: "npm",
        args: ["test"],
        cwd: "D:\\ExampleWorktrees\\city-block (synthetic)",
        status: "stale",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        finishedAt: now,
        exitCode: 0,
        output:
          "SYNTHETIC PREVIEW — no command was executed.\nExample: tests passed for an earlier source snapshot.",
        truncated: false,
        inputRevision: {
          ...sampleRevision,
          fingerprint: "synthetic-earlier-source",
        },
        outputRevision: {
          ...sampleRevision,
          fingerprint: "synthetic-earlier-source",
        },
      },
    );
  }

  return {
    async updateThread(input) {
      const thread = state.threads.find((item) => item.id === input.id);
      if (!thread) throw new Error("The example conversation was not found.");
      if (input.title !== undefined) thread.title = input.title.trim();
      if (input.pinned !== undefined) thread.pinned = input.pinned;
      if (input.archived !== undefined)
        thread.archivedAt = input.archived
          ? new Date().toISOString()
          : undefined;
      thread.updatedAt = new Date().toISOString();
      publish();
      return structuredClone(thread);
    },
    async previewContext(request) {
      const entries = state.memories.filter(
        (entry) =>
          entry.projectId === request.projectId && entry.status === "active",
      );
      const memories: ContextMemory[] = entries.map((entry) => {
        const freshness = !entry.filePath
          ? "unlinked"
          : entry.fileSha256 === "synthetic-current-source"
            ? "current"
            : entry.fileSha256 === "synthetic-changed-source"
              ? "changed"
              : "unavailable";
        const included = freshness === "current" || freshness === "unlinked";
        return {
          id: entry.id,
          title: entry.title,
          kind: entry.kind,
          source: entry.source,
          filePath: entry.filePath,
          freshness,
          included,
          reason:
            freshness === "unavailable"
              ? "The browser preview cannot read or fingerprint local files."
              : freshness === "changed"
                ? "Synthetic example: the source changed after the note was saved."
                : freshness === "unlinked"
                  ? "Unlinked reference; no source freshness check is possible."
                  : "Synthetic example: source bytes match the saved fingerprint.",
        };
      });
      const includedMemoryIds = memories
        .filter((memory) => memory.included)
        .map((memory) => memory.id);
      const history = state.runs
        .filter((run) => run.threadId === request.threadId)
        .slice(-4);
      const prompt = [
        "[SYNTHETIC UI PREVIEW — no provider request is sent]",
        "\nPROJECT MEMORY",
        ...entries
          .filter((entry) => includedMemoryIds.includes(entry.id))
          .map(
            (entry) =>
              `${entry.title}\n${entry.content}\nSource: ${entry.source}`,
          ),
        "\nCONVERSATION",
        ...history.map(
          (run) =>
            `User: ${run.prompt}\nAgent: ${run.events
              .filter((event) => event.kind === "message")
              .map((event) => event.text)
              .join("\n")}`,
        ),
        "\nCURRENT REQUEST",
        request.prompt,
      ].join("\n\n");
      return {
        projectId: request.projectId,
        threadId: request.threadId,
        prompt,
        characters: prompt.length,
        estimatedTokens: Math.ceil(prompt.length / 4),
        memories,
        includedMemoryIds,
        omittedMemoryIds: memories
          .filter((memory) => !memory.included)
          .map((memory) => memory.id),
        historyRunIds: history.map((run) => run.id),
        warnings: [
          "Synthetic preview only. Native context is prepared by the desktop backend using the current repository.",
        ],
      };
    },
    async refreshProviderStatus() {
      return this.getSnapshot();
    },
    async getSnapshot() {
      return {
        state: structuredClone(state),
        providers: [
          {
            id: "codex",
            name: "Codex",
            available: false,
            detail: "Desktop app required; not detected in browser preview.",
          },
          {
            id: "claude",
            name: "Claude Code",
            available: false,
            detail: "Desktop app required; not detected in browser preview.",
          },
          {
            id: "ollama",
            name: "Local · Ollama",
            available: false,
            detail: "Desktop app required; not detected in browser preview.",
          },
        ],
        appVersion: `${APP_VERSION}-preview`,
        platform: "browser preview",
      };
    },
    async chooseProject() {
      if (!state.projects.length) state.projects.push(exampleProject);
      publish();
      return structuredClone(exampleProject);
    },
    async startRun() {
      throw new Error(
        "This is a UI preview. Open the desktop application to run a configured coding agent.",
      );
    },
    async cancelRun() {},
    async getDiff() {
      return { branch: "main", changes: [], diff: "", truncated: false };
    },
    async saveMemory(input) {
      const previous = state.memories.find((item) => item.id === input.id);
      const entry: MemoryEntry = {
        ...input,
        id: input.id ?? crypto.randomUUID(),
        status: "active",
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const existing = state.memories.findIndex((item) => item.id === entry.id);
      if (existing >= 0) state.memories[existing] = entry;
      else state.memories.push(entry);
      publish();
      return structuredClone(entry);
    },
    async archiveMemory(id) {
      const entry = state.memories.find((item) => item.id === id);
      if (entry) entry.status = "archived";
      publish();
    },
    async saveVerificationProfile(input) {
      const previous = state.verificationProfiles.find(
        (profile) => profile.id === input.id,
      );
      const profile = {
        ...input,
        id: input.id ?? crypto.randomUUID(),
        createdAt: previous?.createdAt ?? new Date().toISOString(),
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
    async deleteVerificationProfile(id) {
      state.verificationProfiles = state.verificationProfiles.filter(
        (profile) => profile.id !== id,
      );
      publish();
    },
    async getVerificationReport(runId) {
      const run = state.runs.find((item) => item.id === runId);
      return {
        profiles: state.verificationProfiles.filter(
          (profile) => profile.projectId === run?.projectId,
        ),
        results: structuredClone(
          state.verifications.filter((result) => result.runId === runId),
        ),
        currentRevision: run?.worktreePath ? sampleRevision : undefined,
        busy: false,
      };
    },
    async startVerification() {
      throw new Error(
        "UI preview only. Open the desktop application to run a check after native confirmation.",
      );
    },
    async cancelVerification() {
      throw new Error(
        "UI preview only. There is no running command to cancel.",
      );
    },
    async updateSettings(settings) {
      state.settings = { ...settings };
      publish();
      return { ...settings };
    },
    async openProject() {
      throw new Error(
        "Example project only. The browser preview cannot open a local folder.",
      );
    },
    async revealWorktree() {
      throw new Error("Example project only. No worktree has been created.");
    },
    onStateChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
