import { useEffect, useState, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import * as THREE from 'three';
import { 
  WebGLPathTracer, 
  PhysicalCamera
} from 'three-gpu-pathtracer';
import renderConfig from './config/renderConfig.json';
import { renderTile as executeTileRender, AdvancedSettings } from './rendering/TileRenderer';

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
  
  // Advanced settings refs (can be updated per render)
  const toneMappingRef = useRef<string>('ACESFilmic');
  const shadowMapTypeRef = useRef<string>('PCFShadowMap');
  const shadowMapSizeRef = useRef<number>(4096);
  const rayBouncesRef = useRef<number>(32);
  
  // THE WAITING ROOM: Holds tasks if they arrive before geometry or while rendering
  const pendingTasksRef = useRef<any[]>([]);
  const isRenderingRef = useRef<boolean>(false);
  const geometryVersionRef = useRef<number>(0);
  const pendingGeometryRef = useRef<any>(null);
  const processGeometryRef = useRef<((payload: any) => Promise<void>) | null>(null);

  // Helper function to render a tile
  const renderTile = useCallback(async (task: any) => {
    if (!pathtracerRef.current || !cameraRef.current || !rendererRef.current || !canvasRef.current || !socketRef.current || !sceneRef.current) {
      console.error('Pathtracer not initialized');
      return;
    }

    // Mark as rendering to prevent geometry updates
    isRenderingRef.current = true;
    const renderGeometryVersion = geometryVersionRef.current;

    const { masterSocketId } = task;
    
    // Prepare advanced settings object
    const advancedSettings: AdvancedSettings = {
      toneMapping: toneMappingRef.current,
      shadowMapType: shadowMapTypeRef.current,
      shadowMapSize: shadowMapSizeRef.current,
      rayBounces: rayBouncesRef.current
    };
    
    try {
      // Execute tile rendering using the extracted module
      const result = await executeTileRender(
        task,
        canvasRef.current,
        rendererRef.current,
        pathtracerRef.current,
        sceneRef.current,
        cameraRef.current,
        advancedSettings,
        exposureRef,
        lightScaleRef
      );
      
      // Check if geometry was updated during render
      if (renderGeometryVersion !== geometryVersionRef.current) {
        console.warn(`[Render] Geometry changed during render (v${renderGeometryVersion} -> v${geometryVersionRef.current}), tile may be invalid`);
      }
      
      // Mark as not rendering BEFORE sending tile_finished
      isRenderingRef.current = false;
      
      // Send result back to server with masterSocketId for proper routing
      console.log(`[Render] Emitting tile_finished for (${result.startX},${result.startY})`);
      socketRef.current.emit('tile_finished', {
        buffer: result.pixels.buffer,
        startX: result.startX,
        startY: result.startY,
        width: result.width,
        height: result.height,
        masterSocketId
      }, (ack: any) => {
        if (ack && ack.status === 'received') {
          console.log(`[Render] Server acknowledged tile (${result.startX},${result.startY}), pool size: ${ack.poolSize}`);
        } else if (ack && ack.status === 'error') {
          console.error(`[Render] Server reported error for tile (${result.startX},${result.startY}): ${ack.error}`);
        } else if (ack && ack.status === 'skipped') {
          console.log(`[Render] Server skipped and requeued tile (${result.startX},${result.startY})`);
        } else {
          console.warn(`[Render] No acknowledgment from server for tile (${result.startX},${result.startY})`);
        }
      });

      setTilesProcessed((prev) => prev + 1);
      setStatus('Tile complete. Ready for next...');
      
    } catch (err: any) {
      console.error(`[Render] Exception during tile rendering:`, err);
      isRenderingRef.current = false;
      setErrorLog(`Rendering failed: ${err.message}`);
      return;
    }
    
    // If geometry update arrived while rendering, process it now
    if (pendingGeometryRef.current && processGeometryRef.current) {
      console.log('[Render] Processing queued geometry update...');
      const pendingPayload = pendingGeometryRef.current;
      pendingGeometryRef.current = null;
      // Process the queued geometry update (it will emit worker_ready when done)
      await processGeometryRef.current(pendingPayload);
    } else {
      // No pending geometry update - signal we're ready for next tile
      console.log(`[Render] Emitting worker_ready after tile`);
      if (socketRef.current) {
        socketRef.current.emit('worker_ready');
      }
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    
    // Detect mobile device
    const checkMobile = () => {
      const ua = navigator.userAgent.toLowerCase();
      const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(ua);
      const isMobileTouchScreen = ('ontouchstart' in window) && navigator.maxTouchPoints > 1;
      return isMobileUA || isMobileTouchScreen;
    };
    const mobile = checkMobile();
    console.log(`[Device] Mobile device detected: ${mobile}`);
    
    // Create hidden canvas for GPU rendering
    const canvas = document.createElement('canvas');
    canvas.style.display = 'none';
    document.body.appendChild(canvas);
    canvasRef.current = canvas;
    
    // Add WebGL context loss handlers (critical for mobile)
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      console.error('[WebGL] Context lost! This is common on mobile devices.');
      setErrorLog('GPU context lost. Reconnecting...');
      setStatus('GPU context lost. Please refresh.');
      isRenderingRef.current = false;
      // Notify server that we're not available
      if (socketRef.current) {
        socketRef.current.emit('worker_unavailable', { reason: 'context_lost' });
      }
    };
    
    const handleContextRestored = () => {
      console.log('[WebGL] Context restored. Reconnecting...');
      setErrorLog('GPU context restored.');
      // We'd need to rebuild everything - for now just ask for refresh
      setStatus('GPU restored. Please refresh page.');
    };
    
    canvas.addEventListener('webglcontextlost', handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', handleContextRestored, false);

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

    // Helper function to process geometry updates (defined in useEffect scope)
    const processGeometryUpdate = async (payload: any) => {
      try {
        geometryVersionRef.current++;
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
        const uvs = m.uvsLength > 0
          ? new Float32Array(rawBuffer.slice(m.uvsOffset, m.uvsOffset + m.uvsLength))
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
        
        // Add UVs if available
        if (uvs.length > 0) {
          geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
          console.log(`[GPU] Added ${uvs.length / 2} UV coordinates to geometry`);
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
        
        // Extract and create texture if available
        let baseColorTexture: THREE.Texture | null = null;
        // Check if any mesh has texture data
        const meshWithTexture = metadata.geometry.meshes.find((mesh: any) => mesh.hasTexture);
        if (meshWithTexture && meshWithTexture.textureOffset !== undefined && meshWithTexture.textureWidth && meshWithTexture.textureHeight) {
          try {
            console.log(`[GPU] Loading texture from mesh "${meshWithTexture.name}": ${meshWithTexture.textureWidth}x${meshWithTexture.textureHeight}`);
            
            // Extract texture data from buffer
            const textureData = new Uint8ClampedArray(
              rawBuffer.slice(meshWithTexture.textureOffset, meshWithTexture.textureOffset + meshWithTexture.textureLength!)
            );
            
            // Create canvas and context to convert ImageData to texture
            const canvas = document.createElement('canvas');
            canvas.width = meshWithTexture.textureWidth;
            canvas.height = meshWithTexture.textureHeight;
            const ctx = canvas.getContext('2d');
            
            if (ctx) {
              // Create ImageData from the raw texture data
              const imageData = new ImageData(textureData, meshWithTexture.textureWidth, meshWithTexture.textureHeight);
              ctx.putImageData(imageData, 0, 0);
              
              // Create Three.js texture from canvas
              baseColorTexture = new THREE.CanvasTexture(canvas);
              baseColorTexture.wrapS = meshWithTexture.textureWrapS || THREE.RepeatWrapping;
              baseColorTexture.wrapT = meshWithTexture.textureWrapT || THREE.RepeatWrapping;
              baseColorTexture.magFilter = meshWithTexture.textureMagFilter || THREE.LinearFilter;
              baseColorTexture.minFilter = meshWithTexture.textureMinFilter || THREE.LinearMipmapLinearFilter;
              baseColorTexture.colorSpace = THREE.SRGBColorSpace;
              baseColorTexture.needsUpdate = true;
              
              console.log(`[GPU] Texture created successfully`);
            }
          } catch (err) {
            console.error(`[GPU] Failed to create texture:`, err);
          }
        }
        
        // Create material - use MeshPhysicalMaterial for better path tracing
        const material = new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          map: baseColorTexture, // Apply texture if available
          vertexColors: colors.length > 0 && !baseColorTexture, // Use vertex colors only if no texture
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
          try {
            // Use mobile-friendly settings
            const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            console.log(`[GPU] Initializing WebGL renderer (mobile: ${isMobileDevice})`);
            
            const renderer = new THREE.WebGLRenderer({ 
              canvas: canvasRef.current,
              antialias: renderConfig.renderer.antialias,
              powerPreference: isMobileDevice ? 'default' : renderConfig.renderer.powerPreference,
              stencil: renderConfig.renderer.stencil,
              depth: renderConfig.renderer.depth,
              failIfMajorPerformanceCaveat: renderConfig.renderer.failIfMajorPerformanceCaveat
            });
            
            // Verify WebGL context was created
            const gl = renderer.getContext();
            if (!gl) {
              throw new Error('Failed to get WebGL context from renderer');
            }
            
            console.log(`[GPU] WebGL context created successfully`);
            console.log(`[GPU] WebGL version: ${gl.getParameter(gl.VERSION)}`);
            console.log(`[GPU] Renderer: ${gl.getParameter(gl.RENDERER)}`);
            console.log(`[GPU] Max texture size: ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`);
            
            renderer.outputColorSpace = THREE.SRGBColorSpace;
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = renderConfig.renderer.toneMappingExposure;
            
            // Enable shadow rendering - use config settings
            renderer.shadowMap.enabled = renderConfig.shadows.enabled;
            renderer.shadowMap.type = THREE.BasicShadowMap;
            console.log(`[GPU] Shadow map type: ${renderConfig.shadows.type} (mobile-optimized)`);
            
            rendererRef.current = renderer;
            
            console.log(`[GPU] Creating WebGLPathTracer...`);
            const pathtracer = new WebGLPathTracer(renderer);
            pathtracer.tiles.set(1, 1);
            
            // Configure pathtracer with config settings
            // @ts-ignore - WebGLPathTracer properties
            if (pathtracer.bounces !== undefined) pathtracer.bounces = renderConfig.pathtracer.bounces;
            // @ts-ignore
            if (pathtracer.transmissiveBounces !== undefined) pathtracer.transmissiveBounces = renderConfig.pathtracer.transmissiveBounces;
            // @ts-ignore
            if (pathtracer.filterGlossyFactor !== undefined) pathtracer.filterGlossyFactor = renderConfig.pathtracer.filterGlossyFactor;
            // @ts-ignore
            if (pathtracer.dynamicLowRes !== undefined) pathtracer.dynamicLowRes = renderConfig.pathtracer.dynamicLowRes;
            // @ts-ignore
            if (pathtracer.minSamples !== undefined) pathtracer.minSamples = renderConfig.pathtracer.minSamples;
            
            console.log(`[GPU] Pathtracer configured with ${renderConfig.pathtracer.bounces} bounces`);
            pathtracerRef.current = pathtracer;
          } catch (err: any) {
            console.error('[GPU] Failed to initialize renderer/pathtracer:', err);
            setErrorLog(`WebGL initialization failed: ${err.message}`);
            throw err; // Re-throw to be caught by outer try-catch
          }
        }
        
        // Set scene background to black for proper lighting visibility
        scene.background = new THREE.Color(0x000000);
        scene.fog = null;
        
        // Add lights from GLTF metadata
        const lights = metadata.lights || [];
        console.log(`[GPU] Adding ${lights.length} lights from GLTF`);
        
        // Use shadow map size from config
        const shadowMapSize = renderConfig.shadows.mapSize;
        console.log(`[GPU] Using shadow map size: ${shadowMapSize}x${shadowMapSize} (from config)`);
        
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
            light.castShadow = renderConfig.shadows.enabled;
            (light as THREE.PointLight).shadow.mapSize.width = shadowMapSize;
            (light as THREE.PointLight).shadow.mapSize.height = shadowMapSize;
            (light as THREE.PointLight).shadow.bias = renderConfig.shadows.bias;
            (light as THREE.PointLight).shadow.normalBias = renderConfig.shadows.normalBias;
            (light as THREE.PointLight).shadow.radius = renderConfig.shadows.radius;
            (light as THREE.PointLight).shadow.camera.near = renderConfig.shadows.cameraNear;
            (light as THREE.PointLight).shadow.camera.far = lightDef.distance > 0 ? lightDef.distance : renderConfig.shadows.cameraFar;
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
            light.castShadow = renderConfig.shadows.enabled;
            (light as THREE.DirectionalLight).shadow.mapSize.width = shadowMapSize;
            (light as THREE.DirectionalLight).shadow.mapSize.height = shadowMapSize;
            (light as THREE.DirectionalLight).shadow.bias = renderConfig.shadows.bias;
            (light as THREE.DirectionalLight).shadow.normalBias = renderConfig.shadows.normalBias;
            (light as THREE.DirectionalLight).shadow.camera.near = 0.5;
            (light as THREE.DirectionalLight).shadow.camera.far = renderConfig.shadows.cameraFar;
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
            light.castShadow = renderConfig.shadows.enabled;
            (light as THREE.SpotLight).shadow.mapSize.width = shadowMapSize;
            (light as THREE.SpotLight).shadow.mapSize.height = shadowMapSize;
            (light as THREE.SpotLight).shadow.bias = renderConfig.shadows.bias;
            (light as THREE.SpotLight).shadow.normalBias = renderConfig.shadows.normalBias;
            (light as THREE.SpotLight).shadow.focus = 1; // Better shadow focus
            (light as THREE.SpotLight).shadow.radius = renderConfig.shadows.radius;
            (light as THREE.SpotLight).shadow.camera.near = renderConfig.shadows.cameraNear;
            (light as THREE.SpotLight).shadow.camera.far = lightDef.distance > 0 ? lightDef.distance : renderConfig.shadows.cameraFar;
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
          defaultLight.castShadow = renderConfig.shadows.enabled;
          defaultLight.shadow.mapSize.width = shadowMapSize;
          defaultLight.shadow.mapSize.height = shadowMapSize;
          defaultLight.shadow.bias = renderConfig.shadows.bias;
          defaultLight.shadow.normalBias = renderConfig.shadows.normalBias;
          defaultLight.shadow.radius = renderConfig.shadows.radius;
          defaultLight.shadow.camera.near = renderConfig.shadows.cameraNear;
          defaultLight.shadow.camera.far = renderConfig.shadows.cameraFar;
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
        
        // RACE CONDITION RESOLVER: Did tasks arrive while we were unpacking?
        if (pendingTasksRef.current.length > 0) {
          console.log(`[GPU] Processing ${pendingTasksRef.current.length} queued tile(s)...`);
          const queued = [...pendingTasksRef.current];
          pendingTasksRef.current = [];
          for (const task of queued) {
            setStatus(`Rendering queued tile [${task.startX}, ${task.startY}]...`);
            await renderTile(task);
            // tile_finished atomically returns worker to pool
          }
        } else {
          // No pending tasks, signal we're ready for first task
          console.log('[GPU] Emitting worker_ready (initial)');
          socket.emit('worker_ready');
        }

      } catch (err: any) {
        console.error("Setup error:", err);
        setErrorLog(`Setup Error: ${err.message}`);
        setStatus('Error during setup.');
      }
    };
    
    // Store function in ref so renderTile can access it
    processGeometryRef.current = processGeometryUpdate;

    // 3. THE UNPACKER — read pre-merged scene geometry from the binary buffer
    socket.on('sync_geometry', async (payload) => {
      if (!isMounted) return;
      
      // Don't process new geometry while rendering - queue it for later
      if (isRenderingRef.current) {
        console.warn('[sync_geometry] Worker is busy rendering, geometry update queued');
        pendingGeometryRef.current = payload;
        return;
      }
      
      await processGeometryUpdate(payload);
    });

    // 4. RECEIVE A MICRO-CHUNK TASK
    socket.on('assign_tile', async (task, acknowledgeFn) => {
      if (!isMounted) return;
      
      console.log(`[Worker] Received assign_tile for (${task.startX},${task.startY})`);
      
      // ALWAYS acknowledge immediately to prevent server timeout
      // Check if we can actually handle this tile
      if (!pathtracerRef.current || !geoCacheRef.current) {
        console.warn("[Worker] Task arrived before geometry. Rejecting.");
        console.warn(`[Worker] pathtracerRef: ${!!pathtracerRef.current}, geoCacheRef: ${!!geoCacheRef.current}`);
        setStatus('Task arrived early. Rejecting...');
        if (acknowledgeFn && typeof acknowledgeFn === 'function') {
          acknowledgeFn({ status: 'rejected', reason: 'geometry_not_ready' });
        }
        return;
      }
      
      // Check if already rendering - this is the key check
      if (isRenderingRef.current) {
        console.warn("[Worker] Worker is BUSY rendering. Rejecting tile.");
        if (acknowledgeFn && typeof acknowledgeFn === 'function') {
          acknowledgeFn({ status: 'rejected', reason: 'busy' });
        }
        return;
      }

      // Only acknowledge if we're actually going to render it
      if (acknowledgeFn && typeof acknowledgeFn === 'function') {
        console.log(`[Worker] Acknowledging tile assignment (${task.startX},${task.startY})`);
        acknowledgeFn({ status: 'accepted', workerId: socket.id });
      } else {
        console.warn(`[Worker] No acknowledgeFn provided for tile (${task.startX},${task.startY})`);
      }

      console.log(`[Worker] Starting render for (${task.startX},${task.startY})`);
      setStatus(`Rendering tile [${task.startX}, ${task.startY}]...`);
      
      try {
        await renderTile(task);
      } catch (err: any) {
        console.error(`[Worker] Error rendering tile (${task.startX},${task.startY}):`, err);
        setErrorLog(`Render error: ${err.message}`);
        // Mark as not rendering so we can accept new tiles
        isRenderingRef.current = false;
        // Notify server we're ready again
        socket.emit('worker_ready');
      }
    });

    return () => {
      isMounted = false;
      socket.disconnect();
      
      if (canvasRef.current) {
        // Remove WebGL context loss handlers
        canvasRef.current.removeEventListener('webglcontextlost', handleContextLost as EventListener);
        canvasRef.current.removeEventListener('webglcontextrestored', handleContextRestored as EventListener);
        
        if (document.body.contains(canvasRef.current)) {
          document.body.removeChild(canvasRef.current);
        }
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