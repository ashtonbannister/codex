type RecordValue = Record<string, unknown>;

const object = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const STOPPED = " Native app-server was not started; safety checks were not bypassed.";
const MXC_REQUIRED = "windows.require_mxc = true requires MXC to be selected on this Windows host";

function location(data: RecordValue): string {
  const match = /(?:^|[\\/])(config\.toml|requirements\.toml|managed_config\.toml)$/i.exec(text(data.filePath));
  if (!match) return "";
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;
  const line = positive(data.line) ? `, line ${data.line}` : "";
  const column = line && positive(data.column) ? `, column ${data.column}` : "";
  return ` (${match[1].toLowerCase()}${line}${column})`;
}

/** Classify bounded CLI output without returning native messages, paths or config values. */
export function classifyCodexStartupFailure(
  stdout: unknown,
  stderr: string,
  exitCode: number | null,
): string {
  let value = stdout;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = undefined; }
  }
  const root = object(value);
  const error = object(root?.error);
  const data = object(error?.data) ?? {};
  const detail = text(data.detail);
  const message = text(error?.message);
  if (detail === MXC_REQUIRED || message === MXC_REQUIRED ||
      message === `failed to load configuration: ${MXC_REQUIRED}`) {
    return "Codex requires the MXC Windows sandbox, but Nova's selected startup backend did not satisfy that requirement. Use a compatible Codex installation and sandbox configuration; do not disable the managed requirement." + STOPPED;
  }
  if (data.reason === "cloudConfigBundle") {
    if (data.errorCode === "Auth" || data.action === "relogin")
      return "Codex could not authenticate while loading managed configuration. Complete sign-in through the same official Codex CLI in a terminal, then retry Nova." + STOPPED;
    const reasons: Record<string, string> = {
      Timeout: "Codex timed out while loading managed configuration. Check connectivity to the configured policy service, then retry.",
      RequestFailed: "Codex could not retrieve managed configuration. Check the configured policy service and connectivity through the same official CLI in a terminal.",
      InvalidBundle: "Codex rejected the managed configuration bundle. The policy configuration must be corrected before retrying.",
      Internal: "Codex encountered an internal managed-configuration error. Check the same official CLI in a terminal for details.",
    };
    const code = text(data.errorCode);
    return (Object.hasOwn(reasons, code) ? reasons[code] :
      "Codex could not load managed configuration. Check the same official CLI in a terminal; Nova did not bypass the policy.") + STOPPED;
  }
  if (data.reason === "configLoad") {
    const source = location(data);
    const diagnostic = `${message}\n${detail}`;
    if (/unknown configuration field/i.test(diagnostic))
      return `Codex rejected an unrecognized configuration setting${source}. Select or update to the Codex CLI compatible with your OEM installation, and inspect the setting through that CLI in a terminal.` + STOPPED;
    if (/TOML parse error|failed to parse (?:the )?(?:configuration|config|TOML)|invalid TOML/i.test(diagnostic))
      return `Codex could not parse its configuration${source}. Check and correct the reported configuration file through the same official CLI in a terminal.` + STOPPED;
    return `Codex could not load or validate its configuration${source}. Check the same official CLI in a terminal for the specific configuration or policy error.` + STOPPED;
  }
  if (root && Object.hasOwn(root, "error"))
    return "Codex rejected startup validation. Check the same official CLI in a terminal for its configuration, authentication or policy error." + STOPPED;

  const unsupported = /(?:^|\n)\s*(?:error:\s*)?(?:unexpected argument|unrecognized (?:option|arguments?)):?\s+['"]?(--print-startup-config|--startup-client-info|--strict-config)(?=['"\s:]|$)/i.exec(stderr);
  if (unsupported)
    return `The selected Codex executable does not support ${unsupported[1].toLowerCase()}. Update it or select a compatible native Codex executable in Settings → Agents; verify that exact executable in a terminal.` + STOPPED;
  const code = typeof exitCode === "number" && Number.isSafeInteger(exitCode) &&
    exitCode >= 0 && exitCode <= 0xffff_ffff ? ` (exit code ${exitCode})` : "";
  return `Codex startup discovery failed${code}. Check the same executable and Codex home in the official CLI terminal for the specific error; this alone does not establish an unsupported option.` + STOPPED;
}
