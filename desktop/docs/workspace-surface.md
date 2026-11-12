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
