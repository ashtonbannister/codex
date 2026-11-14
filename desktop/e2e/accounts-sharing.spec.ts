import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installFakeDesktopBridge } from "./desktop-fixture";
import type { FixtureCalls, FixtureControls } from "./desktop-fixture";

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __workbenchTest: FixtureCalls }).__workbenchTest);
const screenshot = async (page: Page, name: string) => {
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: `artifacts/${name}.png`, fullPage: true });
};
const openAccounts = async (page: Page) => {
  await page.getByRole("button", { name: /^Settings/ }).click();
  const dialog = page.getByRole("dialog", { name: "Workbench settings" });
  await dialog.getByRole("tab", { name: "Agents", exact: true }).click();
  return dialog;
};

test("account controls distinguish CLI detection, signed-in state, browser progress and cancellation", async ({ page }) => {
  await installFakeDesktopBridge(page, { seed: true, complete: true });
  await page.goto("/");
  const dialog = await openAccounts(page);
  const accounts = dialog.getByRole("region", { name: "Provider accounts" });
  await expect(accounts.getByText("Account not checked", { exact: true })).toHaveCount(2);
  await accounts.getByRole("button", { name: "Check Codex account", exact: true }).click();
  await expect(accounts).toContainText("Not signed in");
  await accounts.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
  await expect(accounts.getByRole("status")).toContainText("In progress");
  await expect(dialog.getByRole("button", { name: "Save settings", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Finish or cancel sign-in before closing settings.");
  await accounts.scrollIntoViewIfNeeded();
  await screenshot(page, "accounts-codex-sign-in");
  await page.evaluate(() => (window as unknown as { __workbenchFixture: FixtureControls }).__workbenchFixture.setLoginState("complete"));
  await expect(accounts).toContainText("Signed in · fixture-account@example.invalid");
  await expect(accounts.getByRole("status")).toContainText("Complete");
  await accounts.getByRole("button", { name: "Sign in to Claude Code", exact: true }).click();
  await accounts.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(accounts.getByRole("status")).toContainText("Cancelled");
  await expect(dialog.getByRole("button", { name: "Save settings", exact: true })).toBeEnabled();
  const recorded = await calls(page);
  expect(recorded.accountLogins).toEqual(["codex", "claude"]);
  expect(recorded.loginCancellations).toBe(1);
  expect(recorded.requests).toEqual([]);
  await dialog.getByRole("textbox", { name: "Codex executable", exact: true }).fill("D:\\Changed\\codex.exe");
  await expect(accounts.getByRole("button", { name: "Check Codex account", exact: true })).toBeDisabled();
  await expect(accounts).toContainText("Save executable changes");
});

test("shared memory previews exact files, rejects a stale preview and publishes only the reviewed fingerprint", async ({ page }) => {
  await installFakeDesktopBridge(page, { seed: true, complete: true });
  await page.goto("/");
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  const sharing = page.getByRole("region", { name: "Share memory with official apps" });
  await sharing.getByRole("button", { name: "Preview shared memory files", exact: true }).click();
  await expect(sharing.getByLabel("Proposed .nova/MEMORY.md", { exact: true })).toContainText("External note: preserve me.");
  await expect(sharing).toContainText("AGENTS.md");
  await expect(sharing).toContainText("CLAUDE.md");
  await screenshot(page, "sharing-project-memory");
  await page.evaluate(() => (window as unknown as { __workbenchFixture: FixtureControls }).__workbenchFixture.setSharedMemoryFingerprint("fixture-shared-v2"));
  await sharing.getByRole("button", { name: "Publish reviewed memory…", exact: true }).click();
  await expect(sharing.getByRole("alert")).toContainText("Shared memory files changed after preview");
  await expect(sharing.getByRole("button", { name: "Publish reviewed memory…", exact: true })).toHaveCount(0);
  await sharing.getByRole("button", { name: "Preview shared memory files", exact: true }).click();
  await sharing.getByRole("button", { name: "Publish reviewed memory…", exact: true }).click();
  await expect(sharing.getByRole("status")).toContainText("Shared memory published");
  expect((await calls(page)).sharedMemoryPublishes).toEqual([{ projectId: "test-project", fingerprint: "fixture-shared-v1" }, { projectId: "test-project", fingerprint: "fixture-shared-v2" }]);
  await expect(sharing).toContainText("Nova shared-file reads: enabled");
  await sharing.getByRole("button", { name: "Disable Nova shared-file reads", exact: true }).click();
  await expect(sharing.getByRole("status")).toContainText("Project files and official Codex/Claude references were not removed");
  expect((await calls(page)).sharedMemoryDisabled).toEqual(["test-project"]);
  expect((await calls(page)).requests).toEqual([]);
});

test("explicit history copy preserves Nova data and never offers publishing back into Codex", async ({ page }) => {
  await installFakeDesktopBridge(page, { seed: true, complete: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Codex library", exact: true }).click();
  await page.getByRole("button", { name: "Read Codex import source", exact: true }).click();
  await page.getByRole("button", { name: "Open in Nova", exact: true }).click();
  const before = await page.evaluate(() => window.workbench!.getSnapshot());
  await page.getByRole("button", { name: "Copy latest history from Codex", exact: true }).click();
  await expect(page.getByRole("region", { name: "Imported visible history" })).toContainText("New visible message from the synthetic official Codex thread.");
  await expect(page.getByRole("status")).toContainText("existing Nova runs and memory were preserved");
  await expect(page.getByRole("button", { name: "Publish handoff to Codex", exact: true })).toHaveCount(0);
  const after = await page.evaluate(() => window.workbench!.getSnapshot());
  expect(after.state.runs).toEqual(before.state.runs);
  expect(after.state.memories).toEqual(before.state.memories);
  expect((await calls(page)).nativeRefreshes).toHaveLength(1);
  expect((await calls(page)).nativePublishes).toHaveLength(0);
  expect((await calls(page)).requests).toEqual([]);
  await screenshot(page, "sharing-codex-handoff");
});

test("compact light account controls retain keyboard access and safe preview wording", async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 760 });
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: /^Settings/ }).click();
  let dialog = page.getByRole("dialog", { name: "Workbench settings" });
  await dialog.getByRole("combobox", { name: "Theme", exact: true }).selectOption("light");
  await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
  dialog = await openAccounts(page);
  await expect(dialog).toContainText("Synthetic account controls");
  await dialog.getByRole("button", { name: "Sign in to Claude Code", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toContainText("Synthetic sign-in progress");
  await dialog.getByRole("region", { name: "Provider accounts" }).scrollIntoViewIfNeeded();
  await screenshot(page, "accounts-compact-light");
  await dialog.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
