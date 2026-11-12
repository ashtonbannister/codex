import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LocalConnection } from "../../shared/local-models";
import { validateLocalConnection } from "./local-models";

type Json = Record<string, unknown>;
interface ToolMapping { name: string; namespace?: string; custom: boolean }
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}
const REQUEST_LIMIT = 16 * 1024 * 1024;
const TOOL_LIMIT = 256;
const object = (value: unknown): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object in the local model protocol.");
  return value as Json;
};
const string = (value: unknown, label: string, limit = REQUEST_LIMIT): string => {
  if (typeof value !== "string" || value.length > limit)
    throw new Error(`Invalid ${label} in the local model protocol.`);
  return value;
};
const identifier = (value: unknown, label: string): string => {
  const result = string(value, label, 256);
  if (!result || /[\0\r\n]/.test(result)) throw new Error(`Invalid ${label}.`);
  return result;
};

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new Error("The local Chat Completions bridge supports text content only.");
  return value.map((raw) => {
    const item = object(raw);
    if (!["input_text", "output_text", "text"].includes(String(item.type)))
      throw new Error("The local Chat Completions bridge supports text only, not images, audio, or attachments.");
    return string(item.text, "text content");
  }).join("\n");
}

/** Stable aliases preserve namespaces while staying inside Chat Completions' name grammar. */
function toolAlias(name: string, namespace?: string): string {
  if (!namespace && /^[A-Za-z0-9_-]{1,64}$/.test(name)) return name;
  const full = JSON.stringify([namespace ?? "", name]);
  const readable = `${namespace ? `${namespace}__` : ""}${name}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${readable.slice(0, 45)}_${createHash("sha256").update(full).digest("hex").slice(0, 16)}`;
}

