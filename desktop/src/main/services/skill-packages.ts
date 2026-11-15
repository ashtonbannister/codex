import { createHash, randomUUID } from "node:crypto";
import { JSON_SCHEMA, load } from "js-yaml";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultAgentPaths, resolveCustomAgents, unresolvedCustomAgent, verifiedAgentPrompt } from "./skill-agents";
import { parseNamedArguments } from "./skill-arguments";
import { removeOwnedTree } from "./owned-tree";
import { withBundleArchive } from "./bundle-archive";
import { matchingSkillReference, skillReferences, visibleSkill, type SelectedSkill } from "./skill-selection";
import type { SkillPackage } from "../../shared/skills";

const MAX_FILES = 2000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_SKILLS = 200;
const MAX_SKILL_BYTES = 128 * 1024;
const idPattern = /^[0-9a-f-]{36}$/;
export type PackageFile = { path: string; data: Buffer; digest: string };
export type PackageSnapshot = { files: PackageFile[]; skills: SkillPackage["skills"]; bytes: number; fingerprint: string };

const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
function inside(root: string, candidate: string): boolean {
  const rel = path.relative(normalize(root), normalize(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function validName(name: string): boolean {
  return !!name && name !== "." && name !== ".." && !/[\\/:\x00-\x1f\x7f]/.test(name);
}
function metadata(content: string, relative: string): SkillPackage["skills"][number] {
  let header: Record<string, unknown> = {};
  if (/^---\r?\n/.test(content)) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!match) throw new Error(`Skill frontmatter is incomplete: ${relative}`);
    try {
      const value = load(match[1]!, { schema: JSON_SCHEMA });
      if (value != null && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("Invalid frontmatter.");
      header = (value ?? {}) as Record<string, unknown>;
    } catch { throw new Error(`Skill frontmatter is invalid: ${relative}`); }
  }
  const flag = (key: string, fallback: boolean): boolean => {
    const value = header[key]; if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    if (value === 1 || (typeof value === "string" && /^(?:true|yes|on|1)$/i.test(value))) return true;
    if (value === 0 || (typeof value === "string" && /^(?:false|no|off|0)$/i.test(value))) return false;
    throw new Error(`Invalid skill invocation setting ${key}: ${relative}`);
  };
  const name = typeof header.name === "string" && header.name.trim() ? header.name.trim().slice(0, 800) : path.posix.basename(path.posix.dirname(relative)) || "skill";
  const description = typeof header.description === "string" ? header.description.replace(/\s+/g, " ").trim().slice(0, 800) : "";
  const unsupported: string[] = [], warnings: string[] = [];
  let forkAgent: string | undefined;
  if (header.context === "fork") {
    if (header.agent === undefined) forkAgent = "general-purpose";
    else if (typeof header.agent === "string" && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(header.agent)) { forkAgent = header.agent; if (!["general-purpose", "Explore", "Plan"].includes(forkAgent)) unsupported.push(unresolvedCustomAgent); }
    else unsupported.push("This skill requests an invalid fork agent.");
    try { flag("background", true); } catch { unsupported.push("Invalid fork background setting."); }
    warnings.push("Forked skills require explicit invocation and run in a separate provider session.");
  } else if (header.context !== undefined || header.agent !== undefined || header.background !== undefined) unsupported.push("This skill requests an unsupported context or agent.");
  let skillModel: string | undefined;
  if (header.model !== undefined && header.model !== "inherit") {
    if (typeof header.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(header.model)) { skillModel = header.model; warnings.push("This skill requests a Claude model override and requires explicit invocation."); }
    else unsupported.push("This skill requests an invalid model override.");
  }
  if (header.hooks !== undefined) unsupported.push("Skill hooks are not supported.");
  if (header["disallowed-tools"] !== undefined) unsupported.push("Skill-specific tool restrictions are not supported.");
  let namedArguments: string[] | undefined;
  try { namedArguments = parseNamedArguments(header.arguments); } catch { unsupported.push("Invalid named skill arguments."); }
  if (header["allowed-tools"] !== undefined) warnings.push("Requested tool preapprovals are not granted; Nova's normal permissions still apply.");
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const requiresShell = /(?:^|\s)!`[^`\r\n]+`|^```![ \t]*\r?\n[\s\S]*?^```[ \t]*(?=\r?$)/m.test(body);
  if (header.shell !== undefined && header.shell !== "bash" && header.shell !== "powershell") unsupported.push("This skill requests an unsupported shell.");
  if (requiresShell) warnings.push("Shell-generated context requires explicit invocation and command approval.");
  if (/\$\{user_config\./.test(body)) unsupported.push("This skill requires plugin settings.");
  if (/\$\{CLAUDE_SESSION_ID/.test(body)) unsupported.push("This skill uses unsupported context variables.");
  const disableModelInvocation = flag("disable-model-invocation", false) || requiresShell || !!forkAgent || !!skillModel, userInvocable = flag("user-invocable", true);
  if (disableModelInvocation && !userInvocable) unsupported.push("Both user and model invocation are disabled.");
  return { path: relative, name, description, disableModelInvocation, userInvocable, ...(namedArguments ? { namedArguments } : {}), ...(requiresShell ? { requiresShell: true } : {}), ...(forkAgent ? { forkAgent } : {}), ...(skillModel ? { skillModel } : {}), ...(header.model === "inherit" ? { forkModelInherit: true } : {}), ...(header.shell === "bash" || header.shell === "powershell" ? { shell: header.shell } : {}), ...(unsupported.length ? { unsupported } : {}), ...(warnings.length ? { warnings } : {}) };
}

/** Produce a deterministic copy excluding unselected manual-only skill files. */
export function filterSkillSnapshot(snapshot: PackageSnapshot, selected: SkillPackage["skills"]): PackageSnapshot {
  const selectedPaths = new Set(selected.map((skill) => skill.path));
  const hidden = snapshot.skills.filter((skill) => !selectedPaths.has(skill.path));
  const selectedDirs = selected.map((skill) => path.posix.dirname(skill.path));
  const files = snapshot.files.filter((file) => !hidden.some((skill) => {
    const dir = path.posix.dirname(skill.path);
    if (dir === ".") return file.path === skill.path || file.path.toLowerCase() === "agents/openai.yaml";
    if (file.path !== skill.path && !file.path.startsWith(`${dir}/`)) return false;
    return !selectedDirs.some((visible) => visible !== "." && visible.startsWith(`${dir}/`) && (file.path === visible || file.path.startsWith(`${visible}/`)));
  }));
  const fingerprint = createHash("sha256").update(JSON.stringify(files.map(({ path: file, digest, data }) => [file, data.length, digest]))).digest("hex");
  return { files, skills: selected, bytes: files.reduce((sum, file) => sum + file.data.length, 0), fingerprint };
}

/** A bounded snapshot of the entire selected package; no links or special files are followed. */
export async function snapshotSkillPackage(selected: string, options: { allowNoSkills?: boolean } = {}): Promise<PackageSnapshot> {
  if (!path.isAbsolute(selected)) throw new Error("Choose an absolute skill package folder.");
  const top = await lstat(selected);
  if (!top.isDirectory() || top.isSymbolicLink()) throw new Error("Choose a real folder, not a link.");
  const root = await realpath(selected);
  const files: PackageFile[] = [];
  let bytes = 0;
  async function visit(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > 16) throw new Error("Skill package exceeds the 16-folder depth limit.");
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await realpath(dir))) throw new Error("Skill package contains a linked or changed folder.");
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!validName(entry.name)) throw new Error("Skill package contains an unsupported file name.");
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Skill package contains a link: ${rel}`);
      if (entry.isDirectory()) { await visit(full, rel, depth + 1); continue; }
      if (!entry.isFile() || files.length >= MAX_FILES) throw new Error("Skill package contains a special file or exceeds the 2000-file limit.");
      const before = await lstat(full);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > MAX_BYTES - bytes || !inside(root, await realpath(full)))
        throw new Error(`Skill package contains an unsafe or oversized file: ${rel}`);
      const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let data: Buffer;
      try {
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs)
          throw new Error(`Skill package changed while reading: ${rel}`);
        data = await handle.readFile();
        const after = await handle.stat();
        if (data.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || !inside(root, await realpath(full)))
          throw new Error(`Skill package changed while reading: ${rel}`);
      } finally { await handle.close(); }
      bytes += data.length;
      files.push({ path: rel, data, digest: createHash("sha256").update(data).digest("hex") });
    }
  }
  await visit(root, "", 0);
  const skills: SkillPackage["skills"] = [];
  for (const file of files.filter((entry) => path.posix.basename(entry.path) === "SKILL.md")) {
    if (file.data.length > MAX_SKILL_BYTES || skills.length >= MAX_SKILLS) throw new Error("Skill definitions exceed the import limits.");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(file.data); }
    catch { throw new Error(`Skill definition is not UTF-8: ${file.path}`); }
    if (content.includes("\0")) throw new Error(`Skill definition is not text: ${file.path}`);
    const skill = metadata(content, file.path);
    const policyPath = path.posix.join(path.posix.dirname(file.path), "agents", "openai.yaml");
    const policies = files.filter((entry) => entry.path.toLowerCase() === policyPath.toLowerCase());
    if (policies.length > 1 || (policies[0]?.data.length ?? 0) > MAX_SKILL_BYTES) throw new Error(`Skill policy is ambiguous or too large: ${policyPath}`);
    if (policies.length) {
      let config: Record<string, unknown>;
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(policies[0]!.data); const value = load(decoded, { schema: JSON_SCHEMA });
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid policy."); config = value as Record<string, unknown>;
      } catch { throw new Error(`Skill policy is invalid: ${policyPath}`); }
      if (config.policy !== undefined) {
        if (!config.policy || typeof config.policy !== "object" || Array.isArray(config.policy)) throw new Error(`Skill policy is invalid: ${policyPath}`);
        const policy = config.policy as Record<string, unknown>;
        if (policy.allow_implicit_invocation !== undefined && typeof policy.allow_implicit_invocation !== "boolean") throw new Error(`Skill invocation policy is invalid: ${policyPath}`);
        if (policy.allow_implicit_invocation === false) skill.disableModelInvocation = true;
        if (policy.products !== undefined) {
          if (!Array.isArray(policy.products) || !policy.products.length || policy.products.some((item) => item !== "CHAT" && item !== "CODEX")) throw new Error(`Skill product policy is invalid: ${policyPath}`);
          skill.allowedProviders = policy.products.includes("CODEX") ? ["codex", "ollama"] : [];
        }
        if (Object.keys(policy).some((key) => !["allow_implicit_invocation", "products"].includes(key))) (skill.unsupported ??= []).push("This skill declares an unsupported OpenAI policy.");
      }
      if (config.dependencies !== undefined) (skill.warnings ??= []).push("This skill declares tool dependencies; enable and review the required tools separately.");
    }
    if (skill.disableModelInvocation && skill.userInvocable === false && !skill.unsupported?.includes("Both user and model invocation are disabled.")) (skill.unsupported ??= []).push("Both user and model invocation are disabled.");
    skills.push(skill);
  }
  if (!skills.length && !options.allowNoSkills) throw new Error("No SKILL.md file was found in this folder. Select a skill folder or a package containing skills.");
  const fingerprint = createHash("sha256").update(JSON.stringify(files.map(({ path: file, digest, data }) => [file, data.length, digest]))).digest("hex");
  return { files, skills: resolveCustomAgents(skills, files, defaultAgentPaths(files)), bytes, fingerprint };
}

