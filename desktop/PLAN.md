# Nova Workbench: product and implementation plan

## Goal

Build a Windows-first engineering workspace in which Codex, Claude Code, and local coding models can work on the same projects, retain useful shared knowledge, and produce changes that can be independently checked.

The core product promise is **less re-explaining, fewer conflicting edits, and better evidence about whether the work is correct**. More agents, larger context, and longer autonomous runs are tools toward that goal, not success metrics by themselves.

Nova should feel familiar to someone who uses Codex or Claude Code: project navigation on the left, a focused conversation in the middle, and evidence beside it. It must use original code and branding; it is neither a reproduction of proprietary app source nor a claim to include all of either product's features.

## Non-negotiable rules

1. Preserve the user's original checkout and unrelated edits. No automatic destructive cleanup, reset, or merge.
2. Keep provider authentication with official tooling. Never collect, scrape, transplant, or proxy subscription credentials.
3. Separate **a completed model turn**, **a successful command**, and **a verified task** in the data model and UI.
4. Shared memories must have provenance, scope, and a way to become outdated. A model's assertion is not a confirmed fact.
5. Every worker has bounded authority, runtime, output, and ownership. A worktree is not a security sandbox.
6. Unsupported provider capabilities produce explicit errors, not silent weakening of permissions.
7. Use stable extension boundaries before modifying upstream Codex internals. Keep changes easy to rebase.
8. Evaluate improvements against a baseline. Do not promise token savings or better engineering quality before measuring them.

## User experience

### Primary workspace

| Region             | Contents                                                          | Behavior                                                                    |
| ------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Title bar          | Nova identity, window controls, current workspace context         | Native Windows behavior, usable drag region, clear unofficial branding      |
| Project sidebar    | Local repositories, recent threads, new task, settings            | Stable project identity; no automatic scanning of unrelated folders         |
| Conversation       | User request, worker responses, tool activity, failures, handoffs | Provider and mode visible on every run; useful errors and cancellation      |
| Composer           | Prompt, provider/model, Plan or Build                             | Explicit choice; Build explains and confirms its file-write scope           |
| Changes inspector  | Changed paths and diff                                            | Shows the actual worktree; never substitutes a model's claimed change list  |
| Memory inspector   | Decisions, constraints, notes, source references                  | User can inspect, add, and archive; memory use is visible                   |
| Activity inspector | Worker lifecycle and execution evidence                           | Distinguishes failed, cancelled, interrupted, finished, and verified states |

### First-run flow

1. Launch without a configured provider and see a useful empty state, not fake worker activity.
2. Open a Git repository through a native folder picker.
3. Inspect detected CLI availability; configure a native executable or local model if needed.
4. Authenticate in the official CLI, outside Nova, if the provider requires it.
5. Submit a Plan task, then save useful constraints as shared project memory.
6. Confirm a Build task in an isolated worktree, inspect its diff, and verify it before integration.

Keyboard navigation, visible focus, readable contrast, predictable errors, and cancellation are part of the first milestone, not later decoration. Large logs should collapse rather than make the conversation unusable. Progress must reflect observed events; “working” must not conceal a dead process.

## Architecture decisions

### Desktop foundation

- **Electron + React + TypeScript** for a Windows-first, cross-platform-capable application using existing Node process and Git tooling.
- Keep the application under `desktop/`, with its own package lock, tests, and build commands, rather than changing upstream Rust runtime behavior immediately.
- A sandboxed, context-isolated renderer cannot invoke arbitrary Node functions. A small preload bridge exposes application operations by name.
- The main process validates IPC senders, request shapes, project identity, and allowed operations.
- Packaged assets use an application protocol and restrictive content policy. Remote web pages do not become privileged application content.

### Provider boundary

The first adapter layer launches separately installed, unmodified provider CLIs and normalizes their structured events. Prompts travel over stdin, not through shell interpolation. Providers remain separate workers with distinct permissions, model catalogs, usage limits, and accounts.

Local inference reuses **the Codex agent engine with a configurable loopback provider**. Version 0.4.0 offers Ollama, LM Studio, and custom API base URLs with metadata-only model discovery. Responses-native servers connect directly; a bounded per-run bridge supports the text/tool subset of streaming Chat Completions. It does not implement hosted tools, modalities, provider-native conversation IDs, or every Responses capability. The selected model must be listed by the chosen server; Nova neither downloads models nor silently routes to a cloud fallback. A local server can itself forward requests remotely, so a loopback URL is not an offline guarantee. Nova is not a new inference engine and does not make an unsuitable local model capable of frontier-level work.

