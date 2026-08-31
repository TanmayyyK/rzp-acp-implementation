---
name: Experimental Brutalist Ledger
source: Stitch project "Razor AI Command Center" (projects/721221503892739142)
colorMode: DARK
colorVariant: FIDELITY
seedColor: '#f5f5f5'
brand:
  primary: '#f5f5f5'   # text / high-contrast shells
  void: '#0a0a0a'      # base canvas
  accent: '#ffb800'    # Industrial Amber - status, active, critical telemetry
fonts:
  headline: Space Grotesk
  body: Space Mono
  label: Space Mono
roundness: 0            # zero radius; primary actions use a 4px chamfer
colors:
  surface: '#141313'
  surface-dim: '#141313'
  surface-bright: '#3a3939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1c1b1b'
  surface-container: '#201f1f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353434'
  on-surface: '#e5e2e1'
  on-surface-variant: '#c4c7c8'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#8e9192'
  outline-variant: '#444748'
  surface-tint: '#c6c6c7'
  primary: '#ffffff'
  on-primary: '#2f3131'
  primary-container: '#e2e2e2'
  on-primary-container: '#636565'
  inverse-primary: '#5d5f5f'
  secondary: '#c9c6c5'
  on-secondary: '#313030'
  secondary-container: '#4a4949'
  on-secondary-container: '#bab8b7'
  tertiary: '#ffffff'
  on-tertiary: '#412d00'
  tertiary-container: '#ffdea8'
  on-tertiary-container: '#845d00'
  tertiary-fixed-dim: '#ffba20'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  background: '#141313'
  on-background: '#e5e2e1'
  surface-variant: '#353434'
typography:
  display-xl:          { fontFamily: spaceGrotesk, fontSize: 72px, fontWeight: '700', lineHeight: 0.9em, letterSpacing: -0.05em }
  headline-lg:         { fontFamily: spaceGrotesk, fontSize: 32px, fontWeight: '600', lineHeight: 1.1em, letterSpacing: -0.02em }
  headline-lg-mobile:  { fontFamily: spaceGrotesk, fontSize: 24px, fontWeight: '600', lineHeight: 1.1em, letterSpacing: -0.02em }
  body-md:             { fontFamily: spaceMono,     fontSize: 14px, fontWeight: '400', lineHeight: 1.6em, letterSpacing: -0.01em }
  telemetry-sm:        { fontFamily: spaceMono,     fontSize: 11px, fontWeight: '400', lineHeight: 1em,   letterSpacing: 0.05em }
  label-xs:            { fontFamily: spaceMono,     fontSize: 10px, fontWeight: '500', lineHeight: 1em,   letterSpacing: 0.1em }
spacing:
  unit: 4px
  gutter: 1px
  margin-page: 32px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 32px
---

# Razor AI Command Center - Design System

Extracted from the Stitch project **Razor AI Command Center** (`projects/721221503892739142`).
Theme: **Experimental Brutalist Ledger** - DARK mode, FIDELITY dynamic color, seeded from `#f5f5f5`.

Build all Razor AI Command Center components against the tokens below. The YAML frontmatter is the
machine-readable contract; the sections below are the working reference.

## Design principles

- **Experimental brutalism.** Sharp 90-degree angles, zero radii, visible structural hairlines.
- **Data-heavy telemetry.** Information density over whitespace. Every pixel serves data.
- **Analog texture.** A subtle 2-3% film-grain overlay across the whole UI to break digital flatness.
- **Anti-decorative.** No shadows, no blurs, no glow or sparkle. Depth comes from color-fill shifts and hairlines only.

---

## Colors

### Core brand palette

These are the designer-intent brand values (the seed and override colors). Use them as the primary story.

| Role | Hex | Usage |
|------|-----|-------|
| Primary / text | `#F5F5F5` | Primary text and high-contrast UI shells |
| Void / canvas | `#0A0A0A` | Base canvas and deepest structural layer |
| Accent (Industrial Amber) | `#FFB800` | Status indicators, active states, critical telemetry only |

The accent is deliberately scarce. Nothing else competes with amber; it means "live / active / attention".
In the resolved token set the accent maps to `tertiary-fixed-dim` (`#ffba20`, effectively the same amber).

### Surface ramp (elevation by fill, not shadow)

There is no Z-axis light. Elevation is communicated purely by stepping the surface fill and by hairline containment.

| Token | Hex | Level |
|-------|-----|-------|
| `surface-container-lowest` | `#0e0e0e` | Deepest well |
| `surface` / `background` / `surface-dim` | `#141313` | Base canvas (L1) |
| `surface-container-low` | `#1c1b1b` | Raised panel |
| `surface-container` | `#201f1f` | Interactive surface (L2) |
| `surface-container-high` | `#2a2a2a` | Hovered / focused container |
| `surface-container-highest` / `surface-variant` | `#353434` | Topmost inline layer |
| `surface-bright` | `#3a3939` | Brightest structural fill |

Text on surfaces: `on-surface` `#e5e2e1`, muted `on-surface-variant` `#c4c7c8`.

### Lines and outlines

| Token | Hex | Usage |
|-------|-----|-------|
| `outline` | `#8e9192` | Emphasized borders, focused input underline |
| `outline-variant` | `#444748` | Default hairlines between rows, columns, components (0.5-1px) |

Hairlines are the primary separators. Prefer 0.5px / 1px strokes over spacing to divide the layout.

### Inverse (overlays and modals)

Modals and menus have no shadow. They invert the screen: solid light background with dark text to command focus.

| Token | Hex |
|-------|-----|
| `inverse-surface` | `#e5e2e1` |
| `inverse-on-surface` | `#313030` |
| `inverse-primary` | `#5d5f5f` |

