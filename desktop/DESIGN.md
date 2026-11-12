---
name: Nova Workbench
description: Inspectable coding workspace
colors:
  bg: "#1b1d1c"
  sidebar: "#181a19"
  panel: "#1d201e"
  surface: "#242725"
  surface-hover: "#2c302d"
  surface-raised: "#303531"
  border: "#353a36"
  border-soft: "#2c302d"
  text: "#e7eae6"
  secondary: "#c2c9c3"
  muted: "#9da79f"
  faint: "#929c94"
  accent: "#b6d6bc"
  accent-text: "#192d1d"
  accent-surface: "#2a372d"
  error: "#efb0a5"
  error-bg: "#382824"
  warning: "#d4bd8c"
  warning-bg: "#302d23"
  light-bg: "#f7f7f5"
  light-sidebar: "#f1f2ef"
  light-panel: "#fafaf8"
  light-surface: "#ffffff"
  light-surface-hover: "#ecefe9"
  light-surface-raised: "#e3e9e1"
  light-border: "#d3d9d1"
  light-border-soft: "#e1e5de"
  light-text: "#252c27"
  light-secondary: "#4b574e"
  light-muted: "#606e64"
  light-faint: "#637267"
  light-accent: "#3e674b"
  light-accent-text: "#fff"
  light-accent-surface: "#e1ecdf"
  light-error: "#9b3f32"
  light-error-bg: "#f9e9e4"
  light-warning: "#78602a"
  light-warning-bg: "#f3eddf"
typography:
  headline:
    fontFamily: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif'
    fontSize: "23px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.025em"
  title:
    fontFamily: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif'
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.02em"
  section-title:
    fontFamily: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif'
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.55
  body:
    fontFamily: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.8
  button:
    fontFamily: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif'
    fontSize: "12px"
    fontWeight: 500
  label:
    fontFamily: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif'
    fontSize: "11px"
    fontWeight: 500
  metadata:
    fontFamily: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif'
    fontSize: "10px"
  code:
    fontFamily: '"Cascadia Code", "Consolas", ui-monospace, monospace'
    fontSize: "11px"
    lineHeight: 1.65
rounded:
  inline-code: "3px"
  compact-selection: "4px"
  control: "5px"
  button: "6px"
  popover: "7px"
  message: "9px"
  container: "10px"
spacing:
  "4": "4px"
  "7": "7px"
  "8": "8px"
  "10": "10px"
  "12": "12px"
  "14": "14px"
  "16": "16px"
  "18": "18px"
  "20": "20px"
  "23": "23px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "7px 11px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "7px 11px"
  button-text:
    textColor: "{colors.muted}"
    padding: "0"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "9px 10px"
  inspector-tab-active:
    textColor: "{colors.text}"
    padding: "0"
  user-message:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.message}"
    padding: "13px 17px"
  request-payload:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.secondary}"
    rounded: "{rounded.control}"
    padding: "11px"
---

# Design System: Nova Workbench

## Overview

**Inspectable coding workspace.**

Nova Workbench extends a familiar Windows coding-workspace convention: compact
project navigation, a readable conversation, a bottom-aligned composer, and an
optional evidence inspector. Quiet charcoal and warm-light surfaces, system UI
type, line icons, and restrained mint states provide Nova's identity without a
competing brand treatment.

Key characteristics:

- Compact desktop controls and readable conversation text.
- Tonal surfaces and quiet separators, with lift reserved for overlays.
- Visible source context, run state, and check evidence.
- Keyboard access and persistent, resizable workspace panes.

This is a source extraction from [styles.css](src/renderer/styles.css),
[layout.tsx](src/renderer/layout.tsx), and the renderer components. The pinned
surface contract is [workspace-surface.md](docs/workspace-surface.md). This
document does not certify rendered or native-platform QA.

The six captures defined in [workbench.spec.ts](e2e/workbench.spec.ts) are
synthetic test evidence: dark desktop, light desktop, compact layout, Context,
Checks, and command palette. Preserve their synthetic-data provenance; they are
not shipped decorative imagery or evidence of a live provider run. This
extraction introduces no imagery.

## Colors

The palette is neutral and low-chroma, with one mint/green accent and distinct
warning and error roles. Frontmatter names without a prefix describe the default
dark theme. Each `light-` entry records the corresponding light-theme override of
the same CSS custom property; it is not an additional runtime variable. System
theme uses those light overrides when the operating system prefers light.

