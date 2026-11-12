# Existing Codex integration

Version 0.3 connects Nova Workbench to a separately installed Codex engine and selected local reference files. It does not replace Codex's private desktop databases or promise that all desktop features can be used by other providers.

## Folder ownership

| Location or category                                                                                  | Nova behavior                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODEX_HOME`, or `%USERPROFILE%\.codex`                                                               | Resolve the existing directory; an explicit Settings override takes precedence. No automatic creation or wholesale migration.                              |
| Windows Documents `Codex` output folder                                                               | Use Electron's Windows Documents location, then resolve existing redirects/junctions. The app does not assume Documents is still on C:.                    |
| `sessions`, `archived_sessions`, thread/state databases and indexes                                   | List/read/resume/fork through the installed app-server. Nova never edits SQLite or rewrites raw session files.                                             |
| `.codex\worktrees` and `visualizations`                                                               | Show resolved locations. Existing engine-owned worktrees are not adopted, moved, merged, or deleted. Linked threads retain their source working directory. |
| `memories`, `memories_v2`                                                                             | Preview allowlisted Markdown memory summaries and skill references; import selected text into a Nova project with a digest.                                |
| `AGENTS.md`, `MODEL_BENCHMARKS.md`, `skills`, `plans`                                                 | Preview/import allowed Markdown as project reference text. Import does not install a plugin, execute scripts, or grant tool permissions.                   |
| Attachments and generated images                                                                      | Inventory only. Binary attachments are not included in Claude/local transcript handoffs.                                                                   |
| `config.toml`, rules, automations, queues, goals, plugins, caches, runtimes, and process state        | Engine-managed inventory. No direct migrations, queue adoption, automatic execution, or cross-provider synchronization.                                    |
| `auth.json`, browser/app web data, sandbox secrets, private voice/runtime state, Windows package data | Excluded as shared-context sources. Credentials and private app state are not imported.                                                                    |
| SQLite `-wal`/`-shm`, locks, and migration markers                                                    | Leave ownership to Codex. Do not copy a live database plus arbitrary sidecars and call it a consistent backup.                                             |

Presence in the location inventory does not establish a file's schema or enable a corresponding Nova feature. The supplied inventory includes version-specific and inferred names; the installed engine is authoritative for its own history contract. Package discovery only enumerates matching immediate Windows package names; it does not inspect their contents.

Conversation discovery includes the protocol's CLI, VS Code/desktop, exec, app-server, and unknown top-level source kinds for the current account. It does not aggregate other accounts or subagent-only histories. A custom source kind that the installed protocol cannot filter is not silently represented as a complete library.

The default Nova state stays in its own Electron user-data directory. An optional new-worktree storage base creates future directories under `<base>\worktrees\<thread-id>`; it does not change `CODEX_HOME`, move existing Nova worktrees, or commandeer Codex-managed worktrees. Choose a dedicated folder, for example `E:\NovaWorkspaces`, rather than expecting Nova to relocate the installed engine's data.

## Conversation lifecycle

1. **Browse:** native confirmation identifies the executable and canonical home. Nova starts a bounded stdio app-server, initializes it, and requests thread metadata/history. No `turn/start` is issued by browsing or importing. Engine startup can still manage its own logs, authentication, or migrations, so this is not an immutable filesystem scan.
2. **Preview:** active/archived queries remain separate; cursors load additional threads and older visible messages. Imported messages contain user/assistant text only, not reasoning or raw tool logs. Pages are displayed chronologically, and older pages prepend to the preview.
3. **Open in Nova:** a canonical-home/source-thread identity prevents duplicate imports. A bounded latest visible-history snapshot is persisted separately from actual Nova Runs. The source working directory is retained even when its project is mapped to a containing Git repository. Non-Git folders are supported for Plan only.
4. **Native Codex Plan:** initially continue the original at its original working directory, unless it was archived. Archived originals are forked and left archived. A native continuation can append conversation turns through Codex; it is not a read-only history import.
5. **Native Codex Build:** create/use the thread's isolated Nova Git worktree, fork native history to that working directory, persist the returned fork ID before starting a model turn, and reuse that fork on follow-ups. A Plan fork still tied to the original folder is forked again when moving to the managed Build worktree. No automatic merge or unarchive.
6. **Claude/local handoff:** use the same Nova thread/project/worktree with a bounded selection of visible imported messages, recent Nova turns, and project references. The first handoff to each provider in an app session asks for native confirmation. This is shared task context, not equivalent hidden state or guaranteed identical model behavior.

The Context inspector shows Nova's selected reference prompt and omissions. A native Codex continuation also has Codex-managed native history that is not fully represented by Nova's character-based context estimate. Provider limits and native compaction remain the provider's responsibility.

Source files can change outside Nova, and another official Codex client may also use the original conversation. Stop competing writers before continuing important work. Nova's own project/run serialization does not lock every external application.

## Bounded references and history

- Resource sections are `memories`, `memories_v2`, `instructions`, `skills`, and `plans`.
- Instructions allow only top-level `AGENTS.md` and `MODEL_BENCHMARKS.md`.
- Memory sections allow `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, immediate Markdown files in `rollout_summaries`, and `SKILL.md` under their `skills` directory.
- The skills section allows `SKILL.md`; plans allow Markdown files. Scripts, JSON, config, databases, dot paths, absolute paths, traversal, Windows alternate data streams, and arbitrary nested links are rejected.
- An explicitly selected top-level section junction may point to another drive. Descendant links are not followed. Preview checks canonical containment, regular-file identity, bounded size, UTF-8 text, and changes during reading.
- A reference preview reads at most 128 KiB. Listings are bounded to 500 resources, 5000 visited entries, and shallow recursion; warnings disclose incomplete/skipped results.
- Import saves up to 8000 characters with a full-source SHA-256 digest and provenance. It rechecks the preview digest after native confirmation. The original file is preserved.
- Context freshness rereads the allowed source. Changed, missing, or unreadable imported references are omitted until reviewed/re-imported. Editing a note converts it into a Nova-owned note instead of retaining a misleading original-source fingerprint.
- Native history pages and imported snapshots are bounded. “Older messages” can retrieve more preview pages; opening a thread does not promise to retain an unlimited transcript in Nova. The UI and context inspector disclose truncation.

