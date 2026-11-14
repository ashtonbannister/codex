import { ExternalLink, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { LocalConnection, LocalModelCatalog, LocalProviderKind } from "../../shared/local-models";
import { LOCAL_DEFAULTS } from "../../shared/local-models";
import type { ProviderStatus, Settings } from "../../shared/types";
import type { RecoveryItem } from "../../shared/workspace-actions";
import { api, isPreview } from "../bridge";
import { AccountConnections } from "./AccountConnections";
import { errorText, Modal, ProviderMark } from "./primitives";

type Section = "general" | "agents" | "local" | "storage" | "recovery";
const sections: { id: Section; label: string }[] = [
  { id: "general", label: "General" }, { id: "agents", label: "Agents" },
  { id: "local", label: "Local models" }, { id: "storage", label: "Storage" },
  { id: "recovery", label: "Recovery" },
];
const backendNames = { ollama: "Ollama", lmstudio: "LM Studio", custom: "Custom endpoint" };

export function SettingsForm({ settings, providers, workActive = false, initialSection = "general", onClose, onSaved }: {
  settings: Settings; providers: ProviderStatus[]; workActive?: boolean; initialSection?: Section; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState<Settings>(() => ({
    ...settings,
    localProvider: settings.localProvider ?? "ollama",
    localBaseUrl: settings.localBaseUrl ?? LOCAL_DEFAULTS[settings.localProvider ?? "ollama"].baseUrl,
    localProtocol: settings.localProtocol ?? LOCAL_DEFAULTS[settings.localProvider ?? "ollama"].protocol,
  }));
  const [section, setSection] = useState<Section>(initialSection);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [catalog, setCatalog] = useState<LocalModelCatalog | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const discoveryId = useRef(0);
  const connection: LocalConnection = { kind: values.localProvider ?? "ollama", baseUrl: values.localBaseUrl ?? "", protocol: values.localProtocol ?? "responses" };
  const connectionKey = JSON.stringify(connection);
  const currentConnection = useRef(connectionKey);
  currentConnection.current = connectionKey;
  const currentCatalog = catalog && JSON.stringify(catalog.connection) === connectionKey ? catalog : null;
  const busy = saving || !!choosing || authenticating;
  const unsavedAccountConnection = values.codexPath !== settings.codexPath || values.claudePath !== settings.claudePath;
  const accountDisabledReason = workActive ? "Stop active Nova runs and checks before changing provider accounts." : unsavedAccountConnection ? "Save executable changes before checking or signing in to an account." : saving || choosing ? "Wait for the current settings action to finish." : "";
  const close = () => {
    if (authenticating) {
      setSection("agents");
      setNotice("Finish or cancel sign-in before closing settings.");
    } else onClose();
  };
  useEffect(() => () => { discoveryId.current++; }, []);

  const pick = async (kind: "codex" | "claude" | "codex-home" | "worktrees") => {
    setChoosing(kind); setError("");
    try {
      const path = kind === "codex" || kind === "claude" ? await api.chooseExecutable(kind) : await api.chooseStorageDirectory(kind);
      if (path) {
        const field = kind === "codex" ? "codexPath" : kind === "claude" ? "claudePath" : kind === "codex-home" ? "codexHome" : "worktreeStoragePath";
        setValues((current) => ({ ...current, [field]: path }));
        if (isPreview) setNotice("Synthetic example path selected. No system picker or file access was used.");
      }
    } catch (reason) { setError(errorText(reason)); }
    finally { setChoosing(null); }
  };
  const discover = async () => {
    const request = ++discoveryId.current;
    const key = connectionKey;
    setDiscovering(true); setDiscoveryError(""); setCatalog(null);
    try {
      const result = await api.listLocalModels(connection);
      if (request === discoveryId.current && key === currentConnection.current) setCatalog({ ...result, connection });
    } catch (reason) {
      if (request === discoveryId.current && key === currentConnection.current) setDiscoveryError(errorText(reason));
    } finally { if (request === discoveryId.current) setDiscovering(false); }
  };
  const changeBackend = (kind: LocalProviderKind) => {
    discoveryId.current++; setDiscovering(false); setDiscoveryError(""); setCatalog(null);
    setValues((current) => ({ ...current, localProvider: kind, localBaseUrl: LOCAL_DEFAULTS[kind].baseUrl, localProtocol: LOCAL_DEFAULTS[kind].protocol, localModel: "" }));
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError("");
    try { await api.updateSettings(values); await onSaved(); onClose(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setSaving(false); }
  };
  const help = async (provider: "codex" | "claude" | "ollama" | "lmstudio") => {
    setError("");
    try {
      await api.openProviderHelp(provider);
      setNotice(isPreview ? "Preview only. The desktop app opens the provider’s official setup documentation in your browser." : provider === "codex" || provider === "claude" ? "Official setup documentation opened in your browser. Use the account controls here after saving your executable path." : "Official local-server setup documentation opened in your browser. Load an installed model in your server, then use Load models here.");
    } catch (reason) { setError(errorText(reason)); }
  };

  return <Modal title="Workbench settings" subtitle="Local preferences, accounts, and safe recovery." onClose={close} wide className="workbench-settings">
    <form className="settings-form" onSubmit={save}>
      <div className="settings-callout"><ShieldCheck size={17} /><p>Codex runs and sign-in use Nova’s separate runtime home. OEM Codex data is read-only and used only for explicit imports. Workbench does not copy account tokens. Provider usage limits still apply.</p></div>
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {sections.map((item, index) => <button key={item.id} id={`settings-tab-${item.id}`} type="button" role="tab" aria-selected={section === item.id} aria-controls={`settings-panel-${item.id}`} tabIndex={section === item.id ? 0 : -1} onClick={() => setSection(item.id)} onKeyDown={(event) => {
          let next: number | undefined;
          if (event.key === "ArrowRight") next = (index + 1) % sections.length;
          if (event.key === "ArrowLeft") next = (index + sections.length - 1) % sections.length;
          if (event.key === "Home") next = 0;
          if (event.key === "End") next = sections.length - 1;
          if (next !== undefined) { event.preventDefault(); const id = sections[next]!.id; setSection(id); document.getElementById(`settings-tab-${id}`)?.focus(); }
        }}>{item.label}</button>)}
      </div>
      <div className="settings-panel" role="tabpanel" id={`settings-panel-${section}`} aria-labelledby={`settings-tab-${section}`}>
        <AccountConnections hidden={section !== "agents"} disabledReason={accountDisabledReason} onBusyChange={setAuthenticating} />
        {section === "general" && <>
          <section><h3>Run boundaries</h3><div className="field-row">
            <label className="field"><span>Timeout · minutes</span><input type="number" min={1} max={120} required value={values.timeoutMinutes} onChange={(event) => setValues({ ...values, timeoutMinutes: Number(event.target.value) })} /></label>
            <label className="field"><span>Output limit · KiB</span><input type="number" min={64} max={4096} required value={values.maxOutputKb} onChange={(event) => setValues({ ...values, maxOutputKb: Number(event.target.value) })} /></label>
          </div><p className="field-hint">Process limits, not token or billing caps.</p></section>
          <section><h3>Appearance and drafts</h3><label className="field"><span>Theme</span><select value={values.theme} onChange={(event) => setValues({ ...values, theme: event.target.value as Settings["theme"] })}><option value="dark">Dark</option><option value="light">Light</option><option value="system">Use system setting</option></select></label><p className="field-hint">Unsent text and agent choices are saved on this device for up to 40 recent threads or project drafts. Drafts are not encrypted; do not enter credentials.</p></section>
        </>}
        {section === "agents" && <section><h3>Installed coding agents</h3>
          <div className="settings-provider-list">{providers.map((provider) => <div className="runtime-detail" key={provider.id}><div className="settings-provider"><ProviderMark provider={provider.id} small /><strong>{provider.id === "ollama" ? `Local · ${backendNames[settings.localProvider ?? "ollama"]}` : provider.name}</strong><span className={`provider-state ${provider.available ? "ready" : ""}`}>{provider.available ? "Detected" : "Not detected"}</span></div><p className="field-hint">{provider.detail}</p></div>)}</div>
          {(["codex", "claude"] as const).map((provider) => { const field = provider === "codex" ? "codexPath" : "claudePath"; const name = provider === "codex" ? "Codex" : "Claude Code"; return <div className="field" key={provider}><label htmlFor={`settings-${field}`}>{name} executable</label><div className="directory-field"><input id={`settings-${field}`} value={values[field]} onChange={(event) => setValues({ ...values, [field]: event.target.value })} placeholder={`${provider} or an absolute executable path`} required /><button className="secondary-button" type="button" disabled={busy} aria-label={`Choose ${name} executable`} onClick={() => void pick(provider)}>{choosing === provider ? <LoaderCircle size={14} className="spin" /> : "Browse"}</button></div><button className="text-button setup-help" type="button" onClick={() => void help(provider)}><ExternalLink size={12} />{name} setup & sign-in</button></div>; })}
          <p className="field-hint">Detection reflects saved settings, not unsaved executable paths. Save settings to recheck. Local runs also require Codex; Claude uses its own installed runtime.</p>
        </section>}
        {section === "local" && <section><h3>Connect a local model server</h3>
          <div className="field-row"><label className="field"><span>Local backend</span><select value={connection.kind} onChange={(event) => changeBackend(event.target.value as LocalProviderKind)}><option value="ollama">Ollama</option><option value="lmstudio">LM Studio</option><option value="custom">Custom loopback server</option></select></label><label className="field"><span>API protocol</span><select value={connection.protocol} onChange={(event) => setValues({ ...values, localProtocol: event.target.value as LocalConnection["protocol"] })}><option value="responses">Responses</option><option value="chat-completions">Chat completions</option></select></label></div>
          <label className="field"><span>Local base URL</span><input type="url" value={connection.baseUrl} onChange={(event) => { setValues({ ...values, localBaseUrl: event.target.value }); setDiscoveryError(""); }} placeholder={LOCAL_DEFAULTS[connection.kind].baseUrl} required /><small>Loopback addresses only. Include /v1; choose the protocol supported by your running server. No cloud endpoints or keys.</small></label>
          <div className="model-discovery"><button type="button" className="secondary-button" disabled={discovering || !connection.baseUrl.trim()} onClick={() => void discover()}>{discovering ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}Load models</button><span>{currentCatalog ? `${currentCatalog.models.length} available model${currentCatalog.models.length === 1 ? "" : "s"}` : "Uses the unsaved connection above"}</span></div>
          {discoveryError && <p className="form-error" role="alert">{discoveryError} You can still enter a model ID below.</p>}
          {currentCatalog && <><label className="field"><span>Available models</span><select value={currentCatalog.models.some((item) => item.id === values.localModel) ? values.localModel : ""} onChange={(event) => { if (event.target.value) setValues({ ...values, localModel: event.target.value }); }}><option value="">{currentCatalog.models.length ? "Select a model…" : "No models listed — enter an ID below"}</option>{currentCatalog.models.map((item) => <option key={item.id} value={item.id}>{item.name && item.name !== item.id ? `${item.name} · ${item.id}` : item.id}</option>)}</select></label>{currentCatalog.warnings.map((warning, index) => <p className="field-hint" key={index}>{warning}</p>)}</>}
          <label className="field"><span>Default local model</span><input value={values.localModel} maxLength={256} onChange={(event) => setValues({ ...values, localModel: event.target.value })} placeholder="Exact model ID from your local server" /><small>Choose a listed model or enter its exact ID. No models are downloaded automatically. The composer can override this default per thread.</small></label>
          {connection.kind !== "custom" && <button className="text-button setup-help" type="button" onClick={() => void help(connection.kind as "ollama" | "lmstudio")}><ExternalLink size={12} />{backendNames[connection.kind]} server setup</button>}
          {isPreview && <p className="panel-note">Preview model lists are synthetic. No local server is contacted.</p>}
        </section>}
        {section === "storage" && <section><h3>Local storage</h3>
          <div className="field"><label htmlFor="settings-codex-home">Codex import source <small>optional · read-only</small></label><div className="directory-field"><input id="settings-codex-home" aria-label="Codex import source" value={values.codexHome ?? ""} onChange={(event) => setValues({ ...values, codexHome: event.target.value })} placeholder="Use the existing default .codex folder for imports" /><button type="button" className="secondary-button" aria-label="Choose Codex import source folder" disabled={busy} onClick={() => void pick("codex-home")}>{choosing === "codex-home" ? <LoaderCircle size={14} className="spin" /> : "Browse"}</button></div><small>This is only a source for explicit read/copy/import actions. Changing it does not change Nova’s Codex runtime home or account. Nova never starts workers here, writes back, or copies credentials/configuration.</small></div>
          <p className="panel-note">Nova’s Codex runtime home is app-owned and separate from the import source. Sign in once under Agents to use Codex in Nova; your OEM Codex sign-in and working folders stay separate.</p>
          <div className="field"><label htmlFor="settings-worktrees">Worktree storage <small>optional</small></label><div className="directory-field"><input id="settings-worktrees" aria-label="Worktree storage" value={values.worktreeStoragePath ?? ""} onChange={(event) => setValues({ ...values, worktreeStoragePath: event.target.value })} placeholder="Use Nova’s default worktree directory" /><button type="button" className="secondary-button" aria-label="Choose worktree storage folder" disabled={busy} onClick={() => void pick("worktrees")}>{choosing === "worktrees" ? <LoaderCircle size={14} className="spin" /> : "Browse"}</button></div><small>Applies only to newly created worktrees. Existing threads keep their current location; nothing is moved. Windows junctions and relocated folders remain under your control.</small></div>
          {isPreview && <p className="field-hint">Preview browsing selects synthetic example paths; no system folder picker or file access is used.</p>}
        </section>}
        {section === "recovery" && <RecoveryPanel />}
      </div>
      {notice && <p className="panel-note" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={close}>Cancel</button><button className="primary-button" disabled={busy || workActive} type="submit">{saving && <LoaderCircle className="spin" size={15} />}Save settings</button></div>
    </form>
  </Modal>;
}

function RecoveryPanel() {
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const refresh = async () => {
    const current = ++sequence.current; setLoading(true); setError("");
    try { const result = await api.listRecoveryItems(); if (current === sequence.current) setItems(result); }
    catch (reason) { if (current === sequence.current) setError(errorText(reason)); }
    finally { if (current === sequence.current) setLoading(false); }
  };
  useEffect(() => { void refresh(); return () => { sequence.current++; }; }, []);
  const acknowledge = async (item: RecoveryItem) => {
    setAcknowledging(item.id); setError(""); setNotice("");
    try {
      await api.acknowledgeRecovery({ id: item.id, token: item.token });
      // A cancelled native dialog leaves the item present; do not claim success until refreshed.
      const result = await api.listRecoveryItems(); setItems(result);
      if (!result.some((entry) => entry.id === item.id)) setNotice(isPreview ? "Synthetic recovery acknowledgement recorded for this preview only." : "Recovery acknowledged. The original failure remains in the activity history.");
      else setNotice("Recovery was not acknowledged. The safety lock remains in place.");
    } catch (reason) { setError(errorText(reason)); }
    finally { setAcknowledging(null); }
  };
  return <section className="recovery-panel"><div className="inspector-section-top"><h3>Interrupted worker recovery</h3><button type="button" className="icon-button" aria-label="Refresh recovery items" disabled={loading || !!acknowledging} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? "spin" : ""} /></button></div><p className="panel-intro">A failed Nova worker cleanup can leave a saved safety lock. Legacy Codex-home records are kept for visibility, not used to launch or manage the source Codex installation.</p><p className="context-warning">Before acknowledging, verify in Task Manager that the affected old Nova worker is no longer running. This removes Nova’s saved safety flag; it does not stop a process, repair files, or change OEM Codex. A native confirmation is required.</p>
    {loading ? <p className="panel-loading"><LoaderCircle size={14} className="spin" />Reading recovery state…</p> : items.length ? <div className="recovery-list">{items.map((item) => <article className="recovery-item" key={item.id}><h4>{item.label}</h4><span className="field-hint">{item.kind === "codex-home" ? "Codex home lock" : item.kind === "accounts" ? "Provider account worker lock" : "Project worker lock"}</span><p>{item.detail}</p><button type="button" className="secondary-button" disabled={!!acknowledging} onClick={() => void acknowledge(item)}>{acknowledging === item.id && <LoaderCircle size={14} className="spin" />}I verified the worker stopped…</button></article>)}</div> : !error && <p className="panel-note">No recovery locks recorded. This is not a scan of running processes.</p>}
    {notice && <p className="panel-note" role="status">{notice}</p>}{error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
