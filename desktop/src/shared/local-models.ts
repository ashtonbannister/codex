export type LocalProviderKind = "ollama" | "lmstudio" | "custom";
export type LocalProtocol = "responses" | "chat-completions";

export interface LocalConnection {
  kind: LocalProviderKind;
  /** OpenAI-compatible API base, such as http://127.0.0.1:1234/v1. */
  baseUrl: string;
  protocol: LocalProtocol;
}

export interface LocalModel {
  id: string;
  name?: string;
}

export interface LocalModelCatalog {
  connection: LocalConnection;
  models: LocalModel[];
  warnings: string[];
}

export const LOCAL_DEFAULTS: Record<LocalProviderKind, LocalConnection> = {
  ollama: {
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    protocol: "responses",
  },
  lmstudio: {
    kind: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    protocol: "responses",
  },
  custom: {
    kind: "custom",
    baseUrl: "http://127.0.0.1:8080/v1",
    protocol: "chat-completions",
  },
};
