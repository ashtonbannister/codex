import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CodexInstallation,
  CodexLocation,
  CodexMemorySource,
  CodexResource,
  CodexResourcePage,
  CodexResourcePreview,
  CodexResourceQuery,
  CodexResourceRequest,
  CodexResourceSection,
} from "../../shared/compatibility";
import type { MemoryFreshness } from "../../shared/types";

const MAX_RESOURCE_BYTES = 128 * 1024;
const MAX_RESOURCE_FILES = 500;
const MAX_VISITED = 5000;
const SECTIONS: CodexResourceSection[] = [
  "memories",
  "memories_v2",
  "instructions",
  "skills",
  "plans",
];
const INSTRUCTIONS = new Set(["AGENTS.md", "MODEL_BENCHMARKS.md"]);
const ROOT_NOTES = new Set([
  "MEMORY.md",
  "memory_summary.md",
  "raw_memories.md",
]);

function absolute(value: string, label: string): string {
  if (!value || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(
      `${label} must be an absolute folder path without control characters.`,
    );
  return path.normalize(value);
}

function candidateHome(input?: string): string {
  return absolute(
    input?.trim() ||
      process.env.CODEX_HOME ||
      path.join(os.homedir(), ".codex"),
    "Codex home",
  );
}

export async function resolveCodexHome(input?: string): Promise<string> {
  const candidate = candidateHome(input);
  try {
    const resolved = await realpath(candidate);
    if (!(await stat(resolved)).isDirectory())
      throw new Error("Not a directory");
    return resolved;
  } catch {
    throw new Error(
      "Codex home is missing or unavailable. Choose your existing .codex folder in Settings; Nova will not create or replace it.",
    );
  }
}

type Locations = {
  documents?: string;
  userProfile?: string;
  appData?: string;
  localAppData?: string;
};

/** Metadata-only inventory. No database, credential, browser-storage, or config contents are read. */
export async function inspectCodexInstallation(
  input?: string,
  locations: Locations = {},
): Promise<CodexInstallation> {
  const candidate = candidateHome(input);
  let home = candidate;
  let exists = false;
  const warnings: string[] = [];
  try {
    home = await resolveCodexHome(candidate);
    exists = true;
  } catch {
    warnings.push(
      "No readable Codex home found. Select the existing installation in Settings.",
    );
  }
  const profile =
    locations.userProfile || process.env.USERPROFILE || os.homedir();
  const documents = locations.documents || path.join(profile, "Documents");
  const appData =
    locations.appData ||
    process.env.APPDATA ||
    path.join(profile, "AppData", "Roaming");
  const localAppData =
    locations.localAppData ||
    process.env.LOCALAPPDATA ||
    path.join(profile, "AppData", "Local");
  const entries: Array<Omit<CodexLocation, "exists" | "resolvedPath">> = [];
  const add = (
    id: string,
    name: string,
    file: string,
    access: CodexLocation["access"],
    detail: string,
  ) => entries.push({ id, name, path: file, access, detail });
  add(
    "home",
    "Codex home",
    candidate,
    "engine-managed",
    "Existing engine state. Nova does not copy or migrate the entire directory.",
  );
  add(
    "outputs",
    "Projectless outputs",
    path.join(documents, "Codex"),
    "engine-managed",
    "Location resolved from the Windows Documents folder. Open linked conversations to use their working folders.",
  );
  add(
    "runtimes",
    "Runtime dependencies",
    path.join(profile, ".cache", "codex-runtimes"),
    "engine-managed",
    "Installed runtime and cache ownership stays with Codex.",
  );
  add(
    "agent-plugins",
    "Agent plugins",
    path.join(profile, ".agents", "plugins"),
    "engine-managed",
    "Not automatically enabled, copied, or executed.",
  );
  add(
    "web",
    "App web data",
    path.join(appData, "Codex", "web"),
    "excluded",
    "Browser storage is not imported or shared with providers.",
  );
  add(
    "app-logs",
    "App logs",
    path.join(localAppData, "Codex", "Logs"),
    "engine-managed",
    "Log contents are not scanned or uploaded.",
  );
  const content: Array<[string, string]> = [
    ["memories", "Memory notes"],
    ["memories_v2", "Memory v2 notes"],
    ["skills", "Skills"],
    ["plans", "Saved plans"],
  ];
  for (const [folder, name] of content)
    add(
      folder,
      name,
      path.join(home, folder),
      "content",
      "Selected Markdown can be previewed and explicitly imported as shared project reference text.",
    );
  for (const file of INSTRUCTIONS)
    add(
      file,
      file,
      path.join(home, file),
      "content",
      "Previewable reference text; importing does not automatically grant permissions or run a skill.",
    );
  for (const folder of [
    "sessions",
    "archived_sessions",
    "worktrees",
    "visualizations",
    "attachments",
    "generated_images",
    "automations",
    "plugins",
    "rules",
    "bin",
    "vendor_imports",
    "process_manager",
    "state",
    "sqlite",
    "rollout-migrations",
    "project-metadata-locks",
    "thread-writer-locks",
    "cache",
    "tmp",
    ".tmp",
  ])
    add(
      folder,
      folder.replaceAll("_", " "),
      path.join(home, folder),
      "engine-managed",
      folder.includes("sessions")
        ? "Conversation history is accessed through the installed Codex engine, never by editing its records."
        : "Owned by the installed engine. No automatic migration, deletion, or cross-provider execution.",
    );
  for (const file of [
    "config.toml",
    "thread_history_1.sqlite",
    "state_5.sqlite",
    "goals_1.sqlite",
    "queue_1.sqlite",
    "logs_2.sqlite",
    "memories_1.sqlite",
    "memories_v2_1.sqlite",
    "session_index.jsonl",
    ".codex-global-state.json",
    "models_cache.json",
    "models_cache.codex_work_desktop.json",
  ])
    add(
      file,
      file,
      path.join(home, file),
      "engine-managed",
      "Version-specific engine state; database sidecars and locks are left untouched.",
    );
  for (const folder of [
    "auth.json",
    ".credentials.json",
    "browser",
    "computer-use",
    ".sandbox-secrets",
    ".sandbox",
    ".sandbox-bin",
    ".hook-trust",
    "cap_sid",
    "installation_id",
    "chrome-native-hosts-v2.json",
    "dictation-history",
    "transcription-history.jsonl",
    "realtime-voice-continuity.json",
    "node_repl",
    "shell_snapshots",
    "pets",
    ".chatgpt-projects",
    "ambient-suggestions",
    "code-review-plugin",
  ])
    add(
      folder,
      folder,
      path.join(home, folder),
      "excluded",
      "Not a shared-context source. Credential, browser, runtime, and app-private contents are never read by this importer.",
    );
  const packages = path.join(localAppData, "Packages");
  try {
    const names = (await readdir(packages))
      .filter((name) => /^OpenAI\.Codex(?:_|PrimaryRuntime\.)/.test(name))
      .sort();
    for (const name of names.slice(0, 64))
      add(
        `package-${name}`,
        name,
        path.join(packages, name),
        "excluded",
        "Windows-managed package data; no browser storage or package contents are imported.",
      );
    if (names.length > 64)
      warnings.push(
        "Only the first 64 matching Windows package locations are shown.",
      );
  } catch {
    /* The Windows Packages folder may not exist on this platform. */
  }
  const found: CodexLocation[] = [];
  for (let offset = 0; offset < entries.length; offset += 8) {
    found.push(
      ...(await Promise.all(
        entries.slice(offset, offset + 8).map(async (entry) => {
          try {
            const resolvedPath = await realpath(entry.path);
            await stat(resolvedPath);
            return { ...entry, exists: true, resolvedPath };
          } catch {
            return { ...entry, exists: false };
          }
        }),
      )),
    );
  }
  warnings.push(
    "Folder presence is not a feature or schema guarantee. The installed Codex engine owns history, migrations, queues, and authentication.",
  );
  return { home, exists, locations: found, warnings };
}

function section(value: unknown): CodexResourceSection {
  if (
    typeof value !== "string" ||
    !SECTIONS.includes(value as CodexResourceSection)
  )
    throw new Error("Choose a supported reference section.");
  return value as CodexResourceSection;
}

function relative(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2048 ||
    /[\\\u0000-\u001f\u007f:]/.test(value) ||
    value.startsWith("/") ||
    value
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || part.startsWith("."),
      )
  )
    throw new Error("Reference paths must remain inside the selected section.");
  return value;
}