| Role               | Tokens                                                                 | Application                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Primary            | `accent`, `accent-text`, `accent-surface`                              | Primary actions and focus; selected thread/command backgrounds; current or active status text.                               |
| Neutral surfaces   | `bg`, `sidebar`, `panel`, `surface`, `surface-hover`, `surface-raised` | Workspace, navigation/code surfaces, inspector, fields/messages, hover states, and raised controls.                          |
| Neutral separators | `border`, `border-soft`                                                | Field/container strokes and quieter structural dividers.                                                                     |
| Neutral text       | `text`, `secondary`, `muted`, `faint`                                  | Main text, reading text, control/metadata labels, and supplementary detail. `secondary` is a text tone, not a second accent. |
| Error              | `error`, `error-bg`                                                    | Failed runs, form errors, and error banners.                                                                                 |
| Warning            | `warning`, `warning-bg`                                                | Changed/missing sources, omitted context, archived threads, and stale checks.                                                |

Use the same semantic variables in both themes. The sidecar snippets inherit
them rather than installing a separate palette. Status meaning is also written
in text; a green accent alone does not mean the engineering task is verified.

## Typography

The UI uses the Windows-first system stack in the frontmatter, without bundled
display fonts. Code, payloads, paths, and command output use the code stack.

| Frontmatter role | Observed use                                                               |
| ---------------- | -------------------------------------------------------------------------- |
| `headline`       | Welcome-state heading, not a promotional hero.                             |
| `title`          | Dialog headings.                                                           |
| `section-title`  | Larger headings within agent messages.                                     |
| `body`           | Conversation prose; assistant messages are limited to `75ch`.              |
| `button`         | Primary and secondary actions; inspector variants use smaller text.        |
| `label`          | Form field labels.                                                         |
| `metadata`       | Timestamps, source detail, captions, and check metadata.                   |
| `code`           | Code blocks; payload and check surfaces use their own nearby line heights. |

The base UI size is the body size; its line height is assigned per component,
not globally. Semibold headings and ordinary sentence case carry hierarchy.
Long paths and payloads wrap where possible, while code blocks retain deliberate
horizontal scrolling. Context statistics and check metadata use tabular numerals.

## Layout

The native window starts at 1440 × 940, with a 980 × 680 minimum. The renderer's
CSS shell has a separate 740px minimum width; this is not a claim of mobile
support. The titlebar is 42px tall and conversation/inspector headers are 48px.
The workspace occupies the viewport; navigation, conversation, and inspector
contents have their own scrolling regions.

Navigation defaults to 236px and clamps its saved width to 190–360px; the
inspector defaults to 356px and clamps to 300–560px. Their normal CSS width caps
are 29vw and 40vw respectively. Five-pixel separators support pointer dragging
and keyboard adjustment: arrow keys change width by 16px; Home/End use limits.
Panel visibility and widths persist in local storage.

Conversation content and composer share an 810px maximum width. Their padding
is intentionally different, so the rounded composer extends slightly beyond
the text column. The composer stays below the scrolling conversation, and its
textarea grows between 62px and 220px.

- At widths up to 1250px, secondary toolbar detail and the keyboard hint are
  hidden, and conversation/composer padding becomes more compact.
- At widths up to 1100px, the inspector becomes a right-side overlay with a close
  control; its resize handle is hidden. Its width is capped by the viewport minus
  80px. The default inspector visibility is initialized with `innerWidth >= 1100`
  when no saved preference exists.

Spacing values in the frontmatter collect recurring measurements from the
implementation; they are not an imposed uniform grid. Keep dense control groups
distinct from the more generous spacing used for message reading.

## Elevation & Depth

The workspace is flat by default: adjacent tonal surfaces, thin borders, and
dividers establish structure. Only dialogs, the command palette, thread menus,
and the compact inspector use shadows. The actual dark/light overlay shadow and
compact-inspector shadow are recorded in the sidecar. Modal backdrops dim the
workspace without blur. Do not add card shadows to ordinary inspector content.

## Shapes

Small-radius rectangular controls dominate. The frontmatter separates inline
code, compact selected controls, standard controls, buttons, popovers, messages,
and larger composer/dialog containers. Circles are reserved for status dots and
the scroll-to-bottom control. Borders are normally one pixel; the selected
inspector tab uses a two-pixel accent underline. The Nova mark is the existing
inline stroked N; provider markers are functional line icons, not copied logos.

