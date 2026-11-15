import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { auth, extractResourceMetadataUrl, type OAuthClientInformationContext, type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import type { OAuthIdentity, OAuthRecord, PluginOAuthStore } from "./plugin-oauth-store";

export interface OAuthSettings { clientId?: string; scopes?: string[] }
export type OAuthReview = (request: { title: string; detail: string }) => Promise<boolean>;
const safeUrl = (value: string | URL): URL => {
  const url = new URL(value);
  if (url.username || url.password || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("OAuth requires HTTPS or a literal loopback HTTP endpoint.");
  return url;
};

/** Limit discovery to explicitly reviewed origins and never forward through redirects. */
function reviewedFetch(resource: URL, review: OAuthReview, signal: AbortSignal): typeof fetch {
  const approved = new Set([resource.origin]);
  return async (input, init) => {
    signal.throwIfAborted();
    const url = safeUrl(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (!approved.has(url.origin)) {
      if (!await review({ title: "Contact an authorization service?", detail: `The plugin authorization flow wants to contact ${url.origin}. This service may receive authorization data. Continue only if you trust this destination.` })) throw new Error("Authorization service was declined.");
      signal.throwIfAborted(); approved.add(url.origin);
    }
    const response = await fetch(input, { ...init, redirect: "error", credentials: "omit", signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > 1024 * 1024) throw new Error("OAuth response is too large.");
    if (!response.body) return response;
    let bytes = 0;
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024) throw new Error("OAuth response is too large.");
      controller.enqueue(chunk);
    } }));
    return new Response([204, 205, 304].includes(response.status) ? null : stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

class Provider implements OAuthClientProvider {
  readonly stateValue = randomBytes(32).toString("base64url");
  readonly clientMetadata: OAuthClientMetadata;
  private verifier?: string;
  private authorizationUrl?: URL;
  private client?: StoredOAuthClientInformation;
  private current?: StoredOAuthTokens;
  private discovery?: OAuthDiscoveryState;
  private expiresAt?: number;
  constructor(readonly redirectUrl: string, private readonly settings: OAuthSettings, saved?: OAuthRecord) {
    this.client = saved?.client; this.current = saved?.tokens; this.discovery = saved?.discovery; this.expiresAt = saved?.expiresAt;
    this.clientMetadata = { client_name: "Nova Workbench", redirect_uris: [redirectUrl], application_type: "native", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state(): string { return this.stateValue; }
  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    if (this.settings.clientId) return { client_id: this.settings.clientId, token_endpoint_auth_method: "none", ...(ctx ? { issuer: ctx.issuer } : {}) };
    return this.client && ctx && this.client.issuer === ctx.issuer ? this.client : undefined;
  }
  saveClientInformation(value: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): void { const issuer = ctx?.issuer ?? value.issuer; if (!issuer) throw new Error("OAuth client issuer is missing."); this.client = { ...value, issuer }; }
  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined { return this.current && (!ctx || this.current.issuer === ctx.issuer) ? this.current : undefined; }
  saveTokens(value: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
    const issuer = ctx?.issuer ?? value.issuer; if (!issuer) throw new Error("OAuth token issuer is missing.");
    this.current = { ...value, issuer };
    this.expiresAt = value.expires_in === undefined ? undefined : Date.now() + Math.max(0, value.expires_in * 1000);
  }
  redirectToAuthorization(value: URL): void { this.authorizationUrl = safeUrl(value); }
  saveCodeVerifier(value: string): void { this.verifier = value; }
  codeVerifier(): string { if (!this.verifier) throw new Error("Missing PKCE verifier."); return this.verifier; }
  saveDiscoveryState(value: OAuthDiscoveryState): void { this.discovery = value; }
  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery; }
  get redirect(): URL { if (!this.authorizationUrl) throw new Error("Authorization redirect unavailable."); return this.authorizationUrl; }
  record(): OAuthRecord { if (!this.current) throw new Error("Authorization did not return a token."); return { tokens: this.current, ...(this.client ? { client: this.client } : {}), ...(this.discovery ? { discovery: this.discovery } : {}), ...(this.expiresAt === undefined ? {} : { expiresAt: this.expiresAt }) }; }
}

async function callbackListener(signal: AbortSignal): Promise<{ url: string; wait(state: string): Promise<URLSearchParams>; close(): Promise<void> }> {
  const nonce = randomBytes(24).toString("hex"); let server: Server; let callback: ((params: URLSearchParams) => void) | undefined; let stateValue = "";
  server = createServer((request, response) => {
    const addr = server.address(); const expectedHost = typeof addr === "object" && addr ? `127.0.0.1:${addr.port}` : "";
    if (request.method !== "GET" || request.headers.host !== expectedHost || request.headers.origin || !request.url || request.url.length > 16384) { response.writeHead(400).end(); return; }
    const url = new URL(request.url, `http://${expectedHost}`);
    const params = url.searchParams;
    if (url.pathname !== `/${nonce}` || params.getAll("state").length !== 1 || params.get("state") !== stateValue || params.getAll("code").length > 1 || params.getAll("iss").length > 1 || !callback) { response.writeHead(400).end(); return; }
    const done = callback; callback = undefined;
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'", "Referrer-Policy": "no-referrer" }).end("Return to Nova Workbench. You may close this tab.");
    done(params);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("OAuth callback could not start.");
  return {
    url: `http://127.0.0.1:${address.port}/${nonce}`,
    wait: (state) => new Promise((resolve, reject) => {
      stateValue = state;
      const abort = () => { callback = undefined; reject(new Error("Plugin sign-in was cancelled or timed out.")); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      callback = (params) => { signal.removeEventListener("abort", abort); resolve(params); };
    }),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** Explicit user-initiated OAuth authorization-code flow with SDK PKCE and issuer validation. */
export async function signInPluginOAuth(options: { endpoint: string; settings: OAuthSettings; resourceHeaders?: Record<string, string>; identity: OAuthIdentity; store: PluginOAuthStore; signal: AbortSignal; review: OAuthReview; open: (url: string) => Promise<void>; beforeSave?: () => Promise<void> }): Promise<void> {
  const endpoint = safeUrl(options.endpoint); const finishing = new AbortController(); const signal = AbortSignal.any([options.signal, finishing.signal, AbortSignal.timeout(180_000)]);
  const fetchFn = reviewedFetch(endpoint, options.review, signal); const listener = await callbackListener(signal);
  try {
    const provider = new Provider(listener.url, options.settings);
    const probe = await fetchFn(endpoint, { method: "POST", headers: { ...options.resourceHeaders, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nova-workbench", version: "1" } } }) });
    const resourceMetadataUrl = probe.status === 401 ? extractResourceMetadataUrl(probe) : undefined;
    await probe.body?.cancel();
    if (!probe.ok && probe.status !== 401 && probe.status !== 405) throw new Error("Plugin server refused authorization discovery.");
    const optionsBase = { serverUrl: endpoint, ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(options.settings.scopes ? { scope: options.settings.scopes.join(" ") } : {}), fetchFn };
    const result = await auth(provider, optionsBase);
    if (result !== "REDIRECT") throw new Error("Plugin sign-in did not request authorization.");
    const authorizationUrl = provider.redirect;
    if (!await options.review({ title: "Open the provider sign-in page?", detail: `Nova will open ${authorizationUrl.origin} in your browser to authorize access for ${endpoint.origin}. Review the requested permissions on that page.` })) throw new Error("Plugin sign-in was declined.");
    signal.throwIfAborted();
    const waiting = listener.wait(provider.stateValue);
    void waiting.catch(() => undefined);
    await options.open(authorizationUrl.href);
    const params = await waiting;
    const code = params.get("code"); if (!code || params.has("error")) throw new Error("Plugin authorization was not completed.");
    const status = await auth(provider, { ...optionsBase, authorizationCode: code, ...(params.get("iss") ? { iss: params.get("iss")! } : {}) });
    if (status !== "AUTHORIZED") throw new Error("Plugin authorization was not completed.");
    signal.throwIfAborted(); await options.beforeSave?.(); signal.throwIfAborted(); await options.store.set(options.identity, provider.record());
  } catch (error) {
    if (options.signal.aborted) throw new Error("Plugin sign-in was cancelled.");
    if (error instanceof Error && ["Plugin sign-in was declined.", "Authorization service was declined.", "The plugin changed during sign-in. Import it again before retrying."].includes(error.message)) throw error;
    throw new Error("Plugin sign-in failed or timed out. Check the provider settings and try again.");
  } finally { finishing.abort(); await listener.close(); }
}

/** Refresh only after the run's connection review; if refresh is impossible require another explicit sign-in. */
export async function pluginOAuthToken(options: { endpoint: string; settings: OAuthSettings; identity: OAuthIdentity; store: PluginOAuthStore; signal: AbortSignal; review: OAuthReview }): Promise<string | undefined> {
  const saved = options.store.get(options.identity); if (!saved) return undefined;
  if (saved.expiresAt === undefined || saved.expiresAt > Date.now() + 30_000) return saved.tokens.access_token;
  if (!saved.tokens.refresh_token) throw new Error("Plugin sign-in expired. Sign in again in Settings → Plugins.");
  const endpoint = safeUrl(options.endpoint); const provider = new Provider("http://127.0.0.1/unused", options.settings, saved);
  try {
    const result = await auth(provider, { serverUrl: endpoint, fetchFn: reviewedFetch(endpoint, options.review, options.signal) });
    if (result !== "AUTHORIZED") throw new Error("Sign-in required.");
    const next = provider.record(); await options.store.set(options.identity, next); return next.tokens.access_token;
  } catch { throw new Error("Plugin sign-in could not be refreshed. Sign in again in Settings → Plugins."); }
}
