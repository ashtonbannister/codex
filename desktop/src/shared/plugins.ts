export interface PluginServerSummary {
  name: string;
  transport: string;
  enabled: boolean;
  environmentNames: string[];
  unsupported: string[];
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
