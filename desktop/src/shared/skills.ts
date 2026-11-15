export interface SkillPackage {
  id: string;
  name: string;
  enabled: boolean;
  skills: Array<{ path: string; name: string; description: string }>;
  files: number;
  bytes: number;
  fingerprint: string;
}
