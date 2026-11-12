import type { ProviderId, RunEvent, Usage } from "../../shared/types";

export interface NormalizedEvent {
  events: Array<Pick<RunEvent, "kind" | "text">>;
  sessionId?: string;
  usage?: Usage;
  completed?: boolean;
  failed?: string;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const str = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/** Ignore unknown protocol events, but never convert a missing terminal event into success. */
export function normalizeProviderLine(
  provider: ProviderId,
  line: string,
): NormalizedEvent {
  const normalized: NormalizedEvent = { events: [] };
  let event: JsonObject;
  try {
    event = object(JSON.parse(line));
  } catch {
    if (line.trim())
      normalized.events.push({ kind: "status", text: line.slice(0, 2_000) });
    return normalized;
  }
  if (provider === "claude") {
    if (typeof event.session_id === "string")
      normalized.sessionId = event.session_id;
    if (event.type === "system" && event.subtype === "init")
      normalized.events.push({
        kind: "status",
        text: "Claude Code session started.",
      });
    if (event.type === "assistant") {
      const message = object(event.message);
      for (const item of Array.isArray(message.content)
        ? message.content
        : []) {
        const block = object(item);
        if (block.type === "text" && typeof block.text === "string")
          normalized.events.push({ kind: "message", text: block.text });
        if (block.type === "tool_use")
          normalized.events.push({
            kind: "tool",
            text: `Using ${str(block.name) || "tool"}`,
          });
      }
    }
    if (event.type === "result") {
      const usage = object(event.usage);
      normalized.usage = {
        inputTokens: count(usage.input_tokens),
        outputTokens: count(usage.output_tokens),
        cachedTokens: count(usage.cache_read_input_tokens),
      };
      if (event.is_error === true || event.subtype !== "success") {
        normalized.failed =
          str(event.result) ||
          (Array.isArray(event.errors)
            ? event.errors
                .filter((entry) => typeof entry === "string")
                .join("\n")
            : "") ||
          `Claude ended with ${str(event.subtype) || "an error"}.`;
      } else {
        normalized.completed = true;
        if (str(event.result))
          normalized.events.push({ kind: "message", text: str(event.result) });
      }
    }
    if (event.type === "error")
      normalized.failed =
        str(object(event.error).message) ||
        str(event.message) ||
        "Claude reported an error.";
    return normalized;
  }
  if (event.type === "thread.started")
    normalized.sessionId = str(event.thread_id) || undefined;
  if (event.type === "turn.started")
    normalized.events.push({ kind: "status", text: "Agent turn started." });
  if (event.type === "turn.completed") {
    const usage = object(event.usage);
    normalized.completed = true;
    normalized.usage = {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cachedTokens: count(usage.cached_input_tokens),
    };
  }
  if (event.type === "turn.failed" || event.type === "error")
    normalized.failed =
      str(object(event.error).message) ||
      str(event.message) ||
      "Codex reported a failed turn.";
  const item = object(event.item);
  if (event.type === "item.completed") {
    if (item.type === "agent_message" && typeof item.text === "string")
      normalized.events.push({ kind: "message", text: item.text });
    if (item.type === "command_execution")
      normalized.events.push({
        kind: "tool",
        text: `${str(item.command)}\n${str(item.aggregated_output)}`.trim(),
      });
    if (item.type === "file_change")
      normalized.events.push({
        kind: "tool",
        text: `File changes (${str(item.status)}): ${(Array.isArray(item.changes) ? item.changes : []).map((change) => str(object(change).path)).join(", ")}`,
      });
    if (item.type === "mcp_tool_call")
      normalized.events.push({
        kind: "tool",
        text: `${str(item.server)} / ${str(item.tool)} (${str(item.status)})`,
      });
    if (item.type === "error")
      normalized.events.push({ kind: "error", text: str(item.message) });
  }
  if (event.type === "item.started" && item.type === "command_execution")
    normalized.events.push({
      kind: "tool",
      text: `Running: ${str(item.command)}`,
    });
  return normalized;
}
