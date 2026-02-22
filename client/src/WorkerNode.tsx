import { useEffect, useState, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import * as THREE from 'three';
import { 
  WebGLPathTracer, 
  PhysicalCamera
} from 'three-gpu-pathtracer';

interface GeometryCache {
  positions: Float32Array;
  indices: Uint32Array;
  bvhBuffer: Float32Array;
  colors: Float32Array;
  normals: Float32Array;
  emissive: Float32Array;
  ao: Float32Array;
}

export default function WorkerNode() {
  const [status, setStatus] = useState<string>('Connecting to Swarm...');
  const [tilesProcessed, setTilesProcessed] = useState<number>(0);
  const [isConnected, setIsConnected] = useState(false);
  const [errorLog, setErrorLog] = useState<string>(''); // Added for debugging
  
  const socketRef = useRef<Socket | null>(null);
  const geoCacheRef = useRef<GeometryCache | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const pathtracerRef = useRef<WebGLPathTracer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<PhysicalCamera | null>(null);
  const exposureRef = useRef<number>(0); // EV compensation
  const lightScaleRef = useRef<number>(1.0); // Light intensity multiplier
  
  // THE WAITING ROOM: Holds a task if it arrives before the geometry
  const pendingTaskRef = useRef<any>(null);

  // Helper function to render a tile
  const renderTile = useCallback(async (task: any) => {
    if (!pathtracerRef.current || !cameraRef.current || !rendererRef.current || !canvasRef.current || !socketRef.current || !sceneRef.current) {
      console.error('Pathtracer not initialized');
      return;
    }

    const { startX, startY, width, height, canvasWidth, canvasHeight, camera: cameraData, samples: taskSamples } = task;
    
    console.log(`[Render] Tile [${startX},${startY}] ${width}x${height} of ${canvasWidth}x${canvasHeight} with ${taskSamples || 16} samples`);
    
    // Update camera from task data - use FULL canvas aspect ratio
    if (cameraData) {
      if (cameraData.cameraPos) {
        cameraRef.current.position.set(
          cameraData.cameraPos.x,
          cameraData.cameraPos.y,
          cameraData.cameraPos.z
        );
      }
      
      // Update camera orientation from view matrix
      if (cameraData.viewMatrix) {
        const m = cameraData.viewMatrix;
        cameraRef.current.matrixAutoUpdate = false;
        cameraRef.current.matrix.fromArray(m);
        cameraRef.current.matrixWorldNeedsUpdate = true;
      }
      
      if (cameraData.fov) {
        cameraRef.current.fov = cameraData.fov;
      }
      
      // Extract exposure and lightScale from camera data
      if (cameraData.exposure !== undefined) {
        exposureRef.current = cameraData.exposure;
      }
      if (cameraData.lightScale !== undefined) {
        lightScaleRef.current = cameraData.lightScale;
      }
    }
    
    // Use full canvas aspect ratio for proper perspective
    cameraRef.current.aspect = canvasWidth / canvasHeight;
    
    // Adjust camera projection matrix to render only this tile region
    // This shifts the view frustum to capture just this tile
    const fullWidth = canvasWidth;
    const fullHeight = canvasHeight;
    
    // Calculate the tile position as a fraction of the full canvas
    // IMPORTANT: Flip Y coordinates because server uses Y=0 at top, OpenGL uses Y=0 at bottom
    const tileLeft = startX / fullWidth;
    const tileRight = (startX + width) / fullWidth;
    const tileBottom = 1.0 - ((startY + height) / fullHeight); // Flipped
    const tileTop = 1.0 - (startY / fullHeight); // Flipped
    
    // Manual projection matrix calculation for tile region
    const fov = cameraRef.current.fov * (Math.PI / 180);
    const aspect = fullWidth / fullHeight;
    const near = cameraRef.current.near;
    const far = cameraRef.current.far;
    
    const top = near * Math.tan(fov * 0.5);
    const bottom = -top;
    const right = top * aspect;
    const left = -right;
    
    // Calculate tile-specific frustum
    const tileLeftFrustum = left + (right - left) * tileLeft;
    const tileRightFrustum = left + (right - left) * tileRight;
    const tileBottomFrustum = bottom + (top - bottom) * tileBottom;
    const tileTopFrustum = bottom + (top - bottom) * tileTop;
    
    // Set custom projection matrix for this tile
    cameraRef.current.projectionMatrix.makePerspective(
      tileLeftFrustum,
      tileRightFrustum,
      tileTopFrustum,
      tileBottomFrustum,
      near,
      far
    );
    cameraRef.current.projectionMatrixInverse.copy(cameraRef.current.projectionMatrix).invert();
    
    // Set canvas/renderer to tile size
    canvasRef.current.width = width;
    canvasRef.current.height = height;
    rendererRef.current.setSize(width, height, false);
    
    // Apply exposure to renderer (converts EV to linear scale)
    const exposureScale = Math.pow(2, exposureRef.current);
    rendererRef.current.toneMappingExposure = exposureScale;
    
    // Update light intensities based on lightScale
    if (sceneRef.current) {
      sceneRef.current.traverse((obj) => {
        if (obj instanceof THREE.PointLight || obj instanceof THREE.DirectionalLight || obj instanceof THREE.SpotLight) {
          // Scale light intensity (preserve base intensity stored in userData)
          if (obj.userData.baseIntensity !== undefined) {
            obj.intensity = obj.userData.baseIntensity * lightScaleRef.current;
          }
        } else if (obj instanceof THREE.AmbientLight) {
          if (obj.userData.baseIntensity !== undefined) {
            obj.intensity = obj.userData.baseIntensity * lightScaleRef.current;
          }
        }
      });
    }
    
    // Update pathtracer with scene and camera
    pathtracerRef.current.setScene(sceneRef.current, cameraRef.current);
    pathtracerRef.current.reset();
    
    // Render samples - use value from task or default to 16
    const samples = taskSamples || 16;
    for (let i = 0; i < samples; i++) {
      pathtracerRef.current.renderSample();
    }
    
    // Read tile pixels
    const gl = rendererRef.current.getContext();
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    
    // Flip Y coordinate
    const flippedPixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIdx = ((height - 1 - y) * width + x) * 4;
        const dstIdx = (y * width + x) * 4;
        flippedPixels[dstIdx] = pixels[srcIdx];
        flippedPixels[dstIdx + 1] = pixels[srcIdx + 1];
        flippedPixels[dstIdx + 2] = pixels[srcIdx + 2];
        flippedPixels[dstIdx + 3] = pixels[srcIdx + 3];
      }
    }
    
    console.log(`[Render] Tile complete, sending...`);
    
    // Send result back to server
    socketRef.current.emit('tile_finished', {
      buffer: flippedPixels.buffer,
      startX,
      startY,
      width,
      height
    });

    setTilesProcessed((prev) => prev + 1);
    setStatus('Tile complete. Requesting next...');
  }, []);

  useEffect(() => {
    let isMounted = true;
    
    // Create hidden canvas for GPU rendering
    const canvas = document.createElement('canvas');
    canvas.style.display = 'none';
    document.body.appendChild(canvas);
    canvasRef.current = canvas;

    const serverUrl = import.meta.env.VITE_WS_SERVER_URL || `http://${window.location.hostname}:3000`;
    const socket = io(serverUrl, {
      transports: ['websocket'],
      upgrade: false,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      if (!isMounted) return;
      setIsConnected(true);
      setStatus('Connected. Awaiting payload...');
      socket.emit('register_worker');
    });

    socket.on('disconnect', () => {
      if (!isMounted) return;
      setIsConnected(false);
      setStatus('Lost connection to Swarm.');
    });

    socket.on('connect_error', (error) => {
      if (!isMounted) return;
      console.error('Connection error:', error);
      setErrorLog(`Connection error: ${error.message}`);
    });

    // 3. THE UNPACKER — read pre-merged scene geometry from the binary buffer
    socket.on('sync_geometry', async (payload) => {
      if (!isMounted) return;
      
      try {
        setStatus('Unpacking Geometry...');
        const { metadata, buffer } = payload;
        
        // Safety check: Socket.io sometimes wraps binary in a Buffer object
        const rawBuffer = buffer instanceof ArrayBuffer ? buffer : new Uint8Array(buffer).buffer;
        
        const m = metadata.geometry.merged;
        if (!m) throw new Error("Metadata missing merged scene data");

        const positions = new Float32Array(rawBuffer.slice(m.positionsOffset, m.positionsOffset + m.positionsLength));
        const indices = new Uint32Array(rawBuffer.slice(m.indicesOffset, m.indicesOffset + m.indicesLength));
        const bvhBuffer = new Float32Array(rawBuffer.slice(m.bvhOffset, m.bvhOffset + m.bvhLength));
        const colors = m.colorsLength > 0
          ? new Float32Array(rawBuffer.slice(m.colorsOffset, m.colorsOffset + m.colorsLength))
          : new Float32Array(0);
        const normals = m.normalsLength > 0
          ? new Float32Array(rawBuffer.slice(m.normalsOffset, m.normalsOffset + m.normalsLength))
          : new Float32Array(0);
        const emissive = m.emissiveLength > 0
          ? new Float32Array(rawBuffer.slice(m.emissiveOffset, m.emissiveOffset + m.emissiveLength))
          : new Float32Array(0);
        const ao = m.aoLength > 0
          ? new Float32Array(rawBuffer.slice(m.aoOffset, m.aoOffset + m.aoLength))
          : new Float32Array(0);

        geoCacheRef.current = { positions, indices, bvhBuffer, colors, normals, emissive, ao };
        
        const vertCount = positions.length / 3;
        const triCount = indices.length / 3;
        
        setStatus('Setting up GPU Pathtracer...');
        
        // Create Three.js scene and geometry
        const scene = new THREE.Scene();
        sceneRef.current = scene;
        
        // Create geometry from merged buffers
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        
        if (normals.length > 0) {
          geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        } else {
          geometry.computeVertexNormals();
        }
        
        if (colors.length > 0) {
          geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        }
        
        // Add emissive as a vertex attribute if available
        if (emissive.length > 0) {
          geometry.setAttribute('emissive', new THREE.BufferAttribute(emissive, 3));
        }
        
        // Check if any vertices have emissive values
        let hasEmissive = false;
        let maxEmissive = 0;
        let emissiveVertexCount = 0;
        if (emissive.length > 0) {
          for (let i = 0; i < emissive.length; i += 3) {
            const r = emissive[i];
            const g = emissive[i + 1];
            const b = emissive[i + 2];
            const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
            if (luminance > 0.01) {
              hasEmissive = true;
              emissiveVertexCount++;
              maxEmissive = Math.max(maxEmissive, luminance);
            }
          }
        }
        
        const totalVertices = positions.length / 3;
        const emissiveRatio = totalVertices > 0 ? emissiveVertexCount / totalVertices : 0;
        
        console.log(`[GPU] Emissive analysis: ${emissiveVertexCount}/${totalVertices} vertices (${(emissiveRatio * 100).toFixed(1)}%), max: ${maxEmissive.toFixed(3)}`);
        
        // Create material - use MeshPhysicalMaterial for better path tracing
        const material = new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          vertexColors: colors.length > 0,
          roughness: 0.7,
          metalness: 0.0,
          clearcoat: 0.0,
          side: THREE.FrontSide, // Use front side only to reduce shadow acne
          // Enhanced PBR properties for better lighting and shadows
          reflectivity: 0.5,
          envMapIntensity: 1.0,
          transparent: false,
          opacity: 1.0,
          depthWrite: true,
          depthTest: true,
          // Additional settings to help with shadow acne
          flatShading: false,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        
        // Enable emissive if any vertices have emissive colors
        // Note: MeshPhysicalMaterial doesn't support per-vertex emissive directly,
        // but we can enable it with an intensity that will be modulated by the vertex attribute
        if (hasEmissive) {
          material.emissive = new THREE.Color(1, 1, 1);
          // Scale emissive intensity based on the maximum found, with a reasonable multiplier
          // for visibility in the pathtracer
          const intensityScale = maxEmissive > 0.5 ? 1.0 : (maxEmissive > 0.1 ? 3.0 : 5.0);
          material.emissiveIntensity = maxEmissive * intensityScale;
          console.log(`[GPU] Enabled emissive with intensity: ${material.emissiveIntensity.toFixed(3)} (scale: ${intensityScale}x)`);
          
          // Inject custom shader code to read per-vertex emissive colors
          material.onBeforeCompile = (shader) => {
            // Add emissive attribute to vertex shader
            shader.vertexShader = shader.vertexShader.replace(
              '#include <common>',
              `#include <common>
              attribute vec3 emissive;
              varying vec3 vEmissive;`
            );
            
            shader.vertexShader = shader.vertexShader.replace(
              '#include <begin_vertex>',
              `#include <begin_vertex>
              vEmissive = emissive;`
            );
            
            // Use per-vertex emissive in fragment shader
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <common>',
              `#include <common>
              varying vec3 vEmissive;`
            );
            
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <emissivemap_fragment>',
              `#include <emissivemap_fragment>
              totalEmissiveRadiance *= vEmissive;`
            );
            
            console.log('[GPU] Custom emissive shader compiled');
          };
        }
        
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true; // Enable shadow casting from mesh
        mesh.receiveShadow = true; // Enable shadow receiving on mesh
        scene.add(mesh);
        
        // Setup camera
        const camera = new PhysicalCamera(50, 1, 0.1, 1000);
        camera.position.set(0, 0, 5);
        cameraRef.current = camera;
        
        // Setup renderer and pathtracer
        if (!rendererRef.current && canvasRef.current) {
          const renderer = new THREE.WebGLRenderer({ 
            canvas: canvasRef.current,
            antialias: false,
            powerPreference: 'high-performance',
            stencil: false,
            depth: true
          });
          renderer.outputColorSpace = THREE.SRGBColorSpace;
          renderer.toneMapping = THREE.ACESFilmicToneMapping;
          renderer.toneMappingExposure = 1.0; // Will be updated per-render
          
          // Enable shadow rendering
          renderer.shadowMap.enabled = true;
          renderer.shadowMap.type = THREE.PCFShadowMap; // High quality shadows
          
          rendererRef.current = renderer;
          
          const pathtracer = new WebGLPathTracer(renderer);
          pathtracer.tiles.set(1, 1);
          
          // Configure pathtracer for maximum quality
          // @ts-ignore - WebGLPathTracer properties
          if (pathtracer.bounces !== undefined) pathtracer.bounces = 8; // Max ray bounces for indirect lighting
          // @ts-ignore
          if (pathtracer.transmissiveBounces !== undefined) pathtracer.transmissiveBounces = 8; // Bounces through glass
          // @ts-ignore
          if (pathtracer.filterGlossyFactor !== undefined) pathtracer.filterGlossyFactor = 0.5; // Reduce fireflies
          // @ts-ignore - Additional settings to reduce shadow acne
          if (pathtracer.dynamicLowRes !== undefined) pathtracer.dynamicLowRes = false;
          // @ts-ignore
          if (pathtracer.minSamples !== undefined) pathtracer.minSamples = 1;
          
          pathtracerRef.current = pathtracer;
        }
        
        // Set scene background to black for proper lighting visibility
        scene.background = new THREE.Color(0x000000);
        scene.fog = null;
        
        // Add lights from GLTF metadata
        const lights = metadata.lights || [];
        console.log(`[GPU] Adding ${lights.length} lights from GLTF`);
        
        for (const lightDef of lights) {
          let light: THREE.Light;
          
          if (lightDef.type === 'point') {
            light = new THREE.PointLight(
              new THREE.Color(lightDef.color.r, lightDef.color.g, lightDef.color.b),
              lightDef.intensity,
              lightDef.distance,
              lightDef.decay
            );
            light.position.set(lightDef.position.x, lightDef.position.y, lightDef.position.z);
            light.castShadow = true;
            (light as THREE.PointLight).shadow.mapSize.width = 4096;
            (light as THREE.PointLight).shadow.mapSize.height = 4096;
            (light as THREE.PointLight).shadow.bias = -0.0005;
            (light as THREE.PointLight).shadow.normalBias = 0.01;
            (light as THREE.PointLight).shadow.radius = 2; // Softer shadow edges
            (light as THREE.PointLight).shadow.camera.near = 0.1;
            (light as THREE.PointLight).shadow.camera.far = lightDef.distance > 0 ? lightDef.distance : 100;
          } else if (lightDef.type === 'directional') {
            light = new THREE.DirectionalLight(
              new THREE.Color(lightDef.color.r, lightDef.color.g, lightDef.color.b),
              lightDef.intensity
            );
            light.position.set(lightDef.position.x, lightDef.position.y, lightDef.position.z);
            const targetPos = new THREE.Vector3(
              lightDef.position.x + lightDef.direction.x,
              lightDef.position.y + lightDef.direction.y,
              lightDef.position.z + lightDef.direction.z
            );
            (light as THREE.DirectionalLight).target.position.copy(targetPos);
            scene.add((light as THREE.DirectionalLight).target);
            light.castShadow = true;
            (light as THREE.DirectionalLight).shadow.mapSize.width = 4096;
            (light as THREE.DirectionalLight).shadow.mapSize.height = 4096;
            (light as THREE.DirectionalLight).shadow.bias = -0.0005;
            (light as THREE.DirectionalLight).shadow.normalBias = 0.01;
            (light as THREE.DirectionalLight).shadow.camera.near = 0.5;
            (light as THREE.DirectionalLight).shadow.camera.far = 100;
            // Adjust shadow camera frustum for better coverage
            (light as THREE.DirectionalLight).shadow.camera.left = -10;
            (light as THREE.DirectionalLight).shadow.camera.right = 10;
            (light as THREE.DirectionalLight).shadow.camera.top = 10;
            (light as THREE.DirectionalLight).shadow.camera.bottom = -10;
          } else if (lightDef.type === 'spot') {
            light = new THREE.SpotLight(
              new THREE.Color(lightDef.color.r, lightDef.color.g, lightDef.color.b),
              lightDef.intensity,
              lightDef.distance,
              lightDef.angle,
              lightDef.penumbra,
              lightDef.decay
            );
            light.position.set(lightDef.position.x, lightDef.position.y, lightDef.position.z);
            const targetPos = new THREE.Vector3(
              lightDef.position.x + lightDef.direction.x,
              lightDef.position.y + lightDef.direction.y,
              lightDef.position.z + lightDef.direction.z
            );
            (light as THREE.SpotLight).target.position.copy(targetPos);
            scene.add((light as THREE.SpotLight).target);
            light.castShadow = true;
            (light as THREE.SpotLight).shadow.mapSize.width = 4096;
            (light as THREE.SpotLight).shadow.mapSize.height = 4096;
            (light as THREE.SpotLight).shadow.bias = -0.0005;
            (light as THREE.SpotLight).shadow.normalBias = 0.01;
            (light as THREE.SpotLight).shadow.focus = 1; // Better shadow focus
            (light as THREE.SpotLight).shadow.radius = 2; // Softer shadow edges
            (light as THREE.SpotLight).shadow.camera.near = 0.1;
            (light as THREE.SpotLight).shadow.camera.far = lightDef.distance > 0 ? lightDef.distance : 100;
          } else {
            continue;
          }
          
          // Store base intensity for scaling
          light.userData.baseIntensity = lightDef.intensity;
          scene.add(light);
        }
        
        // Add minimal ambient light to prevent completely black shadows if no lights in scene
        if (lights.length === 0) {
          console.log('[GPU] No lights in GLTF, adding default ambient + point light');
          
          const ambientLight = new THREE.AmbientLight(0xffffff, 0.05);
          ambientLight.userData.baseIntensity = 0.05;
          scene.add(ambientLight);
          
          // Add a default point light
          const defaultLight = new THREE.PointLight(0xffffff, 100, 0);
          defaultLight.position.set(5, 5, 5);
          defaultLight.castShadow = true;
          defaultLight.shadow.mapSize.width = 4096;
          defaultLight.shadow.mapSize.height = 4096;
          defaultLight.shadow.bias = -0.0005;
          defaultLight.shadow.normalBias = 0.01;
          defaultLight.shadow.radius = 2; // Softer shadow edges
          defaultLight.shadow.camera.near = 0.1;
          defaultLight.shadow.camera.far = 100;
          defaultLight.userData.baseIntensity = 100;
          scene.add(defaultLight);
        } else {
          // Add very subtle ambient when lights exist
          const ambientLight = new THREE.AmbientLight(0xffffff, 0.02);
          ambientLight.userData.baseIntensity = 0.02;
          scene.add(ambientLight);
        }
        
        // Setup path tracing scene
        if (pathtracerRef.current && sceneRef.current && cameraRef.current) {
          pathtracerRef.current.setScene(scene, camera);
        }
        
        setStatus(`GPU Pathtracer Ready. (${vertCount} verts, ${triCount} tris)`);
        console.log(`[GPU] pathtracer ready: ${vertCount} verts, ${triCount} tris`);
        
        // RACE CONDITION RESOLVER: Did a task arrive while we were unpacking?
        if (pendingTaskRef.current) {
          setStatus(`Rendering queued tile [${pendingTaskRef.current.startX}, ${pendingTaskRef.current.startY}]...`);
          const queued = pendingTaskRef.current;
          pendingTaskRef.current = null;
          await renderTile(queued);
        }

      } catch (err: any) {
        console.error("Setup error:", err);
        setErrorLog(`Setup Error: ${err.message}`);
        setStatus('Error during setup.');
      }
    });

    // 4. RECEIVE A MICRO-CHUNK TASK
    socket.on('assign_tile', async (task) => {
      if (!isMounted) return;
      
      if (!pathtracerRef.current || !geoCacheRef.current) {
        console.warn("Race condition: Task arrived before geometry. Queuing it.");
        setStatus('Task arrived early. Holding...');
        pendingTaskRef.current = task;
        return;
      }

      setStatus(`Rendering tile [${task.startX}, ${task.startY}]...`);
      await renderTile(task);
    });

    return () => {
      isMounted = false;
      socket.disconnect();
      
      if (canvasRef.current && document.body.contains(canvasRef.current)) {
        document.body.removeChild(canvasRef.current);
      }
      
      if (rendererRef.current) {
        rendererRef.current.dispose();
        rendererRef.current = null;
      }
      
      if (pathtracerRef.current) {
        pathtracerRef.current.dispose();
        pathtracerRef.current = null;
      }
    };
  }, [renderTile]);

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6 text-center font-sans">
      <div className={`w-24 h-24 mb-8 rounded-full border-4 border-t-transparent animate-spin ${isConnected ? 'border-cyan-500' : 'border-slate-600'}`}></div>
      
      <h1 className="text-4xl font-bold text-white mb-3 tracking-tight">Shard Node</h1>
      <p className="text-cyan-400 font-mono text-lg mb-4 h-6">{status}</p>
      
      {/* Dynamic Error Log Output */}
      {errorLog && (
        <p className="text-red-400 font-mono text-xs mb-6 max-w-sm bg-red-900/30 p-2 rounded border border-red-700">
          {errorLog}
        </p>
      )}
      
      <div className="bg-slate-800 rounded-2xl p-8 w-full max-w-sm border border-slate-700 shadow-xl relative overflow-hidden mt-4">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-cyan-500 via-purple-500 to-cyan-500 opacity-50"></div>
        
        <h2 className="text-slate-400 text-xs font-bold uppercase tracking-widest mb-3">Compute Contribution</h2>
        <div className="flex items-baseline justify-center space-x-2">
          <p className="text-7xl font-black text-white">{tilesProcessed}</p>
          <span className="text-xl text-slate-500 font-medium">tiles</span>
        </div>
      </div>

      <div className="mt-12 flex items-center space-x-2 opacity-50">
        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
        <span className="text-slate-400 text-sm font-mono">{isConnected ? 'Uplink Established' : 'Offline'}</span>
      </div>
    </div>
  );
}