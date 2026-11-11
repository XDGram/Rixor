# Rixor videos (Remotion)

Programmatic motion video for Rixor, written in React with [Remotion](https://www.remotion.dev).
Source lives in this folder; rendered files go to `out/` (git-ignored).

## Commands

| Command | What it does |
| --- | --- |
| `npm run video:studio` | Open Remotion Studio to preview and scrub compositions live |
| `npm run video:render` | Render `RixorIntro` (1920×1080, 7.5s) to `out/rixor-intro.mp4` |
| `npm run video:render:film` | Render `RixorFilm`, the 30-second film with sound (1920×1080, 30 fps), to `out/rixor-film.mp4` |
| `npm run video:sound` | Re-synthesise the film's soundtrack to `public/audio/rixor-film.wav` (Python 3 + numpy) |
| `npm run video:render:demo` | Render `RixorDemo`, the 25-second V2 product demo (1920×1080, 30 fps), to `out/rixor-demo.mp4` |
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
- `theme.ts` – brand tokens mirrored from `src/styles.css` (`v2`: the V2 app's dark theme, accent `#c8ff00`)
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

## RixorDemo (V2, 25 s)

Hook → logo → the four-step flow on a phone mock-up (connect wallet, lock, earn $WIF, claim) → three facts about the
contracts → end card. Props: `token` (symbol shown in the mock-up, default `MEME`) and `event` (end-card line), e.g.
`npx remotion render RixorDemo out/rixor-demo.mp4 --props='{"token":"HOOKR","event":"World Is Flat hackathon"}'`.

Every balance and amount in the mock-up is an example, and the frame says so. The video shows the product flow; it is
not transaction proof and shows no transaction hash or "confirmed on chain" claim. It has no audio track.

## RixorFilm (30 s, with sound)

| Time | Scene |
|---|---|
| 0–8 s | Cold open: real X posts about holding, hard cuts on black, the key words turn lime |
| 8–10 s | "Everyone says hold." / "Nobody pays you for it." |
| 10–12 s | Full-lime "Rixor does.", then "Lock the bag you hold. Earn $WIF." |
| 12–24 s | The flow on a phone mock-up: connect, lock, earn $WIF, claim |
| 24–28 s | "Paid in $WIF." / "Built for Robinhood Chain." / "Only you can withdraw." |
| 28–30 s | End card: "Hold your bags. Get paid in $WIF." |

**Sound.** `remotion/audio/make-soundtrack.py` synthesises the whole track with numpy (no samples, nothing
downloaded): a drone and a hit on every post, a riser into silence, slams on the hook lines, then 120 BPM music
(one beat = 15 frames) with interface sounds on the exact frames where the picture changes (taps, typing, the lock,
a ping as each coin lands, the claim). The frame map at the top of the script mirrors the one in
`compositions/RixorFilm.tsx`; change both together and re-run `npm run video:sound`.

**Posts.** `public/x/t1–t6.png` are real screenshots supplied by the project owner (right-edge scrollbar cropped,
background set to pure black; text and avatars untouched). Rixor is not affiliated with the accounts quoted, and the
end card says so.

**Uiverse.io elements (MIT).** Two elements from the open-source [Uiverse.io](https://uiverse.io) library
(`uiverse-io/galaxy`) are adapted in `RixorFilm.tsx`, with their CSS animations replaced by frame-driven values:

- 3D rotating coin: "black-rabbit-68" by **JohnnyCSilva** (recoloured lime, WIF face) → `Coin3D`
- Box-to-tick checkbox: "green-bobcat-29" by **SelfMadeSystem** → `UvCheck`

Balances in the phone mock-up are examples and the frame says so; the film shows no transaction hash and makes no
"confirmed on chain" claim. Props: `token` (default `MEME`) and `event`.
