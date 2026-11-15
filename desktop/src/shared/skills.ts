export interface SkillDescriptor {
  path: string;
  name: string;
  description: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  namedArguments?: string[];
  shell?: "bash" | "powershell";
  requiresShell?: boolean;
  allowedProviders?: Array<"codex" | "claude" | "ollama">;
  unsupported?: string[];
  warnings?: string[];
}

export interface SkillPackage {
  id: string;
  name: string;
  enabled: boolean;
  skills: SkillDescriptor[];
  files: number;
  bytes: number;
  fingerprint: string;
  unavailable?: string;
}
