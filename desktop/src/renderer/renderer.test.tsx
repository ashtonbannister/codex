import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageText } from "./components/MessageText";
import { createPreviewAPI } from "./preview";
import { ImportedHistory } from "./components/Transcript";
import { watchLoginProgress } from "./account-polling";
import type { ProviderLoginStatus } from "../shared/provider-auth";

test("login progress retries transient failures, publishes terminal state and bounds retry without retaining callbacks after close", async () => {
  const scheduled: Array<{ run: () => Promise<void>; delay: number; cancelled: boolean }> = [];
  const schedule = (run: () => Promise<void>, delay: number) => {
    const item = { run, delay, cancelled: false };
    scheduled.push(item);
    return () => { item.cancelled = true; };
  };
  let reads = 0;
  let errors = 0;
  let paused = 0;
  const updates: Array<ProviderLoginStatus | null> = [];
  const complete: ProviderLoginStatus = { id: "login-1", provider: "codex", state: "complete", message: "Complete" };
  const stop = watchLoginProgress({
    read: async () => { if (++reads === 1) throw new Error("Transient progress failure"); return complete; },
    onUpdate: (status) => updates.push(status), onError: () => { errors++; }, onPaused: () => { paused++; }, schedule,
  });
  assert.equal(scheduled[0]!.delay, 500);
  await scheduled[0]!.run();
  assert.equal(errors, 1);
  assert.equal(scheduled[1]!.delay, 1500);
  await scheduled[1]!.run();
  assert.deepEqual(updates, [complete]);
  assert.equal(scheduled.length, 2);
  assert.equal(paused, 0);
  stop();

  const stalled = watchLoginProgress({ read: async () => { throw new Error("Offline"); }, onUpdate: () => assert.fail("No result"), onError: () => {}, onPaused: () => { paused++; }, schedule });
  await scheduled[2]!.run();
  await scheduled[3]!.run();
  await scheduled[4]!.run();
  assert.equal(scheduled.length, 5);
  assert.equal(paused, 1);
  stalled();

  let deliver: (status: ProviderLoginStatus) => void = () => {};
  const closed = watchLoginProgress({ read: () => new Promise((resolve) => { deliver = resolve; }), onUpdate: () => assert.fail("Closed UI must ignore late progress"), onError: () => assert.fail("Closed UI"), onPaused: () => assert.fail("Closed UI"), schedule });
  const inFlight = scheduled[5]!.run();
  closed();
  deliver(complete);
  await inFlight;
  assert.equal(scheduled[5]!.cancelled, true);
});

test("browser preview never advertises a runtime or executes a model/check", async () => {
  const api = createPreviewAPI(false);
  const snapshot = await api.getSnapshot();
  assert.equal(snapshot.state.projects.length, 0);
  assert.ok(snapshot.providers.every((provider) => !provider.available));
  await assert.rejects(
    api.startRun({
      projectId: "preview-project",
      provider: "codex",
      mode: "plan",
      prompt: "Test",
    }),
    /UI preview/,
  );
  await assert.rejects(
    api.startVerification({
      runId: "preview-run",
      profileId: "preview-profile-typecheck",
    }),
    /UI preview/,
  );
});

test("preview provider accounts never imply a real login or share credentials", async () => {
  const api = createPreviewAPI(true);
  assert.equal((await api.getAccountStatus("codex")).state, "unknown");
  const progress = await api.startProviderLogin("claude");
  assert.equal(progress.state, "waiting");
  assert.match(progress.message, /Synthetic/);
  assert.equal(progress.verificationUrl, undefined);
  assert.equal(progress.userCode, undefined);
  await api.cancelProviderLogin();
  assert.equal((await api.getProviderLogin())?.state, "cancelled");
  assert.equal((await api.getAccountStatus("claude")).state, "unknown");
});

