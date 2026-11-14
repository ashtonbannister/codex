# Codex import and runtime boundaries — v0.5.4

Nova is an independent development-alpha workbench. Version 0.5.4 replaces the shared OEM-home integration with two separate paths: a private Nova Codex runtime and explicit read-only imports. It does not claim full proprietary desktop parity or that the reported OEM Windows FPS problem has been reproduced and measured. See [feature coverage](feature-coverage.md) for the implemented scope.

## Folder ownership

| Location | Nova behavior |
| --- | --- |
| Electron user data `workspace/codex-runtime` | Fixed private home for Codex/Local workers and Nova's Codex account. Credentials, state/database, logs, and sessions stay here. It is not the selected import source. |
| Existing `.codex` or explicitly selected import source | Read-only source. No workers, native session resume/fork, startup probes, watchers, migrations, source locks, or writeback. No automatic creation or wholesale copy. |
| Source `sessions` and `archived_sessions` | Explicit bounded reads of supported uncompressed rollout JSONL. Only visible user/assistant text is copied. Archive state is preserved. |
| Source `session_index.jsonl` | Optional bounded display-name read, not an authoritative database or runtime connection. |
| Source memory/instruction/skill/plan Markdown | Allowlisted preview and explicit text copy with source fingerprint as provenance. No background freshness reread. |
| Source `config.toml`, credentials, SQLite databases/sidecars, locks, private app/runtime data | Excluded from content imports and never used as Nova's runtime state. No repairs, migrations, or direct edits. |
| Source worktrees, generated media, queues, automations, goals, caches | Inventory only where supported. Not adopted, executed, synchronized, moved, or deleted. |
| `workspace/imported-conversations/<thread-id>` | New app-owned project folder for an independent imported conversation. The source's recorded working folder is only provenance and is not opened. |
| Nova Git worktrees | Managed separately for explicitly opened Git projects. Optional new-worktree storage applies only to new worktrees; OEM worktrees are not adopted. |
| Reviewed project `.nova/MEMORY.md`, `AGENTS.md`, `CLAUDE.md` | Optional project-file interchange after preview and explicit confirmation, not writes into a provider's private home or database. |

Opening Nova, Settings, or Codex Library does not read the OEM import source. The Library starts unloaded and requires **Read import source**. Selecting a new source resets that gate. Main-process confirmation identifies the source as read-only; it does not connect to a Codex engine. Location inventory does not establish schema compatibility or imply a supported feature.

Runtime directories are checked for redirection before worker launch. Inherited Codex-home, session, remote-control, database, and credential environment overrides cannot redirect an engine into the source. The ordinary system/managed restrictions are still enforced. This is separation of application state, not a claim that all worker code runs inside a complete operating-system sandbox.

## Account ownership and sign-in

**Settings → Agents → Provider accounts** separates executable availability from account state. Codex status and ChatGPT sign-in use the installed official app-server, but only against Nova's private runtime. The official tool stores that account using its file credential store under Nova's home. Sign in once for Nova even if the OEM app is already signed in. The import-source setting does not select an account, and Nova does not copy OEM tokens or sign the OEM app out.

Nova opens only approved official login URLs and exposes bounded account metadata. Credentials and raw authentication output are not sent to the renderer, transcripts, or another provider. Status/login does not start a model turn.

Claude Code retains its ordinary CLI-owned account and safe-mode `auth status`/`auth login` flow. Claude Desktop is a separate sign-in. Other Claude Code workers must be idle when changing that shared CLI account; Codex's OEM runtime does not share Nova's new account home. Provider subscriptions, model entitlements, usage limits, and billing remain separate.

Account work is owned and bounded. Main-process gating prevents conflicting Nova runs/checks/configuration changes while sign-in or status work is active. Pure explicit source reads do not start an engine and can remain available independently of that gate. Interrupted account workers retain recovery uncertainty rather than being silently marked stopped.

## Conversation lifecycle

1. **Read import source:** a deliberate Library action and native read-only confirmation permit bounded source listing. Nothing starts an OEM Codex process or opens its databases.
2. **Preview:** active and archived files remain separate. Conversation and history cursors are opaque. Pages display visible text chronologically; older preview pages do not enlarge the eventual bounded import without limit.
3. **Open in Nova:** a source-home/thread identity prevents duplicate imports. Nova saves visible messages separately from real Nova Runs and creates an independent app-owned folder. It does not open the source `cwd`, attach its Git repository, or adopt a native worktree.
4. **Continue with any provider:** Codex, Claude Code, and local models all receive bounded visible copies, recent Nova turns, and selected Nova memory. First handoff consent remains explicit. Source native IDs and archived status are provenance only: no resume, fork, unarchive, injection, or hidden-state transfer occurs.
5. **Copy latest from Codex:** another explicit read-only action refreshes the retained copy while preserving Nova runs and notes. It is not bidirectional or always-on synchronization. A source changing during the read fails or reports an incomplete snapshot; retry after that source conversation is idle.
6. **Export:** Markdown export saves Nova's retained visible text to a user-chosen file. Native **Publish handoff to Codex** is removed, and its compatibility IPC/service entrypoints reject without starting an engine or writing source state.

Independent import folders support Plan. Build still requires an explicitly opened, committed Git project and an isolated Nova-owned worktree; importing a conversation does not grant write access to its recorded source checkout.

