import * as THREE from 'three';
import { WebGLPathTracer, PhysicalCamera } from 'three-gpu-pathtracer';
import renderConfig from '../config/renderConfig.json';

export interface TileRenderTask {
  startX: number;
  startY: number;
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
  camera?: {
    cameraPos?: { x: number; y: number; z: number };
    viewMatrix?: number[];
    fov?: number;
    exposure?: number;
    lightScale?: number;
    advancedSettings?: {
      toneMapping?: string;
      shadowMapType?: string;
      shadowMapSize?: number;
      rayBounces?: number;
      antialias?: boolean;
    };
  };
  samples?: number;
  masterSocketId?: string;
}

export interface RenderResult {
  pixels: Uint8Array;
  startX: number;
  startY: number;
  width: number;
  height: number;
}

export interface AdvancedSettings {
  toneMapping: string;
  shadowMapType: string;
  shadowMapSize: number;
  rayBounces: number;
}

/**
 * Apply advanced rendering settings to the renderer and pathtracer
 */
export function applyAdvancedSettings(
  renderer: THREE.WebGLRenderer,
  pathtracer: WebGLPathTracer,
  scene: THREE.Scene,
  settings: AdvancedSettings
): void {
  // Apply tone mapping
  const toneMappingMap: { [key: string]: THREE.ToneMapping } = {
    'NoToneMapping': THREE.NoToneMapping,
    'LinearToneMapping': THREE.LinearToneMapping,
    'ReinhardToneMapping': THREE.ReinhardToneMapping,
    'CineonToneMapping': THREE.CineonToneMapping,
    'ACESFilmicToneMapping': THREE.ACESFilmicToneMapping,
  };
  renderer.toneMapping = toneMappingMap[settings.toneMapping] || THREE.ACESFilmicToneMapping;
  
  // Apply shadow map type
  const shadowMapMap: { [key: string]: THREE.ShadowMapType } = {
    'BasicShadowMap': THREE.BasicShadowMap,
    'PCFShadowMap': THREE.PCFShadowMap,
    'PCFSoftShadowMap': THREE.PCFSoftShadowMap,
  };
  renderer.shadowMap.type = shadowMapMap[settings.shadowMapType] || THREE.PCFShadowMap;
  
  // Apply ray bounces
  // @ts-ignore - WebGLPathTracer properties
  if (pathtracer.bounces !== undefined) pathtracer.bounces = settings.rayBounces;
  // @ts-ignore
  if (pathtracer.transmissiveBounces !== undefined) pathtracer.transmissiveBounces = settings.rayBounces;
  
  // Update shadow map sizes on all lights
  scene.traverse((obj) => {
    if (obj instanceof THREE.PointLight || obj instanceof THREE.DirectionalLight || obj instanceof THREE.SpotLight) {
      if (obj.shadow && obj.shadow.mapSize) {
        obj.shadow.mapSize.width = settings.shadowMapSize;
        obj.shadow.mapSize.height = settings.shadowMapSize;
      }
    }
  });
  
  console.log(`[Renderer] Applied settings - ToneMapping: ${settings.toneMapping}, Shadows: ${settings.shadowMapType} ${settings.shadowMapSize}, Bounces: ${settings.rayBounces}`);
}

/**
 * Setup camera for tile-based rendering with perspective-correct frustum
 */
