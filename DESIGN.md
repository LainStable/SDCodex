---
name: Obsidian Codex
colors:
  surface: '#0f131c'
  surface-dim: '#0f131c'
  surface-bright: '#353943'
  surface-container-lowest: '#0a0e17'
  surface-container-low: '#181b25'
  surface-container: '#1c1f29'
  surface-container-high: '#262a34'
  surface-container-highest: '#31353f'
  on-surface: '#dfe2ef'
  on-surface-variant: '#c7c4d7'
  inverse-surface: '#dfe2ef'
  inverse-on-surface: '#2c303a'
  outline: '#908fa0'
  outline-variant: '#464554'
  surface-tint: '#c0c1ff'
  primary: '#c0c1ff'
  on-primary: '#1000a9'
  primary-container: '#8083ff'
  on-primary-container: '#0d0096'
  inverse-primary: '#494bd6'
  secondary: '#4cd7f6'
  on-secondary: '#003640'
  secondary-container: '#03b5d3'
  on-secondary-container: '#00424e'
  tertiary: '#d0bcff'
  on-tertiary: '#3c0091'
  tertiary-container: '#a078ff'
  on-tertiary-container: '#340080'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e1e0ff'
  primary-fixed-dim: '#c0c1ff'
  on-primary-fixed: '#07006c'
  on-primary-fixed-variant: '#2f2ebe'
  secondary-fixed: '#acedff'
  secondary-fixed-dim: '#4cd7f6'
  on-secondary-fixed: '#001f26'
  on-secondary-fixed-variant: '#004e5c'
  tertiary-fixed: '#e9ddff'
  tertiary-fixed-dim: '#d0bcff'
  on-tertiary-fixed: '#23005c'
  on-tertiary-fixed-variant: '#5516be'
  background: '#0f131c'
  on-background: '#dfe2ef'
  surface-variant: '#31353f'
  slate-bg: '#0F172A'
  slate-surface: '#1E293B'
  slate-border: '#334155'
  status-active: '#10B981'
  status-warning: '#F59E0B'
  status-alert: '#EF4444'
  badge-flux: '#EC4899'
  badge-sdxl: '#06B6D4'
  badge-lora: '#8B5CF6'
  badge-checkpoint: '#6366F1'
typography:
  display-lg:
    fontFamily: Geist
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 44px
    letterSpacing: -0.025em
  display-lg-mobile:
    fontFamily: Geist
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 34px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Geist
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  code-md:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 18px
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.04em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.06em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-tablet: 0.75rem
  gutter-desktop: 1.25rem
  margin: 1rem
  margin-tablet: 1.5rem
  margin-desktop: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1.25rem
  space-xl: 2rem
---

## Brand & Style

This design system establishes a high-performance, dark-mode-first aesthetic crafted for AI researchers, digital artists, and generative systems engineers managing checkpoints, LoRAs, and workflow plugins. It balances technical precision with tactile depth—delivering a workstation environment that feels simultaneously authoritative, compact, and luminous.

The visual style merges **Glassmorphism** with **Technical Minimalism**:
- Translucent dark surfaces layered over deep obsidian and slate backdrops.
- Crisp hairline borders (`1px`) with subtle directional gradients to catch light.
- Vibrant, hyper-saturated chromatic accents (indigo, cyan, electric violet) reserved for execution states, telemetry indicators, model architectures, and primary calls to action.
- Data density is prioritized: compact gutters, monospaced metadata arrays, and distinct visual badges ensure thousands of generative weights and configurations remain immediately scannable.

## Colors

The palette leverages a deep obsidian canvas (`#090D16`) paired with tiered slate tonal planes (`#0F172A` and `#1E293B`) to eliminate visual fatigue during sustained workstation sessions. Vibrant accents pierce through the dark layers to organize dense generative model catalogs:

