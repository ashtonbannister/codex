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
import { MessageText } from "./MessageText";
import {
  formatTime,
  isActive,
  ProviderMark,
  providerNames,
  statusLabel,
} from "./primitives";

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
