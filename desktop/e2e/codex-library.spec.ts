import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installFakeDesktopBridge } from "./desktop-fixture";
import type { FixtureCalls, FixtureControls } from "./desktop-fixture";

const openLibrary = async (page: Page) => {
  await page
    .getByRole("button", { name: "Codex library", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Codex library", exact: true }),
  ).toBeVisible();
};
const calls = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __workbenchTest: FixtureCalls }).__workbenchTest,
  );
const chooseTheme = async (page: Page, theme: "dark" | "light") => {
  await page.getByRole("button", { name: /^Settings/ }).click();
  const dialog = page.getByRole("dialog", { name: "Workbench settings" });
  await dialog
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption(theme);
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
};

test("locked Codex history still allows agent selection, project opening, and Recovery navigation", async ({ page }) => {
  await installFakeDesktopBridge(page, {
    noProjects: true,
    libraryFailure: "Codex history access is locked because a previous engine process could not be confirmed stopped.",
  });
  await page.goto("/");
  await openLibrary(page);
  await expect(page.getByRole("alert")).toContainText("history access is locked");
  await page.getByRole("combobox", { name: "Choose agent" }).selectOption("claude");
  await page.getByRole("textbox", { name: "Model override" }).fill("fixture-claude-model");
  await page.getByRole("button", { name: "Open Settings → Recovery" }).click();
  await expect(page.getByRole("tab", { name: "Recovery" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Open a project", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Choose agent" })).toHaveValue("claude");
  await expect(page.getByRole("textbox", { name: "Model override" })).toHaveValue("fixture-claude-model");
});

test("Codex library is inline, discoverable, and distinguishes excluded locations", async ({
  page,
}) => {
  await installFakeDesktopBridge(page);
  await page.goto("/");
  await openLibrary(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".library-source-bar")).toContainText(
    "C:\\Fixtures\\Codex",
  );
  await page.getByRole("button", { name: "Locations", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Location inventory" }),
  ).toBeVisible();
  const excluded = page
    .locator(".location-row")
    .filter({ hasText: "Credentials" });
  await expect(excluded).toContainText("Excluded");
  await expect(excluded.getByRole("button")).toHaveCount(0);
  await expect(page.locator(".location-list")).toContainText("Engine-managed");
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.locator(".codex-library")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await page
    .getByRole("combobox", { name: "Search commands" })
    .fill("Codex library");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Codex library", exact: true }),
  ).toBeVisible();
  expect((await calls(page)).requests).toEqual([]);
});

test("conversation discovery supports active, archived, search, and opaque pagination", async ({
  page,
}) => {
  await installFakeDesktopBridge(page);
  await page.goto("/");
  await openLibrary(page);
  await expect(page.locator(".library-thread")).toHaveCount(2);
  await page.getByRole("button", { name: "Load more conversations" }).click();
  await expect(page.locator(".library-thread")).toHaveCount(3);
  expect((await calls(page)).libraryQueries.at(-1)?.cursor).toBe(
    "fixture-next-conversations",
  );
  await page
    .getByRole("textbox", { name: "Search Codex conversations" })
    .fill("Second");
  await expect(page.locator(".library-thread")).toHaveCount(1);
  await expect(page.locator(".library-thread")).toContainText(
    "Second Codex conversation",
  );
  await page
    .getByRole("textbox", { name: "Search Codex conversations" })
    .fill("");
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(page.locator(".library-thread")).toHaveCount(1);
  await expect(page.locator(".library-thread")).toContainText(
    "Archived Codex conversation",
  );
  await expect(page.locator(".library-handoff")).toContainText(
    "archived source is forked first",
  );
  expect((await calls(page)).libraryQueries.at(-1)?.archived).toBe(true);
});

test("older history prepends chronologically while import retains a bounded snapshot", async ({
  page,
}) => {
  await installFakeDesktopBridge(page);
  await page.goto("/");
  await openLibrary(page);
  await expect(page.locator(".library-message")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Older messages", exact: true })
    .click();
  await expect(page.locator(".library-message")).toHaveCount(4);
  await expect(page.locator(".library-message").first()).toContainText(
    "Older question before",
  );
  await expect(page.locator(".library-message").last()).toContainText(
    "Recent retained response",
  );
  await expect(page.locator(".library-message script")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { libraryInjected?: boolean }).libraryInjected,
    ),
  ).toBeUndefined();
  await page.getByRole("button", { name: "Open in Nova", exact: true }).click();
  const history = page.getByRole("region", {
    name: "Imported visible history",
  });
  await expect(history).toContainText(
    "2 retained messages · snapshot truncated",
  );
  await expect(history).toContainText("Recent retained question");
  await expect(history).not.toContainText("Older question before");
  await expect(history).toContainText("not a new agent run");
  await expect(page.locator(".run-card")).toHaveCount(0);
  expect((await calls(page)).imports).toEqual([
    { threadId: "fixture-codex-recent", archived: false },
  ]);
  expect((await calls(page)).requests).toEqual([]);
});

