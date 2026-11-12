/** Provider-owned authentication. These DTOs must never contain credentials. */
export type AccountProvider = "codex" | "claude";

export interface ProviderAccountStatus {
  provider: AccountProvider;
  state: "signed-in" | "signed-out" | "unavailable" | "unknown";
  method?: string;
  label?: string;
  checkedAt: string;
  message?: string;
}

export interface ProviderLoginStatus {
  id: string;
  provider: AccountProvider;
  state: "starting" | "waiting" | "complete" | "failed" | "cancelled";
  message: string;
  /** Ephemeral, allowlisted official sign-in page; never persisted. */
  verificationUrl?: string;
  userCode?: string;
}