Version 0.3 adds the installed Codex app-server for native conversation listing, paginated visible history, resume/fork, and bounded turn lifecycle. It does not replace fresh Codex/Local exec workers or implement an interactive approval center: server-side tool/approval requests are denied. Native state remains owned by Codex; Claude and local models receive a bounded visible-history handoff, not a transplanted native session.

### Shared memory boundary

The initial shared-memory store is Nova-owned, local, and project-scoped. User-authored entries include kind, source, status, timestamps, and available repository provenance. A bounded selection is added to each worker's context, along with bounded prior conversation text.

This does **not** expose or migrate private model reasoning, implicitly import ChatGPT memory, or modify Codex's internal memory pipeline. It also does not extend the selected model's native context window.

Later memory services should be accessible through a consistent local API/MCP interface so multiple workers can retrieve the same evidence without directly editing each other's private stores.

### Existing installation compatibility (version 0.3)

Use the installed engine's protocol for its conversations, not direct SQLite mutations or a speculative parser for every private database. Canonical folder discovery respects Windows Documents redirection and existing junctions. The user explicitly connects before launching the history server, and explicitly imports a selected thread or Markdown reference. Engine startup can run its own migrations even when Nova only requests history metadata; the UI must not call that an immutable read-only scan.

Native Codex Plan initially resumes the original conversation at its original working directory. Isolated Build forks its native history into a Nova-owned worktree; archived originals are forked instead of automatically unarchived. Follow-ups use the persisted native fork and working directory. Existing external Codex worktrees are not silently relabeled as Nova-owned. Non-Git projectless folders remain Plan-only.

Claude/local handoffs use the same Nova project, thread, managed worktree, selected references, and bounded visible messages. No credentials, hidden reasoning, native tool state, binary attachments, queues, or automations are silently copied. Import does not create fake successful Runs. New-worktree storage is configurable without moving existing worktrees or changing their ownership checks.

See [the integration contract](docs/codex-compatibility.md) for resource allowlists, bounds, and fail-closed lifecycle recovery. Actual installed CLI versions and the user's live conversation store still require an observed Windows smoke test.

### Change ownership

Build tasks work in per-thread Git worktrees. The first implementation is deliberately conservative about concurrent writers. The project checkout remains the integration target, not a shared scratch directory for several independent agents.

Version 0.4.0 adds explicit reviewed commits in those worktrees and a separate fast-forward-only integration action. Native confirmation pins the source revision/fingerprint and original target branch/revision/fingerprint; queued execution rechecks them. Source and target must be clean for integration, with the target an ancestor of the source. Dirty, divergent, conflicted, incomplete, or changed inputs are refused. No automatic push, merge commit, reset, stash, conflict resolution, or worktree deletion is introduced. This is a deliberate single-thread integration action, not the future multi-agent merge queue.

Initial checkout suppresses hooks and checkout filters. Large-asset materialization, including Git LFS, needs a deliberate follow-up workflow before engine-level builds can be trusted. Plan and Build follow-ups in an existing thread should inspect the same preserved worktree rather than inadvertently analyzing a different revision.

Future concurrency requires explicit task ownership, dependency ordering, versioned inputs, and an integrator. File locks alone do not detect semantic conflicts between changes to different files.

## Version 0.4.0 — everyday workflow completion

This development-alpha increment closes specific gaps in the existing desktop workflow without declaring the longer roadmap complete:

- Settings tabs for General, Agents, Local models, Storage, and Recovery; native executable selection and metadata-only local model discovery.
- Configurable local backends/protocols, including a bounded streaming Chat Completions bridge for compatible text/tool models.
- Revision-bound reviewed commits and explicit fast-forward integration, with original checkout preservation on refused operations.
- User-confirmed recovery acknowledgement after independent worker cleanup, preserving the original failure history and rejecting active or stale recovery requests. This replaces manual state-file edits, not operating-system containment.
- Explicit Markdown export of retained visible conversation text and active project memory. No raw configuration, credentials, tool/error logs, or hidden state are added; common redaction is not comprehensive privacy assurance.
- Device-local, bounded per-thread/new-task composer drafts, distinct from provider history and exported conversations.

Live Windows behavior and actual installed Codex/Claude/local model compatibility remain untested for this commit. Synthetic integration coverage, renderer checks, and packaging do not establish those live results. MCP administration, automatic routing, unattended teams, semantic acceptance, signed distribution, and updates remain later work.

