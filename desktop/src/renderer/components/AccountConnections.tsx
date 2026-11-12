import { LoaderCircle, LogIn, RefreshCw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProviderAccountStatus, ProviderLoginStatus } from "../../shared/provider-auth";
import { api, isPreview } from "../bridge";
import { watchLoginProgress } from "../account-polling";
import { errorText, ProviderMark } from "./primitives";

type AccountProvider = "codex" | "claude";
const names = { codex: "Codex", claude: "Claude Code" };
const accountLabels = {
  "signed-in": "Signed in",
  "signed-out": "Not signed in",
  unavailable: "Unavailable",
  unknown: "Status unknown",
};
const loginActive = (login: ProviderLoginStatus | null) =>
  login?.state === "starting" || login?.state === "waiting";

/** Account checks and browser sign-in remain native operations, never renderer auth. */
export function AccountConnections({ hidden, disabledReason, onBusyChange }: {
  hidden: boolean;
  disabledReason: string;
  onBusyChange: (busy: boolean) => void;
}) {
  const [accounts, setAccounts] = useState<Partial<Record<AccountProvider, ProviderAccountStatus>>>({});
  const [login, setLogin] = useState<ProviderLoginStatus | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pollPaused, setPollPaused] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const mounted = useRef(true);
  const checking = useRef(false);
  const busy = pending !== null || loginActive(login);

  useEffect(() => {
    mounted.current = true;
    // This only reads Nova's in-memory progress; it does not inspect an account.
    void api.getProviderLogin().then((value) => {
      if (mounted.current) setLogin(value);
    }).catch((reason) => { if (mounted.current) setError(errorText(reason)); });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!loginActive(login)) return;
    setPollPaused(false);
    return watchLoginProgress({
      read: () => api.getProviderLogin(),
      onUpdate: (next) => { setError(""); setLogin(next); },
      onError: (reason) => setError(`${errorText(reason)} Retrying sign-in status. Cancel remains available.`),
      onPaused: () => { setPollPaused(true); setError("Sign-in status is unavailable after three attempts. Check progress again or cancel the sign-in; Nova has not assumed the worker stopped."); },
    });
  }, [login?.id, login?.state, pollRevision]);
  useEffect(() => {
    if (login?.state !== "complete") return;
    let cancelled = false;
    const provider = login.provider;
    checking.current = true;
    setPending(`${provider}-check`);
    const refresh = async () => {
      try {
        const status = await api.getAccountStatus(provider);
        if (!cancelled) setAccounts((current) => ({ ...current, [provider]: status }));
      } catch (reason) {
        if (!cancelled) {
          setAccounts((current) => ({ ...current, [provider]: { provider, state: "unknown", checkedAt: new Date().toISOString(), message: "Sign-in completed; the follow-up account check is unavailable." } }));
          setError(`Sign-in completed, but the account status could not be refreshed. ${errorText(reason)} Use Check status to retry.`);
        }
      } finally {
        checking.current = false;
        if (!cancelled) setPending(null);
      }
    };
    void refresh();
    return () => { cancelled = true; };
  }, [login?.id, login?.state, login?.provider]);

  const act = async (provider: AccountProvider, action: "check" | "login") => {
    if (checking.current || busy || disabledReason) return;
    checking.current = true;
    setPending(`${provider}-${action}`); setError("");
    try {
      if (action === "check") {
        const status = await api.getAccountStatus(provider);
        if (mounted.current) setAccounts((current) => ({ ...current, [provider]: status }));
      } else {
        const progress = await api.startProviderLogin(provider);
        if (mounted.current) setLogin(progress);
      }
    } catch (reason) {
      if (mounted.current) {
        setError(errorText(reason));
        if (action === "check") setAccounts((current) => ({ ...current, [provider]: { provider, state: "unknown", checkedAt: new Date().toISOString(), message: "The most recent account check did not complete. Check status again when the connection is available." } }));
      }
    }
    finally { checking.current = false; if (mounted.current) setPending(null); }
  };
  const cancel = async () => {
    if (pending) return;
    setPending("cancel"); setError("");
    try {
      await api.cancelProviderLogin();
      const next = await api.getProviderLogin();
      if (mounted.current) setLogin(next);
    } catch (reason) { if (mounted.current) setError(errorText(reason)); }
    finally { if (mounted.current) setPending(null); }
  };

  return <section className="account-connections" hidden={hidden} aria-label="Provider accounts">
    <h3>Provider accounts</h3>
    <p className="panel-intro">Use your existing sign-in or connect through the official tool. A detected executable is not proof that an account is signed in.</p>
    <div className="account-list">
      {(["codex", "claude"] as const).map((provider) => {
        const account = accounts[provider];
        return <div className="account-row" key={provider}>
          <div className="account-summary"><ProviderMark provider={provider} small /><div><strong>{names[provider]}</strong><p>{account ? accountLabels[account.state] : "Account not checked"}{account?.label ? ` · ${account.label}` : ""}</p>{account?.method && <small>Authentication: {account.method}</small>}</div></div>
          <div className="account-actions">
            <button type="button" className="secondary-button" disabled={busy || !!disabledReason} aria-label={`Check ${names[provider]} account`} onClick={() => void act(provider, "check")}>{pending === `${provider}-check` ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}Check status</button>
            <button type="button" className="secondary-button" disabled={busy || !!disabledReason} aria-label={`Sign in to ${names[provider]}`} onClick={() => void act(provider, "login")}>{pending === `${provider}-login` ? <LoaderCircle size={13} className="spin" /> : <LogIn size={13} />}Sign in</button>
          </div>
          {account?.message && <p className="field-hint account-detail">{account.message}</p>}
        </div>;
      })}
    </div>
    {disabledReason && <p className="context-warning">{disabledReason}</p>}
    {login && <div className={`login-progress ${login.state === "failed" ? "login-failed" : ""}`} role="status" aria-live="polite">
      <div className="login-heading">{loginActive(login) && !pollPaused && <LoaderCircle size={14} className="spin" />}<strong>{names[login.provider]} sign-in</strong><span>{login.state === "complete" ? "Complete" : login.state === "cancelled" ? "Cancelled" : login.state === "failed" ? "Failed" : pollPaused ? "Status unavailable" : "In progress"}</span></div>
      <p>{login.message}</p>
      {login.userCode && <p>One-time code: <code className="login-code">{login.userCode}</code></p>}
      {login.verificationUrl && <p className="field-hint">Official sign-in address: <span className="login-address">{login.verificationUrl}</span></p>}
      {loginActive(login) && <button type="button" className="secondary-button" onClick={() => void cancel()} disabled={pending !== null}>{pending === "cancel" ? <LoaderCircle size={13} className="spin" /> : <Square size={12} />}Cancel sign-in</button>}
      {loginActive(login) && pollPaused && <button type="button" className="secondary-button" onClick={() => setPollRevision((value) => value + 1)} disabled={pending !== null}><RefreshCw size={13} />Check sign-in progress</button>}
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="field-hint">Codex uses the selected Codex home, including its existing official-app sign-in. Claude Code keeps its own account. Neither credential store is copied or shared with local models. Nova does not sign the official apps out.</p>
    {isPreview && <p className="panel-note">Synthetic account controls. This preview cannot launch sign-in, inspect credentials, or contact a provider.</p>}
  </section>;
}
