import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assessCodexMemoryFreshness,
  inspectCodexInstallation,
  listCodexResources,
  previewCodexResource,
  resolveCodexHome,
} from "../src/main/services/codex-installation";
import type { CodexResourceRequest } from "../src/shared/compatibility";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-installation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "codex home");
  await mkdir(home);
  return { root, home: await realpath(home) };
}

test("Codex inventory resolves redirected Documents and excludes credentials without reading their contents", async (t) => {
  const { root, home } = await fixture(t);
  const documents = path.join(root, "other drive", "Documents");
  await mkdir(path.join(documents, "Codex"), { recursive: true });
  await writeFile(path.join(home, "auth.json"), "AUTH_MUST_NOT_BECOME_CONTEXT");
  await writeFile(path.join(home, "config.toml"), "SECRET_CONFIG_VALUE");
  const result = await inspectCodexInstallation(home, {
    documents,
    userProfile: root,
    appData: root,
    localAppData: root,
  });
  assert.equal(result.exists, true);
  assert.equal(result.home, home);
  assert.equal(
    result.locations.find((entry) => entry.id === "outputs")?.resolvedPath,
    await realpath(path.join(documents, "Codex")),
  );
  assert.equal(
    result.locations.find((entry) => entry.id === "auth.json")?.access,
    "excluded",
  );
  assert.equal(
    result.locations.find((entry) => entry.id === "config.toml")?.access,
    "engine-managed",
  );
  assert.doesNotMatch(JSON.stringify(result), /AUTH_MUST|SECRET_CONFIG/);
  assert.equal(
    await readFile(path.join(home, "auth.json"), "utf8"),
    "AUTH_MUST_NOT_BECOME_CONTEXT",
  );
});

test("missing Codex home is reported without creating it, and relative home paths are refused", async (t) => {
  const { root } = await fixture(t);
  const missing = path.join(root, "missing");
  const report = await inspectCodexInstallation(missing, {
    userProfile: root,
    appData: root,
    localAppData: root,
  });
  assert.equal(report.exists, false);
  await assert.rejects(resolveCodexHome(missing), /missing or unavailable/);
  await assert.rejects(resolveCodexHome("relative/path"), /absolute/);
  await assert.rejects(realpath(missing), { code: "ENOENT" });
});

test("only allowlisted memory, skill and instruction references appear in their sections", async (t) => {
  const { home } = await fixture(t);
  await mkdir(path.join(home, "memories", "rollout_summaries"), {
    recursive: true,
  });
  await mkdir(path.join(home, "skills", "example"), { recursive: true });
  await writeFile(
    path.join(home, "AGENTS.md"),
    "Prefer small verified changes.",
  );
  await writeFile(path.join(home, "auth.json"), "private");
  await writeFile(
    path.join(home, "memories", "memory_summary.md"),
    "A reviewed preference.",
  );
  await writeFile(
    path.join(home, "memories", "rollout_summaries", "one.md"),
    "Visible summary.",
  );
  await writeFile(
    path.join(home, "memories", "unknown.md"),
    "Not a recognized memory artifact.",
  );
  await writeFile(
    path.join(home, "skills", "example", "SKILL.md"),
    "Skill reference; not executed.",
  );
  await writeFile(
    path.join(home, "skills", "example", "run.js"),
    "process.exit(2)",
  );
  assert.deepEqual(
    (await listCodexResources(home, { section: "instructions" })).resources.map(
      (r) => r.path,
    ),
    ["AGENTS.md"],
  );
  assert.deepEqual(
    (await listCodexResources(home, { section: "memories" })).resources.map(
      (r) => r.path,
    ),
    ["memory_summary.md", "rollout_summaries/one.md"],
  );
  assert.deepEqual(
    (await listCodexResources(home, { section: "skills" })).resources.map(
      (r) => r.path,
    ),
    ["example/SKILL.md"],
  );
  assert.equal(
    (await listCodexResources(home, { section: "memories_v2" })).resources
      .length,
    0,
  );
});

test("resource preview rejects traversal, arbitrary state, Windows ADS and executable content", async (t) => {
  const { home } = await fixture(t);
  for (const file of [
    "../auth.json",
    "/auth.json",
    "a/../../auth.json",
    "AGENTS.md:stream",
    "a\\AGENTS.md",
    "auth.json",
    ".sandbox-secrets",
    "config.toml",
    "AGENTS.md\0",
  ]) {
    await assert.rejects(
      previewCodexResource(home, { section: "instructions", path: file }),
    );
  }
  await assert.rejects(
    previewCodexResource(home, {
      section: "browser",
      path: "notes.md",
    } as unknown as CodexResourceRequest),
    /supported reference section/,
  );
});

test("imported reference fingerprints detect changed, missing, oversized and binary sources", async (t) => {
  const { home } = await fixture(t);
  const file = path.join(home, "AGENTS.md");
  await writeFile(file, "One reviewed instruction.\n");
  const preview = await previewCodexResource(home, {
    section: "instructions",
    path: "AGENTS.md",
  });
  assert.equal(preview.content, "One reviewed instruction.\n");
  const source = {
    home,
    section: preview.section,
    path: preview.path,
    sha256: preview.sha256,
  };
  assert.equal((await assessCodexMemoryFreshness(source)).freshness, "current");
  await writeFile(file, "A changed instruction.");
  assert.equal((await assessCodexMemoryFreshness(source)).freshness, "changed");
  await writeFile(file, Buffer.alloc(128 * 1024 + 1, 65));
  await assert.rejects(previewCodexResource(home, source), /128 KiB/);
  await writeFile(file, Buffer.from([255, 254, 0, 1]));
  await assert.rejects(previewCodexResource(home, source), /UTF-8/);
  await writeFile(file, "text\0not text");
  await assert.rejects(previewCodexResource(home, source), /Binary/);
  await rm(file);
  assert.equal((await assessCodexMemoryFreshness(source)).freshness, "missing");
});

test("top-level redirected sections work, while nested links cannot expose another directory", async (t) => {
  const { root, home } = await fixture(t);
  const redirected = path.join(root, "redirected memories");
  const outside = path.join(root, "outside");
  await mkdir(redirected);
  await mkdir(outside);
  await writeFile(
    path.join(redirected, "memory_summary.md"),
    "On another drive.",
  );
  await writeFile(path.join(outside, "private.md"), "Must remain outside.");
  try {
    await symlink(
      redirected,
      path.join(home, "memories"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await symlink(
      outside,
      path.join(redirected, "rollout_summaries"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (
      ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")
    ) {
      t.skip("Directory link creation unavailable on this runner.");
      return;
    }
    throw error;
  }
  assert.equal(
    (
      await previewCodexResource(home, {
        section: "memories",
        path: "memory_summary.md",
      })
    ).content,
    "On another drive.",
  );
  assert.deepEqual(
    (await listCodexResources(home, { section: "memories" })).resources.map(
      (r) => r.path,
    ),
    ["memory_summary.md"],
  );
  await assert.rejects(
    previewCodexResource(home, {
      section: "memories",
      path: "rollout_summaries/private.md",
    }),
    /Linked reference/,
  );
});
