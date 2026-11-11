// Rixor V2 — 25-second motion demo (1920×1080, 30 fps, 750 frames).
//
//   0.0– 3.0s  Hook           "You already hold the meme. Get paid to keep it."
//   3.0– 4.5s  Logo sting
//   4.5–18.5s  The flow       connect wallet → lock → earn $WIF → claim, on a phone mock-up
//  18.5–22.0s  Trust          three facts about the contracts
//  22.0–25.0s  End card
//
// Every balance and amount in the phone mock-up is an EXAMPLE (the frame says so). The video shows the product flow;
// it is not transaction proof and shows no transaction hash, explorer link or "confirmed on chain" claim.
import { noise2D } from '@remotion/noise'
import { evolvePath } from '@remotion/paths'
import type { CSSProperties, ReactNode } from 'react'
import { AbsoluteFill, Easing, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { z } from 'zod'
import { displayFamily, fontFamily } from '../fonts'
import { v2 as C } from '../theme'

export const rixorDemoSchema = z.object({
  /** Symbol of the lockable token shown in the mock-up. */
  token: z.string().min(1).max(8),
  /** Small line on the end card. */
  event: z.string(),
})
type Props = z.infer<typeof rixorDemoSchema>

export const RIXOR_DEMO_FPS = 30
export const RIXOR_DEMO_DURATION = 750

const T = { hook: 90, logo: 45, flow: 420, trust: 105, end: 90 } as const
const FLOW = { connect: 0, lock: 90, earn: 210, claim: 330, end: 420 } as const
const OVERLAP = 8

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const OUT = Easing.bezier(0.16, 1, 0.3, 1)
const IN_OUT = Easing.bezier(0.65, 0, 0.35, 1)
const tween = (f: number, from: number, to: number, a = 0, b = 1, easing = OUT) => interpolate(f, [from, to], [a, b], { ...CLAMP, easing })

const MARK_PATHS = [
  'M4 5h14.2c7.5 0 12.8 4.7 12.8 11.2 0 4.1-2 7.6-5.5 9.6l-4.7-5.1c2.1-.9 3.4-2.4 3.4-4.5 0-2.8-2.2-4.7-5.5-4.7H9.8L4 5Z',
  'M4 31V21.1l12.7-9.2 5.1 5.4L4 31Z',
  'M15.6 22.6l5.3-4 10.2 12.4h-8.6l-6.9-8.4Z',
]
const display: CSSProperties = { fontFamily: displayFamily, fontWeight: 600, letterSpacing: '-0.035em' }
const num: CSSProperties = { fontVariantNumeric: 'tabular-nums' }
const fmt = (v: number, digits = 0) => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

// ------------------------------------------------------------------ shared pieces

const Mark = ({ size, color = C.lime, draw = 1 }: { size: number; color?: string; draw?: number }) => (
  <svg width={size} height={size} viewBox="0 0 36 36">
    {MARK_PATHS.map((d, i) => {
      const p = Math.min(1, Math.max(0, draw * 1.5 - i * 0.25))
      const e = evolvePath(p, d)
      return <path key={i} d={d} fill={color} fillOpacity={Math.max(0, draw * 2 - 1)} stroke={color} strokeWidth={0.7} strokeDasharray={e.strokeDasharray} strokeDashoffset={e.strokeDashoffset} />
    })}
  </svg>
)

/** Words rise out of a mask, one after another. */
const Words = ({ text, at, stagger = 3, style, out }: { text: string; at: number; stagger?: number; style?: CSSProperties; out?: number }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: '0.26em', ...style }}>
      {text.split(' ').map((w, i) => {
        const s = spring({ frame: frame - at - i * stagger, fps, config: { damping: 22, stiffness: 170, mass: 0.7 } })
        const leave = out === undefined ? 0 : tween(frame, out + i, out + i + 9, 0, 1, Easing.in(Easing.cubic))
        return (
          <span key={i} style={{ display: 'inline-block', overflow: 'hidden', paddingBottom: '0.14em', marginBottom: '-0.14em' }}>
            <span style={{ display: 'inline-block', transform: `translateY(${(1 - s) * 108 - leave * 108}%)`, opacity: Math.min(1, s * 1.6) * (1 - leave) }}>{w}</span>
          </span>
        )
      })}
    </div>
  )
}

