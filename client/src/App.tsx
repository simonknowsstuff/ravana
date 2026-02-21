import { useState, useCallback, useRef, useEffect } from 'react'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as THREE from 'three'
import { MeshBVH, computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'
import { io, Socket } from 'socket.io-client'
import GLBViewer, { CameraData } from './GLBViewer'

// Add BVH methods to Three.js prototypes
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

declare module 'three' {
  interface BufferGeometry {
    boundsTree?: MeshBVH
    computeBoundsTree: typeof computeBoundsTree
    disposeBoundsTree: typeof disposeBoundsTree
  }
}

interface BakedData {
  ambientOcclusion: Float32Array
  vertexColors: Float32Array
  bvhNodeCount: number
  raycastSamples: number
}

interface MeshData {
  name: string
  positions: Float32Array
  normals: Float32Array | null
  uvs: Float32Array | null
  indices: Uint16Array | Uint32Array | null
  bakedData?: BakedData
  bvhData?: Uint8Array // Serialized BVH tree for raytracing
}

interface GLBData {
  meshes: MeshData[]
}

// Payload structure for websocket transmission
interface ScenePayload {
  timestamp: number
  version: string
  camera: {
    position: { x: number; y: number; z: number }
    rotation: { x: number; y: number; z: number }
    target: { x: number; y: number; z: number }
    fov: number
    near: number
    far: number
  } | null
  geometry: {
    meshCount: number
    totalVertices: number
    totalIndices: number
    meshes: Array<{
      name: string
      vertexCount: number
      indexCount: number
      hasNormals: boolean
      hasUvs: boolean
      hasBakedData: boolean
      hasBvhData: boolean
      // Byte offsets in the binary buffer
      positionsOffset: number
      positionsLength: number
      normalsOffset: number
      normalsLength: number
      uvsOffset: number
      uvsLength: number
      indicesOffset: number
      indicesLength: number
      aoOffset: number
      aoLength: number
      vertexColorsOffset: number
      vertexColorsLength: number
      bvhOffset: number
      bvhLength: number
    }>
  }
}

// Serialize MeshBVH to a compact Uint8Array for transmission
function serializeBVH(bvh: MeshBVH): Uint8Array {
  const serialized = MeshBVH.serialize(bvh)
  
  // Combine all roots into a single buffer with a header
  // Header: [rootCount (4 bytes)] + [rootLengths (4 bytes each)]
  const rootCount = serialized.roots.length
  const headerSize = 4 + rootCount * 4
  const totalRootsSize = serialized.roots.reduce((sum, root) => sum + root.byteLength, 0)
  
  const result = new Uint8Array(headerSize + totalRootsSize)
  const view = new DataView(result.buffer)
  
  // Write header
  view.setUint32(0, rootCount, true) // little-endian
  let headerOffset = 4
  for (const root of serialized.roots) {
    view.setUint32(headerOffset, root.byteLength, true)
    headerOffset += 4
  }
  
  // Write root data
  let dataOffset = headerSize
  for (const root of serialized.roots) {
    result.set(new Uint8Array(root), dataOffset)
    dataOffset += root.byteLength
  }
  
  return result
}

// Compile scene data into a binary buffer for efficient transmission
function compileSceneData(glbData: GLBData, cameraData: CameraData | null): { metadata: ScenePayload; buffer: ArrayBuffer } {
  // Calculate total buffer size needed
  let totalBytes = 0
  const meshOffsets: ScenePayload['geometry']['meshes'] = []
  
  for (const mesh of glbData.meshes) {
    const positionsLength = mesh.positions.byteLength
    const normalsLength = mesh.normals?.byteLength ?? 0
    const uvsLength = mesh.uvs?.byteLength ?? 0
    const indicesLength = mesh.indices?.byteLength ?? 0
    const aoLength = mesh.bakedData?.ambientOcclusion.byteLength ?? 0
    const vertexColorsLength = mesh.bakedData?.vertexColors.byteLength ?? 0
    const bvhLength = mesh.bvhData?.byteLength ?? 0
    
    meshOffsets.push({
      name: mesh.name,
      vertexCount: mesh.positions.length / 3,
      indexCount: mesh.indices?.length ?? 0,
      hasNormals: !!mesh.normals,
      hasUvs: !!mesh.uvs,
      hasBakedData: !!mesh.bakedData,
      hasBvhData: !!mesh.bvhData,
      positionsOffset: totalBytes,
      positionsLength,
      normalsOffset: totalBytes + positionsLength,
      normalsLength,
      uvsOffset: totalBytes + positionsLength + normalsLength,
      uvsLength,
      indicesOffset: totalBytes + positionsLength + normalsLength + uvsLength,
      indicesLength,
      aoOffset: totalBytes + positionsLength + normalsLength + uvsLength + indicesLength,
      aoLength,
      vertexColorsOffset: totalBytes + positionsLength + normalsLength + uvsLength + indicesLength + aoLength,
      vertexColorsLength,
      bvhOffset: totalBytes + positionsLength + normalsLength + uvsLength + indicesLength + aoLength + vertexColorsLength,
      bvhLength,
    })
    
    totalBytes += positionsLength + normalsLength + uvsLength + indicesLength + aoLength + vertexColorsLength + bvhLength
  }
  
  // Create the binary buffer
  const buffer = new ArrayBuffer(totalBytes)
  const view = new Uint8Array(buffer)
  
  let offset = 0
  for (const mesh of glbData.meshes) {
    // Copy positions
    view.set(new Uint8Array(mesh.positions.buffer), offset)
    offset += mesh.positions.byteLength
    
    // Copy normals
    if (mesh.normals) {
      view.set(new Uint8Array(mesh.normals.buffer), offset)
      offset += mesh.normals.byteLength
    }
    
    // Copy UVs
    if (mesh.uvs) {
      view.set(new Uint8Array(mesh.uvs.buffer), offset)
      offset += mesh.uvs.byteLength
    }
    
    // Copy indices
    if (mesh.indices) {
      view.set(new Uint8Array(mesh.indices.buffer), offset)
      offset += mesh.indices.byteLength
    }
    
    // Copy baked data
    if (mesh.bakedData) {
      view.set(new Uint8Array(mesh.bakedData.ambientOcclusion.buffer), offset)
      offset += mesh.bakedData.ambientOcclusion.byteLength
      view.set(new Uint8Array(mesh.bakedData.vertexColors.buffer), offset)
      offset += mesh.bakedData.vertexColors.byteLength
    }
    
    // Copy BVH data
    if (mesh.bvhData) {
      view.set(mesh.bvhData, offset)
      offset += mesh.bvhData.byteLength
    }
  }
  
  const metadata: ScenePayload = {
    timestamp: Date.now(),
    version: '1.0.0',
    camera: cameraData ? {
      position: cameraData.position,
      rotation: cameraData.rotation,
      target: cameraData.target,
      fov: cameraData.fov,
      near: cameraData.near,
      far: cameraData.far,
    } : null,
    geometry: {
      meshCount: glbData.meshes.length,
      totalVertices: glbData.meshes.reduce((sum, m) => sum + m.positions.length / 3, 0),
      totalIndices: glbData.meshes.reduce((sum, m) => sum + (m.indices?.length ?? 0), 0),
      meshes: meshOffsets,
    },
  }
  
  return { metadata, buffer }
}

interface BakeOptions {
  samples: number
  maxDistance: number
  intensity: number
}

function bakeMeshWithBVH(
  geometry: THREE.BufferGeometry,
  sceneRoot: THREE.Object3D,
  options: BakeOptions = { samples: 64, maxDistance: 2.0, intensity: 1.0 }
): BakedData {
  // Build BVH for the geometry
  geometry.computeBoundsTree()
  
  const positionAttr = geometry.attributes.position
  const normalAttr = geometry.attributes.normal
  const vertexCount = positionAttr.count
  
  // Create Float32Arrays for baked data
  const ambientOcclusion = new Float32Array(vertexCount)
  const vertexColors = new Float32Array(vertexCount * 3) // RGB per vertex
  
  // Create raycaster for BVH-accelerated raycasting
  const raycaster = new THREE.Raycaster()
  raycaster.firstHitOnly = true
  
  const position = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const rayDirection = new THREE.Vector3()
  
  // Collect all meshes in scene for raycasting
  const meshes: THREE.Mesh[] = []
  sceneRoot.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.geometry.boundsTree) {
      meshes.push(obj)
    }
  })
  
  // Sample directions on hemisphere using Fibonacci sphere
  const sampleDirections: THREE.Vector3[] = []
  const goldenRatio = (1 + Math.sqrt(5)) / 2
  for (let i = 0; i < options.samples; i++) {
    const theta = 2 * Math.PI * i / goldenRatio
    const phi = Math.acos(1 - (2 * (i + 0.5)) / options.samples)
    sampleDirections.push(new THREE.Vector3(
      Math.cos(theta) * Math.sin(phi),
      Math.sin(theta) * Math.sin(phi),
      Math.cos(phi)
    ))
  }
  
  // Bake ambient occlusion per vertex
  for (let i = 0; i < vertexCount; i++) {
    position.fromBufferAttribute(positionAttr, i)
    
    if (normalAttr) {
      normal.fromBufferAttribute(normalAttr, i)
    } else {
      normal.set(0, 1, 0)
    }
    
    // Create tangent space basis for hemisphere sampling
    const tangent = new THREE.Vector3()
    const bitangent = new THREE.Vector3()
    
    if (Math.abs(normal.y) < 0.99) {
      tangent.crossVectors(normal, new THREE.Vector3(0, 1, 0)).normalize()
    } else {
      tangent.crossVectors(normal, new THREE.Vector3(1, 0, 0)).normalize()
    }
    bitangent.crossVectors(normal, tangent)
    
    let occlusionSum = 0
    let validSamples = 0
    
    // Cast rays in hemisphere above the surface
    for (const sampleDir of sampleDirections) {
      // Transform sample direction from hemisphere to world space
      if (sampleDir.z < 0) continue // Only upper hemisphere
      
      rayDirection.set(0, 0, 0)
        .addScaledVector(tangent, sampleDir.x)
        .addScaledVector(bitangent, sampleDir.y)
        .addScaledVector(normal, sampleDir.z)
        .normalize()
      
      // Offset ray origin slightly to avoid self-intersection
      const rayOrigin = position.clone().addScaledVector(normal, 0.001)
      raycaster.set(rayOrigin, rayDirection)
      raycaster.far = options.maxDistance
      
      // Check for intersections using BVH
      let occluded = false
      for (const mesh of meshes) {
        const hits = raycaster.intersectObject(mesh, false)
        if (hits.length > 0 && hits[0].distance < options.maxDistance) {
          occluded = true
          // Weighted by distance - closer = more occlusion
          occlusionSum += 1 - (hits[0].distance / options.maxDistance)
          break
        }
      }
      
      if (!occluded) {
        validSamples++
      }
    }
    
    // Calculate AO value (0 = fully occluded, 1 = fully visible)
    const totalHemisphereSamples = sampleDirections.filter(d => d.z >= 0).length
    const aoValue = validSamples / totalHemisphereSamples
    ambientOcclusion[i] = Math.pow(aoValue, options.intensity)
    
    // Generate vertex colors from AO (grayscale)
    const colorValue = ambientOcclusion[i]
    vertexColors[i * 3] = colorValue     // R
    vertexColors[i * 3 + 1] = colorValue // G
    vertexColors[i * 3 + 2] = colorValue // B
  }
  
  return {
    ambientOcclusion,
    vertexColors,
    bvhNodeCount: 1, // BVH tree built internally
    raycastSamples: options.samples
  }
}