function eligible(kind: CodexResourceSection, file: string): boolean {
  const parts = file.split("/");
  if (kind === "instructions")
    return parts.length === 1 && INSTRUCTIONS.has(file);
  if (!/\.md$/i.test(file)) return false;
  if (kind === "skills") return parts.at(-1) === "SKILL.md";
  if (kind === "plans") return true;
  return (
    (parts.length === 1 && ROOT_NOTES.has(file)) ||
    (parts[0] === "rollout_summaries" && parts.length === 2) ||
    (parts[0] === "skills" && parts.at(-1) === "SKILL.md")
  );
}

function within(parent: string, file: string): boolean {
  const remainder = path.relative(parent, file);
  return (
    remainder !== "" &&
    remainder !== ".." &&
    !remainder.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(remainder)
  );
}

async function resourceRoot(
  home: string,
  kind: CodexResourceSection,
): Promise<{ home: string; root: string }> {
  const canonicalHome = await resolveCodexHome(home);
  const root =
    kind === "instructions"
      ? canonicalHome
      : await realpath(path.join(canonicalHome, kind));
  if (!(await stat(root)).isDirectory())
    throw new Error("Reference section is not a directory.");
  // A top-level user-created junction is a valid explicitly selected section;
  // descendants must remain inside its resolved root.
  return { home: canonicalHome, root };
}

