# SchulHub design system

**Schiefer und Kreide – die Farbe gehört den Apps.**

The Hub is a slate board with chalk: near-black surfaces, chalk-white type and hairlines.
It has no colour of its own. Colour appears in exactly two places, so it always means
something:

1. **Status** – green: done / approved · amber: waiting / due soon · red: destroys / overdue.
2. **App identity** – every app has one of eight colours. It shows on the app's tile, as a
   band on its page head, its player bar and its "continue" card. The students' work is the
   colourful part of the school.

Everything lives in `public/hub.css` (tokens + components) and the helpers in `src/html.js`.
The Hub's CSP forbids inline styles, so there is never a `style` attribute: every visual rule
is a class, widths of bars and charts are SVG attributes.

## Tokens

| Group | Tokens (dark default) | Use |
|---|---|---|
| Surfaces | `--ground` #0a0b0c, `--raised-1` #111315, `--raised-2` #181b1e, `--raised-3` #22262a | page; lists and panels; inputs, hover, menus; selected, pressed |
| Ink | `--ink` #f4f5f2, `--ink-2` #b7bdbf, `--ink-3` #8a9296, `--ink-on-ink` | text and primary fills; secondary text (~10:1); metadata (AA) |
| Lines | `--line-1` 7.5 %, `--line-2` 14 %, `--line-3` 32 % white, `--line-strong` | separators; control borders; hover/emphasis; focus, active, selected |
| Meaning | `--ok`, `--wait`, `--danger` (+ `-tint`, `-line`) | status only |
| Apps | `--app-0` … `--app-7` (Himmel, Wiese, Orange, Kirsche, Flieder, Türkis, Sonne, Sand); `.app-N` sets `--app` | app identity only |
| Heat | `--heat-1` … `--heat-5` | monochrome intensity in overviews (never a rainbow) |
| Type | `--sans` Atkinson Hyperlegible Next, `--mono` Atkinson Hyperlegible Mono | see below |
| Space | `--s-1` 4px … `--s-9` 96px, `--gutter` 16→40px, `--w-text` 42rem, `--w-page` 76rem | 4px grid |
| Shape | `--r-1` 6, `--r-btn` 8, `--r-2` 10, `--r-3` 14, `--r-pill` | controls, buttons, surfaces, sheets/tiles |
| Motion | `--t-1` 120ms, `--t-2` 180ms, `--t-3` 260ms, `--ease` | hover/press, state/disclosure, sheets/page |
| Touch | `--tap` 44px | smallest target anywhere |

**Themes.** `data-theme` on `<html>` comes from the person's setting (`dark` default, `light`
"Papier", `auto` follows the device). Light mode is the same structure inverted – warm paper,
black ink – and apps keep their colours. `data-contrast="high"` brightens secondary ink and
firms up lines; `data-text` (`large` 112.5 %, `larger` 125 %) scales everything (all sizes are
`rem`); `data-motion="reduce"` switches motion off like `prefers-reduced-motion`.

## Type

Atkinson Hyperlegible was designed by the Braille Institute so that easily confused letters
look different (I l 1, O 0). It is legible for young and weak readers on cheap screens and it
has a character of its own. One family, variable weight, ~80 KB self-hosted.

| Role | Size | Weight |
|---|---|---|
| Display (landing, projector) | 40 → 80px | 800, tight tracking |
| `h1` page title | 28 → 44px | 760 |
| `h2` section | 19 → 24px | 700 |
| `h3` item | 17px | 660 |
| Body | 16px / 1.55 | 400 |
| Small, meta | 14px, 13px | 400–600 |
| `.eyebrow` | 11.5px mono caps | 650 – sparingly: dates, system labels |

Mono is the system's voice and is used **sparingly**: eyebrows, codes, versions, numbers in
code. Section headings are real sans headings, not mono labels.

## Layout and navigation

Mobile first. Navigation changes form with the space:

| Width | Navigation | Notes |
|---|---|---|
| < 720px | top bar (brand, search, bell, avatar) + **tab bar at the thumb** | menus open as bottom sheets; tables become records |
| 720–1199px | **icon rail** on the left (icon above label) | top bar shows the page title |
| ≥ 1200px | **sidebar** with labels, counts and "Deine Klassen" | search field in the top bar |
| ≥ 1600px | content max 76rem, base size 17px | |

Main areas: Start · Klassen (amber count = apps waiting for review) · Entdecken (catalogue) ·
Bauen (own apps, editor, guide) · Verwaltung (admin). The avatar menu holds Meine Daten,
Darstellung, Hilfe, Datenschutz, Abmelden.