async function extractGLBData(file: File, shouldBake: boolean = false): Promise<GLBData> {
  const loader = new GLTFLoader()
  const url = URL.createObjectURL(file)
  
  try {
    const gltf = await loader.loadAsync(url)
    const meshes: MeshData[] = []
    
    // Build BVH for all meshes first if baking
    if (shouldBake) {
      gltf.scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const geometry = child.geometry as THREE.BufferGeometry
          geometry.computeBoundsTree()
        }
      })
    }
    
    gltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const geometry = child.geometry as THREE.BufferGeometry
        
        // Bake mesh data using BVH if requested
        let bakedData: BakedData | undefined
        if (shouldBake) {
          bakedData = bakeMeshWithBVH(geometry, gltf.scene, {
            samples: 64,
            maxDistance: 2.0,
            intensity: 1.0
          })
        }
        
        // Serialize BVH before disposal
        let bvhData: Uint8Array | undefined
        if (geometry.boundsTree) {
          bvhData = serializeBVH(geometry.boundsTree)
        }
        
        const meshData: MeshData = {
          name: child.name || `mesh_${meshes.length}`,
          positions: new Float32Array(geometry.attributes.position.array),
          normals: geometry.attributes.normal 
            ? new Float32Array(geometry.attributes.normal.array) 
            : null,
          uvs: geometry.attributes.uv 
            ? new Float32Array(geometry.attributes.uv.array) 
            : null,
          indices: geometry.index 
            ? (geometry.index.array instanceof Uint16Array 
                ? new Uint16Array(geometry.index.array) 
                : new Uint32Array(geometry.index.array))
            : null,
          bakedData,
          bvhData,
        }
        meshes.push(meshData)
        
        // Clean up BVH
        if (geometry.boundsTree) {
          geometry.disposeBoundsTree()
        }
      }
    })
    
    return { meshes }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function App() {
  const [fileName, setFileName] = useState<string>('')
  const [isDragging, setIsDragging] = useState(false)
  const [glbData, setGlbData] = useState<GLBData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [bakingProgress, setBakingProgress] = useState<string>('')
  const [currentFile, setCurrentFile] = useState<File | null>(null)
  const [savedCameraData, setSavedCameraData] = useState<CameraData | null>(null)
  const [showViewer, setShowViewer] = useState(true)
  
  // WebSocket state
  const socketRef = useRef<Socket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [lastSentPayload, setLastSentPayload] = useState<ScenePayload | null>(null)

  // Initialize WebSocket connection
  useEffect(() => {
    const serverUrl = import.meta.env.VITE_WS_SERVER_URL || 'http://localhost:3001'
    const socket = io(serverUrl)
    socketRef.current = socket

    socket.on('connect', () => {
      console.log('[socket] connected:', socket.id)
      setIsConnected(true)
      socket.emit('register_dashboard')
    })

    socket.on('disconnect', () => {
      console.log('[socket] disconnected')
      setIsConnected(false)
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  // Compile and send scene data to workers
  const handleSendToWorkers = useCallback(() => {
    if (!glbData || !socketRef.current || !isConnected) return

    setIsSending(true)
    try {
      const { metadata, buffer } = compileSceneData(glbData, savedCameraData)
      
      // Send metadata first, then binary buffer
      socketRef.current.emit('sync_geometry', {
        type: 'scene_payload',
        metadata,
        buffer,
      })
      
      setLastSentPayload(metadata)
      console.log('[socket] sent scene payload:', metadata)
      console.log('[socket] binary buffer size:', buffer.byteLength, 'bytes')
    } catch (error) {
      console.error('[socket] failed to send:', error)
    } finally {
      setIsSending(false)
    }
  }, [glbData, savedCameraData, isConnected])

  const handleFileUpload = useCallback(async (file: File) => {
    if (file && (file.name.endsWith('.gltf') || file.name.endsWith('.glb'))) {
      setIsLoading(true)
      setFileName(file.name)
      setCurrentFile(file)
      setBakingProgress('Building BVH and baking...')
      try {
        const data = await extractGLBData(file, true)
        setGlbData(data)
        console.log('Extracted GLB data:', data)
        console.log('Baked Float32Arrays:', data.meshes.map(m => ({
          name: m.name,
          ambientOcclusion: m.bakedData?.ambientOcclusion,
          vertexColors: m.bakedData?.vertexColors
        })))
      } catch (error) {
        console.error('Failed to parse GLB file:', error)
        alert('Failed to parse the file')
      } finally {
        setIsLoading(false)
        setBakingProgress('')
      }
    } else {
      alert('Please upload a valid .gltf or .glb file')
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) {
      handleFileUpload(file)
    }
  }, [handleFileUpload])

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      handleFileUpload(file)
    }
  }, [handleFileUpload])

  const handleClear = useCallback(() => {
    setGlbData(null)
    setFileName('')
    setCurrentFile(null)
    setSavedCameraData(null)
  }, [])

  const handleCameraSave = useCallback((cameraData: CameraData) => {
    setSavedCameraData(cameraData)
  }, [])

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      {/* Header */}
      <header className="p-6 border-b border-white/10">
        <h1 className="text-4xl font-bold text-white text-center">
          Ravana
        </h1>
        <p className="text-slate-400 text-center mt-2">
          GLB Parser - Extract mesh data from GLTF/GLB files
        </p>
      </header>

      <main className="container mx-auto p-6">
        {/* Upload Section */}
        <div className="mb-8">
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`
              relative border-2 border-dashed rounded-xl p-8 text-center transition-all duration-300
              ${isDragging 
                ? 'border-purple-400 bg-purple-500/20' 
                : 'border-slate-600 hover:border-purple-500 hover:bg-slate-800/50'
              }
            `}
          >
            <input
              type="file"
              accept=".gltf,.glb"
              onChange={handleInputChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <div className="space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-purple-500/20 flex items-center justify-center">
                <svg
                  className="w-8 h-8 text-purple-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
              </div>
              <div>
                <p className="text-lg font-medium text-white">
                  Drop your GLTF/GLB file here
                </p>
                <p className="text-slate-400 text-sm mt-1">
                  or click to browse
                </p>
              </div>
            </div>
          </div>

          {/* File Info */}
          {fileName && (
            <div className="mt-4 flex items-center justify-between bg-slate-800 rounded-lg p-4">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-purple-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                </div>
                <span className="text-white font-medium">{fileName}</span>
              </div>
              <button
                onClick={handleClear}
                className="px-4 py-2 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors"
              >
                Remove
              </button>
            </div>
          )}

          {/* Send to Workers Section */}
          {glbData && (
            <div className="mt-4 bg-slate-800 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  {/* Connection Status */}
                  <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className="text-slate-400 text-sm">
                    {isConnected ? 'Connected to server' : 'Disconnected'}
                  </span>
                </div>
                <button
                  onClick={handleSendToWorkers}
                  disabled={!isConnected || isSending}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2 ${
                    isConnected && !isSending
                      ? 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30'
                      : 'bg-slate-600/50 text-slate-500 cursor-not-allowed'
                  }`}
                >
                  {isSending ? (
                    <>
                      <div className="w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                      <span>Sending...</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      <span>Send to Workers</span>
                    </>
                  )}
                </button>
              </div>
              {/* Last Sent Payload Info */}
              {lastSentPayload && (
                <div className="mt-3 pt-3 border-t border-slate-700">
                  <p className="text-xs text-slate-500">
                    Last sent: {lastSentPayload.geometry.meshCount} meshes, {lastSentPayload.geometry.totalVertices.toLocaleString()} vertices
                    {lastSentPayload.camera && ' + camera data'}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* 3D Viewer Toggle */}
          {fileName && (
            <div className="mt-4 flex items-center space-x-3 bg-slate-800/50 rounded-lg p-4">
              <label className="flex items-center space-x-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showViewer}
                  onChange={(e) => setShowViewer(e.target.checked)}
                  className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-purple-500 focus:ring-purple-500 focus:ring-offset-slate-900"
                />
                <div>
                  <span className="text-white font-medium">Show 3D Viewer</span>
                  <p className="text-slate-400 text-sm">Low quality preview with camera detection</p>
                </div>
              </label>
            </div>
          )}
        </div>

        {/* 3D Viewer Section */}
        {showViewer && currentFile && (
          <div className="mb-8 bg-slate-800 rounded-xl overflow-hidden" style={{ height: '400px' }}>
            <GLBViewer file={currentFile} onCameraSave={handleCameraSave} />
          </div>
        )}

        {/* Data Display */}
        <div className="bg-slate-800 rounded-xl overflow-hidden p-6" style={{ minHeight: '300px' }}>
          {isLoading ? (
            <div className="w-full h-full flex items-center justify-center">
              <div className="text-center">
                <div className="w-12 h-12 mx-auto border-4 border-purple-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-slate-400">{bakingProgress || 'Processing...'}</p>
              </div>
            </div>
          ) : glbData ? (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-white">
                Extracted Meshes ({glbData.meshes.length})
              </h2>
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {glbData.meshes.map((mesh, index) => (
                  <div key={index} className="bg-slate-700 rounded-lg p-4">
                    <h3 className="text-white font-medium mb-2">{mesh.name}</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                      <div className="bg-slate-600 rounded p-2">
                        <span className="text-slate-400">Positions:</span>
                        <span className="text-purple-400 ml-2">{mesh.positions.length / 3} vertices</span>
                      </div>
                      <div className="bg-slate-600 rounded p-2">
                        <span className="text-slate-400">Normals:</span>
                        <span className="text-purple-400 ml-2">{mesh.normals ? mesh.normals.length / 3 : 'N/A'}</span>
                      </div>
                      <div className="bg-slate-600 rounded p-2">
                        <span className="text-slate-400">UVs:</span>
                        <span className="text-purple-400 ml-2">{mesh.uvs ? mesh.uvs.length / 2 : 'N/A'}</span>
                      </div>
                      <div className="bg-slate-600 rounded p-2">
                        <span className="text-slate-400">Indices:</span>
                        <span className="text-purple-400 ml-2">{mesh.indices ? mesh.indices.length : 'N/A'}</span>
                      </div>
                    </div>
                    {/* Baked Data Display */}
                    {mesh.bakedData && (
                      <div className="mt-3 pt-3 border-t border-slate-600">
                        <h4 className="text-green-400 font-medium mb-2 flex items-center">
                          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          BVH Baked Data (Float32Arrays)
                        </h4>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                          <div className="bg-green-900/30 border border-green-700/50 rounded p-2">
                            <span className="text-slate-400">AO Array:</span>
                            <span className="text-green-400 ml-2">{mesh.bakedData.ambientOcclusion.length} floats</span>
                          </div>
                          <div className="bg-green-900/30 border border-green-700/50 rounded p-2">
                            <span className="text-slate-400">Vertex Colors:</span>
                            <span className="text-green-400 ml-2">{mesh.bakedData.vertexColors.length} floats</span>
                          </div>
                          <div className="bg-green-900/30 border border-green-700/50 rounded p-2">
                            <span className="text-slate-400">BVH Nodes:</span>
                            <span className="text-green-400 ml-2">{mesh.bakedData.bvhNodeCount}</span>
                          </div>
                          <div className="bg-green-900/30 border border-green-700/50 rounded p-2">
                            <span className="text-slate-400">Ray Samples:</span>
                            <span className="text-green-400 ml-2">{mesh.bakedData.raycastSamples}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center" style={{ minHeight: '200px' }}>
              <div className="text-center">
                <div className="w-20 h-20 mx-auto rounded-full bg-slate-700 flex items-center justify-center mb-4">
                  <svg
                    className="w-10 h-10 text-slate-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"
                    />
                  </svg>
                </div>
                <p className="text-slate-400">
                  Upload a GLB file to extract mesh data
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-slate-800/50 rounded-lg p-4">
            <h3 className="text-white font-medium mb-2">Positions</h3>
            <p className="text-slate-400 text-sm">Float32Array of vertex positions (x, y, z)</p>
          </div>
          <div className="bg-slate-800/50 rounded-lg p-4">
            <h3 className="text-white font-medium mb-2">Normals</h3>
            <p className="text-slate-400 text-sm">Float32Array of vertex normals for lighting</p>
          </div>
          <div className="bg-slate-800/50 rounded-lg p-4">
            <h3 className="text-white font-medium mb-2">UVs & Indices</h3>
            <p className="text-slate-400 text-sm">Texture coordinates and triangle indices</p>
          </div>
          <div className="bg-green-900/30 border border-green-700/30 rounded-lg p-4">
            <h3 className="text-green-400 font-medium mb-2">BVH Baked Data</h3>
            <p className="text-slate-400 text-sm">Float32Arrays for AO and vertex colors via three-mesh-bvh raycasting</p>
          </div>
        </div>

        {/* Saved Camera Data */}
        {savedCameraData && (
          <div className="mt-8 bg-blue-900/30 border border-blue-700/30 rounded-lg p-4">
            <h3 className="text-blue-400 font-medium mb-3 flex items-center">
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Saved Camera Data
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div className="bg-slate-800 rounded p-3">
                <span className="text-slate-400 block mb-1">Position</span>
                <span className="text-blue-400 font-mono text-xs">
                  x: {savedCameraData.position.x.toFixed(3)}<br/>
                  y: {savedCameraData.position.y.toFixed(3)}<br/>
                  z: {savedCameraData.position.z.toFixed(3)}
                </span>
              </div>
              <div className="bg-slate-800 rounded p-3">
                <span className="text-slate-400 block mb-1">Rotation</span>
                <span className="text-blue-400 font-mono text-xs">
                  x: {savedCameraData.rotation.x.toFixed(3)}<br/>
                  y: {savedCameraData.rotation.y.toFixed(3)}<br/>
                  z: {savedCameraData.rotation.z.toFixed(3)}
                </span>
              </div>
              <div className="bg-slate-800 rounded p-3">
                <span className="text-slate-400 block mb-1">Target</span>
                <span className="text-blue-400 font-mono text-xs">
                  x: {savedCameraData.target.x.toFixed(3)}<br/>
                  y: {savedCameraData.target.y.toFixed(3)}<br/>
                  z: {savedCameraData.target.z.toFixed(3)}
                </span>
              </div>
              <div className="bg-slate-800 rounded p-3">
                <span className="text-slate-400 block mb-1">Settings</span>
                <span className="text-blue-400 font-mono text-xs">
                  FOV: {savedCameraData.fov.toFixed(1)}°<br/>
                  Near: {savedCameraData.near.toFixed(2)}<br/>
                  Far: {savedCameraData.far.toFixed(1)}
                </span>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
