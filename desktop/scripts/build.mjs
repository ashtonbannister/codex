import { build as buildRenderer } from "vite";
import { build as bundle } from "esbuild";
import { copyFile } from "node:fs/promises";

export async function buildMain() {
  await bundle({
    entryPoints: {
      main: "src/main/main.ts",
      preload: "src/main/preload.ts",
      "memory-worker": "src/main/services/memory-fabric/worker.ts",
    },
    outdir: "dist/main",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    // Production workers resolve beside main.cjs, not through the source TS loader.
    define: { "import.meta.url": "undefined" },
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