Importing reference text makes it eligible as project context. It does not certify its factual accuracy or neutralize instructions inside it. Review private material before sending project context to Claude or another cloud provider.

## Runtime restrictions and failure handling

Native-history workers use the installed engine's supported configuration overrides. Unlike fresh `codex exec`, app-server has no `--ignore-user-config` switch. Nova internally reads effective MCP server **names only**, disables those servers individually before loading a native thread, disables inherited hooks/plugins/apps and unsolicited continuation paths using supported settings, and denies server-originated tool/approval requests. Raw config values and diagnostic stderr are not forwarded, logged, persisted, or included in shared context. Ordinary Codex-owned authentication is not transplanted into another provider.

Before starting the normal history server, a bounded one-shot startup-config preflight checks whether managed requirements would force an incompatible feature back on. Unsupported preflight or conflicting requirements fail explicitly, rather than pretending a CLI override defeats managed policy. Metadata startup and preflight both use owned-process cleanup; neither requests inference.

Requests have deadlines, bounded JSON/stdout/stderr, cancellation handling, and owned-process cleanup. Unknown/incompatible responses, unsupported required settings, and native provider mismatches fail explicitly. There is no silent cloud fallback or permission-bypass fallback. A source thread made under an incompatible native model provider is not silently converted into an OpenAI thread.

The fork identity is saved before `turn/start`. If that save fails or cancellation wins, no model turn should be issued. A failed/aborted run is not imported as a successful conversation turn.

If termination of a metadata app-server cannot be confirmed, Nova persists the canonical home in `codexRecoveryHomes` and blocks subsequent history operations/native continuation for that home, including after restart. Reference-only filesystem browsing remains available. If a native model worker cannot be confirmed stopped, existing run/project recovery locks also apply. This version has no automatic recovery/unlock UI. Confirm the owned process tree has stopped, close Nova, back up its `workspace.json`, and deliberately clear only the relevant recovery entry/flag; never clear it while an old worker could still be running. Do not modify Codex's databases to recover Nova.

## Validation and remaining real-machine checks

Automated coverage uses temporary Codex homes, fake stdio app-servers, disposable Git repositories, synthetic renderer bridges, and a native Electron smoke test. It performs no paid inference, user-account sign-in, or live Codex migration. Test results for a particular commit are in its GitHub Actions run.

Before using important projects on Windows, confirm the actual installed executable's protocol, E: junction/redirect resolution, native active/archived history, source-directory preservation, native fork persistence, and one explicit handoff with each intended provider. Packaging success does not substitute for these live compatibility checks. Keep ordinary backups of the original installation independently of Nova.