## Components

| Component                   | Appearance and interaction                                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary / secondary buttons | Compact, medium-weight actions with a 33px minimum height. Primary hover increases brightness; secondary hover changes surface and text tone. Disabled buttons reduce opacity and use a not-allowed cursor.                               |
| Icon / text buttons         | Icon controls are 28px squares with quiet hover fill. Text actions stay unfilled and underline on hover. Controls carry labels independently of their icon.                                                                               |
| Fields                      | Bordered surface fill, visible labels, muted help text, and accent carets. Keyboard focus uses an accent outline with a two-pixel offset. Error messages are separate text surfaces.                                                      |
| Composer                    | Larger rounded field with a provider selector, model override, Plan/Build control, and send/stop action. Focus changes its container border; the textarea intentionally has no separate outline. Controls wrap when space is constrained. |
| Thread navigation           | Compact project and thread rows; the selected thread gets accent-surface fill. Titles truncate. Thread actions become visible on hover, keyboard focus within the row, or selection.                                                      |
| Inspector tabs              | Unfilled labels with an accent underline for the active tab. Left/right arrow keys switch tabs; the active panel is keyboard-focusable.                                                                                                   |
| Message containers          | User text has a tonal rounded container; assistant prose sits directly on the conversation background. Tool output is collapsible, and code blocks have distinct language/copy headers.                                                   |
| Context and check evidence  | Counts, plain-text status, source notes, warnings, and scrollable monospace payload/output surfaces. Passed, stale, failed, and unchecked states retain their actual wording and revision context.                                        |
| Dialogs / menus             | Dialogs manage initial focus, Tab containment, Escape, and focus restoration. Thread menus support arrow-key navigation. The command palette uses keyboard selection and a compact result list.                                           |

There is no general-purpose chip component in the implementation; included,
omitted, availability, and freshness states are compact text or dot treatments.
Do not convert them into decorative badge collections.

Motion is limited to the existing loading spinner. Reduced-motion preferences
shorten animation duration and remove repetition; no entrance or hover
transitions are defined. Component previews in the sidecar are static HTML/CSS
extractions with the implemented visual hover/focus states, not replacements for
the React behavior.

## Do's and Don'ts

- Do extend the existing Windows-first sidebar/conversation/inspector convention.
- Do use the semantic theme variables and the existing system-font stacks.
- Do preserve keyboard focus, readable labels, and access to truncated content.
- Do show source freshness, check revision context, and uncertainty in words.
- Do retain synthetic-data labels and provenance on screenshot test evidence.
- Don't add a competing brand, display-font identity, decorative gradients, or copied provider logos.
- Don't add lift to ordinary content panels or turn status text into decorative chips.
- Don't describe a finished agent turn, preview, or isolated passing check as a fully verified engineering result.
- Don't treat this source extraction as completed rendered or native-platform QA.

## v0.5 accounts and shared context

The incumbent Windows workspace remains the visual authority. Provider accounts
extend Settings → Agents with compact status rows, explicit checks, native-owned
sign-in progress, cancellation, and actionable failures. Account state is separate
from executable detection; credentials and browser navigation never belong to the
renderer. A completed login remains complete if its follow-up account check fails.
Transient progress failures retry within a bounded window, then expose retry and
cancel controls without claiming that an unobserved worker stopped.

Memory adds a project-file preview using the existing inspector typography and
literal-code surfaces. The exact existing/proposed `.nova/MEMORY.md`, `AGENTS.md`,
and `CLAUDE.md` contents are reviewable before native confirmation. The UI
distinguishes Nova-managed notes from preserved external text and distinguishes
disabling Nova reads from deleting the official tools' project references.

Thread toolbar/menu actions refresh retained visible Codex history or publish a
native handoff without starting a model turn. These are explicit operations, not
claims of live synchronization, interchangeable hidden state, or full proprietary
desktop feature parity. Existing neutral colors, mint states, system type, and
line icons are retained; no raster assets are added.

The four `accounts-sharing.spec.ts` captures are synthetic test evidence for
desktop sign-in, compact light-theme controls, shared-memory preview, and Codex
handoff. At this source update the final rendered/native review remains pending
CI artifact inspection. They cannot certify a real provider login or inference.