/** Translate the explicit text/tool subset; never silently strip unsupported input items. */
export function responsesToChat(value: unknown, selectedModel: string): {
  body: Json;
  tools: Map<string, ToolMapping>;
  stream: boolean;
} {
  const request = object(value);
  if (request.model !== selectedModel) throw new Error("The bridge refuses a model different from this run's selected local model.");
  if (request.previous_response_id || request.conversation || request.background === true)
    throw new Error("Local Chat Completions requires full visible input; provider-native response IDs and background jobs are unsupported.");
  if (request.stream !== undefined && typeof request.stream !== "boolean")
    throw new Error("Invalid streaming option.");
  if (request.text && object(request.text).format) {
    const format = object(object(request.text).format);
    if (format.type !== "text") throw new Error("Structured response formats are not supported by the local Chat Completions bridge.");
  }
  const tools = new Map<string, ToolMapping>();
  const declarations: Json[] = [];
  const addTool = (raw: unknown, namespace?: string): void => {
    const tool = object(raw);
    if (tool.type === "namespace") {
      if (namespace || !Array.isArray(tool.tools)) throw new Error("Invalid tool namespace.");
      const parent = identifier(tool.name, "tool namespace");
      for (const entry of tool.tools) addTool(entry, parent);
      return;
    }
    if (tool.type !== "function" && tool.type !== "custom")
      throw new Error("This local bridge supports function and custom text tools, not hosted tools or server-side tool search.");
    const name = identifier(tool.name, "tool name");
    const alias = toolAlias(name, namespace);
    if (tools.has(alias) || tools.size >= TOOL_LIMIT) throw new Error("Duplicate or excessive local tools.");
    const custom = tool.type === "custom";
    let formatDescription = "";
    if (custom && tool.format !== undefined) {
      const format = object(tool.format);
      if (format.type === "grammar" && ["lark", "regex"].includes(String(format.syntax))) {
        formatDescription = `\nThe raw input must follow this ${format.syntax} grammar:\n${string(format.definition, "custom tool grammar", 1024 * 1024)}`;
      } else if (format.type !== "text") {
        throw new Error("This local bridge supports text, Lark, and regex custom-tool formats only.");
      }
    }
    tools.set(alias, { name, ...(namespace ? { namespace } : {}), custom });
    declarations.push({
      type: "function",
      function: {
        name: alias,
        description: `${namespace ? `${namespace}.${name}: ` : ""}${typeof tool.description === "string" ? tool.description : ""}${custom ? " Pass the complete raw text tool input in the input string, without changing its syntax." : ""}${formatDescription}`,
        parameters: custom ? {
          type: "object",
          properties: { input: { type: "string", description: "The tool's complete raw text input." } },
          required: ["input"],
          additionalProperties: false,
        } : tool.parameters ? object(tool.parameters) : { type: "object", properties: {} },
        ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
      },
    });
  };
  if (request.tools !== undefined && !Array.isArray(request.tools)) throw new Error("Invalid tool declarations.");
  for (const tool of (request.tools as unknown[] | undefined) ?? []) addTool(tool);
  const messages: ChatMessage[] = [];
  if (request.instructions !== undefined && request.instructions !== null)
    messages.push({ role: "system", content: string(request.instructions, "instructions") });
  const items = typeof request.input === "string"
    ? [{ role: "user", content: request.input }]
    : request.input;
  if (!Array.isArray(items) || items.length > 10000) throw new Error("Local input must be a bounded text/message list.");
  for (const raw of items) {
    const item = object(raw);
    if (item.encrypted_content || item.encrypted_function_args)
      throw new Error("Encrypted provider state cannot be transferred through the local Chat Completions bridge.");
    if (item.type === "message" || (!item.type && typeof item.role === "string")) {
      if (!["system", "developer", "user", "assistant"].includes(String(item.role)))
        throw new Error("Unsupported local message role.");
      messages.push({
        role: item.role === "developer" ? "system" : item.role as ChatMessage["role"],
        content: contentText(item.content),
      });
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const name = identifier(item.name, "tool name");
      const namespace = item.namespace == null ? undefined : identifier(item.namespace, "tool namespace");
      const call = {
        id: identifier(item.call_id, "tool call ID"),
        type: "function" as const,
        function: {
          name: toolAlias(name, namespace),
          arguments: item.type === "custom_tool_call"
            ? JSON.stringify({ input: string(item.input, "custom tool input") })
            : string(item.arguments, "function arguments"),
        },
      };
      const previous = messages.at(-1);
      if (previous?.role === "assistant") (previous.tool_calls ??= []).push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      messages.push({ role: "tool", tool_call_id: identifier(item.call_id, "tool call ID"), content: contentText(item.output) });
    } else if (item.type === "reasoning" && !item.encrypted_content && (!Array.isArray(item.summary) || item.summary.length === 0) && !item.content) {
      // Empty bookkeeping is harmless; private reasoning text is not portable context.
    } else {
      throw new Error(`Unsupported local input item type: ${typeof item.type === "string" ? item.type.slice(0, 60) : "unknown"}. Use a Responses-native server for richer inputs.`);
    }
  }
  if (!messages.length) throw new Error("Local model input is empty.");
  const body: Json = {
    model: selectedModel,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(declarations.length ? { tools: declarations } : {}),
  };
  if (request.tool_choice !== undefined) {
    if (["auto", "none", "required"].includes(String(request.tool_choice))) body.tool_choice = request.tool_choice;
    else {
      const choice = object(request.tool_choice);
      const alias = toolAlias(identifier(choice.name, "chosen tool"), choice.namespace == null ? undefined : identifier(choice.namespace, "tool namespace"));
      if (!["function", "custom"].includes(String(choice.type)) || !tools.has(alias)) throw new Error("Unsupported local tool choice.");
      body.tool_choice = { type: "function", function: { name: alias } };
    }
  }
  if (typeof request.parallel_tool_calls === "boolean") body.parallel_tool_calls = request.parallel_tool_calls;
  for (const key of ["temperature", "top_p"] as const) {
    if (request[key] !== undefined) {
      if (typeof request[key] !== "number" || !Number.isFinite(request[key])) throw new Error(`Invalid ${key}.`);
      body[key] = request[key];
    }
  }
  if (request.max_output_tokens !== undefined) {
    if (!Number.isSafeInteger(request.max_output_tokens) || Number(request.max_output_tokens) <= 0) throw new Error("Invalid output token limit.");
    body.max_tokens = request.max_output_tokens;
  }
  return { body, tools, stream: request.stream !== false };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > REQUEST_LIMIT) throw new Error("Local request exceeds its size limit.");
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")
    throw new Error("Compressed local requests are unsupported.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > REQUEST_LIMIT) throw new Error("Local request exceeds its size limit.");
    chunks.push(buffer);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Error("The local request is not valid UTF-8 JSON."); }
}

/** Only SSE data is accepted from the selected local upstream; incomplete streams fail. */
async function* chatEvents(response: Response, maxBytes: number): AsyncGenerator<Json> {
  if (!response.body) throw new Error("The local server returned no response stream.");
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream"))
    throw new Error("The selected local server does not support streaming Chat Completions.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let size = 0;
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { pending += decoder.decode(); break; }
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("Local output exceeded this run's configured limit.");
      pending += decoder.decode(next.value, { stream: true });
      for (;;) {
        const end = /\r?\n\r?\n/.exec(pending);
        if (!end || end.index === undefined) break;
        const block = pending.slice(0, end.index);
        pending = pending.slice(end.index + end[0].length);
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") { done = true; break; }
        let value: unknown;
        try { value = JSON.parse(data); }
        catch { throw new Error("Local server returned malformed streaming JSON."); }
        yield object(value);
      }
      if (done) break;
    }
    if (!done) throw new Error("Local model stream ended without its [DONE] marker.");
  } finally { await reader.cancel().catch(() => undefined); }
}

