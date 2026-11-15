import path from "node:path";
import type { BundleField } from "../../shared/plugins";
export type BundleValue = string | number | boolean | string[];
export interface BundleDefinition extends BundleField { defaultValue?: BundleValue }
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid bundle configuration."); return value as Record<string, unknown>; };
export function parseBundleFields(value: unknown): BundleDefinition[] {
  if (value === undefined) return [];
  const entries = Object.entries(object(value)); if (entries.length > 50) throw new Error("Too many bundle configuration fields.");
  return entries.map(([key, raw]) => {
    const field = object(raw);
    if (["__proto__", "constructor", "prototype"].includes(key) || !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(key) || !["string", "number", "boolean", "file", "directory"].includes(String(field.type)) || typeof field.title !== "string" || !field.title || field.title.length > 200 || typeof field.description !== "string" || field.description.length > 2000) throw new Error("Invalid bundle configuration field.");
    for (const name of ["required", "sensitive", "multiple"]) if (field[name] !== undefined && typeof field[name] !== "boolean") throw new Error("Invalid bundle configuration option.");
    if (field.sensitive && field.type !== "string") throw new Error("Only string bundle settings can be sensitive.");
    if (field.multiple && !["file", "directory"].includes(String(field.type))) throw new Error("Only file and directory settings can be multiple.");
    for (const name of ["min", "max"]) if (field[name] !== undefined && (field.type !== "number" || typeof field[name] !== "number" || !Number.isFinite(field[name]))) throw new Error("Invalid bundle number limit.");
    if (typeof field.min === "number" && typeof field.max === "number" && field.min > field.max) throw new Error("Invalid bundle number range.");
    if (Object.keys(field).some((name) => !["type", "title", "description", "required", "sensitive", "multiple", "min", "max", "default"].includes(name))) throw new Error("This bundle uses an unsupported configuration option.");
    const result: BundleDefinition = { key, type: field.type as BundleField["type"], title: field.title, description: field.description, required: field.required === true, sensitive: field.sensitive === true, multiple: field.multiple === true, ...(typeof field.min === "number" ? { min: field.min } : {}), ...(typeof field.max === "number" ? { max: field.max } : {}) };
    if (field.default !== undefined) result.defaultValue = validateBundleValue(result, field.default, true);
    return result;
  });
}
export function validateBundleValue(field: BundleDefinition, value: unknown, isDefault = false): BundleValue {
  if (field.multiple) {
    if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || !item || item.length > 4096 || /[\0\r\n]/.test(item) || (!isDefault && !path.isAbsolute(item)))) throw new Error(`Invalid paths for ${field.title}.`);
    if (field.required && !value.length && !isDefault) throw new Error(`${field.title} requires at least one path.`);
    return [...value] as string[];
  }
  if (field.type === "boolean") { if (typeof value !== "boolean") throw new Error(`Invalid value for ${field.title}.`); return value; }
  if (field.type === "number") { if (typeof value !== "number" || !Number.isFinite(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) throw new Error(`Invalid value for ${field.title}.`); return value; }
  if (typeof value !== "string" || value.length > 4096 || /[\0\r\n]/.test(value) || (field.required && !value && !isDefault) || (!isDefault && value && ["file", "directory"].includes(field.type) && !path.isAbsolute(value))) throw new Error(`Invalid value for ${field.title}.`);
  return value;
}
export function expandBundleDefault(value: BundleValue, paths: Record<string, string>): BundleValue {
  const expand = (item: string) => item.replace(/\$\{(HOME|DESKTOP|DOCUMENTS|DOWNLOADS)\}/g, (_match, name: string) => {
    if (!paths[name]) throw new Error(`The bundle requires an unavailable system folder: ${name}.`);
    return paths[name]!;
  });
  return typeof value === "string" ? expand(value) : Array.isArray(value) ? value.map(expand) : value;
}
export function publicBundleFields(fields: BundleDefinition[]): BundleField[] {
  return fields.map(({ defaultValue, ...field }) => ({ ...field, ...(!field.sensitive && defaultValue !== undefined ? { value: defaultValue } : {}) }));
}