export class SkillPackageStore {
  private readonly root: string;
  constructor(private readonly dataDir: string) { this.root = path.join(dataDir, "skill-packages"); }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || normalize(await realpath(this.root)) !== normalize(this.root))
      throw new Error("Nova's skill package storage is unavailable or redirected.");
  }
  async preview(selected: string): Promise<{ name: string; files: number; bytes: number; fingerprint: string; skills: SkillPackage["skills"] }> {
    await this.ensureRoot();
    if ((await lstat(selected)).isFile()) {
      const archive = await realpath(selected);
      if (inside(this.dataDir, archive)) throw new Error("Choose an archive separate from Nova's skill storage.");
      const name = path.basename(selected).replace(/\.(?:zip|skill|plugin)$/i, "").slice(0, 128) || "Imported skills";
      return withBundleArchive(selected, this.dataDir, async (folder) => ({ ...await this.preview(folder), name }));
    }
    const source = await realpath(selected);
    if (inside(source, this.root) || inside(this.root, source)) throw new Error("Choose a source separate from Nova's skill storage.");
    const snapshot = await snapshotSkillPackage(selected);
    return { name: path.basename(source), files: snapshot.files.length, bytes: snapshot.bytes, fingerprint: snapshot.fingerprint, skills: snapshot.skills };
  }
  async install(selected: string, fingerprint: string, archiveName?: string): Promise<SkillPackage> {
    await this.ensureRoot();
    if ((await lstat(selected)).isFile()) {
      const archive = await realpath(selected);
      if (inside(this.dataDir, archive)) throw new Error("Choose an archive separate from Nova's skill storage.");
      const name = path.basename(selected).replace(/\.(?:zip|skill|plugin)$/i, "").slice(0, 128) || "Imported skills";
      return withBundleArchive(selected, this.dataDir, (folder) => this.install(folder, fingerprint, name));
    }
    const preview = await this.preview(selected);
    if (preview.fingerprint !== fingerprint) throw new Error("The selected package changed. Review it again before importing.");
    const snapshot = await snapshotSkillPackage(selected);
    if (snapshot.fingerprint !== fingerprint) throw new Error("The selected package changed. Review it again before importing.");
    const id = randomUUID();
    const directory = path.join(this.root, id);
    const pkg: SkillPackage = { id, name: archiveName ?? preview.name, enabled: true, files: snapshot.files.length, bytes: snapshot.bytes, fingerprint, skills: snapshot.skills };
    await mkdir(directory, { mode: 0o700 });
    try {
      const contents = path.join(directory, "files");
      await mkdir(contents, { mode: 0o700 });
      for (const entry of snapshot.files) {
        const target = path.join(contents, ...entry.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, entry.data, { flag: "wx", mode: 0o600 });
      }
      await writeFile(path.join(directory, "package.json"), JSON.stringify(pkg), { flag: "wx", mode: 0o600 });
      return pkg;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  private async readPackage(id: string, verify = true): Promise<SkillPackage> {
    if (!idPattern.test(id)) throw new Error("Invalid skill package ID.");
    const dir = path.join(this.root, id);
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(this.root, await realpath(dir))) throw new Error("Skill package storage was redirected.");
    const manifest = path.join(dir, "package.json");
    if ((await lstat(manifest)).isSymbolicLink()) throw new Error("Skill package manifest was redirected.");
    const pkg = JSON.parse(await readFile(manifest, "utf8")) as SkillPackage;
    if (pkg.id !== id || typeof pkg.name !== "string" || typeof pkg.enabled !== "boolean" || !Array.isArray(pkg.skills) || pkg.skills.length > MAX_SKILLS || !pkg.skills.every((skill) => skill && typeof skill.path === "string" && typeof skill.name === "string" && typeof skill.description === "string") || !Number.isSafeInteger(pkg.files) || !Number.isSafeInteger(pkg.bytes) || !/^[a-f0-9]{64}$/.test(pkg.fingerprint)) throw new Error("Invalid skill package manifest.");
    if (!verify) return pkg;
    const snapshot = await snapshotSkillPackage(path.join(dir, "files"));
    if (snapshot.fingerprint !== pkg.fingerprint) throw new Error(`Imported skill package ${pkg.name} changed. Disable it or import a fresh copy.`);
    return { ...pkg, skills: snapshot.skills, files: snapshot.files.length, bytes: snapshot.bytes };
  }
  async list(): Promise<SkillPackage[]> {
    await this.ensureRoot();
    const names = (await readdir(this.root)).filter((name) => idPattern.test(name)).sort();
    if (names.length > 100) throw new Error("Too many installed skill packages.");
    const packages: SkillPackage[] = [];
    for (const name of names) {
      try { packages.push(await this.readPackage(name, true)); }
      catch {
        const pkg = await this.readPackage(name, false);
        packages.push({ ...pkg, skills: [], unavailable: "This package could not be verified. Disable it or import a fresh copy before starting a run." });
      }
    }
    return packages;
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("Invalid skill package setting.");
    await this.ensureRoot();
    const pkg = await this.readPackage(id, enabled);
    const file = path.join(this.root, id, "package.json");
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ ...pkg, enabled }), { flag: "wx", mode: 0o600 });
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
  }
  private async enabled(): Promise<SkillPackage[]> {
    const packages = (await this.list()).filter((pkg) => pkg.enabled);
    const unavailable = packages.find((pkg) => pkg.unavailable);
    if (unavailable) throw new Error(`Imported skill package ${unavailable.name} changed or could not be verified. Disable it or import a fresh copy.`);
    return packages;
  }
  private entries(packages: Array<{ pkg: SkillPackage; selected: SkillPackage["skills"] }>, location: (pkg: SkillPackage) => string): Array<{ source: string; package: string; name: string; description: string; path: string }> {
    const skills = packages.flatMap(({ pkg, selected }) => selected.map((skill) => ({ source: "imported skill", package: pkg.name, name: skill.name, description: skill.description, path: path.join(location(pkg), ...skill.path.split("/")) })));
    if (skills.length > MAX_SKILLS) throw new Error("Too many enabled skills. Disable a package before starting a run.");
    return skills;
  }
  private catalog(skills: ReturnType<SkillPackageStore["entries"]>): string {
    if (!skills.length) return "";
    return `\n\nAvailable user-imported skills (review the applicable SKILL.md before using it; resolve its relative references from that file). These are user-selected instructions, subject to the task and higher-priority boundaries. Imported files may be read by the selected provider:\n${JSON.stringify(skills, null, 2)}`;
  }
  async prompt(input = "", provider?: "codex" | "claude" | "ollama"): Promise<string> {
    const references = skillReferences(input);
    const plans = (await this.enabled()).map((pkg) => ({ pkg, selected: pkg.skills.filter((skill) => !skill.forkAgent && visibleSkill(skill, matchingSkillReference(skill, pkg.name, "imported skill", references), provider)) }));
    return this.catalog(this.entries(plans, (pkg) => path.join(this.root, pkg.id, "files")));
  }
  async previewInvoked(input: string): Promise<SelectedSkill[]> {
    const references = skillReferences(input); const packages = await this.enabled(); const result: SelectedSkill[] = [];
    for (const pkg of packages) {
      const matched = pkg.skills.filter((skill) => !!matchingSkillReference(skill, pkg.name, "imported skill", references)); if (!matched.length) continue;
      const root = path.join(this.root, pkg.id, "files"); const snapshot = await snapshotSkillPackage(root);
      if (snapshot.fingerprint !== pkg.fingerprint) throw new Error(`Skill package ${pkg.name} changed before preview.`);
      for (const skill of matched) {
        const file = snapshot.files.find((entry) => entry.path === skill.path); if (!file) throw new Error("The selected skill is unavailable.");
        result.push({ source: "imported skill", package: pkg.name, name: skill.name, description: skill.description, path: path.join(root, ...skill.path.split("/")), root, data: root, descriptor: skill, reference: matchingSkillReference(skill, pkg.name, "imported skill", references), verifiedContent: new TextDecoder("utf-8", { fatal: true }).decode(file.data), agentPrompt: verifiedAgentPrompt(skill, snapshot.files) });
      }
    }
    return result;
  }
  /** Each run gets disposable copies, so Claude's --add-dir cannot modify installed packages. */
  async prepareRun(input = "", provider?: "codex" | "claude" | "ollama"): Promise<{ prompt: string; directory?: string; review: Array<{ source: string; package: string; name: string; description: string; path: string }>; invoked: SelectedSkill[]; verify(): Promise<void>; dispose(): Promise<void> }> {
    const references = skillReferences(input);
    const packages = (await this.enabled()).map((pkg) => ({ pkg, selected: pkg.skills.filter((skill) => visibleSkill(skill, matchingSkillReference(skill, pkg.name, "imported skill", references), provider)), matched: pkg.skills.filter((skill) => !!matchingSkillReference(skill, pkg.name, "imported skill", references)) })).filter((plan) => plan.selected.length || plan.matched.length);
    if (!packages.length) return { prompt: "", review: [], invoked: [], verify: async () => {}, dispose: async () => {} };
    const runs = path.join(this.dataDir, "skill-run-copies");
    await mkdir(runs, { recursive: true, mode: 0o700 });
    const info = await lstat(runs);
    if (!info.isDirectory() || info.isSymbolicLink() || normalize(await realpath(runs)) !== normalize(runs)) throw new Error("Skill run-copy storage is unavailable or redirected.");
    const directory = path.join(runs, randomUUID());
    await mkdir(directory, { mode: 0o700 });
    try {
      const fingerprints = new Map<string, string>(); const verifiedContents = new Map<string, string>(); const agentPrompts = new Map<string, string>();
      for (const { pkg, selected, matched } of packages) {
        const snapshot = await snapshotSkillPackage(path.join(this.root, pkg.id, "files"));
        if (snapshot.fingerprint !== pkg.fingerprint) throw new Error(`Imported skill package ${pkg.name} changed before launch.`);
        for (const skill of matched) { const file = snapshot.files.find((entry) => entry.path === skill.path); if (!file) throw new Error("The selected skill is unavailable."); verifiedContents.set(`${pkg.id}\0${skill.path}`, new TextDecoder("utf-8", { fatal: true }).decode(file.data)); const prompt = verifiedAgentPrompt(skill, snapshot.files); if (prompt) agentPrompts.set(`${pkg.id}\0${skill.path}`, prompt); }
        if (!selected.length) continue;
        const filtered = filterSkillSnapshot(snapshot, selected); fingerprints.set(pkg.id, filtered.fingerprint);
        for (const entry of filtered.files) {
          const target = path.join(directory, pkg.id, ...entry.path.split("/"));
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, entry.data, { flag: "wx", mode: 0o700 });
        }
      }
      const review = this.entries(packages, (pkg) => path.join(directory, pkg.id));
      const invoked: SelectedSkill[] = packages.flatMap(({ pkg, matched }) => matched.map((skill) => ({ source: "imported skill" as const, package: pkg.name, name: skill.name, description: skill.description, path: path.join(directory, pkg.id, ...skill.path.split("/")), root: path.join(directory, pkg.id), data: path.join(directory, pkg.id), descriptor: skill, reference: matchingSkillReference(skill, pkg.name, "imported skill", references), verifiedContent: verifiedContents.get(`${pkg.id}\0${skill.path}`), agentPrompt: agentPrompts.get(`${pkg.id}\0${skill.path}`) })));
      return {
        prompt: this.catalog(this.entries(packages.map((entry) => ({ ...entry, selected: entry.selected.filter((skill) => !skill.forkAgent) })), (pkg) => path.join(directory, pkg.id))), review, invoked,
        directory,
        verify: async () => {
          for (const { pkg } of packages) { const fingerprint = fingerprints.get(pkg.id); if (fingerprint && (await snapshotSkillPackage(path.join(directory, pkg.id), { allowNoSkills: true })).fingerprint !== fingerprint) throw new Error(`Skill package ${pkg.name} changed after sharing was reviewed.`); }
        },
        dispose: async () => {
          await removeOwnedTree(runs, directory);
        },
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