export function setupTileCamera(
  camera: PhysicalCamera,
  task: TileRenderTask
): void {
  const { startX, startY, width, height, canvasWidth, canvasHeight, camera: cameraData } = task;
  
  // Update camera from task data
  if (cameraData) {
    if (cameraData.cameraPos) {
      camera.position.set(
        cameraData.cameraPos.x,
        cameraData.cameraPos.y,
        cameraData.cameraPos.z
      );
    }
    
    if (cameraData.viewMatrix) {
      camera.matrixAutoUpdate = false;
      camera.matrix.fromArray(cameraData.viewMatrix);
      camera.matrixWorldNeedsUpdate = true;
    }
    
    if (cameraData.fov) {
      camera.fov = cameraData.fov;
    }
  }
  
  // Set aspect ratio for full canvas
  camera.aspect = canvasWidth / canvasHeight;
  
  // Calculate tile frustum (Y-flipped for OpenGL coordinates)
  const tileLeft = startX / canvasWidth;
  const tileRight = (startX + width) / canvasWidth;
  const tileBottom = 1.0 - ((startY + height) / canvasHeight);
  const tileTop = 1.0 - (startY / canvasHeight);
  
  // Manual projection matrix calculation
  const fov = camera.fov * (Math.PI / 180);
  const aspect = canvasWidth / canvasHeight;
  const near = camera.near;
  const far = camera.far;
  
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
  camera.projectionMatrix.makePerspective(
    tileLeftFrustum,
    tileRightFrustum,
    tileTopFrustum,
    tileBottomFrustum,
    near,
    far
  );
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/**
 * Update scene lighting based on exposure and light scale
 */
export function updateSceneLighting(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  exposure: number,
  lightScale: number
): void {
  // Apply exposure to renderer (converts EV to linear scale)
  const exposureScale = Math.pow(2, exposure);
  renderer.toneMappingExposure = exposureScale;
  
  // Update light intensities based on lightScale
  scene.traverse((obj) => {
    if (obj instanceof THREE.PointLight || obj instanceof THREE.DirectionalLight || obj instanceof THREE.SpotLight || obj instanceof THREE.AmbientLight) {
      if (obj.userData.baseIntensity !== undefined) {
        obj.intensity = obj.userData.baseIntensity * lightScale;
      }
    }
  });
}

/**
 * Read and validate pixels from the renderer
 */
export function readAndValidatePixels(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  width: number,
  height: number
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  
  // Check for WebGL errors before reading
  const preError = gl.getError();
  if (preError !== gl.NO_ERROR) {
    console.error(`[Renderer] WebGL error before readPixels: ${preError}`);
  }
  
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  
  // Check if readPixels succeeded
  const postError = gl.getError();
  if (postError !== gl.NO_ERROR) {
    console.error(`[Renderer] WebGL error during readPixels: ${postError}`);
    console.error(`[Renderer] This is common on mobile devices with limited GPU memory`);
  }
  
  // Verify we got valid data
  let nonZeroPixels = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0) {
      nonZeroPixels++;
      if (nonZeroPixels > 10) break;
    }
  }
  
  if (nonZeroPixels === 0) {
    console.warn(`[Renderer] WARNING: All pixels are black!`);
    console.warn(`[Renderer] Context state: isContextLost=${gl.isContextLost()}`);
  } else {
    console.log(`[Renderer] Pixel data OK: ${nonZeroPixels}+ non-black pixels found`);
  }
  
  return pixels;
}

/**
 * Flip pixel data vertically (OpenGL to screen coordinate system)
 */
export function flipPixelsVertically(
  pixels: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const flipped = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = ((height - 1 - y) * width + x) * 4;
      const dstIdx = (y * width + x) * 4;
      flipped[dstIdx] = pixels[srcIdx];
      flipped[dstIdx + 1] = pixels[srcIdx + 1];
      flipped[dstIdx + 2] = pixels[srcIdx + 2];
      flipped[dstIdx + 3] = pixels[srcIdx + 3];
    }
  }
  return flipped;
}

/**
 * Render a single tile using the pathtracer
 */
export async function renderTile(
  task: TileRenderTask,
  canvas: HTMLCanvasElement,
  renderer: THREE.WebGLRenderer,
  pathtracer: WebGLPathTracer,
  scene: THREE.Scene,
  camera: PhysicalCamera,
  advancedSettings: AdvancedSettings,
  exposureRef: { current: number },
  lightScaleRef: { current: number }
): Promise<RenderResult> {
  const { startX, startY, width, height, camera: cameraData, samples: taskSamples } = task;
  
  console.log(`[Renderer] Rendering tile [${startX},${startY}] ${width}x${height} with ${taskSamples || renderConfig.render.defaultSamples} samples`);
  
  // Extract settings from task
  if (cameraData) {
    if (cameraData.exposure !== undefined) exposureRef.current = cameraData.exposure;
    if (cameraData.lightScale !== undefined) lightScaleRef.current = cameraData.lightScale;
    
    if (cameraData.advancedSettings) {
      const adv = cameraData.advancedSettings;
      if (adv.toneMapping !== undefined) advancedSettings.toneMapping = adv.toneMapping;
      if (adv.shadowMapType !== undefined) advancedSettings.shadowMapType = adv.shadowMapType;
      if (adv.shadowMapSize !== undefined) advancedSettings.shadowMapSize = adv.shadowMapSize;
      if (adv.rayBounces !== undefined) advancedSettings.rayBounces = adv.rayBounces;
    }
  }
  
  // Apply advanced settings
  applyAdvancedSettings(renderer, pathtracer, scene, advancedSettings);
  
  // Setup camera for tile rendering
  setupTileCamera(camera, task);
  
  // Set canvas and renderer to tile size
  canvas.width = width;
  canvas.height = height;
  renderer.setSize(width, height, false);
  
  // Update scene lighting
  updateSceneLighting(scene, renderer, exposureRef.current, lightScaleRef.current);
  
  // Update pathtracer
  pathtracer.setScene(scene, camera);
  pathtracer.reset();
  
  // Render samples
  const samples = taskSamples || renderConfig.render.defaultSamples;
  for (let i = 0; i < samples; i++) {
    pathtracer.renderSample();
  }
  
  // Read and validate pixels
  const gl = renderer.getContext();
  const pixels = readAndValidatePixels(gl, width, height);
  
  // Flip pixels vertically
  const flippedPixels = flipPixelsVertically(pixels, width, height);
  
  console.log(`[Renderer] Tile complete`);
  
  return {
    pixels: flippedPixels,
    startX,
    startY,
    width,
    height
  };
}
