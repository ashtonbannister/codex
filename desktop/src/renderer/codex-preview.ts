import type {
  CodexResourcePreview,
  CodexResourceSection,
  CodexThreadSummary,
  ImportedMessage,
} from "../shared/compatibility";
import type {
  MemoryEntry,
  Thread,
  WorkbenchAPI,
  WorkspaceState,
} from "../shared/types";

type LibraryMethods = Pick<
  WorkbenchAPI,
  | "inspectCodexInstallation"
  | "chooseStorageDirectory"
  | "listCodexThreads"
  | "readCodexHistory"
  | "importCodexThread"
  | "listCodexResources"
  | "previewCodexResource"
  | "importCodexMemory"
>;

/** Synthetic catalog used only by the browser adapter. No filesystem or provider calls. */
export function createPreviewLibrary(
  state: WorkspaceState,
  publish: () => void,
): LibraryMethods {
  const defaultHome = "C:\\Synthetic\\Codex (example)";
  const home = () => state.settings.codexHome || defaultHome;
  const now = "2026-11-12T00:00:00.000Z";
  const conversations: CodexThreadSummary[] = [
    {
      id: "sample-codex-city",
      title: "Build the first city block",
      cwd: "D:\\Projects\\HendayHeat (example)",
      modelProvider: "openai",
      createdAt: now,
      updatedAt: now,
      source: "Synthetic CLI conversation",
      status: "idle",
      archived: false,
    },
    {
      id: "sample-codex-unreal",
      title: "Review the Unreal import pipeline",
      cwd: "D:\\Projects\\HendayHeat (example)",
      modelProvider: "openai",
      createdAt: now,
      updatedAt: now,
      source: "Synthetic desktop conversation",
      status: "idle",
      archived: false,
    },
    {
      id: "sample-codex-folder",
      title: "Compare local project notes",
      cwd: "D:\\Notes (example folder)",
      modelProvider: "openai",
      createdAt: now,
      updatedAt: now,
      source: "Synthetic CLI conversation",
      status: "idle",
      archived: false,
    },
    {
      id: "sample-codex-archived",
      title: "Early world-generation research",
      cwd: "D:\\Projects\\HendayHeat (example)",
      modelProvider: "openai",
      createdAt: now,
      updatedAt: now,
      source: "Synthetic archived conversation",
      status: "idle",
      archived: true,
    },
  ];
  const recent: ImportedMessage[] = [
    {
      id: "synthetic-u2",
      turnId: "synthetic-turn-2",
      role: "user",
      text: "Keep the next milestone to a complete, testable city block. What should the handoff contain?",
    },
    {
      id: "synthetic-a2",
      turnId: "synthetic-turn-2",
      role: "assistant",
      text: "### A focused handoff\n\nKeep the source data, coordinate conventions, and acceptance checks together.\n\n- Import one bounded road segment.\n- Preserve the source coordinates and units.\n- Compare a fixed camera view before expanding the area.\n\n```ts\nconst scope = { area: 'one-city-block', units: 'meters' };\n```\n\nThis is an illustrative transcript for the UI preview. No Codex conversation or project file was read.",
    },
  ];
  const older: ImportedMessage[] = [
    {
      id: "synthetic-u1",
      turnId: "synthetic-turn-1",
      role: "user",
      text: "What is a useful first milestone? (Synthetic earlier message.)",
    },
    {
      id: "synthetic-a1",
      turnId: "synthetic-turn-1",
      role: "assistant",
      text: "Start small enough to inspect completely. This is sample history, not a real model response.",
    },
  ];
  const definitions: {
    section: CodexResourceSection;
    path: string;
    title: string;
    content: string;
  }[] = [
    {
      section: "instructions",
      path: "AGENTS.md",
      title: "AGENTS.md",
      content:
        "# Synthetic project instructions\n\nKeep changes focused and review the diff before integration.\nRecord the command and source revision for each check.\n\nThis illustrative resource is not read from your computer. Importing it creates a reference note; it does not install instructions.",
    },
    {
      section: "memories",
      path: "memory_summary.md",
      title: "Memory summary",
      content:
        "Synthetic remembered decision: preserve the source coordinate system during import.\n\nThis preview note has no relationship to actual Codex memory.",
    },
    {
      section: "memories_v2",
      path: "project-notes.md",
      title: "Project notes",
      content:
        "Synthetic memory v2 reference. Keep acceptance checks next to each implementation milestone.",
    },
    {
      section: "skills",
      path: "world-import/SKILL.md",
      title: "World import skill",
      content:
        "# Synthetic skill\n\n1. Inspect the source schema.\n2. Confirm units.\n3. Compare a fixed test region.\n\nImport copies text as a reference. Nothing is installed or executed.",
    },
    {
      section: "plans",
      path: "city-block.md",
      title: "City-block plan",
      content:
        "# Synthetic implementation plan\n\n- Read one data tile.\n- Generate a bounded test scene.\n- Inspect geometry and record checks.\n\nThis is preview content only.",
    },
  ];
  const resource = (
    section: CodexResourceSection,
    path: string,
  ): CodexResourcePreview => {
    const found = definitions.find(
      (item) => item.section === section && item.path === path,
    );
    if (!found) throw new Error("This synthetic resource is not available.");
    return {
      ...found,
      bytes: new TextEncoder().encode(found.content).length,
      sha256: `synthetic-preview-${section}-fingerprint`,
      home: home(),
    };
  };
  const findThread = (id: string) => {
    const found = conversations.find((thread) => thread.id === id);
    if (!found)
      throw new Error("This synthetic conversation is not available.");
    return found;
  };
  return {
    async inspectCodexInstallation() {
      return {
        home: home(),
        exists: true,
        warnings: [],
        locations: [
          ...(
            [
              ["memories", "Memories"],
              ["memories_v2", "Memories v2"],
              ["instructions", "Instructions"],
              ["skills", "Skills"],
              ["plans", "Plans"],
            ] as const
          ).map(([id, name]) => ({
            id,
            name,
            path: `${home()}\\${id === "instructions" ? "AGENTS.md" : id}`,
            exists: true,
            access: "content" as const,
            detail:
              "Synthetic readable resource location. Preview selected text before importing it.",
          })),
          {
            id: "sessions",
            name: "Conversations",
            path: `${home()}\\sessions`,
            exists: true,
            access: "content",
            detail:
              "Synthetic read-only conversation source. No engine is started and the source is never changed.",
          },
          {
            id: "credentials",
            name: "Credentials and configuration",
            path: `${home()}\\auth.json / config.toml`,
            exists: true,
            access: "excluded",
            detail:
              "Not opened, copied, previewed, or imported by this library.",
          },
        ],
      };
    },
    async chooseStorageDirectory(kind) {
      return kind === "codex-home"
        ? defaultHome
        : "D:\\Synthetic\\Nova worktrees (example)";
    },
    async listCodexThreads(query) {
      const found = conversations.filter(
        (thread) =>
          thread.archived === !!query.archived &&
          `${thread.title} ${thread.cwd}`
            .toLowerCase()
            .includes((query.search ?? "").toLowerCase()),
      );
      const offset = query.cursor === "synthetic-page-2" ? 2 : 0;
      return {
        threads: structuredClone(found.slice(offset, offset + 2)),
        nextCursor: found.length > offset + 2 ? "synthetic-page-2" : undefined,
        warnings: [],
      };
    },
    async readCodexHistory(query) {
      return {
        thread: structuredClone(findThread(query.threadId)),
        messages: structuredClone(query.cursor ? older : recent),
        nextCursor: query.cursor ? undefined : "synthetic-older-page",
        truncated: false,
        warnings: [
          "Synthetic visible history. No local conversation was read.",
        ],
      };
    },
    async importCodexThread(request) {
      const source = findThread(request.threadId);
      const existing = state.threads.find(
        (thread) => thread.codex?.sourceThreadId === source.id,
      );
      if (existing) return structuredClone(existing);
      const projectPath = `D:\\Synthetic\\Nova imports\\${source.id}`;
      let project = state.projects.find((item) => item.path === projectPath);
      if (!project) {
        project = {
          id: `preview-project-${source.id}`,
          name: "Imported conversation (example)",
          path: projectPath,
          branch: "",
          kind: "folder",
          createdAt: now,
        };
        state.projects.push(project);
      }
      const thread: Thread = {
        id: `preview-import-${source.id}`,
        projectId: project.id,
        title: source.title,
        createdAt: now,
        updatedAt: now,
        codex: {
          home: home(),
          sourceThreadId: source.id,
          sourceCwd: source.cwd,
          sourceArchived: source.archived,
          importedAt: now,
          history: structuredClone(recent),
          historyTruncated: true,
          warnings: [
            "Synthetic snapshot. Earlier messages exist in this example but are not retained in the imported snapshot.",
          ],
        },
      };
      state.threads.push(thread);
      publish();
      return structuredClone(thread);
    },
    async listCodexResources(query) {
      return {
        resources: definitions
          .filter((item) => item.section === query.section)
          .map((item) => {
            const {
              content: _content,
              sha256: _sha256,
              home: _home,
              ...entry
            } = resource(item.section, item.path);
            return entry;
          }),
        truncated: false,
        warnings: [],
      };
    },
    async previewCodexResource(request) {
      return resource(request.section, request.path);
    },
    async importCodexMemory(request) {
      const preview = resource(request.section, request.path);
      if (request.expectedSha256 !== preview.sha256)
        throw new Error(
          "The synthetic resource changed. Preview it again before importing.",
        );
      if (!state.projects.some((item) => item.id === request.projectId))
        throw new Error("Choose an example project first.");
      const entry: MemoryEntry = {
        id: crypto.randomUUID(),
        projectId: request.projectId,
        title: preview.title,
        content: preview.content,
        kind: "note",
        source: `Synthetic Codex resource · ${preview.path}`,
        status: "active",
        createdAt: now,
        updatedAt: now,
        codexSource: {
          home: preview.home,
          section: preview.section,
          path: preview.path,
          sha256: preview.sha256,
        },
      };
      state.memories.push(entry);
      publish();
      return structuredClone(entry);
    },
  };
}