const Backdrop = () => {
  const frame = useCurrentFrame()
  const gx = 50 + noise2D('gx', frame / 260, 0) * 16
  const gy = 42 + noise2D('gy', 0, frame / 260) * 12
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      <AbsoluteFill style={{ background: `radial-gradient(900px 620px at ${gx}% ${gy}%, rgba(200,255,0,0.105), transparent 68%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(760px 560px at ${100 - gx}% ${118 - gy}%, rgba(242,240,232,0.05), transparent 70%)` }} />
      <AbsoluteFill
        style={{
          backgroundImage: 'linear-gradient(rgba(242,240,232,0.034) 1px, transparent 1px), linear-gradient(90deg, rgba(242,240,232,0.034) 1px, transparent 1px)',
          backgroundSize: '96px 96px',
          backgroundPosition: `${-(frame * 0.18) % 96}px ${-(frame * 0.1) % 96}px`,
          maskImage: 'radial-gradient(ellipse 75% 70% at 50% 50%, black 30%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(ellipse 75% 70% at 50% 50%, black 30%, transparent 100%)',
        }}
      />
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.5) 100%)' }} />
    </AbsoluteFill>
  )
}

const Grain = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ opacity: 0.07, mixBlendMode: 'overlay', pointerEvents: 'none' }}>
      <svg width="100%" height="100%">
        <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={frame % 12} /><feColorMatrix type="saturate" values="0" /></filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
    </AbsoluteFill>
  )
}

/** Scene wrapper: soft scale/blur in and out, so neighbouring scenes cross-dissolve over OVERLAP frames. */
const Scene = ({ duration, children, first, last }: { duration: number; children: ReactNode; first?: boolean; last?: boolean }) => {
  const frame = useCurrentFrame()
  const enter = first ? 1 : tween(frame, 0, OVERLAP + 4)
  const exit = last ? 0 : tween(frame, duration - OVERLAP, duration, 0, 1, Easing.in(Easing.cubic))
  return (
    <AbsoluteFill style={{ opacity: enter * (1 - exit), transform: `scale(${0.985 + enter * 0.015 + exit * 0.03})`, filter: `blur(${(1 - enter) * 10 + exit * 12}px)` }}>
      {children}
    </AbsoluteFill>
  )
}

// ------------------------------------------------------------------ 1. hook

const Hook = () => {
  const frame = useCurrentFrame()
  const sweep = tween(frame, 34, 62)
  return (
    <AbsoluteFill style={{ justifyContent: 'center', padding: '0 170px' }}>
      <div style={{ ...display, fontWeight: 500, fontSize: 30, letterSpacing: '0.16em', textTransform: 'uppercase', color: C.inkMute, marginBottom: 34, opacity: tween(frame, 2, 14) }}>
        Conviction locks · Robinhood Chain
      </div>
      <Words text="You already hold the meme." at={3} style={{ ...display, fontSize: 124, lineHeight: 1.02, color: C.ink }} />
      <div style={{ position: 'relative', marginTop: 14, alignSelf: 'flex-start' }}>
        <Words text="Get paid to keep it." at={34} stagger={4} style={{ ...display, fontSize: 164, lineHeight: 1.02, color: C.lime }} />
        <div style={{ position: 'absolute', left: 0, bottom: -14, height: 8, borderRadius: 8, width: `${sweep * 100}%`, background: C.lime, opacity: 0.9 }} />
      </div>
    </AbsoluteFill>
  )
}

// ------------------------------------------------------------------ 2. logo sting

const LogoSting = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const draw = tween(frame, 2, 26, 0, 1, IN_OUT)
  const word = spring({ frame: frame - 12, fps, config: { damping: 20, stiffness: 150 } })
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 34 }}>
        <Mark size={190} draw={draw} />
        <div style={{ overflow: 'hidden' }}>
          <div style={{ ...display, fontSize: 210, color: C.ink, lineHeight: 1, transform: `translateX(${(1 - word) * -110}%)`, opacity: word }}>Rixor</div>
        </div>
      </div>
      <div style={{ fontFamily, fontSize: 38, color: C.inkSoft, marginTop: 30, opacity: tween(frame, 20, 32), transform: `translateY(${(1 - tween(frame, 20, 34)) * 18}px)` }}>
        Lock a meme you hold. Earn <span style={{ color: C.lime, fontWeight: 600 }}>$WIF</span>.
      </div>
    </AbsoluteFill>
  )
}

// ------------------------------------------------------------------ 3. the flow (phone mock-up)

