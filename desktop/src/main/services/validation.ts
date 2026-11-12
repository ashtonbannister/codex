import type { MemoryInput, RunRequest, Settings } from "../../shared/types";

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

export function validateRunRequest(value: unknown): RunRequest {
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
    prompt: text(input.prompt, "Prompt", 32_000),
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
  };
}
