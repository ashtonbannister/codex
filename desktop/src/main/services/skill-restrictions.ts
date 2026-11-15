const known = ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "PowerShell", "WebFetch", "WebSearch", "mcp__*"];
export function parseSkillDisallowedTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const list = typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : value;
  if (!Array.isArray(list) || !list.length || list.length > known.length || list.some((item) => typeof item !== "string" || !known.includes(item)) || new Set(list).size !== list.length) throw new Error("Unsupported skill tool restrictions.");
  return list as string[];
}
