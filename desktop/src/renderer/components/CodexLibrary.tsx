import {
  ArrowLeft,
  ArrowRight,
  FileText,
  Folder,
  LoaderCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  CodexHistoryPage,
  CodexInstallation,
  CodexResource,
  CodexResourcePage,
  CodexResourcePreview,
  CodexResourceRequest,
  CodexResourceSection,
  CodexThreadPage,
  CodexThreadSummary,
} from "../../shared/compatibility";
import type { Project, Thread } from "../../shared/types";
import { api, isPreview } from "../bridge";
import { MessageText } from "./MessageText";
import { EmptyPanel, errorText, formatTime } from "./primitives";

type LibraryTab = "conversations" | "resources" | "locations";
export const resourceSections: { id: CodexResourceSection; label: string }[] = [
  { id: "memories", label: "Memories" },
  { id: "memories_v2", label: "Memories v2" },
  { id: "instructions", label: "Instructions" },
  { id: "skills", label: "Skills" },
  { id: "plans", label: "Plans" },
];

function Warnings({ warnings }: { warnings: string[] }) {
  return warnings.length ? (
    <div className="library-warnings" role="note">
      {[...new Set(warnings)].map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
    </div>
  ) : null;
}

export function CodexLibrary({
  projects,
  selectedProjectId,
  codexHome,
  initialResource,
  onOpenThread,
  onMemory,
  onSettings,
  onRecovery,
  onOpenProject,
  onBack,
}: {
  projects: Project[];
  selectedProjectId: string | null;
  codexHome?: string;
  initialResource?: CodexResourceRequest & { home?: string };
  onOpenThread: (thread: Thread) => Promise<void>;
  onMemory: (projectId: string) => void;
  onSettings: () => void;
  onRecovery: () => void;
  onOpenProject: () => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<LibraryTab>(
    initialResource ? "resources" : "conversations",
  );
  const [installation, setInstallation] = useState<CodexInstallation | null>(
    null,
  );
  const [installationError, setInstallationError] = useState("");
  const [sourceEnabled, setSourceEnabled] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [threads, setThreads] = useState<CodexThreadPage | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState("");
  const [selected, setSelected] = useState<CodexThreadSummary | null>(null);
  const [history, setHistory] = useState<CodexHistoryPage | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [section, setSection] = useState<CodexResourceSection>(
    initialResource?.section ?? "instructions",
  );
  const [resources, setResources] = useState<CodexResourcePage | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesError, setResourcesError] = useState("");
  const [resource, setResource] = useState<CodexResourcePreview | null>(null);
  const [resourceLoading, setResourceLoading] = useState(false);
  const [resourceError, setResourceError] = useState("");
  const [targetProject, setTargetProject] = useState(
    selectedProjectId ?? projects[0]?.id ?? "",
  );
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importedProject, setImportedProject] = useState<string | null>(null);
  const threadRequest = useRef(0);
  const historyRequest = useRef(0);
  const resourceRequest = useRef(0);

  useEffect(() => {
    let alive = true;
    setInstallation(null);
    setInstallationError("");
    if (!sourceEnabled) return;
    void api
      .inspectCodexInstallation()
      .then((value) => {
        if (alive) setInstallation(value);
      })
      .catch((reason) => {
        if (alive) setInstallationError(errorText(reason));
      });
    return () => {
      alive = false;
    };
  }, [codexHome, refresh, sourceEnabled]);

  useEffect(() => {
    const request = ++threadRequest.current;
    if (!sourceEnabled || tab !== "conversations") {
      setThreadsLoading(false);
      return;
    }
    setThreads(null);
    setSelected(null);
    setHistory(null);
    setThreadsError("");
    setThreadsLoading(true);
    const timer = window.setTimeout(
      () => {
        void api
          .listCodexThreads({ archived, search: search.trim() || undefined })
          .then((value) => {
            if (request !== threadRequest.current) return;
            setThreads(value);
            setSelected(value.threads[0] ?? null);
          })
          .catch((reason) => {
            if (request === threadRequest.current)
              setThreadsError(errorText(reason));
          })
          .finally(() => {
            if (request === threadRequest.current) setThreadsLoading(false);
          });
      },
      search ? 250 : 0,
    );
    return () => {
      threadRequest.current++;
      window.clearTimeout(timer);
    };
  }, [tab, archived, search, codexHome, refresh, sourceEnabled]);

  useEffect(() => {
    const request = ++historyRequest.current;
    if (!sourceEnabled || tab !== "conversations") {
      setHistoryLoading(false);
      return;
    }
    setHistory(null);
    setHistoryError("");
    setImportError("");
    setHistoryLoading(!!selected);
    if (selected)
      void api
        .readCodexHistory({
          threadId: selected.id,
          archived: selected.archived,
        })
        .then((value) => {
          if (request === historyRequest.current) setHistory(value);
        })
        .catch((reason) => {
          if (request === historyRequest.current)
            setHistoryError(errorText(reason));
        })
        .finally(() => {
          if (request === historyRequest.current) setHistoryLoading(false);
        });
    return () => {
      historyRequest.current++;
    };
  }, [tab, selected, refresh, sourceEnabled]);

  useEffect(() => {
    if (!sourceEnabled || !installation || tab !== "resources") return;
    let alive = true;
    resourceRequest.current++;
    setResources(null);
    setResource(null);
    setResourceLoading(false);
    setResourceError("");
    setImportedProject(null);
    setResourcesError("");
    setResourcesLoading(true);
    void api
      .listCodexResources({ section })
      .then((value) => {
        if (!alive) return;
        setResources(value);
        if (
          initialResource?.section === section &&
          (!initialResource.home || initialResource.home === installation?.home)
        ) {
          const match = value.resources.find(
            (item) => item.path === initialResource.path,
          );
          if (match) void previewResource(match);
        }
      })
      .catch((reason) => {
        if (alive) setResourcesError(errorText(reason));
      })
      .finally(() => {
        if (alive) setResourcesLoading(false);
      });
    return () => {
      alive = false;
      resourceRequest.current++;
    };
  }, [tab, section, codexHome, refresh, initialResource, installation?.home, sourceEnabled]);

  const loadThreads = async () => {
    if (!threads?.nextCursor || threadsLoading) return;
    const request = threadRequest.current;
    setThreadsLoading(true);
    setThreadsError("");
    try {
      const next = await api.listCodexThreads({
        archived,
        search: search.trim() || undefined,
        cursor: threads.nextCursor,
      });
      if (request === threadRequest.current)
        setThreads((current) => ({
          ...next,
          threads: [...(current?.threads ?? []), ...next.threads].filter(
            (item, index, all) =>
              all.findIndex((other) => other.id === item.id) === index,
          ),
          warnings: [...(current?.warnings ?? []), ...next.warnings],
        }));
    } catch (reason) {
      if (request === threadRequest.current) setThreadsError(errorText(reason));
    } finally {
      if (request === threadRequest.current) setThreadsLoading(false);
    }
  };
  const loadHistory = async () => {
    if (!history?.nextCursor || !selected || historyLoading) return;
    const request = historyRequest.current;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const next = await api.readCodexHistory({
        threadId: selected.id,
        archived: selected.archived,
        cursor: history.nextCursor,
      });
      if (request === historyRequest.current)
        setHistory((current) => ({
          ...next,
          messages: [...next.messages, ...(current?.messages ?? [])].filter(
            (item, index, all) =>
              all.findIndex(
                (other) => other.id === item.id && other.turnId === item.turnId,
              ) === index,
          ),
          truncated: !!current?.truncated || next.truncated,
          warnings: [...(current?.warnings ?? []), ...next.warnings],
        }));
    } catch (reason) {
      if (request === historyRequest.current)
        setHistoryError(errorText(reason));
    } finally {
      if (request === historyRequest.current) setHistoryLoading(false);
    }
  };
  const previewResource = async (item: CodexResource) => {
    const request = ++resourceRequest.current;
    setResource(null);
    setResourceError("");
    setImportError("");
    setImportedProject(null);
    setResourceLoading(true);
    try {
      const value = await api.previewCodexResource({
        section: item.section,
        path: item.path,
      });
      if (request === resourceRequest.current) setResource(value);
    } catch (reason) {
      if (request === resourceRequest.current)
        setResourceError(errorText(reason));
    } finally {
      if (request === resourceRequest.current) setResourceLoading(false);
    }
  };
  const importThread = async () => {
    if (!selected || !history || importing) return;
    setImporting(true);
    setImportError("");
    try {
      await onOpenThread(
        await api.importCodexThread({
          threadId: selected.id,
          archived: selected.archived,
        }),
      );
    } catch (reason) {
      setImportError(errorText(reason));
    } finally {
      setImporting(false);
    }
  };
  const importMemory = async () => {
    if (!resource || !targetProject || importing) return;
    setImporting(true);
    setImportError("");
    setImportedProject(null);
    try {
      await api.importCodexMemory({
        projectId: targetProject,
        section: resource.section,
        path: resource.path,
        expectedSha256: resource.sha256,
      });
      setImportedProject(targetProject);
    } catch (reason) {
      setImportError(errorText(reason));
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="codex-library" aria-label="Codex library">
      <header className="library-heading">
        <div>
          <h1>Codex library</h1>
          <p>
            {isPreview
              ? "Synthetic examples — nothing is read from your computer."
              : "Copy selected conversations and knowledge into Nova. Source folders are read-only."}
          </p>
        </div>
        <button className="secondary-button" onClick={onBack}>
          <ArrowLeft size={14} />
          Workspace
        </button>
      </header>
      {!projects.length && (
        <div className="library-start-note">
          <span>Want to work with another agent? Choose Codex, Claude Code, or a local model above, then open a project to start chatting. Codex Library access is separate.</span>
          <button className="secondary-button" onClick={onOpenProject}>Open a project</button>
        </div>
      )}
      <div className="library-source-bar">
        <Folder size={14} />
        <code title={installation?.home ?? codexHome}>
          {installation?.home ??
            (installationError
              ? "Location unavailable"
              : sourceEnabled ? "Reading import source…" : codexHome || "Default Codex import source · not loaded")}
        </code>
        <button className="text-button" onClick={onSettings}>
          Change location
        </button>
        <button
          className="secondary-button"
          aria-label={sourceEnabled ? "Refresh Codex import source" : "Read Codex import source"}
          disabled={importing}
          onClick={() => { setSourceEnabled(true); setRefresh((value) => value + 1); }}
        >
          <RefreshCw size={14} />
          {sourceEnabled ? "Refresh import source" : "Read import source"}
        </button>
      </div>
      {installationError && (
        <p className="form-error library-inline-error" role="alert">
          {installationError}
        </p>
      )}
      <Warnings warnings={installation?.warnings ?? []} />
      {initialResource?.home &&
        installation &&
        initialResource.home !== installation.home && (
          <Warnings
            warnings={[
              `This note was imported from ${initialResource.home}. The library is currently using ${installation.home}. Change the configured location to review the original resource, or deliberately select a resource from the current library.`,
            ]}
          />
        )}
      <nav className="library-tabs" aria-label="Codex library sections">
        {(
          [
            ["conversations", "Conversations"],
            ["resources", "Resources"],
            ["locations", "Locations"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            aria-pressed={tab === id}
            className={tab === id ? "selected" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {!sourceEnabled ? (
        <div className="library-locations">
          <h2>Import only · separate working state</h2>
          <p className="panel-intro">Nothing in the source folder is read until you choose Read import source. Nova does not start Codex there, watch for changes, or write back.</p>
          <p className="panel-note">Imported conversations become independent Nova copies in a Nova-owned folder. Credentials, native session state, and the original working folder are not transferred. Nova uses its own Codex runtime home and sign-in.</p>
        </div>
      ) : tab === "locations" ? (
        <div className="library-locations">
          <h2>Location inventory</h2>
          <p className="panel-intro">
            Readable resources are previewed before import. Conversation files
            are read only to make visible-text copies. Credentials, databases,
            and raw configuration are not imported or modified.
          </p>
          {installation ? (
            <div className="location-list">
              {installation.locations.map((location) => (
                <article key={location.id} className="location-row">
                  <div>
                    <strong>{location.name}</strong>
                    <span className={`location-access ${location.access}`}>
                      {location.access === "content"
                        ? "Readable content"
                        : location.access === "engine-managed"
                          ? "Not imported"
                          : "Excluded"}
                    </span>
                  </div>
                  <code>{location.path}</code>
                  {location.resolvedPath &&
                    location.resolvedPath !== location.path && (
                      <p>
                        Resolved location: <code>{location.resolvedPath}</code>
                      </p>
                    )}
                  <p>{location.detail}</p>
                  <small>{location.exists ? "Present" : "Not found"}</small>
                </article>
              ))}
            </div>
          ) : (
            !installationError && <p role="status">Inspecting locations…</p>
          )}
        </div>
      ) : tab === "conversations" ? (
        <div className="library-split">
          <section
            className="library-list-pane"
            aria-label="Codex conversations"
          >
            <div className="library-list-controls">
              <div
                className="mode-switch"
                role="group"
                aria-label="Codex conversation filter"
              >
                <button
                  className={!archived ? "active" : ""}
                  aria-pressed={!archived}
                  onClick={() => setArchived(false)}
                >
                  Active
                </button>
                <button
                  className={archived ? "active" : ""}
                  aria-pressed={archived}
                  onClick={() => setArchived(true)}
                >
                  Archived
                </button>
              </div>
              <label className="library-search">
                <Search size={14} />
                <input
                  aria-label="Search Codex conversations"
                  placeholder="Search conversations…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
            </div>
            <Warnings warnings={threads?.warnings ?? []} />
            {threadsError && (
              <div className="library-error-block">
                <p className="form-error" role="alert">{threadsError}</p>
                {/history access is locked|cleanup is unconfirmed/i.test(threadsError) && (
                  <button className="secondary-button" onClick={onRecovery}>Open Settings → Recovery</button>
                )}
              </div>
            )}
            <div className="library-items">
              {threads?.threads.map((item) => (
                <button
                  key={item.id}
                  aria-pressed={selected?.id === item.id}
                  className={`library-thread ${selected?.id === item.id ? "selected" : ""}`}
                  onClick={() => setSelected(item)}
                >
                  <strong>{item.title || "Untitled conversation"}</strong>
                  <span title={item.cwd}>{item.cwd}</span>
                  <small>
                    {formatTime(item.updatedAt)} ·{" "}
                    {item.modelProvider || "Codex"}
                  </small>
                </button>
              ))}
            </div>
            {threadsLoading && (
              <p className="panel-loading" role="status">
                Loading conversations…
              </p>
            )}
            {!threadsLoading && !threadsError && !threads?.threads.length && (
              <EmptyPanel title="No matching conversations">
                Try another search, check the archived list, or inspect the
                configured location.
              </EmptyPanel>
            )}
            {threads?.nextCursor && (
              <button
                className="secondary-button library-load-more"
                disabled={threadsLoading}
                onClick={() => void loadThreads()}
              >
                Load more conversations
              </button>
            )}
          </section>
          <section
            className="library-detail"
            aria-label="Codex conversation preview"
          >
            {selected ? (
              <>
                <div className="library-detail-heading">
                  <div>
                    <h2>{selected.title || "Untitled conversation"}</h2>
                    <p>
                      {selected.archived
                        ? "Archived Codex conversation"
                        : "Codex conversation"}{" "}
                      · {selected.status}
                    </p>
                  </div>
                  <button
                    className="primary-button"
                    disabled={!history || historyLoading || importing}
                    onClick={() => void importThread()}
                  >
                    {importing ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <ArrowRight size={14} />
                    )}
                    Open in Nova
                  </button>
                </div>
                <dl className="library-metadata">
                  <div>
                    <dt>Recorded folder · not opened</dt>
                    <dd>
                      <code>{selected.cwd}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{selected.source || "Read-only conversation file"}</dd>
                  </div>
                </dl>
                <details className="library-handoff" open>
                  <summary>What carries over?</summary>
                  <p>
                    Nova copies visible text into its own workspace. The source
                    conversation, archive state, and working folder remain
                    untouched. No native session is resumed or forked.
                  </p>
                  <p>
                    Codex, Claude, and local models all receive a bounded visible
                    transcript and selected Nova memory, not Codex’s hidden state.
                    Opening makes an independent copy; it does not run a model.
                  </p>
                </details>
                {importError && (
                  <p className="form-error" role="alert">
                    {importError}
                  </p>
                )}
                <Warnings warnings={history?.warnings ?? []} />
                <div className="library-history-label">
                  <h3>Visible history</h3>
                  <span>
                    {history?.messages.length ?? 0} messages shown
                    {history?.truncated ? " · bounded preview" : ""}
                  </span>
                </div>
                {history?.nextCursor && (
                  <button
                    className="secondary-button library-load-more"
                    disabled={historyLoading}
                    onClick={() => void loadHistory()}
                  >
                    Older messages
                  </button>
                )}
                {historyError && (
                  <p className="form-error" role="alert">
                    {historyError}
                  </p>
                )}
                {history?.messages.map((message) => (
                  <article
                    key={JSON.stringify([message.turnId, message.id])}
                    className={`library-message library-message-${message.role}`}
                  >
                    <strong>{message.role === "user" ? "You" : "Codex"}</strong>
                    {message.role === "user" ? (
                      <p>{message.text}</p>
                    ) : (
                      <MessageText text={message.text} />
                    )}
                  </article>
                ))}
                {historyLoading && (
                  <p className="panel-loading" role="status">
                    Loading visible history…
                  </p>
                )}
                {!historyLoading && history && !history.messages.length && (
                  <EmptyPanel title="No visible text">
                    This conversation has no user or assistant text available in
                    this view.
                  </EmptyPanel>
                )}
                <p className="panel-note">
                  Preview pagination does not enlarge the imported snapshot.
                  Nova keeps a bounded copy; the source Codex history is never
                  used as Nova’s working state. Hidden reasoning and raw tool
                  payloads are not shared here.
                </p>
              </>
            ) : (
              <EmptyPanel title="Choose a conversation">
                Preview its visible history before opening it in your workspace.
              </EmptyPanel>
            )}
          </section>
        </div>
      ) : (
        <div className="library-split">
          <section className="library-list-pane" aria-label="Codex resources">
            <label className="field library-resource-filter">
              <span>Resource section</span>
              <select
                value={section}
                onChange={(event) =>
                  setSection(event.target.value as CodexResourceSection)
                }
              >
                {resourceSections.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <Warnings warnings={resources?.warnings ?? []} />
            {resourcesError && (
              <p className="form-error" role="alert">
                {resourcesError}
              </p>
            )}
            <div className="library-items">
              {resources?.resources.map((item) => (
                <button
                  className={`library-resource ${resource?.path === item.path ? "selected" : ""}`}
                  key={item.path}
                  aria-pressed={resource?.path === item.path}
                  onClick={() => void previewResource(item)}
                >
                  <FileText size={15} />
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.path}</span>
                    <small>{item.bytes.toLocaleString()} bytes</small>
                  </div>
                </button>
              ))}
            </div>
            {resourcesLoading && (
              <p className="panel-loading" role="status">
                Loading resources…
              </p>
            )}
            {!resourcesLoading &&
              !resourcesError &&
              !resources?.resources.length && (
                <EmptyPanel title="No readable resources">
                  This section may be empty or unavailable. Check Locations for
                  the source paths.
                </EmptyPanel>
              )}
            {resources?.truncated && (
              <p className="panel-note">
                The resource listing reached its safety limit. Only the
                displayed files can be previewed here.
              </p>
            )}
          </section>
          <section
            className="library-detail"
            aria-label="Codex resource preview"
          >
            {resourceLoading && (
              <p className="panel-loading" role="status">
                Reading resource preview…
              </p>
            )}
            {resourceError && (
              <p className="form-error" role="alert">
                {resourceError}
              </p>
            )}
            {resource ? (
              <>
                <div className="library-detail-heading">
                  <div>
                    <h2>{resource.title}</h2>
                    <p>
                      Read-only preview · {resource.bytes.toLocaleString()}{" "}
                      bytes
                    </p>
                  </div>
                </div>
                <code className="resource-source-path">{resource.path}</code>
                <p className="panel-intro">
                  Import a reference note into one project. Instructions,
                  skills, and plans are not installed or executed; imported text
                  is shared only when included in a provider request.
                </p>
                <div className="library-import-controls">
                  <label className="field">
                    <span>Import into project</span>
                    <select
                      value={targetProject}
                      onChange={(event) => {
                        setTargetProject(event.target.value);
                        setImportedProject(null);
                      }}
                    >
                      <option value="">Choose a project</option>
                      {projects.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="primary-button"
                    disabled={!targetProject || importing}
                    onClick={() => void importMemory()}
                  >
                    {importing && <LoaderCircle size={14} className="spin" />}
                    Import as project memory
                  </button>
                </div>
                {!projects.length && (
                  <p className="panel-note">
                    Open a project or a Codex conversation first to choose where
                    this reference belongs.
                  </p>
                )}
                {importError && (
                  <p className="form-error" role="alert">
                    {importError}
                  </p>
                )}
                {importedProject && (
                  <div className="library-import-success" role="status">
                    <span>
                      {isPreview
                        ? "Added to the synthetic workspace."
                        : "Imported as a source-linked reference."}
                    </span>
                    <button
                      className="text-button"
                      onClick={() => onMemory(importedProject)}
                    >
                      Show memory
                      <ArrowRight size={12} />
                    </button>
                  </div>
                )}
                <details className="resource-digest">
                  <summary>Preview fingerprint</summary>
                  <code>{resource.sha256}</code>
                  <p>
                    The native import rechecks this exact content digest. If the
                    file changes, preview it again before importing.
                  </p>
                </details>
                <pre
                  className="resource-preview"
                  tabIndex={0}
                  aria-label="Resource content"
                >
                  {resource.content}
                </pre>
              </>
            ) : (
              !resourceLoading &&
              !resourceError && (
                <EmptyPanel title="Preview before importing">
                  Choose a resource to inspect its content and destination.
                  Credentials and raw configuration are excluded.
                </EmptyPanel>
              )
            )}
          </section>
        </div>
      )}
    </section>
  );
}
