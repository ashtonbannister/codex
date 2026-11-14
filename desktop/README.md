# Nova Workbench

A Windows-first, multi-provider development workbench built alongside the open-source Codex engine.

Nova uses the familiar **projects → conversation → changes** workflow of Codex and Claude Code, with its own interface and branding. It is an independent project, not an official OpenAI or Anthropic desktop application, and does not contain either company's proprietary desktop UI.

**Status: development alpha, version 0.5.4.** Nova's Codex runtime and account now live in its own application-data folder. OEM Codex folders are read-only import sources, never active runtime homes. Existing conversations and selected references can be copied into independent Nova state; native source resume/fork/publishing has been removed. Codex/Claude sign-in, local-server connections, isolated builds, Git review/integration, checks, recovery, and conversation export remain available. This is **not full proprietary Codex/Claude desktop parity**. Live account/inference compatibility and the reported OEM Windows slowdown need real-machine acceptance checks; synthetic tests do not establish a measured FPS fix. A finished agent process is explicitly **not** a verified engineering result.

Version 0.5.4 preserves the v0.5.3 no-project draft, agent/model selection, New thread project-opening, and Recovery navigation fixes. Opening Nova, Settings, or Codex Library does not read the OEM source. Choose **Read import source** to start a bounded read-only import session. There are no OEM source workers, watchers, automatic freshness reads, source locks, or writebacks. Existing cleanup records remain visible; Nova neither kills OEM processes nor silently clears old recovery uncertainty.

This replaces the v0.5.1/v0.5.2 shared-home compatibility path. Nova no longer tries to make an OEM `config.toml` usable by launching an engine in that folder. Its own restricted runtime can still reject an incompatible installed CLI or managed policy with an explicit error.

## What's in this milestone

- Project and thread navigation, a conversation composer, and Changes, Context, Memory, Checks, and Activity inspectors.
- Manual provider selection: Codex, Claude Code, or a model served by Ollama, LM Studio, or a compatible custom loopback endpoint through the Codex agent engine.
- Plan mode and explicitly confirmed Build mode in a separate Git worktree.
- Streaming agent messages and tool activity, failure states, cancellation, and runtime/output limits.
- Persistent local projects, conversations, settings, and user-authored project memories.
- Shared, bounded project-memory and conversation context when changing providers.
- Worktree diffs, reviewed commits, and separately confirmed fast-forward-only integration into the original checkout; no automatic merging, pushing, or deleting worktrees.
- A narrow Electron bridge, isolated renderer, and Windows packaging configuration.
- Thread rename, pin, archive, and restore without deleting conversations or worktrees.
- Inspectable context packs with inclusion/omission reasons and optional file-linked memory fingerprints.
- Saved verification command profiles with explicit native confirmation, bounded output, cancellation, and source-revision evidence.
- A gated, read-only Codex library with active/archived JSONL conversation browsing, visible-history previews, and explicit bounded copies into Nova.
- The same independent visible-history handoff for Codex, Claude, and local models; no source-native resume, fork, or publishing back to OEM Codex.
- Selective Markdown memory, instructions, skill-reference, and plan import with source fingerprints as provenance; originals are not automatically reread.
- Configurable read-only Codex import source and storage for new Nova worktrees; Nova's private Codex runtime is separate and fixed under its own data directory.
- Tabbed Settings with native CLI executable selection and local model discovery, without downloading models or starting inference during discovery.
- User-confirmed recovery acknowledgement that preserves the original unconfirmed-termination history.
- Explicit Markdown export of visible conversation text and active project memory, plus device-local per-thread composer drafts.
- Codex and Claude Code account status and official browser sign-in from Settings, with cancellation, bounded process lifetimes, and no credential import.
- Explicit **Copy latest from Codex** reads a source conversation again without changing it or starting inference; Nova runs and notes remain separate.
- Previewed publishing of `.nova/MEMORY.md` and references in `AGENTS.md`/`CLAUDE.md`, with opt-in fresh reads for subsequent Nova requests and preservation of text outside Nova-managed blocks.