const PHONE = { w: 390, h: 760, scale: 1.2, cx: 1410, cy: 545 } as const
const STEPS = [
  { key: 'Connect', title: 'Connect your wallet.', sub: 'Your keys stay yours. Rixor never sees a key or a seed phrase.', chips: ['Self-custody', 'No sign-up', 'No new deposit'], hot: -1 },
  { key: 'Lock', title: 'Lock the meme you already hold.', sub: 'Pick your conviction. A longer commitment earns a bigger share.', chips: ['Flexible 0.5×', 'Committed 1.5×', 'Diamond 2.5×'], hot: 1 },
  { key: 'Earn', title: 'Earn $WIF every second.', sub: 'Paid from a prefunded reward pool. No emissions.', chips: [], hot: -1 },
  { key: 'Claim', title: 'Claim it. It is yours.', sub: '$WIF goes straight to your wallet.', chips: ['Claim any time', 'Rewards are never locked'], hot: -1 },
] as const
const stepStart = [FLOW.connect, FLOW.lock, FLOW.earn, FLOW.claim, FLOW.end]
const EARNED = 1428.57

const Tap = ({ at, x, y }: { at: number; x: number; y: number }) => {
  const frame = useCurrentFrame()
  const t = frame - at
  if (t < -10 || t > 16) return null
  const appear = tween(t, -10, -3)
  const press = tween(t, -1, 3) - tween(t, 3, 9)
  const ring = tween(t, 0, 16)
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: 0, height: 0, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: -46, top: -46, width: 92, height: 92, borderRadius: 92, border: `2px solid ${C.lime}`, opacity: (1 - ring) * 0.9 * (t >= 0 ? 1 : 0), transform: `scale(${0.4 + ring * 0.9})` }} />
      <div style={{ position: 'absolute', left: -19, top: -19, width: 38, height: 38, borderRadius: 38, background: 'rgba(242,240,232,0.92)', boxShadow: '0 6px 18px rgba(0,0,0,0.45)', opacity: appear * (1 - tween(t, 10, 16)), transform: `scale(${1 - press * 0.22})` }} />
    </div>
  )
}

