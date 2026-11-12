import type {
  MemoryInput,
  RunRequest,
  Settings,
  ThreadUpdate,
  VerificationProfileInput,
  VerificationRequest,
} from "../../shared/types";
import type {
  CodexHistoryQuery,
  CodexImportRequest,
  CodexMemoryImportRequest,
  CodexResourceQuery,
  CodexResourceRequest,
  CodexResourceSection,
  CodexThreadQuery,
} from "../../shared/compatibility";
import path from "node:path";
import { normalizeMemoryFilePath } from "./memory-source";

export function record(
  value: unknown,
  name = "Value",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function text(
  value: unknown,
  name: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.length > maximum
  ) {
    throw new Error(
      `${name} must be text of at most ${maximum} characters without null bytes.`,
    );
  }
  const result = value.trim();
  if (!allowEmpty && !result) throw new Error(`${name} is required.`);
  return result;
}

export function identifier(value: unknown, name = "Identifier"): string {
  const result = text(value, name, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result))
    throw new Error(`${name} is invalid.`);
  return result;
}

export function modelName(value: unknown): string {
  const model = text(value ?? "", "Model", 200, true);
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(model)) {
    throw new Error(
      "Model must be a model identifier, not a command or options.",
    );
  }
  return model;
}

export function absoluteDirectory(value: unknown, name: string): string {
  const result = text(value, name, 32_768);
  if (
    !path.isAbsolute(result) ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(result)
  )
    throw new Error(
      `${name} must be an absolute directory without control characters.`,
    );
  return path.normalize(result);
}

function optionalDirectory(value: unknown, name: string): string | undefined {
  return value === undefined || value === ""
    ? undefined
    : absoluteDirectory(value, name);
}

function archivedFlag(value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error("Archived must be true or false.");
  return value as boolean | undefined;
}

function pageCursor(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value, "Page cursor", 8_192);
}

export function validateCodexThreadQuery(value: unknown): CodexThreadQuery {
  const input = record(value, "Codex thread query");
  return {
    cursor: pageCursor(input.cursor),
    archived: archivedFlag(input.archived),
    search:
      input.search === undefined
        ? undefined
        : text(input.search, "Search", 500, true),
  };
}

export function validateCodexHistoryQuery(value: unknown): CodexHistoryQuery {
  const input = record(value, "Codex history query");
  return {
    threadId: identifier(input.threadId, "Codex thread"),
    cursor: pageCursor(input.cursor),
    archived: archivedFlag(input.archived),
  };
}

export function validateCodexImportRequest(value: unknown): CodexImportRequest {
  const input = record(value, "Codex conversation import");
  return {
    threadId: identifier(input.threadId, "Codex thread"),
    archived: archivedFlag(input.archived),
  };
}

export function validateCodexResourceQuery(value: unknown): CodexResourceQuery {
  const input = record(value, "Codex resource query");
  if (
    !["memories", "memories_v2", "instructions", "skills", "plans"].includes(
      String(input.section),
    )
  )
    throw new Error("Choose an allowed Codex resource section.");
  return { section: input.section as CodexResourceSection };
}

