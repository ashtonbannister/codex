import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { RunRequest } from "../src/shared/types";
import { installFakeDesktopBridge } from "./desktop-fixture";
import type { FixtureCalls, FixtureControls } from "./desktop-fixture";

test("browser preview has an honest empty state and refuses model execution", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByText(
      "UI preview — no local files, credentials, or AI services are accessed.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Start with a project" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".availability-dot.available")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Open example project", exact: true })
    .click();
  await expect(page.locator(".toolbar-breadcrumb")).toContainText(
    "Henday Heat",
  );
  await page
    .getByRole("textbox", { name: "Message your coding agent" })
    .fill("Try to run an agent");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("UI preview");
  await expect(page.getByRole("alert")).toContainText("desktop application");
  await expect(page.locator(".run-card")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("sample conversation is explicitly illustrative and unverified", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await expect(page.locator(".run-card")).toHaveCount(1);
  await expect(
    page.getByText("Finished · not verified", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".message-text")).toContainText(
    "sample content for the interface preview",
  );
  await expect(page.locator(".inspector-footer")).toContainText(
    "Sample data only",
  );
  await page.getByRole("tab", { name: /Memory/ }).click();
  await expect(
    page.getByRole("heading", { name: "Simulation comes first" }),
  ).toBeVisible();
});

test("project memory can be created, edited, and explicitly archived", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open example project", exact: true })
    .click();
  await page.getByRole("tab", { name: /Memory/ }).click();
  await page.getByRole("button", { name: "Add a memory", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Add project memory" });
  await dialog
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Preserve stable interfaces");
  await dialog
    .getByRole("combobox", { name: "Type", exact: true })
    .selectOption("constraint");
  await dialog
    .getByRole("textbox", { name: "What should the agents know?" })
    .fill("Add tests before changing an exported interface.");
  await dialog
    .getByRole("textbox", { name: /Source or reference/ })
    .fill("docs/architecture.md");
  await dialog
    .getByRole("button", { name: "Save memory", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  let card = page.locator(".memory-card").filter({
    has: page.getByRole("heading", { name: "Preserve stable interfaces" }),
  });
  await expect(card).toContainText("docs/architecture.md");
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Edit project memory" });
  await dialog
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Review interface compatibility");
  await dialog
    .getByRole("button", { name: "Save memory", exact: true })
    .click();
  card = page.locator(".memory-card").filter({
    has: page.getByRole("heading", {
      name: "Review interface compatibility",
    }),
  });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(card).toBeVisible();
  await card
    .getByRole("button", { name: "Confirm archive", exact: true })
    .click();
  await expect(page.locator(".memory-card")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Keep the important parts" }),
  ).toBeVisible();
});

test("settings enforce timeout bounds and apply appearance", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Settings/ }).click();
  const dialog = page.getByRole("dialog", { name: "Workbench settings" });
  await expect(dialog).toContainText("does not collect API keys");
  const timeout = dialog.getByRole("spinbutton", { name: "Timeout · minutes" });
  await expect(timeout).toHaveAttribute("min", "1");
  await expect(timeout).toHaveAttribute("max", "120");
  await timeout.fill("121");
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  expect(
    await timeout.evaluate(
      (element: HTMLInputElement) => element.validity.rangeOverflow,
    ),
  ).toBe(true);
  await timeout.fill("10");
  await dialog
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("light");
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: /^Settings/ }).click();
  await expect(
    page.getByRole("spinbutton", { name: "Timeout · minutes" }),
  ).toHaveValue("10");
});

