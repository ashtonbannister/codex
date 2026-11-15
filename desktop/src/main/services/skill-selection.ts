import path from "node:path";
import type { SkillDescriptor } from "../../shared/skills";
import { renderPluginCommand } from "./plugin-commands";

export interface SkillReference { namespace?: string; name: string; args: string; token: string }
export interface SelectedSkill { source: "imported skill" | "plugin"; package: string; name: string; description: string; path: string; root: string; data: string; descriptor: SkillDescriptor; reference?: SkillReference; verifiedContent?: string; config?: Record<string, string> }

/** Only slash commands at the start or explicit $skill mentions select manual-only skills. */
export function skillReferences(input: string): SkillReference[] {
  const result: SkillReference[] = [];
  const expression = /(^|\s)([/$])([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?::([A-Za-z0-9][A-Za-z0-9_-]{0,63}))?(?=\s|$)/g;
  for (const match of input.matchAll(expression)) {
    const index = match.index! + match[1]!.length;
    if (match[2] === "/" && index !== 0) continue;
    const namespace = match[4] ? match[3] : undefined; const name = match[4] ?? match[3]!;
    result.push({ ...(namespace ? { namespace } : {}), name, args: index === 0 ? input.slice(index + match[0].length - match[1]!.length).trim() : "", token: `${match[2]}${match[3]}${match[4] ? `:${match[4]}` : ""}` });
  }
  return result;
}
export function matchingSkillReference(skill: SkillDescriptor, packageName: string, source: SelectedSkill["source"], references: SkillReference[]): SkillReference | undefined {
  return references.find((reference) => reference.name.toLowerCase() === skill.name.toLowerCase() && (source === "plugin" ? !!reference.namespace && reference.namespace.toLowerCase() === packageName.toLowerCase() : !reference.namespace));
}
export function visibleSkill(skill: SkillDescriptor, reference?: SkillReference, provider?: "codex" | "claude" | "ollama"): boolean {
  if (skill.unsupported?.length || (skill.allowedProviders && (!provider || !skill.allowedProviders.includes(provider)))) return false;
  return !skill.disableModelInvocation || (!!reference && skill.userInvocable !== false);
}
export async function renderExplicitSkill(selected: SelectedSkill, project: string, provider?: "codex" | "claude" | "ollama"): Promise<{ name: string; path: string; warnings: string[]; content: string }> {
  if (!selected.reference) throw new Error("No explicit skill was selected.");
  if (selected.descriptor.allowedProviders && (!provider || !selected.descriptor.allowedProviders.includes(provider))) throw new Error(`The skill ${selected.name} is not available for the selected provider.`);
  if (selected.descriptor.userInvocable === false) throw new Error(`The skill ${selected.name} cannot be invoked directly.`);
  if (selected.descriptor.unsupported?.length) throw new Error(`The skill ${selected.name} is unavailable: ${selected.descriptor.unsupported.join(" ")}`);
  if (selected.verifiedContent === undefined) throw new Error("The selected skill has not been verified.");
  const raw = selected.verifiedContent;
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const content = renderPluginCommand({ name: selected.name, description: selected.description, unsupported: [], warnings: selected.descriptor.warnings ?? [], body }, selected.reference.args, { root: selected.root, data: selected.data, project, skillDir: path.dirname(selected.path), config: selected.config });
  return { name: selected.source === "plugin" ? `${selected.package}:${selected.name}` : selected.name, path: selected.path, warnings: selected.descriptor.warnings ?? [], content };
}
