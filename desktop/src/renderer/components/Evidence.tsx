import {
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FolderOpen,
  LoaderCircle,
  Plus,
  RefreshCw,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  ContextMemory,
  ContextPreview,
  MemoryEntry,
  Run,
  VerificationProfile,
  VerificationReport,
  VerificationResult,
  WorkspaceState,
} from "../../shared/types";
import { api, isPreview } from "../bridge";
import { ProfileEditor } from "./Forms";
import { EmptyPanel, errorText, formatTime, isActive } from "./primitives";

const freshnessLabels: Record<ContextMemory["freshness"], string> = {
  current: "Source unchanged",
  changed: "Source changed",
  missing: "Source missing",
  unlinked: "No file link",
  unavailable: "Source unavailable",
};

export function ContextPanel({
  preview,
  loading,
  error,
  hasProject,
  hasPrompt,
  onRefresh,
}: {
  preview: ContextPreview | null;
  loading: boolean;
  error: string;
  hasProject: boolean;
  hasPrompt: boolean;
  onRefresh: () => void;
}) {
  return (
    <>
      <div className="inspector-section-top">
        <h3>Request context</h3>
        <button
          className="icon-button"
          aria-label="Refresh context preview"
          onClick={onRefresh}
          disabled={!hasProject || loading}
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} />
        </button>
      </div>
      <p className="panel-intro">
        Inspect the request body built for the selected agent. The same bounded
        context follows this thread when you switch providers.
      </p>
      {!hasProject && (
        <EmptyPanel title="Open a project">
          Context stays scoped to the selected project and conversation.
        </EmptyPanel>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <div className="panel-loading" role="status">
          Preparing context preview…
        </div>
      )}
      {!loading && preview && (
        <>
          <div className="context-stats">
            <div>
              <strong>{preview.characters.toLocaleString()}</strong>
              <span>characters</span>
            </div>
            <div>
              <strong>≈ {preview.estimatedTokens.toLocaleString()}</strong>
              <span>estimated tokens</span>
            </div>
            <div>
              <strong>{preview.historyRunIds.length}</strong>
              <span>prior runs</span>
            </div>
          </div>
          <p className="panel-note">
            Token estimate uses characters ÷ 4. It is not the model’s tokenizer
            or a billing estimate.
          </p>
          {!hasPrompt && (
            <p className="context-warning">
              No task text yet. This preview shows the shared context only; add
              your request in the composer before sending.
            </p>
          )}
          {preview.warnings.map((warning, index) => (
            <p className="context-warning" key={index}>
              {warning}
            </p>
          ))}
          <h4 className="panel-subheading">Memory selection</h4>
          {preview.memories.length ? (
            <ul className="context-memory-list">
              {preview.memories.map((memory) => (
                <li key={memory.id}>
                  <div>
                    <strong>{memory.title}</strong>
                    <span
                      className={`context-decision ${memory.included ? "included" : "omitted"}`}
                    >
                      {memory.included ? "Included" : "Omitted"}
                    </span>
                  </div>
                  <p>
                    {freshnessLabels[memory.freshness]}
                    {memory.reason ? ` · ${memory.reason}` : ""}
                  </p>
                  {memory.filePath && <code>{memory.filePath}</code>}
                  <small>{memory.source}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel-note">No active project memories.</p>
          )}
          <div className="payload-heading">
            <h4>Exact request payload</h4>
            <span>{isPreview ? "Synthetic preview" : "Current draft"}</span>
          </div>
          <pre
            className="context-payload"
            aria-label="Exact context payload"
            tabIndex={0}
          >
            {preview.prompt}
          </pre>
          <p className="panel-note">
            This is the application’s request body. Provider-owned system
            instructions, tool results, and hidden state are not included.
            Sending rebuilds the context so recent source changes are respected.
          </p>
        </>
      )}
    </>
  );
}

export function MemoryCard({
  entry,
  context,
  checking,
  onEdit,
  onArchive,
  onCodexSource,
}: {
  entry: MemoryEntry;
  context?: ContextMemory;
  checking: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onCodexSource?: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <article className="memory-card">
      <div className="memory-card-meta">
        <span className="memory-kind">{entry.kind}</span>
        <div className="memory-card-actions">
          <button className="text-button" onClick={onEdit}>
            {entry.codexSource ? "Edit as manual note" : "Edit"}
          </button>
          <button
            className="text-button"
            onClick={() => {
              if (confirm) onArchive();
              else setConfirm(true);
            }}
            onBlur={() => setConfirm(false)}
          >
            {confirm ? "Confirm archive" : "Archive"}
          </button>
        </div>
      </div>
      <h3>{entry.title}</h3>
      <p>{entry.content}</p>
      <div
        className={`memory-freshness freshness-${context?.freshness ?? "unavailable"}`}
      >
        {checking
          ? "Checking source…"
          : context
            ? freshnessLabels[context.freshness]
            : entry.filePath || entry.codexSource
              ? "Source not checked"
              : "No file link"}
        {context && !checking && (
          <span>
            {context.included
              ? "Included in current context"
              : "Omitted from current context"}
          </span>
        )}
      </div>
      {entry.filePath && <code className="memory-path">{entry.filePath}</code>}
      {entry.codexSource && (
        <>
          <code className="memory-path">{entry.codexSource.path}</code>
          <p className="memory-reason">
            Codex resource · {entry.codexSource.section}. The saved fingerprint
            tracks the external resource, not a project file.
          </p>
          {onCodexSource && (
            <button
              className="text-button reconfirm-memory"
              onClick={onCodexSource}
            >
              Preview source in Codex library
            </button>
          )}
        </>
      )}
      {context?.reason && <p className="memory-reason">{context.reason}</p>}
      <div className="memory-source">
        <FileCode2 size={12} />
        <span>{entry.source}</span>
      </div>
      {entry.filePath && (
        <button className="text-button reconfirm-memory" onClick={onEdit}>
          Review original project source
        </button>
      )}
    </article>
  );
}

function resultPresentation(
  result: VerificationResult,
  report: VerificationReport | null,
  busy: boolean,
) {
  if (result.status === "stale")
    return {
      label: "Stale · files changed",
      kind: "stale",
      note: "This command’s evidence does not describe the current files. Run the check again.",
    };
  if (result.status === "passed") {
    if (busy)
      return {
        label: "Freshness pending",
        kind: "pending",
        note: "A worker is active. Wait for it to finish before relying on earlier evidence.",
      };
    const current = report?.currentRevision;
    const checked = result.outputRevision;
    if (!current?.complete || !checked?.complete)
      return {
        label: "Revision unconfirmed",
        kind: "pending",
        note: "The command exited successfully, but a complete source snapshot is unavailable.",
      };
    if (current.fingerprint !== checked.fingerprint)
      return {
        label: "Stale · files changed",
        kind: "stale",
        note: "The command passed for an earlier source snapshot. Run it again for the current files.",
      };
    return {
      label: "Passed · current revision",
      kind: "passed",
      note: "This named command passed on the recorded source snapshot. It does not verify the whole task.",
    };
  }
  const labels = {
    running: "Running",
    failed: "Failed",
    cancelled: "Cancelled",
    error: "Could not run",
    interrupted: "Interrupted",
  };
  return {
    label: labels[result.status],
    kind: result.status,
    note:
      result.status === "running"
        ? "Live command output. Cancellation keeps any files the command already changed."
        : "Inspect the command, output, and exit status before drawing conclusions.",
  };
}

export function ChecksPanel({
  projectId,
  run,
  state,
  onError,
}: {
  projectId?: string;
  run?: Run;
  state: WorkspaceState;
  onError: (error: string) => void;
}) {
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<VerificationProfile | "new" | null>(
    null,
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestId = useRef(0);
  const statusKey = state.verifications
    .filter((result) => result.runId === run?.id)
    .map((result) => `${result.id}:${result.status}:${result.finishedAt ?? ""}`)
    .join("|");
  const refresh = async () => {
    const id = ++requestId.current;
    if (!run) {
      setReport(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const value = await api.getVerificationReport(run.id);
      if (id === requestId.current) setReport(value);
    } catch (reason) {
      if (id === requestId.current) setError(errorText(reason));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };
  useEffect(() => {
    setReport(null);
    setExpanded(null);
    setEditor(null);
  }, [run?.id]);
  useEffect(() => {
    void refresh();
    return () => {
      requestId.current++;
    };
  }, [run?.id, statusKey, run?.status]);
  const profiles = state.verificationProfiles.filter(
    (profile) => profile.projectId === projectId,
  );
  const persisted = state.verifications.filter(
    (result) => result.runId === run?.id,
  );
  const results = (report?.results ?? persisted)
    .map(
      (result) =>
        persisted.find(
          (live) => live.id === result.id && live.status === "running",
        ) ?? result,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const result of persisted)
    if (
      result.status === "running" &&
      !results.some((item) => item.id === result.id)
    )
      results.unshift(result);
  const busy =
    pending ||
    !!report?.busy ||
    (!!run && isActive(run)) ||
    state.verifications.some(
      (result) => result.projectId === projectId && result.status === "running",
    );
  const start = async (profileId: string) => {
    if (!run) return;
    setPending(true);
    setError("");
    try {
      const result = await api.startVerification({ runId: run.id, profileId });
      setExpanded(result.id);
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPending(false);
    }
  };
  const remove = async (profileId: string) => {
    try {
      await api.deleteVerificationProfile(profileId);
      setDeleting(null);
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  return (
    <>
      <div className="inspector-section-top">
        <h3>Checks</h3>
        <div className="inline-actions">
          <button
            className="icon-button"
            aria-label="Refresh check results"
            disabled={!run || loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} />
          </button>
          <button
            className="icon-button"
            aria-label="Add check profile"
            disabled={!projectId}
            onClick={() => setEditor("new")}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>
      <p className="panel-intro">
        Run your project’s commands independently of the coding agent. Results
        belong to a captured source revision.
      </p>
      {isPreview && (
        <p className="context-warning">
          UI preview. Sample results are synthetic; no commands run here.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {editor && projectId ? (
        <ProfileEditor
          key={typeof editor === "string" ? "new" : editor.id}
          projectId={projectId}
          entry={typeof editor === "string" ? undefined : editor}
          onClose={() => setEditor(null)}
          onSaved={() => void refresh()}
        />
      ) : (
        <>
          <h4 className="panel-subheading">Check profiles</h4>
          {profiles.length ? (
            <div className="check-profiles">
              {profiles.map((profile) => (
                <div className="check-profile" key={profile.id}>
                  <div className="profile-name">
                    <strong>{profile.name}</strong>
                    <button
                      className="icon-button run-check"
                      aria-label={`Run check: ${profile.name}`}
                      title={
                        !run?.worktreePath
                          ? "A completed run in a worktree is required"
                          : "Run check (requires confirmation)"
                      }
                      disabled={!run?.worktreePath || busy}
                      onClick={() => void start(profile.id)}
                    >
                      {pending ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <ChevronRight size={16} />
                      )}
                    </button>
                  </div>
                  <code>
                    {profile.executable} {JSON.stringify(profile.args)}
                  </code>
                  <div className="profile-actions">
                    <span>{profile.timeoutMinutes} min limit</span>
                    <button
                      className="text-button"
                      aria-label={`Edit check: ${profile.name}`}
                      onClick={() => setEditor(profile)}
                    >
                      Edit
                    </button>
                    <button
                      className="text-button"
                      aria-label={`${deleting === profile.id ? "Confirm delete" : "Delete"} check: ${profile.name}`}
                      onClick={() => {
                        if (deleting === profile.id) void remove(profile.id);
                        else setDeleting(profile.id);
                      }}
                      onBlur={() => setDeleting(null)}
                    >
                      {deleting === profile.id ? "Confirm delete" : "Delete"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyPanel title="Add a project check">
              Save a test, typecheck, or build command. A profile does nothing
              until you choose Run.
            </EmptyPanel>
          )}
          <button
            className="secondary-button full-width"
            disabled={!projectId}
            onClick={() => setEditor("new")}
          >
            <Plus size={14} />
            Add check profile
          </button>
        </>
      )}
      {!run?.worktreePath && (
        <p className="panel-note">
          Checks need a completed run in a thread worktree. First complete a
          Build; a Plan-only checkout is not a check target. Saved profiles are
          reusable across the project.
        </p>
      )}
      {run?.worktreePath && (
        <button
          className="text-button reveal-worktree"
          onClick={() =>
            void api
              .revealWorktree(run.id)
              .catch((reason) => onError(errorText(reason)))
          }
        >
          <FolderOpen size={14} />
          Open worktree
        </button>
      )}
      {run && (
        <>
          <div className="history-heading">
            <h4>Run history</h4>
            <span>
              {results.length} {results.length === 1 ? "check" : "checks"}
            </span>
          </div>
          {loading && !report && (
            <p className="panel-loading" role="status">
              Reading check evidence…
            </p>
          )}
          {results.length === 0 && !loading && (
            <p className="panel-note">
              No checks recorded for this run. A finished agent turn is not a
              verified result.
            </p>
          )}
          {results.map((result, index) => {
            const presentation = resultPresentation(result, report, busy);
            const open =
              expanded === result.id || (expanded === null && index === 0);
            return (
              <article
                className={`check-result check-${presentation.kind}`}
                key={result.id}
              >
                <button
                  className="check-result-heading"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? "none" : result.id)}
                >
                  {open ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                  <span>
                    <strong>{result.profileName}</strong>
                    <small>{presentation.label}</small>
                  </span>
                  {result.status === "running" ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : presentation.kind === "passed" ? (
                    <Check size={14} />
                  ) : null}
                </button>
                {open && (
                  <div className="check-result-body">
                    <p>{presentation.note}</p>
                    <dl className="check-metadata">
                      <dt>Started</dt>
                      <dd>
                        {new Date(result.createdAt).toLocaleDateString()}{" "}
                        {formatTime(result.createdAt)}
                      </dd>
                      <dt>Exit code</dt>
                      <dd>{result.exitCode ?? "—"}</dd>
                      <dt>Working folder</dt>
                      <dd>{result.cwd}</dd>
                      <dt>Command</dt>
                      <dd>
                        <code>
                          {result.executable} {JSON.stringify(result.args)}
                        </code>
                      </dd>
                      <dt>Source</dt>
                      <dd
                        title={
                          result.outputRevision?.fingerprint ??
                          result.inputRevision?.fingerprint
                        }
                      >
                        {(
                          result.outputRevision?.fingerprint ??
                          result.inputRevision?.fingerprint
                        )?.slice(0, 16) ?? "Not captured"}
                      </dd>
                    </dl>
                    {result.error && (
                      <p className="form-error">{result.error}</p>
                    )}
                    <pre
                      className="check-output"
                      aria-label={`Check output for ${result.profileName}`}
                      tabIndex={0}
                    >
                      {result.output ||
                        (result.status === "running"
                          ? "Waiting for command output…"
                          : "No output was captured.")}
                    </pre>
                    {result.truncated && (
                      <p className="panel-note">
                        Output reached the capture limit.
                      </p>
                    )}
                    {result.status === "running" && (
                      <button
                        className="secondary-button"
                        onClick={() =>
                          void api
                            .cancelVerification(result.id)
                            .catch((reason) => setError(errorText(reason)))
                        }
                      >
                        <Square size={12} />
                        Cancel check
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
          <p className="panel-note">
            Refresh after external file changes. Checks passing is evidence for
            these commands, not automatic approval to merge.
          </p>
        </>
      )}
    </>
  );
}
