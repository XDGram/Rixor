// Rixor — 30-second film (1920×1080, 30 fps, 900 frames) with a frame-accurate soundtrack.
//
//    0.0– 8.0s  Cold open   real X posts about holding, hard cuts on black, the key words turn lime
//    8.0–10.0s  Hook        "Everyone says hold." / "Nobody pays you for it."
//   10.0–12.0s  Drop        full-lime "Rixor does.", then the promise
//   12.0–24.0s  The flow    connect → lock → earn $WIF → claim, on a phone mock-up
//   24.0–28.0s  Proof       three facts about the contracts
//   28.0–30.0s  End card    "Hold your bags. Get paid in $WIF."
//
// Sound: public/audio/rixor-film.wav, synthesised by remotion/audio/make-soundtrack.py from THIS frame map (120 BPM:
// one beat = 15 frames). If a frame number changes here, change it there and re-run the script.
//
// Style: pure black, flat lime, hard cuts and wipes. No glows or gradients.
// The posts in public/x are real screenshots supplied by the project owner; nothing in them is edited except the
// lime highlight drawn over them. Balances in the phone mock-up are examples and the frame says so.
import type { CSSProperties, ReactNode } from 'react'
import { AbsoluteFill, Audio, Easing, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { evolvePath } from '@remotion/paths'
import { z } from 'zod'
import { displayFamily, fontFamily } from '../fonts'
import { v2 } from '../theme'

export const rixorFilmSchema = z.object({
  /** Symbol of the lockable token shown in the mock-up. */
  token: z.string().min(1).max(8),
  /** Small line on the end card. */
  event: z.string(),
})
type Props = z.infer<typeof rixorFilmSchema>

export const RIXOR_FILM_FPS = 30
export const RIXOR_FILM_DURATION = 900

// ---- frame map (shared with make-soundtrack.py) ----------------------------------------------------------------
const POSTS = [
  { src: 'x/t1.png', h: 289, at: 8, hl: [310, 386, 210, 250] },
  { src: 'x/t2.png', h: 317, at: 56, hl: [310, 532, 210, 250] },
  { src: 'x/t3.png', h: 180, at: 96, hl: [232, 425, 36, 76] },
  { src: 'x/t4.png', h: 446, at: 134, hl: [379, 613, 312, 352] },
  { src: 'x/t5.png', h: 273, at: 168, hl: [31, 312, 161, 202] },
  { src: 'x/t6.png', h: 305, at: 194, hl: [30, 352, 210, 250] },
] as const
const POST_W = 1140
const POSTS_END = 224
const AT = { hook: 240, drop: 300, flow: 360, trust: 720, end: 840 } as const
const STEP = { connect: 0, lock: 60, earn: 180, claim: 270, end: 360 } as const // local to the flow
const EARNED = 1428.57

const C = { ...v2, black: '#000000', dim: '#5d5a52', bezel: '#161614', bezelLine: '#33322d' } as const
const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const OUT = Easing.bezier(0.16, 1, 0.3, 1)
const IN_OUT = Easing.bezier(0.65, 0, 0.35, 1)
const tween = (f: number, from: number, to: number, a = 0, b = 1, easing = OUT) => interpolate(f, [from, to], [a, b], { ...CLAMP, easing })
const display: CSSProperties = { fontFamily: displayFamily, fontWeight: 600, letterSpacing: '-0.035em' }
const num: CSSProperties = { fontVariantNumeric: 'tabular-nums' }
const fmt = (v: number, digits = 0) => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
/** Decaying camera shake after a hit at local frame 0. */
const shake = (t: number, amp: number, seed = 0) => (t < 0 || t > 14 ? 'translate(0px, 0px)' : `translate(${Math.sin(t * 2.3 + seed) * amp * Math.exp(-t / 3)}px, ${Math.cos(t * 1.9 + seed * 2) * amp * Math.exp(-t / 3)}px)`)

const MARK_PATHS = [
  'M4 5h14.2c7.5 0 12.8 4.7 12.8 11.2 0 4.1-2 7.6-5.5 9.6l-4.7-5.1c2.1-.9 3.4-2.4 3.4-4.5 0-2.8-2.2-4.7-5.5-4.7H9.8L4 5Z',
  'M4 31V21.1l12.7-9.2 5.1 5.4L4 31Z',
  'M15.6 22.6l5.3-4 10.2 12.4h-8.6l-6.9-8.4Z',
]
const Mark = ({ size, color = C.lime }: { size: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 36 36">{MARK_PATHS.map((d, i) => <path key={i} d={d} fill={color} />)}</svg>
)

// ---- elements adapted from Uiverse.io (MIT). CSS keyframes and :checked transitions are replaced by values
// computed from the current frame, so every render is deterministic.

/**
 * 3D rotating coin. Adapted from "black-rabbit-68" by JohnnyCSilva on Uiverse.io (tags: card, crypto, bitcoin,
 * rotating): the same construction (a thin edge bar with two faces and two inner faces in preserve-3d), recoloured
 * lime with a WIF face. `angle` 90 shows the face front-on.
 */
const Coin3D = ({ size, angle }: { size: number; angle: number }) => {
  const edge = 'linear-gradient(#b4e600, #2c3800)'
  const face: CSSProperties = { position: 'absolute', top: 0, width: size, height: size, borderRadius: '50%', overflow: 'hidden', backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }
  const front: CSSProperties = { ...face, background: C.lime, boxShadow: `inset 0 0 0 ${size * 0.055}px #a9d900, inset 0 0 0 ${size * 0.075}px rgba(28,26,21,0.35)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: displayFamily, fontWeight: 600, fontSize: size * 0.3, letterSpacing: '-0.03em', color: C.onLime }
  return (
    <div style={{ width: size, height: size, perspective: size * 5 }}>
      <div style={{ position: 'absolute', left: size * 0.45, top: 0, width: size * 0.1, height: size, background: edge, transformStyle: 'preserve-3d', transform: `rotateY(${angle}deg)` }}>
        <div style={{ ...face, background: edge, right: -size * 0.4, transform: 'rotateY(90deg)' }} />
        <div style={{ ...face, background: edge, left: -size * 0.4, transform: 'rotateY(-90deg)' }} />
        <div style={{ ...front, right: -size * 0.4, transform: 'rotateY(-90deg)' }}>WIF</div>
        <div style={{ ...front, left: -size * 0.4, transform: 'rotateY(90deg)' }}>WIF</div>
      </div>
    </div>
  )
}

/**
 * A box whose outline morphs into a tick. Adapted from "green-bobcat-29" by SelfMadeSystem on Uiverse.io (tags:
 * checkbox): the same single path and dash values; `draw` (0..1) draws the box, `checked` (0..1) morphs it.
 */
const UvCheck = ({ size, draw, checked, color = C.lime }: { size: number; draw: number; checked: number; color?: string }) => (
  <svg viewBox="0 0 64 64" width={size} height={size} style={{ overflow: 'visible' }}>
    <path
      d="M 0 16 V 56 A 8 8 90 0 0 8 64 H 56 A 8 8 90 0 0 64 56 V 8 A 8 8 90 0 0 56 0 H 8 A 8 8 90 0 0 0 8 V 16 L 32 48 L 64 16 V 8 A 8 8 90 0 0 56 0 H 8 A 8 8 90 0 0 0 8 V 56 A 8 8 90 0 0 8 64 H 56 A 8 8 90 0 0 64 56 V 16"
      pathLength={575.0541381835938}
      fill="none" stroke={color} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round"
      strokeDasharray={`${interpolate(checked, [0, 1], [241 * draw, 70.5096664428711])} 9999999`}
      strokeDashoffset={interpolate(checked, [0, 1], [0, -262.2723388671875])}
    />
  </svg>
)

/** Words rise out of a mask, one after another. */
const Words = ({ text, at, stagger = 3, style, out }: { text: string; at: number; stagger?: number; style?: CSSProperties; out?: number }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: '0.26em', ...style }}>
      {text.split(' ').map((w, i) => {
        const s = spring({ frame: frame - at - i * stagger, fps, config: { damping: 22, stiffness: 190, mass: 0.6 } })
        const leave = out === undefined ? 0 : tween(frame, out + i, out + i + 7, 0, 1, Easing.in(Easing.cubic))
        return (
          <span key={i} style={{ display: 'inline-block', overflow: 'hidden', paddingBottom: '0.14em', marginBottom: '-0.14em' }}>
            <span style={{ display: 'inline-block', transform: `translateY(${(1 - s) * 108 - leave * 108}%)`, opacity: Math.min(1, s * 1.6) * (1 - leave), color: w.includes('$WIF') ? C.lime : undefined }}>{w}</span>
          </span>
        )
      })}
    </div>
  )
}

/** A lime bar sweeps across and leaves the content behind it. */
const Wipe = ({ at, children, color = C.lime, frames = 12 }: { at: number; children: ReactNode; color?: string; frames?: number }) => {
  const p = tween(useCurrentFrame(), at, at + frames, 0, 1, IN_OUT)
  const right = Math.min(1, p * 2), left = Math.max(0, p * 2 - 1)
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <div style={{ clipPath: `inset(0 ${100 - left * 100}% 0 0)` }}>{children}</div>
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${left * 100}%`, width: `${(right - left) * 100}%`, background: color }} />
    </div>
  )
}

