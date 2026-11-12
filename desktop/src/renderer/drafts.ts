import { useEffect, useRef, useState } from "react";
import type { ProviderId, RunMode } from "../shared/types";

const STORAGE_KEY = "nova-workbench:composer-drafts:v1";
const MAX_DRAFTS = 40;
const MAX_TOTAL_TEXT = 256_000;
const EMPTY = { text: "", provider: "codex" as ProviderId, model: "", mode: "plan" as RunMode, updatedAt: 0 };
interface ComposerDraft { text: string; provider: ProviderId; model: string; mode: RunMode; updatedAt: number }
type Drafts = Record<string, ComposerDraft>;

function bounded(entries: Drafts): Drafts {
  let remaining = MAX_TOTAL_TEXT;
  return Object.fromEntries(Object.entries(entries)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_DRAFTS)
    .flatMap(([key, value]) => {
      const size = JSON.stringify([key, value]).length;
      if (size > remaining) return [];
      remaining -= size;
      return [[key, value]];
    }));
}

function readDrafts(): Drafts {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored || stored.length > 320_000) return {};
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("drafts" in value) || !value.drafts || typeof value.drafts !== "object") return {};
    const valid: Drafts = {};
    for (const [key, item] of Object.entries(value.drafts)) {
      if (!/^(thread|project):.{1,200}$/.test(key) || !item || typeof item !== "object") continue;
      const entry = item as Partial<ComposerDraft>;
      if (typeof entry.text !== "string" || typeof entry.model !== "string" || !["codex", "claude", "ollama"].includes(entry.provider ?? "") || !["plan", "build"].includes(entry.mode ?? "") || typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)) continue;
      valid[key] = { text: entry.text.slice(0, 32_000), model: entry.model.slice(0, 256), provider: entry.provider!, mode: entry.mode!, updatedAt: entry.updatedAt };
    }
    return bounded(valid);
  } catch { return {}; }
}

/** Drafts stay on this device. Derive by key during render, never load a previous thread's text in an effect. */
export function useComposerDraft(projectId: string | null, threadId: string | null) {
  const key = threadId ? `thread:${threadId}` : projectId ? `project:${projectId}:new` : null;
  const [drafts, setDrafts] = useState<Drafts>(readDrafts);
  const [storageWarning, setStorageWarning] = useState("");
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, drafts }));
      setStorageWarning("");
    } catch {
      setStorageWarning("Draft storage is unavailable. Keep this window open to retain unsent text.");
    }
  }, [drafts]);
  const update = (patch: Partial<Omit<ComposerDraft, "updatedAt">>) => {
    if (!key) return;
    setDrafts((current) => {
      const next = { ...(current[key] ?? EMPTY), ...patch, updatedAt: Date.now() };
      next.text = next.text.slice(0, 32_000);
      next.model = next.model.slice(0, 256);
      return bounded({ ...current, [key]: next });
    });
  };
  const clearSubmitted = (submittedKey: string | null, submitted: ComposerDraft, newThreadId: string) => {
    if (!submittedKey) return;
    setDrafts((current) => {
      const previous = current[submittedKey];
      // Do not discard text the user changed while the native start request was pending.
      if (previous && (previous.text !== submitted.text || previous.provider !== submitted.provider || previous.model !== submitted.model || previous.mode !== submitted.mode || previous.updatedAt !== submitted.updatedAt)) return current;
      const next = { ...current, [submittedKey]: { ...submitted, text: "", updatedAt: Date.now() } };
      const destination = `thread:${newThreadId}`;
      if (destination === submittedKey || !next[destination]) next[destination] = { ...submitted, text: "", updatedAt: Date.now() };
      return bounded(next);
    });
  };
  return { key, currentKey, draft: (key ? drafts[key] : undefined) ?? EMPTY, update, clearSubmitted, storageWarning };
}
