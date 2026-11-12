import { emptyWorkspace } from "../shared/types";
import type {
  MemoryEntry,
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

  if (seedDemo) {
    state.projects.push(exampleProject);
    state.threads.push({
      id: "preview-thread",
      projectId: exampleProject.id,
      title: "Plan a world-generation pipeline",
      createdAt: now,
      updatedAt: now,
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
          text: "Start with one complete city block, not the whole city. That gives us a small, repeatable test of the pipeline before we scale it.\n\n1. Import the terrain and road centerlines for a bounded area.\n2. Generate the road surface, curbs, and simple building volumes.\n3. Check road grade, intersections, and vehicle clearance.\n4. Record a fixed camera route and performance baseline.\n\nThe milestone is complete only when the block loads, can be driven, and passes those checks. A successful code edit alone does not prove the world behaves correctly.\n\nThis is sample content for the interface preview, not a live analysis of your project.",
        },
      ],
    });
  }

  return {
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
        appVersion: "0.1.0-preview",
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
      const entry: MemoryEntry = {
        ...input,
        id: input.id ?? crypto.randomUUID(),
        status: "active",
        createdAt: new Date().toISOString(),
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
