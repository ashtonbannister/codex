import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  APP_URL,
  assetPath,
  CONTENT_SECURITY_POLICY,
  isTrustedRendererUrl,
} from "../src/main/security";

test("only the exact top-level app URL is a trusted IPC source", () => {
  assert.equal(isTrustedRendererUrl(APP_URL, false), true);
  for (const url of [
    "https://example.com",
    "nova://evil/index.html",
    "nova://app/other.html",
    "nova://app:80/index.html",
    "nova://user@app/index.html",
    "file:///tmp/index.html",
    "not a URL",
  ]) {
    assert.equal(isTrustedRendererUrl(url, false), false);
  }
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:5173/", true), true);
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:5173/evil", true), false);
  assert.equal(isTrustedRendererUrl("http://localhost:5173/", true), false);
  assert.equal(
    isTrustedRendererUrl("http://user@127.0.0.1:5173/", true),
    false,
  );
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:5173/", false), false);
});

test("asset handler rejects encoded traversal, alternate origins and Windows separators", () => {
  const root = path.resolve("app-renderer");
  assert.equal(
    assetPath(root, "nova://app/assets/index.js"),
    path.join(root, "assets/index.js"),
  );
  assert.equal(assetPath(root, "nova://app/"), path.join(root, "index.html"));
  for (const url of [
    "nova://app/..%2f..%2fsecret",
    "nova://app/%5csecret",
    "nova://app/%00file",
    "nova://other/file",
    "nova://app:123/file",
    "nova://user@app/file",
    "https://app/file",
  ]) {
    assert.throws(() => assetPath(root, url));
  }
});

test("packaged renderer cannot load remote scripts, frames or make network calls", () => {
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-src 'none'/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-eval/);
});
