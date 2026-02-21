import { useState, useCallback, useRef, useEffect } from 'react'
import { io, Socket } from 'socket.io-client'
import GLBViewer, { CameraData } from './GLBViewer'
import { GLBData, extractGLBData } from './hooks/useGLBData'
import { ScenePayload } from './types'

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
      target: cameraData.target,
      fov: cameraData.fov,
      near: cameraData.near,
      far: cameraData.far,
      viewMatrix: cameraData.viewMatrix,
      projectionMatrix: cameraData.projectionMatrix,
      cameraMatrix: cameraData.cameraMatrix,
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
    const serverUrl = import.meta.env.VITE_WS_SERVER_URL || `http://${window.location.hostname}:3000`;
    const socket = io(serverUrl,{
      transports:['websocket']
  });
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

      // 2. THE SPARK: Tell the server to create the queue and start the Swarm
      socketRef.current.emit('start_render', {
        canvasWidth: 800,
        canvasHeight: 450,
        // Make sure your savedCameraData has these!
        cameraPos: savedCameraData?.position,
        viewMatrix: savedCameraData?.viewMatrix || [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], 
        sunDir: { x: 0.5, y: 1.0, z: 0.5 }
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
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 relative flex flex-col">
      {/* Golden Grid Overlay */}
      <div 
        className="absolute inset-0 pointer-events-none"
        style={{
          opacity: 0.2,
          backgroundImage: `
            linear-gradient(rgba(212, 175, 55, 0.3) 1px, transparent 1px),
            linear-gradient(90deg, rgba(212, 175, 55, 0.3) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px'
        }}
      />
      
      {/* Content wrapper - takes remaining space above footer */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <header className="p-6 border-b border-white/10 bg-slate-800 relative z-10">
        <h1 className="text-4xl font-bold text-white text-center">
          Ravana
        </h1>
        <p className="text-slate-400 text-center mt-2">
          Zero-install, browser-based compute farm.
        </p>
      </header>

        <main className="container mx-auto p-6 pb-30 relative z-10 flex-1">
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

        {/* Saved Camera Data - below 3D viewer */}
        {showViewer && currentFile && savedCameraData && (
          <div className="mb-8 bg-blue-900/30 border border-blue-700/30 rounded-lg p-4">
            <h3 className="text-blue-400 font-medium mb-3 flex items-center">
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Camera Data
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
        </main>

        {/* Floating Send to Workers Button */}
        {glbData && (
          <div className="sticky bottom-0 pb-6 z-50 flex justify-center pointer-events-none">
            <div className="w-[40%] min-w-[320px] pointer-events-auto">
              <div className={`flex items-center justify-between rounded-2xl px-6 py-5 shadow-lg shadow-cyan-500/20 transition-all duration-300 ${
                isConnected && !isSending
                  ? 'bg-slate-800 border border-cyan-500/30'
                  : 'bg-slate-800 border border-slate-600'
              }`}>
                {/* Status Side */}
                <div className="flex flex-col space-y-1">
                  <div className="flex items-center space-x-2">
                    <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span className={`text-sm font-medium ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
                      {isConnected ? 'Connected' : 'Disconnected'}
                    </span>
                  </div>
                  {lastSentPayload && (
                    <p className="text-xs text-slate-500">
                      Last: {lastSentPayload.geometry.meshCount} meshes, {lastSentPayload.geometry.totalVertices.toLocaleString()} verts
                    </p>
                  )}
                </div>
                {/* Button */}
                <button
                  onClick={handleSendToWorkers}
                  disabled={!isConnected || isSending}
                  className={`px-8 py-3 rounded-xl font-semibold text-lg transition-all duration-300 flex items-center space-x-3 ${
                    isConnected && !isSending
                      ? 'bg-cyan-500 text-white hover:bg-cyan-400 hover:scale-105'
                      : 'bg-slate-600 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  {isSending ? (
                    <>
                      <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Sending...</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      <span>Send to Workers</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="bg-slate-900 border-t border-white/10 py-8 relative z-10">
        <div className="container mx-auto px-6">
          <div className="flex flex-col md:flex-row items-center justify-between">
            <div className="text-center md:text-left mb-4 md:mb-0">
              <h3 className="text-white font-bold text-lg">Ravana</h3>
              <p className="text-slate-400 text-sm">Distributed rendering made simple</p>
            </div>
            <div className="text-slate-500 text-sm">
              &copy; 2026 Ravana. All rights reserved.
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default App