test("Escape closes dialogs and restores the invoking control", async ({
  page,
}) => {
  await page.goto("/");
  const settingsButton = page.getByRole("button", { name: /^Settings/ });
  await settingsButton.click();
  await expect(
    page.getByRole("dialog", { name: "Workbench settings" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(settingsButton).toBeFocused();
});

test("narrow desktop layout does not overflow horizontally", async ({
  page,
}) => {
  await page.setViewportSize({ width: 980, height: 720 });
  await page.goto("/?demo=1");
  await expect(
    page.getByRole("button", { name: "Show inspector" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Show inspector" }).click();
  await expect(
    page.getByRole("complementary", { name: "Project inspector" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(
    page.getByRole("complementary", { name: "Project inspector" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message your coding agent" }),
  ).toBeVisible();
});

test("mock desktop bridge receives chosen provider and supports cancellation", async ({
  page,
}) => {
  await installFakeDesktopBridge(page);
  await page.goto("/");
  await expect(page.locator(".preview-banner")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Choose agent" })
    .selectOption("claude");
  await page
    .getByRole("textbox", { name: "Model override" })
    .fill("fixture-model");
  const prompt = page.getByRole("textbox", {
    name: "Message your coding agent",
  });
  await prompt.fill("Inspect the fixture repository");
  await prompt.press("Control+Enter");
  await expect(
    page.getByRole("button", { name: "Stop current run" }),
  ).toBeVisible();
  await expect(page.locator(".agent-heading")).toContainText("Claude Code");
  await expect(page.locator(".agent-model")).toHaveText("fixture-model");
  const requests = await page.evaluate(
    () =>
      (window as unknown as { __workbenchTest: { requests: RunRequest[] } })
        .__workbenchTest.requests,
  );
  expect(requests).toEqual([
    {
      projectId: "test-project",
      provider: "claude",
      model: "fixture-model",
      mode: "plan",
      prompt: "Inspect the fixture repository",
    },
  ]);
  await page.getByRole("button", { name: "Stop current run" }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop current run" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __workbenchTest: { cancellations: string[] } })
          .__workbenchTest.cancellations,
    ),
  ).toEqual(["test-run-1"]);
});

test("model HTML and script text remain literal, and success is never called verified", async ({
  page,
}) => {
  await installFakeDesktopBridge(page, { complete: true, literal: true });
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Message your coding agent" })
    .fill("Return sample markup");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".message-text")).toContainText(
    '<img src="bad.example" onerror="window.injected=true">',
  );
  await expect(page.locator(".message-text code")).toHaveText(
    "<script>window.injected=true</script>\n",
  );
  await expect(
    page.locator(".agent-message img, .agent-message script"),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { injected?: boolean }).injected,
    ),
  ).toBeUndefined();
  await expect(
    page.getByText("Finished · not verified", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(
    page.getByText("Task not automatically verified", { exact: true }),
  ).toBeVisible();
});

test("unavailable agents cannot run until an explicit availability refresh", async ({
  page,
}) => {
  await installFakeDesktopBridge(page, { available: false });
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Message your coding agent" })
    .fill("Test readiness gating");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Refresh agent availability" })
    .click();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __workbenchTest: { refreshes: number } })
          .__workbenchTest.refreshes,
    ),
  ).toBe(1);
});

test("local model runs require an explicit model and Build is sent to the native bridge", async ({
  page,
}) => {
  await installFakeDesktopBridge(page);
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Choose agent" })
    .selectOption("ollama");
  await page
    .getByRole("textbox", { name: "Message your coding agent" })
    .fill("Build a fixture change");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Model override" })
    .fill("fixture-local-model");
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop current run" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __workbenchTest: { requests: RunRequest[] } })
          .__workbenchTest.requests[0],
    ),
  ).toMatchObject({
    provider: "ollama",
    model: "fixture-local-model",
    mode: "build",
  });
  // Native confirmation is main-process owned; these tests do not emulate or validate it.
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("command palette navigates threads and settings using the keyboard", async ({
  page,
}) => {
  await installFakeDesktopBridge(page, { seed: true });
  await page.goto("/");
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  const search = palette.getByRole("combobox", { name: "Search commands" });
  await search.fill("Review the fixture change");
  await search.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.locator(".toolbar-breadcrumb")).toContainText(
    "Review the fixture change",
  );
  await page.keyboard.press("Control+k");
  await search.fill("Settings");
  await search.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Workbench settings" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await search.fill("New thread");
  await search.press("Enter");
  await expect(
    page.getByRole("heading", { name: "What are we working on?" }),
  ).toBeVisible();
});

test("long command lists keep keyboard selection visible through scrolling and wraparound", async ({
  page,
}) => {
  await installFakeDesktopBridge(page, { seed: true, extraThreads: 14 });
  await page.goto("/");
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const search = palette.getByRole("combobox", { name: "Search commands" });
  await search.fill("Palette test thread");
  await expect(palette.getByRole("option")).toHaveCount(14);
  const selected = palette.locator('[role="option"][aria-selected="true"]');
  const expectVisibleSelection = async (title: string) => {
    await expect(search).toBeFocused();
    await expect(selected).toContainText(title);
    await expect
      .poll(() =>
        selected.evaluate((element) => {
          const list = element
            .closest(".command-results")!
            .getBoundingClientRect();
          const item = element.getBoundingClientRect();
          return item.top >= list.top && item.bottom <= list.bottom;
        }),
      )
      .toBe(true);
  };
  for (let index = 0; index < 12; index++) await search.press("ArrowDown");
  await expectVisibleSelection("Palette test thread 13");
  await search.press("ArrowDown");
  await search.press("ArrowDown");
  await expectVisibleSelection("Palette test thread 01");
  await search.press("ArrowUp");
  await expectVisibleSelection("Palette test thread 14");
  await search.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.locator(".toolbar-breadcrumb")).toContainText(
    "Palette test thread 14",
  );
});

test("thread names, pinning, archiving, and restoration are state backed", async ({
  page,
}) => {
  await installFakeDesktopBridge(page, { seed: true });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Thread actions: Review the fixture change" })
    .click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Thread name" })
    .fill("Focused fixture task");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.locator(".toolbar-breadcrumb")).toContainText(
    "Focused fixture task",
  );
  await page
    .getByRole("button", { name: "Thread actions: Focused fixture task" })
    .click();
  await page.getByRole("menuitem", { name: "Pin thread", exact: true }).click();
  await page
    .getByRole("button", { name: "Thread actions: Focused fixture task" })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Unpin thread", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Archive thread", exact: true })
    .click();
  await expect(
    page.getByText("This conversation is archived.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message your coding agent" }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Thread filter" })
    .selectOption("archived");
  await page
    .getByRole("button", { name: "Thread actions: Focused fixture task" })
    .click();
  await page
    .getByRole("menuitem", { name: "Restore thread", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message your coding agent" }),
  ).toBeEnabled();
  await page
    .getByRole("combobox", { name: "Thread filter" })
    .selectOption("active");
  await expect(
    page.getByRole("button", { name: "Thread actions: Focused fixture task" }),
  ).toBeVisible();
  const updates = await page.evaluate(
    () =>
      (window as unknown as { __workbenchTest: FixtureCalls }).__workbenchTest
        .threadUpdates,
  );
  expect(updates).toEqual([
    { id: "test-thread-1", title: "Focused fixture task" },
    { id: "test-thread-1", pinned: true },
    { id: "test-thread-1", archived: true },
    { id: "test-thread-1", archived: false },
  ]);
});

test("layout separators support keyboard resizing, collapse, and persistence", async ({
  page,
}) => {
  await page.goto("/");
  const separator = page.getByRole("separator", {
    name: "Resize project sidebar",
  });
  await separator.focus();
  await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "252");
  await page.reload();
  await expect(separator).toHaveAttribute("aria-valuenow", "252");
  const inspectorSeparator = page.getByRole("separator", {
    name: "Resize inspector",
  });
  await inspectorSeparator.focus();
  await inspectorSeparator.press("ArrowLeft");
  await expect(inspectorSeparator).toHaveAttribute("aria-valuenow", "372");
  await page.getByRole("button", { name: "Hide project sidebar" }).click();
  await expect(
    page.getByRole("complementary", { name: "Project navigation" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Show project sidebar" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show project sidebar" }).click();
  await expect(separator).toHaveAttribute("aria-valuenow", "252");
});

test("context displays the exact payload and preserves bounded history across providers", async ({
  page,
}) => {
  await installFakeDesktopBridge(page, { seed: true });
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Message your coding agent" })
    .fill("Continue the focused task");
  await page.getByRole("button", { name: "Preview context" }).click();
  const payload = page.getByLabel("Exact context payload");
  await expect(payload).toContainText("FIXTURE EXACT REQUEST");
  await expect(payload).toContainText("Task: Continue the focused task");
  await expect(payload).toContainText("History: Inspect the test fixture");
  await expect(payload).not.toContainText("This note needs review.");
  await expect(page.locator(".context-memory-list")).toContainText(
    "Source changed",
  );
  await expect(page.locator(".context-memory-list")).toContainText("Omitted");
  await expect(
    page.getByText("Token estimate uses characters ÷ 4.", { exact: false }),
  ).toBeVisible();
  const first = await payload.textContent();
  await page
    .getByRole("combobox", { name: "Choose agent" })
    .selectOption("claude");
  await expect(payload).toHaveText(first!);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __workbenchTest: FixtureCalls }
          ).__workbenchTest.contextRequests.at(-1)?.provider,
      ),
    )
    .toBe("claude");
  const requests = await page.evaluate(
    () =>
      (window as unknown as { __workbenchTest: FixtureCalls }).__workbenchTest
        .contextRequests,
  );
  expect(requests.at(-1)?.threadId).toBe("test-thread-1");
});

