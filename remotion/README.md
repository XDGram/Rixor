# Rixor videos (Remotion)

Programmatic motion video for Rixor, written in React with [Remotion](https://www.remotion.dev).
Source lives in this folder; rendered files go to `out/` (git-ignored).

## Commands

| Command | What it does |
| --- | --- |
| `npm run video:studio` | Open Remotion Studio to preview and scrub compositions live |
| `npm run video:render` | Render `RixorIntro` (1920×1080, 7.5s) to `out/rixor-intro.mp4` |
| `npm run video:render:square` | Render the 1080×1080 social cut to `out/rixor-intro-square.mp4` |
| `npm run video:still` | Export frame 60 of `RixorIntro` as a PNG |
| `npm run video:typecheck` | Type-check the video sources |

Any composition can be rendered directly: `npx remotion render <CompositionId> out/<file>.mp4`.
Props can be overridden at render time, e.g.
`npx remotion render RixorIntro out/custom.mp4 --props='{"tagline":"Save on your terms.","plans":["Flexible","1 year"]}'`.

## Layout

- `index.ts` – entry point (`registerRoot`)
- `Root.tsx` – registers compositions (id, size, fps, duration, default props, zod schema)
- `compositions/` – one file per video
- `theme.ts` – brand tokens mirrored from `src/styles.css`
- `fonts.ts` – self-hosted Inter (via `@fontsource/inter` + `@remotion/fonts`), so renders work offline
- `../remotion.config.ts` – CLI config (entry point, Tailwind v4, `public/` as static dir)

Files in `public/` are available with `staticFile('images/rixor-logo.svg')`.

## Installed tooling

| Package | Use |
| --- | --- |
| `remotion`, `@remotion/cli`, `@remotion/renderer`, `@remotion/bundler` | Core, Studio and rendering |
| `@remotion/player` | Embed a composition inside the Vite app (`<Player component={RixorIntro} … />`) |
| `@remotion/transitions` | Scene transitions (`fade`, `slide`, `wipe`, `flip`, …) via `TransitionSeries` |
| `@remotion/shapes`, `@remotion/paths` | SVG shapes and path animation (`evolvePath` draws the logo) |
| `@remotion/noise` | Perlin/simplex noise for organic motion |
| `@remotion/animation-utils` | CSS transform/interpolation helpers |
| `@remotion/layout-utils` | Text measurement and fit-text |
| `@remotion/media`, `@remotion/media-utils` | Video/audio embedding, audio visualisation |
| `@remotion/fonts`, `@fontsource/inter` | Local font loading |
| `@remotion/tailwind-v4` | Tailwind classes inside compositions |
| `@remotion/zod-types`, `zod` | Typed, editable composition props in Studio |
| `motion` | Motion (formerly Framer Motion) for UI animation in the Vite app itself |

All `remotion` / `@remotion/*` packages are pinned to the same exact version; Remotion requires
them to match. Upgrade them together with `npx remotion upgrade`.

## Rendering environment

- FFmpeg is bundled with Remotion; no system install required.
- On first render Remotion downloads Chrome Headless Shell. If that download is blocked
  (CI or sandboxed machines), point it at an existing headless Chromium:
  `REMOTION_BROWSER_EXECUTABLE=/path/to/chrome-headless-shell npm run video:render`.
- Remotion is free for individuals and companies of up to 3 people; larger companies need a
  [company license](https://www.remotion.pro/license).
