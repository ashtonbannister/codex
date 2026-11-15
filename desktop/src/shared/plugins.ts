export interface PluginServerSummary {
  name: string;
  transport: string;
  enabled: boolean;
  environmentNames: string[];
  unsupported: string[];
  endpointOrigin?: string;
  supportsCredential?: boolean;
  credentialStored?: boolean;
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
  warnings: string[];
}
