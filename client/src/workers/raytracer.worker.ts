import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';

// @ts-ignore - for worker scope
const _self = self as any;
globalThis.length = 0; // Polyfill for three-gpu-pathtracer bug that assumes `window.length` exists!

let renderer: THREE.WebGLRenderer | null = null;
let pathTracer: WebGLPathTracer | null = null;
let currentCamera: THREE.PerspectiveCamera | null = null;
let currentScene: THREE.Scene | null = null;
let currentFileUrl: string | null = null;

_self.onmessage = async (event: MessageEvent) => {
  const data = event.data;

  if (data.type === 'render_tile') {
    const {
      fileUrl,
      startX, startY, width, height,
      canvasWidth, canvasHeight,
      camera: camData
    } = data;

    // 1. Initialize WebGL on OffscreenCanvas
    if (!renderer) {
      const canvas = new OffscreenCanvas(width, height);
      const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext;
      
      renderer = new THREE.WebGLRenderer({ canvas, context: gl });
      renderer.setPixelRatio(1);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      
      pathTracer = new WebGLPathTracer(renderer);
      // Fast quality settings
      pathTracer.bounces = 3;
      pathTracer.tiles.set(1, 1);
      pathTracer.renderScale = 1;
      
      currentScene = new THREE.Scene();
      // Add a simple environment
      currentScene.background = new THREE.Color(0x1a1a20);
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
      currentScene.add(ambientLight);
      const dirLight = new THREE.DirectionalLight(0xffffff, 2);
      dirLight.position.set(5, 10, 5);
      currentScene.add(dirLight);
    }

    // Fix context sizing for this exact tile
    // WebGLRenderer resets target if we resize canvas, so we do it
    renderer.setSize(width, height, false);

    // 2. Load GLB Model if it's new
    if (fileUrl !== currentFileUrl && currentScene) {
      try {
        console.log(`[Worker] Loading model via HTTP: ${fileUrl}`);
        const loader = new GLTFLoader();
        
        // Add DRACO loader in case the GLB uses Draco mesh compression
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
        loader.setDRACOLoader(dracoLoader);
        
        // Remove old models if any
        const objectsToRemove: THREE.Object3D[] = [];
        currentScene.children.forEach(c => {
          if (c.userData.isModel) objectsToRemove.push(c);
        });
        objectsToRemove.forEach(o => currentScene!.remove(o));

        const gltf = await loader.loadAsync(fileUrl);
        gltf.scene.userData.isModel = true;
        
        // Ensure materials are DoubleSide for better pathtracing robustness
        gltf.scene.traverse((c) => {
          if ((c as THREE.Mesh).isMesh) {
            const m = (c as THREE.Mesh).material;
            if (m) (m as THREE.Material).side = THREE.DoubleSide;
          }
        });

        currentScene.add(gltf.scene);
        currentFileUrl = fileUrl;
        
        console.log(`[Worker] Model Loaded. Updating PathTracer Scene...`);
        // We set scene below
      } catch (err) {
        console.error("[Worker] GLB Load Error:", err);
        return; // drop tile
      }
    }

    // 3. Update Camera
    if (!currentCamera) {
      currentCamera = new THREE.PerspectiveCamera(camData?.fov || 50, canvasWidth / canvasHeight, 0.1, 1000);
    }
    
    currentCamera.aspect = canvasWidth / canvasHeight;
    // Set position and view matrix
    if (camData?.cameraPos) {
      currentCamera.position.set(camData.cameraPos.x, camData.cameraPos.y, camData.cameraPos.z);
    }
    if (camData?.viewMatrix) {
      currentCamera.matrixAutoUpdate = false;
      currentCamera.matrixWorld.fromArray(camData.viewMatrix);
    } else {
      currentCamera.updateMatrixWorld();
    }
    
    // THE SECRET SAUCE: Tell the camera to only render THIS TILE
    currentCamera.setViewOffset(canvasWidth, canvasHeight, startX, startY, width, height);
    currentCamera.updateProjectionMatrix();

    // 4. Update PathTracer
    if (pathTracer && currentScene && currentCamera) {
      // setScene builds the BVH if scene changed.
      pathTracer.setScene(currentScene, currentCamera);
      pathTracer.updateCamera();

      // Reset accumulation
      pathTracer.reset();

      // 5. Render N samples
      const SAMPLES = 25; // Good balance for web workers
      for (let i = 0; i < SAMPLES; i++) {
        pathTracer.renderSample();
      }

      // 6. Read Pixels out of the render target
      const readBuffer = new Uint8Array(width * height * 4);
      
      // WebGLPathTracer renders to the canvas by default (renderToCanvas=true),
      // which automatically tone-maps the internal float buffers to Uint8 for display.
      // We can directly capture this resulting RGBA Uint8 byte array!
      const gl = renderer.getContext();
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, readBuffer);

      // WebGL reads bottom-up. Canvas expects top-down. We MUST flip Y!
      const flippedBuffer = new Uint8ClampedArray(width * height * 4);
      const rowBytes = width * 4;
      for (let r = 0; r < height; r++) {
        const srcOffset = (height - 1 - r) * rowBytes;
        const dstOffset = r * rowBytes;
        flippedBuffer.set(readBuffer.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
      }

      // 7. Send back
      _self.postMessage({
        buffer: flippedBuffer.buffer, 
        startX, 
        startY, 
        width, 
        height
      }, [flippedBuffer.buffer]);
    }
  }
};