test("linked memories expose freshness and original-checkout reconfirmation", async ({
  page,
}) => {
  await installFakeDesktopBridge(page, { seed: true });
  await page.goto("/");
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  const card = page.locator(".memory-card").filter({
    has: page.getByRole("heading", { name: "Prior source decision" }),
  });
  await expect(card).toContainText("Source changed");
  await expect(card).toContainText("Omitted from current context");
  await card
    .getByRole("button", { name: "Review original project source" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Edit project memory" });
  await expect(dialog).toContainText("not the selected thread’s worktree");
  await expect(
    dialog.getByRole("textbox", { name: "Linked source file" }),
  ).toHaveValue("src/changed.ts");
  await dialog
    .getByRole("button", { name: "Save memory", exact: true })
    .click();
  await expect(card).toContainText("Source unchanged");
  await expect(card).toContainText("Included in current context");
});

test("check profiles validate JSON arguments and saving never executes them", async ({
  page,
}) => {
  await installFakeDesktopBridge(page, { seed: true });
  await page.goto("/");
  await page.getByRole("tab", { name: "Checks", exact: true }).click();
  await page
    .getByRole("button", { name: "Add check profile", exact: true })
    .last()
    .click();
  const form = page.getByRole("form", { name: "New check profile" });
  await form.getByRole("button", { name: "Typecheck", exact: true }).click();
  await expect(form.getByRole("textbox", { name: "Check name" })).toHaveValue(
    "Typecheck",
  );
  await form
    .getByRole("textbox", { name: "Arguments · JSON array" })
    .fill('{"unsafe":"shape"}');
  await form.getByRole("button", { name: "Save profile" }).click();
  await expect(form.getByRole("alert")).toContainText("JSON array of strings");
  await form
    .getByRole("textbox", { name: "Arguments · JSON array" })
    .fill('["run","typecheck"]');
  await form.getByRole("button", { name: "Save profile" }).click();
  await expect(
    page.getByRole("button", { name: "Run check: Typecheck", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __workbenchTest: FixtureCalls }).__workbenchTest
          .checks,
    ),
  ).toEqual([]);
});

test("checks stream mock output, cancel, and mark earlier evidence stale", async ({
  page,
}) => {
  await installFakeDesktopBridge(page, { seed: true });
  await page.goto("/");
  await page.getByRole("tab", { name: "Checks", exact: true }).click();
  await expect(
    page.getByText("Passed · current revision", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { __workbenchFixture: FixtureControls }
    ).__workbenchFixture.setRevision("fixture-changed"),
  );
  await page.getByRole("button", { name: "Refresh check results" }).click();
  await expect(
    page.getByText("Stale · files changed", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Run check: Fixture typecheck", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Cancel check", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { __workbenchFixture: FixtureControls }
    ).__workbenchFixture.appendCheckOutput(
      "fixture-check-1",
      "Streaming fixture output\n<img src=x>\n",
    ),
  );
  await expect(
    page.getByLabel("Check output for Fixture typecheck").first(),
  ).toContainText("Streaming fixture output");
  await expect(page.locator(".check-output img")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel check", exact: true }).click();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __workbenchTest: FixtureCalls }).__workbenchTest
          .checkCancellations,
    ),
  ).toEqual(["fixture-check-1"]);
  await expect(
    page.getByText("Finished · not verified", { exact: true }),
  ).toBeVisible();
});

