# Workspace surface

Mode: Operate. Windows-first desktop, with a 980px minimum window width.

Audience: Ashton and other developers switching between Codex, Claude Code,
and locally hosted models on long-running engineering projects. Frequent tasks
are continuing a thread, reviewing changes, checking context, and running
explicit project checks. Existing sign-ins, worktrees, and source files remain
under the user's control.

## Direction contract

**THESIS:** A familiar coding workspace whose context and evidence are inspectable.
Preserve the sidebar/conversation/inspector composition; remove promotional
empty-state styling that competes with the actual work.

**OWN-WORLD:** Inherit Nova's neutral charcoal and warm-light themes, system UI
type, compact line icons, quiet separators, and restrained mint selected states.
No competing brand, display-font identity, decorative gradients, or logo copies.

**STORY:** Open a project, find or create a thread, inspect its bounded context
and source-scope warnings, run a bounded agent, and judge its changes against recorded checks.

**FIRST VIEWPORT:** Compact project/thread sidebar, a wide readable conversation,
bottom-aligned composer as the primary action, and a collapsible evidence panel.
Context and Checks sit beside Changes and Memory. Command search and thread
actions are available without crowding the conversation. Resizing preserves a
usable composer and keyboard access at 1440px and 980px.

**FORM:** User-pinned Codex/Claude-style desktop convention, extending the existing
surface. No new-world roll or competing design proposal applies. The signature
interaction is inspecting the cross-provider context pack and linking a check's
result to the revision it tested. Motion is limited to state feedback.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance. Here, the existing code is the visual authority; new screenshot
artifacts are test evidence, not shipped decorative assets. The unavailable
design launcher is not represented as having run.

## Verification scope

Capture desktop and compact Windows-layout renderer states, both themes, and
representative Context/Checks states with clearly labeled synthetic data. Test
keyboard navigation and actual bridge requests. Native Electron startup and
preload/IPC checks run separately in Windows CI. Browser-only success must never
be described as a live provider or native operating-system sandbox test.

The initial interface does not imply completed autonomous agent teams, complete
MCP administration, automatic routing, or semantic verification of engineering
requirements.

## v0.3 Codex library extension

The existing sidebar gains one quiet `Codex library` destination, also available
through command search. It opens inside the main workspace, not as a blocking
modal. The established type, color, spacing, sidebar, and inspector tokens remain
unchanged. The library uses a compact list/detail layout with Conversations,
Resources, and Locations sections; the normal composer returns when a conversation
is opened in Nova.

The conversation list supports active/archived state, search, and opaque cursor
pagination. History starts with recent visible messages; older pages are prepended
in chronological order using the combined turn and item identity. Loading older
preview pages does not silently enlarge the bounded imported snapshot. Source and
truncation labels stay with the retained transcript, which is never displayed as a
new agent run or new verification evidence.

As of v0.5.4, the Library opens unloaded and requires **Read import source**.
Codex, Claude, and local providers all use the same independent Nova copy and its
bounded visible context. No source-native resume, fork, or archive change occurs.
Imports create Nova-owned Plan folders, not projects at their recorded source cwd.
Isolated Build requires an explicitly opened Git project. Native consent and
provider execution remain main-process responsibilities.

Resources are previewed as literal text and imported only into a selected project
with the exact reviewed digest. Memories, memories v2, instructions, skills, and
plans become reference notes—not installed instructions or executable skills.
Credentials and raw configuration are excluded. An imported note retains its
external source fingerprint as import provenance, without automatic freshness
reads; manual editing explicitly removes that link. Returning to a note's resource
preview still requires Read import source and never starts an OEM engine. If its
source home differs from the configured library, the UI warns before offering
current-library resources instead of silently substituting another source.

Settings expose an optional read-only Codex import source and worktree-storage
location through the native picker contract. Codex runtime/sign-in stays in Nova's
private app-owned home, not the source. A worktree
location change applies only to future worktrees; existing thread folders are not
moved.

New deterministic browser capture cases cover dark desktop conversation browsing,
light desktop resource preview, compact 980px browsing, and an imported transcript
with cross-provider Context. All screenshot data is explicitly synthetic. Local
browser execution remains unavailable in this environment; CI artifacts, not a
simulated local render, supply visual-review evidence. These cases do not validate
live provider accounts or Windows-native sandbox behavior.

## v0.4.0 everyday-workflow extension

The direction contract is unchanged. The existing workspace gains working actions
inside its established surfaces, not a different desktop design or a claim of full
Codex/Claude feature parity.

Settings uses General, Agents, Local models, Storage, and Recovery tabs. Agents
offers a native executable picker and official-tooling guidance. Local models
shows the selected backend, loopback API base URL, protocol, discovery results,
and manual model identifier. Discovery is labeled metadata-only, with local-server
and protocol limits visible; an available catalog entry is not a successful model run.

Changes presents the reviewed worktree branch, revision, paths, and original
target branch. Commit and fast-forward integration are separate actions, each
with a native confirmation and revision/fingerprint revalidation in the main
process. Unavailable actions explain why rather than silently weakening the
clean-baseline or fast-forward requirement. No push or destructive cleanup is
implicit.

Recovery lists affected projects/accounts and retained legacy Codex-home warnings;
those source-home warnings no longer block importing or the independent runtime.
It explicitly records the user's cleanup acknowledgement without killing OEM
processes or auto-clearing records. It neither claims to have found every detached process
nor turns a historical unconfirmed termination into a verified shutdown. Active
work or stale recovery entries cannot be cleared through the interface.

The thread toolbar/menu exposes Markdown export of retained visible messages and
active project memory through a native Save dialog, with privacy limits disclosed.
Per-thread and per-project new-task drafts retain text/provider/model/mode on this
device within bounded storage; no draft is sent to a provider merely by switching
threads. Storage failures are visible.

Browser-preview actions remain explicitly simulated and cannot launch tools,
models, native Git operations, or native export. Automated synthetic coverage is
separate from actual Windows/provider compatibility, which remains untested for
this commit. The alpha does not imply completed MCP administration, autonomous
teams, routing, signed distribution, or every later roadmap milestone.

## v0.5.0 accounts and shared-context extension

Settings → Agents separates saved executable detection from account state.
Explicit account checks and sign-in run through the official tools. Native
confirmation, persisted worker/recovery controls, and Nova's private Codex home
remain main-process responsibilities. The renderer shows bounded progress and
cancel/retry states without collecting credentials or opening OAuth URLs itself.
Transient progress failures do not strand the dialog, and a failed account refresh
does not change a completed login back to an in-progress state.

The Memory inspector previews complete existing/proposed contents for the common
project reference and both official-tools' instruction files. Publishing requires
the exact reviewed fingerprint and a native confirmation. Ordinary project changes
must be reviewed/committed before an isolated Build; the UI does not imply an
automatic commit. Opted-in shared-file reads are fresh per request across Nova's
providers. Disabling them leaves project files and official Codex/Claude references
intact, as stated next to the action.

**Copy latest from Codex** lives beside existing thread actions. It explicitly
copies bounded source-visible text and preserves Nova runs and notes. Native
publishing has been removed and its IPC fails closed. Hidden reasoning, live
sessions, and private memory databases are outside this interchange contract.

Four deterministic, synthetic capture cases cover accounts, compact light-theme
keyboard use, memory review, and explicit thread-history copy. Final browser/native QA
is pending CI artifact review at this documentation update. No local browser or
real provider account was used to claim completion.
