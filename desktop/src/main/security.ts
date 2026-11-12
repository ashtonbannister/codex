import path from "node:path";

export const APP_URL = "nova://app/index.html";
export const DEV_ORIGIN = "http://127.0.0.1:5173";

export function isTrustedRendererUrl(
  url: string,
  development: boolean,
): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    return development
      ? parsed.origin === DEV_ORIGIN && parsed.pathname === "/"
      : parsed.protocol === "nova:" &&
          parsed.hostname === "app" &&
          !parsed.port &&
          parsed.pathname === "/index.html";
  } catch {
    return false;
  }
}

export function assetPath(root: string, url: string): string {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "nova:" ||
    parsed.hostname !== "app" ||
    parsed.port ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Invalid app origin.");
  const resource = decodeURIComponent(
    parsed.pathname === "/" ? "/index.html" : parsed.pathname,
  );
  if (resource.includes("\0") || resource.includes("\\"))
    throw new Error("Invalid asset path.");
  const filename = path.resolve(root, `.${resource}`);
  const relative = path.relative(root, filename);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Asset is outside the application.");
  return filename;
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join("; ");