test("Plan-only threads cannot execute project checks", async ({ page }) => {
  await installFakeDesktopBridge(page, { seed: true, planOnly: true });
  await page.goto("/");
  await page.getByRole("tab", { name: "Checks", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Run check: Fixture typecheck" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Checks need a completed run in a thread worktree.", {
      exact: false,
    }),
  ).toBeVisible();
});

test("browser preview refuses check execution and composer grows without horizontal overflow", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const composer = page.getByRole("textbox", {
    name: "Message your coding agent",
  });
  const initialHeight = (await composer.boundingBox())!.height;
  await composer.fill(
    Array.from(
      { length: 9 },
      (_, index) => `Line ${index + 1}: a focused draft`,
    ).join("\n"),
  );
  expect((await composer.boundingBox())!.height).toBeGreaterThan(initialHeight);
  await expect(composer).toHaveAttribute("maxlength", "32000");
  await page.getByRole("tab", { name: "Checks", exact: true }).click();
  await page
    .getByRole("button", { name: "Run check: Typecheck", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("UI preview only");
  expect(
    await page
      .locator(".composer")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test("capture six synthetic desktop states for human visual review", async ({
  page,
}) => {
  await mkdir("artifacts", { recursive: true });
  await page.goto("/?demo=1");
  await expect(
    page.getByText("Finished · not verified", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  await expect(page.locator(".memory-freshness").first()).toContainText(
    "Source unchanged",
  );
  await page.screenshot({
    path: "artifacts/workbench-dark-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /^Settings/ }).click();
  await page
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("light");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: "artifacts/workbench-light-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 980, height: 720 });
  await page.getByRole("button", { name: "Close inspector" }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/workbench-compact-980.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.getByRole("button", { name: /^Settings/ }).click();
  await page
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("dark");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Message your coding agent" })
    .fill("Continue the milestone with the current project constraints.");
  await page.getByRole("button", { name: "Preview context" }).click();
  await expect(page.getByLabel("Exact context payload")).toContainText(
    "SYNTHETIC UI PREVIEW",
  );
  await page.screenshot({
    path: "artifacts/workbench-context.png",
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Checks", exact: true }).click();
  await expect(
    page.getByText("Passed · current revision", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Stale · files changed", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "artifacts/workbench-checks.png",
    fullPage: true,
  });
  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("dialog", { name: "Command palette" }),
  ).toBeVisible();
  await page.screenshot({
    path: "artifacts/workbench-command-palette.png",
    fullPage: true,
  });
});
