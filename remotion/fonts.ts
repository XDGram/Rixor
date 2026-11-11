// Self-hosted fonts: bundled by webpack, so renders never depend on Google Fonts
// being reachable and every frame uses the exact same glyphs.
import { loadFont } from '@remotion/fonts'
import inter400 from '@fontsource/inter/files/inter-latin-400-normal.woff2'
import inter500 from '@fontsource/inter/files/inter-latin-500-normal.woff2'
import inter600 from '@fontsource/inter/files/inter-latin-600-normal.woff2'
import inter700 from '@fontsource/inter/files/inter-latin-700-normal.woff2'
import tight500 from '@fontsource/inter-tight/files/inter-tight-latin-500-normal.woff2'
import tight600 from '@fontsource/inter-tight/files/inter-tight-latin-600-normal.woff2'

export const fontFamily = 'Inter'

for (const [weight, url] of [['400', inter400], ['500', inter500], ['600', inter600], ['700', inter700]] as const) {
  loadFont({ family: fontFamily, url, weight, format: 'woff2' })
}

// Display face of the V2 app (src/styles.css: --display).
export const displayFamily = 'Inter Tight'

for (const [weight, url] of [['500', tight500], ['600', tight600]] as const) {
  loadFont({ family: displayFamily, url, weight, format: 'woff2' })
}