/** Full-frame lime panel crossing the screen; it covers everything exactly at `at`, where the scene changes. */
const Sweep = ({ at, stay }: { at: number; stay?: boolean }) => {
  const f = useCurrentFrame()
  if (f < at - 8 || f > at + 8 || (stay && f >= at)) return null
  return <AbsoluteFill style={{ background: C.lime, transform: `translateX(${tween(f, at - 8, at + 8, -100, 100, IN_OUT)}%)` }} />
}

// ------------------------------------------------------------------ 1. cold open: the posts

const Posts = () => {
  const f = useCurrentFrame()
  if (f < POSTS[0].at || f >= POSTS_END) return null
  const i = POSTS.reduce((acc, p, k) => (f >= p.at ? k : acc), 0)
  const post = POSTS[i]
  const last = i === POSTS.length - 1
  const t = f - post.at
  const S = 1.23
  const [x0, x1, y0, y1] = post.hl
  const mark = tween(t, 6, 16, 0, 1, IN_OUT)
  // The last post pushes in on its three words until the cut to black.
  const push = last ? tween(t, 10, POSTS_END - post.at, 0, 1, Easing.in(Easing.quad)) : 0
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  const zoom = (1 + t * 0.0012 + 0.05 * Math.exp(-t / 2.5)) * (1 + push * 1.7)
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', transform: shake(t, 9, i) }}>
        <div style={{ position: 'relative', width: POST_W, height: post.h, transformOrigin: last ? `${cx}px ${cy}px` : '50% 50%', transform: `translate(${-(cx - POST_W / 2) * S * push}px, ${-(cy - post.h / 2) * S * push}px) scale(${S * zoom})` }}>
          <Img src={staticFile(post.src)} style={{ position: 'absolute', inset: 0, width: POST_W, height: post.h }} />
          {/* multiply: the white words under the bar turn lime, the black stays black */}
          <div style={{ position: 'absolute', left: x0 - 8, top: y0 - 8, height: y1 - y0 + 16, width: (x1 - x0 + 16) * mark, background: C.lime, mixBlendMode: 'multiply' }} />
          <div style={{ position: 'absolute', left: x0 - 2, top: y1 + 5, height: 4, width: (x1 - x0 + 4) * mark, background: C.lime }} />
          {last && <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: y0 - 30, background: C.black, opacity: push * 1.6 }} />}
        </div>
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 150, top: 96, fontFamily, fontSize: 22, fontWeight: 600, letterSpacing: '0.2em', textTransform: 'uppercase', color: C.dim, opacity: 1 - push * 2 }}>Crypto Twitter · every cycle</div>
      <div style={{ position: 'absolute', left: 150, bottom: 92, display: 'flex', alignItems: 'center', gap: 22, opacity: 1 - push * 2 }}>
        <span style={{ fontFamily, ...num, fontSize: 22, fontWeight: 600, letterSpacing: '0.12em', color: C.ink }}>0{i + 1} / 0{POSTS.length}</span>
        <span style={{ display: 'flex', gap: 8 }}>{POSTS.map((_, k) => <span key={k} style={{ width: 44, height: 4, background: k <= i ? C.lime : '#2a2924' }} />)}</span>
      </div>
      <AbsoluteFill style={{ background: '#ffffff', opacity: 0.16 * Math.exp(-t / 1.4) }} />
    </AbsoluteFill>
  )
}

