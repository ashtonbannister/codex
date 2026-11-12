/** A receipt for an engine-created native conversation, not a copied provider database. */
export interface CodexHandoffReceipt {
  nativeThreadId: string;
  home: string;
  cwd: string;
  fingerprint: string;
  createdAt: string;
  state: "pending" | "published" | "failed";
}

export interface CodexHandoffResult {
  threadId: string;
  nativeThreadId: string;
  title: string;
  createdAt: string;
  warnings: string[];
  unchanged: boolean;
}
