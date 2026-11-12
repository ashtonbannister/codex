import { GitCommitHorizontal, GitMerge, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Run } from "../../shared/types";
import type { WorktreeReview } from "../../shared/workspace-actions";
import { api, isPreview } from "../bridge";
import { errorText, isActive } from "./primitives";

/** Git actions always submit the identity shown by the last explicit review. */
export function WorktreeActions({ run, onChanged }: { run: Run; onChanged: () => Promise<void> }) {
  const [review, setReview] = useState<WorktreeReview | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"review" | "commit" | "integrate" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const inspect = async () => {
    const current = ++sequence.current;
    setBusy("review"); setError(""); setReview(null);
    try { await onChanged(); const result = await api.reviewWorktree(run.id); if (current === sequence.current) setReview(result); }
    catch (reason) { if (current === sequence.current) setError(errorText(reason)); }
    finally { if (current === sequence.current) setBusy(null); }
  };
  useEffect(() => {
    setReview(null); setError(""); setNotice(""); setBusy(null);
    return () => { sequence.current++; };
  }, [run.id, run.status]);
  const perform = async (action: "commit" | "integrate") => {
    if (!review || busy) return;
    setBusy(action); setError(""); setNotice("");
    const current = ++sequence.current;
    try {
      const result = action === "commit"
        ? await api.commitWorktree({ runId: review.runId, message: message.trim(), expectedHead: review.head, expectedFingerprint: review.fingerprint })
        : await api.integrateWorktree({ runId: review.runId, expectedHead: review.head, expectedFingerprint: review.fingerprint, expectedTargetHead: review.targetHead, expectedTargetBranch: review.targetBranch, expectedTargetFingerprint: review.targetFingerprint });
      if (current !== sequence.current) return;
      setNotice(result.message);
      if (action === "commit") setMessage("");
      setReview(null);
      await onChanged();
      const refreshed = await api.reviewWorktree(run.id);
      if (current === sequence.current) setReview(refreshed);
    } catch (reason) {
      if (current === sequence.current) { setError(errorText(reason)); setReview(null); }
    } finally { if (current === sequence.current) setBusy(null); }
  };
  return <section className="worktree-actions" aria-label="Worktree review and integration">
    <div className="inspector-section-top"><h3>Review & integrate</h3><button type="button" className="secondary-button compact-button" disabled={!!busy || isActive(run)} onClick={() => void inspect()}>{busy === "review" ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}Review worktree</button></div>
    <p className="panel-note">Commit in this owned worktree, then fast-forward the original checkout. No automatic merge, push, or conflict resolution.</p>
    {isPreview && <p className="field-hint">Synthetic review only. Preview actions never change Git or local files.</p>}
    {isActive(run) && <p className="panel-note">Stop the active run before reviewing changes for integration.</p>}
    {review && <>
      <dl className="worktree-review-meta"><div><dt>Worktree</dt><dd title={review.branch}>{review.branch}</dd></div><div><dt>Reviewed commit</dt><dd><code>{review.head.slice(0, 12)}</code></dd></div><div><dt>Target branch</dt><dd title={review.targetBranch}>{review.targetBranch || "Unavailable"}</dd></div><div><dt>Uncommitted</dt><dd>{review.changes.length} file{review.changes.length === 1 ? "" : "s"}</dd></div></dl>
      {!!review.changes.length && <ul className="reviewed-file-list" aria-label="Files included in this review">{review.changes.map((change) => <li key={change.path}><span className="file-status">{change.status}</span><code>{change.path}</code></li>)}</ul>}
      <label className="field"><span>Commit message</span><textarea rows={2} maxLength={2000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe the reviewed change" disabled={!!busy || !review.canCommit} /></label>
      {review.commitReason && <p className="field-hint">{review.commitReason}</p>}
      <button className="secondary-button full-width" type="button" disabled={!!busy || !review.canCommit || !message.trim()} onClick={() => void perform("commit")}>{busy === "commit" ? <LoaderCircle size={14} className="spin" /> : <GitCommitHorizontal size={14} />}Commit reviewed changes…</button>
      <p className="panel-note">{review.integrationReason || `Ready to update ${review.targetBranch} after native confirmation. The original checkout must still be clean and match the reviewed target.`}</p>
      <button className="secondary-button full-width" type="button" disabled={!!busy || !review.canIntegrate} onClick={() => void perform("integrate")}>{busy === "integrate" ? <LoaderCircle size={14} className="spin" /> : <GitMerge size={14} />}Integrate into original checkout…</button>
    </>}
    {notice && <p className="panel-note" role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error} Review the worktree again before retrying.</p>}
  </section>;
}
