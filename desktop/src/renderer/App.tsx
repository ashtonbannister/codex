import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  SquarePen,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { APP_VERSION, emptyWorkspace } from "../shared/types";
import type {
  ContextPreview,
  DiffSnapshot,
  MemoryEntry,
  ProviderId,
  RunMode,
  RunRequest,
  Thread,
  WorkspaceSnapshot,
} from "../shared/types";
import { api, isPreview } from "./bridge";
import { CommandPalette } from "./components/CommandPalette";
import { ChecksPanel, ContextPanel, MemoryCard } from "./components/Evidence";
import { MemoryForm, RenameThreadForm, SettingsForm } from "./components/Forms";
import { ThreadMenu } from "./components/ThreadMenu";
import { RunCard } from "./components/Transcript";
import {
  EmptyPanel,
  errorText,
  formatTime,
  isActive,
  NovaMark,
  ProviderMark,
  providerNames,
  statusLabel,
} from "./components/primitives";
import { ResizeHandle, useWorkspaceLayout } from "./layout";

type InspectorTab = "changes" | "context" | "memory" | "checks" | "activity";
type Dialog = "settings" | "memory" | "palette" | "rename" | null;
const tabs: { id: InspectorTab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "context", label: "Context" },
  { id: "memory", label: "Memory" },
  { id: "checks", label: "Checks" },
  { id: "activity", label: "Activity" },
];
const starters = [
  {
    title: "Understand the codebase",
    prompt:
      "Explore this project and explain its architecture, important entry points, and development conventions. Do not change files.",
  },
  {
    title: "Plan a focused change",
    prompt:
      "Help me plan the next development milestone. Identify the smallest useful implementation and concrete checks that would verify it.",
  },
  {
    title: "Review for correctness",
    prompt:
      "Review this project's current code for likely correctness issues. Prioritize findings with concrete evidence and propose tests. Do not change files.",
  },
];

