import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { removeOwnedTree } from "./owned-tree";
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
  const header = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] ?? "";
  const read = (key: string) => {
    const value = new RegExp(`^${key}:\\s*([^\\r\\n]*)`, "m").exec(header)?.[1]?.trim() ?? "";
    return value.replace(/^(["'])((?:.|\n)*)\1$/, "$2").slice(0, 800);
  };
  return { path: relative, name: read("name") || path.posix.basename(path.posix.dirname(relative)) || "skill", description: read("description") };
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
    skills.push(metadata(content, file.path));
  }
  if (!skills.length && !options.allowNoSkills) throw new Error("No SKILL.md file was found in this folder. Select a skill folder or a package containing skills.");
  const fingerprint = createHash("sha256").update(JSON.stringify(files.map(({ path: file, digest, data }) => [file, data.length, digest]))).digest("hex");
  return { files, skills, bytes, fingerprint };
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
    const source = await realpath(selected);
    if (inside(source, this.root) || inside(this.root, source)) throw new Error("Choose a source separate from Nova's skill storage.");
    const snapshot = await snapshotSkillPackage(selected);
    return { name: path.basename(source), files: snapshot.files.length, bytes: snapshot.bytes, fingerprint: snapshot.fingerprint, skills: snapshot.skills };
  }
  async install(selected: string, fingerprint: string): Promise<SkillPackage> {
    const preview = await this.preview(selected);
    if (preview.fingerprint !== fingerprint) throw new Error("The selected package changed. Review it again before importing.");
    const snapshot = await snapshotSkillPackage(selected);
    if (snapshot.fingerprint !== fingerprint) throw new Error("The selected package changed. Review it again before importing.");
    const id = randomUUID();
    const directory = path.join(this.root, id);
    const pkg: SkillPackage = { id, name: preview.name, enabled: true, files: snapshot.files.length, bytes: snapshot.bytes, fingerprint, skills: snapshot.skills };
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
    return Promise.all(names.map((name) => this.readPackage(name, false)));
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
    return Promise.all((await this.list()).filter((pkg) => pkg.enabled).map((pkg) => this.readPackage(pkg.id)));
  }
  private catalog(packages: SkillPackage[], location: (pkg: SkillPackage) => string): string {
    const skills = packages.flatMap((pkg) => pkg.skills.map((skill) => ({
      name: skill.name, description: skill.description,
      path: path.join(location(pkg), ...skill.path.split("/")),
    })));
    if (!skills.length) return "";
    if (skills.length > MAX_SKILLS) throw new Error("Too many enabled skills. Disable a package before starting a run.");
    return `\n\nAvailable user-imported skills (review the applicable SKILL.md before using it; resolve its relative references from that file). These are user-selected instructions, subject to the task and higher-priority boundaries. Imported files may be read by the selected provider:\n${JSON.stringify(skills, null, 2)}`;
  }
  async prompt(): Promise<string> {
    return this.catalog(await this.enabled(), (pkg) => path.join(this.root, pkg.id, "files"));
  }
  /** Each run gets disposable copies, so Claude's --add-dir cannot modify installed packages. */
  async prepareRun(): Promise<{ prompt: string; directory?: string; dispose(): Promise<void> }> {
    const packages = await this.enabled();
    if (!packages.length) return { prompt: "", dispose: async () => {} };
    const runs = path.join(this.dataDir, "skill-run-copies");
    await mkdir(runs, { recursive: true, mode: 0o700 });
    const info = await lstat(runs);
    if (!info.isDirectory() || info.isSymbolicLink() || normalize(await realpath(runs)) !== normalize(runs)) throw new Error("Skill run-copy storage is unavailable or redirected.");
    const directory = path.join(runs, randomUUID());
    await mkdir(directory, { mode: 0o700 });
    try {
      for (const pkg of packages) {
        const snapshot = await snapshotSkillPackage(path.join(this.root, pkg.id, "files"));
        if (snapshot.fingerprint !== pkg.fingerprint) throw new Error(`Imported skill package ${pkg.name} changed before launch.`);
        for (const entry of snapshot.files) {
          const target = path.join(directory, pkg.id, ...entry.path.split("/"));
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, entry.data, { flag: "wx", mode: 0o700 });
        }
      }
      return {
        prompt: this.catalog(packages, (pkg) => path.join(directory, pkg.id)),
        directory,
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