test("imported threads keep one Nova thread when switching Codex, Claude, and local providers", async ({
  page,
}) => {
  await installFakeDesktopBridge(page, { complete: true });
  await page.goto("/");
  await openLibrary(page);
  await page.getByRole("button", { name: "Open in Nova", exact: true }).click();
  await expect(page.locator(".continuation-note")).toContainText(
    "resume the original conversation",
  );
  const composer = page.getByRole("textbox", {
    name: "Message your coding agent",
  });
  await composer.fill("Continue natively");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".run-card")).toHaveCount(1);
  await page
    .getByRole("combobox", { name: "Choose agent" })
    .selectOption("claude");
  await expect(page.locator(".continuation-note")).toContainText(
    "No Codex hidden state is transferred",
  );
  await composer.fill("Continue from visible context");
  await page.getByRole("button", { name: "Preview context" }).click();
  await expect(page.getByLabel("Exact context payload")).toContainText(
    "Recent retained question",
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".run-card")).toHaveCount(2);
  await page
    .getByRole("combobox", { name: "Choose agent" })
    .selectOption("ollama");
  await page
    .getByRole("textbox", { name: "Model override" })
    .fill("fixture-local-model");
  await composer.fill("Continue locally");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".run-card")).toHaveCount(3);
  const requests = (await calls(page)).requests;
  expect(requests.map((request) => request.provider)).toEqual([
    "codex",
    "claude",
    "ollama",
  ]);
  expect(new Set(requests.map((request) => request.threadId))).toEqual(
    new Set(["imported-fixture-codex-recent"]),
  );
  await expect(
    page.getByText("Finished · not verified", { exact: true }),
  ).toHaveCount(3);
});

