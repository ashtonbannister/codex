/** Explicit, project-local interchange. This is not a provider-private database. */
export interface SharedMemoryFile {
  path: ".nova/MEMORY.md" | "AGENTS.md" | "CLAUDE.md";
  before: string | null;
  after: string;
  sha256: string | null;
  changed: boolean;
}

export interface SharedMemoryPreview {
  projectId: string;
  projectPath: string;
  enabled: boolean;
  fingerprint: string;
  files: SharedMemoryFile[];
  warnings: string[];
}

export interface SharedMemoryRequest {
  projectId: string;
  /** Exact file contents and active-note selection reviewed in the preview. */
  fingerprint: string;
}

export interface SharedMemoryResult {
  projectId: string;
  paths: string[];
  enabled: true;
  message: string;
}
