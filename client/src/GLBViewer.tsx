import { useRef, useState, useEffect, useCallback } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import * as THREE from 'three'

interface CameraData {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  fov: number
  near: number
  far: number
  target: { x: number; y: number; z: number }
  timestamp: number
  // Matrices for ray tracing (column-major, 16 floats each)
  viewMatrix: number[]          // camera.matrixWorldInverse - world to view space
  projectionMatrix: number[]    // camera.projectionMatrix - view to clip space
  cameraMatrix: number[]        // camera.matrixWorld - camera to world (for ray generation)
}

interface GLBViewerProps {
  file: File | null
  onCameraSave?: (cameraData: CameraData) => void
}

interface CameraSettings {
  sensitivity: number
  fov: number
  panSpeed: number
}

interface LiveCameraPosition {
  position: { x: number; y: number; z: number }
  target: { x: number; y: number; z: number }
}

interface SceneContentProps {
  file: File | null
  onCameraFound: (camera: THREE.Camera | null) => void
  onCameraSave?: (cameraData: CameraData) => void
  savedCameraRef: React.MutableRefObject<CameraData | null>
  cameraSettings: CameraSettings
  onCameraUpdate?: (position: LiveCameraPosition) => void
}

function SceneContent({ file, onCameraFound, onCameraSave, savedCameraRef, cameraSettings, onCameraUpdate }: SceneContentProps) {
  const { camera, scene } = useThree()
  const [model, setModel] = useState<THREE.Group | null>(null)
  const controlsRef = useRef<any>(null)
  const glbCameraRef = useRef<THREE.Camera | null>(null)

  // Track camera position and auto-save in real-time
  useFrame(() => {
    const perspCamera = camera as THREE.PerspectiveCamera
    const target = controlsRef.current?.target || new THREE.Vector3()
    
    if (onCameraUpdate) {
      onCameraUpdate({
        position: {
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z,
        },
        target: {
          x: target.x,
          y: target.y,
          z: target.z,
        },
      })
    }

    // Auto-save camera data on every frame
    if (onCameraSave) {
      perspCamera.updateMatrixWorld(true)
      perspCamera.updateProjectionMatrix()
      
      const cameraData: CameraData = {
        position: {
          x: perspCamera.position.x,
          y: perspCamera.position.y,
          z: perspCamera.position.z,
        },
        rotation: {
          x: perspCamera.rotation.x,
          y: perspCamera.rotation.y,
          z: perspCamera.rotation.z,
        },
        fov: perspCamera.fov,
        near: perspCamera.near,
        far: perspCamera.far,
        target: {
          x: target.x,
          y: target.y,
          z: target.z,
        },
        timestamp: Date.now(),
        viewMatrix: perspCamera.matrixWorldInverse.elements.slice(),
        projectionMatrix: perspCamera.projectionMatrix.elements.slice(),
        cameraMatrix: perspCamera.matrixWorld.elements.slice(),
      }
      
      savedCameraRef.current = cameraData
      onCameraSave(cameraData)
    }
  })

  // Apply FOV changes
  useEffect(() => {
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = cameraSettings.fov
      camera.updateProjectionMatrix()
    }
  }, [camera, cameraSettings.fov])

  // Load GLB file
  useEffect(() => {
    if (!file) {
      setModel(null)
      onCameraFound(null)
      return
    }

    const loader = new GLTFLoader()
    
    // Set up DRACO loader for compressed geometries
    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')
    loader.setDRACOLoader(dracoLoader)
    
    const url = URL.createObjectURL(file)

    loader.load(
      url,
      (gltf) => {
        // Clean up previous model
        if (model) {
          scene.remove(model)
          model.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.geometry.dispose()
              if (Array.isArray(child.material)) {
                child.material.forEach((mat) => mat.dispose())
              } else {
                child.material.dispose()
              }
            }
          })
        }

        // Check for cameras in the GLB file
        let foundCamera: THREE.Camera | null = null
        gltf.scene.traverse((child) => {
          if (child instanceof THREE.Camera) {
            foundCamera = child
          }
        })

        // Also check gltf.cameras array
        if (!foundCamera && gltf.cameras && gltf.cameras.length > 0) {
          foundCamera = gltf.cameras[0]
        }

        if (foundCamera) {
          glbCameraRef.current = foundCamera
          onCameraFound(foundCamera)

          // Apply GLB camera settings to the viewer camera
          if (foundCamera instanceof THREE.PerspectiveCamera) {
            const perspCamera = camera as THREE.PerspectiveCamera
            
            // Get world position and rotation
            const worldPos = new THREE.Vector3()
            const worldQuat = new THREE.Quaternion()
            foundCamera.getWorldPosition(worldPos)
            foundCamera.getWorldQuaternion(worldQuat)

            perspCamera.position.copy(worldPos)
            perspCamera.quaternion.copy(worldQuat)
            perspCamera.fov = foundCamera.fov
            perspCamera.near = foundCamera.near
            perspCamera.far = foundCamera.far
            perspCamera.updateProjectionMatrix()

            // Update controls target based on camera direction
            const direction = new THREE.Vector3(0, 0, -1)
            direction.applyQuaternion(worldQuat)
            const target = worldPos.clone().add(direction.multiplyScalar(5))
            
            if (controlsRef.current) {
              controlsRef.current.target.copy(target)
              controlsRef.current.update()
            }
          }
        } else {
          onCameraFound(null)
          
          // Auto-fit camera to model bounds
          const box = new THREE.Box3().setFromObject(gltf.scene)
          const center = box.getCenter(new THREE.Vector3())
          const size = box.getSize(new THREE.Vector3())
          const maxDim = Math.max(size.x, size.y, size.z)
          const fov = (camera as THREE.PerspectiveCamera).fov * (Math.PI / 180)
          const distance = maxDim / (2 * Math.tan(fov / 2)) * 1.5

          camera.position.set(center.x + distance, center.y + distance * 0.5, center.z + distance)
          camera.lookAt(center)
          
          if (controlsRef.current) {
            controlsRef.current.target.copy(center)
            controlsRef.current.update()
          }
        }

        setModel(gltf.scene)
        scene.add(gltf.scene)

        URL.revokeObjectURL(url)
      },
      undefined,
      (error) => {
        console.error('Error loading GLB:', error)
        URL.revokeObjectURL(url)
      }
    )

    return () => {
      URL.revokeObjectURL(url)
    }
  }, [file])

  return (
    <>
      {/* Standard lighting setup */}
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 10, 5]} intensity={1} />
      <directionalLight position={[-10, -10, -5]} intensity={0.5} />
      
      <OrbitControls
        ref={controlsRef}
        enableDamping={false}
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        rotateSpeed={cameraSettings.sensitivity}
        panSpeed={cameraSettings.panSpeed}
      />
    </>
  )
}