export function validateCodexResourceRequest(
  value: unknown,
): CodexResourceRequest {
  const input = record(value, "Codex resource request");
  const resourcePath = text(
    input.path,
    "Codex resource path",
    2_048,
  ).replaceAll("\\", "/");
  if (
    /[\u0000-\u001f\u007f-\u009f:<>"|?*]/.test(resourcePath) ||
    resourcePath.startsWith("/") ||
    resourcePath
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  )
    throw new Error(
      "Codex resource path must stay inside its selected section.",
    );
  return { ...validateCodexResourceQuery(input), path: resourcePath };
}

export function validateCodexMemoryImportRequest(
  value: unknown,
): CodexMemoryImportRequest {
  const input = record(value, "Codex memory import");
  const expectedSha256 = text(input.expectedSha256, "Preview fingerprint", 64);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new Error("Preview fingerprint must be a SHA-256 digest.");
  return {
    ...validateCodexResourceRequest(input),
    projectId: identifier(input.projectId, "Project"),
    expectedSha256,
  };
}

export function validateRunRequest(
  value: unknown,
  allowEmptyPrompt = false,
): RunRequest {
  const input = record(value, "Run request");
  if (!["codex", "claude", "ollama"].includes(String(input.provider)))
    throw new Error("Unknown provider.");
  if (input.mode !== "plan" && input.mode !== "build")
    throw new Error("Choose Plan or Build mode.");
  return {
    projectId: identifier(input.projectId, "Project"),
    threadId:
      input.threadId === undefined
        ? undefined
        : identifier(input.threadId, "Thread"),
    provider: input.provider as RunRequest["provider"],
    mode: input.mode,
    model: modelName(input.model),
    prompt: text(input.prompt, "Prompt", 32_000, allowEmptyPrompt),
  };
}

export function validateMemoryInput(value: unknown): MemoryInput {
  const input = record(value, "Memory");
  if (!["note", "constraint", "decision"].includes(String(input.kind)))
    throw new Error("Unknown memory kind.");
  return {
    id: input.id === undefined ? undefined : identifier(input.id, "Memory"),
    projectId: identifier(input.projectId, "Project"),
    title: text(input.title, "Memory title", 160),
    content: text(input.content, "Memory content", 8_000),
    kind: input.kind as MemoryInput["kind"],
    source: text(input.source, "Memory source", 500, true) || "User note",
    filePath:
      input.filePath === undefined ||
      (typeof input.filePath === "string" && !input.filePath.trim())
        ? undefined
        : normalizeMemoryFilePath(input.filePath),
  };
}

export function validateThreadUpdate(value: unknown): ThreadUpdate {
  const input = record(value, "Thread update");
  for (const key of ["pinned", "archived"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw new Error(`${key} must be true or false.`);
  }
  if (
    input.title === undefined &&
    input.pinned === undefined &&
    input.archived === undefined
  )
    throw new Error("Choose a thread field to update.");
  return {
    id: identifier(input.id, "Thread"),
    title:
      input.title === undefined
        ? undefined
        : text(input.title, "Thread title", 160).replace(/\s+/g, " "),
    pinned: input.pinned as boolean | undefined,
    archived: input.archived as boolean | undefined,
  };
}

export function validateVerificationProfileInput(
  value: unknown,
): VerificationProfileInput {
  const input = record(value, "Verification profile");
  const executable = text(input.executable, "Verification executable", 2_000);
  const name = text(input.name, "Profile name", 160);
  if (
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(
      executable + name,
    )
  )
    throw new Error(
      "Verification names and executable paths cannot contain control or bidirectional formatting characters.",
    );
  if (
    !Array.isArray(input.args) ||
    input.args.length > 64 ||
    input.args.some(
      (arg) =>
        typeof arg !== "string" || arg.includes("\0") || arg.length > 4_000,
    )
  )
    throw new Error(
      "Verification arguments must be at most 64 text values of 4000 characters each without null bytes.",
    );
  if (
    input.args.reduce((size, arg) => size + (arg as string).length, 0) > 32_000
  )
    throw new Error("Verification arguments exceed 32000 characters.");
  if (
    !Number.isInteger(input.timeoutMinutes) ||
    Number(input.timeoutMinutes) < 1 ||
    Number(input.timeoutMinutes) > 120
  )
    throw new Error(
      "Verification timeout must be a whole number between 1 and 120 minutes.",
    );
  return {
    id: input.id === undefined ? undefined : identifier(input.id, "Profile"),
    projectId: identifier(input.projectId, "Project"),
    name,
    executable,
    args: [...input.args] as string[],
    timeoutMinutes: input.timeoutMinutes as number,
  };
}

export function validateVerificationRequest(
  value: unknown,
): VerificationRequest {
  const input = record(value, "Verification request");
  return {
    runId: identifier(input.runId, "Run"),
    profileId: identifier(input.profileId, "Profile"),
  };
}

export function validateSettings(value: unknown): Settings {
  const input = record(value, "Settings");
  const codexPath = text(input.codexPath, "Codex executable", 2_000);
  const claudePath = text(input.claudePath, "Claude executable", 2_000);
  for (const executable of [codexPath, claudePath]) {
    if (/[\r\n]/.test(executable))
      throw new Error("Executable paths cannot contain line breaks.");
  }
  if (
    !Number.isInteger(input.timeoutMinutes) ||
    Number(input.timeoutMinutes) < 1 ||
    Number(input.timeoutMinutes) > 120
  ) {
    throw new Error(
      "Timeout must be a whole number between 1 and 120 minutes.",
    );
  }
  if (
    !Number.isInteger(input.maxOutputKb) ||
    Number(input.maxOutputKb) < 64 ||
    Number(input.maxOutputKb) > 4_096
  ) {
    throw new Error(
      "Output limit must be a whole number between 64 and 4096 KiB.",
    );
  }
  if (!["dark", "light", "system"].includes(String(input.theme)))
    throw new Error("Unknown theme.");
  return {
    codexPath,
    claudePath,
    localModel: modelName(input.localModel),
    timeoutMinutes: input.timeoutMinutes as number,
    maxOutputKb: input.maxOutputKb as number,
    theme: input.theme as Settings["theme"],
    codexHome: optionalDirectory(input.codexHome, "Codex home"),
    worktreeStoragePath: optionalDirectory(
      input.worktreeStoragePath,
      "Worktree storage",
    ),
  };
}
