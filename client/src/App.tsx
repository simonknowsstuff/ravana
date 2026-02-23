import { useState, useCallback, useRef, useEffect } from 'react'
import { io, Socket } from 'socket.io-client'
import { QRCodeSVG } from 'qrcode.react'
import GLBViewer, { CameraData } from './GLBViewer'
import { GLBData, extractGLBData } from './hooks/useGLBData'
import { useCanvasExporter } from './hooks'
import { ScenePayload } from './types'

// Compile scene data into a binary buffer for efficient transmission
function compileSceneData(glbData: GLBData, cameraData: CameraData | null): { metadata: ScenePayload; buffer: ArrayBuffer } {
  // Calculate total buffer size needed for per-mesh data
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
  
  // Merged scene data offsets (appended after per-mesh data)
  const merged = glbData.merged
  const mergedPosOff = totalBytes
  const mergedIdxOff = mergedPosOff + merged.positions.byteLength
  const mergedBvhOff = mergedIdxOff + merged.indices.byteLength
  const mergedColOff = mergedBvhOff + merged.bvhData.byteLength
  const mergedNrmOff = mergedColOff + merged.colors.byteLength
  const mergedEmiOff = mergedNrmOff + merged.normals.byteLength
  const mergedAoOff = mergedEmiOff + merged.emissive.byteLength
  const mergedMeta = {
    positionsOffset: mergedPosOff,
    positionsLength: merged.positions.byteLength,
    indicesOffset: mergedIdxOff,
    indicesLength: merged.indices.byteLength,
    bvhOffset: mergedBvhOff,
    bvhLength: merged.bvhData.byteLength,
    colorsOffset: mergedColOff,
    colorsLength: merged.colors.byteLength,
    normalsOffset: mergedNrmOff,
    normalsLength: merged.normals.byteLength,
    emissiveOffset: mergedEmiOff,
    emissiveLength: merged.emissive.byteLength,
    aoOffset: mergedAoOff,
    aoLength: merged.ambientOcclusion.byteLength,
  }
  totalBytes += merged.positions.byteLength + merged.indices.byteLength + merged.bvhData.byteLength + merged.colors.byteLength + merged.normals.byteLength + merged.emissive.byteLength + merged.ambientOcclusion.byteLength
  
  // Create the binary buffer
  const buffer = new ArrayBuffer(totalBytes)
  const view = new Uint8Array(buffer)
  
  let offset = 0
  for (const mesh of glbData.meshes) {
    // Copy positions
    view.set(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength), offset)
    offset += mesh.positions.byteLength
    
    // Copy normals
    if (mesh.normals) {
      view.set(new Uint8Array(mesh.normals.buffer, mesh.normals.byteOffset, mesh.normals.byteLength), offset)
      offset += mesh.normals.byteLength
    }
    
    // Copy UVs
    if (mesh.uvs) {
      view.set(new Uint8Array(mesh.uvs.buffer, mesh.uvs.byteOffset, mesh.uvs.byteLength), offset)
      offset += mesh.uvs.byteLength
    }
    
    // Copy indices
    if (mesh.indices) {
      view.set(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength), offset)
      offset += mesh.indices.byteLength
    }
    
    // Copy baked data
    if (mesh.bakedData) {
      const ao = mesh.bakedData.ambientOcclusion
      view.set(new Uint8Array(ao.buffer, ao.byteOffset, ao.byteLength), offset)
      offset += ao.byteLength
      const vc = mesh.bakedData.vertexColors
      view.set(new Uint8Array(vc.buffer, vc.byteOffset, vc.byteLength), offset)
      offset += vc.byteLength
    }
    
    // Copy BVH data
    if (mesh.bvhData) {
      view.set(new Uint8Array(mesh.bvhData.buffer, mesh.bvhData.byteOffset, mesh.bvhData.byteLength), offset)
      offset += mesh.bvhData.byteLength
    }
  }
  
  // Copy merged scene data
  view.set(new Uint8Array(merged.positions.buffer, merged.positions.byteOffset, merged.positions.byteLength), offset)
  offset += merged.positions.byteLength
  view.set(new Uint8Array(merged.indices.buffer, merged.indices.byteOffset, merged.indices.byteLength), offset)
  offset += merged.indices.byteLength
  view.set(new Uint8Array(merged.bvhData.buffer, merged.bvhData.byteOffset, merged.bvhData.byteLength), offset)
  offset += merged.bvhData.byteLength
  view.set(new Uint8Array(merged.colors.buffer, merged.colors.byteOffset, merged.colors.byteLength), offset)
  offset += merged.colors.byteLength
  view.set(new Uint8Array(merged.normals.buffer, merged.normals.byteOffset, merged.normals.byteLength), offset)
  offset += merged.normals.byteLength
  view.set(new Uint8Array(merged.emissive.buffer, merged.emissive.byteOffset, merged.emissive.byteLength), offset)
  offset += merged.emissive.byteLength
  view.set(new Uint8Array(merged.ambientOcclusion.buffer, merged.ambientOcclusion.byteOffset, merged.ambientOcclusion.byteLength), offset)
  offset += merged.ambientOcclusion.byteLength
  
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
      merged: mergedMeta,
    },
    lights: glbData.lights,
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
  const [exposure, setExposure] = useState<number>(0)  // EV compensation: -10 to +10
  const [lightScale, setLightScale] = useState<number>(0.01)  // Light intensity multiplier
  const [networkIP, setNetworkIP] = useState<string | null>(null)
  
  // Render Settings Modal State
  const [showRenderSettings, setShowRenderSettings] = useState(false)
  const [renderWidth, setRenderWidth] = useState<number>(1920)
  const [renderHeight, setRenderHeight] = useState<number>(1080)
  const [samples, setSamples] = useState<number>(16)
  const [tileSize, setTileSize] = useState<number>(64)
  
  // File input ref (to reset after clearing)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // WebSocket state
  const socketRef = useRef<Socket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [lastSentPayload, setLastSentPayload] = useState<ScenePayload | null>(null)

  // Render canvas state
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const exportCanvas = useCanvasExporter(canvasRef) // hook for exporting PNG
  const [isRendering, setIsRendering] = useState(false)
  const [tilesReceived, setTilesReceived] = useState(0)
  const [totalTiles, setTotalTiles] = useState(0)
  const [renderStartTime, setRenderStartTime] = useState<number | null>(null)
  const [renderElapsed, setRenderElapsed] = useState<string>('')
  const [imageFormat, setImageFormat] = useState<'png' | 'jpeg'>('png')
  const [jpegQuality, setJpegQuality] = useState<number>(0.95)
  
  // Tile buffer queue for batched canvas updates
  const tileQueueRef = useRef<Array<{ buffer: ArrayBuffer | Uint8Array; startX: number; startY: number; width: number; height: number; retries?: number }>>([])
  const processingTilesRef = useRef(false)
  const animFrameRef = useRef<number | null>(null)
  const paintedTilesRef = useRef<Set<string>>(new Set()) // Track which tiles have been painted (key: "x,y")

  // Download rendered image
  const handleDownloadImage = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const mimeType = imageFormat === 'png' ? 'image/png' : 'image/jpeg'
    const quality = imageFormat === 'jpeg' ? jpegQuality : undefined
    
    canvas.toBlob((blob) => {
      if (!blob) {
        console.error('Failed to create blob from canvas')
        return
      }
      
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0]
      link.download = `ravana-render-${timestamp}.${imageFormat}`
      link.href = url
      link.click()
      URL.revokeObjectURL(url)
    }, mimeType, quality)
  }, [imageFormat, jpegQuality])

  // Initialize WebSocket connection
  // Fetch network IP address for QR code
  useEffect(() => {
    const serverUrl = import.meta.env.VITE_WS_SERVER_URL || `http://${window.location.hostname}:3000`;
    console.log('[network-ip] Fetching from:', `${serverUrl}/network-ip`);
    fetch(`${serverUrl}/network-ip`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        console.log('[network-ip] Received:', data.ip);
        console.log('[network-ip] All available IPs:', data.allIPs);
        console.log('[network-ip] Interfaces:', data.interfaces);
        setNetworkIP(data.ip);
      })
      .catch(err => {
        console.warn('[network-ip] Failed to fetch network IP, using hostname:', err);
        // Fallback to current hostname
        setNetworkIP(window.location.hostname);
      });
  }, []);

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

    // Process tile queue in batches for better performance
    const processTileQueue = () => {
      if (processingTilesRef.current || tileQueueRef.current.length === 0) {
        animFrameRef.current = null
        return
      }

      processingTilesRef.current = true
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')

      if (!canvas || !ctx) {
        processingTilesRef.current = false
        animFrameRef.current = null
        return
      }

      // Process all queued tiles in this frame (or limit to batch size if needed)
      const batch = tileQueueRef.current.splice(0, tileQueueRef.current.length)
      let successCount = 0
      let failedTiles: Array<{ buffer: ArrayBuffer | Uint8Array; startX: number; startY: number; width: number; height: number; reason: string; retries?: number }> = []

      for (const payload of batch) {
        const retries = payload.retries || 0
        const MAX_RETRIES = 3
        
        try {
          const { startX, startY, width, height } = payload
          // Ensure we have a proper ArrayBuffer
          const raw = payload.buffer instanceof ArrayBuffer
            ? payload.buffer
            : new Uint8Array(payload.buffer).buffer
          const pixels = new Uint8ClampedArray(raw)

          // Validate buffer size matches tile dimensions
          const expected = width * height * 4
          if (pixels.length !== expected) {
            console.error(`[render] Buffer size mismatch: got ${pixels.length}, expected ${expected} for ${width}x${height} tile at (${startX},${startY})`)
            if (retries < MAX_RETRIES) {
              failedTiles.push({ buffer: payload.buffer, startX, startY, width, height, reason: 'size_mismatch', retries: retries + 1 })
            } else {
              console.error(`[render] Tile (${startX},${startY}) failed after ${MAX_RETRIES} retries, giving up`)
            }
            continue
          }

          const imageData = new ImageData(pixels, width, height)
          ctx.putImageData(imageData, startX, startY)
          paintedTilesRef.current.add(`${startX},${startY}`)
          successCount++
        } catch (err) {
          console.error(`[render] Failed to paint tile at (${payload.startX},${payload.startY}):`, err)
          if (retries < MAX_RETRIES) {
            failedTiles.push({ buffer: payload.buffer, startX: payload.startX, startY: payload.startY, width: payload.width, height: payload.height, reason: 'paint_error', retries: retries + 1 })
          } else {
            console.error(`[render] Tile (${payload.startX},${payload.startY}) failed after ${MAX_RETRIES} retries, giving up`)
          }
        }
      }

      // Retry failed tiles (put them back at the front of the queue)
      if (failedTiles.length > 0) {
        console.warn(`[render] ${failedTiles.length} tile(s) failed to paint, will retry`)
        tileQueueRef.current.unshift(...failedTiles)
      }

      if (successCount > 0) {
        setTilesReceived(prev => prev + successCount)
        if (successCount > 1) {
          console.log(`[render] painted ${successCount} tiles in batch`)
        }
      }

      processingTilesRef.current = false

      // Schedule next frame if there are more tiles
      if (tileQueueRef.current.length > 0) {
        animFrameRef.current = requestAnimationFrame(processTileQueue)
      } else {
        animFrameRef.current = null
      }
    }

    // Listen for completed tiles from workers - add to queue and acknowledge
    socket.on('render_update', (payload: { buffer: ArrayBuffer | Uint8Array; startX: number; startY: number; width: number; height: number }, acknowledgeFn) => {
      // Add tile to queue
      console.log(`[render] received tile (${payload.startX},${payload.startY}) — queue size: ${tileQueueRef.current.length + 1}`)
      tileQueueRef.current.push(payload)

      // Send acknowledgment immediately to confirm receipt
      if (acknowledgeFn && typeof acknowledgeFn === 'function') {
        acknowledgeFn({ status: 'received', queueSize: tileQueueRef.current.length })
      }

      // Schedule processing if not already scheduled
      if (!animFrameRef.current) {
        animFrameRef.current = requestAnimationFrame(processTileQueue)
      }
    })

    return () => {
      socket.disconnect()
      // Clean up animation frame on unmount
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current)
      }
    }
  }, [])

  // Check for missing tiles when render appears complete
  useEffect(() => {
    if (tilesReceived > 0 && tilesReceived === totalTiles && totalTiles > 0) {
      console.log(`[render] Render complete: ${tilesReceived}/${totalTiles} tiles painted`)
      
      // Check if all expected tiles were painted
      const expectedTiles = new Set<string>()
      for (let y = 0; y < renderHeight; y += tileSize) {
        for (let x = 0; x < renderWidth; x += tileSize) {
          expectedTiles.add(`${x},${y}`)
        }
      }
      
      const missingTiles: string[] = []
      for (const expectedKey of expectedTiles) {
        if (!paintedTilesRef.current.has(expectedKey)) {
          missingTiles.push(expectedKey)
        }
      }
      
      if (missingTiles.length > 0) {
        console.error(`[render] WARNING: ${missingTiles.length} tiles were never painted:`, missingTiles.slice(0, 10))
      } else {
        console.log(`[render] ✓ All ${totalTiles} tiles successfully painted`)
      }
    }
  }, [tilesReceived, totalTiles, renderHeight, renderWidth, tileSize])

  // Open render settings modal
  const handleOpenRenderSettings = useCallback(() => {
    setShowRenderSettings(true)
  }, [])

  // Compile and send scene data to workers with render settings
  const handleSendToWorkers = useCallback(() => {
    if (!glbData || !socketRef.current || !isConnected) return

    setIsSending(true)
    setShowRenderSettings(false) // Close modal
    
    try {
      const { metadata, buffer } = compileSceneData(glbData, savedCameraData)
      
      // Send metadata first, then binary buffer
      socketRef.current.emit('sync_geometry', {
        type: 'scene_payload',
        metadata,
        buffer,
      })

      // 2. THE SPARK: Tell the server to create the queue and start the Swarm
      const cols = Math.ceil(renderWidth / tileSize)
      const rows = Math.ceil(renderHeight / tileSize)
      setTotalTiles(cols * rows)
      setTilesReceived(0)
      setIsRendering(true)
      setRenderStartTime(Date.now())
      
      // Clear tile queue and painted tiles tracking from any previous render
      tileQueueRef.current = []
      paintedTilesRef.current.clear()
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
      processingTilesRef.current = false

      // Initialize canvas to black
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = renderWidth
        canvas.height = renderHeight
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.fillStyle = '#0f0f19'
          ctx.fillRect(0, 0, renderWidth, renderHeight)
        }
      }

      socketRef.current.emit('start_render', {
        canvasWidth: renderWidth,
        canvasHeight: renderHeight,
        samples: samples,
        tileSize: tileSize,
        camera: {
          cameraPos: savedCameraData?.position ?? { x: 0, y: 2, z: 5 },
          viewMatrix: savedCameraData?.cameraMatrix || [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
          fov: savedCameraData?.fov ?? 50,
          sunDir: { x: 0.5, y: 1.0, z: 0.5 },
          exposure: exposure,  // EV compensation
          lightScale: lightScale,  // Light intensity multiplier
          samples: samples,  // Samples per pixel
        },
        lights: glbData.lights,
        sunDir: { x: 0.5, y: 1.0, z: 0.5 }
      })
      
      setLastSentPayload(metadata)
      console.log('[socket] sent scene payload:', metadata)
      console.log('[socket] binary buffer size:', buffer.byteLength, 'bytes')
      console.log('[socket] render settings:', { renderWidth, renderHeight, samples, tileSize, exposure, lightScale })
    } catch (error) {
      console.error('[socket] failed to send:', error)
    } finally {
      setIsSending(false)
    }
  }, [glbData, savedCameraData, isConnected, exposure, lightScale, renderWidth, renderHeight, samples, tileSize])

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
    // Reset the file input so onChange fires even for the same file
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [])

  const handleCameraSave = useCallback((cameraData: CameraData) => {
    setSavedCameraData(cameraData)
  }, [])

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 relative flex flex-col">
      {/* Full-screen Loading Overlay */}
      {isLoading && (
        <div className="fixed inset-0 z-50 bg-slate-900/90 backdrop-blur-sm flex items-center justify-center">
          <div className="text-center">
            <div className="w-16 h-16 mx-auto border-4 border-purple-500 border-t-transparent rounded-full animate-spin mb-6"></div>
            <h2 className="text-2xl font-semibold text-white mb-2">Processing File</h2>
            <p className="text-slate-400">{bakingProgress || 'Loading...'}</p>
          </div>
        </div>
      )}

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
          <div className="max-w-7xl mx-auto">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <h1 className="text-4xl font-bold text-white">
                  Ravana
                </h1>
                <p className="text-slate-400 mt-2">
                  Zero-install, browser-based compute farm.
                </p>
              </div>
              
              {/* QR Code Section */}
              {networkIP && (
                <div className="ml-8 bg-slate-700/50 rounded-lg p-4 flex items-center space-x-4">
                  <div className="bg-white p-2 rounded-lg">
                    <QRCodeSVG 
                      value={`http://${networkIP}:${window.location.port || '5173'}/worker`}
                      size={120}
                      level="M"
                      includeMargin={false}
                    />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-semibold text-white mb-1">Join as Worker</p>
                    <p className="text-xs text-slate-400 max-w-[200px]">
                      Scan to connect your device as a render node
                    </p>
                    <p className="text-xs text-purple-400 mt-2 font-mono break-all">
                      http://{networkIP}:{window.location.port || '5173'}/worker
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
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
              ref={fileInputRef}
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
            <>
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
            </>
          )}
        </div>

        {/* Render Settings Section */}
        {glbData && (
          <div className="bg-slate-900 rounded-lg p-6 mb-8">
            <h2 className="text-white font-semibold text-lg mb-4 flex items-center">
              <svg className="w-5 h-5 mr-2 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
              </svg>
              Render Settings
            </h2>

            {/* Exposure Control */}
            <div className="bg-slate-800/50 rounded-lg p-4 mb-4">
              <label className="block text-white font-medium mb-2">
                Exposure: {exposure > 0 ? '+' : ''}{exposure.toFixed(1)} EV
              </label>
              <input
                type="range"
                min="-10"
                max="10"
                step="0.1"
                value={exposure}
                onChange={(e) => setExposure(parseFloat(e.target.value))}
                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>-10 EV (darker)</span>
                <span>0</span>
                <span>+10 EV (brighter)</span>
              </div>
              <p className="text-slate-400 text-sm mt-2">Adjust overall brightness (matches Blender's exposure setting)</p>
            </div>

            {/* Light Intensity Scale */}
            <div className="bg-slate-800/50 rounded-lg p-4">
              <label className="block text-white font-medium mb-2">
                Light Intensity Scale: {lightScale.toFixed(3)}x
              </label>
              <input
                type="range"
                min="0.01"
                max="1"
                step="0.001"
                value={lightScale}
                onChange={(e) => setLightScale(parseFloat(e.target.value))}
                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>0.01x (very dim)</span>
                <span>0.5x</span>
                <span>1x (full)</span>
              </div>
              <p className="text-slate-400 text-sm mt-2">Fine-tune light power from GLTF (start with lower values like 0.01-0.1)</p>
            </div>
          </div>
        )}

        {/* 3D Viewer Section */}
        {showViewer && currentFile && (
          <div
            className="mb-8 bg-slate-800 rounded-xl overflow-hidden"
            // responsive box that keeps 1920×720 (16:9) aspect ratio
            style={{
              width: '100%',
              maxWidth: '1920px',
              aspectRatio: '16 / 9',
            }}
          >
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

        {/* Render Canvas */}
        {(isRendering || tilesReceived > 0) && (
          <div className="mb-8">
            <div className="bg-slate-800 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
                <h2 className="text-xl font-semibold text-white flex items-center">
                  <svg className="w-5 h-5 mr-2 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  Distributed Render
                </h2>
                <div className="flex items-center space-x-4 text-sm">
                  <span className="text-slate-400">
                    {tilesReceived} / {totalTiles} tiles
                  </span>
                  {totalTiles > 0 && (
                    <div className="w-32 h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-cyan-500 to-purple-500 transition-all duration-300"
                        style={{ width: `${Math.min(100, (tilesReceived / totalTiles) * 100)}%` }}
                      />
                    </div>
                  )}
                  {tilesReceived === totalTiles && totalTiles > 0 && (
                  <>
                    <span className="text-green-400 font-medium">Complete</span>
                    <button
                      onClick={() => exportCanvas()}
                      className="ml-4 px-3 py-1 rounded bg-cyan-500 text-white text-sm hover:bg-cyan-600"
                    >
                      Download PNG
                    </button>
                  </>
                  )}
                </div>
              </div>
              
              {/* Save Controls - Show when render is complete */}
              {tilesReceived === totalTiles && totalTiles > 0 && (
                <div className="px-6 py-4 bg-slate-800/50 border-b border-slate-700">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-4">
                      <span className="text-sm font-medium text-white">Save as:</span>
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => setImageFormat('png')}
                          className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                            imageFormat === 'png'
                              ? 'bg-cyan-500 text-white'
                              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                          }`}
                        >
                          PNG
                        </button>
                        <button
                          onClick={() => setImageFormat('jpeg')}
                          className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                            imageFormat === 'jpeg'
                              ? 'bg-cyan-500 text-white'
                              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                          }`}
                        >
                          JPEG
                        </button>
                      </div>
                      {imageFormat === 'jpeg' && (
                        <div className="flex items-center space-x-2">
                          <span className="text-sm text-slate-400">Quality:</span>
                          <input
                            type="range"
                            min="0.5"
                            max="1"
                            step="0.05"
                            value={jpegQuality}
                            onChange={(e) => setJpegQuality(parseFloat(e.target.value))}
                            className="w-24 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                          />
                          <span className="text-sm text-slate-300 font-mono w-10">{(jpegQuality * 100).toFixed(0)}%</span>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={handleDownloadImage}
                      className="px-6 py-2 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-400 hover:to-emerald-400 text-white font-semibold rounded-lg transition-all duration-300 flex items-center space-x-2 shadow-lg shadow-green-500/20"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      <span>Download Image</span>
                    </button>
                  </div>
                </div>
              )}
              <div className="flex justify-center p-4 bg-slate-900/50" style={{ maxHeight: '1000px', overflow: 'auto' }}>
                <canvas
                  ref={canvasRef}
                  width={renderWidth}
                  height={renderHeight}
                  className="rounded-lg border border-slate-700 shadow-lg shadow-cyan-500/10"
                  style={{ 
                    maxWidth: '100%', 
                    maxHeight: '950px',
                    width: 'auto',
                    height: 'auto',
                    objectFit: 'contain',
                    imageRendering: 'pixelated' 
                  }}
                />
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
                  onClick={handleOpenRenderSettings}
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

        {/* Render Settings Modal */}
        {showRenderSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="bg-slate-800 rounded-2xl p-8 max-w-2xl w-full mx-4 shadow-2xl border border-cyan-500/30">
              {/* Modal Header */}
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-bold text-white">Render Settings</h2>
                <button
                  onClick={() => setShowRenderSettings(false)}
                  className="text-slate-400 hover:text-white transition-colors"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Settings Grid */}
              <div className="space-y-6">
                {/* Resolution Section */}
                <div>
                  <h3 className="text-lg font-semibold text-cyan-400 mb-4">Resolution</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Width</label>
                      <input
                        type="number"
                        value={renderWidth}
                        onChange={(e) => setRenderWidth(Math.max(128, parseInt(e.target.value) || 1920))}
                        className="w-full px-4 py-2 bg-slate-700 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        min="128"
                        max="7680"
                        step="16"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Height</label>
                      <input
                        type="number"
                        value={renderHeight}
                        onChange={(e) => setRenderHeight(Math.max(128, parseInt(e.target.value) || 1080))}
                        className="w-full px-4 py-2 bg-slate-700 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        min="128"
                        max="4320"
                        step="16"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => { setRenderWidth(1920); setRenderHeight(1080); }} className="px-3 py-1 text-xs bg-slate-600 hover:bg-slate-500 text-white rounded transition-colors">1080p</button>
                    <button onClick={() => { setRenderWidth(2560); setRenderHeight(1440); }} className="px-3 py-1 text-xs bg-slate-600 hover:bg-slate-500 text-white rounded transition-colors">1440p</button>
                    <button onClick={() => { setRenderWidth(3840); setRenderHeight(2160); }} className="px-3 py-1 text-xs bg-slate-600 hover:bg-slate-500 text-white rounded transition-colors">4K</button>
                  </div>
                </div>

                {/* Lighting Section */}
                <div>
                  <h3 className="text-lg font-semibold text-cyan-400 mb-4">Lighting</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Exposure (EV): {exposure.toFixed(2)}
                      </label>
                      <input
                        type="range"
                        value={exposure}
                        onChange={(e) => setExposure(parseFloat(e.target.value))}
                        className="w-full"
                        min="-10"
                        max="10"
                        step="0.1"
                      />
                      <div className="flex justify-between text-xs text-slate-500 mt-1">
                        <span>-10</span>
                        <span>0</span>
                        <span>+10</span>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Light Scale: {lightScale.toFixed(3)}
                      </label>
                      <input
                        type="range"
                        value={lightScale}
                        onChange={(e) => setLightScale(parseFloat(e.target.value))}
                        className="w-full"
                        min="0.001"
                        max="10"
                        step="0.001"
                      />
                      <div className="flex justify-between text-xs text-slate-500 mt-1">
                        <span>0.001</span>
                        <span>1.0</span>
                        <span>10</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Quality Settings */}
                <div>
                  <h3 className="text-lg font-semibold text-cyan-400 mb-4">Quality</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Samples per Pixel: {samples}
                      </label>
                      <input
                        type="range"
                        value={samples}
                        onChange={(e) => setSamples(parseInt(e.target.value))}
                        className="w-full"
                        min="1"
                        max="128"
                        step="1"
                      />
                      <div className="flex justify-between text-xs text-slate-500 mt-1">
                        <span>1 (Fast)</span>
                        <span>64</span>
                        <span>128 (Best)</span>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Tile Size: {tileSize}px
                      </label>
                      <input
                        type="range"
                        value={tileSize}
                        onChange={(e) => setTileSize(parseInt(e.target.value))}
                        className="w-full"
                        min="32"
                        max="256"
                        step="32"
                      />
                      <div className="flex justify-between text-xs text-slate-500 mt-1">
                        <span>32</span>
                        <span>128</span>
                        <span>256</span>
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500 mt-3">
                    Higher samples = better quality but slower render. Smaller tiles = better distribution but more overhead.
                  </p>
                </div>

                {/* Render Info */}
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-slate-400">Total Pixels:</span>
                      <span className="text-white ml-2">{(renderWidth * renderHeight).toLocaleString()}</span>
                    </div>
                    <div>
                      <span className="text-slate-400">Total Tiles:</span>
                      <span className="text-white ml-2">{Math.ceil(renderWidth / tileSize) * Math.ceil(renderHeight / tileSize)}</span>
                    </div>
                    <div>
                      <span className="text-slate-400">Aspect Ratio:</span>
                      <span className="text-white ml-2">{(renderWidth / renderHeight).toFixed(3)}</span>
                    </div>
                    <div>
                      <span className="text-slate-400">Total Samples:</span>
                      <span className="text-white ml-2">{(renderWidth * renderHeight * samples).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-end gap-4 mt-8">
                <button
                  onClick={() => setShowRenderSettings(false)}
                  className="px-6 py-3 rounded-lg font-semibold text-slate-300 bg-slate-700 hover:bg-slate-600 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSendToWorkers}
                  className="px-6 py-3 rounded-lg font-semibold text-white bg-cyan-500 hover:bg-cyan-400 transition-colors flex items-center space-x-2"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  <span>Start Render</span>
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