- **Primary Accent (`#6366F1`)**: Indigo is used for interactive focal points, active state highlights, primary action triggers, and standard Checkpoint models.
- **Secondary Accent (`#06B6D4`)**: Electric Cyan communicates real-time operations, throughput, live execution monitors, and SDXL architecture classification.
- **Tertiary Accent (`#8B5CF6`)**: Deep Violet identifies LoRA modules, plug-in extensions, and active socket endpoints.
- **Telemetry & Status Variables**:
  - `status-active` (`#10B981`): Operational `socket: rw`, mounted volumes, healthy Docker containers.
  - `status-warning` (`#F59E0B`): Restricted access `socket: ro`, low GPU VRAM warning thresholds.
  - `status-alert` (`#EF4444`): Missing dependencies, broken pipelines, container disconnects.
- **Model Taxonomy Colors**: Specific badges use distinct hue bands to make disparate GenAI weights immediately recognizable within large asset grids.

## Typography

Typography prioritizes functional legibility across intense numerical and alphanumeric density:

- **Headlines & Structural Titles (Geist)**: Provides geometric clarity with modern, tight letterform tracking. Used across section titles, dashboard overviews, modal caps, and workspace headers.
- **Interface & Descriptive Body (Inter)**: Handles descriptive documentation, setup guides, release notes, and configuration copy. Highly readable at small viewports without fatigue.
- **Metadata, Tags, File Metrics & Telemetry (JetBrains Mono)**: Strictly assigned to model hashes, parameter counts (`12B`, `70B`), file size designations (`6.42 GB`), socket designations (`socket: rw`), keyboard shortcuts (`/`), and command line invocations. All tags and tabular matrices utilize monospaced numerical spacing to prevent horizontal layout shift during live background data fetching.

## Layout & Spacing

This design system uses an ultra-compact fluid grid architecture optimized for large multi-pane displays, split-screen model comparisons, and floating parameter panels.

- **Grid Architecture**: 12-column dynamic fluid grid for primary workstation windows; collapsible to 8-column for tablet inspector drawers and single-column for responsive administrative viewports.
- **Rhythm Model**: Spacing adheres to a strict 4px base increment (`0.25rem` up to `2rem`). Micro gaps (`space-xs` and `space-sm`) structure dense tag clusters, tabular metadata, and socket indicators. Macro gaps (`space-lg` and `space-xl`) isolate operational modules and card boundaries.
- **Breakpoints**:
  - `Mobile (<640px)`: Single column layout, permanent bottom drawer navigation, margins at `1rem`.
  - `Tablet (640px - 1024px)`: Compact two-tier pane with collapsible model properties drawer, gutters at `0.75rem`.
  - `Desktop (>1024px)`: Full multi-pane asset catalog, persistent left sidebar, center asset matrix, dynamic right-side telemetry panel, gutters at `1.25rem`.

## Elevation & Depth

Visual hierarchy uses physical glass layering and edge-lit border boundaries instead of heavy drop shadows, preserving clarity on dark OLED and IPS displays:

- **Base Layer (L0 - Background)**: Solid `#090D16` canvas. Holds background patterns, subtle radial gradients, and structural dividers.
- **Surface Layer (L1 - Workspace Cards & Tables)**: `#0F172A` at `80%` opacity with a `backdrop-blur(12px)` and a directional hairline border: `1px solid rgba(255, 255, 255, 0.08)`.
- **Raised Interactive Layer (L2 - Popovers, Dropdowns, Hovered Cards)**: `#1E293B` at `90%` opacity with `backdrop-blur(16px)`, paired with an ambient tinted glow: `box-shadow: 0 8px 32px -4px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(99, 102, 241, 0.15)`.
- **Overlay Layer (L3 - Modal Dialogs & Sidecar Update Banners)**: `#0F172A` at `95%` opacity, framed by a high-visibility border `1px solid rgba(255, 255, 255, 0.15)` and an ambient shadow `0 24px 48px -12px rgba(0, 0, 0, 0.85)`.
- **Edge Highlighting**: Focused and active interactive containers implement a sharp top-edge gradient shimmer (`linear-gradient(90deg, transparent, rgba(99, 102, 241, 0.4), transparent)`) to communicate physical depth and computational responsiveness.

