import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  ExternalLink,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  Layers3,
  LoaderCircle,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  SquarePen,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { emptyWorkspace } from "../shared/types";
import type {
  DiffSnapshot,
  MemoryEntry,
  MemoryInput,
  MemoryKind,
  ProviderId,
  ProviderStatus,
  Run,
  RunMode,
  Settings,
  WorkspaceSnapshot,
} from "../shared/types";
import { api, isPreview } from "./bridge";

type InspectorTab = "changes" | "memory" | "activity";
type Dialog = "settings" | "memory" | null;

const providerNames: Record<ProviderId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  ollama: "Local · Ollama",
};
const providerMarks: Record<ProviderId, string> = {
  codex: "C",
  claude: "✳",
  ollama: "L",
};
const starters = [
  {
    icon: BookOpen,
    title: "Understand this project",
    description: "Map the architecture and conventions",
    prompt:
      "Explore this project and explain its architecture, important entry points, and existing development conventions. Do not change files.",
  },
  {
    icon: Layers3,
    title: "Plan the next milestone",
    description: "Find a small, testable starting point",
    prompt:
      "Help me plan the next development milestone for this project. Identify the smallest useful implementation and concrete checks that would verify it.",
  },
  {
    icon: FileCode2,
    title: "Review the current code",
    description: "Find risks before making changes",
    prompt:
      "Review this project's current code for likely correctness issues. Prioritize findings with concrete evidence and propose tests. Do not change files.",
  },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isActive(run: Run): boolean {
  return run.status === "queued" || run.status === "running";
}

function statusLabel(run: Run): string {
  if (run.status === "completed") return "Finished · not verified";
  return {
    queued: "Queued",
    running: "Working",
    failed: "Failed",
    cancelled: "Stopped",
    interrupted: "Interrupted",
  }[run.status];
}

function NovaMark({ large = false }: { large?: boolean }) {
  return (
    <span
      className={`nova-mark ${large ? "nova-mark-large" : ""}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 32 32" fill="none">
        <path
          d="M7 24V8l18 16V8"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M16 5v5M16 22v5M4 16h5M23 16h5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity=".48"
        />
      </svg>
    </span>
  );
}

function ProviderMark({
  provider,
  small = false,
}: {
  provider: ProviderId;
  small?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`provider-mark provider-${provider} ${small ? "small" : ""}`}
    >
      {providerMarks[provider]}
    </span>
  );
}

function EmptyPanel({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty-panel">
      <span className="empty-panel-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog
      ?.querySelector<HTMLElement>("input, textarea, select, button")
      ?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key !== "Tab" || !dialog) return;
      const elements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ),
      );
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "modal-wide" : ""}`}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function MessageText({ text }: { text: string }) {
  // Render model output as text, never trusted HTML. Fences are visual only.
  const parts = text.split(/(```[\s\S]*?```)/g);
  return (
    <div className="message-text">
      {parts.map((part, index) => {
        if (part.startsWith("```")) {
          const body = part.slice(3, -3);
          const lineBreak = body.indexOf("\n");
          const language =
            lineBreak >= 0 ? body.slice(0, lineBreak).trim() : "";
          const code = lineBreak >= 0 ? body.slice(lineBreak + 1) : body;
          return (
            <div className="code-block" key={index}>
              {language && <div className="code-language">{language}</div>}
              <pre>
                <code>{code}</code>
              </pre>
            </div>
          );
        }
        return (
          <div className="message-prose" key={index}>
            {part}
          </div>
        );
      })}
    </div>
  );
}

function RunCard({ run, onInspect }: { run: Run; onInspect: () => void }) {
  const messages = run.events.filter((event) => event.kind === "message");
  const tools = run.events.filter((event) => event.kind === "tool");
  const statusEvents = run.events.filter((event) => event.kind === "status");
  const errors = run.events.filter((event) => event.kind === "error");
  const active = isActive(run);

  return (
    <article className="run-card">
      <div className="user-message">
        <div className="message-overline">
          <span>You</span>
          <time dateTime={run.createdAt}>{formatTime(run.createdAt)}</time>
        </div>
        <p>{run.prompt}</p>
      </div>
      <div className="agent-message">
        <div className="agent-heading">
          <ProviderMark provider={run.provider} />
          <strong>{providerNames[run.provider]}</strong>
          <span className="agent-model">{run.model || "Provider default"}</span>
          <span className="run-mode-label">
            {run.mode === "plan" ? "Plan" : "Build"}
          </span>
        </div>
        {tools.length > 0 && (
          <details className="tool-group">
            <summary>
              <Terminal size={14} />
              <span>
                {tools.length} tool {tools.length === 1 ? "event" : "events"}
              </span>
              <ChevronDown size={13} />
            </summary>
            <div className="tool-event-list">
              {tools.map((event) => (
                <pre key={event.id}>{event.text}</pre>
              ))}
            </div>
          </details>
        )}
        {messages.map((event) => (
          <MessageText key={event.id} text={event.text} />
        ))}
        {!messages.length && active && (
          <div className="thinking-state">
            <span className="thinking-dots">
              <i />
              <i />
              <i />
            </span>
            <span>
              {statusEvents.at(-1)?.text ?? "Waiting for the agent’s response…"}
            </span>
          </div>
        )}
        {!messages.length && !active && !run.error && !errors.length && (
          <p className="muted">
            This run ended without a text response. Check Activity for details.
          </p>
        )}
        {(run.error || errors.length > 0) && (
          <div className="run-error">
            <AlertCircle size={16} />
            <div>{run.error || errors.at(-1)?.text}</div>
          </div>
        )}
        <div className="run-footer">
          <span className={`run-state run-state-${run.status}`}>
            {active ? (
              <LoaderCircle className="spin" size={12} />
            ) : run.status === "completed" ? (
              <Check size={12} />
            ) : (
              <Clock3 size={12} />
            )}
            {statusLabel(run)}
          </span>
          <button onClick={onInspect} className="text-button">
            <Brain size={12} />
            {run.contextMemoryIds.length} memories
          </button>
          {run.usage && (
            <span className="token-count">
              {(
                (run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0)
              ).toLocaleString()}{" "}
              tokens
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function SettingsForm({
  settings,
  providers,
  onClose,
  onSaved,
}: {
  settings: Settings;
  providers: ProviderStatus[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState({ ...settings });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.updateSettings(values);
      await onSaved();
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Workbench settings"
      subtitle="Your tools, your models, your boundaries."
      onClose={onClose}
      wide
    >
      <form onSubmit={save} className="settings-form">
        <div className="settings-callout">
          <ShieldCheck size={18} />
          <p>
            Sign in through the official CLI tools. Workbench does not collect
            API keys or account tokens. Provider usage limits still apply.
          </p>
        </div>
        <section>
          <h3>Agent runtimes</h3>
          <div className="settings-provider-list">
            {providers.map((provider) => (
              <div className="settings-provider" key={provider.id}>
                <ProviderMark provider={provider.id} small />
                <strong>{provider.name}</strong>
                <span
                  className={`provider-state ${provider.available ? "ready" : ""}`}
                >
                  {provider.available ? "Detected" : "Not detected"}
                </span>
              </div>
            ))}
          </div>
          <label className="field">
            <span>Codex executable</span>
            <input
              value={values.codexPath}
              onChange={(event) =>
                setValues({ ...values, codexPath: event.target.value })
              }
              placeholder="codex or an absolute executable path"
              required
            />
            <small>
              Also powers local-model runs through Codex’s Ollama provider.
            </small>
          </label>
          <label className="field">
            <span>Claude Code executable</span>
            <input
              value={values.claudePath}
              onChange={(event) =>
                setValues({ ...values, claudePath: event.target.value })
              }
              placeholder="claude or an absolute executable path"
              required
            />
          </label>
          <label className="field">
            <span>Default local model</span>
            <input
              value={values.localModel}
              onChange={(event) =>
                setValues({ ...values, localModel: event.target.value })
              }
              placeholder="An installed Ollama model name"
            />
            <small>
              Use a model you have already installed. No model is downloaded
              automatically by Workbench.
            </small>
          </label>
        </section>
        <section>
          <h3>Run boundaries</h3>
          <div className="field-row">
            <label className="field">
              <span>Timeout · minutes</span>
              <input
                type="number"
                min={1}
                max={120}
                required
                value={values.timeoutMinutes}
                onChange={(event) =>
                  setValues({
                    ...values,
                    timeoutMinutes: Number(event.target.value),
                  })
                }
              />
            </label>
            <label className="field">
              <span>Output limit · KiB</span>
              <input
                type="number"
                min={64}
                max={4096}
                required
                value={values.maxOutputKb}
                onChange={(event) =>
                  setValues({
                    ...values,
                    maxOutputKb: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
          <p className="field-hint">
            These limits stop runaway processes. They are not token or billing
            caps.
          </p>
        </section>
        <section>
          <h3>Appearance</h3>
          <label className="field">
            <span>Theme</span>
            <select
              value={values.theme}
              onChange={(event) =>
                setValues({
                  ...values,
                  theme: event.target.value as Settings["theme"],
                })
              }
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">Use system setting</option>
            </select>
          </label>
        </section>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={saving} type="submit">
            {saving && <LoaderCircle className="spin" size={15} />}Save settings
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MemoryForm({
  projectId,
  entry,
  onClose,
}: {
  projectId: string;
  entry?: MemoryEntry;
  onClose: () => void;
}) {
  const [values, setValues] = useState<MemoryInput>(
    entry
      ? {
          id: entry.id,
          projectId,
          title: entry.title,
          content: entry.content,
          kind: entry.kind,
          source: entry.source,
        }
      : {
          projectId,
          title: "",
          content: "",
          kind: "decision",
          source: "User-provided project knowledge",
        },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.saveMemory(values);
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={entry ? "Edit project memory" : "Add project memory"}
      subtitle="Keep the decisions worth carrying into the next conversation."
      onClose={onClose}
    >
      <form onSubmit={save}>
        <label className="field">
          <span>Title</span>
          <input
            maxLength={160}
            required
            value={values.title}
            onChange={(event) =>
              setValues({ ...values, title: event.target.value })
            }
            placeholder="e.g. Keep physics deterministic"
          />
        </label>
        <label className="field">
          <span>Type</span>
          <select
            value={values.kind}
            onChange={(event) =>
              setValues({ ...values, kind: event.target.value as MemoryKind })
            }
          >
            <option value="decision">Decision</option>
            <option value="constraint">Constraint</option>
            <option value="note">Note</option>
          </select>
        </label>
        <label className="field">
          <span>What should the agents know?</span>
          <textarea
            required
            rows={5}
            maxLength={8000}
            value={values.content}
            onChange={(event) =>
              setValues({ ...values, content: event.target.value })
            }
            placeholder="Be specific. Include the reason or the evidence when you can."
          />
        </label>
        <label className="field">
          <span>Source or reference</span>
          <input
            required
            maxLength={500}
            value={values.source}
            onChange={(event) =>
              setValues({ ...values, source: event.target.value })
            }
            placeholder="Document, file path, test result, or your decision"
          />
          <small>
            Active memories are included in a bounded context pack for future
            runs. Do not store credentials or secrets.
          </small>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={saving}>
            {saving && <LoaderCircle size={15} className="spin" />}Save memory
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MemoryCard({
  entry,
  onArchive,
  onEdit,
}: {
  entry: MemoryEntry;
  onArchive: () => void;
  onEdit: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <article className="memory-card">
      <div className="memory-card-meta">
        <span className={`memory-kind memory-kind-${entry.kind}`}>
          {entry.kind}
        </span>
        <div className="memory-card-actions">
          <button className="text-button archive-button" onClick={onEdit}>
            Edit
          </button>
          <button
            className="text-button archive-button"
            onClick={() => {
              if (confirm) onArchive();
              else setConfirm(true);
            }}
            onBlur={() => setConfirm(false)}
            title="Archive this memory"
          >
            {confirm ? "Confirm archive" : "Archive"}
          </button>
        </div>
      </div>
      <h3>{entry.title}</h3>
      <p>{entry.content}</p>
      <div className="memory-source">
        <BookOpen size={12} />
        <span>{entry.source}</span>
      </div>
      {entry.commit && (
        <div className="memory-commit">
          <GitBranch size={11} />
          Recorded at {entry.commit.slice(0, 8)} · check freshness
        </div>
      )}
    </article>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>({
    state: emptyWorkspace(),
    providers: [],
    appVersion: "0.1.0",
    platform: "",
  });
  const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProviderId>("codex");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<RunMode>("plan");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<InspectorTab>("changes");
  const [inspector, setInspector] = useState(() => window.innerWidth >= 1100);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editingMemory, setEditingMemory] = useState<MemoryEntry | undefined>(
    undefined,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<DiffSnapshot | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
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
              .filter((item) => item.projectId === first.id)
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

  const refreshDiff = async (runId = latestRun?.id) => {
    const requestId = ++diffRequestId.current;
    if (!runId) {
      setDiff(null);
      setDiffError("");
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
    let alive = true;
    const requestId = ++diffRequestId.current;
    setDiff(null);
    setDiffError("");
    if (!latestRun) {
      setDiffLoading(false);
      return;
    }
    setDiffLoading(true);
    api
      .getDiff(latestRun.id)
      .then((value) => {
        if (alive && requestId === diffRequestId.current) setDiff(value);
      })
      .catch((reason) => {
        if (alive && requestId === diffRequestId.current)
          setDiffError(errorText(reason));
      })
      .finally(() => {
        if (alive && requestId === diffRequestId.current) setDiffLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [latestRun?.id, latestRun?.status]);

  const addProject = async () => {
    try {
      const chosen = await api.chooseProject();
      if (chosen) {
        await refreshSnapshot();
        setProjectId(chosen.id);
        setThreadId(null);
        setDraft("");
      }
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const selectProject = (id: string) => {
    setProjectId(id);
    setThreadId(
      state.threads
        .filter((item) => item.projectId === id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null,
    );
    setDraft("");
    setAutoScroll(true);
  };

  const newThread = () => {
    setThreadId(null);
    setDraft("");
    setAutoScroll(true);
    composer.current?.focus();
  };

  const startRun = async () => {
    if (!project || !draft.trim() || busy || activeRun) return;
    setBusy(true);
    setError("");
    setDialog(null);
    try {
      const run = await api.startRun({
        projectId: project.id,
        threadId: threadId ?? undefined,
        provider,
        model: configuredModel || undefined,
        mode,
        prompt: draft.trim(),
      });
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

  const submit = () => {
    if (!project || !draft.trim() || busy || activeRun) return;
    // The main process owns the native Build confirmation; the renderer cannot bypass it.
    void startRun();
  };

  const openMemoryForm = (entry?: MemoryEntry) => {
    setEditingMemory(entry);
    setDialog("memory");
  };

  const changeProvider = (value: ProviderId) => {
    setProvider(value);
    setModel("");
  };
  const runAction = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  const canSend =
    !!project &&
    !!draft.trim() &&
    !busy &&
    !activeRun &&
    (!!activeProvider?.available || isPreview) &&
    (provider !== "ollama" || !!configuredModel);
  const activityEvents =
    latestRun?.events.filter((event) => event.kind !== "message") ?? [];

  return (
    <div className={`workbench ${inspector ? "with-inspector" : ""}`}>
      <header className="titlebar">
        <div className="titlebar-brand">
          <NovaMark />
          <span>
            Nova <strong>Workbench</strong>
          </span>
          <span className="alpha-label">ALPHA</span>
        </div>
        <div className="titlebar-status">
          <span className="subtle-dot" />
          {isPreview ? "Interface preview" : "Local workspace"}
        </div>
        <div className="titlebar-native-space" aria-hidden="true" />
      </header>
      {isPreview && (
        <div className="preview-banner">
          <Code2 size={13} />
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
            <ArrowUpRight size={12} />
          </button>
        </div>
      )}
      <div className="workspace-body">
        <aside className="sidebar" aria-label="Project navigation">
          <div className="sidebar-top">
            <button
              className="new-thread-button"
              onClick={newThread}
              disabled={!project}
            >
              <SquarePen size={16} />
              <span>New thread</span>
              <span className="button-hint">＋</span>
            </button>
            <label className="sidebar-search">
              <Search size={14} />
              <input
                aria-label="Search projects and threads"
                placeholder="Find a conversation"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          <div className="sidebar-section-title">
            <span>PROJECTS</span>
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
                <Folder size={24} strokeWidth={1.3} />
                <p>
                  Your next idea
                  <br />
                  starts with a project.
                </p>
                <button
                  className="text-button"
                  onClick={() => void addProject()}
                >
                  Open a repository
                  <ArrowUpRight size={12} />
                </button>
              </div>
            )}
            {state.projects.map((item) => {
              const matchingThreads = state.threads
                .filter(
                  (entry) =>
                    entry.projectId === item.id &&
                    entry.title.toLowerCase().includes(query.toLowerCase()),
                )
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
              const visible =
                !query ||
                item.name.toLowerCase().includes(query.toLowerCase()) ||
                matchingThreads.length > 0;
              if (!visible) return null;
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
                  {(projectId === item.id || query) && (
                    <div className="thread-list">
                      {matchingThreads.map((entry) => {
                        const running = state.runs.some(
                          (run) => run.threadId === entry.id && isActive(run),
                        );
                        return (
                          <button
                            key={entry.id}
                            className={`thread-button ${threadId === entry.id ? "selected" : ""}`}
                            onClick={() => {
                              setProjectId(item.id);
                              setThreadId(entry.id);
                              setAutoScroll(true);
                              setDraft("");
                            }}
                          >
                            {running ? (
                              <span className="working-dot" />
                            ) : (
                              <MessageSquare size={12} />
                            )}
                            <span>{entry.title}</span>
                          </button>
                        );
                      })}
                      {matchingThreads.length === 0 && (
                        <span className="no-threads">
                          {query
                            ? "No matching conversations"
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
              <span>YOUR AGENTS</span>
              <button
                className="icon-button"
                onClick={() =>
                  void runAction(async () =>
                    setSnapshot(await api.refreshProviderStatus()),
                  )
                }
                aria-label="Refresh agent availability"
                title="Refresh agent availability"
              >
                <RefreshCw size={13} />
              </button>
            </div>
            <div className="agent-list">
              {(["codex", "claude", "ollama"] as ProviderId[]).map((id) => {
                const runtime = providers.find((item) => item.id === id);
                return (
                  <button
                    key={id}
                    className={`agent-option ${provider === id ? "selected" : ""}`}
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

        <main className="main-pane">
          <div className="conversation-toolbar">
            <div className="toolbar-breadcrumb">
              <span>{project?.name ?? "Your workspace"}</span>
              <ChevronRight size={13} />
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
                  title="Open project folder"
                  aria-label="Open project folder"
                  onClick={() =>
                    void runAction(() => api.openProject(project.id))
                  }
                >
                  <FolderOpen size={16} />
                </button>
              )}
              <button
                className="icon-button"
                aria-label={inspector ? "Hide inspector" : "Show inspector"}
                title={inspector ? "Hide inspector" : "Show inspector"}
                onClick={() => setInspector(!inspector)}
              >
                {inspector ? (
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
              <div className="loading-state">
                <LoaderCircle size={22} className="spin" />
                <p>Opening your workbench…</p>
              </div>
            ) : runs.length ? (
              <div className="conversation-content">
                {runs.map((run) => (
                  <RunCard
                    key={run.id}
                    run={run}
                    onInspect={() => {
                      setInspector(true);
                      setTab("memory");
                    }}
                  />
                ))}
              </div>
            ) : (
              <section className="welcome">
                <div className="welcome-eyebrow">
                  <NovaMark large />
                  <span>MAKE ROOM FOR YOUR NEXT IDEA</span>
                </div>
                <h1>
                  One workspace.
                  <br />
                  <span>More ways to build.</span>
                </h1>
                <p className="welcome-description">
                  Bring Codex, Claude, and local models to the same project.
                  <br className="desktop-break" /> Keep the context. Stay in
                  control of the changes.
                </p>
                {project ? (
                  <div className="welcome-project">
                    <Folder size={14} />
                    <span>{project.name}</span>
                    <span className="welcome-project-separator" />
                    <GitBranch size={12} />
                    <span>{project.branch}</span>
                  </div>
                ) : (
                  <button
                    className="primary-button open-project-cta"
                    onClick={() => void addProject()}
                  >
                    <FolderOpen size={16} />
                    {isPreview ? "Open example project" : "Open a project"}
                    <ArrowUpRight size={15} />
                  </button>
                )}
                <div className="starter-grid">
                  {starters.map((item) => (
                    <button
                      className="starter-card"
                      key={item.title}
                      onClick={() => {
                        setDraft(item.prompt);
                        setMode("plan");
                        composer.current?.focus();
                      }}
                    >
                      <item.icon size={19} strokeWidth={1.5} />
                      <strong>{item.title}</strong>
                      <span>{item.description}</span>
                      <ArrowUpRight size={13} className="starter-arrow" />
                    </button>
                  ))}
                </div>
                <div className="welcome-safety">
                  <ShieldCheck size={13} />
                  <span>
                    Read-only plans. Isolated builds. No automatic merges.
                  </span>
                </div>
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
          <div className="composer-area">
            {activeRun && (
              <div className="active-run-line">
                <LoaderCircle size={12} className="spin" />
                <span>
                  {providerNames[activeRun.provider]} is working
                  {activeRun.mode === "build"
                    ? " in an isolated worktree"
                    : " in plan mode"}
                </span>
              </div>
            )}
            <div
              className={`composer ${busy || activeRun ? "composer-busy" : ""}`}
            >
              <textarea
                ref={composer}
                aria-label="Message your coding agent"
                placeholder={
                  project
                    ? "What would you like to build?"
                    : "Open a project, then tell us what’s next…"
                }
                rows={3}
                value={draft}
                maxLength={32000}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === "Enter" &&
                    canSend
                  ) {
                    event.preventDefault();
                    submit();
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
                  <ChevronDown size={12} />
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
                      className={mode === "plan" ? "active" : ""}
                      aria-pressed={mode === "plan"}
                      onClick={() => setMode("plan")}
                    >
                      <BookOpen size={12} />
                      Plan
                    </button>
                    <button
                      className={mode === "build" ? "active" : ""}
                      aria-pressed={mode === "build"}
                      onClick={() => setMode("build")}
                    >
                      <Code2 size={13} />
                      Build
                    </button>
                  </div>
                  {activeRun ? (
                    <button
                      className="send-button stop-button"
                      aria-label="Stop current run"
                      title="Stop agent process"
                      onClick={() =>
                        void runAction(() => api.cancelRun(activeRun.id))
                      }
                    >
                      <Square size={14} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      aria-label="Send message"
                      title="Send · Ctrl+Enter"
                      disabled={!canSend}
                      onClick={submit}
                    >
                      {busy ? (
                        <LoaderCircle size={17} className="spin" />
                      ) : (
                        <ArrowUp size={18} />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="composer-caption">
              <span>
                {!project ? (
                  "Choose a local Git repository to begin."
                ) : provider === "ollama" && !configuredModel ? (
                  "Set an installed local model in Settings or enter its name above."
                ) : !activeProvider?.available ? (
                  <button
                    className="text-button"
                    onClick={() => setDialog("settings")}
                  >
                    {isPreview
                      ? "Preview only — agents are not connected."
                      : `${providerNames[provider]} is not detected. Open settings.`}
                  </button>
                ) : mode === "plan" ? (
                  <>
                    <ShieldCheck size={11} />
                    Plan mode · no source edits
                  </>
                ) : (
                  <>
                    <GitBranch size={11} />
                    Build mode · worktree changes require your review
                  </>
                )}
              </span>
              <span className="keyboard-hint">
                <kbd>Ctrl</kbd>
                <kbd>↵</kbd> to send
              </span>
            </div>
          </div>
        </main>

        {inspector && (
          <aside className="inspector" aria-label="Project inspector">
            <div className="inspector-header">
              <div
                className="inspector-tabs"
                role="tablist"
                aria-label="Inspector"
              >
                <button
                  role="tab"
                  aria-selected={tab === "changes"}
                  className={tab === "changes" ? "active" : ""}
                  onClick={() => setTab("changes")}
                >
                  <FileCode2 size={14} />
                  Changes
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "memory"}
                  className={tab === "memory" ? "active" : ""}
                  onClick={() => setTab("memory")}
                >
                  <Brain size={14} />
                  Memory
                  {activeMemories.length > 0 && (
                    <span className="tab-count">{activeMemories.length}</span>
                  )}
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "activity"}
                  className={tab === "activity" ? "active" : ""}
                  onClick={() => setTab("activity")}
                  title="Run activity"
                >
                  <Activity size={15} />
                  <span className="sr-only">Activity</span>
                </button>
              </div>
            </div>
            <div className="inspector-content" role="tabpanel" aria-label={tab}>
              {tab === "changes" && (
                <>
                  <div className="inspector-section-top">
                    <span>{diff?.changes.length ?? 0} changed files</span>
                    <button
                      className="icon-button"
                      onClick={() => void refreshDiff()}
                      disabled={!latestRun || diffLoading}
                      title="Refresh changes"
                      aria-label="Refresh changes"
                    >
                      <RefreshCw
                        size={13}
                        className={diffLoading ? "spin" : ""}
                      />
                    </button>
                  </div>
                  {diffError && <p className="form-error">{diffError}</p>}
                  {diffLoading && !diff && (
                    <div className="panel-loading">
                      <LoaderCircle size={18} className="spin" />
                      Reading changes…
                    </div>
                  )}
                  {!diffLoading &&
                    !diffError &&
                    (!diff || diff.changes.length === 0) && (
                      <EmptyPanel
                        icon={<FileCode2 size={28} strokeWidth={1.2} />}
                        title="A clean starting point"
                      >
                        Changes from your selected run appear here. Build in a
                        worktree, then review before integrating.
                      </EmptyPanel>
                    )}
                  {diff && diff.changes.length > 0 && (
                    <>
                      <div className="changed-files">
                        {diff.changes.map((change) => (
                          <div className="changed-file" key={change.path}>
                            <FileCode2 size={13} />
                            <span title={change.path}>{change.path}</span>
                            <span className="file-status">{change.status}</span>
                          </div>
                        ))}
                      </div>
                      <div className="diff-header">
                        <GitBranch size={12} />
                        <span>{diff.branch}</span>
                      </div>
                      <pre className="diff-view" aria-label="Git diff">
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
                          Diff output was capped. Open the worktree for the
                          complete changes.
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
                      <ExternalLink size={12} />
                    </button>
                  )}
                  <div className="inspector-bottom-note">
                    <ShieldCheck size={14} />
                    <div>
                      <strong>You control integration.</strong>
                      <p>
                        Workbench never merges or pushes agent changes
                        automatically.
                      </p>
                    </div>
                  </div>
                </>
              )}
              {tab === "memory" && (
                <>
                  <div className="inspector-section-top">
                    <span>Shared project context</span>
                    <button
                      className="icon-button"
                      disabled={!project}
                      title="Add project memory"
                      aria-label="Add project memory"
                      onClick={() => openMemoryForm()}
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                  <p className="panel-intro">
                    Decisions and constraints to carry between agents.
                    Source-linked, editable, and owned by you.
                  </p>
                  {activeMemories.length === 0 ? (
                    <EmptyPanel
                      icon={<Brain size={28} strokeWidth={1.2} />}
                      title="Keep the important parts"
                    >
                      Add a decision, a constraint, or a note. Active memories
                      can inform Codex, Claude, and local-model runs.
                    </EmptyPanel>
                  ) : (
                    <div className="memory-list">
                      {activeMemories.map((entry) => (
                        <MemoryCard
                          key={entry.id}
                          entry={entry}
                          onEdit={() => openMemoryForm(entry)}
                          onArchive={() =>
                            void runAction(() => api.archiveMemory(entry.id))
                          }
                        />
                      ))}
                    </div>
                  )}
                  <button
                    className="secondary-button full-width"
                    disabled={!project}
                    onClick={() => openMemoryForm()}
                  >
                    <Plus size={14} />
                    Add a memory
                  </button>
                  <p className="panel-note">
                    Memory is reference material, not proof. Check old decisions
                    against the current code.
                  </p>
                </>
              )}
              {tab === "activity" && (
                <>
                  <div className="inspector-section-top">
                    <span>Latest run</span>
                    {latestRun && (
                      <span className="activity-time">
                        {formatTime(latestRun.createdAt)}
                      </span>
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
                        {activityEvents.length === 0 && (
                          <p className="panel-note">
                            No tool or status events were emitted.
                          </p>
                        )}
                      </div>
                      <div className="verification-note">
                        <ShieldCheck size={16} />
                        <strong>Verification not run</strong>
                        <p>
                          A completed agent process is not evidence that the
                          result works. Inspect its changes and run project
                          checks.
                        </p>
                      </div>
                    </>
                  ) : (
                    <EmptyPanel
                      icon={<Activity size={28} strokeWidth={1.2} />}
                      title="See the work as it happens"
                    >
                      Tool events, status updates, and failures will appear here
                      when you start a run.
                    </EmptyPanel>
                  )}
                </>
              )}
            </div>
            <div className="inspector-footer">
              <span className="subtle-dot" />
              {isPreview ? "Sample data only" : "Stored on this device"}
              <ShieldCheck size={12} />
            </div>
          </aside>
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
    </div>
  );
}
