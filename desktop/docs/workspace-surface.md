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

Codex Plan resumes native engine history, or an owned fork once one exists. An
archived source is forked before continuing. Isolated Build uses a Nova worktree;
non-Git folders remain Plan-only. Claude and local providers share the same Nova
thread and its bounded visible context, not Codex hidden state. Native consent and
provider execution remain main-process responsibilities.

Resources are previewed as literal text and imported only into a selected project
with the exact reviewed digest. Memories, memories v2, instructions, skills, and
plans become reference notes—not installed instructions or executable skills.
Credentials and raw configuration are excluded. An imported note retains its
external source fingerprint; manual editing explicitly removes that link. Returning
to a note's resource preview does not start the native conversation engine. If its
source home differs from the configured library, the UI warns before offering
current-library resources instead of silently substituting another source.

Settings expose optional Codex home and worktree-storage locations through the
native picker contract. Empty values preserve configured defaults. A worktree
location change applies only to future worktrees; existing thread folders are not
moved.

New deterministic browser capture cases cover dark desktop conversation browsing,
light desktop resource preview, compact 980px browsing, and an imported transcript
with cross-provider Context. All screenshot data is explicitly synthetic. Local
browser execution remains unavailable in this environment; CI artifacts, not a
simulated local render, supply visual-review evidence. These cases do not validate
live provider accounts or Windows-native sandbox behavior.