## Shapes

The design system employs a refined, technical **Soft (`1`)** shape language that evokes scientific instrumentation and modern IDE tools:

- Standard controls (input fields, command inputs, list group rows): `0.25rem` (4px).
- Containers, model catalog cards, code blocks, alert boxes: `0.5rem` (8px).
- Outer window frames, primary workstation modals: `0.75rem` (12px).
- Metadata badges, socket pills, tags: fully rounded pill shapes or precise `0.25rem` micro-capsules to distinguish taxonomic metadata from structural frames.

## Components

### Buttons
- **Primary Action**: Solid background (`#6366F1`) transitioning to Indigo Light (`#818CF8`) on hover. Label set in Geist/Inter Semibold, text `#FFFFFF`. Subtle internal highlight border on top edge (`1px solid rgba(255,255,255,0.2)`).
- **Secondary / Ghost Action**: `#1E293B` with `1px solid rgba(255, 255, 255, 0.1)`. Hover shifts background to `#334155` and accentuates border with primary cyan or violet tint.
- **Destructive Action**: `#1E293B` container with border `rgba(239, 68, 68, 0.4)` and text `#EF4444`. On hover, background shifts to `rgba(239, 68, 68, 0.15)`.

### Chips & Model Badges
- High-contrast, compact capsules displaying model architecture and operational flags.
- **Flux**: Background `rgba(236, 72, 153, 0.12)`, border `1px solid rgba(236, 72, 153, 0.35)`, text `#F472B6`.
- **SDXL**: Background `rgba(6, 182, 212, 0.12)`, border `1px solid rgba(6, 182, 212, 0.35)`, text `#22D3EE`.
- **LoRA**: Background `rgba(139, 92, 246, 0.12)`, border `1px solid rgba(139, 92, 246, 0.35)`, text `#A78BFA`.
- **Checkpoint**: Background `rgba(99, 102, 241, 0.12)`, border `1px solid rgba(99, 102, 241, 0.35)`, text `#818CF8`.
- Set strictly in `label-sm` (JetBrains Mono, uppercase, bold).

### Status Indicators (Sockets & Telemetry)
- Formatted as compound pills composed of an active glow pip and monospace descriptor:
  - `socket: rw`: Green pip (`#10B981`) with faint radial pulse glow (`box-shadow: 0 0 8px rgba(16, 185, 129, 0.5)`), text `#10B981`.
  - `socket: ro`: Amber pip (`#F59E0B`), text `#FCD34D`.
  - `socket: missing`: Red pip (`#EF4444`), text `#F87171`.

### Data Cards (Model & Plugin Items)
- Built on `L1 Surface` (`#0F172A` with `backdrop-blur`).
- Header area features a preview asset thumbnail with model badge overlays, followed by headline title, parameter metrics, model hash, and target directory path in `code-sm`.
- Hover state raises container elevation subtly via border transition to `rgba(99, 102, 241, 0.4)` and background glow.

### Input Fields & Quick Command Search
- Surface color `#090D16` set inside `#1E293B` boundary, `1px` border with `rgba(255, 255, 255, 0.1)`.
- Focus state reveals a luminous focus ring: `border-color: #6366F1; box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25)`.
- Quick-search fields incorporate trailing hotkey capsules (e.g. `'/'` or `'⌘K'`) set in `code-sm` with subtle inset backgrounds (`rgba(255, 255, 255, 0.05)`).

### Form Controls (Checkboxes & Radios)
- Custom square (`0.25rem` radius) or circular controls in `#0F172A` with `1px solid #334155`.
- Active state renders a solid `#6366F1` fill with a high-contrast white checkmark icon or pip.

### Tables & Dense Lists
- Row height fixed at compact 36px or 44px intervals.
- Alternating subtle rows (`#090D16` to `#0F172A` at `50%`).
- Table headers set in `label-md`, uppercase, color `#64748B`. Dividers styled with crisp `1px solid rgba(255, 255, 255, 0.06)`.