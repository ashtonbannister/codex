import type { GitChange } from "./types";

export interface WorktreeReview {
  runId: string;
  branch: string;
  head: string;
  fingerprint: string;
  changes: GitChange[];
  canCommit: boolean;
  commitReason?: string;
  canIntegrate: boolean;
  integrationReason?: string;
  targetBranch: string;
  targetHead: string;
  targetFingerprint: string;
}

export interface CommitWorktreeRequest {
  runId: string;
  message: string;
  expectedHead: string;
  expectedFingerprint: string;
}

export interface IntegrateWorktreeRequest {
  runId: string;
  expectedHead: string;
  expectedTargetHead: string;
  expectedTargetBranch: string;
  expectedFingerprint: string;
  expectedTargetFingerprint: string;
}

export interface WorktreeActionResult {
  commit: string;
  branch: string;
  message: string;
}

export interface RecoveryItem {
  id: string;
  kind: "project" | "codex-home";
  label: string;
  detail: string;
  token: string;
}

export interface RecoveryRequest {
  id: string;
  token: string;
}

export interface ConversationExport {
  filename: string;
  content: string;
}

export interface CodexRecoveryAcknowledgement {
  home: string;
  acknowledgedAt: string;
}