const Coin = ({ size = 40 }: { size?: number }) => (
  <div style={{ width: size, height: size, borderRadius: size, background: `radial-gradient(circle at 32% 28%, #f0ff9a, ${C.lime} 46%, #93bd00)`, boxShadow: `0 0 ${size * 0.5}px rgba(200,255,0,0.42), inset 0 -${size * 0.07}px ${size * 0.14}px rgba(0,0,0,0.25)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: displayFamily, fontWeight: 600, fontSize: size * 0.3, letterSpacing: '-0.02em', color: C.onLime }}>
    WIF
  </div>
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
  { label: 'Explore', icon: 'M4 11l8-6.500 8 6.500v8.500h-5.500v-5h-5v5H4z' },
  { label: 'Portfolio', icon: 'M6 4.500h12l3.500 5-9.500 10-9.500-10z' },
  { label: 'lock', icon: '' },
  { label: 'Activity', icon: 'M12 3.500a8.500 8.500 0 1 0 0 17 8.500 8.500 0 0 0 0-17zM12 7.500V12l3 2' },
  { label: 'Wallet', icon: 'M5 7c0-1.400 3.100-2.500 7-2.500s7 1.100 7 2.500-3.100 2.500-7 2.500S5 8.400 5 7zm0 0v5c0 1.400 3.100 2.500 7 2.500s7-1.100 7-2.500V7m-14 5v5c0 1.400 3.100 2.500 7 2.500s7-1.100 7-2.500v-5' },
] as const
const card: CSSProperties = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 26, padding: 22 }
const kicker: CSSProperties = { fontFamily, fontSize: 12.5, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.inkMute }

const PhoneScreen = ({ token }: { token: string }) => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  // --- connect
  const connected = spring({ frame: f - 44, fps, config: { damping: 18, stiffness: 160 } })
  // --- lock (local frame)
  const l = f - FLOW.lock
  const typed = ['', '5', '50', '500', '5,000'][Math.max(0, Math.min(4, Math.floor((l - 8) / 6) + 1))]
  const tier = spring({ frame: l - 44, fps, config: { damping: 17, stiffness: 170 } })
  const term = tween(l, 56, 64)
  const locking = tween(l, 80, 92)
  const locked = spring({ frame: l - 92, fps, config: { damping: 13, stiffness: 160 } })
  // --- screens
  const toLock = tween(f, 72, 90, 0, 1, IN_OUT)
  const toPos = tween(l, 100, 118, 0, 1, IN_OUT)
  // --- earn / claim (local frames)
  const e = f - FLOW.earn
  const earnedNow = EARNED * tween(e, 6, 108, 0, 1, Easing.bezier(0.3, 0, 0.5, 1))
  const c = f - FLOW.claim
  const claimIn = spring({ frame: c + 8, fps, config: { damping: 18, stiffness: 150 } })
  const claimed = spring({ frame: c - 24, fps, config: { damping: 14, stiffness: 160 } })
  const walletWif = EARNED * tween(c, 30, 58)
  const claimable = Math.max(0, earnedNow - walletWif)
  const tab = f < 78 ? 0 : l < 104 ? 2 : 1

  const screen = (x: number, opacity: number): CSSProperties => ({ position: 'absolute', left: 0, right: 0, top: 86, bottom: 0, padding: '8px 18px', transform: `translateX(${x}px)`, opacity })
  const chip = (active: number): CSSProperties => ({ flex: 1, textAlign: 'center', padding: '11px 0 10px', borderRadius: 16, fontFamily, fontSize: 13.5, fontWeight: 600, color: active > 0.5 ? C.onLime : C.inkSoft, position: 'relative', zIndex: 1 })

  return (
    <div style={{ position: 'absolute', inset: 0, background: C.paper, fontFamily, color: C.ink, overflow: 'hidden' }}>
      {/* status + app bar */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 86, padding: '40px 18px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Mark size={24} color={C.ink} />
          <span style={{ ...display, fontSize: 21 }}>Rixor</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 14px', borderRadius: 38, border: `1px solid ${C.line}`, background: C.surface, fontSize: 13.5, fontWeight: 600 }}>
          <span style={{ width: 8, height: 8, borderRadius: 8, background: connected > 0.5 ? C.lime : C.inkMute, boxShadow: connected > 0.5 ? `0 0 10px ${C.lime}` : 'none' }} />
          <span style={{ ...num, fontFamily }}>{connected > 0.5 ? '0x7A3f…91c2' : 'Connect'}</span>
        </div>
      </div>

      {/* A · connect */}
      <div style={screen(-toLock * 60, 1 - toLock)}>
        <div style={{ ...card, padding: 26, marginTop: 14 }}>
          <div style={kicker}>Conviction locks</div>
          <div style={{ ...display, fontSize: 38, lineHeight: 1.04, margin: '12px 0 12px' }}>Lock what you hold. Earn $WIF.</div>
          <div style={{ fontSize: 14.5, lineHeight: 1.5, color: C.inkSoft }}>No deposit of new money. Only you can withdraw your tokens.</div>
          <div style={{ marginTop: 22, height: 58, borderRadius: 58, background: C.lime, color: C.onLime, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontSize: 17, fontWeight: 600, transform: `scale(${1 - (tween(f, 38, 42) - tween(f, 42, 48)) * 0.045})` }}>
            {connected > 0.5 ? <><Check p={tween(f, 46, 58)} /> Wallet connected</> : 'Connect wallet'}
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
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '14px 0 4px', padding: '14px 16px', borderRadius: 18, background: C.surface2, border: `1px solid ${typed ? 'rgba(200,255,0,0.45)' : C.line}` }}>
            <span style={{ ...display, ...num, fontSize: 44, lineHeight: 1 }}>
              {typed || <span style={{ color: C.inkMute }}>0</span>}
              <span style={{ display: 'inline-block', width: 3, height: 36, marginLeft: 3, background: C.lime, opacity: l < 44 && Math.floor(l / 8) % 2 === 0 ? 1 : 0, transform: 'translateY(5px)' }} />
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
              <div key={d} style={{ padding: '9px 14px', borderRadius: 30, fontSize: 13, fontWeight: 600, border: `1px solid ${i === 0 && term > 0.5 ? C.lime : C.line}`, color: i === 0 && term > 0.5 ? C.lime : C.inkSoft, background: i === 0 ? `rgba(200,255,0,${term * 0.1})` : 'transparent' }}>{d}</div>
            ))}
          </div>

          <div style={{ marginTop: 20, height: 58, borderRadius: 58, background: C.lime, color: C.onLime, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontSize: 17, fontWeight: 600, transform: `scale(${1 - (tween(l, 76, 80) - tween(l, 80, 86)) * 0.045 + (locked - tween(l, 96, 104)) * 0.03})` }}>
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
            <div style={{ fontSize: 12.5, fontWeight: 600, color: C.lime, padding: '7px 11px', borderRadius: 30, background: 'rgba(200,255,0,0.1)' }}>Open</div>
          </div>
        </div>

        <div style={{ ...card, marginTop: 12, borderColor: `rgba(200,255,0,${0.16 + tween(e, 0, 20) * 0.26})` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={kicker}>{claimed > 0.5 ? 'WIF claimable' : 'WIF earned'}</div>
            <div style={{ fontSize: 12.5, color: C.inkMute, ...num }}>≈ 714 WIF / day</div>
          </div>
          <div style={{ ...display, ...num, fontSize: 60, lineHeight: 1, marginTop: 12, color: C.lime }}>{fmt(claimable, 2)}</div>
          <div style={{ height: 8, borderRadius: 8, background: C.surface2, marginTop: 18, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${2 + tween(e, 6, 108, 0, 1, Easing.bezier(0.3, 0, 0.5, 1)) * 26}%`, borderRadius: 8, background: `linear-gradient(90deg, #8fb800, ${C.lime})` }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: C.inkMute, marginTop: 9 }}><span>Reward stream · prefunded</span><span>Day {e < 60 ? 1 : 2} of 7</span></div>

          <div style={{ marginTop: 18 * claimIn, height: 58 * claimIn, borderRadius: 58, overflow: 'hidden', opacity: claimIn, transform: `translateY(${(1 - claimIn) * 14}px) scale(${1 - (tween(c, 18, 22) - tween(c, 22, 28)) * 0.045})`, background: claimed > 0.5 ? C.surface2 : C.lime, color: claimed > 0.5 ? C.lime : C.onLime, border: `1px solid ${claimed > 0.5 ? 'rgba(200,255,0,0.45)' : C.lime}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontSize: 17, fontWeight: 600, ...num }}>
            {claimed > 0.5 ? <><Check p={tween(c, 26, 38)} color={C.lime} /> Claimed {fmt(EARNED, 2)} WIF</> : `Claim ${fmt(EARNED, 2)} WIF`}
          </div>
        </div>

        <div style={{ ...card, marginTop: 12, padding: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div><div style={kicker}>WIF in your wallet</div><div style={{ ...display, ...num, fontSize: 30, marginTop: 6 }}>{fmt(walletWif, 2)}</div></div>
          <div style={{ transform: `scale(${0.9 + claimed * 0.1 + (tween(c, 30, 36) - tween(c, 36, 46)) * 0.18})` }}><Coin size={46} /></div>
        </div>
      </div>

      {/* bottom tab bar, as in the app */}
      <div style={{ position: 'absolute', left: 14, right: 14, bottom: 16, height: 70, borderRadius: 70, background: C.ink, display: 'flex', alignItems: 'center', justifyContent: 'space-around', padding: '0 10px', boxShadow: '0 14px 30px rgba(0,0,0,0.5)' }}>
        {TABS.map((t, i) => {
          if (t.label === 'lock') {
            const on = tab === 2 ? 1 : 0
            return <div key={i} style={{ width: 54, height: 54, borderRadius: 54, background: C.lime, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: on ? '0 0 0 5px rgba(200,255,0,0.28)' : 'none' }}><LockIcon closed={1} size={24} /></div>
          }
          const on = i === tab
          return (
            <div key={i} style={{ width: 62, height: 52, borderRadius: 26, background: on ? 'rgba(28,26,21,0.1)' : 'transparent', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, color: on ? C.onLime : '#7d796f', fontSize: 10.5, fontWeight: 600 }}>
              <svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
              {t.label}
            </div>
          )
        })}
      </div>

      {/* taps (screen coordinates) */}
      <Tap at={40} x={195} y={353} />
      <Tap at={FLOW.lock + 43} x={195} y={339} />
      <Tap at={FLOW.lock + 57} x={62} y={405} />
      <Tap at={FLOW.lock + 78} x={195} y={474} />
      <Tap at={FLOW.claim + 20} x={195} y={434} />
    </div>
  )
}

const Phone = ({ token }: { token: string }) => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  const rise = spring({ frame: f - 2, fps, config: { damping: 20, stiffness: 90, mass: 1.1 } })
  const bob = Math.sin(f / 26) * 6
  const ry = interpolate(f, [0, T.flow], [-13, -5], CLAMP)
  const bump = (at: number) => spring({ frame: f - at, fps, config: { damping: 9, stiffness: 180 }, durationInFrames: 26 }) - tween(f, at + 4, at + 22)
  const pulse = bump(FLOW.lock + 92) * 0.018 + bump(FLOW.claim + 24) * 0.022
  return (
    <div style={{ position: 'absolute', left: PHONE.cx - PHONE.w / 2, top: PHONE.cy - PHONE.h / 2, width: PHONE.w, height: PHONE.h, perspective: 2200 }}>
      <div style={{ position: 'absolute', inset: -90, borderRadius: 200, background: 'radial-gradient(closest-side, rgba(200,255,0,0.2), transparent)', filter: 'blur(40px)', opacity: rise * (0.7 + pulse * 12) }} />
      <div style={{ width: '100%', height: '100%', transform: `translateY(${(1 - rise) * 240 + bob}px) scale(${PHONE.scale * (0.9 + rise * 0.1 + pulse)}) rotateY(${ry}deg) rotateX(3deg)`, opacity: Math.min(1, rise * 1.4), transformStyle: 'preserve-3d' }}>
        <div style={{ position: 'absolute', inset: -11, borderRadius: 66, background: 'linear-gradient(145deg, #3b3932, #15140f 42%, #2a2822)', boxShadow: '0 60px 120px rgba(0,0,0,0.6), 0 0 0 1.5px rgba(242,240,232,0.1), inset 0 0 0 2px rgba(0,0,0,0.6)' }} />
        <div style={{ position: 'absolute', inset: 0, borderRadius: 56, overflow: 'hidden' }}>
          <PhoneScreen token={token} />
          <div style={{ position: 'absolute', left: '50%', top: 12, width: 112, height: 31, marginLeft: -56, borderRadius: 31, background: '#000' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(118deg, rgba(255,255,255,0.07) 0%, transparent 26%)', pointerEvents: 'none' }} />
        </div>
      </div>
    </div>
  )
}

/** WIF coins travelling from the reward pool into the phone while the position earns. */
const CoinStream = () => {
  const f = useCurrentFrame() - FLOW.earn
  if (f < 0 || f > 126) return null
  // From the reward pool to the phone's left edge, level with the "WIF earned" counter.
  const from = { x: 606, y: 866 }, ctl1 = { x: 900, y: 980 }, ctl2 = { x: 1010, y: 470 }, to = { x: PHONE.cx - (PHONE.w / 2) * PHONE.scale + 46, y: PHONE.cy - 96 }
  return (
    <>
      {Array.from({ length: 27 }, (_, i) => {
        const t = (f - 6 - i * 3.6) / 30
        if (t <= 0 || t >= 1) return null
        const u = IN_OUT(t), m = 1 - u
        const x = m * m * m * from.x + 3 * m * m * u * ctl1.x + 3 * m * u * u * ctl2.x + u * u * u * to.x
        const y = m * m * m * from.y + 3 * m * m * u * ctl1.y + 3 * m * u * u * ctl2.y + u * u * u * to.y + Math.sin(i * 2.1) * 26 * Math.sin(u * Math.PI)
        const s = 0.72 + Math.sin(u * Math.PI) * 0.42
        return <div key={i} style={{ position: 'absolute', left: x - 22, top: y - 22, opacity: Math.min(1, t * 6, (1 - t) * 3.2), transform: `scale(${s}) rotate(${u * 220 + i * 40}deg)` }}><Coin size={44} /></div>
      })}
    </>
  )
}

/** Coins bursting out of the phone when the reward is claimed. */
const ClaimBurst = () => {
  const f = useCurrentFrame() - FLOW.claim - 24
  if (f < 0 || f > 40) return null
  return (
    <>
      {Array.from({ length: 16 }, (_, i) => {
        const a = (i / 16) * Math.PI * 2 + 0.3
        const d = tween(f, 0, 30) * (190 + (i % 4) * 70)
        const x = PHONE.cx + Math.cos(a) * d * 1.25, y = PHONE.cy + 70 + Math.sin(a) * d - tween(f, 0, 40) * 60 + tween(f, 12, 40, 0, 1, Easing.in(Easing.quad)) * 90
        return <div key={i} style={{ position: 'absolute', left: x - 17, top: y - 17, opacity: 1 - tween(f, 16, 36), transform: `scale(${1.15 - tween(f, 0, 40) * 0.35}) rotate(${f * 9 + i * 30}deg)` }}><Coin size={42} /></div>
      })}
    </>
  )
}

const Flow = ({ token }: Props) => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  const active = f < FLOW.lock ? 0 : f < FLOW.earn ? 1 : f < FLOW.claim ? 2 : 3
  const pool = tween(f, FLOW.earn - 4, FLOW.earn + 12) * (1 - tween(f, FLOW.claim - 6, FLOW.claim + 6))
  const drained = tween(f, FLOW.earn + 6, FLOW.earn + 114)
  return (
    <AbsoluteFill>
      {/* step rail */}
      <div style={{ position: 'absolute', left: 150, top: 236, width: 720, opacity: tween(f, 4, 18) }}>
        <div style={{ display: 'flex' }}>
          {STEPS.map((s, i) => (
            <div key={s.key} style={{ flex: 1, display: 'flex', alignItems: 'baseline', gap: 10, fontFamily, color: i === active ? C.ink : i < active ? C.inkSoft : C.inkMute }}>
              <span style={{ ...num, fontSize: 17, fontWeight: 600, color: i <= active ? C.lime : C.inkMute }}>0{i + 1}</span>
              <span style={{ fontSize: 24, fontWeight: 600 }}>{s.key}</span>
            </div>
          ))}
        </div>
        <div style={{ height: 3, borderRadius: 3, background: C.line, marginTop: 16, overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: 3, background: C.lime, width: `${STEPS.reduce((w, _, i) => w + tween(f, stepStart[i], stepStart[i + 1], 0, 25, Easing.linear), 0)}%` }} />
        </div>
      </div>

      {/* captions: one per step, each rises in and leaves before the next */}
      {STEPS.map((s, i) => {
        const from = stepStart[i], to = stepStart[i + 1]
        if (f < from - 2 || f > to + 12) return null
        const lastStep = i === STEPS.length - 1
        const out = lastStep ? undefined : to - 12
        return (
          <div key={s.key} style={{ position: 'absolute', left: 150, top: 366, width: 940 }}>
            <Words text={s.title} at={from + 4} out={out} style={{ ...display, fontSize: 96, lineHeight: 1.02, color: C.ink }} />
            <div style={{ fontFamily, fontSize: 33, lineHeight: 1.35, color: C.inkSoft, marginTop: 30, maxWidth: 720, opacity: tween(f, from + 16, from + 30) * (out === undefined ? 1 : 1 - tween(f, out, out + 8)), transform: `translateY(${(1 - tween(f, from + 16, from + 32)) * 16}px)` }}>{s.sub}</div>
            <div style={{ display: 'flex', gap: 14, marginTop: 44 }}>
              {s.chips.map((chipText, k) => {
                const p = spring({ frame: f - from - 26 - k * 5, fps, config: { damping: 14, stiffness: 170 } }) * (out === undefined ? 1 : 1 - tween(f, out - 2, out + 6))
                const hot = k === s.hot ? tween(f, from + 46, from + 54) : 0
                return (
                  <div key={chipText} style={{ fontFamily, ...num, fontSize: 26, fontWeight: 600, padding: '15px 26px', borderRadius: 60, color: hot > 0.5 ? C.onLime : C.ink, background: hot > 0.5 ? C.lime : C.surface, border: `1px solid ${hot > 0.5 ? C.lime : C.line}`, opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * 22}px) scale(${0.92 + p * 0.08 + hot * 0.04})` }}>{chipText}</div>
                )
              })}
            </div>
          </div>
        )
      })}

      {/* reward pool (earn step) */}
      <div style={{ position: 'absolute', left: 150, top: 810, width: 440, padding: '22px 26px', borderRadius: 28, background: C.surface, border: `1px solid rgba(200,255,0,${0.2 + pool * 0.2})`, opacity: pool, transform: `translateY(${(1 - pool) * 24}px)`, display: 'flex', alignItems: 'center', gap: 18 }}>
        <Coin size={62} />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily, fontSize: 17, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.inkMute }}>Reward pool · prefunded</div>
          <div style={{ height: 8, borderRadius: 8, background: C.surface2, marginTop: 14, overflow: 'hidden' }}><div style={{ height: '100%', width: `${100 - drained * 26}%`, borderRadius: 8, background: C.lime }} /></div>
        </div>
      </div>

      <Phone token={token} />
      <CoinStream />
      <ClaimBurst />

      <div style={{ position: 'absolute', left: 150, bottom: 54, fontFamily, fontSize: 18, color: C.inkMute, opacity: tween(f, 20, 40) * 0.9 }}>Illustrative product preview. Balances and amounts are examples.</div>
    </AbsoluteFill>
  )
}

