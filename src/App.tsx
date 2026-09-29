import { Suspense, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, MeshReflectorMaterial, MeshTransmissionMaterial } from '@react-three/drei'
import { Bloom, EffectComposer } from '@react-three/postprocessing'
import * as THREE from 'three'

type Point = [number, number, number]
type GlassRibbonProps = {
  points: Point[]; width: number; thickness: number; twist: number
  position?: Point; rotation?: Point; speed: number; phase: number; color?: string
}

function makeRibbon(points: Point[], width: number, thickness: number, twist: number) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'catmullrom', 0.42)
  const segments = 180
  const vertices: number[] = []
  const indices: number[] = []
  const up = new THREE.Vector3(0, 1, 0)
  const fallback = new THREE.Vector3(0, 0, 1)
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments
    const center = curve.getPointAt(t)
    const tangent = curve.getTangentAt(t).normalize()
    let side = new THREE.Vector3().crossVectors(tangent, up)
    if (side.lengthSq() < 0.001) side.crossVectors(tangent, fallback)
    side.normalize()
    const normal = new THREE.Vector3().crossVectors(side, tangent).normalize()
    const angle = twist * Math.PI * 2 * t + Math.sin(t * Math.PI * 2) * 0.16
    side.applyAxisAngle(tangent, angle)
    normal.applyAxisAngle(tangent, angle)
    const halfWidth = width * (0.76 + Math.sin(Math.PI * t) * 0.24) * 0.5
    const halfThickness = thickness * 0.5
    const corners = [
      center.clone().addScaledVector(side, halfWidth).addScaledVector(normal, halfThickness),
      center.clone().addScaledVector(side, -halfWidth).addScaledVector(normal, halfThickness),
      center.clone().addScaledVector(side, halfWidth).addScaledVector(normal, -halfThickness),
      center.clone().addScaledVector(side, -halfWidth).addScaledVector(normal, -halfThickness),
    ]
    corners.forEach((corner) => vertices.push(corner.x, corner.y, corner.z))
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i * 4
    const b = (i + 1) * 4
    indices.push(
      a, b, a + 1, a + 1, b, b + 1,
      a + 2, a + 3, b + 2, a + 3, b + 3, b + 2,
      a, a + 2, b, a + 2, b + 2, b,
      a + 1, b + 1, a + 3, a + 3, b + 1, b + 3,
    )
  }
  indices.push(0, 1, 2, 1, 3, 2)
  const end = segments * 4
  indices.push(end, end + 2, end + 1, end + 1, end + 2, end + 3)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

function GlassRibbon({ points, width, thickness, twist, position = [0, 0, 0], rotation = [0, 0, 0], speed, phase, color = '#aaff27' }: GlassRibbonProps) {
  const ref = useRef<THREE.Group>(null)
  const geometry = useMemo(() => makeRibbon(points, width, thickness, twist), [points, width, thickness, twist])
  useFrame(({ clock, pointer }) => {
    if (!ref.current) return
    const t = clock.elapsedTime * speed + phase
    ref.current.position.y = position[1] + Math.sin(t) * 0.035
    ref.current.rotation.y = rotation[1] + Math.sin(t * 0.42) * 0.025 + pointer.x * 0.035
    ref.current.rotation.x = rotation[0] + Math.cos(t * 0.36) * 0.018 - pointer.y * 0.025
  })
  return (
    <group ref={ref} position={position} rotation={rotation}>
      <mesh geometry={geometry} castShadow receiveShadow>
        <MeshTransmissionMaterial
          color={color} transmission={1} thickness={1.1} roughness={0.035} ior={1.39}
          chromaticAberration={0.025} anisotropy={0.32} distortion={0.11}
          distortionScale={0.17} temporalDistortion={0.025} clearcoat={1}
          clearcoatRoughness={0.025} attenuationDistance={0.72}
          attenuationColor="#b7ff57" samples={8} resolution={768}
        />
      </mesh>
    </group>
  )
}