test("preview memory sharing and handoffs retain synthetic provenance and no run evidence", async () => {
  const api = createPreviewAPI(true);
  const before = await api.getSnapshot();
  const preview = await api.previewSharedMemory("preview-project");
  assert.deepEqual(preview.files.map((file) => file.path), [".nova/MEMORY.md", "AGENTS.md", "CLAUDE.md"]);
  assert.match(preview.files[0]!.after, /Synthetic preview only/);
  const publication = await api.publishSharedMemory({ projectId: preview.projectId, fingerprint: preview.fingerprint });
  assert.match(publication.message, /No files were written/);
  assert.deepEqual((await api.getSnapshot()).state.sharedMemoryProjects, ["preview-project"]);
  await api.disableSharedMemory("preview-project");
  assert.deepEqual((await api.getSnapshot()).state.sharedMemoryProjects, []);
  const handoff = await api.publishCodexHandoff("preview-thread");
  assert.equal(handoff.nativeThreadId, "synthetic-native-handoff");
  assert.match(handoff.warnings.join(" "), /No native thread or model turn/);
  assert.deepEqual((await api.getSnapshot()).state.runs, before.state.runs);
});

test("preview context labels synthetic history and excludes changed sources", async () => {
  const api = createPreviewAPI(true);
  const context = await api.previewContext({
    projectId: "preview-project",
    threadId: "preview-thread",
    provider: "claude",
    mode: "plan",
    prompt: "Continue",
  });
  assert.match(context.prompt, /SYNTHETIC UI PREVIEW/);
  assert.match(context.prompt, /CURRENT REQUEST\s+Continue/);
  assert.deepEqual(context.includedMemoryIds, ["preview-memory-1"]);
  assert.deepEqual(context.omittedMemoryIds, ["preview-memory-2"]);
  assert.equal(context.estimatedTokens, Math.ceil(context.characters / 4));
});

test("preview thread changes persist within the preview without mutating returned snapshots", async () => {
  const api = createPreviewAPI(true);
  await api.updateThread({
    id: "preview-thread",
    title: "Renamed",
    pinned: true,
    archived: true,
  });
  const first = await api.getSnapshot();
  assert.equal(first.state.threads[0].title, "Renamed");
  assert.ok(first.state.threads[0].archivedAt);
  first.state.threads[0].title = "External mutation";
  assert.equal((await api.getSnapshot()).state.threads[0].title, "Renamed");
  await api.updateThread({ id: "preview-thread", archived: false });
  assert.equal(
    (await api.getSnapshot()).state.threads[0].archivedAt,
    undefined,
  );
});

test("new linked preview memories honestly report source unavailable", async () => {
  const api = createPreviewAPI(false);
  await api.chooseProject();
  const memory = await api.saveMemory({
    projectId: "preview-project",
    title: "Source rule",
    content: "Check the real source.",
    kind: "constraint",
    source: "User",
    filePath: "src/source.ts",
  });
  const context = await api.previewContext({
    projectId: "preview-project",
    provider: "codex",
    mode: "plan",
    prompt: "",
  });
  assert.equal(context.memories[0].freshness, "unavailable");
  assert.equal(context.memories[0].included, false);
  await api.archiveMemory(memory.id);
  assert.equal(
    (
      await api.previewContext({
        projectId: "preview-project",
        provider: "codex",
        mode: "plan",
        prompt: "",
      })
    ).memories.length,
    0,
  );
});

test("saving a preview check profile does not add execution evidence", async () => {
  const api = createPreviewAPI(true);
  const before = (await api.getSnapshot()).state.verifications.length;
  const profile = await api.saveVerificationProfile({
    projectId: "preview-project",
    name: "Example lint",
    executable: "npm",
    args: ["run", "lint"],
    timeoutMinutes: 10,
  });
  assert.equal((await api.getSnapshot()).state.verifications.length, before);
  await api.deleteVerificationProfile(profile.id);
  assert.equal(
    (await api.getSnapshot()).state.verificationProfiles.some(
      (entry) => entry.id === profile.id,
    ),
    false,
  );
});

