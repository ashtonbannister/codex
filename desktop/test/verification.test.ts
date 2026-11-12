import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { VerificationProfile } from "../src/shared/types";
import { captureRevisionSnapshot } from "../src/main/services/revision";
import {
  CleanupFailure,
  classifyWindowsInventoryFailure,
  parseWindowsProcessTable,
  readWindowsInventory,
  runProvider,
  selectWindowsDescendants,
  windowsInventoryTimeout,
} from "../src/main/services/providers";
import {
  resolveVerificationExecutable,
  runVerificationCommand,
  verificationExecutableCandidates,
} from "../src/main/services/verification";

type TestContext = {
  after: (fn: () => Promise<void> | void) => void;
  skip: (message: string) => void;
};

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "nova-verification-"));
  const root = await realpath(temporary);
  const repo = path.join(root, "repository with spaces");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "Nova verification test");
  git("config", "user.email", "nova-test@example.invalid");
  await writeFile(path.join(repo, "README.md"), "Source baseline\n");
  await writeFile(path.join(repo, ".gitignore"), "generated/\n");
  git("add", "README.md", ".gitignore");
  git("commit", "-m", "fixture");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, repo, git };
}

function profile(
  executable: string,
  args: string[] = [],
  timeoutMinutes = 1,
): VerificationProfile {
  return {
    id: "test-check",
    projectId: "project",
    name: "Test check",
    executable,
    args,
    timeoutMinutes,
    createdAt: "now",
    updatedAt: "now",
  };
}

async function run(executable: string, cwd: string, args: string[] = []) {
  return runVerificationCommand({
    profile: profile(executable, args),
    cwd,
    signal: new AbortController().signal,
    maxBytes: 65_536,
    onOutput: () => undefined,
  });
}

