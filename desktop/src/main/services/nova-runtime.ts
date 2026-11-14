import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Only homes issued from Nova's own data directory in this process may be used
// to start an engine. An import location or inherited CODEX_HOME is not a home.
const ownedHomes = new Set<string>();
const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
const same = (left: string, right: string) => key(path.resolve(left)) === key(path.resolve(right));
const inside = (candidate: string, root: string) => {
  const relative = path.relative(key(path.resolve(root)), key(path.resolve(candidate)));
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const failure = () => new Error("Nova's private Codex runtime is unavailable or redirected. Choose a separate Nova data directory; OEM Codex folders are import-only.");

async function privateDirectory(directory: string, create: boolean): Promise<void> {
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !same(await realpath(directory), directory))
    throw failure();
  // Check only our own immediate children. Never follow a link into the import
  // source, credentials, OEM databases or history. No recursive source scans.
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) throw failure();
  for (const entry of entries) {
    if (["config.toml", "auth.json"].includes(entry.name) && (await lstat(path.join(directory, entry.name))).nlink > 1)
      throw failure();
  }
}

/** Creates a fixed Nova-owned runtime; does not inspect the import/OEM home. */
export async function ensureNovaCodexHome(dataDir: string, importSource?: string): Promise<string> {
  if (!dataDir || !path.isAbsolute(dataDir) || /[\0\r\n]/.test(dataDir)) throw failure();
  const forbidden = [path.join(os.homedir(), ".codex"), ...[importSource, process.env.CODEX_HOME, process.env.CODEX_SQLITE_HOME]
    .filter((value): value is string => !!value).map((value) => path.resolve(value))];
  if (forbidden.some((source) => inside(dataDir, source))) throw failure();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const root = await realpath(dataDir);
  const home = path.join(root, "codex-runtime");
  if (forbidden.some((source) => inside(root, source) || inside(home, source) || inside(source, home))) throw failure();
  await privateDirectory(home, true);
  for (const directory of ["state", "log", "sessions", "archived_sessions", "tmp"])
    await privateDirectory(path.join(home, directory), true);
  ownedHomes.add(key(home));
  return home;
}

function issuedHome(home: string): string {
  if (!home || !path.isAbsolute(home) || !ownedHomes.has(key(path.resolve(home)))) throw failure();
  return path.resolve(home);
}

/** Re-check owned directories immediately before starting a child process. */
export async function assertNovaCodexHome(home: string): Promise<string> {
  home = issuedHome(home);
  await privateDirectory(home, false);
  for (const directory of ["state", "log", "sessions", "archived_sessions", "tmp"])
    await privateDirectory(path.join(home, directory), false);
  return home;
}

/** Neither inherited nor caller-provided environment can redirect an engine. */
export function isolatedCodexEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  home = issuedHome(home);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries({ ...process.env, ...extra })) {
    const upper = name.toUpperCase();
    // Keep OS/enterprise trust and proxy settings. Drop Codex host identity,
    // auth, configuration/debug redirection and inherited session context.
    if ((upper.startsWith("CODEX_") && upper !== "CODEX_CA_CERTIFICATE") ||
      upper === "SQLITE_HOME" || /^OPENAI_(?:API_KEY|ACCESS_TOKEN|BASE_URL|ORG_ID|ORGANIZATION|PROJECT_ID)$/.test(upper)) continue;
    environment[name] = value;
  }
  return {
    ...environment,
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: path.join(home, "state"),
    CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
    NO_COLOR: "1",
  };
}

/** Ordinary config overrides; managed requirements must still be respected. */
export function novaCodexConfigArgs(home: string): string[] {
  home = issuedHome(home);
  return Object.entries({
    sqlite_home: path.join(home, "state"),
    log_dir: path.join(home, "log"),
    cli_auth_credentials_store: "file",
  }).flatMap(([name, value]) => ["--config", `${name}=${JSON.stringify(value)}`]);
}

function matchesDirectory(value: unknown, expected: string): boolean {
  if (typeof value !== "string" || /[\0\r\n]/.test(value)) return false;
  try {
    const directory = value.startsWith("file:") ? fileURLToPath(value) : value;
    return path.isAbsolute(directory) && same(directory, expected);
  } catch { return false; }
}

/** Managed policy is not overridden: an incompatible storage mandate stops startup. */
export function assertNovaCodexRequirements(home: string, requirements: Record<string, unknown>): void {
  home = issuedHome(home);
  for (const [name, expected] of [["sqliteHome", path.join(home, "state")], ["logDir", path.join(home, "log")]] as const) {
    const value = requirements[name];
    if (value !== undefined && value !== null && !matchesDirectory(value, expected))
      throw new Error("Managed Codex policy requires storage outside Nova's private runtime. Nova will not start that engine or override the managed policy.");
  }
  if (requirements.cliAuthCredentialsStore !== undefined && requirements.cliAuthCredentialsStore !== null && requirements.cliAuthCredentialsStore !== "file")
    throw new Error("Managed Codex policy requires a credential store incompatible with Nova's separate sign-in. Nova will not reuse OEM credentials or override the managed policy.");
}

/** Confirm the effective account transport config before doing account operations. */
export function assertNovaCodexConfig(home: string, config: Record<string, unknown>): void {
  home = issuedHome(home);
  if (!matchesDirectory(config.sqlite_home, path.join(home, "state")) ||
    !matchesDirectory(config.log_dir, path.join(home, "log")) || config.cli_auth_credentials_store !== "file")
    throw new Error("Codex did not confirm Nova's private storage and credential configuration. Account access was refused; OEM Codex remains separate.");
}