// ------------------------------------------------------------------ 2. hook

const Slam = ({ at, children, style }: { at: number; children: ReactNode; style?: CSSProperties }) => {
  const f = useCurrentFrame()
  if (f < at) return null
  const t = f - at
  return <div style={{ ...display, transformOrigin: '0% 60%', transform: `${shake(t, 12, at)} scale(${1 + 0.2 * (1 - tween(t, 0, 7))})`, ...style }}>{children}</div>
}

const Hook = () => {
  const f = useCurrentFrame()
  return (
    <AbsoluteFill style={{ background: C.black, justifyContent: 'center', padding: '0 150px', gap: 10 }}>
      <Slam at={0} style={{ fontSize: 158, lineHeight: 1.02, whiteSpace: 'nowrap', color: f >= 30 ? C.dim : C.ink }}>Everyone says hold.</Slam>
      <div style={{ minHeight: 162 }}><Slam at={30} style={{ fontSize: 158, lineHeight: 1.02, whiteSpace: 'nowrap', color: C.ink }}>Nobody pays you for it.</Slam></div>
    </AbsoluteFill>
  )
}

// ------------------------------------------------------------------ 3. the drop

const Drop = () => {
  const f = useCurrentFrame()
  const lift = tween(f, 18, 28, 0, 1, IN_OUT)
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <AbsoluteFill style={{ justifyContent: 'center', padding: '0 150px' }}>
        <Words text="Lock the bag you hold." at={21} stagger={2} style={{ ...display, fontSize: 150, lineHeight: 1.03, color: C.ink }} />
        <Words text="Earn $WIF." at={28} stagger={2} style={{ ...display, fontSize: 150, lineHeight: 1.03, color: C.lime, marginTop: 6 }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ background: C.lime, alignItems: 'center', justifyContent: 'center', transform: `translateY(${-lift * 100}%)` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 34, transform: `${shake(f, 14)} scale(${1 + 0.22 * (1 - tween(f, 0, 8))})` }}>
          <Mark size={190} color={C.onLime} />
          <span style={{ ...display, fontSize: 230, lineHeight: 1, color: C.onLime }}>Rixor does.</span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

// ------------------------------------------------------------------ 4. the flow (phone mock-up)

const PHONE = { w: 390, h: 760, scale: 1.2, cx: 1410, cy: 545 } as const
const STEPS = [
  { key: 'Connect', title: 'Connect your wallet.', sub: 'Your keys stay yours. Rixor never sees a key or a seed phrase.', chips: ['Self-custody', 'No sign-up', 'No new deposit'], hot: -1 },
  { key: 'Lock', title: 'Lock the bag you already hold.', sub: 'Pick your conviction. A longer commitment earns a bigger share.', chips: ['Flexible 0.5×', 'Committed 1.5×', 'Diamond 2.5×'], hot: 1 },
  { key: 'Earn', title: 'Earn $WIF every second.', sub: 'Paid from a prefunded reward pool. No emissions.', chips: [], hot: -1 },
  { key: 'Claim', title: 'Claim it. It is yours.', sub: '$WIF goes straight to your wallet.', chips: ['Claim any time', 'Rewards are never locked'], hot: -1 },
] as const
const stepStart = [STEP.connect, STEP.lock, STEP.earn, STEP.claim, STEP.end]
const TAPS = { connect: 15, tier: 105, term: 120, lock: 135, claim: 285 } as const
const COIN = { first: 2, every: 5, travel: 20, count: 13 } as const