## Milestone 1 — usable foundation

This is the scope of the initial implementation. Items below are acceptance criteria, not a blanket assertion that every platform/provider combination has been live-tested.

- [ ] Desktop development build starts from documented Windows commands.
- [ ] Project/thread navigation, conversation composer, inspector, and settings are wired to real application state.
- [ ] Browser preview is explicitly labeled and cannot execute native operations.
- [ ] Projects, runs, settings, and user-created memories survive restart.
- [ ] Runs interrupted by application exit are not displayed as still running after restart.
- [ ] Provider discovery does not execute a paid model request or inspect credential values.
- [ ] Codex, Claude Code, and Codex/Ollama adapters have version/capability checks and normalized event handling.
- [ ] Plan uses the adapter's restricted permissions; Build receives explicit confirmation and an isolated worktree.
- [ ] First Build rejects a dirty baseline instead of silently dropping uncommitted work.
- [ ] Each thread has at most one active run; conflicting writer starts are rejected atomically.
- [ ] Timeouts, output caps, cancellation, and process-tree cleanup have deterministic tests.
- [ ] Unconfirmed worker termination is persisted and blocks further Build tasks for the project until deliberate recovery; no silent retry creates competing writers.
- [ ] Diffs reflect the actual worktree, including relevant new text files within display bounds.
- [ ] Switching providers preserves bounded, project-scoped shared context.
- [ ] Provider-reported failures cannot be mistaken for success solely because the process exits zero.
- [ ] Every finished run remains marked unverified until a later verification system exists.
- [ ] Typecheck, deterministic tests, and renderer/main builds pass.
- [ ] Windows packaging is configured; native installation and live-provider testing are reported separately.

Not in milestone 1: automatic merging, autonomous delegation, native provider-session migration, model routing, credential provisioning, comprehensive MCP administration, automatic memory extraction, or engineering-quality verification.

## Milestone 2 — trustworthy context and memory

Add source-aware retrieval rather than endlessly growing transcripts.

**Version 0.2 implementation:** bounded lexical memory selection, optional source-file digests, freshness warnings and omissions, exact context preview, and stored per-run context summaries. Thread rename/pin/archive/restore is also included. This is the first source-aware layer, not a completed symbol/dependency index or automatic knowledge extraction system. A source digest indicates whether bytes match, not whether a remembered statement is true.

- Repository symbol/dependency index with incremental invalidation when source hashes change.
- Typed memories: confirmed constraints, observed test outcomes, architectural decisions, and unverified hypotheses.
- Source file/line or artifact reference, commit/hash, author/provider, timestamps, and supersession links.
- Clear memory review and correction UI; no model can silently promote its own guess into a confirmed fact.
- Retrieval budgets per task/provider, with a visible record of what context was supplied.
- Separate project facts from personal preferences, secret material, and untrusted retrieved content.
- Optional audited import/export; never implicitly ingest all private provider histories.

**Exit criterion:** on a fixed set of long-running tasks, the system retrieves current evidence, detects stale facts, avoids cross-project leakage, and requires less user re-explanation without reducing task accuracy.

## Milestone 3 — verified execution

Define machine-checkable acceptance criteria before starting a task.

**Version 0.2 implementation:** user-owned command profiles, native execution confirmation, isolated-worktree execution, bounded output/cancellation, recorded command/exit/source evidence, stale-result detection, and persisted recovery locks. A zero exit code with unchanged complete source fingerprints can establish that one check passed for those inputs. It does not establish all task requirements, reproducibility of the external environment, or a domain-specific Unreal/BeamNG acceptance verdict.

- Named verification profiles: typecheck, tests, build, launch, screenshot, performance, or domain-specific checks.
- Record exact input revision, command/tool, timestamps, exit status, artifact hashes, and results.
- The worker may propose tests; an independent policy decides which evidence is required.
- Distinguish pre-existing failures from regressions and unsupported checks from passed checks.
- Keep “finished,” “checks passed,” and “ready for integration” separate.
- Prevent a change to tests or acceptance criteria from silently lowering the task's definition of done.

For **Henday Heat / Unreal**, begin with compilation and a repeatable editor/play smoke test, then add scene evidence, asset validity, expected behavior, and frame-time budgets.

For **370Z / BeamNG**, begin with JBeam load/validation and reproducible vehicle spawn, then add suspension geometry, deformation stability, collision, and driving measurements. Syntactically valid JBeam is not proof of physically correct behavior.

