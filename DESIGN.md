# SchulHub design system

All styling lives in `public/hub.css`. The Hub's Content Security Policy forbids inline
styles, so every visual rule must be a class there.

## Idea

A ruled sheet in the dark. Near-black ground, content separated by white hairlines
instead of boxes and shadows, white as the one accent. Colour only appears where it
carries meaning, so it is always noticed.

## Colour

| Token | Use |
|---|---|
| `--bg` `#09090b` | page ground |
| `--s1` `#111114`, `--s2` `#1a1a1f` | raised: panels, inputs, hover, selected |
| `--ink` `#fafafa` | text, primary buttons, active states, focus ring |
| `--muted`, `--faint` | secondary text, labels, metadata |
| `--line`, `--line-2`, `--line-3` | hairlines: dividers, default borders, hover borders |
| `--ok` green | approved, published, saved |
| `--warn` amber | waits for someone's decision |
| `--danger` red | destroys something; the test-mode warning |
| `.c0`–`.c7` | an app's identity colour, used only as the hairline around its icon |

Never use colour for decoration.

## Type

- **Sans** for content. `h1` is large and tight (negative tracking); `h3` names things.
- **Mono, small caps** is the system's voice: section labels (`h2` + hairline rule),
  form labels, table headers, badges, breadcrumbs, navigation, metadata.

## Shape

- One radius, `3px`, nearly square.
- No drop shadows. Depth comes from surface steps and hairlines.
- Status is a 3px bar on the left edge (flash messages, upload status, panels that wait
  for a decision).

## Components

| Component | Rule |
|---|---|
| `.btn.primary` | solid white; at most one per task area |
| `.btn` | white hairline; real actions that are not the main one |
| `.btn.ghost` | text only; low-stakes or navigation-like |
| `.btn.danger` | red hairline, fills red on hover |
| `.btn.busy` | spinner after a form is sent (set by `hub.js`) |
| `.grid` + `.card` | cells of one ruled sheet sharing hairlines; links show an arrow on hover |
| `.panel` | a bounded task area; `.attention` = someone must decide; `.quiet` (dashed) = settings and destructive actions |
| `.badge` | mono status tag; `.ok` and `.warn` add a dot (the warning dot pulses) |
| `table.data` | ruled table; below 720px each row becomes a labelled record (`hub.js` adds the labels) |
| `details.result` | expandable record with a `+` that turns into `×` |

## Layout and responsiveness

Mobile first. Breakpoints:

| Width | Change |
|---|---|
| < 560px | forms stack, buttons full width, tables become records, navigation is a bottom tab bar with icons |
| ≥ 560px | forms go inline, the role appears under the name, the QR code sits next to its text |
| ≥ 860px | navigation moves into the header as text tabs; source viewer gets a sticky file list |
| ≥ 1100px | taller header, form fields capped in width |
| ≥ 1600px | base size grows to 17px |

The player is a special page: one thin bar, no footer, no tab bar on phones. The app
gets the screen.

## Motion

Fast (0.15–0.3s), one easing curve, small distances: pages rise in by 8px, flash messages
slide in, the active tab underline scales in, card arrows slide in, expanded records rotate
their `+`. All motion is switched off under `prefers-reduced-motion`.
