import path from "node:path";
import { JSON_SCHEMA, load } from "js-yaml";
import type { SkillDescriptor } from "../../shared/skills";
import type { PackageFile } from "./skill-packages";

const unresolved = "This custom fork agent is unavailable or unsupported in the imported package.";
const builtin = new Set(["general-purpose", "Explore", "Plan"]);
export function defaultAgentPaths(files: PackageFile[], plugin = false): string[] {
  return files.filter((file) => /^(?:agents|\.claude\/agents)\/.*\.md$/i.test(file.path) && (!plugin || !file.path.toLowerCase().startsWith(".claude/"))).map((file) => file.path);
}
function agent(file: PackageFile): { name: string; prompt: string; readOnly: boolean; model?: string } | undefined {
  if (file.data.length > 64000) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.data); if (text.includes("\0")) return undefined;
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text); if (!match) return undefined;
    const value: unknown = load(match[1]!, { schema: JSON_SCHEMA }); if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const meta = value as Record<string, unknown>; const prompt = text.slice(match[0].length);
    if (typeof meta.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(meta.name) || typeof meta.description !== "string" || !meta.description.trim() || meta.description.length > 800 || !prompt.trim() || prompt.length > 24000 || /\$\{(?:user_config\.|CLAUDE_|CODEX_|PLUGIN_)/.test(prompt)) return undefined;
    if (Object.keys(meta).some((key) => !["name", "description", "tools", "model", "color"].includes(key)) || (meta.model !== undefined && (typeof meta.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(meta.model))) || (meta.color !== undefined && typeof meta.color !== "string")) return undefined;
    let readOnly = false;
    if (meta.tools !== undefined) {
      const tools = typeof meta.tools === "string" ? meta.tools.split(/[\s,]+/).filter(Boolean) : meta.tools;
      if (!Array.isArray(tools) || tools.some((item) => typeof item !== "string") || tools.length !== 3 || new Set(tools).size !== 3 || !["Read", "Grep", "Glob"].every((item) => tools.includes(item))) return undefined;
      readOnly = true;
    }
    return { name: meta.name, prompt, readOnly, ...(typeof meta.model === "string" && meta.model !== "inherit" ? { model: meta.model } : {}) };
  } catch { return undefined; }
}
function declaredName(file: PackageFile): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.data); const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text); if (!match) return undefined;
    const value = load(match[1]!, { schema: JSON_SCHEMA }); if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const name = (value as Record<string, unknown>).name; return typeof name === "string" ? name : undefined;
  } catch { return undefined; }
}
/** Resolve custom agents only from an explicitly selected, fingerprinted package. */
export function resolveCustomAgents(skills: SkillDescriptor[], files: PackageFile[], paths: string[], namespace?: string): SkillDescriptor[] {
  const allowed = new Set(paths.map((item) => item.toLowerCase()));
  const candidates = files.filter((file) => allowed.has(file.path.toLowerCase())).map((file) => ({ file, definition: agent(file) }));
  return skills.map((skill) => {
    const requested = skill.forkAgent; if (!requested) return skill;
    const unsupported = (skill.unsupported ?? []).filter((reason) => reason !== unresolved);
    const parts = requested.split(":");
    const validNamespace = parts.length === 1 || (parts.length >= 2 && !!namespace && parts[0]!.toLowerCase() === namespace.toLowerCase());
    const target = parts.slice(parts.length > 1 ? 1 : 0).join(":").toLowerCase();
    const matches = validNamespace ? candidates.filter(({ file, definition }) => {
      const declared = declaredName(file)?.toLowerCase();
      const scopedPath = file.path.replace(/^agents\//i, "").replace(/\.md$/i, "").replace(/\//g, ":").toLowerCase();
      return parts.length > 2 ? scopedPath === target : declared === target || path.posix.basename(file.path, ".md").toLowerCase() === target || definition?.name.toLowerCase() === target;
    }) : [];
    if (!matches.length && parts.length === 1 && builtin.has(requested)) return { ...skill, forkAgentPath: undefined, forkAgentReadOnly: undefined, forkAgentModel: undefined, unsupported };
    if (matches.length !== 1 || !matches[0]!.definition) return { ...skill, forkAgentPath: undefined, forkAgentReadOnly: undefined, forkAgentModel: undefined, unsupported: [...unsupported, unresolved] };
    return { ...skill, forkAgentPath: matches[0]!.file.path, forkAgentReadOnly: matches[0]!.definition!.readOnly, forkAgentModel: skill.forkModelInherit ? undefined : matches[0]!.definition!.model, unsupported };
  });
}
export function verifiedAgentPrompt(skill: SkillDescriptor, files: PackageFile[]): string | undefined {
  if (!skill.forkAgentPath) return undefined;
  const file = files.find((entry) => entry.path === skill.forkAgentPath); const parsed = file && agent(file);
  if (!parsed) throw new Error("The selected custom agent is unavailable or unsupported.");
  return parsed.prompt;
}
export const unresolvedCustomAgent = unresolved;
