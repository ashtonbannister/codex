# Nova Workbench

A Windows-first, multi-provider development workbench built alongside the open-source Codex engine.

Nova uses the familiar **projects → conversation → changes** workflow of Codex and Claude Code, with its own interface and branding. It is an independent project, not an official OpenAI or Anthropic desktop application, and does not contain either company's proprietary desktop UI.

**Status: initial foundation, version 0.1.0.** This is a runnable development starting point, not the completed autonomous engineering system. A finished agent process is explicitly **not** a verified engineering result.

## What's in this milestone

- Project and thread navigation, a conversation composer, and Changes, Memory, and Activity inspectors.
- Manual provider selection: Codex, Claude Code, or a local Ollama model through the Codex agent engine.
- Plan mode and explicitly confirmed Build mode in a separate Git worktree.
- Streaming agent messages and tool activity, failure states, cancellation, and runtime/output limits.
- Persistent local projects, conversations, settings, and user-authored project memories.
- Shared, bounded project-memory and conversation context when changing providers.
- Worktree diffs for review, without automatic merging or deleting worktrees.
- A narrow Electron bridge, isolated renderer, and Windows packaging configuration.

The larger roadmap is in [PLAN.md](PLAN.md). Automatic model routing, unattended agent teams, automatic knowledge extraction, a general MCP manager, and automated Unreal/BeamNG validation are **not implemented in this milestone**.

## Run on Windows

### Prerequisites

