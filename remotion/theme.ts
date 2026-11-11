// Brand tokens shared by all Rixor videos (mirrors src/styles.css).
export const theme = {
  accent: '#CFEF00',
  ink: '#F4F4F1',
  muted: 'rgba(244,244,241,0.62)',
  background: '#0B0B0C',
  surface: '#161618',
  border: 'rgba(218,218,219,0.16)',
} as const

export const VIDEO = { width: 1920, height: 1080, fps: 30 } as const

// Rixor V2 dark theme (mirrors the V2 app's src/styles.css; the approved accent is #c8ff00).
export const v2 = {
  lime: '#c8ff00',
  onLime: '#1c1a15',
  bg: '#0c0b09',
  paper: '#12110e',
  surface: '#1b1915',
  surface2: '#23211c',
  line: '#2f2c26',
  ink: '#f2f0e8',
  inkSoft: '#bdb9ae',
  inkMute: '#8a867c',
} as const