const Tap = ({ at, x, y }: { at: number; x: number; y: number }) => {
  const t = useCurrentFrame() - at
  if (t < -8 || t > 14) return null
  const ring = tween(t, 0, 14)
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: 0, height: 0 }}>
      <div style={{ position: 'absolute', left: -46, top: -46, width: 92, height: 92, borderRadius: 92, border: `2px solid ${C.lime}`, opacity: t >= 0 ? 1 - ring : 0, transform: `scale(${0.4 + ring * 0.9})` }} />
      <div style={{ position: 'absolute', left: -18, top: -18, width: 36, height: 36, borderRadius: 36, background: C.ink, opacity: tween(t, -8, -3) * (1 - tween(t, 8, 14)), transform: `scale(${1 - (tween(t, -1, 2) - tween(t, 2, 8)) * 0.25})` }} />
    </div>
  )
}

const Coin = ({ size = 40 }: { size?: number }) => (
  <div style={{ width: size, height: size, borderRadius: size, background: C.lime, boxShadow: `inset 0 0 0 ${Math.max(2, size * 0.07)}px rgba(28,26,21,0.2)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: displayFamily, fontWeight: 600, fontSize: size * 0.3, letterSpacing: '-0.02em', color: C.onLime }}>WIF</div>
)

const LockIcon = ({ closed, size = 26, color = C.onLime }: { closed: number; size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.6" fill={color} fillOpacity={0.14} />
    <path d="M8 10.5V7.4a4 4 0 0 1 8 0v3.1" transform={`translate(0 ${(1 - closed) * -2.6}) rotate(${(1 - closed) * 26} 16 9)`} />
  </svg>
)

const Check = ({ p, size = 22, color = C.onLime }: { p: number; size?: number; color?: string }) => {
  const e = evolvePath(p, 'M5 12.5l4.6 4.6L19 7.5')
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.6 4.6L19 7.5" strokeDasharray={e.strokeDasharray} strokeDashoffset={e.strokeDashoffset} />
    </svg>
  )
}

const TABS = [
  { label: 'Explore', icon: 'M4 11l8-6.5 8 6.5v8.5h-5.5v-5h-5v5H4z' },
  { label: 'Portfolio', icon: 'M6 4.5h12l3.5 5-9.5 10-9.5-10z' },
  { label: 'lock', icon: '' },
  { label: 'Activity', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.5V12l3 2' },
  { label: 'Wallet', icon: 'M5 7c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5-3.1 2.5-7 2.5S5 8.4 5 7zm0 0v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V7m-14 5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5' },
] as const
const card: CSSProperties = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 26, padding: 22 }
const kicker: CSSProperties = { fontFamily, fontSize: 12.5, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.inkMute }

const PhoneScreen = ({ token }: { token: string }) => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  const press = (at: number) => (tween(f, at - 1, at + 2) - tween(f, at + 2, at + 8)) * 0.05
  // connect
  const connected = spring({ frame: f - TAPS.connect - 4, fps, config: { damping: 18, stiffness: 190 } })
  const toLock = tween(f, 45, 60, 0, 1, IN_OUT)
  // lock (local frame)
  const l = f - STEP.lock
  const typed = ['', '5', '50', '500', '5,000'][Math.max(0, Math.min(4, Math.floor((l - 8) / 6) + 1))]
  const tier = spring({ frame: f - TAPS.tier - 1, fps, config: { damping: 17, stiffness: 190 } })
  const term = tween(f, TAPS.term + 1, TAPS.term + 7)
  const locking = tween(f, TAPS.lock + 2, TAPS.lock + 14)
  const locked = spring({ frame: f - TAPS.lock - 15, fps, config: { damping: 12, stiffness: 200 } })
  const toPos = tween(l, 100, 118, 0, 1, IN_OUT)
  // earn / claim
  const e = f - STEP.earn
  const earnedNow = EARNED * tween(e, 20, 86, 0, 1, Easing.bezier(0.3, 0, 0.6, 1))
  const c = f - STEP.claim
  const claimIn = spring({ frame: c + 8, fps, config: { damping: 18, stiffness: 170 } })
  const claimed = spring({ frame: f - TAPS.claim - 4, fps, config: { damping: 14, stiffness: 190 } })
  const walletWif = EARNED * tween(f, TAPS.claim + 7, TAPS.claim + 35)
  const claimable = Math.max(0, earnedNow - walletWif)
  const tab = f < 45 ? 0 : l < 104 ? 2 : 1

  const screen = (x: number, opacity: number): CSSProperties => ({ position: 'absolute', left: 0, right: 0, top: 86, bottom: 0, padding: '8px 18px', transform: `translateX(${x}px)`, opacity })
  const chip = (active: number): CSSProperties => ({ flex: 1, textAlign: 'center', padding: '11px 0 10px', borderRadius: 16, fontFamily, fontSize: 13.5, fontWeight: 600, color: active > 0.5 ? C.onLime : C.inkSoft, position: 'relative', zIndex: 1 })

  return (
    <div style={{ position: 'absolute', inset: 0, background: C.paper, fontFamily, color: C.ink, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 86, padding: '40px 18px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Mark size={24} color={C.ink} /><span style={{ ...display, fontSize: 21 }}>Rixor</span></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 14px', borderRadius: 38, border: `1px solid ${C.line}`, background: C.surface, fontSize: 13.5, fontWeight: 600 }}>
          <span style={{ width: 8, height: 8, borderRadius: 8, background: connected > 0.5 ? C.lime : C.inkMute }} />
          <span style={num}>{connected > 0.5 ? '0x7A3f…91c2' : 'Connect'}</span>
        </div>
      </div>

      {/* A · connect */}
      <div style={screen(-toLock * 60, 1 - toLock)}>
        <div style={{ ...card, padding: 26, marginTop: 14 }}>
          <div style={kicker}>Conviction locks</div>
          <div style={{ ...display, fontSize: 38, lineHeight: 1.04, margin: '12px 0 12px' }}>Lock what you hold. Earn $WIF.</div>
          <div style={{ fontSize: 14.5, lineHeight: 1.5, color: C.inkSoft }}>No deposit of new money. Only you can withdraw your tokens.</div>
          <div style={{ marginTop: 22, height: 58, borderRadius: 58, background: C.lime, color: C.onLime, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontSize: 17, fontWeight: 600, transform: `scale(${1 - press(TAPS.connect)})` }}>
            {connected > 0.5 ? <><Check p={tween(f, TAPS.connect + 5, TAPS.connect + 14)} /> Wallet connected</> : 'Connect wallet'}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12, opacity: connected, transform: `translateY(${(1 - connected) * 16}px)` }}>
          <div style={{ ...card, padding: 18 }}><div style={kicker}>{token} in wallet</div><div style={{ ...display, ...num, fontSize: 30, marginTop: 8 }}>25,000</div></div>
          <div style={{ ...card, padding: 18 }}><div style={kicker}>Reward pool</div><div style={{ ...display, fontSize: 30, marginTop: 8, color: C.lime }}>$WIF</div></div>
        </div>
      </div>

      {/* B · lock form */}
      <div style={screen((1 - toLock) * 60 - toPos * 60, toLock * (1 - toPos))}>
        <div style={{ ...card, marginTop: 14 }}>
          <div style={kicker}>Lock {token}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '14px 0 4px', padding: '14px 16px', borderRadius: 18, background: C.surface2, border: `1px solid ${typed ? C.lime : C.line}` }}>
            <span style={{ ...display, ...num, fontSize: 44, lineHeight: 1 }}>
              {typed || <span style={{ color: C.inkMute }}>0</span>}
              <span style={{ display: 'inline-block', width: 3, height: 36, marginLeft: 3, background: C.lime, opacity: l < 40 && Math.floor(l / 8) % 2 === 0 ? 1 : 0, transform: 'translateY(5px)' }} />
            </span>
            <span style={{ fontSize: 16, fontWeight: 600, color: C.inkSoft }}>{token}</span>
          </div>
          <div style={{ fontSize: 12.5, color: C.inkMute }}>Balance 25,000 {token}</div>
          <div style={{ ...kicker, marginTop: 20 }}>Tier</div>
          <div style={{ position: 'relative', display: 'flex', marginTop: 9, padding: 4, borderRadius: 20, background: C.surface2, border: `1px solid ${C.line}` }}>
            <div style={{ position: 'absolute', top: 4, bottom: 4, left: 4, width: 'calc((100% - 8px) / 3)', borderRadius: 16, background: C.lime, transform: `translateX(${tier * 100}%)` }} />
            <div style={chip(1 - tier)}>Flexible<br /><span style={{ fontWeight: 500, opacity: 0.75 }}>0.5×</span></div>
            <div style={chip(tier)}>Committed<br /><span style={{ fontWeight: 500, opacity: 0.75 }}>1.5×</span></div>
            <div style={chip(0)}>Diamond<br /><span style={{ fontWeight: 500, opacity: 0.75 }}>2.5×</span></div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, opacity: tier, transform: `translateY(${(1 - tier) * 10}px)` }}>
            {['30 days', '60 days', '90 days'].map((d, i) => (
              <div key={d} style={{ padding: '9px 14px', borderRadius: 30, fontSize: 13, fontWeight: 600, border: `1px solid ${i === 0 && term > 0.5 ? C.lime : C.line}`, color: i === 0 && term > 0.5 ? C.lime : C.inkSoft }}>{d}</div>
            ))}
          </div>
          <div style={{ marginTop: 20, height: 58, borderRadius: 58, background: C.lime, color: C.onLime, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontSize: 17, fontWeight: 600, transform: `scale(${1 - press(TAPS.lock) + (locked - tween(f, TAPS.lock + 19, TAPS.lock + 27)) * 0.04})` }}>
            <LockIcon closed={locked} size={22} />
            {locked > 0.5 ? 'Locked' : locking > 0 ? 'Locking…' : `Lock ${token}`}
          </div>
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: C.inkMute, padding: '14px 6px 0' }}>Committed exits early for a fee that falls to zero. Flexible exits any time, free.</div>
      </div>

      {/* C · position, earning, claim */}
      <div style={screen((1 - toPos) * 60, toPos)}>
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <div style={{ width: 50, height: 50, borderRadius: 16, background: C.lime, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><LockIcon closed={1} /></div>
            <div style={{ flex: 1 }}>
              <div style={{ ...display, ...num, fontSize: 25 }}>5,000 {token}</div>
              <div style={{ fontSize: 13, color: C.inkSoft, marginTop: 2 }}>Committed · 1.5× · 30 days</div>
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: C.lime, padding: '7px 11px', borderRadius: 30, border: `1px solid ${C.lime}` }}>Open</div>
          </div>
        </div>
        <div style={{ ...card, marginTop: 12, borderColor: e > 18 ? C.lime : C.line }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={kicker}>{claimed > 0.5 ? 'WIF claimable' : 'WIF earned'}</div>
            <div style={{ fontSize: 12.5, color: C.inkMute, ...num }}>≈ 714 WIF / day</div>
          </div>
          <div style={{ ...display, ...num, fontSize: 60, lineHeight: 1, marginTop: 12, color: C.lime }}>{fmt(claimable, 2)}</div>
          <div style={{ height: 8, borderRadius: 8, background: C.surface2, marginTop: 18, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${2 + tween(e, 20, 86, 0, 1, Easing.bezier(0.3, 0, 0.6, 1)) * 26}%`, borderRadius: 8, background: C.lime }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: C.inkMute, marginTop: 9 }}><span>Reward stream · prefunded</span><span>Day {e < 52 ? 1 : 2} of 7</span></div>
          <div style={{ marginTop: 18 * claimIn, height: 58 * claimIn, borderRadius: 58, overflow: 'hidden', opacity: claimIn, transform: `scale(${1 - press(TAPS.claim)})`, background: claimed > 0.5 ? C.surface2 : C.lime, color: claimed > 0.5 ? C.lime : C.onLime, border: `1px solid ${C.lime}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontSize: 17, fontWeight: 600, ...num }}>
            {claimed > 0.5 ? <><Check p={tween(f, TAPS.claim + 5, TAPS.claim + 15)} color={C.lime} /> Claimed {fmt(EARNED, 2)} WIF</> : `Claim ${fmt(EARNED, 2)} WIF`}
          </div>
        </div>
        <div style={{ ...card, marginTop: 12, padding: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div><div style={kicker}>WIF in your wallet</div><div style={{ ...display, ...num, fontSize: 30, marginTop: 6 }}>{fmt(walletWif, 2)}</div></div>
          <div style={{ transform: `scale(${1 + (tween(f, TAPS.claim + 6, TAPS.claim + 11) - tween(f, TAPS.claim + 11, TAPS.claim + 22)) * 0.25})` }}><Coin size={46} /></div>
        </div>
      </div>

      {/* bottom tab bar, as in the app */}
      <div style={{ position: 'absolute', left: 14, right: 14, bottom: 16, height: 70, borderRadius: 70, background: C.ink, display: 'flex', alignItems: 'center', justifyContent: 'space-around', padding: '0 10px' }}>
        {TABS.map((t, i) => {
          if (t.label === 'lock') return <div key={i} style={{ width: 54, height: 54, borderRadius: 54, background: C.lime, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: tab === 2 ? `0 0 0 4px ${C.onLime}` : 'none' }}><LockIcon closed={1} size={24} /></div>
          const on = i === tab
          return (
            <div key={i} style={{ width: 62, height: 52, borderRadius: 26, background: on ? 'rgba(28,26,21,0.1)' : 'transparent', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, color: on ? C.onLime : '#7d796f', fontSize: 10.5, fontWeight: 600 }}>
              <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
              {t.label}
            </div>
          )
        })}
      </div>

      <Tap at={TAPS.connect} x={195} y={353} />
      <Tap at={TAPS.tier} x={195} y={339} />
      <Tap at={TAPS.term} x={62} y={405} />
      <Tap at={TAPS.lock} x={195} y={474} />
      <Tap at={TAPS.claim} x={195} y={434} />
    </div>
  )
}

const Phone = ({ token }: { token: string }) => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  const rise = spring({ frame: f - 3, fps, config: { damping: 19, stiffness: 130 } })
  const hit = (at: number, amount: number) => (f < at ? 0 : amount * Math.exp(-(f - at) / 3) * Math.cos((f - at) * 0.9))
  const pulse = hit(TAPS.lock + 15, 0.035) + hit(TAPS.claim + 4, 0.03)
  return (
    <div style={{ position: 'absolute', left: PHONE.cx - PHONE.w / 2, top: PHONE.cy - PHONE.h / 2, width: PHONE.w, height: PHONE.h, transform: `translateY(${(1 - rise) * 900}px) scale(${PHONE.scale * (1 + pulse)})` }}>
      <div style={{ position: 'absolute', inset: -12, borderRadius: 66, background: C.bezel, border: `2px solid ${C.bezelLine}` }} />
      <div style={{ position: 'absolute', inset: 0, borderRadius: 54, overflow: 'hidden' }}>
        <PhoneScreen token={token} />
        <div style={{ position: 'absolute', left: '50%', top: 12, width: 112, height: 31, marginLeft: -56, borderRadius: 31, background: '#000' }} />
      </div>
    </div>
  )
}

/** WIF coins travelling from the reward pool into the phone; the soundtrack pings as each one lands. */
const CoinStream = () => {
  const e = useCurrentFrame() - STEP.earn
  if (e < 0 || e > 90) return null
  const from = { x: 606, y: 866 }, c1 = { x: 900, y: 980 }, c2 = { x: 1010, y: 470 }, to = { x: PHONE.cx - (PHONE.w / 2) * PHONE.scale + 40, y: PHONE.cy - 96 }
  return (
    <>
      {Array.from({ length: COIN.count }, (_, i) => {
        const t = (e - COIN.first - i * COIN.every) / COIN.travel
        if (t <= 0 || t >= 1) return null
        const u = IN_OUT(t), m = 1 - u
        const x = m * m * m * from.x + 3 * m * m * u * c1.x + 3 * m * u * u * c2.x + u * u * u * to.x
        const y = m * m * m * from.y + 3 * m * m * u * c1.y + 3 * m * u * u * c2.y + u * u * u * to.y
        return <div key={i} style={{ position: 'absolute', left: x - 29, top: y - 29, opacity: Math.min(1, t * 8, (1 - t) * 6), transform: `scale(${0.75 + Math.sin(u * Math.PI) * 0.4})` }}><Coin3D size={58} angle={90 + e * 16 + i * 47} /></div>
      })}
    </>
  )
}

const ClaimBurst = () => {
  const t = useCurrentFrame() - TAPS.claim - 4
  if (t < 0 || t > 34) return null
  return (
    <>
      {Array.from({ length: 16 }, (_, i) => {
        const a = (i / 16) * Math.PI * 2 + 0.3
        const d = tween(t, 0, 26) * (210 + (i % 4) * 80)
        const x = PHONE.cx + Math.cos(a) * d * 1.3, y = PHONE.cy + 60 + Math.sin(a) * d + tween(t, 10, 34, 0, 1, Easing.in(Easing.quad)) * 110
        return <div key={i} style={{ position: 'absolute', left: x - 21, top: y - 21, opacity: 1 - tween(t, 18, 34), transform: `scale(${1.15 - tween(t, 0, 34) * 0.35}) rotate(${t * 9 + i * 30}deg)` }}><Coin size={42} /></div>
      })}
    </>
  )
}

const Flow = ({ token }: Props) => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  const active = f < STEP.lock ? 0 : f < STEP.earn ? 1 : f < STEP.claim ? 2 : 3
  const pool = tween(f, STEP.earn - 2, STEP.earn + 8) * (1 - tween(f, STEP.claim - 8, STEP.claim))
  const sent = Math.max(0, Math.min(COIN.count, Math.floor((f - STEP.earn - COIN.first) / COIN.every) + 1))
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <div style={{ position: 'absolute', left: 150, top: 236, width: 720 }}>
        <div style={{ display: 'flex' }}>
          {STEPS.map((s, i) => (
            <div key={s.key} style={{ flex: 1, display: 'flex', alignItems: 'baseline', gap: 10, fontFamily, color: i === active ? C.ink : i < active ? C.inkSoft : C.dim }}>
              <span style={{ ...num, fontSize: 17, fontWeight: 600, color: i <= active ? C.lime : C.dim }}>0{i + 1}</span>
              <span style={{ fontSize: 24, fontWeight: 600 }}>{s.key}</span>
            </div>
          ))}
        </div>
        <div style={{ height: 3, background: C.line, marginTop: 16 }}>
          <div style={{ height: '100%', background: C.lime, width: `${STEPS.reduce((w, _, i) => w + tween(f, stepStart[i], stepStart[i] + 10, 0, 25, IN_OUT), 0)}%` }} />
        </div>
      </div>

      {STEPS.map((s, i) => {
        const from = stepStart[i], to = stepStart[i + 1]
        if (f < from - 2 || f > to + 4) return null
        const out = i === STEPS.length - 1 ? undefined : to - 10
        return (
          <div key={s.key} style={{ position: 'absolute', left: 150, top: 366, width: 940 }}>
            <Words text={s.title} at={from + 2} out={out} style={{ ...display, fontSize: 96, lineHeight: 1.02, color: C.ink }} />
            <div style={{ fontFamily, fontSize: 33, lineHeight: 1.35, color: C.inkSoft, marginTop: 30, maxWidth: 720, opacity: tween(f, from + 12, from + 22) * (out === undefined ? 1 : 1 - tween(f, out, out + 6)), transform: `translateY(${(1 - tween(f, from + 12, from + 24)) * 16}px)` }}>{s.sub}</div>
            <div style={{ display: 'flex', gap: 14, marginTop: 44 }}>
              {s.chips.map((text, k) => {
                const p = spring({ frame: f - from - 18 - k * 4, fps, config: { damping: 14, stiffness: 190 } }) * (out === undefined ? 1 : 1 - tween(f, out - 2, out + 4))
                const hot = k === s.hot && f >= TAPS.tier + 1
                return <div key={text} style={{ fontFamily, ...num, fontSize: 26, fontWeight: 600, padding: '15px 26px', borderRadius: 60, color: hot ? C.onLime : C.ink, background: hot ? C.lime : C.surface, border: `1px solid ${hot ? C.lime : C.line}`, opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * 22}px) scale(${0.92 + p * 0.08})` }}>{text}</div>
              })}
            </div>
          </div>
        )
      })}

      <div style={{ position: 'absolute', left: 150, top: 810, width: 440, padding: '22px 26px', borderRadius: 28, background: C.surface, border: `1px solid ${C.lime}`, opacity: pool, transform: `translateY(${(1 - pool) * 24}px)`, display: 'flex', alignItems: 'center', gap: 18 }}>
        <Coin3D size={62} angle={90 + (f - STEP.earn) * 5} />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily, fontSize: 17, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.inkMute }}>$WIF pool · prefunded</div>
          <div style={{ height: 8, borderRadius: 8, background: C.surface2, marginTop: 14, overflow: 'hidden' }}><div style={{ height: '100%', width: `${100 - (sent / COIN.count) * 26}%`, borderRadius: 8, background: C.lime }} /></div>
        </div>
      </div>

      <Phone token={token} />
      <CoinStream />
      <ClaimBurst />
      <div style={{ position: 'absolute', left: 150, bottom: 54, fontFamily, fontSize: 18, color: C.inkMute, opacity: tween(f, 14, 28) }}>Illustrative product preview. Balances and amounts are examples.</div>
    </AbsoluteFill>
  )
}

