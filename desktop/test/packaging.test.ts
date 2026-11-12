import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { APP_VERSION } from "../src/shared/types";

interface PackageConfiguration {
  name: string;
  version: string;
  type: string;
  main: string;
  build: {
    productName: string;
    files: string[];
    win: { target: string[]; artifactName?: string };
    nsis: { artifactName: string };
    portable: { artifactName: string };
  };
}

const desktopRoot = new URL("../", import.meta.url);
const configuration = JSON.parse(
  await readFile(new URL("package.json", desktopRoot), "utf8"),
) as PackageConfiguration;
const require = createRequire(import.meta.url);
const { expandMacro } =
  require("app-builder-lib/out/util/macroExpander.js") as {
    expandMacro: (
      pattern: string,
      arch: string,
      appInfo: Record<string, string>,
      extra: Record<string, string>,
    ) => string;
  };

test("installed Windows packager expands distinct setup and portable filenames", () => {
  assert.equal(
    configuration.version,
    APP_VERSION,
    "UI/runtime and package versions must agree",
  );
  assert.deepEqual(configuration.build.win.target, ["nsis", "portable"]);
  const appInfo = {
    name: configuration.name,
    version: configuration.version,
    productName: configuration.build.productName,
    sanitizedProductName: configuration.build.productName,
  };
  // Match PlatformPackager.computeArtifactName: there is no `target` macro.
  // Calling the installed implementation catches unsupported macros without
  // downloading Electron/NSIS or needing an already-generated dist directory.
  const names = ["nsis", "portable"].map((target) => {
    const pattern =
      configuration.build[target as "nsis" | "portable"].artifactName;
    assert.equal(
      typeof pattern,
      "string",
      `${target} needs an explicit filename`,
    );
    const filename = expandMacro(pattern, "x64", appInfo, {
      os: "win",
      ext: "exe",
    });
    assert.equal(
      path.win32.basename(filename),
      filename,
      "artifact names must not contain a directory",
    );
    assert.ok(filename.endsWith(".exe"));
    assert.ok(!filename.includes("${"), "all filename macros must be expanded");
    return filename;
  });
  assert.equal(
    new Set(names).size,
    2,
    "setup and portable builds must not overwrite one another",
  );
  assert.deepEqual(names, [
    `Nova-Workbench-${configuration.version}-x64-setup.exe`,
    `Nova-Workbench-${configuration.version}-x64-portable.exe`,
  ]);
});

test("packaged main and sandboxed preload agree with bundler output before a build", async () => {
  const [buildScript, mainSource, viteConfiguration] = await Promise.all([
    readFile(new URL("scripts/build.mjs", desktopRoot), "utf8"),
    readFile(new URL("src/main/main.ts", desktopRoot), "utf8"),
    readFile(new URL("vite.config.ts", desktopRoot), "utf8"),
  ]);
  assert.equal(configuration.type, "module");
  assert.equal(configuration.main, "dist/main/main.cjs");
  assert.ok(configuration.build.files.includes("dist/**/*"));
  assert.match(
    buildScript,
    /entryPoints:\s*\{\s*main:\s*["']src\/main\/main\.ts["'],\s*preload:\s*["']src\/main\/preload\.ts["'],?\s*\}/,
  );
  assert.match(buildScript, /outdir:\s*["']dist\/main["']/);
  assert.match(
    buildScript,
    /outExtension:\s*\{\s*["']\.js["']:\s*["']\.cjs["']\s*\}/,
  );
  assert.match(buildScript, /format:\s*["']cjs["']/);
  assert.match(buildScript, /external:\s*\[["']electron["']\]/);
  assert.match(
    mainSource,
    /preload:\s*path\.join\(__dirname,\s*["']preload\.cjs["']\)/,
  );
  assert.match(
    mainSource,
    /path\.resolve\(__dirname,\s*["']\.\.\/renderer["']\)/,
  );
  assert.match(viteConfiguration, /outDir:\s*["']dist\/renderer["']/);
});
