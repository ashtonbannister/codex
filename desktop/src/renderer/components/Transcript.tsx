import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  Clock3,
  LoaderCircle,
  Terminal,
} from "lucide-react";
import type { Run } from "../../shared/types";
import type { CodexThreadLink } from "../../shared/compatibility";
import { memo } from "react";
import { MessageText } from "./MessageText";
import {
  formatTime,
  isActive,
  ProviderMark,
  providerNames,
  statusLabel,
} from "./primitives";

export const ImportedHistory = memo(function ImportedHistory({
  source,
}: {
  source: CodexThreadLink;
}) {
  return (
    <section className="imported-history" aria-label="Imported visible history">
      <header className="imported-history-heading">
        <h2>Imported from Codex</h2>
        <span>Visible transcript · not a new agent run</span>
        <p>
          {source.history.length} retained messages
          {source.historyTruncated ? " · snapshot truncated" : ""}. All agents use
          a bounded subset of this independent copy. The source stays untouched.
        </p>
        <details>
          <summary>Source and import details</summary>
          <dl>
            <div>
              <dt>Recorded source folder · not opened</dt>
              <dd>
                <code>{source.sourceCwd}</code>
              </dd>
            </div>
            <div>
              <dt>Read-only import source</dt>
              <dd>
                <code>{source.home}</code>
              </dd>
            </div>
            <div>
              <dt>Source conversation</dt>
              <dd>
                <code>{source.sourceThreadId}</code>
              </dd>
            </div>
          </dl>
          <p>
            Imported {formatTime(source.importedAt)}
            {source.sourceArchived ? " from an archived source" : ""}. Hidden
            reasoning and tool payloads are not included.
          </p>
          {source.warnings.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
        </details>
      </header>
      {source.history.map((message) =>
        message.role === "user" ? (
          <div
            className="user-message"
            key={JSON.stringify([message.turnId, message.id])}
          >
            <div className="message-overline">
              <span>You · imported</span>
            </div>
            <p>{message.text}</p>
          </div>
        ) : (
          <div
            className="agent-message"
            key={JSON.stringify([message.turnId, message.id])}
          >
            <div className="agent-heading">
              <ProviderMark provider="codex" />
              <strong>Codex</strong>
              <span className="agent-model">Imported visible response</span>
            </div>
            <MessageText text={message.text} />
          </div>
        ),
      )}
      {!source.history.length && (
        <p className="muted">
          No visible text was retained. The source Codex conversation remains
          separate from Nova.
        </p>
      )}
      <div className="imported-history-end">
        End of retained history · continue below
      </div>
    </section>
  );
});

export function RunCard({ run, onMemory }: { run: Run; onMemory: () => void }) {
  const messages = run.events.filter((event) => event.kind === "message");
  const tools = run.events.filter((event) => event.kind === "tool");
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
          <div className="thinking-state" role="status">
            <LoaderCircle className="spin" size={14} />
            <span>
              {run.events.filter((event) => event.kind === "status").at(-1)
                ?.text ?? "Waiting for the agent’s response…"}
            </span>
          </div>
        )}
        {!messages.length && !active && !run.error && !errors.length && (
          <p className="muted">
            No text response was captured. Check Activity for details.
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
          <button onClick={onMemory} className="text-button">
            <Brain size={12} />
            {run.contextMemoryIds.length} memories
          </button>
          {run.usage && (
            <span className="token-count">
              {(
                (run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0)
              ).toLocaleString()}{" "}
              reported tokens
            </span>
          )}
        </div>
        {run.contextSummary && (
          <details className="context-record">
            <summary>
              Context sent · {run.contextSummary.characters.toLocaleString()}{" "}
              characters
            </summary>
            <p>
              ≈ {run.contextSummary.estimatedTokens.toLocaleString()} tokens
              (character-based estimate).{" "}
              {run.contextSummary.omittedMemoryIds.length} memories omitted.
            </p>
            {run.contextSummary.warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
          </details>
        )}
      </div>
    </article>
  );
}
