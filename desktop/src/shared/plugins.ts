export interface PluginCommand {
  name: string;
  description: string;
  path?: string;
  argumentHint?: string;
  namedArguments?: string[];
  unsupported: string[];
  warnings: string[];
}

export interface BundleField {
  key: string;
  server?: string;
  type: "string" | "number" | "boolean" | "file" | "directory";
  title: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  multiple: boolean;
  options?: string[];
  min?: number;
  max?: number;
  configured?: boolean;
  value?: string | number | boolean | string[];
}

export interface PluginServerSummary {
  name: string;
  transport: string;
  enabled: boolean;
  environmentNames: string[];
  unsupported: string[];
  endpointOrigin?: string;
  supportsCredential?: boolean;
  credentialStored?: boolean;
  supportsOAuth?: boolean;
  oauthConnected?: boolean;
}
export interface PluginPackage {
  id: string;
  name: string;
  enabled: boolean;
  files: number;
  bytes: number;
  fingerprint: string;
  skills: import("./skills").SkillDescriptor[];
  commands?: PluginCommand[];
  servers: PluginServerSummary[];
  disabledServers: string[];
  bundleFields?: BundleField[];
  warnings: string[];
}