1. Windows with [Node.js](https://nodejs.org/) **24.22.1 or newer** and [Git](https://git-scm.com/downloads/win).
2. At least one supported provider installed separately:
   - [Codex CLI](https://github.com/openai/codex), for OpenAI-hosted models.
   - [Claude Code](https://code.claude.com/docs/en/setup), for Claude.
   - Codex CLI plus [Ollama](https://ollama.com/), for a locally installed model.
3. Complete authentication in the provider's **own official CLI**, where required. Nova does not provide a Claude.ai/OpenAI login form, read provider credential files, or import credentials.

From this repository's root, open PowerShell:

```powershell
cd desktop
npm ci
npm run dev
```

The development command starts the local renderer and Electron together. Renderer edits hot-reload; restart the command after changing main-process or preload code.

To run a built development application:

```powershell
npm run build
npm start
```

If provider discovery fails, use Settings to choose the installed native executable. A configured executable must actually be executable; a command containing shell operators is not a supported configuration. Nova intentionally does not use a shell to interpolate prompts or launch arbitrary renderer-supplied commands.

After installing or updating a CLI, use **Refresh agent availability** to rerun capability detection. Saving Settings also refreshes detection. Routine conversation updates use cached results; they do not repeatedly launch the CLIs.

### First task

1. Choose **Open project** and select a local Git repository.
2. Choose a provider. For Local, set the exact name of an already-installed Ollama model in Settings and start Ollama separately.
3. Start in **Plan** mode to inspect or discuss the project.
4. Add relevant constraints or decisions in **Memory**. Include a source that another agent or human can check.
5. Choose **Build** when you want file changes. The first build needs a clean Git baseline; Nova creates an isolated worktree for the thread and asks for confirmation before execution.
6. Inspect **Changes** and run the project's real verification steps. Nova does not merge the branch into your original checkout.

Changing the provider within a thread passes a bounded transcript and selected project memories to the next worker. This is **not** a transfer of private reasoning, provider-native hidden state, or an unlimited conversation context. Providers retain their own model limits, account access, and billing rules.

The Local adapter checks for the exact installed model at Ollama's loopback endpoint before starting. It does not pull models or fall back to a cloud model. Install the model yourself with the official Ollama tools; the selected model must support the capabilities needed by the Codex harness.

## Plan versus Build

| Mode     | Intended behavior                                                                  | Important boundary                                                                               |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Plan     | Read and analyze the selected project using the adapter's restricted configuration | Permission enforcement belongs to the configured provider runtime; review its support and errors |
| Build    | Work in the thread's isolated Git worktree                                         | A worktree isolates repository changes, not the entire operating system                          |
| Finished | The provider completed its process/turn                                            | Does not mean builds, tests, physics, or visual behavior passed                                  |

The first version limits writer concurrency and never silently merges competing changes. Existing worktrees are retained for inspection and follow-up work. Cancellation stops the running worker; it does not roll back edits already made.

If worker termination cannot be confirmed, Nova reports a failure and locks further Build tasks for that project, including after restart. Do not simply retry the task: inspect and stop any remaining CLI processes first. This milestone has no automatic recovery/unlock UI. After confirming cleanup, close Nova, back up `workspace.json`, and deliberately clear the affected run's `terminationUnconfirmed` flag before restarting. Do not clear the flag while a worker may still be editing files.

Unsupported safety capabilities must fail with an actionable error rather than falling back to an unrestricted invocation. Nova does not use permission-bypass or no-sandbox modes. Inherited hooks, plugins, and MCP integrations are deliberately not part of this initial adapter contract; explicit integration management is a later milestone.

In particular, the Codex adapter ignores ordinary user configuration rather than inheriting custom profiles, hooks, or trusted project settings; normal CLI authentication remains separate. Managed/system policy can still apply. Claude's adapter requires its safe/restricted CLI capabilities and limits built-in tools; this is not an operating-system sandbox. An older installed CLI may need an update before Nova will run it.

Worktree creation deliberately avoids running repository hooks or checkout filters. Projects using Git LFS or other smudge filters can therefore contain pointer files instead of materialized assets. Check those requirements before attempting an Unreal or BeamNG build; a worktree existing is not proof that all large assets are present.

## Local data and privacy

Application state is written atomically to `workspace/workspace.json` under Electron's per-user application-data directory. On a typical Windows installation the file is `%APPDATA%\Nova Workbench\workspace\workspace.json`, and worktrees are kept in the neighboring `workspace\worktrees\<thread-id>` directories. Electron or operating-system configuration can change the base location.

- Projects, runs, messages, memory entries, and settings are stored locally in plaintext. This is not an encrypted secrets vault.
- Do not put API keys, passwords, or other secrets in project memory.
- A cloud provider receives the prompt and context passed to it and any project content its tools read. Local persistence does not make cloud execution private or offline.
- The Local adapter uses a local model through Codex/Ollama; it is not a blanket guarantee that every external tool or provider configuration is offline.
- No project-memory export to the repository is automatic. Memory is separate from Codex's own internal memory store.
- Provider credentials remain with the official provider tooling. Nova does not copy, exchange, or share authentication between providers.

Only use trusted repositories and executables. A malicious project can influence an agent through its contents; context delimiters and worktrees are not a complete prompt-injection defense.

## Development and checks

This folder is intentionally a self-contained npm application. The upstream Rust workspace and its pnpm packages remain separate; run these commands **inside `desktop/`**.

```powershell
npm run typecheck
npm test
npm run build
# Or all three:
npm run check
```

Tests use temporary repositories and fake provider processes. They should not require a live model request, a cloud API key, or paid inference. Passing them validates the application plumbing, not the quality of a provider's generated code.

Run browser interaction tests separately:

```powershell
npx playwright install chromium
npm run test:ui
```

Playwright starts the renderer development server when needed. These checks exercise the interface and explicit browser-preview behavior, not native Electron privileges or a live model. The `Nova Workbench` GitHub Actions workflow runs typechecking, unit/integration tests, and production builds on Linux and Windows; browser interaction checks run on Linux, and unsigned installer packaging runs on Windows. Inspect the actual workflow result before treating either platform as validated.

For renderer-only development:

```powershell
npm run dev:ui
```

Open the local address printed by Vite. Browser-only preview has no native filesystem or agent execution. `?demo=1` provides clearly labeled illustrative data for visual inspection; it is not a real agent run or proof that a provider is available.

### Source layout

| Path                  | Responsibility                                                    |
| --------------------- | ----------------------------------------------------------------- |
| `src/renderer/`       | React desktop workflow, safe text rendering, browser-only preview |
| `src/shared/types.ts` | Shared data model and narrow renderer/main API contract           |
| `src/main/main.ts`    | Electron lifecycle, native dialogs, validated IPC, app protocol   |
| `src/main/preload.ts` | Explicitly exposed bridge methods; no raw Node or IPC access      |
| `src/main/services/`  | State, context, provider processes, Git/worktree operations       |
| `test/`               | Deterministic unit and integration checks                         |
| `scripts/`            | Local build and development launch                                |

## Build a Windows package

On a Windows development machine:

```powershell
npm ci
npm run check
npm run pack:win
```

The package configuration targets **Windows x64 NSIS installer and portable executable**, written to `release/`. The build copies the repository's license and notices into the package. These commands do not publish a release.

The initial package is unsigned. A public release still needs a Windows-native smoke test, code signing, installer/uninstaller verification, dependency review, and a tested update channel. Do not interpret packaging configuration as evidence that a signed installer has been built or tested.

### First-version validation checklist

- [ ] Install or launch the application on Windows and confirm the native folder picker and window controls work.
- [ ] Detect each intended provider; confirm an unsupported CLI reports an error without a weaker fallback.
- [ ] Run Plan against a disposable repository, then confirm Build creates a separate worktree and leaves the original checkout unchanged.
- [ ] Cancel an active task and verify its worker exits while existing changes remain reviewable.
- [ ] Restart the app and verify projects, conversations, and memory persist; interrupted tasks must not appear active.
- [ ] Review actual diffs and run the project's own checks before manually integrating anything.

This checklist is intentionally separate from automated test results. Provider compatibility and Windows-native behavior need observed evidence on the machine where the application will run.

## Scope and licensing

Nova Workbench is maintained in this fork under the repository's Apache-2.0 license. Preserve the root `LICENSE` and `NOTICE`; third-party packages and separately installed CLIs have their own licenses and terms. Codex, Claude, OpenAI, and Anthropic names identify compatible tools, not sponsorship or affiliation.

Useful upstream references:

- [Codex source and build documentation](https://github.com/openai/codex)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code legal and compliance guidance](https://code.claude.com/docs/en/legal-and-compliance)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
