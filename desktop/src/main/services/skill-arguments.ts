/** Parse Claude named positional arguments without permitting ambiguous placeholders. */
export function parseNamedArguments(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const names = typeof value === "string" ? value.trim().split(/\s+/).filter(Boolean) : value;
  if (!Array.isArray(names) || names.length > 50 || names.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || name === "ARGUMENTS") || new Set(names).size !== names.length) throw new Error("Invalid named skill arguments.");
  return names as string[];
}