The **player** is its own shell: no navigation, one 44px bar with the app's colour band; the
app gets the rest of the screen. Previews add a console drawer.

## Components (`src/html.js`)

| Helper | Use |
|---|---|
| `pageHead({ crumbs, eyebrow, title, lead, meta, actions, app, tabs })` | every page starts with it; `app` adds the colour band and tile |
| `tabs(items, current)` | sub-areas of one object (class, app, admin) |
| `sectionHead(title, { count, sub, actions })` | heads of sections |
| `list(rows)`, `row({ href, title, sub, start, end })`, `appRow(app, …)` | **the default way to show things.** A row with `href` is clickable as a whole; buttons inside stay separate |
| `shelf(items)`, `shelfItem(app, href, sub)` | collections of apps: scrolls sideways on phones, grid on wide screens |
| `dataTable({ columns, rows })` | tabular data; becomes labelled records on phones (no sideways scrolling) |
| `stats([stat({ label, value, sub, tone, href })])` | a few key numbers in one strip |
| `meter(value, { tone })`, `sparkline(values)`, `barChart(bars)` | SVG, server-rendered, with text alternatives |
| `badge(text, tone)`, `countPill(n)` | status; counts |
| `notice({ tone, title, text, actions })` | callouts, flash messages |
| `empty({ icon, title, text, actions })` | every list has one: what goes here and the one next step |
| `field(req, { label, name, … })` | form fields; keeps what the person typed after a validation error |
| `linkButton`, `postButton` (`kind`: primary / secondary / quiet / danger, `confirm`) | actions; state changes are always POST forms |
| `timeline(items)` | histories: review decisions, comments, audit |
| `appIcon(app, size)`, `avatar(name)`, `icon(name)`, `dueChip(ts, tone)` | identity, people, icons (Lucide subset, `src/icons.js`) |

### Rules

- **One primary action per area.** Primary = chalk-white fill. Secondary = hairline.
  Quiet = text. Danger = red hairline that fills on hover, always behind a confirmation that
  says what will happen (`postButton(…, { kind: 'danger', confirm: 'Titel\nWas passiert.' })`).
- **Related actions sit together**, primary first. On phones they stretch to full width.
- **Lists, not card grids.** Rows on one surface separated by hairlines. Shelves only for apps.
- **No decoration.** No gradients, glows, glass, drop shadows (only floating menus, sheets and
  dialogs get a shadow, to separate them from the page).
- **Colour discipline.** Never colour for emphasis; use weight, size, ink level or a white
  hairline. App colours never style the chrome.
- **Every list has an empty state**, every action a result message (`flash`), every form an
  error path back to the form (the error handler does this for 400/409/413).
- **Text**: German, sentence case, short. Use `plural()`, `formatAgo()`, `formatDue()`,
  `formatDay()` from `src/util.js` – never hand-built plurals or dates.

## Pages have their own character

Inside the system, pages differ in density and rhythm:

- **Landing** – editorial: display type, a mosaic of app colours, three numbered steps.
- **Start** – personal: date and greeting, one big "continue" card in the app's colour, then
  tasks with calendar chips, feedback, classes. Teachers get a stat strip and their queue.
- **Player** – almost nothing: the app is the page.
- **Review** – a workbench: preview and decision side by side, a fixed decision bar.
- **Teacher results** – dense and calm: a monochrome heat grid, numbers in tabular figures.
- **Projector (QR)** – one huge thing at a time, readable from the back row.

## Motion

Fast and quiet: 120ms for hover and press, 180ms for state and disclosure, 260ms for sheets;
one ease-out curve; a 140ms cross-fade between pages (CSS View Transitions, navigation and
top bar stay still). No bounce. Everything is off with `prefers-reduced-motion` or the
person's setting.

## Accessibility

Visible focus (2px chalk outline) everywhere; 44px targets; skip link; `aria-current` on the
active navigation; every icon-only button has a label; charts carry a text alternative;
contrast AA or better in both themes (secondary ink ~10:1 on dark).

## For page authors

- Build pages from the helpers above. Page-specific CSS goes in `public/css/<area>.css`,
  loaded with `page(req, { styles: ['css/<area>.css'] })`. It is unlayered, so it wins over
  the system; keep selectors to one class and prefix them with the area (`.review-…`).
- Never write `style=""`, never inline `<script>` or `<style>`, never load anything from
  another host.
- Check every page at 360, 768, 1280 and 1920px: no horizontal scrolling from 320px up.
