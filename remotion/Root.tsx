import { Composition, Folder } from 'remotion'
import { RixorIntro, rixorIntroSchema, RIXOR_INTRO_DURATION } from './compositions/RixorIntro'
import { RixorDemo, rixorDemoSchema, RIXOR_DEMO_DURATION, RIXOR_DEMO_FPS } from './compositions/RixorDemo'
import { RixorFilm, rixorFilmSchema, RIXOR_FILM_DURATION, RIXOR_FILM_FPS } from './compositions/RixorFilm'
import { VIDEO } from './theme'

export const RemotionRoot = () => (
  <Folder name="Rixor">
    <Composition
      id="RixorFilm"
      component={RixorFilm}
      durationInFrames={RIXOR_FILM_DURATION}
      fps={RIXOR_FILM_FPS}
      width={1920}
      height={1080}
      schema={rixorFilmSchema}
      defaultProps={{ token: 'MEME', event: 'Built for the World Is Flat hackathon · on Robinhood Chain' }}
    />
    <Composition
      id="RixorDemo"
      component={RixorDemo}
      durationInFrames={RIXOR_DEMO_DURATION}
      fps={RIXOR_DEMO_FPS}
      width={1920}
      height={1080}
      schema={rixorDemoSchema}
      defaultProps={{ token: 'MEME', event: 'Built for the World Is Flat hackathon · on Robinhood Chain' }}
    />
    <Composition
      id="RixorIntro"
      component={RixorIntro}
      durationInFrames={RIXOR_INTRO_DURATION}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
      schema={rixorIntroSchema}
      defaultProps={{
        tagline: 'Onchain savings with clear terms.',
        plans: ['Flexible', '30 days', '90 days', '180 days', '1 year'],
      }}
    />
    <Composition
      id="RixorIntroSquare"
      component={RixorIntro}
      durationInFrames={RIXOR_INTRO_DURATION}
      fps={VIDEO.fps}
      width={1080}
      height={1080}
      schema={rixorIntroSchema}
      defaultProps={{
        tagline: 'Onchain savings with clear terms.',
        plans: ['Flexible', '30 days', '90 days', '180 days', '1 year'],
      }}
    />
  </Folder>
)