export function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>({
    state: emptyWorkspace(),
    providers: [],
    appVersion: APP_VERSION,
    platform: "",
  });
  const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProviderId>("codex");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<RunMode>("plan");
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<InspectorTab>("changes");
  const [layout, setLayout] = useWorkspaceLayout();
  const [archived, setArchived] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editingMemory, setEditingMemory] = useState<MemoryEntry | undefined>();
  const [editingThread, setEditingThread] = useState<Thread | undefined>();
  const [threadMenu, setThreadMenu] = useState<{
    thread: Thread;
    anchor: { x: number; y: number };
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [diff, setDiff] = useState<DiffSnapshot | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [context, setContext] = useState<ContextPreview | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState("");
  const [contextRefresh, setContextRefresh] = useState(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const diffRequestId = useRef(0);
  const { state, providers } = snapshot;
  const project = state.projects.find((item) => item.id === projectId);
  const thread = state.threads.find((item) => item.id === threadId);
  const runs = useMemo(
    () => state.runs.filter((item) => item.threadId === threadId),
    [state.runs, threadId],
  );
  const latestRun = runs.at(-1);
  const activeRun = runs.find(isActive);
  const activeMemories = state.memories.filter(
    (item) => item.projectId === projectId && item.status === "active",
  );
  const activeProvider = providers.find((item) => item.id === provider);
  const configuredModel =
    model.trim() || (provider === "ollama" ? state.settings.localModel : "");
  const contextRequest = useMemo<RunRequest | null>(
    () =>
      projectId
        ? {
            projectId,
            threadId: threadId ?? undefined,
            provider,
            model: configuredModel || undefined,
            mode,
            prompt: draft.trim(),
          }
        : null,
    [projectId, threadId, provider, configuredModel, mode, draft],
  );
  const memoryVersion = activeMemories
    .map((entry) => `${entry.id}:${entry.updatedAt}:${entry.filePath ?? ""}`)
    .join("|");
  const historyVersion = runs
    .map((run) => `${run.id}:${run.status}:${run.events.length}`)
    .join("|");
  const refreshSnapshot = async () => {
    setSnapshot(await api.getSnapshot());
  };

  useEffect(() => {
    let alive = true;
    api
      .getSnapshot()
      .then((value) => {
        if (!alive) return;
        setSnapshot(value);
        const first = value.state.projects[0];
        if (first) {
          setProjectId(first.id);
          setThreadId(
            value.state.threads
              .filter((item) => item.projectId === first.id && !item.archivedAt)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ??
              null,
          );
        }
      })
      .catch((reason) => {
        if (alive) setError(errorText(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const unsubscribe = api.onStateChanged((nextState) => {
      if (alive) setSnapshot((current) => ({ ...current, state: nextState }));
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = state.settings.theme;
  }, [state.settings.theme]);
  useEffect(() => {
    if (autoScroll && timeline.current)
      timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [runs, autoScroll]);
  useLayoutEffect(() => {
    if (composer.current) {
      composer.current.style.height = "auto";
      composer.current.style.height = `${Math.min(Math.max(composer.current.scrollHeight, 62), 220)}px`;
    }
  }, [draft, layout.navigationWidth, layout.inspectorWidth, layout.inspector]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDialog((current) => (current === "palette" ? null : "palette"));
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);
  useEffect(() => {
    let alive = true;
    setContext(null);
    setContextError("");
    if (
      !contextRequest ||
      !layout.inspector ||
      (tab !== "context" && tab !== "memory")
    ) {
      setContextLoading(false);
      return;
    }
    setContextLoading(true);
    const timer = window.setTimeout(() => {
      void api
        .previewContext(contextRequest)
        .then((value) => {
          if (alive) setContext(value);
        })
        .catch((reason) => {
          if (alive) setContextError(errorText(reason));
        })
        .finally(() => {
          if (alive) setContextLoading(false);
        });
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [
    contextRequest,
    contextRefresh,
    memoryVersion,
    historyVersion,
    tab,
    layout.inspector,
  ]);
  const refreshDiff = async (runId = latestRun?.id) => {
    const requestId = ++diffRequestId.current;
    if (!runId) {
      setDiff(null);
      setDiffError("");
      setDiffLoading(false);
      return;
    }
    setDiffLoading(true);
    setDiffError("");
    try {
      const value = await api.getDiff(runId);
      if (requestId === diffRequestId.current) setDiff(value);
    } catch (reason) {
      if (requestId === diffRequestId.current) setDiffError(errorText(reason));
    } finally {
      if (requestId === diffRequestId.current) setDiffLoading(false);
    }
  };
  useEffect(() => {
    setDiff(null);
    void refreshDiff();
    return () => {
      diffRequestId.current++;
    };
  }, [latestRun?.id, latestRun?.status]);
  const runAction = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  const addProject = async () => {
    try {
      const chosen = await api.chooseProject();
      if (chosen) {
        await refreshSnapshot();
        setProjectId(chosen.id);
        setThreadId(null);
        setDraft("");
        setArchived(false);
      }
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  const selectProject = (id: string) => {
    setProjectId(id);
    setThreadId(
      state.threads
        .filter(
          (item) => item.projectId === id && !!item.archivedAt === archived,
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null,
    );
    setDraft("");
    setAutoScroll(true);
  };
  const selectThread = (next: Thread) => {
    setProjectId(next.projectId);
    setThreadId(next.id);
    setDraft("");
    setAutoScroll(true);
    setArchived(!!next.archivedAt);
  };
  const newThread = () => {
    setThreadId(null);
    setDraft("");
    setArchived(false);
    setAutoScroll(true);
    composer.current?.focus();
  };
  const canSend =
    !!project &&
    !!draft.trim() &&
    !busy &&
    !activeRun &&
    !thread?.archivedAt &&
    (!!activeProvider?.available || isPreview) &&
    (provider !== "ollama" || !!configuredModel);
  const submit = async () => {
    if (!canSend || !contextRequest) return;
    setBusy(true);
    setError("");
    try {
      const run = await api.startRun(contextRequest);
      setThreadId(run.threadId);
      setDraft("");
      setAutoScroll(true);
      await refreshSnapshot();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const showPanel = (next: InspectorTab) => {
    setTab(next);
    setLayout((current) => ({ ...current, inspector: true }));
  };
  const editMemory = (entry?: MemoryEntry) => {
    setEditingMemory(entry);
    setDialog("memory");
  };
  const changeProvider = (value: ProviderId) => {
    setProvider(value);
    setModel("");
  };
  const menuAction = (action: () => Promise<unknown>) => {
    setThreadMenu(null);
    void runAction(action);
  };
  const activityEvents =
    latestRun?.events.filter((event) => event.kind !== "message") ?? [];
  const layoutStyle = {
    "--navigation-width": `${layout.navigationWidth}px`,
    "--inspector-width": `${layout.inspectorWidth}px`,
  } as CSSProperties;

  return (
    <div
      className={`workbench ${layout.inspector ? "with-inspector" : ""} ${layout.navigation ? "with-navigation" : ""}`}
      style={layoutStyle}
    >
      <header className="titlebar">
        <div className="titlebar-brand">
          <NovaMark />
          <span>Nova Workbench</span>
        </div>
        <span className="titlebar-status">
          {isPreview ? "Interface preview" : "Local workspace"}
        </span>
        <div className="titlebar-native-space" aria-hidden="true" />
      </header>
      {isPreview && (
        <div className="preview-banner">
          <span>
            UI preview — no local files, credentials, or AI services are
            accessed.
          </span>
          <button
            onClick={() => {
              window.location.search = new URLSearchParams(
                window.location.search,
              ).has("demo")
                ? ""
                : "?demo=1";
            }}
          >
            {new URLSearchParams(window.location.search).has("demo")
              ? "Show empty state"
              : "Explore sample workspace"}
          </button>
        </div>
      )}
      <div className="workspace-body">
        {layout.navigation && (
          <>
            <aside className="sidebar" aria-label="Project navigation">
              <div className="sidebar-top">
                <button
                  className="new-thread-button"
                  onClick={newThread}
                  disabled={!project}
                >
                  <SquarePen size={16} />
                  <span>New thread</span>
                </button>
                <button
                  className="sidebar-search"
                  onClick={() => setDialog("palette")}
                  aria-label="Search projects and threads"
                >
                  <Search size={14} />
                  <span>Search or jump to…</span>
                  <kbd>Ctrl K</kbd>
                </button>
              </div>
              <div className="sidebar-section-title">
                <select
                  aria-label="Thread filter"
                  value={archived ? "archived" : "active"}
                  onChange={(event) =>
                    setArchived(event.target.value === "archived")
                  }
                >
                  <option value="active">Projects</option>
                  <option value="archived">Archived threads</option>
                </select>
                <button
                  className="icon-button"
                  onClick={() => void addProject()}
                  aria-label="Add project"
                  title="Open a local Git repository"
                >
                  <Plus size={16} />
                </button>
              </div>
              <nav className="project-list">
                {state.projects.length === 0 && (
                  <div className="sidebar-empty">
                    <p>No projects yet.</p>
                    <button
                      className="text-button"
                      onClick={() => void addProject()}
                    >
                      Open a repository
                    </button>
                  </div>
                )}
                {state.projects.map((item) => {
                  const threads = state.threads
                    .filter(
                      (entry) =>
                        entry.projectId === item.id &&
                        !!entry.archivedAt === archived,
                    )
                    .sort(
                      (a, b) =>
                        Number(!!b.pinned) - Number(!!a.pinned) ||
                        b.updatedAt.localeCompare(a.updatedAt),
                    );
                  return (
                    <div className="project-group" key={item.id}>
                      <button
                        className={`project-button ${projectId === item.id ? "selected" : ""}`}
                        onClick={() => selectProject(item.id)}
                      >
                        <Folder size={15} />
                        <span>{item.name}</span>
                        {projectId === item.id ? (
                          <ChevronDown size={12} />
                        ) : (
                          <ChevronRight size={12} />
                        )}
                      </button>
                      {projectId === item.id && (
                        <div className="thread-list">
                          {threads.map((entry) => (
                            <div
                              className={`thread-row ${threadId === entry.id ? "selected" : ""}`}
                              key={entry.id}
                            >
                              <button
                                className="thread-button"
                                onClick={() => selectThread(entry)}
                              >
                                {state.runs.some(
                                  (run) =>
                                    run.threadId === entry.id && isActive(run),
                                ) ? (
                                  <span className="working-dot" />
                                ) : entry.pinned ? (
                                  <Pin size={12} />
                                ) : (
                                  <MessageSquare size={12} />
                                )}
                                <span>{entry.title}</span>
                              </button>
                              <button
                                className="thread-more icon-button"
                                aria-label={`Thread actions: ${entry.title}`}
                                onClick={(event) => {
                                  const rect =
                                    event.currentTarget.getBoundingClientRect();
                                  setThreadMenu({
                                    thread: entry,
                                    anchor: {
                                      x: rect.left,
                                      y: rect.bottom + 4,
                                    },
                                  });
                                }}
                              >
                                <MoreHorizontal size={15} />
                              </button>
                            </div>
                          ))}
                          {threads.length === 0 && (
                            <span className="no-threads">
                              {archived
                                ? "No archived threads"
                                : "No conversations yet"}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </nav>
              <div className="sidebar-bottom">
                <div className="sidebar-section-title">
                  <span>Agents</span>
                  <button
                    className="icon-button"
                    onClick={() =>
                      void runAction(async () =>
                        setSnapshot(await api.refreshProviderStatus()),
                      )
                    }
                    aria-label="Refresh agent availability"
                  >
                    <RefreshCw size={13} />
                  </button>
                </div>
                <div className="agent-list">
                  {(["codex", "claude", "ollama"] as ProviderId[]).map((id) => {
                    const runtime = providers.find((item) => item.id === id);
                    return (
                      <button
                        className={`agent-option ${provider === id ? "selected" : ""}`}
                        key={id}
                        onClick={() => changeProvider(id)}
                        title={runtime?.detail ?? "Checking runtime"}
                      >
                        <ProviderMark provider={id} small />
                        <span>{providerNames[id]}</span>
                        <span
                          aria-label={
                            runtime?.available ? "Detected" : "Not detected"
                          }
                          className={`availability-dot ${runtime?.available ? "available" : ""}`}
                        />
                      </button>
                    );
                  })}
                </div>
                <button
                  className="settings-button"
                  onClick={() => setDialog("settings")}
                >
                  <Settings2 size={16} />
                  <span>Settings</span>
                  <span className="version-label">
                    v{snapshot.appVersion.replace("-preview", "")}
                  </span>
                </button>
              </div>
            </aside>
            <ResizeHandle
              label="Resize project sidebar"
              value={layout.navigationWidth}
              min={190}
              max={360}
              onChange={(value) =>
                setLayout((current) => ({ ...current, navigationWidth: value }))
              }
            />
          </>
        )}

        <main className="main-pane">
          <div className="conversation-toolbar">
            <button
              className="icon-button"
              aria-label={
                layout.navigation
                  ? "Hide project sidebar"
                  : "Show project sidebar"
              }
              onClick={() =>
                setLayout((current) => ({
                  ...current,
                  navigation: !current.navigation,
                }))
              }
            >
              {layout.navigation ? (
                <PanelLeftClose size={17} />
              ) : (
                <PanelLeftOpen size={17} />
              )}
            </button>
            <div className="toolbar-breadcrumb">
              <span>{project?.name ?? "Workspace"}</span>
              <ChevronRight size={12} />
              <strong>{thread?.title ?? "New thread"}</strong>
            </div>
            <div className="toolbar-actions">
              {project && (
                <span
                  className="branch-label"
                  title={thread?.branch ?? project.branch}
                >
                  <GitBranch size={12} />
                  {thread?.branch ?? project.branch}
                </span>
              )}
              {project && (
                <button
                  className="icon-button"
                  aria-label="Open project folder"
                  title="Open project folder"
                  onClick={() =>
                    void runAction(() => api.openProject(project.id))
                  }
                >
                  <FolderOpen size={16} />
                </button>
              )}
              <button
                className="icon-button"
                aria-label={
                  layout.inspector ? "Hide inspector" : "Show inspector"
                }
                onClick={() =>
                  setLayout((current) => ({
                    ...current,
                    inspector: !current.inspector,
                  }))
                }
              >
                {layout.inspector ? (
                  <PanelRightClose size={17} />
                ) : (
                  <PanelRightOpen size={17} />
                )}
              </button>
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <AlertCircle size={16} />
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {thread?.archivedAt && (
            <div className="archived-banner">
              <span>This conversation is archived.</span>
              <button
                className="text-button"
                onClick={() =>
                  void runAction(async () => {
                    await api.updateThread({ id: thread.id, archived: false });
                    setArchived(false);
                  })
                }
              >
                Restore to continue
              </button>
            </div>
          )}
          <div
            className={`conversation-scroll ${runs.length ? "has-runs" : ""}`}
            ref={timeline}
            onScroll={() => {
              const element = timeline.current;
              if (element)
                setAutoScroll(
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                    80,
                );
            }}
          >
            {loading ? (
              <div className="loading-state" role="status">
                <div className="skeleton-line" />
                <div className="skeleton-line short" />
                <span>Opening workspace…</span>
              </div>
            ) : runs.length ? (
              <div className="conversation-content">
                {runs.map((run) => (
                  <RunCard
                    key={run.id}
                    run={run}
                    onMemory={() => showPanel("memory")}
                  />
                ))}
              </div>
            ) : (
              <section className="welcome">
                <h1>
                  {project ? "What are we working on?" : "Start with a project"}
                </h1>
                <p className="welcome-description">
                  {project
                    ? "Describe a change, ask a question, or plan the next step."
                    : "Open a local Git repository to work with Codex, Claude, or a local model."}
                </p>
                {project ? (
                  <div className="welcome-project">
                    <Folder size={14} />
                    <span>{project.name}</span>
                    <span className="welcome-project-path">{project.path}</span>
                  </div>
                ) : (
                  <button
                    className="primary-button open-project-cta"
                    onClick={() => void addProject()}
                  >
                    <FolderOpen size={16} />
                    {isPreview ? "Open example project" : "Open a project"}
                  </button>
                )}
                <div className="starter-list">
                  {starters.map((starter) => (
                    <button
                      key={starter.title}
                      onClick={() => {
                        setDraft(starter.prompt);
                        setMode("plan");
                        composer.current?.focus();
                      }}
                    >
                      <span>{starter.title}</span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
                <p className="welcome-safety">
                  Plan first. Build in a separate worktree. Review the evidence
                  before integrating.
                </p>
              </section>
            )}
          </div>
          {!autoScroll && runs.length > 0 && (
            <button
              className="scroll-bottom"
              aria-label="Scroll to latest message"
              onClick={() => {
                setAutoScroll(true);
                timeline.current?.scrollTo({
                  top: timeline.current.scrollHeight,
                  behavior: "smooth",
                });
              }}
            >
              <ArrowDown size={15} />
            </button>
          )}
          <form
            className="composer-area"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {activeRun && (
              <div className="active-run-line" role="status">
                <LoaderCircle size={12} className="spin" />
                <span>
                  {providerNames[activeRun.provider]} is working
                  {activeRun.mode === "build"
                    ? " in a separate worktree"
                    : " in Plan mode"}
                </span>
              </div>
            )}
            <div className="composer">
              <textarea
                ref={composer}
                aria-label="Message your coding agent"
                placeholder={
                  thread?.archivedAt
                    ? "Restore this conversation to continue…"
                    : project
                      ? "Ask about this project or describe a change…"
                      : "Open a project to begin…"
                }
                disabled={!!thread?.archivedAt}
                rows={2}
                value={draft}
                maxLength={32000}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
              <div className="composer-controls">
                <div className="composer-provider">
                  <ProviderMark provider={provider} small />
                  <select
                    aria-label="Choose agent"
                    value={provider}
                    onChange={(event) =>
                      changeProvider(event.target.value as ProviderId)
                    }
                  >
                    <option value="codex">Codex</option>
                    <option value="claude">Claude Code</option>
                    <option value="ollama">Local · Ollama</option>
                  </select>
                </div>
                <input
                  className="model-input"
                  aria-label="Model override"
                  title="Optional model name; leave empty to use the provider default"
                  placeholder={
                    provider === "ollama"
                      ? state.settings.localModel || "Local model name"
                      : "Provider default"
                  }
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
                <div className="composer-right">
                  <div
                    className="mode-switch"
                    role="group"
                    aria-label="Run mode"
                  >
                    <button
                      type="button"
                      className={mode === "plan" ? "active" : ""}
                      aria-pressed={mode === "plan"}
                      onClick={() => setMode("plan")}
                    >
                      Plan
                    </button>
                    <button
                      type="button"
                      className={mode === "build" ? "active" : ""}
                      aria-pressed={mode === "build"}
                      onClick={() => setMode("build")}
                    >
                      Build
                    </button>
                  </div>
                  {activeRun ? (
                    <button
                      type="button"
                      className="send-button stop-button"
                      aria-label="Stop current run"
                      onClick={() =>
                        void runAction(() => api.cancelRun(activeRun.id))
                      }
                    >
                      <Square size={14} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="send-button"
                      aria-label="Send message"
                      title="Send · Ctrl+Enter"
                      disabled={!canSend}
                    >
                      {busy ? (
                        <LoaderCircle size={17} className="spin" />
                      ) : (
                        <ArrowUp size={17} />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="composer-caption">
              <span>
                {!project ? (
                  "Choose a local Git repository."
                ) : provider === "ollama" && !configuredModel ? (
                  "Enter an installed local model name."
                ) : !activeProvider?.available ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setDialog("settings")}
                  >
                    {isPreview
                      ? "Preview only — agents are not connected."
                      : `${providerNames[provider]} not detected. Open settings.`}
                  </button>
                ) : mode === "plan" ? (
                  "Plan · no source edits requested"
                ) : (
                  "Build · separate worktree, explicit confirmation"
                )}
              </span>
              <button
                type="button"
                className="text-button context-trigger"
                disabled={!project}
                onClick={() => showPanel("context")}
              >
                Preview context
              </button>
              <span className="keyboard-hint">
                <kbd>Ctrl ↵</kbd>
              </span>
            </div>
          </form>
        </main>

        {layout.inspector && (
          <>
            <div className="inspector-resize">
              <ResizeHandle
                label="Resize inspector"
                value={layout.inspectorWidth}
                min={300}
                max={560}
                direction={-1}
                onChange={(value) =>
                  setLayout((current) => ({
                    ...current,
                    inspectorWidth: value,
                  }))
                }
              />
            </div>
            <aside className="inspector" aria-label="Project inspector">
              <div className="inspector-header">
                <div
                  className="inspector-tabs"
                  role="tablist"
                  aria-label="Inspector"
                >
                  {tabs.map((item) => (
                    <button
                      key={item.id}
                      id={`inspector-tab-${item.id}`}
                      role="tab"
                      aria-selected={tab === item.id}
                      aria-controls={`inspector-panel-${item.id}`}
                      tabIndex={tab === item.id ? 0 : -1}
                      className={tab === item.id ? "active" : ""}
                      onClick={() => setTab(item.id)}
                      onKeyDown={(event) => {
                        const index = tabs.findIndex(
                          (candidate) => candidate.id === tab,
                        );
                        const next =
                          event.key === "ArrowRight"
                            ? tabs[(index + 1) % tabs.length]
                            : event.key === "ArrowLeft"
                              ? tabs[(index + tabs.length - 1) % tabs.length]
                              : null;
                        if (next) {
                          event.preventDefault();
                          setTab(next.id);
                          document
                            .getElementById(`inspector-tab-${next.id}`)
                            ?.focus();
                        }
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <button
                  className="inspector-close icon-button"
                  aria-label="Close inspector"
                  onClick={() =>
                    setLayout((current) => ({ ...current, inspector: false }))
                  }
                >
                  <X size={15} />
                </button>
              </div>
              <div
                className="inspector-content"
                role="tabpanel"
                id={`inspector-panel-${tab}`}
                aria-labelledby={`inspector-tab-${tab}`}
                tabIndex={0}
              >
                {tab === "changes" && (
                  <>
                    <div className="inspector-section-top">
                      <h3>{diff?.changes.length ?? 0} changed files</h3>
                      <button
                        className="icon-button"
                        onClick={() => void refreshDiff()}
                        disabled={!latestRun || diffLoading}
                        aria-label="Refresh changes"
                      >
                        <RefreshCw
                          size={14}
                          className={diffLoading ? "spin" : ""}
                        />
                      </button>
                    </div>
                    {diffError && <p className="form-error">{diffError}</p>}
                    {diffLoading && !diff && (
                      <p className="panel-loading">Reading changes…</p>
                    )}
                    {!diffLoading &&
                      !diffError &&
                      (!diff || diff.changes.length === 0) && (
                        <EmptyPanel title="A clean starting point">
                          Changes from the selected run appear here. Review the
                          worktree diff before integrating.
                        </EmptyPanel>
                      )}
                    {diff && diff.changes.length > 0 && (
                      <>
                        <div className="changed-files">
                          {diff.changes.map((change) => (
                            <div className="changed-file" key={change.path}>
                              <FileCode2 size={13} />
                              <span title={change.path}>{change.path}</span>
                              <span className="file-status">
                                {change.status}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="diff-header">
                          <GitBranch size={12} />
                          <span>{diff.branch}</span>
                        </div>
                        <pre
                          className="diff-view"
                          aria-label="Git diff"
                          tabIndex={0}
                        >
                          {diff.diff.split("\n").map((line, index) => (
                            <span
                              key={index}
                              className={
                                line.startsWith("+") && !line.startsWith("+++")
                                  ? "diff-added"
                                  : line.startsWith("-") &&
                                      !line.startsWith("---")
                                    ? "diff-removed"
                                    : line.startsWith("@@")
                                      ? "diff-hunk"
                                      : ""
                              }
                            >
                              {line}
                              {"\n"}
                            </span>
                          ))}
                        </pre>
                        {diff.truncated && (
                          <p className="panel-note">
                            Diff output was capped. Open the worktree to inspect
                            all changes.
                          </p>
                        )}
                      </>
                    )}
                    {latestRun?.worktreePath && (
                      <button
                        className="secondary-button full-width reveal-worktree"
                        onClick={() =>
                          void runAction(() => api.revealWorktree(latestRun.id))
                        }
                      >
                        <FolderOpen size={14} />
                        Open worktree
                      </button>
                    )}
                    <div className="inspector-bottom-note">
                      <ShieldCheck size={15} />
                      <p>
                        No automatic merge or push. Integration stays under your
                        control.
                      </p>
                    </div>
                  </>
                )}
                {tab === "context" && (
                  <ContextPanel
                    preview={context}
                    loading={contextLoading}
                    error={contextError}
                    hasProject={!!project}
                    hasPrompt={!!draft.trim()}
                    onRefresh={() => setContextRefresh((value) => value + 1)}
                  />
                )}
                {tab === "memory" && (
                  <>
                    <div className="inspector-section-top">
                      <h3>Shared project memory</h3>
                      <div className="inline-actions">
                        <button
                          className="icon-button"
                          aria-label="Refresh memory sources"
                          disabled={!project || contextLoading}
                          onClick={() =>
                            setContextRefresh((value) => value + 1)
                          }
                        >
                          <RefreshCw
                            size={14}
                            className={contextLoading ? "spin" : ""}
                          />
                        </button>
                        <button
                          className="icon-button"
                          disabled={!project}
                          aria-label="Add project memory"
                          onClick={() => editMemory()}
                        >
                          <Plus size={15} />
                        </button>
                      </div>
                    </div>
                    <p className="panel-intro">
                      Decisions and constraints shared between agents. Source
                      unchanged means the file matches its saved fingerprint,
                      not that the note is proven true.
                    </p>
                    {contextError && (
                      <p className="form-error">{contextError}</p>
                    )}
                    {activeMemories.length ? (
                      <div className="memory-list">
                        {activeMemories.map((entry) => (
                          <MemoryCard
                            key={entry.id}
                            entry={entry}
                            context={context?.memories.find(
                              (item) => item.id === entry.id,
                            )}
                            checking={contextLoading}
                            onEdit={() => editMemory(entry)}
                            onArchive={() =>
                              void runAction(() => api.archiveMemory(entry.id))
                            }
                          />
                        ))}
                      </div>
                    ) : (
                      <EmptyPanel title="Keep the important parts">
                        Add a decision, constraint, or note. Link a source file
                        when the knowledge depends on code.
                      </EmptyPanel>
                    )}
                    <button
                      className="secondary-button full-width"
                      disabled={!project}
                      onClick={() => editMemory()}
                    >
                      <Plus size={14} />
                      Add a memory
                    </button>
                    <p className="panel-note">
                      Saving a note reconfirms the original checkout, not
                      worktree-only edits. Changed worktree sources remain
                      excluded until they match. Unlinked notes may be included
                      with a warning.
                    </p>
                  </>
                )}
                {tab === "checks" && (
                  <ChecksPanel
                    projectId={project?.id}
                    run={latestRun}
                    state={state}
                    onError={setError}
                  />
                )}
                {tab === "activity" && (
                  <>
                    <div className="inspector-section-top">
                      <h3>Latest run</h3>
                      {latestRun && (
                        <span>{formatTime(latestRun.createdAt)}</span>
                      )}
                    </div>
                    {latestRun ? (
                      <>
                        <div className="activity-summary">
                          <ProviderMark provider={latestRun.provider} small />
                          <div>
                            <strong>{providerNames[latestRun.provider]}</strong>
                            <p>{statusLabel(latestRun)}</p>
                          </div>
                        </div>
                        <div className="activity-list">
                          {activityEvents.map((event) => (
                            <div
                              key={event.id}
                              className={`activity-event activity-${event.kind}`}
                            >
                              <span className="activity-dot" />
                              <div>
                                <time dateTime={event.at}>
                                  {formatTime(event.at)}
                                </time>
                                <p>{event.text}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="verification-note">
                          <ShieldCheck size={16} />
                          <strong>Task not automatically verified</strong>
                          <p>
                            A completed agent process is not proof of
                            correctness. Use Checks to inspect independent
                            command results.
                          </p>
                          <button
                            className="text-button"
                            onClick={() => setTab("checks")}
                          >
                            Open checks
                          </button>
                        </div>
                      </>
                    ) : (
                      <EmptyPanel title="See the work as it happens">
                        Tool events, status updates, and failures appear here
                        when you start a run.
                      </EmptyPanel>
                    )}
                  </>
                )}
              </div>
              <div className="inspector-footer">
                {isPreview ? "Sample data only" : "Stored on this device"}
              </div>
            </aside>
          </>
        )}
      </div>
      {dialog === "settings" && (
        <SettingsForm
          settings={state.settings}
          providers={providers}
          onClose={() => setDialog(null)}
          onSaved={refreshSnapshot}
        />
      )}
      {dialog === "memory" && project && (
        <MemoryForm
          projectId={project.id}
          entry={editingMemory}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "rename" && editingThread && (
        <RenameThreadForm
          thread={editingThread}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "palette" && (
        <CommandPalette
          projects={state.projects}
          threads={state.threads}
          canCreateThread={!!project}
          onProject={selectProject}
          onThread={selectThread}
          onNewThread={newThread}
          onOpenProject={() => void addProject()}
          onSettings={() => setDialog("settings")}
          onClose={() => setDialog(null)}
        />
      )}
      {threadMenu && (
        <ThreadMenu
          thread={threadMenu.thread}
          anchor={threadMenu.anchor}
          onClose={() => setThreadMenu(null)}
          onRename={() => {
            setEditingThread(threadMenu.thread);
            setThreadMenu(null);
            setDialog("rename");
          }}
          onPin={() =>
            menuAction(() =>
              api.updateThread({
                id: threadMenu.thread.id,
                pinned: !threadMenu.thread.pinned,
              }),
            )
          }
          onArchive={() =>
            menuAction(() =>
              api.updateThread({
                id: threadMenu.thread.id,
                archived: !threadMenu.thread.archivedAt,
              }),
            )
          }
        />
      )}
    </div>
  );
}
