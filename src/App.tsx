import { Suspense, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, MeshTransmissionMaterial, useGLTF } from '@react-three/drei'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'

type RibbonProps = {
  position: [number, number, number]
  rotation: [number, number, number]
  scale: number
  speed: number
  phase: number
  opacity?: number
}

function Ribbon({ position, rotation, scale, speed, phase, opacity = 1 }: RibbonProps) {
  const group = useRef<THREE.Group>(null)
  const { scene } = useGLTF('/models/rixor-ribbon.glb')
  const geometry = useMemo(() => {
    let source: THREE.BufferGeometry | undefined
    scene.traverse((child) => {
      if (!source && child instanceof THREE.Mesh) source = child.geometry
    })
    const next = source?.clone() ?? new THREE.BufferGeometry()
    next.computeVertexNormals()
    next.center()
    return next
  }, [scene])

  useFrame(({ clock, pointer }, delta) => {
    if (!group.current) return
    const t = clock.elapsedTime * speed + phase
    group.current.rotation.y += delta * 0.045 * speed
    group.current.rotation.x = rotation[0] + Math.sin(t * 0.45) * 0.055 + pointer.y * 0.055
    group.current.rotation.z = rotation[2] + Math.sin(t * 0.32) * 0.035 - pointer.x * 0.045
    group.current.position.y = position[1] + Math.sin(t * 0.55) * 0.07
    group.current.position.x = position[0] + pointer.x * 0.075 * (1 + phase * 0.08)
  })

  return (
    <group ref={group} position={position} rotation={rotation} scale={scale}>
      <mesh geometry={geometry} castShadow receiveShadow>
        <MeshTransmissionMaterial
          color="#a9ff24" transmission={1} thickness={0.72} roughness={0.06}
          chromaticAberration={0.035} anisotropy={0.18} distortion={0.22}
          distortionScale={0.22} temporalDistortion={0.06} ior={1.34}
          clearcoat={1} clearcoatRoughness={0.05} attenuationDistance={0.68}
          attenuationColor="#b8ff56" opacity={opacity} transparent samples={6} resolution={512}
        />
      </mesh>
    </group>
  )
}

function Rig() {
  const { camera, pointer } = useThree()
  useFrame(() => {
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, pointer.x * 0.12, 0.025)
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, pointer.y * 0.08, 0.025)
    camera.lookAt(0.18, -0.08, 0)
  })
  return null
}

function Scene() {
  return (
    <>
      <color attach="background" args={['#f6f5ed']} />
      <ambientLight intensity={1.15} color="#f9fff0" />
      <directionalLight position={[-5, 6, 7]} intensity={3.8} color="#f3ffe1" />
      <directionalLight position={[6, 1, 4]} intensity={2.2} color="#baff31" />
      <pointLight position={[0, -2.8, 3]} intensity={22} distance={9} color="#d9ff9a" />

      <Ribbon position={[0.48, 0.48, -0.28]} rotation={[0.16, -0.58, -0.04]} scale={2.62} speed={0.7} phase={0.4} />
      <Ribbon position={[-0.72, -0.72, 0.15]} rotation={[-0.06, 0.68, 0.13]} scale={2.24} speed={0.54} phase={2.3} opacity={0.96} />
      <Ribbon position={[1.56, -0.48, -0.58]} rotation={[0.2, -0.06, -0.2]} scale={1.58} speed={0.43} phase={4.2} opacity={0.88} />

      <Environment preset="studio" environmentIntensity={0.82} />
      <Rig />
      <EffectComposer multisampling={4}>
        <Bloom intensity={0.22} luminanceThreshold={0.72} luminanceSmoothing={0.5} mipmapBlur />
        <Vignette eskil={false} offset={0.2} darkness={0.08} />
      </EffectComposer>
    </>
  )
}

export default function App() {
  return (
    <main className="study">
      <div className="wash wash-top" />
      <div className="wash wash-bottom" />
      <div className="canvas-wrap" aria-label="Animated Rixor glass ribbon background">
        <Canvas dpr={[1, 1.5]} gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }} camera={{ position: [0, 0.08, 5.2], fov: 34, near: 0.1, far: 100 }} shadows>
          <Suspense fallback={null}><Scene /></Suspense>
        </Canvas>
      </div>
      <div className="preview-label"><span>RIXOR</span><span>DESKTOP BACKGROUND STUDY 01</span></div>
    </main>
  )
}

useGLTF.preload('/models/rixor-ribbon.glb')