### Status / semantic

| Token | Hex |
|-------|-----|
| `error` | `#ffb4ab` |
| `on-error` | `#690005` |
| `error-container` | `#93000a` |
| `on-error-container` | `#ffdad6` |

### Full resolved token set

`primary #ffffff` / `on-primary #2f3131` / `primary-container #e2e2e2` / `on-primary-container #636565`
`secondary #c9c6c5` / `on-secondary #313030` / `secondary-container #4a4949` / `on-secondary-container #bab8b7`
`tertiary #ffffff` / `on-tertiary #412d00` / `tertiary-container #ffdea8` / `on-tertiary-container #845d00` / `tertiary-fixed-dim #ffba20`
`surface-tint #c6c6c7`

### CSS custom properties

```css
:root {
  /* brand */
  --color-brand-primary: #f5f5f5;
  --color-void: #0a0a0a;
  --color-accent: #ffb800;

  /* surfaces */
  --surface-lowest: #0e0e0e;
  --surface: #141313;
  --surface-low: #1c1b1b;
  --surface-container: #201f1f;
  --surface-high: #2a2a2a;
  --surface-highest: #353434;
  --surface-bright: #3a3939;

  /* content */
  --on-surface: #e5e2e1;
  --on-surface-variant: #c4c7c8;

  /* lines */
  --outline: #8e9192;
  --outline-variant: #444748;
  --hairline: #262626; /* brief-specified schematic hairline */

  /* inverse (overlays) */
  --inverse-surface: #e5e2e1;
  --inverse-on-surface: #313030;

  /* status */
  --error: #ffb4ab;
  --on-error: #690005;
  --error-container: #93000a;
  --on-error-container: #ffdad6;
}
```

---

## Typography

Type is the architecture of the system. Headlines are packed and structural; body/data is monospaced for
vertical alignment across ledger rows. Large display type may span black/white containers with
`mix-blend-mode: difference` for the signature negative-space shift.

**Families**
- **Space Grotesk** - headlines and display. Tight tracking and leading.
- **Space Mono** - body, data, inputs, code, labels, telemetry.

**Scale**

| Level | Family | Size | Weight | Line height | Letter spacing |
|-------|--------|------|--------|-------------|----------------|
| `display-xl` | Space Grotesk | 72px | 700 | 0.9em | -0.05em |
| `headline-lg` | Space Grotesk | 32px | 600 | 1.1em | -0.02em |
| `headline-lg-mobile` | Space Grotesk | 24px | 600 | 1.1em | -0.02em |
| `body-md` | Space Mono | 14px | 400 | 1.6em | -0.01em |
| `telemetry-sm` | Space Mono | 11px | 400 | 1em | 0.05em |
| `label-xs` | Space Mono | 10px | 500 | 1em | 0.1em |

Labels and telemetry tags are always UPPERCASE Space Mono.

```css
:root {
  --font-headline: 'Space Grotesk', sans-serif;
  --font-body: 'Space Mono', monospace;
}
.display-xl   { font: 700 72px/0.9 var(--font-headline); letter-spacing: -0.05em; }
.headline-lg  { font: 600 32px/1.1 var(--font-headline); letter-spacing: -0.02em; }
.body-md      { font: 400 14px/1.6 var(--font-body); letter-spacing: -0.01em; }
.telemetry-sm { font: 400 11px/1 var(--font-body); letter-spacing: 0.05em; text-transform: uppercase; }
.label-xs     { font: 500 10px/1 var(--font-body); letter-spacing: 0.1em; text-transform: uppercase; }
```

---

## Spacing and layout

Base grid is a **Structural Ledger Grid**: 1px hairlines define grid areas instead of whitespace, so the
interface reads like a technical schematic or financial ledger.

**Spacing tokens**

| Token | Value |
|-------|-------|
| `unit` | 4px (base) |
| `gutter` | 1px (hairline gutter) |
| `stack-sm` | 8px |
| `stack-md` | 16px |
| `stack-lg` | 32px |
| `margin-page` | 32px |

**Grid**
- 12 columns on desktop, fixed 32px page margins.
- Separate every component, row, and column with 0.5px / 1px hairline strokes (`outline-variant` `#444748`, or `#262626` per brief).
- Functional density: pack elements tightly, avoid breathable whitespace.

---

## Shape

Strictly geometric and sharp.

- **Zero radius** on every button, card, and input.
- **Faceted geometry**: primary actions use a 45-degree clipped corner (~4px chamfer) on top-right and bottom-left.
- Dividers are horizontal/vertical hairlines.

```css
.chamfer { clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px); }
```

---

## Elevation and texture

- **Flat layering.** Depth = surface-fill shift + hairline containment. No shadows, ever.
- **Overlays.** Modals/menus use a solid `inverse-surface` `#e5e2e1` background with dark text; they invert the color space rather than float.
- **Grain.** A global low-opacity (2-3%) film-grain overlay sits over the entire UI.

---

## Component conventions

- **Faceted buttons.** Solid `#F5F5F5` bg, `#0A0A0A` Space Mono text, 4px hard-clipped corners. No hover transition - instant color inversion to amber `#FFB800` on hover/active.
- **Ledger lists.** Rows separated by 0.5px horizontal hairlines, monospaced for column alignment. Row hover fills `#141313`.
- **Telemetry tags.** Small rectangular tags, 1px border, uppercase Space Mono 10px. Active state uses amber.
- **Input fields.** Bottom-border only (1px). Focus shifts border to `#F5F5F5`. No rounded corners.
- **Checkboxes / radios.** Square only, 1px stroke. Checked = solid amber fill, no check glyph (just a filled square).
- **Imagery.** Grayscale, increased contrast, heavy grain filter via CSS.