The Context inspector shows bounded reference selection and omissions. Every provider has its own context limits and behavior; copying text does not preserve private reasoning, native tools/state, images/attachments, or unlimited history. Earlier imported/native-linked threads keep their visible text and provenance, but future execution is detached from their OEM native session and source working folder.

## Read-only importer limits

- Conversation discovery supports recognized uncompressed `rollout-*.jsonl` files in the selected source's `sessions` or `archived_sessions`. It never falls back to a database or launches the engine to unpack unsupported formats.
- Compressed rollouts and engine-only/private formats may be absent. A missing source conversation is not evidence that the OEM app deleted it. Supply an uncompressed copy/export when needed.
- Listing is bounded to 5,000 rollout files and 15,000 directory entries with shallow traversal. Paginated results and warnings disclose skipped/incomplete content.
- History reads a bounded stable slice of at most the latest 8 MiB of a rollout, retains at most 2,000 visible messages / 2 MiB, and bounds individual text/messages and output pages. Oversized/malformed content is not treated as a complete transcript.
- Conversation source links, redirection outside the chosen source, traversal, and non-regular files are refused. Reads use read-only file handles and check source identity/changes. A short-lived in-memory cache reduces repeated explicit browsing reads; it is not a watcher or background scan.
- Resource sections are `memories`, `memories_v2`, `instructions`, `skills`, and `plans`. Only the existing allowlisted Markdown paths are previewed; imported skills are reference text, not installed tools.
- Resource previews are limited to 128 KiB; listings are bounded to 500 resources and 5,000 visited entries. Imports retain up to 8,000 characters and a full-source SHA-256 digest after rechecking the reviewed preview.
- Imported references are independent copies. Their fingerprints document the import, not current source freshness. Context generation does not reread OEM sources. Explicitly preview and re-import to update a copy. Ordinary project-file-linked notes retain their separate project freshness rules.
- Reading reference text does not establish accuracy or neutralize instructions embedded in it. Review private content before sending it to a chosen cloud provider.

## Project-memory interchange, Git, and local models

Project memory remains a deliberate ordinary-file workflow. Preview shows the complete proposed `.nova/MEMORY.md`, `AGENTS.md`, and `CLAUDE.md` contents and a fingerprint. Publish revalidates reviewed bytes, preserves external text outside Nova-managed blocks, and refuses ambiguous links or stale previews. These are explicitly selected project files, not OEM runtime stores.

Official tools can read those project references independently. Opted-in Nova shared-project-file reads are fresh per request; imported OEM copies are not. Disabling Nova shared-file reads leaves existing files and official-tool references intact. Publishing is manual, not background memory extraction, provider database synchronization, or automatic Git commit. Stop competing editors for reviewed project writes; optimistic fingerprints are not an OS-wide transaction. Recoverable revisions remain in ignored `.nova/.memory-backups` folders.

The Local adapter still uses the Codex agent harness, now in Nova's private runtime. It supports the selected loopback Responses API or bounded streaming Chat Completions bridge. Discovery remains metadata-only, with no model download, hosted fallback, or proof that a listed model supports the task. Protocol limits remain in the [local setup guide](../README.md#connect-a-local-model).

Reviewed Git commits and fast-forward integration operate only on Nova-owned Build worktrees and explicitly opened projects. They do not adopt OEM worktrees or rewrite native history. Commit/integration remain separately confirmed with revision and cleanliness checks; there is no automatic push, reset, stash, merge commit, conflict resolution, or deletion.

Markdown export is a bounded visible-content copy, not a complete provider backup or guaranteed secrets scrubber. Raw config, credentials, private reasoning, raw logs, and native state are not added. Common secret patterns are redacted, but review retained visible text before sharing it.

## Recovery and migration

The update preserves old run records, imported visible text, source provenance, and unconfirmed-cleanup records. Legacy Codex-home recovery entries are retained as warnings, not as locks on the read-only importer or Nova's separate runtime. No migration starts a worker at that legacy home, kills an OEM process, repairs its databases, or silently acknowledges cleanup.

A previously launched Nova worker can still exist outside the newly started application. Inspect and stop only the affected old Nova-owned worker and its children before acknowledging its record in **Settings → Recovery**. Do not terminate all `codex.exe` processes indiscriminately. Acknowledgement records user confirmation, not a new proof that every operating-system child was contained.

New Nova account/run/check workers retain their lifecycle bounds and ownership checks. An unconfirmed shutdown remains a recovery failure; active operations and changed recovery entries cannot be cleared automatically. Restricted runtime/managed-policy incompatibilities fail visibly rather than enabling unsafe fallback.

## Validation scope

Automated checks use synthetic source folders, disposable repositories, fake provider processes, renderer fixtures, and native Electron smoke tests with isolated user data. They do not use real accounts, paid inference, or the user's OEM source. Test results apply only to their tested commit/environment.

Windows acceptance must still observe the exact packaged build alongside the OEM Codex app, confirm responsiveness and no unintended source access, test independent Codex sign-in, read-only active/archived copies, every intended provider, and normal recovery. The user's reported severe OEM slowdown has not been reproduced as a measured FPS test here. Code isolation and unchanged-source assertions are relevant evidence, not proof of all real-machine behavior.

Protocol references: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude Code CLI](https://code.claude.com/docs/en/cli-reference), and [Claude project memory](https://code.claude.com/docs/en/memory). Nova's read-only rollout support is a bounded compatibility reader, not a guarantee that every future private storage format is stable.