test("imported non-Git folders stay Plan-only with no automatic repository initialization", async ({
  page,
}) => {
  await installFakeDesktopBridge(page);
  await page.goto("/");
  await openLibrary(page);
  await page
    .getByRole("textbox", { name: "Search Codex conversations" })
    .fill("Folder notes");
  await expect(page.locator(".library-detail-heading")).toContainText(
    "Folder notes conversation",
  );
  await page.getByRole("button", { name: "Open in Nova", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Build", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".folder-project-note")).toContainText(
    "will not initialize or modify this folder automatically",
  );
  await expect(
    page.getByRole("button", { name: "Plan", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("textbox", { name: "Message your coding agent" })
    .fill("Inspect these notes");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop current run" }),
  ).toBeVisible();
  expect((await calls(page)).requests[0]).toMatchObject({
    projectId: "fixture-folder-project",
    mode: "plan",
  });
});

test("resources require exact preview digests and keep external provenance distinct from project files", async ({
  page,
}) => {
  await installFakeDesktopBridge(page);
  await page.goto("/");
  await openLibrary(page);
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  const selector = page.getByRole("combobox", { name: "Resource section" });
  await expect(selector.locator("option")).toHaveText([
    "Memories",
    "Memories v2",
    "Instructions",
    "Skills",
    "Plans",
  ]);
  await page
    .getByRole("button", { name: /Fixture instructions reference/ })
    .click();
  await expect(page.getByLabel("Resource content")).toContainText(
    "<script>window.libraryInjected=true</script>",
  );
  await expect(page.locator(".resource-preview script")).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { __workbenchFixture: FixtureControls }
    ).__workbenchFixture.setResourceDigest("fixture-resource-v2"),
  );
  await page.getByRole("button", { name: "Import as project memory" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Resource changed since preview",
  );
  await page
    .getByRole("button", { name: /Fixture instructions reference/ })
    .click();
  await page.getByRole("button", { name: "Import as project memory" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Imported as a source-linked reference",
  );
  const imports = (await calls(page)).resourceImports;
  expect(imports.map((request) => request.expectedSha256)).toEqual([
    "fixture-resource-v1",
    "fixture-resource-v2",
  ]);
  expect(imports[1]).toMatchObject({
    projectId: "test-project",
    section: "instructions",
    path: "instructions/guide.md",
  });
  await page.getByRole("button", { name: "Show memory" }).click();
  const memory = page
    .locator(".memory-card")
    .filter({ hasText: "Fixture instructions reference" });
  await expect(memory).toContainText("external resource, not a project file");
  await memory.getByRole("button", { name: "Edit as manual note" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit project memory" });
  await expect(dialog).toContainText("removes the Codex resource link");
  await expect(
    dialog.getByRole("button", { name: "Save as manual memory" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const beforeSourcePreview = await calls(page);
  await memory
    .getByRole("button", { name: "Preview source in Codex library" })
    .click();
  await expect(page.getByLabel("Resource content")).toContainText(
    "Keep checks reproducible",
  );
  const afterSourcePreview = await calls(page);
  expect(afterSourcePreview.libraryQueries.length).toBe(
    beforeSourcePreview.libraryQueries.length,
  );
  expect(afterSourcePreview.historyQueries.length).toBe(
    beforeSourcePreview.historyQueries.length,
  );
  expect((await calls(page)).requests).toEqual([]);
});

test("all resource sections preview as text without installing or executing anything", async ({
  page,
}) => {
  await installFakeDesktopBridge(page);
  await page.goto("/");
  await openLibrary(page);
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  for (const section of [
    "memories",
    "memories_v2",
    "instructions",
    "skills",
    "plans",
  ]) {
    await page
      .getByRole("combobox", { name: "Resource section" })
      .selectOption(section);
    await page
      .getByRole("button", {
        name: `Fixture ${section} reference`,
        exact: false,
      })
      .click();
    await expect(page.getByLabel("Resource content")).toContainText(
      "Fixture reference",
    );
    await expect(page.locator(".library-detail")).toContainText(
      "not installed or executed",
    );
  }
  expect(
    (await calls(page)).resourcePreviews.map((request) => request.section),
  ).toEqual(["memories", "memories_v2", "instructions", "skills", "plans"]);
  expect((await calls(page)).resourceImports).toEqual([]);
  expect((await calls(page)).requests).toEqual([]);
});

test("storage settings use native bridge pickers and explicitly do not relocate existing threads", async ({
  page,
}) => {
  await installFakeDesktopBridge(page, { seed: true });
  await page.goto("/");
  await page.getByRole("button", { name: /^Settings/ }).click();
  const dialog = page.getByRole("dialog", { name: "Workbench settings" });
  await dialog.getByRole("tab", { name: "Storage", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Choose Codex home folder" })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Codex home", exact: true }),
  ).toHaveValue("E:\\Chosen\\Codex");
  await dialog
    .getByRole("button", { name: "Choose worktree storage folder" })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Worktree storage", exact: true }),
  ).toHaveValue("E:\\Chosen\\Worktrees");
  await expect(dialog).toContainText(
    "Existing threads keep their current location; nothing is moved",
  );
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  const snapshot = await page.evaluate(() => window.workbench!.getSnapshot());
  expect(snapshot.state.settings).toMatchObject({
    codexHome: "E:\\Chosen\\Codex",
    worktreeStoragePath: "E:\\Chosen\\Worktrees",
  });
  expect(snapshot.state.threads[0].worktreePath).toBe("D:\\Fixtures\\worktree");
  expect((await calls(page)).directoryPicks).toEqual([
    "codex-home",
    "worktrees",
  ]);
});

test("library errors are explicit and refresh recovers without a model call", async ({
  page,
}) => {
  await installFakeDesktopBridge(page, {
    libraryFailure:
      "Configured Codex engine does not support conversation reads.",
  });
  await page.goto("/");
  await openLibrary(page);
  await expect(page.getByRole("alert")).toContainText(
    "does not support conversation reads",
  );
  await expect(
    page.getByRole("button", { name: "Open in Nova", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { __workbenchFixture: FixtureControls }
    ).__workbenchFixture.setLibraryFailure(""),
  );
  await page.getByRole("button", { name: "Refresh Codex library" }).click();
  await expect(
    page.getByRole("button", { name: "Open in Nova", exact: true }),
  ).toBeEnabled();
  expect((await calls(page)).requests).toEqual([]);
});

test("capture synthetic Codex library and imported handoff at desktop and compact sizes", async ({
  page,
}) => {
  await mkdir("artifacts", { recursive: true });
  await page.goto("/?demo=1");
  await openLibrary(page);
  await expect(
    page.getByRole("button", { name: "Open in Nova", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".library-heading")).toContainText(
    "Synthetic examples",
  );
  await page.screenshot({
    path: "artifacts/codex-library-dark.png",
    fullPage: true,
  });
  await chooseTheme(page, "light");
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await page.getByRole("button", { name: /AGENTS.md/ }).click();
  await expect(page.getByLabel("Resource content")).toContainText(
    "Synthetic project instructions",
  );
  await page.screenshot({
    path: "artifacts/codex-library-light-resources.png",
    fullPage: true,
  });
  await chooseTheme(page, "dark");
  await page.setViewportSize({ width: 980, height: 720 });
  await page
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open in Nova", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/codex-library-compact980.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.getByRole("button", { name: "Open in Nova", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Choose agent" })
    .selectOption("claude");
  await page.getByRole("button", { name: "Preview context" }).click();
  await expect(page.getByLabel("Exact context payload")).toContainText(
    "SYNTHETIC UI PREVIEW",
  );
  await page.locator(".conversation-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: "artifacts/codex-imported-handoff.png",
    fullPage: true,
  });
  await expect(page.locator(".continuation-note")).toContainText(
    "No Codex hidden state is transferred",
  );
});
