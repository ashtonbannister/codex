import { DesktopControlSession } from "./desktop-control";
import { startLocalMcp } from "./mcp-http";

const tool = {
  name: "desktop",
  description: "Use a user-approved Windows window. First list and select a window, then inspect it. Use only selectors and the observation ID returned by the latest inspection. Every operation requires the user's approval. Never use this tool for authentication, password managers, terminals, system security settings, or the Nova/Codex application itself.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "select", "inspect", "screenshot", "invoke", "set-value", "click", "scroll", "type", "key"] },
      hwnd: { type: "integer", description: "Window handle returned by list; required for select." },
      observation: { type: "string", description: "Latest observation ID; required for invoke and set-value." },
      selector: { type: "string", description: "Element selector from the latest inspection." },
      operation: { type: "string", enum: ["invoke", "select", "toggle", "toggle-on", "toggle-off", "expand", "collapse"] },
      value: { type: "string", description: "Text for set-value or type." },
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      key: { type: "string", enum: ["enter", "tab", "escape", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "backspace", "delete"] },
    },
    required: ["action"], additionalProperties: false,
  },
};

/** Private, per-run desktop MCP connection. */
export async function startDesktopMcp(session: DesktopControlSession, signal: AbortSignal): Promise<{
  url: string; token: string; dispose(): Promise<void>;
}> {
  return startLocalMcp({
    name: "nova-desktop", tools: [tool], signal,
    execute: async (name, args, requestSignal) => {
      if (name !== "desktop") throw new Error("Unknown desktop tool.");
      const outcome = await session.execute(args, requestSignal);
      return { content: [{ type: "text", text: outcome.text }, ...(outcome.image ? [{ type: "image", ...outcome.image }] : [])], isError: false };
    },
    close: () => session.close(),
  });
}
