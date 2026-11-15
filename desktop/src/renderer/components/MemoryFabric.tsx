import { ArrowLeft, ArrowRight, Database, LoaderCircle, RefreshCw, Search, SquarePen, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { FabricReadResult, FabricSearchResult, FabricSource, FabricStats } from "../../shared/memory-fabric";
import { api, isPreview } from "../bridge";
import { errorText } from "./primitives";
import "./memory-fabric.css";

const PAGE_SIZE = 12;
const SOURCE_PAGE_SIZE = 8_000;
const sourceLabel: Record<FabricSource["kind"], string> = {
  user: "User statement", assistant: "Assistant claim", note: "Curated note",
  tool: "Tool observation", import: "Imported reference", correction: "User correction", checkpoint: "Task checkpoint",
};

/** Fetch only the visible page. The archive is never part of renderer state. */
export function MemoryFabric({ projectId, refreshKey, busy, onChanged }: {
  projectId: string; refreshKey: string; busy: boolean; onChanged: () => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [historical, setHistorical] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [results, setResults] = useState<FabricSearchResult | null>(null);
  const [stats, setStats] = useState<FabricStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceOffset, setSourceOffset] = useState(0);
  const [source, setSource] = useState<FabricReadResult | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState("");
  const [editing, setEditing] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [reason, setReason] = useState("");
  const [mutation, setMutation] = useState<"correct" | "forget" | null>(null);
  const lifetime = useRef(0);

  useEffect(() => {
    lifetime.current++;
    return () => { lifetime.current++; };
  }, [projectId]);

  useEffect(() => {
    let current = true;
    setLoading(true); setError("");
    void Promise.all([
      api.memoryFabricSearch({ projectId, query, includeSuperseded: historical, offset, limit: PAGE_SIZE }),
      api.memoryFabricStats(projectId),
    ]).then(([page, totals]) => {
      if (!current) return;
      setResults(page); setStats(totals);
      if (offset > 0 && page.items.length === 0) setOffset(0);
    }).catch((failure) => {
      if (current) { setResults(null); setError(errorText(failure)); }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [projectId, query, historical, offset, refresh, refreshKey]);

  useEffect(() => {
    let current = true;
    setSource(null); setReadError("");
    if (!selectedId) { setReading(false); return; }
    setReading(true);
    void api.memoryFabricRead({ projectId, id: selectedId, offset: sourceOffset, limit: SOURCE_PAGE_SIZE })
      .then((value) => { if (current) setSource(value); })
      .catch((failure) => { if (current) setReadError(errorText(failure)); })
      .finally(() => { if (current) setReading(false); });
    return () => { current = false; };
  }, [projectId, selectedId, sourceOffset, refresh]);

  const select = (id: string | null) => {
    setSelectedId(id); setSourceOffset(0); setEditing(false); setReplacement(""); setReason("");
  };
  const correct = async () => {
    if (!source || mutation || busy || !replacement.trim()) return;
    const generation = lifetime.current;
    setMutation("correct"); setReadError(""); setNotice("");
    try {
      const revised = await api.memoryFabricCorrect({ projectId, id: source.source.id, text: replacement, reason: reason.trim() || undefined });
      if (generation !== lifetime.current) return;
      select(revised.id); setRefresh((value) => value + 1);
      setNotice("Correction saved as a new user-supplied revision. The prior source remains historical; dependent context packets are invalidated. Exported files are not rewritten: preview and republish shared notes if needed. Previously sent provider context and external history cannot be recalled.");
      onChanged();
    } catch (failure) { if (generation === lifetime.current) setReadError(errorText(failure)); }
    finally { if (generation === lifetime.current) setMutation(null); }
  };
  const forget = async () => {
    if (!source || mutation || busy) return;
    const generation = lifetime.current;
    setMutation("forget"); setReadError(""); setNotice("");
    try {
      const result = await api.memoryFabricForget({ projectId, id: source.source.id });
      if (generation !== lifetime.current || result === null) return;
      select(null); setRefresh((value) => value + 1);
      setNotice(`Forgot ${result.forgottenSources} source revision${result.forgottenSources === 1 ? "" : "s"}; invalidated ${result.invalidatedPackets} context packet${result.invalidatedPackets === 1 ? "" : "s"}. ${result.warning}`);
      onChanged();
    } catch (failure) { if (generation === lifetime.current) setReadError(errorText(failure)); }
    finally { if (generation === lifetime.current) setMutation(null); }
  };

  return <section className="memory-fabric" aria-label="Nova Memory Fabric">
    <div className="inspector-section-top">
      <h3><Database size={15} /> Memory Fabric</h3>
      <button type="button" className="icon-button" aria-label="Refresh memory archive" disabled={loading || !!mutation} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
    </div>
    <p className="panel-intro">Search retained evidence across this project’s conversations and models. Compact views link back to their source; an assistant’s claim is not a verified fact.</p>
    {stats && <dl className="fabric-stats">
      <div><dt>Active sources</dt><dd>{stats.activeSources.toLocaleString()}</dd></div>
      <div><dt>Historical revisions</dt><dd>{stats.supersededSources.toLocaleString()}</dd></div>
      <div><dt>Retained characters</dt><dd>{stats.sourceCharacters.toLocaleString()}</dd></div>
      <div><dt>Compressed payload</dt><dd>{(stats.compressedBytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB</dd></div>
    </dl>}
    {stats?.migrationPending && <p className="context-warning" role="status">Existing visible history is being indexed in the background. Search coverage is incomplete until migration finishes.</p>}
    {stats?.captureWarning && <p className="context-warning" role="status">{stats.captureWarning}</p>}
    <form className="fabric-search" onSubmit={(event) => { event.preventDefault(); setQuery(draft.trim()); setOffset(0); setRefresh((value) => value + 1); }}>
      <label className="sr-only" htmlFor={inputId}>Search retained memory evidence</label>
      <input id={inputId} value={draft} maxLength={2_000} onChange={(event) => setDraft(event.target.value)} placeholder="Find a decision, value, or earlier attempt…" />
      <button type="submit" className="icon-button" aria-label="Search memory archive" disabled={loading}><Search size={15} /></button>
    </form>
    <label className="fabric-history-toggle"><input type="checkbox" checked={historical} onChange={(event) => { setHistorical(event.target.checked); setOffset(0); }} />Include superseded revisions</label>
    {loading && <p className="panel-note" role="status">Searching this project’s archive…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {!loading && results && <>
      <p className="field-hint">{results.total.toLocaleString()} matching source{results.total === 1 ? "" : "s"} · archive revision {results.watermark}</p>
      <ul className="fabric-results">
        {results.items.map((hit) => <li key={hit.source.id}>
          <button type="button" className={`fabric-result ${selectedId === hit.source.id ? "selected" : ""}`} disabled={!!mutation} aria-pressed={selectedId === hit.source.id} onClick={() => select(hit.source.id)}>
            <strong>{hit.source.title}</strong>
            <span>{sourceLabel[hit.source.kind]} · {hit.source.status} · {hit.source.coverage.status} capture</span>
            <p>{hit.excerpt}</p>
          </button>
        </li>)}
      </ul>
      {results.items.length === 0 && <p className="panel-note">{query ? "No retained source matched this search. Try a distinctive identifier or another wording." : "No retained evidence yet. New Nova conversations and approved imports appear here after capture."}</p>}
      {(results.total > PAGE_SIZE || offset > 0) && <div className="fabric-pagination">
        <button type="button" className="text-button" disabled={loading || offset === 0} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}><ArrowLeft size={13} />Previous</button>
        <span>{offset + 1}–{Math.min(offset + results.items.length, results.total)}</span>
        <button type="button" className="text-button" disabled={loading || offset + PAGE_SIZE >= results.total} onClick={() => setOffset((value) => value + PAGE_SIZE)}>Next<ArrowRight size={13} /></button>
      </div>}
    </>}
    {selectedId && <div className="fabric-source">
      <div className="inspector-section-top"><h4>Source evidence</h4><button type="button" className="icon-button" aria-label="Close memory evidence" disabled={!!mutation} onClick={() => select(null)}><X size={14} /></button></div>
      {reading && <p className="panel-note" role="status">Reading source page…</p>}
      {readError && <p className="form-error" role="alert">{readError}</p>}
      {source && <>
        <h4>{source.source.title}</h4>
        <p className="panel-note">{sourceLabel[source.source.kind]} · {source.source.provider || "Nova"} · {source.source.status}</p>
        <dl className="fabric-provenance">
          <dt>Observed</dt><dd>{source.source.observedAt}</dd>
          <dt>Retained</dt><dd>{source.source.createdAt}</dd>
          {source.source.revision && <><dt>Code revision</dt><dd><code>{source.source.revision}</code></dd></>}
          {source.source.sourceRef && <><dt>Origin</dt><dd><code>{source.source.sourceRef}</code></dd></>}
          <dt>Source digest</dt><dd><code>{source.source.sha256}</code></dd>
        </dl>
        <p className="panel-note">Capture: {source.source.coverage.status}{source.source.coverage.redacted ? " · redacted" : ""}. Exact recovery applies to retained text, not omitted or redacted material. A digest proves byte identity, not truth.</p>
        {source.source.coverage.omissions.map((item, index) => <p className="context-warning" key={index}>{item}</p>)}
        <pre tabIndex={0} className="fabric-source-text" aria-label="Retained memory source text">{source.text}</pre>
        <div className="fabric-pagination">
          <button type="button" className="text-button" disabled={reading || source.offset === 0 || !!mutation} onClick={() => setSourceOffset((value) => Math.max(0, value - SOURCE_PAGE_SIZE))}><ArrowLeft size={13} />Previous</button>
          <span>{source.offset + (source.text.length ? 1 : 0)}–{source.offset + source.text.length} / {source.totalCharacters.toLocaleString()} chars</span>
          <button type="button" className="text-button" disabled={reading || source.nextOffset === undefined || !!mutation} onClick={() => { if (source.nextOffset !== undefined) setSourceOffset(source.nextOffset); }}>Next<ArrowRight size={13} /></button>
        </div>
        <p className="field-hint">Compact view: {source.source.capsule.retainedCharacters.toLocaleString()} / {source.source.capsule.sourceCharacters.toLocaleString()} characters · {source.source.capsule.lossy ? "extractive, incomplete view" : "all retained source text represented"}. Search also reads the independent source index.</p>
        <div className="fabric-actions">
          <button type="button" className="text-button" disabled={!!mutation || busy || source.source.status !== "active"} onClick={() => setEditing((value) => !value)}><SquarePen size={13} />Correct…</button>
          <button type="button" className="text-button fabric-forget" disabled={!!mutation || busy} onClick={() => void forget()}>{mutation === "forget" ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}Forget…</button>
        </div>
        {busy && <p className="field-hint">Corrections and forgetting are available after active work finishes.</p>}
        {editing && <form className="fabric-correction" onSubmit={(event) => { event.preventDefault(); void correct(); }}>
          <label>Corrected statement<textarea value={replacement} rows={5} maxLength={32_768} onChange={(event) => setReplacement(event.target.value)} required placeholder="Write the complete corrected statement, including conditions and exact values." /></label>
          <label>Reason<input value={reason} maxLength={800} onChange={(event) => setReason(event.target.value)} placeholder="What changed, or what was wrong?" /></label>
          <p className="field-hint">This creates a user-supplied correction, not an independent verification. It replaces this source’s active interpretation and retains the previous revision as history. Exported files are not rewritten; preview and republish shared notes if needed. Provider-side context and history cannot be recalled.</p>
          <button type="submit" className="secondary-button full-width" disabled={!!mutation || busy || !replacement.trim()}>{mutation === "correct" && <LoaderCircle size={13} className="spin" />}Save correction</button>
        </form>}
      </>}
    </div>}
    {notice && <p className="panel-note" role="status">{notice}</p>}
    <p className="field-hint">Stored in Nova’s own local archive, separate from provider accounts. Selected project evidence can be included when you send a request to a cloud or local model. Storage figures above exclude search indexes and other database overhead.</p>
    {isPreview && <p className="context-warning">UI preview only. No real archive, provider memory, or source files are accessed.</p>}
  </section>;
}