// ------------------------------------------------------------------ 5. proof: $WIF, Robinhood Chain, safety

const FACTS = [
  { at: 0, title: 'Paid in $WIF.', body: 'World Is Flat: the token every Rixor reward is paid in. 0x5173…4773' },
  { at: 30, title: 'Built for Robinhood Chain.', body: 'Fees so low that a lock costs about a cent in gas.' },
  { at: 60, title: 'Only you can withdraw.', body: 'Two 2-of-3 Safes. No upgrade path. Rewards are prefunded.' },
] as const

const Proof = () => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  const coinIn = spring({ frame: f - 2, fps, config: { damping: 13, stiffness: 150 } })
  const kick = FACTS.reduce((a, x) => a + (f >= x.at ? 150 * (1 - Math.exp(-(f - x.at) / 5)) : 0), 0) // each slam spins the coin on
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <AbsoluteFill style={{ padding: '0 150px', justifyContent: 'center', gap: 46 }}>
        {FACTS.map((x, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 40, transform: shake(f - x.at, 8, i) }}>
            <div style={{ paddingTop: 30, opacity: f >= x.at ? 1 : 0 }}>
              <UvCheck size={58} draw={tween(f, x.at, x.at + 6)} checked={tween(f, x.at + 8, x.at + 20, 0, 1, IN_OUT)} />
            </div>
            <div>
              <Wipe at={x.at} frames={11}><div style={{ ...display, fontSize: 112, lineHeight: 1.05, color: C.ink, paddingRight: 12, whiteSpace: 'nowrap' }}>{x.title.split('$WIF').map((part, k) => <span key={k}>{k > 0 && <span style={{ color: C.lime }}>$WIF</span>}{part}</span>)}</div></Wipe>
              <div style={{ fontFamily, ...num, fontSize: 31, color: C.inkSoft, marginTop: 8, opacity: tween(f, x.at + 9, x.at + 18) }}>{x.body}</div>
            </div>
          </div>
        ))}
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 1680 - 140, top: 540 - 170, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26, transform: `scale(${coinIn})` }}>
        <Coin3D size={280} angle={90 + f * 3 + kick} />
        <div style={{ fontFamily, fontSize: 22, fontWeight: 600, letterSpacing: '0.18em', textTransform: 'uppercase', color: C.inkMute }}>World Is Flat</div>
      </div>
    </AbsoluteFill>
  )
}

