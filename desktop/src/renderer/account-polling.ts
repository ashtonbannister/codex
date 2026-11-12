import type { ProviderLoginStatus } from "../shared/provider-auth";

type Poll = () => Promise<void>;
/** Only observes Nova's in-memory login progress; it never starts account reads. */
export function watchLoginProgress({ read, onUpdate, onError, onPaused, schedule = (callback, delay) => {
  const timer = setTimeout(() => void callback(), delay);
  return () => clearTimeout(timer);
} }: {
  read: () => Promise<ProviderLoginStatus | null>;
  onUpdate: (status: ProviderLoginStatus | null) => void;
  onError: (error: unknown) => void;
  onPaused: () => void;
  schedule?: (callback: Poll, delay: number) => () => void;
}): () => void {
  let stopped = false;
  let failures = 0;
  let cancelTimer: (() => void) | undefined;
  const poll: Poll = async () => {
    try {
      const next = await read();
      if (stopped) return;
      failures = 0;
      // Publish terminal state immediately, independently of any follow-up
      // account-status request. A failed account refresh cannot revive a login.
      onUpdate(next);
      if (next?.state === "starting" || next?.state === "waiting")
        cancelTimer = schedule(poll, 1500);
    } catch (error) {
      if (stopped) return;
      onError(error);
      if (++failures < 3) cancelTimer = schedule(poll, 1500);
      else onPaused();
    }
  };
  cancelTimer = schedule(poll, 500);
  return () => { stopped = true; cancelTimer?.(); };
}
