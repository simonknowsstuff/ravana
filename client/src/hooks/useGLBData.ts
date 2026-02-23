import { useState, useCallback } from 'react'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import * as THREE from 'three'
import { BakedData, BakeOptions, bakeMeshWithBVH, buildFlatBVH } from './useBVH'

export interface TextureData {
  pixels: Uint8Array
  width: number
  height: number
}

export interface MeshData {
  name: string
  positions: Float32Array
  normals: Float32Array | null
  uvs: Float32Array | null
  indices: Uint32Array | null
  bakedData?: BakedData
  bvhData?: Float32Array
}

export interface MergedSceneData {
  positions: Float32Array
  indices: Uint32Array
  bvhData: Float32Array
  colors: Float32Array
  normals: Float32Array
  emissive: Float32Array
  ambientOcclusion: Float32Array
  uvs: Float32Array
  textureIndices: Float32Array 
  roughness: Float32Array
  metallic: Float32Array
  ormTextureIndices: Float32Array
  emissiveTextureIndices: Float32Array // NEW
  textures: TextureData[]
}

export interface SceneLight {
  type: 'point' | 'directional' | 'spot'
  position: { x: number; y: number; z: number }
  direction: { x: number; y: number; z: number }
  color: { r: number; g: number; b: number }
  intensity: number
  distance: number
  decay: number
  angle: number
  penumbra: number
}

export interface GLBData {
  meshes: MeshData[]
  merged: MergedSceneData
  lights: SceneLight[]
}

export interface UseGLBDataOptions {
  shouldBake?: boolean
  bakeOptions?: BakeOptions
}

export interface UseGLBDataReturn {
  glbData: GLBData | null
  isLoading: boolean
  error: Error | null
  extractGLBData: (file: File) => Promise<GLBData>
  reset: () => void
}

const defaultBakeOptions: BakeOptions = {
  samples: 64,
  maxDistance: 2.0,
  intensity: 1.0
}

