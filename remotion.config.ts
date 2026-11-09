// Remotion CLI configuration (used by `npm run video:*` scripts).
// https://www.remotion.dev/docs/config
import { Config } from '@remotion/cli/config'
import { enableTailwind } from '@remotion/tailwind-v4'

Config.setEntryPoint('./remotion/index.ts')
Config.setVideoImageFormat('jpeg')
Config.setOverwriteOutput(true)
Config.setConcurrency(null)
Config.setPublicDir('./public')

// Remotion downloads its own Chrome Headless Shell on first render. In sandboxes
// where that download is blocked, point it at an existing headless Chromium:
//   REMOTION_BROWSER_EXECUTABLE=/path/to/chrome-headless-shell npm run video:render
if (process.env.REMOTION_BROWSER_EXECUTABLE) {
  Config.setBrowserExecutable(process.env.REMOTION_BROWSER_EXECUTABLE)
}

// Lets compositions use the same Tailwind v4 setup as the app.
Config.overrideWebpackConfig((config) => enableTailwind(config))
