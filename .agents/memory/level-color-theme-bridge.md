---
name: Level/palette colors need html.light bridge overrides
description: Any raw Tailwind palette class emitted for level/subject coloring must have a matching html.light override in index.css or it breaks light mode.
---

# Level color theme-awareness

`getLevelColor()` / `getSubjectColor()` in `client/src/lib/subjectColors.ts` return
`{hex,bg,border,ring,label}` where `bg`/`border`/`label` are raw Tailwind palette
classes (e.g. `bg-blue-500/15`). These are applied as classes in JSX (not inline hex)
so they can be re-tinted for light mode.

**Rule:** every palette class returned by these helpers MUST have a matching
`html.light .<class> { ... }` override in the bridge block of `client/src/index.css`
(the `html.light .bg-*/.border-*/.text-*` section). Without it, the dark-tuned
translucent palette color renders unreadable in light mode.

**Why:** the app is true dual-theme via a manual `html.light` bridge, not automatic
dark: variants. A palette opacity that isn't in the bridge (e.g. `bg-blue-500/15`,
`border-violet-400/30`) silently falls through to its dark value in light mode.

**How to apply:** when adding/changing a level or subject color, prefer palette
families+opacities that ALREADY have bridge entries (emerald/amber/violet-500/blue-500
bg+border, and text-*-400). If you must introduce a new one, add the `html.light`
override in the same change. The violet-400 bg/border had no bridge — University level
was switched to violet-500 to reuse existing overrides.