The current [feature coverage](docs/feature-coverage.md) distinguishes shipped workflows, native-engine delegation, and missing features. The larger roadmap is in [PLAN.md](PLAN.md); the implemented interface conventions are recorded in [DESIGN.md](DESIGN.md). Automatic model routing, unattended agent teams, automatic knowledge extraction, repository-wide symbol indexing, a general MCP manager, and semantic Unreal/BeamNG validation are **not implemented**. The checks establish which command ran against which source, not whether every engineering requirement is correct.

## Run on Windows

### Prerequisites

1. Windows with [Node.js](https://nodejs.org/) **24.22.1 or newer** and [Git](https://git-scm.com/downloads/win).
2. At least one supported provider installed separately:
   - [Codex CLI](https://github.com/openai/codex), for OpenAI-hosted models.
   - [Claude Code](https://code.claude.com/docs/en/setup), for Claude.
   - Codex CLI plus an already-running Ollama, LM Studio, or compatible local API server, for local models. See the protocol limits below.
3. Use **Settings → Agents → Provider accounts** to sign in to Nova's separate Codex runtime or the installed Claude Code account. Your OEM Codex sign-in is not reused or copied. Nova does not host a password form, read provider credential files, or import credentials.

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

Settings is organized into **General**, **Agents**, **Local models**, **Storage**, and **Recovery**. If provider discovery fails, use **Agents → Browse** to select the installed native executable. Supported JavaScript CLI entry points use the configured Node runtime; arbitrary `.cmd`/`.bat` wrappers are not interpreted. A command containing shell operators is not a supported configuration. Nova intentionally does not use a shell to interpolate prompts or launch arbitrary renderer-supplied commands.

After installing or updating a CLI, use **Refresh agent availability** to rerun capability detection. Saving Settings also refreshes detection. Routine conversation updates use cached results; they do not repeatedly launch the CLIs.

### Sign in to Codex or Claude Code

1. Save any executable changes, then open **Settings → Agents**. **Check status** reads account metadata through the installed tool; CLI availability and signed-in status are separate checks. Changing the import source does not change your runtime account.
2. Choose **Sign in** for the intended provider. Codex needs a one-time sign-in to Nova's independent runtime even if the OEM app is already signed in. Finish Nova agent work first; Claude Code sign-in additionally requires other Claude Code workers to be idle because its CLI account remains shared.
3. Complete the official browser flow while Nova stays open. Progress and **Cancel sign-in** remain available. Nova confirms the account through the official tool before reporting completion.
4. After completion, select the provider in the composer. Account status alone does not establish model entitlement, remaining usage, or a successful model request.

Codex uses the official app-server's supported ChatGPT login and account-status methods only in Nova's app-owned `workspace/codex-runtime` home. Its file credential store, database, logs, and sessions are separate from OEM Codex. Nova does not copy OEM tokens or sign the OEM app out. Claude uses the official `claude auth login` and JSON `claude auth status` commands under safe mode; that CLI owns its normal credential location and browser flow. **Claude Code login is not a login to Claude Desktop**, and neither provider receives the other's tokens. Organizational or unsupported interactive flows fail visibly; Nova does not bypass them.

Status checks and login start no model turn. Workspace/provider mutations are blocked while an account operation is active, including while browser sign-in is pending. Cancel the flow before changing configuration. If process cleanup cannot be confirmed, Settings → Recovery retains an account-worker lock until you inspect and stop the affected processes and explicitly acknowledge cleanup.

### First task

1. Choose **Open project** and select a local Git repository.
2. Choose a provider. For Local, start the server separately, configure its backend/URL/protocol in Settings, then discover and select an available model.
3. Start in **Plan** mode to inspect or discuss the project.
4. Add relevant constraints or decisions in **Memory**. Include a source that another agent or human can check.
5. Choose **Build** when you want file changes. The first build needs a clean Git baseline; Nova creates an isolated worktree for the thread and asks for confirmation before execution.
6. Inspect **Changes** and run the project's real verification steps. Commit reviewed changes when ready; bringing that commit into the original checkout is a separate, explicit fast-forward action.

Changing the provider within a thread passes a bounded transcript and selected project memories to the next worker. This is **not** a transfer of private reasoning, provider-native hidden state, or an unlimited conversation context. Providers retain their own model limits, account access, and billing rules.

### Connect a local model

In **Settings → Local models**, choose the backend, API base URL, and protocol. Defaults are Ollama at `http://127.0.0.1:11434/v1`, LM Studio at `http://127.0.0.1:1234/v1`, or a custom server at `http://127.0.0.1:8080/v1`. Use the protocol actually supported by the installed server; choosing its brand is not proof of compatibility.

**Discover models** requests metadata only: Ollama's `/api/tags`, or the other backends' `/models` endpoint. Nova checks the selected model against that catalog before execution. It does not download, load, or run a model during discovery, and excludes model entries identified as remote/cloud. A catalog entry alone does not establish that a model is loaded, supports tools, or has enough context for the task.

| Selected protocol | Execution path and limits |
| ----------------- | ------------------------- |
| Responses | The Codex harness connects directly to the selected local server's Responses API. Actual server/model compatibility remains its responsibility. |
| Chat completions | A bounded, per-run loopback bridge translates full-context Responses requests into streaming Chat Completions, including text and function/custom-text tool calls. It requires streaming tool-capable output; it is not a complete Responses implementation. |

The Chat Completions bridge rejects images/audio/attachments, encrypted or nonportable reasoning state, provider-native response IDs, background jobs, hosted tools/tool search, and structured response formats. Custom text tools are represented as function calls; grammar guidance does not give a local model native grammar-constrained decoding. The bridge is limited to 16 MiB request bodies, 256 tools, a bounded response stream, and a maximum ten-minute upstream request; normal worker limits still apply. Its generated authorization token exists only for that worker and is not saved in Settings.

Endpoints must use loopback (`127.0.0.1`, `localhost`, or `[::1]`) without embedded credentials, query, or fragment. Discovery and bridged requests refuse redirects; authenticated local servers are not supported by this adapter. There is no hosted-model fallback. A loopback server can itself forward requests elsewhere, so connect only a server you trust. A Strata or other custom endpoint is usable only if it meets this contract; Nova has not live-tested or certified every local runtime.

### Import copies from an existing Codex installation

1. In Settings → Storage, leave **Codex import source** blank for the existing default `.codex` source, or choose an existing source folder. Do not select `auth.json` or a database file. This setting is never an engine working home.
2. Open **Codex library**. Nothing is scanned yet; agent/model selection and normal navigation remain usable.
3. Choose **Read import source** and review the native read-only confirmation. Nova reads supported uncompressed JSONL conversation files and allowlisted reference text; it does not start Codex, open databases, watch the source, or modify any source files. Reading imports does not require a running or authenticated Codex engine.
4. Browse active or archived conversations, inspect the visible messages, then choose **Open in Nova**. A new copy lives under Nova's `workspace/imported-conversations` folder. The recorded original working folder is not opened or adopted; these independent folders support Plan. Open a Git project separately for Build.
5. Select Codex, Claude, or local: every provider receives a bounded visible copy and selected Nova references, not the OEM native session, account, private reasoning, or binary attachments.
6. Preview selected references before importing them into a project. Imported skills are reference text, not installed or automatically executed tools.

For an imported conversation, use **Copy latest from Codex** after the source changes. This explicitly reads another bounded snapshot and preserves Nova's recorded runs and memory. Active source writes can make a read fail or incomplete; wait for that conversation to settle before retrying. Nothing is written back, resumed, forked, migrated, or unarchived.

**Publish handoff to Codex has been removed and its IPC endpoint rejects calls.** Use Markdown export when you want to copy Nova text elsewhere. Old native IDs are retained only as provenance. Unsupported, compressed, or engine-only histories may not be available to the read-only importer; Nova reports limits instead of starting an OEM engine or falling back to database access.

See [Codex compatibility and storage boundaries](docs/codex-compatibility.md) for exact folder handling, conversation lifecycle, limits, and recovery behavior. This is an integration with the open-source engine, not a clone of every proprietary desktop feature.

### Share project memory with the official tools

1. Add or review project notes in **Memory**, then choose **Preview shared memory files** under **Use memory in the official apps**.
2. Review the complete before/after text for `.nova/MEMORY.md`, `AGENTS.md`, and `CLAUDE.md`. Stale, missing, or unavailable source-linked notes are omitted with a warning. Existing text outside Nova's managed blocks is preserved.
3. Choose **Publish reviewed memory…** and confirm the exact project files in the native dialog. A changed preview or ambiguous file/link state requires a fresh review; it is not silently overwritten.
4. Review and commit these ordinary project-file changes yourself before a new isolated Build. No automatic commit occurs, Build requires a clean baseline, and a new worktree inherits only committed files.

Publishing opts that project into fresh shared-file reads for later Nova Codex, Claude, and local-model context. Official Codex follows the project's `AGENTS.md` reference; Claude Code follows its `CLAUDE.md` import. Put durable notes written by other tools **outside the Nova-managed notes block** so a later explicit publish preserves them. Nested instruction overrides, selected worktree contents, and each model's context limits still apply.

Publishing is manual, not background synchronization or automatic extraction of memories from every conversation. Nova's private note store and the providers' private memory databases remain separate. **Disable Nova shared-file reads** stops Nova's automatic inclusion, but does not delete shared files or remove instructions that the official tools can still read. Review/remove those project references separately if you want to stop that sharing too. Never put credentials in these files; included context can be sent to your selected cloud provider.

### Inspect context and organize ongoing work

Use the Context inspector before sending a request to see the bounded prompt, included/omitted memories, history selection, and warnings. The token figure is a character-based estimate, not the provider's tokenizer, bill, or context-window limit. Previewing never launches a model or creates a worktree. Before a thread's first Build, its preview is explicitly provisional: it inspects the original checkout, while the new worktree can lack ignored files or have different checkout bytes. A later run rebuilds context against its actual working files at launch; the preview is not a frozen promise that external edits cannot change it.

Memory entries may link to a project-relative file. Saving records the file's digest from the **original project checkout**, not an automatic copy of its contents. Before context selection, Nova compares that digest against the selected worktree or project. Changed, missing, or unreadable linked sources are omitted with a reason. Reviewing and saving again reconfirms the original checkout's bytes; it does not endorse different worktree bytes. A memory whose source differs only in a Build worktree remains omitted until the source is deliberately reconciled and the note reviewed. Worktree-only files cannot yet be used as memory sources. Unlinked user notes remain usable but are not source-verified. **Matching source bytes are not proof that a note is factually correct.**

Pin important threads, rename them, or archive completed conversations. Archiving preserves history and the worktree; active work must finish or be cancelled first. Restore an archived thread to continue it.

Composer text, provider, model, and mode are retained locally for each thread and each project's unsent new task. Drafts are bounded to 40 recent entries, 32,000 prompt characters each, and an approximately 256,000-character serialized budget; older entries can be evicted. They are not synchronized to providers or included in conversation exports. They use plaintext renderer storage, not an encrypted vault; a storage failure displays a warning.

Choose **Export Markdown** from the thread toolbar/menu to save the retained visible conversation and active project memories through a native Save dialog. This exports only Nova's retained imported history and visible user/assistant messages—not all native Codex history, configuration, credentials, raw tool/error logs, or private reasoning. Active memory includes user notes that may be stale or unverified; export does not certify them. Common credential patterns are redacted, but private details or unrecognized secrets can remain in visible text. Review the file before sharing. Exports over 8 MiB fail instead of silently producing a partial file.

### Run an explicit check

1. Select a thread with an existing Build worktree. Checks never execute in the original project checkout.
2. In Checks, save a profile with a name, executable, exact argument array, and timeout. The npm presets are editable suggestions; saving does not execute them.
3. Choose Run check and inspect the native confirmation's program, arguments, and working directory.
4. Review output, exit status, and input/output source fingerprints. A result is current only for the source snapshot it actually tested.

Verification commands run as your own user account, **outside the agent sandbox**. They can execute project scripts, modify files, or access the network. Only approve trusted programs and repositories. Nova passes an explicit argument array without implicit shell interpolation. Windows npm is resolved through its known JavaScript entry point; arbitrary `.cmd`/`.bat` shims are not interpreted. A script needing a shell must use an explicitly configured interpreter whose arguments are visible in the confirmation.

The source fingerprint covers tracked and Git-unignored files, including binary content and symlink metadata, within bounded size/time limits. Git-ignored dependencies, generated outputs, external symlink targets, the broader machine environment, and network services are outside that fingerprint. Oversized, unstable, unreadable, or unsupported source snapshots cannot earn a current passing result. If the source changes while the command runs, the result is stale even when the command exits zero. Passing one profile is not a blanket "task verified" state.

### Review, commit, and integrate changes

1. Finish or cancel active workers and checks. In **Changes**, review the worktree branch, HEAD, changed paths, and original target branch. An incomplete or unstable source fingerprint cannot be approved.
2. Enter a commit message and choose **Commit changes**. The native confirmation is tied to the reviewed revision and file bytes. Nova rechecks them before committing; changed inputs require a fresh review. The commit remains on the Nova-owned thread branch, leaving the original checkout untouched.
3. After reviewing the committed result and relevant check evidence, choose the separate fast-forward integration action. Both checkouts must be clean, the original branch must still match the reviewed target, and its HEAD must be an ancestor of the source commit.

Git actions suppress repository hooks, signing helpers, and clean/smudge filters. Commits include reviewed staged changes and Git-unignored worktree changes; suspicious untracked credential filenames are refused. Ignored dependencies/outputs are not automatically added. Integration refuses divergence, dirty files, ignored-file collisions, recovery locks, and stale branch/revision evidence instead of resetting, stashing, resolving conflicts, or creating a merge commit. No action pushes to a remote or removes the worktree. Git identity must already be configured. Stop external editors/agents that may write during these actions; Nova's queue does not lock every other application.

A successful command check is evidence for its recorded snapshot, not an automatic integration approval. If Git succeeds but saving Nova state fails, the error reports the preserved Git result; Nova does not undo a real commit or fast-forward to hide a persistence failure.

## Plan versus Build

| Mode     | Intended behavior                                                                  | Important boundary                                                                               |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Plan     | Read and analyze the selected project using the adapter's restricted configuration | Permission enforcement belongs to the configured provider runtime; review its support and errors |
| Build    | Work in the thread's isolated Git worktree                                         | A worktree isolates repository changes, not the entire operating system                          |
| Finished | The provider completed its process/turn                                            | Does not mean builds, tests, physics, or visual behavior passed                                  |

The first version limits writer concurrency and never silently merges competing changes. Existing worktrees are retained for inspection and follow-up work. Cancellation stops the running worker; it does not roll back edits already made.

Process cleanup tracks owned process groups on POSIX and observable process ancestry on Windows. Windows cleanup uses the built-in PowerShell/CIM tools to inspect process IDs, parent IDs, and creation times, not command lines or credentials; unavailable inspection is reported as unconfirmed cleanup. This is lifecycle management, not full operating-system containment. Deliberately detached processes or Windows ancestry lost through already-exited intermediate parents require stronger isolation, such as Windows Job Objects, which this version does not implement.

If worker termination cannot be confirmed, Nova reports a failure and locks further Build/check/Git actions for that project, including after restart. Inspect and stop only the affected Nova-owned workers and children before using **Settings → Recovery**. Acknowledgement records **your confirmation**, not a successful new operating-system process inspection; active work and changed recovery records are still guarded. The original unconfirmed-termination history stays intact with acknowledgement metadata. Legacy Codex-home records from older shared-home versions remain warnings, but no longer block read-only import or Nova's separate runtime. They are not auto-cleared, and the update does not locate or kill already-running OEM processes. Never clear a record while its old Nova worker may still be editing files, or modify OEM databases to recover Nova.

Unsupported safety capabilities must fail with an actionable error rather than falling back to an unrestricted invocation. Nova does not use permission-bypass or no-sandbox modes. Inherited hooks, plugins, and MCP integrations are deliberately not part of this initial adapter contract; explicit integration management is a later milestone.

Codex and Local workers use Nova's fixed private runtime home with isolated database/log/session locations and restrictive configuration. Inherited Codex home/session/remote-control and credential overrides are not allowed to redirect those workers into OEM state. Runtime paths are checked for redirection before launch. The official app-server is retained for Nova's own account operations, never for browsing the OEM source; unsupported restrictions or managed-policy conflicts fail visibly. Raw configuration is not returned to the renderer or shared with another provider. Claude's adapter requires safe/restricted CLI capabilities and limits built-in tools; this is not an operating-system sandbox. An older installed CLI may need an update before Nova will run it.

Worktree creation deliberately avoids running repository hooks or checkout filters. Projects using Git LFS or other smudge filters can therefore contain pointer files instead of materialized assets. Check those requirements before attempting an Unreal or BeamNG build; a worktree existing is not proof that all large assets are present.

## Local data and privacy

Application state is written atomically to `workspace/workspace.json` under Electron's per-user application-data directory. On a typical Windows installation the file is `%APPDATA%\Nova Workbench\workspace\workspace.json`, and worktrees are kept in the neighboring `workspace\worktrees\<thread-id>` directories. An optional **new worktree storage** folder changes the base for future worktrees, which remain under `<selected-base>\worktrees\<thread-id>`. Existing threads retain their original canonical storage base. Electron or operating-system configuration can change the default location.

Nova's Codex runtime lives in `workspace\codex-runtime`; independent conversation-copy folders live in `workspace\imported-conversations`. Both are separate from the configured read-only OEM import source. Changing the import source neither moves Nova's runtime nor changes its account. Imported threads from older versions retain their text/provenance, but their future execution is detached from native source sessions and recorded source working directories.

- Projects, runs, messages, memory entries, and settings are stored locally in plaintext. This is not an encrypted secrets vault.
- Verification commands, arguments, and output are also stored locally. Commands can print sensitive data; review what a check emits before sharing logs.
- Do not put API keys, passwords, or other secrets in project memory.
- A cloud provider receives the prompt and context passed to it and any project content its tools read. Local persistence does not make cloud execution private or offline.
- The Local adapter uses the Codex harness and a configured loopback server; it is not a blanket guarantee that every external tool or local server is offline.
- No project-memory export to the repository is automatic. An explicitly reviewed publish writes ordinary project files and enables opt-in shared-project-file reads in Nova; it does not synchronize private Codex/Claude memory databases. Imported Codex references are independent copies with provenance, not live source links. Re-import explicitly to refresh them.
- Provider credentials remain with official tooling. Codex credentials are stored by that tool in Nova's own home; OEM credentials are not reused, copied, exchanged, or shared with other providers.
- Composer drafts are separate plaintext device-local storage. An explicit Markdown export creates a plaintext file at your chosen destination; it is not a complete native-history backup or a guaranteed secrets scrubber.

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

Tests use temporary repositories and fake provider processes. Backend test files run serially so concurrent test-created Windows process trees do not contend for bounded CIM inventory checks or race PID reuse. They should not require a live model request, a cloud API key, or paid inference. Passing them validates the application plumbing, not the quality of a provider's generated code. Legacy version-1 workspace files are read with defaults for the new optional metadata and check collections; no existing history is intentionally discarded.

Run browser interaction tests separately:

```powershell
npx playwright install chromium
npm run test:ui
```

Playwright starts the renderer development server when needed. These checks exercise the interface and explicit browser-preview behavior, not native Electron privileges or a live model. The `Nova Workbench` GitHub Actions workflow runs typechecking, unit/integration tests, and production builds on Linux and Windows; browser interaction checks and review screenshots run on Linux. Windows additionally runs a native Electron startup/preload/IPC/restart smoke test before unsigned installer packaging. Inspect the actual workflow result before treating either platform as validated.

After `npm run build`, `npm run test:electron` runs that native smoke test using an isolated temporary user-data directory and synthetic Codex source. It accepts only the synthetic read-source confirmation, tests bounded conversation/reference reads and rejection of native publishing, and checks that the source bytes remain unchanged. It does not sign in, open a real history server, choose a project, run inference, or execute a saved command profile. It tests the compiled development application, not installer installation/uninstallation, the reported OEM FPS problem, or every Windows sandbox capability.

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
npm run test:electron
npx --no-install electron-builder --win --x64 --publish never
```

`npm run check` builds once; the final command packages those exact built assets without rebuilding. If the build has already been checked, use just the packaging command. The package configuration targets **Windows x64 NSIS installer and portable executable**, written to `release/`, including `Nova-Workbench-0.5.4-x64-portable.exe`. The build copies the repository's license and notices into the package. These commands do not publish a release.

The initial package is unsigned. A public release still needs a Windows-native smoke test, code signing, installer/uninstaller verification, dependency review, and a tested update channel. Do not interpret packaging configuration as evidence that a signed installer has been built or tested.

### First-version validation checklist

- [ ] Install or launch the application on Windows and confirm the native folder picker and window controls work.
- [ ] Detect each intended provider; confirm an unsupported CLI reports an error without a weaker fallback.
- [ ] Check and complete official Codex/Claude Code sign-in, then cancel a pending sign-in; confirm no credentials appear in Nova state or transcript exports.
- [ ] Leave OEM Codex open, launch Nova, and verify there is no source read until **Read import source** and no observed OEM performance regression. Do not treat a synthetic import test as an FPS measurement.
- [ ] Import and explicitly copy latest from a disposable Codex source; confirm the original files are unchanged, the source working folder is not adopted, and every provider starts from the Nova copy rather than resuming/forking a source session.
- [ ] Review/publish shared project memory, edit a note outside its managed block, confirm a later context request reads the change, and exercise disabling Nova reads without deleting files.
- [ ] Run Plan against a disposable repository, then confirm Build creates a separate worktree and leaves the original checkout unchanged.
- [ ] Cancel an active task and verify its worker exits while existing changes remain reviewable.
- [ ] Restart the app and verify projects, conversations, and memory persist; interrupted tasks must not appear active.
- [ ] Discover the intended local server's models, then confirm its selected Responses or streaming Chat Completions protocol can complete a real tool-using task.
- [ ] Review actual diffs, run the project's own checks, commit, and explicitly fast-forward a disposable original checkout; confirm dirty/divergent targets remain untouched.
- [ ] Exercise Recovery only after independently stopping remaining workers; verify the uncertainty record survives acknowledgement and restart.
- [ ] Confirm draft persistence and review a Markdown export for expected visible content and private details before sharing it.

This checklist is intentionally separate from automated test results. Provider compatibility and Windows-native behavior need observed evidence on the machine where the application will run.

## Scope and licensing

Nova Workbench is maintained in this fork under the repository's Apache-2.0 license. Preserve the root `LICENSE` and `NOTICE`; third-party packages and separately installed CLIs have their own licenses and terms. Codex, Claude, OpenAI, and Anthropic names identify compatible tools, not sponsorship or affiliation.

Useful upstream references:

- [Codex source and build documentation](https://github.com/openai/codex)
- [Codex app-server protocol, including account and thread methods](https://learn.chatgpt.com/docs/app-server)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code project memory and instruction files](https://code.claude.com/docs/en/memory)
- [Claude Code legal and compliance guidance](https://code.claude.com/docs/en/legal-and-compliance)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
