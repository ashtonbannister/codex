import type { Settings } from "../../shared/types";
import {
  LOCAL_DEFAULTS,
  type LocalConnection,
  type LocalModelCatalog,
} from "../../shared/local-models";
import { startLocalChatBridge } from "./local-chat-bridge";

const MODEL_LIST_LIMIT = 1024 * 1024;
const MODEL_LIMIT = 2048;
const cloudModel = (id: string) => /(?:[:/\-]cloud)(?:$|[:/\-])/i.test(id);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A numerical loopback destination cannot be redirected by a DNS record. */
export function validateLocalConnection(value: unknown): LocalConnection {
  const input = record(value);
  if (!["ollama", "lmstudio", "custom"].includes(String(input.kind)))
    throw new Error("Choose Ollama, LM Studio, or a custom local server.");
  if (!["responses", "chat-completions"].includes(String(input.protocol)))
    throw new Error("Choose the Responses or Chat Completions local protocol.");
  if (
    typeof input.baseUrl !== "string" ||
    input.baseUrl.length > 2048 ||
    /[\s\\\0]/.test(input.baseUrl)
  ) throw new Error("Enter a local API base URL, such as http://127.0.0.1:1234/v1.");
  let url: URL;
  try { url = new URL(input.baseUrl); }
  catch { throw new Error("The local API base URL is invalid."); }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) throw new Error("Local models require a loopback URL without credentials, query, or fragment. Use localhost, 127.0.0.1, or [::1].");
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  if (url.pathname.includes("%") || /\/(?:responses|models|chat\/completions)\/?$/.test(url.pathname))
    throw new Error("Use the API base URL ending in /v1, not a model or completion endpoint.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return {
    kind: input.kind as LocalConnection["kind"],
    protocol: input.protocol as LocalConnection["protocol"],
    baseUrl: url.toString().replace(/\/$/, ""),
  };
}

export function connectionFromSettings(settings: Settings): LocalConnection {
  const kind = settings.localProvider ?? "ollama";
  const defaults = LOCAL_DEFAULTS[kind];
  if (!defaults) throw new Error("Unknown local model server.");
  return validateLocalConnection({
    kind,
    baseUrl: settings.localBaseUrl?.trim() || defaults.baseUrl,
    protocol: settings.localProtocol ?? defaults.protocol,
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body)
    throw new Error(`Local server could not list models (HTTP ${response.status}). Check its API settings; authenticated endpoints are not supported here.`);
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MODEL_LIST_LIMIT) throw new Error("Local server returned an oversized model list.");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new Error("Local server returned an invalid JSON model list."); }
}

/** Metadata only. No model pull, load, inference, credential read, or redirect. */
export async function listLocalModels(
  value: LocalConnection,
  signal?: AbortSignal,
): Promise<LocalModelCatalog> {
  const connection = validateLocalConnection(value);
  const endpoint = connection.kind === "ollama"
    ? `${connection.baseUrl.replace(/\/v1$/, "")}/api/tags`
    : `${connection.baseUrl}/models`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
      redirect: "error",
      headers: { Accept: "application/json" },
    });
  } catch {
    if (signal?.aborted) throw new Error("Local model discovery was cancelled.");
    throw new Error(`Local server is not reachable at ${connection.baseUrl}. Start its API server and check the configured port. No cloud fallback was attempted.`);
  }
  const payload = record(await boundedJson(response));
  const rows = connection.kind === "ollama" ? payload.models : payload.data;
  if (!Array.isArray(rows) || rows.length > MODEL_LIMIT)
    throw new Error("Local server returned an invalid or oversized model catalog.");
  const models: LocalModelCatalog["models"] = [];
  let excluded = 0;
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = record(raw);
    const id = connection.kind === "ollama" ? row.name : row.id;
    if (typeof id !== "string" || !id || id.length > 256 || /[\0\r\n]/.test(id))
      throw new Error("Local server returned an invalid model identifier.");
    if (cloudModel(id) || row.remote_host || row.remote_model || row.remote === true) {
      excluded++;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return {
    connection,
    models,
    warnings: [
      ...(excluded ? [`${excluded} remote/cloud model entries were excluded.`] : []),
      ...(connection.kind === "ollama" ? [] : ["The server's model list is not proof that a model is loaded or supports tools. Nova does not download models."]),
      "A loopback endpoint can itself forward requests elsewhere. Only connect a local server you trust.",
    ],
  };
}

export async function assertLocalModelAvailable(
  model: string,
  settings?: Settings,
  signal?: AbortSignal,
): Promise<void> {
  if (!model || model.length > 256 || /[\0\r\n]/.test(model) || cloudModel(model))
    throw new Error("Choose an already-installed local model, not a remote/cloud model.");
  const connection = settings ? connectionFromSettings(settings) : LOCAL_DEFAULTS.ollama;
  const catalog = await listLocalModels(connection, signal);
  if (!catalog.models.some((entry) => entry.id === model || (connection.kind === "ollama" && entry.id === `${model}:latest`)))
    throw new Error(`Model ${model} is not listed by the selected local server. Refresh the model list and choose an installed model. Nova does not download models.`);
}

/** Per-run connection metadata; dispose must run after the worker stops. */
export async function prepareLocalProvider(
  settings: Settings,
  model: string,
  signal: AbortSignal,
): Promise<{ configArgs: string[]; env?: Record<string, string>; dispose(): Promise<void> }> {
  const connection = connectionFromSettings(settings);
  await assertLocalModelAvailable(model, settings, signal);
  signal.throwIfAborted();
  const bridge = connection.protocol === "chat-completions"
    ? await startLocalChatBridge(connection, model, signal, {
        timeoutMs: Math.min(settings.timeoutMinutes * 60_000, 600_000),
        maxBytes: Math.max(1024 * 1024, Math.min(settings.maxOutputKb * 1024, 8 * 1024 * 1024)),
      })
    : undefined;
  const configArgs = [
    "--config", 'model_provider="nova_local"',
    "--config", 'model_providers.nova_local.name="Nova local model"',
    "--config", `model_providers.nova_local.base_url=${JSON.stringify(bridge?.baseUrl ?? connection.baseUrl)}`,
    "--config", 'model_providers.nova_local.wire_api="responses"',
    "--config", "model_providers.nova_local.requires_openai_auth=false",
    "--config", "model_providers.nova_local.supports_websockets=false",
    // The header is generated in memory for this worker, never saved in Settings.
    ...(bridge ? ["--config", 'model_providers.nova_local.env_http_headers.Authorization="NOVA_LOCAL_BRIDGE_AUTH"'] : []),
  ];
  return {
    configArgs,
    ...(bridge ? { env: { NOVA_LOCAL_BRIDGE_AUTH: `Bearer ${bridge.token}` } } : {}),
    dispose: async () => { await bridge?.dispose(); },
  };
}