export default function GLBViewer({ file, onCameraSave }: GLBViewerProps) {
  const [glbCamera, setGlbCamera] = useState<THREE.Camera | null>(null)
  const savedCameraRef = useRef<CameraData | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [cameraSettings, setCameraSettings] = useState<CameraSettings>({
    sensitivity: 1,
    fov: 60,
    panSpeed: 1,
  })
  const [livePosition, setLivePosition] = useState<LiveCameraPosition | null>(null)

  const handleCameraUpdate = useCallback((position: LiveCameraPosition) => {
    setLivePosition(position)
  }, [])

  const handleCameraFound = useCallback((camera: THREE.Camera | null) => {
    setGlbCamera(camera)
  }, [])

  const handleCameraSave = useCallback((cameraData: CameraData) => {
    onCameraSave?.(cameraData)
  }, [onCameraSave])

  return (
    <div className="flex flex-col h-full">
      {/* Viewer Header */}
      <div className="flex items-center justify-between p-3 bg-slate-700/50 border-b border-slate-600">
        <div className="flex items-center space-x-4">
          <h3 className="text-white font-medium">3D Viewer</h3>
          {glbCamera && (
            <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded-full">
              GLB Camera Found
            </span>
          )}
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`px-3 py-1.5 rounded transition-colors text-sm ${
              showSettings 
                ? 'bg-slate-500/30 text-slate-300' 
                : 'bg-slate-500/20 text-slate-400 hover:bg-slate-500/30'
            }`}
          >
            Settings
          </button>
        </div>
      </div>

      {/* Camera Settings Panel */}
      {showSettings && (
        <div className="p-3 bg-slate-800/80 border-b border-slate-600">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-xs text-slate-400 block mb-1">
                Sensitivity: {cameraSettings.sensitivity.toFixed(1)}
              </label>
              <input
                type="range"
                min="0.1"
                max="3"
                step="0.1"
                value={cameraSettings.sensitivity}
                onChange={(e) => setCameraSettings(prev => ({ ...prev, sensitivity: parseFloat(e.target.value) }))}
                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">
                FOV: {cameraSettings.fov.toFixed(0)}°
              </label>
              <input
                type="range"
                min="20"
                max="120"
                step="1"
                value={cameraSettings.fov}
                onChange={(e) => setCameraSettings(prev => ({ ...prev, fov: parseFloat(e.target.value) }))}
                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">
                Pan Speed: {cameraSettings.panSpeed.toFixed(1)}
              </label>
              <input
                type="range"
                min="0.1"
                max="3"
                step="0.1"
                value={cameraSettings.panSpeed}
                onChange={(e) => setCameraSettings(prev => ({ ...prev, panSpeed: parseFloat(e.target.value) }))}
                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
              />
            </div>
          </div>
        </div>
      )}

      {/* Canvas Container */}
      <div className="flex-1 relative bg-slate-900">
        {file ? (
          <>
            <Canvas
              camera={{
                fov: 60,
                near: 0.1,
                far: 1000,
                position: [5, 5, 5],
              }}
              style={{ background: '#1e293b' }}
            >
              <SceneContent
                file={file}
                onCameraFound={handleCameraFound}
                onCameraSave={handleCameraSave}
                savedCameraRef={savedCameraRef}
                cameraSettings={cameraSettings}
                onCameraUpdate={handleCameraUpdate}
              />
            </Canvas>
            {/* Live Camera Position Overlay */}
            {livePosition && (
              <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-slate-900/80 backdrop-blur-sm border-t border-slate-700/50">
                <div className="flex items-center justify-between text-xs font-mono">
                  <div className="flex items-center space-x-4">
                    <span className="text-slate-500">Position:</span>
                    <span className="text-cyan-400">
                      X: {livePosition.position.x.toFixed(2)}
                    </span>
                    <span className="text-green-400">
                      Y: {livePosition.position.y.toFixed(2)}
                    </span>
                    <span className="text-orange-400">
                      Z: {livePosition.position.z.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex items-center space-x-4">
                    <span className="text-slate-500">Target:</span>
                    <span className="text-cyan-400/70">
                      X: {livePosition.target.x.toFixed(2)}
                    </span>
                    <span className="text-green-400/70">
                      Y: {livePosition.target.y.toFixed(2)}
                    </span>
                    <span className="text-orange-400/70">
                      Z: {livePosition.target.z.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-slate-500">Load a GLB file to view</p>
          </div>
        )}
      </div>

      {/* Hints */}
      <div className="px-3 py-2 bg-slate-800/50 border-t border-slate-700">
        <p className="text-xs text-slate-500">
          <span className="text-slate-400">Controls:</span> Left-click + drag to rotate | Right-click + drag to pan | Scroll to zoom
        </p>
      </div>
    </div>
  )
}

export type { CameraData }
