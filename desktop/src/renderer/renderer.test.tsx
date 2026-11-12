import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageText } from "./components/MessageText";
import { createPreviewAPI } from "./preview";

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
