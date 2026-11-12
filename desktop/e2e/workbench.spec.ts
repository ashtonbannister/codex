import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { emptyWorkspace } from "../src/shared/types";
import type { Run, RunRequest, WorkspaceState } from "../src/shared/types";

/** These are renderer integration tests, not Electron or live-provider tests. */
async function installFakeDesktopBridge(
  page: Page,
  options: { available?: boolean; complete?: boolean; literal?: boolean } = {},
) {
  const initial = emptyWorkspace();
  initial.projects.push({
    id: "test-project",
    name: "Fixture repository",
    path: "D:\\Fixtures\\repository",
    branch: "main",
    createdAt: "2026-11-12T00:00:00Z",
  });
  await page.addInitScript(
    ({ initialState, config }) => {
      const state = initialState;
      const listeners = new Set<(value: WorkspaceState) => void>();
      const calls = {
        requests: [] as RunRequest[],
        cancellations: [] as string[],
        refreshes: 0,
        opens: [] as string[],
      };
      let available = config.available !== false;
      const publish = () =>
        listeners.forEach((callback) => callback(structuredClone(state)));
      const snapshot = () => ({
        state: structuredClone(state),
        providers: [
          {
            id: "codex",
            name: "Codex",
            available,
            detail: "Mock runtime for renderer tests",
          },
          {
            id: "claude",
            name: "Claude Code",
            available,
            detail: "Mock runtime for renderer tests",
          },
          {
            id: "ollama",
            name: "Local · Ollama",
            available,
            detail: "Mock runtime for renderer tests",
          },
        ],
        appVersion: "0.1.0-test",
        platform: "mock-desktop",
      });
      Object.assign(window, {
        __workbenchTest: calls,
        workbench: {
          async getSnapshot() {
            return snapshot();
          },
          async refreshProviderStatus() {
            calls.refreshes += 1;
            available = true;
            return snapshot();
          },
          async chooseProject() {
            return state.projects[0];
          },
          async startRun(request: RunRequest) {
            calls.requests.push(structuredClone(request));
            const threadId =
              request.threadId ?? `test-thread-${calls.requests.length}`;
            if (!state.threads.some((thread) => thread.id === threadId))
              state.threads.push({
                id: threadId,
                projectId: request.projectId,
                title: request.prompt.slice(0, 50),
                createdAt: "2026-11-12T00:00:00Z",
                updatedAt: "2026-11-12T00:00:00Z",
              });
            const run: Run = {
              id: `test-run-${calls.requests.length}`,
              threadId,
              projectId: request.projectId,
              provider: request.provider,
              model: request.model ?? "Provider default",
              mode: request.mode,
              prompt: request.prompt,
              status: config.complete ? "completed" : "running",
              createdAt: "2026-11-12T00:00:00Z",
              startedAt: "2026-11-12T00:00:00Z",
              verification: "not-run",
              contextMemoryIds: [],
              events: [
                {
                  id: "test-event-status",
                  at: "2026-11-12T00:00:00Z",
                  kind: "status",
                  text: "Mock process event",
                },
                {
                  id: "test-event-message",
                  at: "2026-11-12T00:00:01Z",
                  kind: "message",
                  text: config.literal
                    ? '<img src="bad.example" onerror="window.injected=true">\n\n```html\n<script>window.injected=true</script>\n```'
                    : "A mocked response for testing the desktop bridge.",
                },
              ],
            };
            state.runs.push(run);
            publish();
            return structuredClone(run);
          },
          async cancelRun(id: string) {
            calls.cancellations.push(id);
            const run = state.runs.find((item) => item.id === id);
            if (run) run.status = "cancelled";
            publish();
          },
          async getDiff() {
            return { branch: "main", changes: [], diff: "", truncated: false };
          },
          async saveMemory() {
            throw new Error("Not used by this fixture");
          },
          async archiveMemory() {
            throw new Error("Not used by this fixture");
          },
          async updateSettings(settings: WorkspaceState["settings"]) {
            state.settings = settings;
            publish();
            return settings;
          },
          async openProject(id: string) {
            calls.opens.push(id);
          },
          async revealWorktree(id: string) {
            calls.opens.push(id);
          },
          onStateChanged(callback: (value: WorkspaceState) => void) {
            listeners.add(callback);
            return () => {
              listeners.delete(callback);
            };
          },
        },
      });
    },
    { initialState: initial, config: options },
  );
}

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
    page.getByRole("heading", { name: /One workspace/ }),
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
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/workbench-preview.png",
    fullPage: true,
  });
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
  let card = page
    .locator(".memory-card")
    .filter({
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
  card = page
    .locator(".memory-card")
    .filter({
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
  await page.getByRole("button", { name: "Hide inspector" }).click();
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
    page.getByText("Verification not run", { exact: true }),
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
