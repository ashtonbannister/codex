# Nova Workbench feature coverage — 0.5.4

This records what this application implements, not everything present in a vendor's desktop app. **Implemented** means there is a working code path and an explicit failure path; it does not mean a live account, installed model, or proprietary UI has been tested on the user's machine. Consult the matching commit's GitHub Actions results for automated evidence.

## Implemented application workflows

| Capability | Current implementation | Boundary |
| --- | --- | --- |
| Windows desktop workspace | Projects/threads, conversation and composer, Changes/Context/Memory/Checks/Activity inspectors, light/dark/system theme, keyboard and resizable panes | Independent Electron interface inspired by familiar desktop conventions; no vendor UI assets or proprietary shell |
| Project/thread management | Open Git projects or independent app-owned conversation-copy folders; rename, pin, archive/restore, retain local drafts; select agent/model before opening a project | Imported folders are Plan-only and never adopt recorded source checkouts; archival does not delete worktrees |
| Plan and Build | Restricted Plan; explicitly confirmed Build in an isolated per-thread Git worktree | No automatic main-branch write, merge, remote push, or deletion; worktrees are not full OS sandboxes |
| Agent lifecycle | Streaming visible messages/tool activity, bounded output/runtime, cancel and interrupted/failed states | Completed process is not verified engineering success |
| Review and checks | Diffs, configured command checks with revision evidence, reviewed commit and separate fast-forward integration | Checks are user-approved programs outside the agent sandbox; no automatic semantic correctness guarantee |
| Nova context and memory | Project notes, source fingerprints, bounded visible history, inspectable inclusions/omissions | Not an unlimited context window or private reasoning transfer |
| Shared project-memory files | Preview and explicitly publish `.nova/MEMORY.md` plus managed `AGENTS.md`/`CLAUDE.md` references; opt-in fresh reads for each Nova context build; disable Nova reads | Manual publishing, not background private-memory synchronization; disabling Nova reads leaves official-tool references intact |
| Failure recovery | Persisted project/account-worker locks; old Codex-home cleanup records remain nonblocking warnings; explicit native acknowledgement after user cleanup | No automatic cleanup acknowledgement or killing OEM processes; user attestation is not proof of complete OS containment |
| Export and persistence | Atomic Nova state, retained runs/memory, device-local drafts, explicit Markdown export | Plaintext local data; visible-content exports are not native-history backups or guaranteed secret scrubbers |
| Windows distribution | x64 installer and portable packaging workflow | Unsigned; no implemented production updater or signing pipeline |

## Implemented through the installed provider tools

| Capability | Integration | What is not shared or assumed |
| --- | --- | --- |
| Codex account login/status | Official app-server `account/read`, ChatGPT login start/completion/cancel in Nova's private runtime; trusted browser launch, bounded process ownership | Separate one-time Nova sign-in; no OEM account reuse, token copying, password form, or source-home worker |
| Claude Code account login/status | Official CLI `auth status` JSON and `auth login` browser flow under safe mode | Claude Desktop sign-in is separate; organization-specific interactive flows may need the CLI terminal |
| Existing official Codex conversations | Explicit read-only browsing of supported JSONL rollouts, bounded preview/import and Copy latest; independent Nova folders and visible context for every provider | No startup source reads, watchers, databases, source workers, native resume/fork, or writeback; unsupported/compressed/engine-only histories may be absent |
| Nova context back to OEM Codex | Native publication removed; use explicit visible Markdown export for a copy | Compatibility IPC rejects immediately; no thread creation/injection or private-state synchronization |
| Codex and Claude coding | Separately installed CLIs, private Nova Codex runtime and normal Claude Code account, explicit provider selection | Provider permissions, model availability, usage limits and billing remain separate |
| Local Responses models | Configurable Ollama/LM Studio/custom loopback API, metadata-only model discovery, Codex harness against Responses-native server | Discovery does not prove a model is loaded/capable; no model download or hosted fallback |
| Local Chat Completions models | Per-run loopback translation for streaming text and supported tool calls | Not complete Responses parity: no media/attachments, encrypted reasoning/native response IDs, background jobs, hosted tools or structured-output formats |
| Existing Codex reference files | Explicit preview/import of allowlisted Markdown memories, instructions, skill references and plans with import fingerprints | Independent copies, not background freshness reads; references do not install skills/plugins or migrate private memory/automation databases |

Login and local connection setup are not substitutes for a real provider acceptance test. Nova preserves supported account boundaries: it does not turn a ChatGPT subscription into Anthropic access, or give a local model the context window/capabilities of a different model.

## Not yet implemented

These are application gaps, not promises that every vendor exposes an interchangeable interface for them:

| Capability | Current status |
| --- | --- |
| General MCP server/plugin administration and provider tool discovery | Not implemented; inherited MCP/hooks/plugins are disabled by the bounded adapter contract |
| Interactive per-tool approvals/permission center | Not implemented; server-originated tool/approval requests are denied rather than silently approved |
| Autonomous multi-agent teams, delegation and automatic model routing | Not implemented |
| Scheduled/background automations, goals, queues and proactive tasks | Not implemented; existing native state is inventory-only |
| Voice/dictation, live audio/video and computer/browser use | Not implemented |
| Multimodal attachment transfer and generated-image workflows | Not implemented in the shared transcript/local bridge |
| Complete native model catalog, billing/usage dashboard and account management | No comprehensive UI; status and manual provider/model selection do not certify entitlements or remaining quota |
| Full Claude Desktop conversation import/resume | Not implemented; Claude Code account/worker integration is not a desktop-history adapter |
| Automatic cross-provider memory extraction, indexing, semantic retrieval and background bidirectional conversation sync | Not implemented; current sharing is bounded explicit snapshots and project references |
| Complete OEM Codex feature parity | Not claimed; a supported engine feature is not automatically exposed by this UI |
| Signed releases, production auto-update and installer/uninstaller acceptance | Not completed by packaging alone |

## Private implementation boundaries

The fork includes the open-source engine and Nova's own application, not OpenAI's or Anthropic's proprietary desktop source. Private app databases, hidden provider state, browser storage, credential files, runtime caches, voice state and vendor-specific UI behavior are **not assumed to be portable APIs**. An installed version may expose more supported engine functions in the future; implementing them still requires explicit UI, lifecycle, permissions and compatibility work.

Nova uses official CLI/app-server operations only within its assigned runtime boundaries, explicit bounded read-only compatibility readers for OEM import copies, and ordinary reviewed project files for opted-in memory sharing. Unsupported formats, versions, or policy requirements produce errors rather than raw-database fallback or permission bypass. The reported OEM Windows FPS regression still needs measurement against the packaged update on the affected machine. The [compatibility contract](codex-compatibility.md) explains ownership and limits; the [README](../README.md) provides current setup and end-to-end workflows. [PLAN.md](../PLAN.md) is a roadmap, not a claim that every milestone has shipped.
