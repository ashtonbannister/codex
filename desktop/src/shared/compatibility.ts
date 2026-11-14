/** Provider-neutral, visible data only. Native provider internals stay with their engine. */
export interface ImportedMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  text: string;
}

export interface CodexThreadSummary {
  id: string;
  title: string;
  cwd: string;
  modelProvider: string;
  createdAt: string;
  updatedAt: string;
  source: string;
  status: string;
  archived: boolean;
}

export interface CodexThreadQuery {
  cursor?: string;
  archived?: boolean;
  search?: string;
}

export interface CodexThreadPage {
  threads: CodexThreadSummary[];
  nextCursor?: string;
  warnings: string[];
}

export interface CodexHistoryQuery {
  threadId: string;
  cursor?: string;
  archived?: boolean;
}

export interface CodexHistoryPage {
  thread: CodexThreadSummary;
  messages: ImportedMessage[];
  nextCursor?: string;
  truncated: boolean;
  warnings: string[];
}

export interface CodexThreadLink {
  /** Imported visible snapshot only. Never a native session-resume target. */
  copyOnly?: boolean;
  home: string;
  sourceThreadId: string;
  sourceCwd: string;
  importedAt: string;
  sourceArchived: boolean;
  /** An engine-created fork for Nova-owned work, never a fabricated native ID. */
  forkedThreadId?: string;
  /** Working directory of that fork; a later isolated Build may need a new fork. */
  forkedCwd?: string;
  history: ImportedMessage[];
  historyTruncated: boolean;
  warnings: string[];
}

export interface CodexImportRequest {
  threadId: string;
  archived?: boolean;
}

export type CodexResourceSection =
  | "memories"
  | "memories_v2"
  | "instructions"
  | "skills"
  | "plans";

export interface CodexLocation {
  id: string;
  name: string;
  path: string;
  resolvedPath?: string;
  exists: boolean;
  access: "content" | "engine-managed" | "excluded";
  detail: string;
}

export interface CodexInstallation {
  home: string;
  exists: boolean;
  locations: CodexLocation[];
  warnings: string[];
}

export interface CodexResource {
  section: CodexResourceSection;
  path: string;
  title: string;
  bytes: number;
}

export interface CodexResourceQuery {
  section: CodexResourceSection;
}

export interface CodexResourcePage {
  resources: CodexResource[];
  truncated: boolean;
  warnings: string[];
}

export interface CodexResourceRequest {
  section: CodexResourceSection;
  path: string;
}

export interface CodexResourcePreview extends CodexResource {
  home: string;
  content: string;
  sha256: string;
}

export interface CodexMemoryImportRequest extends CodexResourceRequest {
  projectId: string;
  /** Exact preview digest; changed files require a new preview/confirmation. */
  expectedSha256: string;
}

export interface CodexMemorySource extends CodexResourceRequest {
  home: string;
  sha256: string;
}