function extractTextureData(texture: THREE.Texture): TextureData | null {
  if (!texture || !texture.image) return null;
  const image = texture.image;
  const width = image.width;
  const height = image.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  try {
    if (texture.flipY) {
      ctx.translate(0, height);
      ctx.scale(1, -1);
    }
    ctx.drawImage(image, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    return { pixels: new Uint8Array(imageData.data.buffer), width, height };
  } catch (err) {
    console.warn("Failed to extract texture pixels:", err);
    return null;
  }
}

export async function extractGLBData(
  file: File, 
  shouldBake: boolean = false,
  bakeOptions: BakeOptions = defaultBakeOptions
): Promise<GLBData> {
  const loader = new GLTFLoader()
  const dracoLoader = new DRACOLoader()
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')
  loader.setDRACOLoader(dracoLoader)
  
  const url = URL.createObjectURL(file)
  
  try {
    const gltf = await loader.loadAsync(url)
    const meshes: MeshData[] = []
    
    // Per-mesh tracking arrays
    const meshColors: THREE.Color[] = []
    const meshEmissiveColors: THREE.Color[] = []
    const meshVertexColors: (Float32Array | null)[] = []
    const meshWorldNormals: (Float32Array | null)[] = []
    const meshUVs: (Float32Array | null)[] = []
    
    const meshRoughness: number[] = []
    const meshMetallic: number[] = []
    
    const meshTextureIndices: number[] = []
    const meshOrmIndices: number[] = []
    const meshEmissiveIndices: number[] = [] // NEW
    
    const globalTextures: TextureData[] = []
    const textureCache = new Map<THREE.Texture, number>()

    gltf.scene.updateMatrixWorld(true)

    if (shouldBake) {
      gltf.scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          ;(child.geometry as THREE.BufferGeometry).computeBoundsTree()
        }
      })
    }
    
    gltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const geometry = child.geometry as THREE.BufferGeometry
        
        let bakedData: BakedData | undefined
        if (shouldBake) bakedData = bakeMeshWithBVH(geometry, gltf.scene, bakeOptions)
        
        const positions = new Float32Array(geometry.attributes.position.array)
        const v = new THREE.Vector3()
        for (let i = 0; i < positions.length; i += 3) {
          v.set(positions[i], positions[i + 1], positions[i + 2])
          v.applyMatrix4(child.matrixWorld)
          positions[i] = v.x; positions[i + 1] = v.y; positions[i + 2] = v.z;
        }

        const normalMatrix = new THREE.Matrix3().getNormalMatrix(child.matrixWorld)
        let worldNormals: Float32Array | null = null
        if (geometry.attributes.normal) {
          worldNormals = new Float32Array(geometry.attributes.normal.array)
          const nv = new THREE.Vector3()
          for (let i = 0; i < worldNormals.length; i += 3) {
            nv.set(worldNormals[i], worldNormals[i + 1], worldNormals[i + 2])
            nv.applyMatrix3(normalMatrix).normalize()
            worldNormals[i] = nv.x; worldNormals[i + 1] = nv.y; worldNormals[i + 2] = nv.z;
          }
        }
        
        const mat = (Array.isArray(child.material) ? child.material[0] : child.material) as any
        
        // Base Colors
        const linearBase = mat?.color ? mat.color.clone() : new THREE.Color(1, 1, 1)
        const linearEmissive = mat?.emissive ? mat.emissive.clone() : new THREE.Color(0, 0, 0)
        linearEmissive.multiplyScalar(mat?.emissiveIntensity ?? 1.0)
        meshColors.push(new THREE.Color().copyLinearToSRGB(linearBase))
        meshEmissiveColors.push(new THREE.Color().copyLinearToSRGB(linearEmissive))

        // PBR Base Properties
        meshRoughness.push(mat?.roughness !== undefined ? mat.roughness : 0.5)
        meshMetallic.push(mat?.metalness !== undefined ? mat.metalness : 0.0)

        // Vertex Colors
        const geoColors = geometry.attributes.color
        if (geoColors) {
          const raw = geoColors.array as Float32Array
          const stride = geoColors.itemSize
          const vertCount = positions.length / 3
          const vcolors = new Float32Array(vertCount * 3)
          for (let vi = 0; vi < vertCount; vi++) {
            vcolors[vi * 3] = raw[vi * stride]; vcolors[vi * 3 + 1] = raw[vi * stride + 1]; vcolors[vi * 3 + 2] = raw[vi * stride + 2];
          }
          meshVertexColors.push(vcolors)
        } else {
          meshVertexColors.push(null)
        }
        meshWorldNormals.push(worldNormals)
        meshUVs.push(geometry.attributes.uv ? new Float32Array(geometry.attributes.uv.array) : null)

        // ── Texture Extraction Helper ──
        const extractTex = (texObj: any) => {
          if (!texObj) return -1;
          if (textureCache.has(texObj)) return textureCache.get(texObj)!;
          const texData = extractTextureData(texObj);
          if (texData) {
            const idx = globalTextures.length;
            globalTextures.push(texData);
            textureCache.set(texObj, idx);
            return idx;
          }
          return -1;
        }

        // Extract All Maps
        meshTextureIndices.push(extractTex(mat?.map))
        meshOrmIndices.push(extractTex(mat?.metalnessMap || mat?.roughnessMap))
        meshEmissiveIndices.push(extractTex(mat?.emissiveMap)) // NEW

        let rawIndices: Uint32Array
        if (geometry.index) {
          rawIndices = new Uint32Array(geometry.index.array)
        } else {
          const vertCount = positions.length / 3
          rawIndices = new Uint32Array(vertCount)
          for (let j = 0; j < vertCount; j++) rawIndices[j] = j
        }
        
        const { bvhBuffer, indices: bvhIndices } = buildFlatBVH(positions, rawIndices)
        
        meshes.push({
          name: child.name || `mesh_${meshes.length}`,
          positions, normals: worldNormals, uvs: meshUVs[meshUVs.length - 1],
          indices: bvhIndices, bakedData, bvhData: bvhBuffer,
        })
        
        if (geometry.boundsTree) geometry.disposeBoundsTree()
      }
    })
    
    // Extract lights (Same as before)
    const lights: SceneLight[] = []
    gltf.scene.traverse((child) => {
      if (child instanceof THREE.PointLight) {
        const wp = new THREE.Vector3(); child.getWorldPosition(wp); const c = new THREE.Color().copyLinearToSRGB(child.color);
        lights.push({ type: 'point', position: { x: wp.x, y: wp.y, z: wp.z }, direction: { x: 0, y: -1, z: 0 }, color: { r: c.r, g: c.g, b: c.b }, intensity: child.intensity, distance: child.distance, decay: child.decay, angle: 0, penumbra: 0 })
      } else if (child instanceof THREE.DirectionalLight) {
        const wp = new THREE.Vector3(); child.getWorldPosition(wp); const td = new THREE.Vector3();
        if (child.target) { child.target.getWorldPosition(td); td.sub(wp).normalize(); } else { td.set(0, -1, 0); }
        const c = new THREE.Color().copyLinearToSRGB(child.color);
        lights.push({ type: 'directional', position: { x: wp.x, y: wp.y, z: wp.z }, direction: { x: td.x, y: td.y, z: td.z }, color: { r: c.r, g: c.g, b: c.b }, intensity: child.intensity, distance: 0, decay: 0, angle: 0, penumbra: 0 })
      } else if (child instanceof THREE.SpotLight) {
        const wp = new THREE.Vector3(); child.getWorldPosition(wp); const td = new THREE.Vector3();
        if (child.target) { child.target.getWorldPosition(td); td.sub(wp).normalize(); } else { td.set(0, -1, 0); }
        const c = new THREE.Color().copyLinearToSRGB(child.color);
        lights.push({ type: 'spot', position: { x: wp.x, y: wp.y, z: wp.z }, direction: { x: td.x, y: td.y, z: td.z }, color: { r: c.r, g: c.g, b: c.b }, intensity: child.intensity, distance: child.distance, decay: child.decay, angle: child.angle, penumbra: child.penumbra })
      }
    })
    
    if (lights.length === 0) {
      lights.push(
        { type: 'point', position: { x: 3, y: 5, z: 3 }, direction: { x: 0, y: -1, z: 0 }, color: { r: 1, g: 0.95, b: 0.9 }, intensity: 40, distance: 0, decay: 2, angle: 0, penumbra: 0 },
        { type: 'point', position: { x: -3, y: 4, z: -2 }, direction: { x: 0, y: -1, z: 0 }, color: { r: 0.7, g: 0.8, b: 1.0 }, intensity: 25, distance: 0, decay: 2, angle: 0, penumbra: 0 },
        { type: 'directional', position: { x: 0, y: 10, z: 0 }, direction: { x: 0.3, y: -1, z: 0.4 }, color: { r: 1, g: 1, b: 1 }, intensity: 1.0, distance: 0, decay: 0, angle: 0, penumbra: 0 },
      )
    }
    
    // ── Build merged scene geometry ──
    let totalPositionFloats = 0
    let totalIndexUints = 0
    for (const m of meshes) {
      totalPositionFloats += m.positions.length
      totalIndexUints += m.indices?.length ?? 0
    }
    
    const mergedPositions = new Float32Array(totalPositionFloats)
    const mergedIndices = new Uint32Array(totalIndexUints)
    const mergedColors = new Float32Array(totalPositionFloats) 
    const mergedNormals = new Float32Array(totalPositionFloats)
    const mergedEmissive = new Float32Array(totalPositionFloats)
    const mergedAO = new Float32Array(totalPositionFloats / 3) 
    const mergedUVs = new Float32Array((totalPositionFloats / 3) * 2) 
    
    // IMPORTANT: THESE MUST FILL WITH -1 SO NO TEXTURE IS INDEX 0!
    const mergedTextureIndices = new Float32Array(totalPositionFloats / 3).fill(-1)
    const mergedRoughness = new Float32Array(totalPositionFloats / 3)
    const mergedMetallic = new Float32Array(totalPositionFloats / 3)
    const mergedOrmTextureIndices = new Float32Array(totalPositionFloats / 3).fill(-1)
    const mergedEmissiveTextureIndices = new Float32Array(totalPositionFloats / 3).fill(-1)

    let posOff = 0, idxOff = 0, vertBase = 0, aoOff = 0, uvOff = 0
    
    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi]
      const matColor = meshColors[mi]; const emissiveColor = meshEmissiveColors[mi];
      const vcolors = meshVertexColors[mi]; const wnormals = meshWorldNormals[mi];
      const bakedAO = m.bakedData?.ambientOcclusion || null; const uvs = meshUVs[mi];
      
      const texIndex = meshTextureIndices[mi]
      const baseRough = meshRoughness[mi]
      const baseMetal = meshMetallic[mi]
      const ormTexIdx = meshOrmIndices[mi]
      const emiTexIdx = meshEmissiveIndices[mi]

      mergedPositions.set(m.positions, posOff)
      
      const vertCount = m.positions.length / 3
      for (let vi = 0; vi < vertCount; vi++) {
        if (vcolors) {
          mergedColors[posOff + vi * 3]     = vcolors[vi * 3]
          mergedColors[posOff + vi * 3 + 1] = vcolors[vi * 3 + 1]
          mergedColors[posOff + vi * 3 + 2] = vcolors[vi * 3 + 2]
        } else {
          mergedColors[posOff + vi * 3]     = matColor.r
          mergedColors[posOff + vi * 3 + 1] = matColor.g
          mergedColors[posOff + vi * 3 + 2] = matColor.b
        }
        if (wnormals) {
          mergedNormals[posOff + vi * 3]     = wnormals[vi * 3]
          mergedNormals[posOff + vi * 3 + 1] = wnormals[vi * 3 + 1]
          mergedNormals[posOff + vi * 3 + 2] = wnormals[vi * 3 + 2]
        }
        mergedEmissive[posOff + vi * 3]     = emissiveColor.r
        mergedEmissive[posOff + vi * 3 + 1] = emissiveColor.g
        mergedEmissive[posOff + vi * 3 + 2] = emissiveColor.b
        mergedAO[aoOff + vi] = bakedAO ? bakedAO[vi] : 1.0

        if (uvs) {
          mergedUVs[uvOff + vi * 2]     = uvs[vi * 2]
          mergedUVs[uvOff + vi * 2 + 1] = uvs[vi * 2 + 1]
        }
        
        mergedTextureIndices[aoOff + vi] = texIndex
        mergedRoughness[aoOff + vi] = baseRough
        mergedMetallic[aoOff + vi] = baseMetal
        mergedOrmTextureIndices[aoOff + vi] = ormTexIdx
        mergedEmissiveTextureIndices[aoOff + vi] = emiTexIdx
      }
      if (m.indices) {
        for (let i = 0; i < m.indices.length; i++) mergedIndices[idxOff + i] = m.indices[i] + vertBase;
        idxOff += m.indices.length
      }
      posOff += m.positions.length; aoOff += vertCount; uvOff += vertCount * 2; vertBase += vertCount;
    }
    
    const { bvhBuffer, indices: bvhIndices } = buildFlatBVH(mergedPositions, mergedIndices)
    
    const merged: MergedSceneData = {
      positions: mergedPositions, indices: bvhIndices, bvhData: bvhBuffer,
      colors: mergedColors, normals: mergedNormals, emissive: mergedEmissive, ambientOcclusion: mergedAO,
      uvs: mergedUVs, textureIndices: mergedTextureIndices, roughness: mergedRoughness, metallic: mergedMetallic,
      ormTextureIndices: mergedOrmTextureIndices, emissiveTextureIndices: mergedEmissiveTextureIndices, textures: globalTextures
    }
    return { meshes, merged, lights }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function useGLBData(options: UseGLBDataOptions = {}): UseGLBDataReturn {
  const { shouldBake = false, bakeOptions = defaultBakeOptions } = options
  const [glbData, setGlbData] = useState<GLBData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const extract = useCallback(async (file: File): Promise<GLBData> => {
    setIsLoading(true); setError(null);
    try {
      const data = await extractGLBData(file, shouldBake, bakeOptions)
      setGlbData(data)
      return data
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to extract GLB data')
      setError(error); throw error;
    } finally {
      setIsLoading(false)
    }
  }, [shouldBake, bakeOptions])

  const reset = useCallback(() => { setGlbData(null); setError(null); }, [])
  return { glbData, isLoading, error, extractGLBData: extract, reset }
}