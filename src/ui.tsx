export const iconPaths = {
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  arrowUpRight: 'M7 17 17 7M8 7h9v9',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  info: 'M12 11v5M12 8v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  sun: 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
  home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-9.5Z',
  diamond: 'M6 4h12l3 5-9 11L3 9l3-5ZM3 9h18M10 4 8 9l4 11 4-11-2-5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5V11Z',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  flame: 'M12 21c-4 0-7-2.7-7-6.6C5 10 9 8.5 9 4c3 1.6 4.6 4.3 4.3 7 1.2-.6 2-1.8 2.2-3.4 2 1.6 3.5 4.1 3.5 6.8C19 18.3 16 21 12 21Z',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0V4ZM8 6H5v1a3 3 0 0 0 3 3M16 6h3v1a3 3 0 0 1-3 3M12 13v4M8 20h8M9.5 17h5',
  loop: 'M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5',
  coins: 'M12 7c3.9 0 7-1.3 7-3s-3.1-3-7-3-7 1.3-7 3 3.1 3 7 3ZM5 4v5c0 1.7 3.1 3 7 3s7-1.3 7-3V4M5 9v5c0 1.7 3.1 3 7 3s7-1.3 7-3V9M5 14v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5',
} as const

export type IconName = keyof typeof iconPaths

export const icon = (name: IconName, size = 18) => (
  <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={iconPaths[name]} />
  </svg>
)

/** Neutral network glyph. Third-party network logos are deliberately not used. */
export const networkGlyph = (chainId?: number | null) => {
  const isEthereum = chainId === 11155111
  return (
    <span className={`chain-mark ${isEthereum ? 'chain-mark--sepolia' : 'chain-mark--generic'}`} aria-hidden="true">
      {isEthereum ? (
        <svg viewBox="0 0 32 52" role="presentation">
          <path d="M16 0 0 26.5 16 36 32 26.5 16 0Z" fill="currentColor" opacity=".92" />
          <path d="M16 38.8 0 29.6 16 52 32 29.6 16 38.8Z" fill="currentColor" opacity=".58" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" role="presentation">
          <circle cx="12" cy="12" r="4" fill="currentColor" />
          <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".5" />
        </svg>
      )}
    </span>
  )
}
