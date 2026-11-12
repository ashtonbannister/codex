import { build as buildRenderer } from "vite";
import { build as bundle } from "esbuild";
import { copyFile } from "node:fs/promises";

export async function buildMain() {
  await bundle({
    entryPoints: { main: "src/main/main.ts", preload: "src/main/preload.ts" },
    outdir: "dist/main",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: false,
  });
}

if (process.argv[1]?.endsWith("build.mjs")) {
  await Promise.all([buildMain(), buildRenderer()]);
  await copyFile("../LICENSE", "LICENSE");
  await copyFile("../NOTICE", "NOTICE");
}
