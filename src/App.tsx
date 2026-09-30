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
        <source src="/video/rixor-hero-motion-alpha.webm" type="video/webm" />
      </video>
    </main>
  )
}