function safeUsage(value: unknown): Json | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = object(value);
  if (![usage.prompt_tokens, usage.completion_tokens].every((count) => Number.isSafeInteger(count) && Number(count) >= 0)) return undefined;
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: Number(usage.prompt_tokens) + Number(usage.completion_tokens),
  };
}

function sendError(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.end(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "local_bridge_error", message } } })}\n\n`);
  } else {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: { type: "invalid_request_error", message } }));
  }
}

/** Per-run, authenticated loopback bridge. It never executes tools itself. */
export async function startLocalChatBridge(
  value: LocalConnection,
  selectedModel: string,
  signal: AbortSignal,
  limits: { timeoutMs: number; maxBytes: number },
): Promise<{ baseUrl: string; token: string; dispose(): Promise<void> }> {
  const connection = validateLocalConnection(value);
  identifier(selectedModel, "selected model");
  signal.throwIfAborted();
  const token = randomBytes(32).toString("hex");
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const shutdown = new AbortController();
  const running = new Set<AbortController>();
  let requests = 0;
  let active = false;
  let closePromise: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (request.headers.origin || supplied.length !== expectedAuth.length || !timingSafeEqual(supplied, expectedAuth)) {
      sendError(response, 401, "Unauthorized local bridge request.");
      request.resume();
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      sendError(response, 404, "Only full-context POST /v1/responses is supported by this local bridge.");
      request.resume();
      return;
    }
    if (active || requests >= 256 || shutdown.signal.aborted) {
      sendError(response, 429, "The local bridge is busy, closed, or has reached its per-run request limit.");
      request.resume();
      return;
    }
    active = true;
    requests++;
    const controller = new AbortController();
    running.add(controller);
    const abortClient = () => { if (!response.writableFinished) controller.abort(); };
    request.once("aborted", abortClient);
    response.once("close", abortClient);
    const requestSignal = AbortSignal.any([signal, shutdown.signal, controller.signal, AbortSignal.timeout(Math.max(1000, Math.min(limits.timeoutMs, 600000)))]);
    void (async () => {
      const translated = responsesToChat(await readBody(request), selectedModel);
      requestSignal.throwIfAborted();
      let upstream: Response;
      try {
        upstream = await fetch(`${connection.baseUrl}/chat/completions`, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify(translated.body),
          signal: requestSignal,
        });
      } catch { throw new Error(requestSignal.aborted ? "Local model request was cancelled or timed out." : "The configured local Chat Completions endpoint is unreachable."); }
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new Error(`Local Chat Completions failed (HTTP ${upstream.status}). Check model loading, tool support, and context limits in the local server.`);
      }
      const id = `resp_${randomUUID().replaceAll("-", "")}`;
      const created = Math.floor(Date.now() / 1000);
      const output: Json[] = [];
      let sequence = 0;
      let text = "";
      let messageId: string | undefined;
      let finishReason: string | undefined;
      let usage: Json | undefined;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      const envelope = (status: string): Json => ({ id, object: "response", created_at: created, status, model: selectedModel, output, ...(usage ? { usage } : {}) });
      const emit = (type: string, fields: Json = {}) => {
        if (response.destroyed || response.writableEnded || requestSignal.aborted) throw new Error("Local model request was cancelled.");
        if (translated.stream) {
          if (!response.headersSent) response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
          response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
          if (response.writableLength > 2 * 1024 * 1024) throw new Error("Local response consumer is too slow.");
        }
      };
      emit("response.created", { response: envelope("in_progress") });
      for await (const chunk of chatEvents(upstream, Math.max(1024, Math.min(limits.maxBytes, 8 * 1024 * 1024)))) {
        if (chunk.error) throw new Error("The local model reported an error. Check the local server's logs.");
        usage = safeUsage(chunk.usage) ?? usage;
        if (!Array.isArray(chunk.choices)) throw new Error("Local stream contains no choices array.");
        if (chunk.choices.length > 1) throw new Error("Multiple completion choices are not supported.");
        if (!chunk.choices.length) continue;
        const choice = object(chunk.choices[0]);
        if (choice.index !== undefined && choice.index !== 0) throw new Error("Unexpected completion choice index.");
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) finishReason = string(choice.finish_reason, "finish reason", 100);
        const delta = choice.delta === undefined ? {} : object(choice.delta);
        if (delta.content !== undefined && delta.content !== null) {
          const part = string(delta.content, "text delta");
          if (!messageId && part) {
            messageId = `msg_${randomUUID().replaceAll("-", "")}`;
            emit("response.output_item.added", { output_index: 0, item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] } });
            emit("response.content_part.added", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          }
          text += part;
          if (part) emit("response.output_text.delta", { item_id: messageId, output_index: 0, content_index: 0, delta: part });
        }
        if (delta.refusal) throw new Error("The local model declined this request.");
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) throw new Error("Invalid local tool calls.");
          for (const raw of delta.tool_calls) {
            const item = object(raw);
            if (!Number.isInteger(item.index) || Number(item.index) < 0 || Number(item.index) >= TOOL_LIMIT) throw new Error("Invalid local tool index.");
            const index = Number(item.index);
            const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
            if (item.type !== undefined && item.type !== "function") throw new Error("Unsupported local tool-call type.");
            if (item.id !== undefined) call.id += string(item.id, "tool call ID", 256);
            if (item.function !== undefined) {
              const fn = object(item.function);
              if (fn.name !== undefined) call.name += string(fn.name, "tool name", 256);
              if (fn.arguments !== undefined) call.arguments += string(fn.arguments, "tool arguments");
            }
            if (call.id.length > 256 || call.name.length > 256) throw new Error("Oversized local tool identity.");
            calls.set(index, call);
          }
        }
      }
      if (!finishReason) throw new Error("Local stream ended without a completion finish reason.");
      if (finishReason !== "stop" && finishReason !== "tool_calls") throw new Error(`Local completion was not complete (${finishReason.slice(0, 60)}). Reduce context/output or check the local model.`);
      if (finishReason === "tool_calls" && !calls.size) throw new Error("The local model reported tool calls without providing any.");
      const completedCalls: Json[] = [];
      const callIds = new Set<string>();
      for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
        const mapping = translated.tools.get(call.name);
        if (!mapping) throw new Error("The local model requested a tool that was not offered.");
        identifier(call.id, "returned tool call ID");
        if (callIds.has(call.id)) throw new Error("The local model repeated a tool call ID.");
        callIds.add(call.id);
        let args: Json;
        try { args = object(JSON.parse(call.arguments)); }
        catch { throw new Error("The local model returned invalid JSON tool arguments."); }
        const common = { id: `${mapping.custom ? "ctc" : "fc"}_${randomUUID().replaceAll("-", "")}`, call_id: call.id, name: mapping.name, ...(mapping.namespace ? { namespace: mapping.namespace } : {}), status: "completed" };
        completedCalls.push(mapping.custom
          ? { ...common, type: "custom_tool_call", input: string(args.input, "custom tool input") }
          : { ...common, type: "function_call", arguments: call.arguments });
      }
      if (messageId) {
        const content = { type: "output_text", text, annotations: [] };
        emit("response.output_text.done", { item_id: messageId, output_index: 0, content_index: 0, text });
        emit("response.content_part.done", { item_id: messageId, output_index: 0, content_index: 0, part: content });
        const message = { id: messageId, type: "message", role: "assistant", status: "completed", content: [content] };
        output.push(message);
        emit("response.output_item.done", { output_index: 0, item: message });
      }
      for (const call of completedCalls) {
        const index = output.length;
        emit("response.output_item.added", { output_index: index, item: { ...call, status: "in_progress" } });
        output.push(call);
        emit("response.output_item.done", { output_index: index, item: call });
      }
      if (!output.length) throw new Error("The local model completed without visible text or tool calls.");
      const result = envelope("completed");
      emit("response.completed", { response: result });
      if (translated.stream) response.end();
      else {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify(result));
      }
    })().catch((error: unknown) => {
      sendError(response, 502, error instanceof Error && error.name !== "AbortError" ? error.message : "Local model request was cancelled or timed out.");
    }).finally(() => {
      controller.abort();
      running.delete(controller);
      active = false;
      request.removeListener("aborted", abortClient);
      response.removeListener("close", abortClient);
    });
  });
  server.maxConnections = 8;
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 1000;
  const dispose = (): Promise<void> => {
    if (closePromise) return closePromise;
    shutdown.abort();
    signal.removeEventListener("abort", onAbort);
    for (const controller of running) controller.abort();
    closePromise = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closePromise;
  };
  const onAbort = () => { void dispose(); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = () => reject(new Error("Could not start the isolated local model bridge."));
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", onError); resolve(); });
    });
    if (signal.aborted) { await dispose(); signal.throwIfAborted(); }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local bridge did not receive a loopback port.");
    return { baseUrl: `http://127.0.0.1:${address.port}/v1`, token, dispose };
  } catch (error) { await dispose(); throw error; }
}