// ------------------------------------------------------------------ 4. trust

const FACTS = [
  { title: 'Only you can withdraw', body: 'No admin, key or contract can move your locked tokens.', icon: 'M12 3.5l7 3v5.2c0 4.3-2.9 7.6-7 8.8-4.1-1.2-7-4.5-7-8.8V6.5l7-3ZM9 12.2l2.2 2.2L15.2 10' },
  { title: 'Rewards are prefunded', body: 'Every $WIF paid out is already in the pool. No minting, no emissions.', icon: 'M12 4.5c4 0 7 1.2 7 2.8s-3 2.8-7 2.8-7-1.200-7-2.800 3-2.800 7-2.800ZM5 7.300v4.700c0 1.600 3 2.800 7 2.800s7-1.200 7-2.800V7.300M5 12v4.700c0 1.600 3 2.800 7 2.800s7-1.200 7-2.800V12' },
  { title: 'Two 2-of-3 Safes', body: 'Six separate signers. No proxy, no upgrade path, no oracle.', icon: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM16.500 12a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5ZM2.500 19c.4-3 2.600-5 5.500-5s5.100 2 5.500 5M14.500 14.300c.6-.2 1.300-.3 2-.3 2.500 0 4.400 1.700 4.800 4.300' },
] as const

const Trust = () => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  return (
    <AbsoluteFill style={{ padding: '0 150px', justifyContent: 'center' }}>
      <Words text="Simple where it counts." at={6} style={{ ...display, fontSize: 108, color: C.ink, lineHeight: 1.02 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 28, marginTop: 64 }}>
        {FACTS.map((x, i) => {
          const s = spring({ frame: f - 20 - i * 7, fps, config: { damping: 18, stiffness: 120 } })
          return (
            <div key={x.title} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 34, padding: '38px 36px 42px', opacity: Math.min(1, s * 1.3), transform: `translateY(${(1 - s) * 70}px)` }}>
              <div style={{ width: 76, height: 76, borderRadius: 24, background: C.lime, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${0.6 + s * 0.4}) rotate(${(1 - s) * -18}deg)` }}>
                <svg width={42} height={42} viewBox="0 0 24 24" fill="none" stroke={C.onLime} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d={x.icon} /></svg>
              </div>
              <div style={{ ...display, fontSize: 46, lineHeight: 1.06, color: C.ink, marginTop: 30 }}>{x.title}</div>
              <div style={{ fontFamily, fontSize: 27, lineHeight: 1.4, color: C.inkSoft, marginTop: 16 }}>{x.body}</div>
            </div>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}

// ------------------------------------------------------------------ 5. end card

const EndCard = ({ event }: Props) => {
  const f = useCurrentFrame()
  const { fps } = useVideoConfig()
  const logo = spring({ frame: f - 4, fps, config: { damping: 18, stiffness: 120 } })
  const beats = ['Lock.', 'Earn $WIF.', 'Claim.']
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, opacity: logo, transform: `translateY(${(1 - logo) * 26}px)` }}>
        <Mark size={84} />
        <span style={{ ...display, fontSize: 92, color: C.ink, lineHeight: 1 }}>Rixor</span>
      </div>
      <div style={{ display: 'flex', gap: 36, marginTop: 46 }}>
        {beats.map((b, i) => {
          const s = spring({ frame: f - 16 - i * 9, fps, config: { damping: 13, stiffness: 190, mass: 0.8 } })
          return <div key={b} style={{ ...display, fontSize: 156, lineHeight: 1, color: i === 1 ? C.lime : C.ink, opacity: Math.min(1, s * 1.5), transform: `translateY(${(1 - s) * 60}px) scale(${0.86 + s * 0.14})` }}>{b}</div>
        })}
      </div>
      <div style={{ fontFamily, fontSize: 32, color: C.inkSoft, marginTop: 50, opacity: tween(f, 46, 60) }}>{event}</div>
      <div style={{ position: 'absolute', bottom: 54, fontFamily, fontSize: 18, color: C.inkMute, opacity: tween(f, 52, 66) * 0.9, textAlign: 'center' }}>
        Tested, not audited. $WIF carries no promise of value or return. Rixor is not affiliated with Robinhood Markets, Inc.
      </div>
    </AbsoluteFill>
  )
}

// ------------------------------------------------------------------ composition

export const RixorDemo = (props: Props) => {
  const scenes: { d: number; el: ReactNode }[] = [
    { d: T.hook, el: <Hook /> },
    { d: T.logo, el: <LogoSting /> },
    { d: T.flow, el: <Flow {...props} /> },
    { d: T.trust, el: <Trust /> },
    { d: T.end, el: <EndCard {...props} /> },
  ]
  let at = 0
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      <Backdrop />
      {scenes.map((s, i) => {
        const from = at
        at += s.d
        const last = i === scenes.length - 1
        // Each scene stays OVERLAP frames into the next one, dissolving out while the next dissolves in.
        const duration = s.d + (last ? 0 : OVERLAP)
        return (
          <Sequence key={i} from={from} durationInFrames={duration} layout="none">
            <Scene duration={duration} first={i === 0} last={last}>{s.el}</Scene>
          </Sequence>
        )
      })}
      <Grain />
    </AbsoluteFill>
  )
}