async function stopFixture(stopFile: string | undefined): Promise<void> {
  if (!stopFile) return;
  // Only this fixture observes this private token. Never signal a saved PID:
  // Windows may already have recycled it for another test's Git/CLI process.
  try {
    await writeFile(stopFile, "stop");
    await new Promise((resolve) => setTimeout(resolve, 100));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

test("verification executable candidates never use cwd or Windows drive-relative PATH entries", () => {
  assert.deepEqual(
    verificationExecutableCandidates(
      "node",
      "win32",
      ';.;C:relative;\\relative;"C:\\Program Files\\nodejs";\\\\server\\share\\bin',
    ),
    [
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Program Files\\nodejs\\node.cmd",
      "C:\\Program Files\\nodejs\\node",
      "\\\\server\\share\\bin\\node.exe",
      "\\\\server\\share\\bin\\node.cmd",
      "\\\\server\\share\\bin\\node",
    ],
  );
  assert.deepEqual(
    verificationExecutableCandidates("node", "linux", ":.:relative:/usr/bin"),
    ["/usr/bin/node"],
  );
  assert.throws(
    () => verificationExecutableCandidates("C:relative\\tool.exe", "win32"),
    /absolute/,
  );
  assert.throws(
    () => verificationExecutableCandidates("node\nother"),
    /Invalid/,
  );
});

test("source fingerprints are stable and cover binary content and assume-unchanged files", async (t) => {
  const { repo, git } = await fixture(t);
  const baseline = await captureRevisionSnapshot(repo);
  assert.equal(baseline.complete, true);
  assert.match(baseline.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(await captureRevisionSnapshot(repo), baseline);
  git("update-index", "--assume-unchanged", "README.md");
  await writeFile(path.join(repo, "README.md"), "Changed source\n");
  assert.equal(git("status", "--porcelain"), "");
  const hiddenChange = await captureRevisionSnapshot(repo);
  assert.equal(hiddenChange.complete, true);
  assert.notEqual(hiddenChange.fingerprint, baseline.fingerprint);
  await writeFile(path.join(repo, "asset.bin"), Buffer.from([0, 1, 2, 255]));
  const firstBinary = await captureRevisionSnapshot(repo);
  await writeFile(path.join(repo, "asset.bin"), Buffer.from([0, 1, 3, 255]));
  const secondBinary = await captureRevisionSnapshot(repo);
  assert.notEqual(firstBinary.fingerprint, secondBinary.fingerprint);
});

test("fingerprint source scope excludes ignored generated files but includes untracked files and deletions", async (t) => {
  const { repo } = await fixture(t);
  const initial = await captureRevisionSnapshot(repo);
  await mkdir(path.join(repo, "generated"));
  await writeFile(path.join(repo, "generated", "result.txt"), "ignored output");
  assert.equal(
    (await captureRevisionSnapshot(repo)).fingerprint,
    initial.fingerprint,
  );
  await writeFile(path.join(repo, "new.ts"), "export const n = 1;\n");
  const untracked = await captureRevisionSnapshot(repo);
  assert.notEqual(untracked.fingerprint, initial.fingerprint);
  await rm(path.join(repo, "README.md"));
  const deleted = await captureRevisionSnapshot(repo);
  assert.equal(deleted.complete, true);
  assert.notEqual(deleted.fingerprint, untracked.fingerprint);
});

test("fingerprint budgets fail closed rather than describing a partial snapshot as complete", async (t) => {
  const { repo } = await fixture(t);
  const limits = {
    maxFiles: 10,
    maxFileBytes: 1024,
    maxTotalBytes: 4096,
    maxDurationMs: 10_000,
  };
  assert.equal((await captureRevisionSnapshot(repo, limits)).complete, true);
  const fileLimit = await captureRevisionSnapshot(repo, {
    ...limits,
    maxFiles: 1,
  });
  assert.equal(fileLimit.complete, false);
  assert.match(fileLimit.reason!, /file-count/);
  const byteLimit = await captureRevisionSnapshot(repo, {
    ...limits,
    maxTotalBytes: 1,
  });
  assert.equal(byteLimit.complete, false);
  assert.match(byteLimit.reason!, /byte budget/);
  assert.equal(
    (await captureRevisionSnapshot(repo, { ...limits, maxFileBytes: 1 }))
      .complete,
    false,
  );
  for (const maxDurationMs of [0.001, 1]) {
    const duration = await captureRevisionSnapshot(repo, {
      ...limits,
      maxDurationMs,
    });
    assert.equal(duration.complete, false);
    assert.match(duration.reason!, /time budget/);
  }
});

test("Windows process identity checks reject reused leader/descendant PIDs and old historical parents", () => {
  const leader = { pid: 100, startedAt: 1000, exitedAt: 2000, hasExited: true };
  assert.throws(
    () =>
      selectWindowsDescendants(
        [{ pid: 100, parent: 1, started: 2100 }],
        leader,
        new Map([[100, 1000]]),
      ),
    /uniquely identified/,
  );
  assert.deepEqual(
    selectWindowsDescendants(
      [
        { pid: 101, parent: 100, started: 999 },
        { pid: 102, parent: 100, started: 2001 },
      ],
      leader,
      new Map([[100, 1000]]),
    ),
    [],
  );
  assert.deepEqual(
    selectWindowsDescendants(
      [
        { pid: 101, parent: 100, started: 1200 },
        { pid: 102, parent: 101, started: 1300 },
      ],
      leader,
      new Map([[100, 1000]]),
    ).map((row) => row.pid),
    [101, 102],
  );
  assert.throws(
    () =>
      selectWindowsDescendants(
        [{ pid: 101, parent: 100, started: 1400 }],
        leader,
        new Map([
          [100, 1000],
          [101, 1200],
        ]),
      ),
    /reused/,
  );
  assert.throws(
    () =>
      selectWindowsDescendants(
        [{ pid: 101, parent: 100, started: Number.NaN }],
        leader,
        new Map([[100, 1000]]),
      ),
    /Unknown descendant/,
  );
  assert.throws(
    () =>
      selectWindowsDescendants(
        [{ pid: 102, parent: 101, started: 9000 }],
        leader,
        new Map([
          [100, 1000],
          [101, 1200],
        ]),
      ),
    /historical descendant parent/,
  );
});

test("Windows cleanup diagnostics distinguish bounded failure causes without exposing command or output data", () => {
  const privateFields = {
    cmd: "sensitive-command",
    stdout: "private-output",
    stderr: "credential-value",
  };
  assert.equal(
    classifyWindowsInventoryFailure({ ...privateFields, killed: true }),
    "windows-inventory-timeout",
  );
  assert.equal(
    classifyWindowsInventoryFailure({
      ...privateFields,
      killed: true,
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    }),
    "windows-inventory-output-limit",
  );
  assert.equal(
    classifyWindowsInventoryFailure({ ...privateFields, code: "ENOENT" }),
    "windows-inventory-unavailable",
  );
  assert.equal(
    classifyWindowsInventoryFailure({ ...privateFields, code: "EPERM" }),
    "windows-inventory-unavailable",
  );
  assert.equal(
    classifyWindowsInventoryFailure({ ...privateFields, code: 1 }),
    "windows-inventory-exit-failure",
  );
  assert.equal(
    classifyWindowsInventoryFailure(null),
    "windows-inventory-exit-failure",
  );
  for (const output of [
    "private-output",
    "[]",
    '{"pid":"not a PID","parent":1,"started":"private-output"}',
    "null",
  ]) {
    assert.throws(
      () => parseWindowsProcessTable(output),
      (error: unknown) => {
        assert.equal((error as Error).message, "windows-inventory-invalid");
        return true;
      },
    );
  }
  const valid = parseWindowsProcessTable(
    '\uFEFF[{"pid":42,"parent":7,"started":"2026-11-12T06:00:00.0000000Z"}]',
  );
  assert.deepEqual(valid, [
    { pid: 42, parent: 7, started: Date.parse("2026-11-12T06:00:00Z") },
  ]);
  assert.throws(
    () =>
      selectWindowsDescendants(
        [{ pid: 42, parent: 7, started: 1000 }],
        { pid: 42, startedAt: 900, exitedAt: 1200, hasExited: true },
        new Map([[42, 900]]),
      ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "windows-exited-leader-pid-observed",
      );
      return true;
    },
  );
  assert.throws(
    () =>
      selectWindowsDescendants(
        [{ pid: 42, parent: 7, started: 1300 }],
        { pid: 42, startedAt: 900, exitedAt: 1200, hasExited: true },
        new Map([[42, 900]]),
      ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "windows-leader-pid-reused-after-exit",
      );
      return true;
    },
  );
});

test("cold Windows inventory gets up to five seconds without extending the total cleanup deadline", () => {
  const deadline = 8_000;
  assert.equal(windowsInventoryTimeout(deadline, 0), 5_000);
  assert.equal(windowsInventoryTimeout(deadline, 2_000), 5_000);
  assert.equal(windowsInventoryTimeout(deadline, 4_500), 3_500);
  assert.equal(windowsInventoryTimeout(deadline, 7_999), 1);
  assert.equal(windowsInventoryTimeout(deadline, 8_000), 0);
  assert.equal(windowsInventoryTimeout(deadline, 9_000), 0);
});

test("a timed-out Windows inventory retries once inside the original deadline", async () => {
  let now = 0;
  const budgets: number[] = [];
  const rows = [{ pid: 42, parent: 7, started: 1000 }];
  const result = await readWindowsInventory(
    8000,
    async (timeout) => {
      budgets.push(timeout);
      if (budgets.length === 1) {
        now += timeout;
        throw new CleanupFailure("windows-inventory-timeout");
      }
      now += 700;
      return rows;
    },
    () => now,
  );
  assert.deepEqual(result, rows);
  assert.deepEqual(budgets, [5000, 3000]);
  assert.equal(now, 5700);

  now = 0;
  budgets.length = 0;
  await assert.rejects(
    readWindowsInventory(
      8000,
      async (timeout) => {
        budgets.push(timeout);
        now += timeout;
        throw new CleanupFailure("windows-inventory-timeout");
      },
      () => now,
    ),
    /windows-inventory-timeout/,
  );
  assert.deepEqual(budgets, [5000, 3000]);
  assert.equal(now, 8000);
});

test("Windows inventory retry never extends an expired deadline or retries non-timeout failures", async () => {
  for (const code of [
    "windows-inventory-unavailable",
    "windows-inventory-invalid",
    "windows-inventory-output-limit",
    "windows-identity-ambiguous",
  ] as const) {
    let calls = 0;
    await assert.rejects(
      readWindowsInventory(
        8000,
        async () => {
          calls += 1;
          throw new CleanupFailure(code);
        },
        () => 0,
      ),
      new RegExp(code),
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(
    readWindowsInventory(
      8000,
      async () => {
        calls += 1;
        return [];
      },
      () => 8000,
    ),
    /windows-cleanup-deadline/,
  );
  assert.equal(calls, 0);

  let now = 0;
  await assert.rejects(
    readWindowsInventory(
      8000,
      async () => {
        calls += 1;
        now = 8000;
        throw new CleanupFailure("windows-inventory-timeout");
      },
      () => now,
    ),
    /windows-cleanup-deadline/,
  );
  assert.equal(calls, 1);

  now = 0;
  await assert.rejects(
    readWindowsInventory(
      8000,
      async () => {
        now = 8000;
        return [{ pid: 42, parent: 7, started: 1000 }];
      },
      () => now,
    ),
    /windows-cleanup-deadline/,
  );
});

for (const runner of ["verification", "provider"] as const) {
  for (const cancel of [true, false]) {
    test(`${runner} ${cancel ? "cancellation" : "successful leader exit"} waits for ignored-stdio descendants to stop`, async (t) => {
      let descendant: number | undefined;
      let stopFile: string | undefined;
      t.after(() => stopFixture(stopFile));
      const { root, repo } = await fixture(t);
      const entry = path.join(root, "ignored-stdio-leader.cjs");
      const marker = path.join(root, "background-writes.txt");
      stopFile = path.join(root, "stop-descendant");
      await writeFile(marker, "");
      const background = `const fs=require('node:fs');process.on('SIGTERM',()=>{});let writes=0;setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopFile)})||!fs.existsSync(${JSON.stringify(root)}))process.exit(0);fs.appendFileSync(${JSON.stringify(marker)},'write\\n');if(++writes===3)process.send(process.pid);},20);setTimeout(()=>process.exit(0),30000).unref();`;
      await writeFile(
        entry,
        `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(background)}],{stdio:['ignore','ignore','ignore','ipc']});c.once('message',pid=>{c.disconnect();process.stdout.write('READY:'+pid+'\\n'+JSON.stringify({type:'turn.completed'})+'\\n',()=>{${cancel ? "" : "process.exit(0);"}});});setInterval(()=>{},1000);`,
      );
      const controller = new AbortController();
      let log = "";
      let readyAt = 0;
      const observe = (text: string) => {
        log += text;
        const match = /READY:(\d+)/.exec(log);
        if (match && !descendant) {
          descendant = Number(match[1]);
          readyAt = Date.now();
          if (cancel) controller.abort();
        }
      };
      const result =
        runner === "verification"
          ? await runVerificationCommand({
              profile: profile(entry),
              cwd: repo,
              signal: controller.signal,
              maxBytes: 4096,
              onOutput: observe,
            })
          : await runProvider({
              command: { command: process.execPath, prefix: [entry], args: [] },
              provider: "codex",
              cwd: repo,
              prompt: "",
              timeoutMs: 30_000,
              maxBytes: 4096,
              signal: controller.signal,
              onEvent: (event) =>
                event.events.forEach((item) => observe(item.text)),
            });
      assert.ok(
        descendant,
        "The descendant must write and report ready before the leader exits/cancels.",
      );
      assert.equal(result.terminationUnconfirmed, undefined);
      assert.equal(result.error, undefined);
      assert.equal(result.cancelled, cancel);
      assert.ok(
        Date.now() - readyAt < 12_000,
        "Cleanup must finish before the fixture's independent self-expiry.",
      );
      if ("completed" in result) assert.equal(result.completed, !cancel);
      if (process.platform === "linux") {
        try {
          const status = await readFile(`/proc/${descendant}/stat`, "utf8");
          const state = status.slice(status.lastIndexOf(")") + 2).split(" ")[0];
          assert.match(
            state,
            /^[ZX]$/,
            "Only an OS-reaper zombie may remain after cleanup.",
          );
        } catch (error) {
          if (
            !["ENOENT", "ESRCH"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw error;
        }
      }
      // The private marker identifies this writer even after Windows recycles
      // its PID. A raw PID existence check could observe an unrelated process.
      const before = await readFile(marker, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        await readFile(marker, "utf8"),
        before,
        "No background write may occur after the runner resolves.",
      );
    });
  }
}

test("fingerprints hash symlink metadata without reading external targets", async (t) => {
  const { repo, root } = await fixture(t);
  const outside = path.join(root, "outside.txt");
  await writeFile(outside, "not source");
  try {
    await symlink(outside, path.join(repo, "link.txt"), "file");
  } catch (error) {
    if (
      process.platform === "win32" &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    ) {
      t.skip("Creating symlinks requires Windows developer mode or privilege.");
      return;
    }
    throw error;
  }
  const first = await captureRevisionSnapshot(repo);
  assert.equal(first.complete, true);
  await writeFile(outside, "private target changed");
  assert.equal(
    (await captureRevisionSnapshot(repo)).fingerprint,
    first.fingerprint,
  );
  await rm(path.join(repo, "link.txt"));
  await symlink(`${outside}.missing`, path.join(repo, "link.txt"), "file");
  assert.notEqual(
    (await captureRevisionSnapshot(repo)).fingerprint,
    first.fingerprint,
  );
});

test("source paths through an outside directory symlink are rejected", async (t) => {
  const { repo, root, git } = await fixture(t);
  const directory = path.join(repo, "nested");
  await mkdir(directory);
  await writeFile(path.join(directory, "source.ts"), "source\n");
  git("add", "nested/source.ts");
  git("commit", "-m", "nested source");
  const outside = path.join(root, "external");
  await mkdir(outside);
  await writeFile(path.join(outside, "source.ts"), "must not be read\n");
  await rename(directory, path.join(repo, "nested-original"));
  try {
    await symlink(
      outside,
      directory,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (
      process.platform === "win32" &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    ) {
      t.skip("Directory links need Windows privilege.");
      return;
    }
    throw error;
  }
  const result = await captureRevisionSnapshot(repo);
  assert.equal(result.complete, false);
  assert.match(result.reason!, /outside/);
});

test("snapshot reads never execute configured checkout or clean filters", async (t) => {
  const { repo, root, git } = await fixture(t);
  const marker = path.join(root, "filter-ran");
  const script = path.join(root, "filter.cjs");
  await writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad');`,
  );
  git(
    "config",
    "filter.nova.clean",
    `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
  );
  await writeFile(path.join(repo, ".gitattributes"), "*.md filter=nova\n");
  assert.equal((await captureRevisionSnapshot(repo)).complete, true);
  await assert.rejects(readFile(marker), /ENOENT/);
});

test("verification preserves argument boundaries without executing shell-like text", async (t) => {
  const { repo, root } = await fixture(t);
  const entry = path.join(root, "literal args.cjs");
  await writeFile(
    entry,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
  );
  const args = [
    "hello world",
    "& touch nope",
    "$(touch nope)",
    "",
    "  spaced  ",
  ];
  const result = await run(entry, repo, args);
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, undefined);
  assert.deepEqual(JSON.parse(result.output), args);
  await assert.rejects(readFile(path.join(repo, "nope")), /ENOENT/);
});

test("Windows npm shim resolves a known JavaScript entry without executing the batch contents", async (t) => {
  const { root, repo } = await fixture(t);
  const directory = path.join(root, "node installation");
  await mkdir(path.join(directory, "node_modules", "npm", "bin"), {
    recursive: true,
  });
  const shim = path.join(directory, "npm.cmd");
  await writeFile(shim, "@echo This must never execute\nexit /b 99\n");
  await writeFile(
    path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    "console.log(JSON.stringify(process.argv.slice(2)));",
  );
  const resolved = await resolveVerificationExecutable(shim);
  assert.equal(resolved.command, process.execPath);
  assert.equal(resolved.env?.ELECTRON_RUN_AS_NODE, "1");
  const result = await run(shim, repo, ["run", "typecheck"]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.output), ["run", "typecheck"]);
});

test("raw verification logs preserve split UTF-8 and stderr, and failed exits are explicit", async (t) => {
  const { root, repo } = await fixture(t);
  const entry = path.join(root, "output.cjs");
  await writeFile(
    entry,
    "const b=Buffer.from('résumé');process.stdout.write(b.subarray(0,2));setTimeout(()=>{process.stdout.write(b.subarray(2));process.stderr.write(' warning');process.exitCode=7},20);",
  );
  const chunks: string[] = [];
  const result = await runVerificationCommand({
    profile: profile(entry),
    cwd: repo,
    maxBytes: 65_536,
    signal: new AbortController().signal,
    onOutput: (text) => chunks.push(text),
  });
  assert.equal(result.exitCode, 7);
  assert.match(result.output, /résumé/);
  assert.match(result.output, /warning/);
  assert.equal(result.output, chunks.join(""));
  assert.ok(!result.output.includes("�"));
  assert.match(result.error!, /code 7/);
});

test("verification output caps stop the process and never claim success", async (t) => {
  const { root, repo } = await fixture(t);
  const entry = path.join(root, "overflow.cjs");
  await writeFile(
    entry,
    "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000);",
  );
  const result = await runVerificationCommand({
    profile: profile(entry),
    cwd: repo,
    maxBytes: 1024,
    signal: new AbortController().signal,
    onOutput: () => undefined,
  });
  assert.equal(result.truncated, true);
  assert.ok(result.output.length <= 1024);
  assert.match(result.error!, /output exceeded/);
});

test("verification cancellation starts after observed command output and stops its process", async (t) => {
  const { root, repo } = await fixture(t);
  const entry = path.join(root, "wait.cjs");
  await writeFile(entry, "console.log('READY');setInterval(()=>{},1000);");
  const controller = new AbortController();
  const result = await runVerificationCommand({
    profile: profile(entry),
    cwd: repo,
    maxBytes: 1024,
    signal: controller.signal,
    onOutput: (text) => {
      if (text.includes("READY")) controller.abort();
    },
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.error, undefined);
  assert.equal(result.terminationUnconfirmed, undefined);
});

test("verification deadlines and output-storage errors cannot become successful checks", async (t) => {
  const { root, repo } = await fixture(t);
  const entry = path.join(root, "wait.cjs");
  await writeFile(entry, "console.log('READY');setInterval(()=>{},1000);");
  const timed = await runVerificationCommand({
    profile: profile(entry, [], 0.003),
    cwd: repo,
    maxBytes: 1024,
    signal: new AbortController().signal,
    onOutput: () => undefined,
  });
  assert.match(timed.error!, /timed out/);
  const unsaved = await runVerificationCommand({
    profile: profile(entry),
    cwd: repo,
    maxBytes: 1024,
    signal: new AbortController().signal,
    onOutput: () => {
      throw new Error("disk full");
    },
  });
  assert.match(unsaved.error!, /could not be recorded/);
});

test("verification rejects invalid arguments and honours an already-cancelled request without launching", async (t) => {
  const { repo } = await fixture(t);
  const invalid = await run(process.execPath, repo, ["bad\0argument"]);
  assert.match(invalid.error!, /Invalid/);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runVerificationCommand({
    profile: profile("not-installed"),
    cwd: repo,
    maxBytes: 1024,
    signal: controller.signal,
    onOutput: () => undefined,
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.error, undefined);
  const missing = await run("nova-absent-verification-command-76228", repo);
  assert.match(missing.error!, /not found/);
});

test(
  "an exited verification leader cannot leave inherited pipes hanging",
  { skip: process.platform === "win32" },
  async (t) => {
    let stopFile: string | undefined;
    t.after(() => stopFixture(stopFile));
    const { root, repo } = await fixture(t);
    stopFile = path.join(root, "stop-orphan");
    const entry = path.join(root, "orphan.cjs");
    const code = `process.on('SIGTERM',()=>{});const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopFile)})||!fs.existsSync(${JSON.stringify(root)}))process.exit(0);},20);setTimeout(()=>process.exit(0),30000).unref();const ready=()=>console.log('READY:'+process.pid);if(process.connected)process.once('disconnect',ready);else ready();`;
    await writeFile(
      entry,
      `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(code)}],{stdio:['ignore','inherit','inherit','ipc']});c.unref();process.exit(0);`,
    );
    const controller = new AbortController();
    let log = "";
    let readyAt = 0;
    const result = await runVerificationCommand({
      profile: profile(entry, [], 0.15),
      cwd: repo,
      maxBytes: 4096,
      signal: controller.signal,
      onOutput: (chunk) => {
        log += chunk;
        const match = /READY:(\d+)\r?\n/.exec(log);
        if (match && !readyAt) {
          readyAt = Date.now();
          controller.abort();
        }
      },
    });
    assert.ok(readyAt, "fixture must report ready after its leader exits");
    assert.ok(Date.now() - readyAt < 2800);
    assert.equal(result.cancelled, true);
    assert.equal(result.terminationUnconfirmed, undefined);
  },
);

test(
  "unreachable verification descendants fail closed after a bounded drain",
  { skip: process.platform === "win32" },
  async (t) => {
    let stopFile: string | undefined;
    t.after(() => stopFixture(stopFile));
    const { root, repo } = await fixture(t);
    stopFile = path.join(root, "stop-detached-orphan");
    const entry = path.join(root, "detached-orphan.cjs");
    const code = `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopFile)})||!fs.existsSync(${JSON.stringify(root)}))process.exit(0);},20);setTimeout(()=>process.exit(0),30000).unref();const ready=()=>console.log('READY:'+process.pid);if(process.connected)process.once('disconnect',ready);else ready();`;
    await writeFile(
      entry,
      `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(code)}],{stdio:['ignore','inherit','inherit','ipc'],detached:true});c.unref();process.exit(0);`,
    );
    const controller = new AbortController();
    let log = "";
    let readyAt = 0;
    const result = await runVerificationCommand({
      profile: profile(entry, [], 0.15),
      cwd: repo,
      maxBytes: 4096,
      signal: controller.signal,
      onOutput: (chunk) => {
        log += chunk;
        const match = /READY:(\d+)\r?\n/.exec(log);
        if (match && !readyAt) {
          readyAt = Date.now();
          controller.abort();
        }
      },
    });
    assert.ok(readyAt, "fixture must report ready after its leader exits");
    assert.ok(Date.now() - readyAt < 2800);
    assert.equal(result.cancelled, false);
    assert.equal(result.terminationUnconfirmed, true);
    assert.match(result.error!, /termination could not be confirmed/);
  },
);