const topRibbon: Point[] = [
  [-0.55, 0.4, -0.45], [-0.05, 1.05, -0.25], [0.65, 1.44, 0], [1.38, 1.28, 0.18],
  [1.72, 0.7, 0.14], [1.42, 0.2, 0.08], [0.82, 0.1, -0.1], [0.36, 0.45, -0.2],
  [0.55, 0.98, -0.35], [1.16, 1.12, -0.5], [1.75, 0.86, -0.58], [2.25, 0.52, -0.62],
]
const mainRibbon: Point[] = [
  [-3.35, -1.05, -0.35], [-2.45, -1.3, -0.16], [-1.55, -1.34, 0.08], [-0.75, -1.02, 0.22],
  [-0.28, -0.38, 0.28], [0.05, 0.18, 0.22], [0.55, 0.45, 0.08], [1.02, 0.2, 0.12],
  [1.12, -0.38, 0.25], [0.82, -0.82, 0.34], [0.28, -0.92, 0.26], [-0.06, -0.56, 0.08],
  [0.2, -0.14, -0.12], [0.86, -0.08, -0.2], [1.52, -0.36, -0.12], [2.08, -0.62, 0.02],
  [2.7, -0.56, 0.1], [3.2, -0.2, 0.06],
]
const rightRibbon: Point[] = [
  [1.32, -1.02, -0.64], [1.78, -1.25, -0.52], [2.34, -1.08, -0.4], [2.62, -0.55, -0.32],
  [2.45, -0.08, -0.34], [2.02, 0.12, -0.44], [1.82, 0.48, -0.58], [2.18, 0.85, -0.68],
  [2.85, 0.78, -0.7], [3.42, 0.52, -0.64],
]

function CameraRig() {
  const { camera, pointer } = useThree()
  useFrame(() => {
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, pointer.x * 0.08, 0.035)
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0.04 + pointer.y * 0.045, 0.035)
    camera.lookAt(0, -0.05, 0)
  })
  return null
}

function Scene() {
  return (
    <>
      <color attach="background" args={['#f8f7f0']} />
      <ambientLight intensity={1.25} color="#fffff5" />
      <directionalLight position={[-4, 6, 7]} intensity={4.4} color="#ffffff" />
      <directionalLight position={[6, 3, 3]} intensity={3.2} color="#cfff69" />
      <pointLight position={[-1.2, -1.1, 3]} intensity={22} distance={10} color="#ecffc6" />
      <GlassRibbon points={topRibbon} width={0.62} thickness={0.17} twist={1.04} position={[0.3, 0.2, -0.4]} rotation={[0.04, -0.1, -0.04]} speed={0.38} phase={0.2} color="#baff37" />
      <GlassRibbon points={mainRibbon} width={0.72} thickness={0.2} twist={1.23} position={[0, -0.08, 0.08]} rotation={[-0.04, 0.04, 0.02]} speed={0.31} phase={1.8} color="#a8ff20" />
      <GlassRibbon points={rightRibbon} width={0.55} thickness={0.15} twist={0.86} position={[0.25, -0.05, -0.72]} rotation={[0.08, -0.06, -0.08]} speed={0.26} phase={3.2} color="#b8ff35" />
      <mesh position={[0, -1.52, -0.5]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[18, 12]} />
        <MeshReflectorMaterial color="#f5f5eb" roughness={0.28} metalness={0} blur={[540, 110]} mixBlur={0.62} mixStrength={0.34} resolution={512} depthScale={0.36} minDepthThreshold={0.74} maxDepthThreshold={1.35} />
      </mesh>
      <Environment preset="studio" environmentIntensity={0.92} />
      <CameraRig />
      <EffectComposer multisampling={4}>
        <Bloom intensity={0.16} luminanceThreshold={0.78} luminanceSmoothing={0.55} mipmapBlur />
      </EffectComposer>
    </>
  )
}

export default function App() {
  return (
    <main className="study">
      <div className="canvas-wrap" aria-label="Animated lime glass ribbons">
        <Canvas dpr={[1, 1.5]} gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }} camera={{ position: [0, 0.04, 5.25], fov: 35, near: 0.1, far: 100 }} shadows>
          <Suspense fallback={null}><Scene /></Suspense>
        </Canvas>
      </div>
      <div className="soft-light soft-light-left" />
      <div className="soft-light soft-light-top" />
    </main>
  )
}