// ------------------------------------------------------------------ 6. end card

const EndCard = ({ event }: Props) => {
  const f = useCurrentFrame()
  const ink = C.onLime
  return (
    <AbsoluteFill style={{ background: C.lime, alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, opacity: tween(f, 12, 22), marginBottom: 34 }}>
        <Mark size={72} color={ink} />
        <span style={{ ...display, fontSize: 80, lineHeight: 1, color: ink }}>Rixor</span>
      </div>
      <div style={{ ...display, fontSize: 196, lineHeight: 1.0, color: ink, transform: `${shake(f, 14)} scale(${1 + 0.2 * (1 - tween(f, 0, 8))})` }}>Hold your bags.</div>
      <div style={{ ...display, fontSize: 196, lineHeight: 1.0, color: ink, opacity: f >= 8 ? 1 : 0, transform: `scale(${1 + 0.2 * (1 - tween(f, 8, 16))})` }}>Get paid in $WIF.</div>
      <div style={{ fontFamily, fontSize: 32, fontWeight: 500, color: ink, marginTop: 40, opacity: tween(f, 20, 30) * 0.8 }}>{event}</div>
      <div style={{ position: 'absolute', bottom: 50, fontFamily, fontSize: 18, color: ink, opacity: tween(f, 24, 34) * 0.7, textAlign: 'center' }}>
        Tested, not audited. $WIF carries no promise of value or return. Rixor is not affiliated with Robinhood Markets, Inc. or with the accounts quoted.
      </div>
    </AbsoluteFill>
  )
}

// ------------------------------------------------------------------ composition

export const RixorFilm = (props: Props) => (
  <AbsoluteFill style={{ backgroundColor: C.black }}>
    <Audio src={staticFile('audio/rixor-film.wav')} />
    <Sequence durationInFrames={AT.hook} layout="none"><Posts /></Sequence>
    <Sequence from={AT.hook} durationInFrames={AT.drop - AT.hook} layout="none"><Hook /></Sequence>
    <Sequence from={AT.drop} durationInFrames={AT.flow - AT.drop} layout="none"><Drop /></Sequence>
    <Sequence from={AT.flow} durationInFrames={AT.trust - AT.flow} layout="none"><Flow {...props} /></Sequence>
    <Sequence from={AT.trust} durationInFrames={AT.end - AT.trust} layout="none"><Proof /></Sequence>
    <Sequence from={AT.end} layout="none"><EndCard {...props} /></Sequence>
    <Sweep at={AT.flow} />
    <Sweep at={AT.trust} />
    <Sweep at={AT.end} stay />
  </AbsoluteFill>
)
