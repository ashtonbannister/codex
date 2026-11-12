import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installFakeDesktopBridge } from "./desktop-fixture";
import type { FixtureCalls, FixtureControls } from "./desktop-fixture";

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __workbenchTest: FixtureCalls }).__workbenchTest);
const settings = async (page: Page, section: string) => {
  await page.getByRole("button", { name: /^Settings/ }).click();
  const dialog = page.getByRole("dialog", { name: "Workbench settings" });
  await dialog.getByRole("tab", { name: section, exact: true }).click();
  return dialog;
};
const screenshot = async (page: Page, name: string) => {
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: `artifacts/${name}.png`, fullPage: true });
};

test("local settings discover against the unsaved backend and keep a manual model fallback", async ({ page }) => {
  await installFakeDesktopBridge(page, { seed: true, finishing: true });
  await page.goto("/");
  const dialog = await settings(page, "Local models");
  await dialog.getByRole("combobox", { name: "Local backend" }).selectOption("custom");
  await expect(dialog.getByRole("textbox", { name: "Local base URL" })).toHaveValue("http://127.0.0.1:8080/v1");
  await expect(dialog.getByRole("combobox", { name: "API protocol" })).toHaveValue("chat-completions");
  await dialog.getByRole("combobox", { name: "Local backend" }).selectOption("lmstudio");
  await expect(dialog.getByRole("textbox", { name: "Local base URL" })).toHaveValue("http://127.0.0.1:1234/v1");
  await expect(dialog.getByRole("combobox", { name: "API protocol" })).toHaveValue("responses");
  await dialog.getByRole("combobox", { name: "API protocol" }).selectOption("chat-completions");
  await dialog.getByRole("button", { name: "Load models", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Available models" }).selectOption("fixture-coder");
  await expect(dialog.getByRole("textbox", { name: "Default local model" })).toHaveValue("fixture-coder");
  expect((await calls(page)).modelQueries).toEqual([{ kind: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", protocol: "chat-completions" }]);
  expect((await page.evaluate(() => window.workbench!.getSnapshot())).state.settings.localProvider).not.toBe("lmstudio");
  await dialog.getByRole("button", { name: "LM Studio server setup" }).click();
  expect((await calls(page)).providerHelp).toEqual(["lmstudio"]);
  await screenshot(page, "finishing-local-models");
  await dialog.getByRole("textbox", { name: "Default local model" }).fill("manually-entered-model");
  await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const snapshot = await page.evaluate(() => window.workbench!.getSnapshot());
  expect(snapshot.state.settings).toMatchObject({ localProvider: "lmstudio", localBaseUrl: "http://127.0.0.1:1234/v1", localProtocol: "chat-completions", localModel: "manually-entered-model" });
  await expect(page.getByRole("combobox", { name: "Choose agent" }).locator('option[value="ollama"]')).toHaveText("Local · LM Studio");
});

test("runtime browsing and recovery are explicit native bridge actions", async ({ page }) => {
  await installFakeDesktopBridge(page, { seed: true, finishing: true });
  await page.goto("/");
  const dialog = await settings(page, "Agents");
  await dialog.getByRole("button", { name: "Choose Codex executable", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Codex executable", exact: true })).toHaveValue("C:\\Fixture runtimes\\codex.exe");
  await dialog.getByRole("button", { name: "Choose Claude Code executable", exact: true }).click();
  await dialog.getByRole("button", { name: "Claude Code setup & sign-in" }).click();
  expect((await calls(page)).executablePicks).toEqual(["codex", "claude"]);
  expect((await calls(page)).providerHelp).toEqual(["claude"]);
  await dialog.getByRole("tab", { name: "Recovery", exact: true }).click();
  await expect(dialog.getByText("Fixture cleanup failure", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("cannot automatically prove");
  await expect(dialog).toContainText("verify in Task Manager");
  await screenshot(page, "finishing-recovery");
  await dialog.getByRole("button", { name: "I verified the worker stopped…" }).click();
  await expect(dialog).toContainText("No recovery locks recorded");
  expect((await calls(page)).recoveryAcknowledgements).toEqual([{ id: "fixture-recovery", token: "fixture-lock-token" }]);
});

test("reviewed Git actions retain identities, reject stale state, and fast-forward only after commit", async ({ page }) => {
  await installFakeDesktopBridge(page, { seed: true, finishing: true });
  await page.goto("/");
  const inspector = page.getByRole("complementary", { name: "Project inspector" });
  await inspector.getByRole("button", { name: "Review worktree", exact: true }).click();
  await expect(inspector.getByRole("button", { name: "Integrate into original checkout…" })).toBeDisabled();
  await inspector.getByRole("textbox", { name: "Commit message" }).fill("Finish the fixture change");
  await screenshot(page, "finishing-worktree-review");
  await page.evaluate(() => (window as unknown as { __workbenchFixture: FixtureControls }).__workbenchFixture.setRevision("fixture-new-change"));
  await inspector.getByRole("button", { name: "Commit reviewed changes…" }).click();
  await expect(inspector.getByRole("alert")).toContainText("Worktree changed after review");
  expect((await calls(page)).worktreeCommits[0]).toMatchObject({ runId: "test-run-1", expectedHead: "fixture-head", expectedFingerprint: "fixture-current" });
  await inspector.getByRole("button", { name: "Review worktree", exact: true }).click();
  await inspector.getByRole("button", { name: "Commit reviewed changes…" }).click();
  await expect(inspector.getByRole("button", { name: "Integrate into original checkout…" })).toBeEnabled();
  await inspector.getByRole("button", { name: "Integrate into original checkout…" }).click();
  await expect(inspector).toContainText("Already integrated");
  expect((await calls(page)).worktreeIntegrations).toEqual([{ runId: "test-run-1", expectedHead: "fixture-commit", expectedFingerprint: "fixture-committed-clean", expectedTargetHead: "fixture-target", expectedTargetBranch: "main", expectedTargetFingerprint: "fixture-target-clean" }]);
});

test("composer drafts restore per-thread provider, model and mode without crossing thread boundaries", async ({ page }) => {
  await installFakeDesktopBridge(page, { seed: true, extraThreads: 1, complete: true });
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message your coding agent" });
  await composer.fill("First thread draft");
  await page.getByRole("combobox", { name: "Choose agent" }).selectOption("claude");
  await page.getByRole("textbox", { name: "Model override" }).fill("fixture-model-override");
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByRole("button", { name: "Palette test thread 01", exact: true }).click();
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Choose agent" })).toHaveValue("codex");
  await composer.fill("Second thread draft");
  await page.getByRole("button", { name: "Review the fixture change", exact: true }).click();
  await expect(composer).toHaveValue("First thread draft");
  await page.reload();
  await expect(composer).toHaveValue("First thread draft");
  await expect(page.getByRole("combobox", { name: "Choose agent" })).toHaveValue("claude");
  await expect(page.getByRole("textbox", { name: "Model override" })).toHaveValue("fixture-model-override");
  await expect(page.getByRole("button", { name: "Build", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Palette test thread 01", exact: true }).click();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(composer).toHaveValue("");
  expect((await calls(page)).requests[0]).toMatchObject({ threadId: "extra-thread-1", provider: "codex", mode: "plan", prompt: "Second thread draft" });
  await page.getByRole("button", { name: "Review the fixture change", exact: true }).click();
  await expect(composer).toHaveValue("First thread draft");
});

test("conversation export distinguishes a saved Markdown file from native cancellation", async ({ page }) => {
  await installFakeDesktopBridge(page, { seed: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Export conversation as Markdown", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Conversation exported as Markdown");
  await expect(page.getByRole("status")).toContainText("conversation.md");
  expect((await calls(page)).exports).toEqual(["test-thread-1"]);
  await page.evaluate(() => (window as unknown as { __workbenchFixture: FixtureControls }).__workbenchFixture.setExportCancelled(true));
  await page.getByRole("button", { name: "Thread actions: Review the fixture change" }).click();
  await page.getByRole("menuitem", { name: "Export as Markdown…" }).click();
  await expect(page.getByRole("status")).toContainText("Export cancelled. No file was written.");
});

test("browser preview labels simulated workflows and keeps rejected prompts", async ({ page }) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Export conversation as Markdown", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Preview only — no conversation file is written");
  const dialog = await settings(page, "Local models");
  await dialog.getByRole("button", { name: "Load models", exact: true }).click();
  await expect(dialog).toContainText("Synthetic preview catalog");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Message your coding agent" });
  await composer.fill("Keep this rejected preview draft");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("UI preview");
  await expect(composer).toHaveValue("Keep this rejected preview draft");
  await page.reload();
  await expect(composer).toHaveValue("Keep this rejected preview draft");
});