test("Markdown formatting is safe text, with headings/lists and literal HTML/code", () => {
  const html = renderToStaticMarkup(
    <MessageText
      text={
        "## Heading\n\n**Bold** and `code`\n\n1. First\n2. Second\n\n<img src=x onerror=alert(1)>\n\n```html\n<script>alert(1)</script>\n```"
      }
    />,
  );
  assert.match(html, /<h3>Heading<\/h3>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<ol/);
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("synthetic Codex library pages recent history and exposes only permitted resource sections", async () => {
  const api = createPreviewAPI(false);
  const first = await api.listCodexThreads({ archived: false });
  assert.equal(first.threads.length, 2);
  assert.ok(first.nextCursor);
  const next = await api.listCodexThreads({
    archived: false,
    cursor: first.nextCursor,
  });
  assert.equal(next.threads.length, 1);
  assert.match(next.threads[0].title, /notes/);
  const history = await api.readCodexHistory({ threadId: first.threads[0].id });
  const older = await api.readCodexHistory({
    threadId: first.threads[0].id,
    cursor: history.nextCursor,
  });
  assert.equal(history.messages[0].turnId, "synthetic-turn-2");
  assert.equal(older.messages[0].turnId, "synthetic-turn-1");
  const inventory = await api.inspectCodexInstallation();
  assert.match(inventory.home, /Synthetic/);
  assert.equal(
    inventory.locations.find((item) => item.id === "credentials")?.access,
    "excluded",
  );
  await assert.rejects(
    api.previewCodexResource({ section: "instructions", path: "auth.json" }),
    /not available/,
  );
});

test("synthetic conversation import retains recent visible history without a model run", async () => {
  const api = createPreviewAPI(false);
  const thread = await api.importCodexThread({ threadId: "sample-codex-city" });
  assert.equal(thread.codex?.history.length, 2);
  assert.ok(thread.codex?.historyTruncated);
  const same = await api.importCodexThread({ threadId: "sample-codex-city" });
  assert.equal(same.id, thread.id);
  const context = await api.previewContext({
    projectId: thread.projectId,
    threadId: thread.id,
    provider: "claude",
    mode: "plan",
    prompt: "Continue",
  });
  assert.match(context.prompt, /bounded|testable city block/);
  assert.equal((await api.getSnapshot()).state.runs.length, 0);
  const folderThread = await api.importCodexThread({
    threadId: "sample-codex-folder",
  });
  const folder = (await api.getSnapshot()).state.projects.find(
    (item) => item.id === folderThread.projectId,
  );
  assert.equal(folder?.kind, "folder");
});

test("preview resource imports require the preview digest and manual edits remove external provenance", async () => {
  const api = createPreviewAPI(true);
  const resource = await api.previewCodexResource({
    section: "instructions",
    path: "AGENTS.md",
  });
  await assert.rejects(
    api.importCodexMemory({
      projectId: "preview-project",
      section: resource.section,
      path: resource.path,
      expectedSha256: "different",
    }),
    /changed/,
  );
  const entry = await api.importCodexMemory({
    projectId: "preview-project",
    section: resource.section,
    path: resource.path,
    expectedSha256: resource.sha256,
  });
  assert.equal(entry.codexSource?.sha256, resource.sha256);
  assert.equal(entry.filePath, undefined);
  const manual = await api.saveMemory({
    id: entry.id,
    projectId: entry.projectId,
    title: entry.title,
    content: "User revised note",
    kind: "note",
    source: "User reviewed",
  });
  assert.equal(manual.codexSource, undefined);
  assert.equal((await api.getSnapshot()).state.runs.length, 1);
});

test("imported history is visibly bounded and escapes literal model HTML", () => {
  const html = renderToStaticMarkup(
    <ImportedHistory
      source={{
        home: "synthetic",
        sourceThreadId: "thread",
        sourceCwd: "project",
        sourceArchived: false,
        importedAt: "2026-11-12T00:00:00Z",
        historyTruncated: true,
        warnings: ["Synthetic test"],
        history: [
          {
            id: "message",
            turnId: "turn",
            role: "assistant",
            text: "<script>window.injected=true</script>",
          },
        ],
      }}
    />,
  );
  assert.match(html, /snapshot truncated/);
  assert.match(html, /not a new agent run/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;script&gt;/);
});
