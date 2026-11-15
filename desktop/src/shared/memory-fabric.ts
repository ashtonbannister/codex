/** Portable memory is retained evidence, never provider-private reasoning or authority. */
export type FabricSourceKind = "user" | "assistant" | "note" | "tool" | "import" | "correction" | "checkpoint";
export type FabricSourceStatus = "active" | "superseded";

export interface FabricCoverage {
  status: "complete" | "bounded" | "legacy";
  omissions: string[];
  retainedCharacters: number;
  originalCharacters?: number;
  redacted?: boolean;
}

export interface FabricSourceInput {
  /** Stable origin identity. Repeated capture is idempotent; a new hash is a revision. */
  key: string;
  projectId: string;
  threadId?: string;
  runId?: string;
  provider?: string;
  kind: FabricSourceKind;
  title: string;
  text: string;
  observedAt: string;
  sourceRef?: string;
  revision?: string;
  coverage: FabricCoverage;
}

export interface FabricSpan {
  /** UTF-16 source offsets, matching JavaScript string slicing. */
  start: number;
  end: number;
  text: string;
}

export interface FabricCapsule {
  version: 1;
  spans: FabricSpan[];
  omittedRanges: Array<{ start: number; end: number }>;
  sourceCharacters: number;
  retainedCharacters: number;
  protectedValues: string[];
  /** Extractive capsules are lossy views; the exact retained source remains recoverable. */
  lossy: boolean;
}

export interface FabricSource extends Omit<FabricSourceInput, "text"> {
  id: string;
  sha256: string;
  status: FabricSourceStatus;
  supersedesId?: string;
  createdAt: string;
  compressedBytes: number;
  capsule: FabricCapsule;
}

export interface FabricSearchQuery {
  projectId: string;
  query?: string;
  threadId?: string;
  includeSuperseded?: boolean;
  offset?: number;
  limit?: number;
}

export interface FabricSearchHit {
  source: FabricSource;
  excerpt: string;
  start: number;
  end: number;
  score: number;
}

export interface FabricSearchResult {
  items: FabricSearchHit[];
  total: number;
  offset: number;
  limit: number;
  watermark: number;
}

export interface FabricReadRequest { projectId: string; id: string; offset?: number; limit?: number }
export interface FabricReadResult {
  source: FabricSource;
  text: string;
  offset: number;
  totalCharacters: number;
  nextOffset?: number;
}

export interface FabricCorrectionRequest {
  projectId: string;
  id: string;
  text: string;
  reason?: string;
}
export interface FabricForgetRequest { projectId: string; id: string }
export interface FabricForgetResult { forgottenSources: number; invalidatedPackets: number; warning: string }

export interface FabricStats {
  sources: number;
  activeSources: number;
  supersededSources: number;
  sourceCharacters: number;
  compressedBytes: number;
  packets: number;
  watermark: number;
  migrationPending?: boolean;
  captureWarning?: string;
}

export type FabricObligation = "exact" | "quotation" | "chronology" | "complete-list" | "constraints" | "provenance";
export interface FabricPrepareRequest {
  projectId: string;
  threadId?: string;
  prompt: string;
  maxCharacters?: number;
  excludedKeys?: string[];
}

/** Full source text stays in the worker. Only bounded compiled evidence crosses IPC. */
export interface FabricCandidate { source: FabricSource; text: string; score: number }
export interface FabricEvidence {
  sourceId: string;
  sourceKey: string;
  title: string;
  kind: FabricSourceKind;
  status: FabricSourceStatus;
  observedAt: string;
  provider?: string;
  revision?: string;
  sourceRef?: string;
  sha256: string;
  coverage: FabricCoverage;
  spans: FabricSpan[];
  expanded: boolean;
  omittedCharacters: number;
}

export interface FabricPacket {
  version: 1;
  id: string;
  projectId: string;
  threadId?: string;
  watermark: number;
  createdAt: string;
  mode: "compact" | "evidence";
  obligations: FabricObligation[];
  items: FabricEvidence[];
  omittedSourceIds: string[];
  warnings: string[];
  /** Exact model-facing memory JSON. This, not the entire transport envelope, is budgeted. */
  content: string;
  sha256: string;
  characters: number;
  estimatedTokens: number;
  candidateCharacters: number;
  selectedCharacters: number;
}

export interface FabricPacketReceipt {
  projectId: string;
  runId: string;
  packet: FabricPacket;
  /** Hash of the fully compiled prompt after skills and approved tool instructions. */
  compiledPromptSha256?: string;
}

export interface FabricRunSummary {
  packetId: string;
  watermark: number;
  sourceIds: string[];
  characters: number;
  estimatedTokens: number;
  expandedSources: number;
  warnings: string[];
}
