import type { SkillDescriptor } from "../../shared/skills";
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hook configuration."); return value as Record<string, unknown>; };
/** Only MCP PreToolUse hooks can be intercepted before Nova's plugin gateway sends a call. */
export function parseSkillMcpHooks(value: unknown): SkillDescriptor["mcpHooks"] {
  if (value === undefined) return undefined;
  const root = object(value); if (Object.keys(root).some((key) => key !== "PreToolUse") || !Array.isArray(root.PreToolUse) || !root.PreToolUse.length || root.PreToolUse.length > 12) throw new Error("Unsupported skill hook events.");
  const result: NonNullable<SkillDescriptor["mcpHooks"]> = [];
  for (const item of root.PreToolUse) {
    const group = object(item);
    if (Object.keys(group).some((key) => !["matcher", "hooks"].includes(key)) || typeof group.matcher !== "string" || !Array.isArray(group.hooks) || !group.hooks.length) throw new Error("Unsupported skill hook matcher.");
    const match = /^mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__([A-Za-z0-9_-]+|\.\*)$/.exec(group.matcher);
    if (!match || match[1] === "nova_desktop") throw new Error("Only specific plugin MCP server hooks are supported.");
    for (const entry of group.hooks) {
      const hook = object(entry); if (Object.keys(hook).some((key) => !["type", "command", "timeout"].includes(key)) || hook.type !== "command" || typeof hook.command !== "string" || !hook.command.trim() || hook.command.length > 8192 || /[\0\r\n]/.test(hook.command) || /\$\{(?:user_config\.|CLAUDE_SESSION_ID|CLAUDE_EFFORT)/.test(hook.command)) throw new Error("Unsupported skill hook command.");
      if (hook.timeout !== undefined && (typeof hook.timeout !== "number" || !Number.isFinite(hook.timeout) || hook.timeout <= 0 || hook.timeout > 120)) throw new Error("Invalid skill hook timeout.");
      result.push({ server: match[1]!, tool: match[2]!, command: hook.command, timeoutMs: Math.ceil((hook.timeout as number | undefined ?? 60) * 1000) });
      if (result.length > 12) throw new Error("Too many skill hooks.");
    }
  }
  return result;
}