export async function listCodexResources(
  home: string,
  query: CodexResourceQuery,
): Promise<CodexResourcePage> {
  const kind = section(query?.section);
  let root: string;
  try {
    root = (await resourceRoot(home, kind)).root;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        resources: [],
        truncated: false,
        warnings: ["This section does not exist in the selected installation."],
      };
    throw error;
  }
  const resources: CodexResource[] = [];
  const pending = [""];
  let visited = 0;
  let skipped = false;
  while (
    pending.length &&
    visited < MAX_VISITED &&
    resources.length < MAX_RESOURCE_FILES
  ) {
    const prefix = pending.shift()!;
    const directory = path.join(root, prefix);
    if (prefix) {
      try {
        if (
          (await lstat(directory)).isSymbolicLink() ||
          !within(root, await realpath(directory))
        ) {
          skipped = true;
          continue;
        }
      } catch {
        skipped = true;
        continue;
      }
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      skipped = true;
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > MAX_VISITED || resources.length >= MAX_RESOURCE_FILES)
        break;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const file = prefix ? `${prefix}/${entry.name}` : entry.name;
      try {
        relative(file);
      } catch {
        skipped = true;
        continue;
      }
      if (kind === "instructions" && !INSTRUCTIONS.has(file)) continue;
      if (entry.isSymbolicLink()) {
        skipped = true;
        continue;
      }
      if (entry.isDirectory()) {
        if (kind !== "instructions" && file.split("/").length < 6)
          pending.push(file);
        continue;
      }
      if (!entry.isFile() || !eligible(kind, file)) continue;
      try {
        const resolved = await realpath(path.join(root, file));
        if (!within(root, resolved)) {
          skipped = true;
          continue;
        }
        const info = await stat(resolved);
        if (info.size > MAX_RESOURCE_BYTES || !info.isFile()) {
          skipped = true;
          continue;
        }
        resources.push({
          section: kind,
          path: file,
          title: file,
          bytes: info.size,
        });
      } catch {
        skipped = true;
      }
    }
  }
  const truncated =
    pending.length > 0 ||
    visited > MAX_VISITED ||
    resources.length >= MAX_RESOURCE_FILES;
  const warnings: string[] = [];
  if (skipped)
    warnings.push(
      "Links, unavailable files, and files above 128 KiB were skipped. This browser never follows arbitrary nested links.",
    );
  if (truncated)
    warnings.push(
      "The bounded listing is incomplete; at most 500 resources and 5000 entries are inspected.",
    );
  return { resources, truncated, warnings };
}

/** Explicit, bounded text preview. No config, credentials, SQLite, scripts, or binary attachments. */
export async function previewCodexResource(
  home: string,
  request: CodexResourceRequest,
): Promise<CodexResourcePreview> {
  const kind = section(request?.section);
  const file = relative(request?.path);
  if (!eligible(kind, file))
    throw new Error("This file is not an importable Markdown reference.");
  const { home: canonicalHome, root } = await resourceRoot(home, kind);
  const requested = path.join(root, file);
  // Reject every nested link, including a final-file symlink, before opening.
  let prefix = root;
  for (const part of file.split("/")) {
    prefix = path.join(prefix, part);
    if ((await lstat(prefix)).isSymbolicLink())
      throw new Error(
        "Linked reference files must be imported from their own selected section, not followed implicitly.",
      );
  }
  const canonical = await realpath(requested);
  if (!within(root, canonical))
    throw new Error("Reference resolves outside its selected section.");
  const before = await stat(canonical);
  if (!before.isFile() || before.size > MAX_RESOURCE_BYTES)
    throw new Error(
      "Reference files must be regular Markdown files no larger than 128 KiB.",
    );
  const handle = await open(
    canonical,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  let bytes: Buffer;
  try {
    const current = await handle.stat();
    if (
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs
    )
      throw new Error("Reference changed while opening it. Preview it again.");
    const buffer = Buffer.alloc(MAX_RESOURCE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      length > MAX_RESOURCE_BYTES ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      (await realpath(requested)) !== canonical
    )
      throw new Error(
        "Reference changed or exceeded its size limit. Preview it again.",
      );
    bytes = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Only UTF-8 text references can be imported.");
  }
  if (content.includes("\0"))
    throw new Error("Binary reference contents cannot be imported.");
  return {
    home: canonicalHome,
    section: kind,
    path: file,
    title: file,
    bytes: bytes.length,
    content,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function assessCodexMemoryFreshness(
  source: CodexMemorySource,
): Promise<{ freshness: MemoryFreshness; reason?: string }> {
  try {
    const preview = await previewCodexResource(source.home, source);
    return preview.sha256 === source.sha256
      ? { freshness: "current" }
      : {
          freshness: "changed",
          reason:
            "The imported Codex reference changed. Preview and import it again to review the new content.",
        };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? {
          freshness: "missing",
          reason: "The imported Codex reference is missing.",
        }
      : {
          freshness: "unavailable",
          reason:
            "The imported Codex reference cannot be safely re-read; it is omitted.",
        };
  }
}