**Exit criterion:** a deliberately broken but plausible patch cannot be reported as verified; each passed task has reproducible evidence rather than only an agent-written summary.

## Milestone 4 — coordinated multi-model work

- Task graph with explicit prerequisites, owners, worktrees, and input revisions.
- Structured handoffs: scope, changed files, assumptions, unresolved issues, and verification evidence.
- Shared task messaging without copying entire private conversations into every worker.
- Independent review for high-risk changes, including cross-model review where evaluation shows benefit.
- Merge/integration queue that checks both textual and semantic compatibility.
- Resource scheduling for CPU, RAM, GPU/VRAM, local models, editor instances, and provider limits.
- Explicit user pause, cancel, inspect, and take-over controls at all times.

**Exit criterion:** multiple providers finish independent work without overwriting each other, while deliberately conflicting tasks are serialized or returned for resolution.

## Milestone 5 — routing, budgets, and recovery

- Route task classes to providers using measured performance, not fixed brand stereotypes.
- Per-task time/token/cost ceilings, with clear handling when a provider does not expose cost or usage.
- Escalation rules for repeated failures, insufficient model capabilities, or architecture-level uncertainty.
- Cache reusable context while invalidating it on relevant changes.
- Durable checkpoints and a journal of attempted approaches and observed failures.
- Detect repeated no-progress loops, preserve the failed experiment, and ask or replan within the user's approved scope.
- Resume safely after crashes without duplicating commands, commits, or external actions.

**Exit criterion:** against the stock baseline, routing improves cost or time per verified success without materially increasing failures or human correction.

## Milestone 6 — Windows release readiness

- Test the installer and portable build on clean Windows machines, including paths containing spaces and non-ASCII characters.
- Test cancellation and app shutdown with child processes, slow tools, missing CLIs, stale locks, and damaged state files.
- Code-sign installers and application binaries; establish a verified update process and rollback strategy.
- Review dependencies, supply-chain policy, filesystem capabilities, and IPC boundaries.
- Add opt-in, privacy-conscious diagnostic export with credential/content redaction and a preview before sharing.
- Document supported CLI versions, provider terms, local data retention, backups, and deletion behavior.
- No auto-update or usage telemetry should be enabled without a deliberate product decision and clear disclosure.

## Evaluation plan

Build a small, versioned benchmark from representative tasks before adding autonomous complexity.

| Task category           | Example                                                 | Evidence                                         |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| Ordinary code change    | Bounded TypeScript or C++ feature                       | Diff, tests, build                               |
| Long-session continuity | Continue a task after restart/provider handoff          | Preserved constraints, correct source revision   |
| Root-cause debugging    | Reproducible failure with a misleading symptom          | Regression test and causal explanation           |
| Parallel integration    | Two independent changes plus a conflicting pair         | Correct integration or explicit conflict         |
| Unreal workflow         | Compile and verify a small gameplay/scene change        | Build log and repeatable play evidence           |
| BeamNG workflow         | Fix a bounded vehicle configuration issue               | Load log and defined physical measurements       |
| Adversarial/recovery    | Malicious context, interrupted process, corrupted state | Bounded authority, no false success or data loss |

For stock Codex and each proposed enhancement, record:

- Verified success rate and regression rate.
- Total input/output tokens where reported; distinguish cached tokens.
- Wall-clock time and paid usage per verified success.
- Repeated failed approaches and human corrections.
- Context retrieval precision, stale-fact use, and cross-project leakage.
- Review/integration effort, not just generation speed.

Keep model/version, task revision, tool versions, hardware, and verification criteria fixed where possible. Repeat nondeterministic tasks. Do not claim a universal improvement from one attractive demonstration.

## Immediate development sequence

1. Validate version 0.4.0's local connection, Git action, recovery, export, and draft workflows alongside the existing installation/history integration in Linux and Windows CI; inspect rendered review evidence.
2. Run Windows-native live-provider smoke tests with each intended CLI, starting with a disposable Git repository and Plan mode. Connect the user's actual Codex history only after native confirmation.
3. Exercise native resume/fork, archived-source preservation, folder-only Plan, explicit Claude/local handoffs, configured local protocols, source freshness, worktree storage settings, checks, reviewed commit/integration, deliberate recovery, export, and restart before using important projects.
4. Establish repeatable project-specific verification profiles and a baseline task suite, including external dependency/version records.
5. Expand shared-memory retrieval into incremental repository indexing and explicit context budgets.
6. Add parallel delegation, routing, and a coordinated multi-agent integration queue only after the preceding boundaries are measured and reliable.
