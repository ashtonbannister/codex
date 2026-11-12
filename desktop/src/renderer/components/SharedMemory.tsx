import { ChevronRight, FileText, LoaderCircle, RefreshCw, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SharedMemoryPreview } from "../../shared/sharing";
import { api, isPreview } from "../bridge";
import { errorText } from "./primitives";

export function SharedMemory({ projectId, memoryVersion, enabled, busy, onPublished }: {
  projectId: string;
  memoryVersion: string;
  enabled: boolean;
  busy: boolean;
  onPublished: () => void;
}) {
  const [preview, setPreview] = useState<SharedMemoryPreview | null>(null);
  const [pending, setPending] = useState<"preview" | "publish" | "disable" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    sequence.current++;
    setPreview(null); setPending(null); setError(""); setNotice("");
    return () => { sequence.current++; };
  }, [projectId, memoryVersion]);

  const load = async () => {
    const request = ++sequence.current;
    setPending("preview"); setError(""); setNotice("");
    try {
      const result = await api.previewSharedMemory(projectId);
      if (request === sequence.current) setPreview(result);
    } catch (reason) { if (request === sequence.current) { setPreview(null); setError(errorText(reason)); } }
    finally { if (request === sequence.current) setPending(null); }
  };
  const publish = async () => {
    if (!preview || pending || busy) return;
    const request = ++sequence.current;
    setPending("publish"); setError(""); setNotice("");
    try {
      const result = await api.publishSharedMemory({ projectId, fingerprint: preview.fingerprint });
      if (request !== sequence.current) return;
      setPreview(null);
      setNotice(result.message);
      onPublished();
    } catch (reason) {
      if (request === sequence.current) { setPreview(null); setError(`${errorText(reason)} Preview again before retrying.`); }
    } finally { if (request === sequence.current) setPending(null); }
  };
  const disable = async () => {
    if (pending || busy) return;
    const request = ++sequence.current;
    setPending("disable"); setError(""); setNotice("");
    try {
      await api.disableSharedMemory(projectId);
      if (request !== sequence.current) return;
      setPreview(null);
      setNotice("Nova shared-file reads disabled. Project files and official Codex/Claude references were not removed; review or remove those instructions separately if needed.");
      onPublished();
    } catch (reason) { if (request === sequence.current) setError(errorText(reason)); }
    finally { if (request === sequence.current) setPending(null); }
  };

  return <section className="shared-memory" aria-label="Share memory with official apps">
    <div className="inspector-section-top"><h3>Use memory in the official apps</h3><Share2 size={14} /></div>
    <p className="panel-intro">Publish project notes to <code>.nova/MEMORY.md</code>, with references in <code>AGENTS.md</code> and <code>CLAUDE.md</code>. Nova reads the shared file fresh for Codex, Claude, and local-model requests.</p>
    <p className="panel-note">Nova shared-file reads: {enabled ? "enabled" : "not enabled"}.</p>
    <button type="button" className="secondary-button full-width" disabled={!!pending || busy} onClick={() => void load()}>{pending === "preview" ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}Preview shared memory files</button>
    {busy && <p className="field-hint">Wait for active work to finish before publishing project files.</p>}
    {preview && <div className="shared-memory-preview">
      <p className="panel-note">{preview.enabled ? "Shared-file context is enabled for this project." : "Publishing enables shared-file context for this project."} Review the complete proposed files below.</p>
      <p className="shared-project-path"><code>{preview.projectPath}</code></p>
      {preview.warnings.map((warning, index) => <p key={index} className="context-warning">{warning}</p>)}
      {preview.files.map((file) => <details className="shared-file" key={file.path} open={file.path === ".nova/MEMORY.md"}>
        <summary><ChevronRight size={12} className="shared-file-chevron" /><FileText size={13} /><code>{file.path}</code><span>{file.changed ? file.before === null ? "New" : "Update" : "Unchanged"}</span></summary>
        <details className="shared-file-before"><summary>Existing contents</summary><pre tabIndex={0} aria-label={`Existing ${file.path}`}>{file.before ?? "This file does not exist yet."}</pre></details>
        <h4>Proposed contents</h4><pre tabIndex={0} aria-label={`Proposed ${file.path}`}>{file.after}</pre>
      </details>)}
      <p className="context-warning">Publishing replaces the Nova-managed notes block. Text outside that block is preserved. Do not put credentials or secrets in shared memory; the selected cloud provider receives included context when you send a request.</p>
      <button type="button" className="primary-button full-width" disabled={!!pending || busy} onClick={() => void publish()}>{pending === "publish" ? <LoaderCircle size={14} className="spin" /> : <Share2 size={14} />}Publish reviewed memory…</button>
      <p className="field-hint">A native confirmation rechecks the reviewed files before writing. These are ordinary project files: review and commit them before an isolated Build, which needs a clean baseline. Nothing is committed automatically; no private Codex or Claude database is edited.</p>
    </div>}
    {notice && <p className="panel-note" role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {enabled && <button type="button" className="text-button" disabled={!!pending || busy} onClick={() => void disable()}>{pending === "disable" && <LoaderCircle size={12} className="spin" />}Disable Nova shared-file reads</button>}
    <p className="field-hint">This shares project references, not proprietary memory databases or hidden reasoning. Changes made outside Nova’s managed block are read on the next request; publishing is explicit, not background synchronization.</p>
    {isPreview && <p className="panel-note">Synthetic file preview. No project files or provider memory are accessed.</p>}
  </section>;
}
