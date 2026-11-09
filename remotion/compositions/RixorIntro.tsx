import { linearTiming, springTiming, TransitionSeries } from '@remotion/transitions'
import { fade } from '@remotion/transitions/fade'
import { slide } from '@remotion/transitions/slide'
import { noise2D } from '@remotion/noise'
import { evolvePath } from '@remotion/paths'
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion'
import { z } from 'zod'
import { fontFamily } from '../fonts'
import { theme } from '../theme'

export const rixorIntroSchema = z.object({
  tagline: z.string(),
  plans: z.array(z.string()).min(1).max(6),
})

type Props = z.infer<typeof rixorIntroSchema>

const SCENE = { logo: 75, tagline: 75, plans: 105 } as const
const TRANSITION = 15
export const RIXOR_INTRO_DURATION = SCENE.logo + SCENE.tagline + SCENE.plans - 2 * TRANSITION

// Paths copied from public/images/rixor-logo.svg (32x32 mark).
const MARK_PATHS = [
  'M4 5h14.2c7.5 0 12.8 4.7 12.8 11.2 0 4.1-2 7.6-5.5 9.6l-4.7-5.1c2.1-.9 3.4-2.4 3.4-4.5 0-2.8-2.2-4.7-5.5-4.7H9.8L4 5Z',
  'M4 31V21.1l12.7-9.2 5.1 5.4L4 31Z',
  'M15.6 22.6l5.3-4 10.2 12.4h-8.6l-6.9-8.4Z',
]

const Backdrop = () => {
  const frame = useCurrentFrame()
  const { width, height } = useVideoConfig()
  const dots = Array.from({ length: 40 }, (_, i) => {
    const x = ((i * 97) % 100) / 100
    const y = ((i * 53) % 100) / 100
    const dx = noise2D('x', i, frame / 120) * 40
    const dy = noise2D('y', i, frame / 120) * 40
    return { cx: x * width + dx, cy: y * height + dy, r: 2 + (i % 3), o: 0.12 + (i % 4) * 0.05 }
  })
  return (
    <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 40%, #1b1d12 0%, ${theme.background} 65%)` }}>
      <svg width={width} height={height}>
        {dots.map((d, i) => (
          <circle key={i} cx={d.cx} cy={d.cy} r={d.r} fill={theme.accent} opacity={d.o} />
        ))}
      </svg>
    </AbsoluteFill>
  )
}

const LogoScene = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const draw = interpolate(frame, [0, 35], [0, 1], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) })
  const fill = interpolate(frame, [28, 42], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const word = spring({ frame: frame - 30, fps, config: { damping: 200 } })

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 48 }}>
      <svg width={220} height={220} viewBox="0 0 34 34">
        {MARK_PATHS.map((d) => {
          const { strokeDasharray, strokeDashoffset } = evolvePath(draw, d)
          return (
            <path
              key={d}
              d={d}
              stroke={theme.accent}
              strokeWidth={0.6}
              fill={theme.accent}
              fillOpacity={fill}
              strokeDasharray={strokeDasharray}
              strokeDashoffset={strokeDashoffset}
            />
          )
        })}
      </svg>
      <div
        style={{
          fontFamily,
          fontWeight: 700,
          fontSize: 150,
          letterSpacing: 40,
          color: theme.ink,
          opacity: word,
          transform: `translateX(${interpolate(word, [0, 1], [-40, 0])}px)`,
        }}
      >
        RIXOR
      </div>
    </AbsoluteFill>
  )
}

const TaglineScene = ({ tagline }: { tagline: string }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const words = tagline.split(' ')
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: 120 }}>
      <div style={{ fontFamily, fontWeight: 600, fontSize: 96, color: theme.ink, textAlign: 'center', lineHeight: 1.1 }}>
        {words.map((w, i) => {
          const s = spring({ frame: frame - i * 4, fps, config: { damping: 18, mass: 0.6 } })
          return (
            <span
              key={i}
              style={{
                display: 'inline-block',
                marginRight: 28,
                opacity: s,
                transform: `translateY(${interpolate(s, [0, 1], [40, 0])}px)`,
                color: i === words.length - 1 ? theme.accent : theme.ink,
              }}
            >
              {w}
            </span>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}

const PlansScene = ({ plans }: { plans: string[] }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', gap: 56, padding: 80 }}>
      <div style={{ fontFamily, fontSize: 44, color: theme.muted, letterSpacing: 6, textTransform: 'uppercase' }}>
        Choose your plan
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 28 }}>
        {plans.map((plan, i) => {
          const s = spring({ frame: frame - 8 - i * 5, fps, config: { damping: 14 } })
          const active = frame > 60 && i === plans.length - 1
          return (
            <div
              key={plan}
              style={{
                fontFamily,
                fontWeight: 600,
                fontSize: 44,
                padding: '28px 44px',
                borderRadius: 999,
                border: `2px solid ${active ? theme.accent : theme.border}`,
                background: active ? theme.accent : theme.surface,
                color: active ? '#111' : theme.ink,
                transform: `scale(${s})`,
              }}
            >
              {plan}
            </div>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}

export const RixorIntro = ({ tagline, plans }: Props) => (
  <AbsoluteFill style={{ backgroundColor: theme.background }}>
    <Backdrop />
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={SCENE.logo}>
        <LogoScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: TRANSITION })} />
      <TransitionSeries.Sequence durationInFrames={SCENE.tagline}>
        <TaglineScene tagline={tagline} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={slide({ direction: 'from-right' })}
        timing={springTiming({ config: { damping: 200 }, durationInFrames: TRANSITION })}
      />
      <TransitionSeries.Sequence durationInFrames={SCENE.plans}>
        <PlansScene plans={plans} />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
)
