export interface BundleField {
  key: string;
  type: "string" | "number" | "boolean" | "file" | "directory";
  title: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  multiple: boolean;
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
  skills: Array<{ path: string; name: string; description: string }>;
  servers: PluginServerSummary[];
  disabledServers: string[];
  bundleFields?: BundleField[];
  warnings: string[];
}
