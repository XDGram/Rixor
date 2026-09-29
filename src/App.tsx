export default function App() {
  return (
    <main className="hero-background" aria-label="Rixor glass ribbon background">
      <video
        className="hero-background__media"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        poster="/images/rixor-hero-background.webp"
        aria-hidden="true"
      >
        <source src="/video/rixor-hero-loop.webm" type="video/webm" />
        <source src="/video/rixor-hero-loop.mp4" type="video/mp4" />
      </video>
    </main>
  )
}
