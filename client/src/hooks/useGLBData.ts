import { useState, useCallback } from 'react'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import * as THREE from 'three'
import { BakedData, BakeOptions, bakeMeshWithBVH, buildFlatBVH } from './useBVH'

export interface MeshData {
  name: string
  positions: Float32Array
  normals: Float32Array | null
  uvs: Float32Array | null
  indices: Uint32Array | null
  bakedData?: BakedData
  bvhData?: Float32Array // Serialized BVH tree for raytracing
}

/** Scene-wide merged geometry for the raytracer (single BVH over all meshes) */
export interface MergedSceneData {
  positions: Float32Array
  indices: Uint32Array
  bvhData: Float32Array
  /** Per-vertex base-albedo RGB [r,g,b, ...] in 0-1 sRGB */
  colors: Float32Array
  /** Per-vertex smooth normals [nx,ny,nz, ...] in world space */
  normals: Float32Array
  /** Per-vertex emissive RGB [r,g,b, ...] in 0-1 sRGB (self-illumination, ignores lighting) */
  emissive: Float32Array
  /** Per-vertex ambient occlusion [ao, ...] in 0-1 (modulates ambient lighting) */
  ambientOcclusion: Float32Array
}

/** A light extracted from the GLB scene */
export interface SceneLight {
  type: 'point' | 'directional' | 'spot'
  position: { x: number; y: number; z: number }   // world space
  direction: { x: number; y: number; z: number }   // for directional/spot
  color: { r: number; g: number; b: number }        // sRGB 0-1
  intensity: number                                  // candela / lux depending on type
  distance: number                                   // 0 = infinite (directional)
  decay: number                                      // attenuation exponent
  angle: number                                      // spot cone angle (radians), 0 for others
  penumbra: number                                   // spot penumbra 0-1
}

export interface GLBData {
  meshes: MeshData[]
  /** Merged scene geometry with a single BVH for raytrace workers */
  merged: MergedSceneData
  /** Lights extracted from the GLB scene graph */
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

/**
 * Extract mesh data from a GLB/GLTF file
 */
export async function extractGLBData(
  file: File, 
  shouldBake: boolean = false,
  bakeOptions: BakeOptions = defaultBakeOptions
): Promise<GLBData> {
  const loader = new GLTFLoader()
  
  // Set up DRACO loader for compressed geometries
  const dracoLoader = new DRACOLoader()
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')
  loader.setDRACOLoader(dracoLoader)
  
  const url = URL.createObjectURL(file)
  
  try {
    const gltf = await loader.loadAsync(url)
    const meshes: MeshData[] = []
    // Per-mesh material color (RGB 0-1) — needed for merged vertex colors
    const meshColors: THREE.Color[] = []
    // Per-mesh emissive colour (sRGB 0-1)
    const meshEmissiveColors: THREE.Color[] = []
    // Per-mesh: does this mesh have per-vertex colors in the geometry?
    const meshVertexColors: (Float32Array | null)[] = []
    // Per-mesh world-space normals (null if geometry had none → flat normals generated during merge)
    const meshWorldNormals: (Float32Array | null)[] = []
    
    // Ensure world matrices are computed so we get correct world-space positions
    gltf.scene.updateMatrixWorld(true)

    // Diagnostic: count original model polygons before any processing
    let originalTriCount = 0
    let originalMeshCount = 0
    gltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const geo = child.geometry as THREE.BufferGeometry
        const posCount = geo.attributes.position?.count ?? 0
        const idxCount = geo.index ? geo.index.count : posCount
        originalTriCount += Math.floor(idxCount / 3)
        originalMeshCount++
      }
    })
    console.log(`[GLB] Original model: ${originalMeshCount} meshes, ${originalTriCount} triangles`)
    
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
          bakedData = bakeMeshWithBVH(geometry, gltf.scene, bakeOptions)
        }
        
        // Apply world transform so positions are in world space
        const positions = new Float32Array(geometry.attributes.position.array)
        const v = new THREE.Vector3()
        for (let i = 0; i < positions.length; i += 3) {
          v.set(positions[i], positions[i + 1], positions[i + 2])
          v.applyMatrix4(child.matrixWorld)
          positions[i] = v.x
          positions[i + 1] = v.y
          positions[i + 2] = v.z
        }

        // Transform normals by the normal matrix (inverse transpose of upper 3×3)
        // If no normals exist, compute flat face normals later during merge
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(child.matrixWorld)
        let worldNormals: Float32Array | null = null
        if (geometry.attributes.normal) {
          worldNormals = new Float32Array(geometry.attributes.normal.array)
          const nv = new THREE.Vector3()
          for (let i = 0; i < worldNormals.length; i += 3) {
            nv.set(worldNormals[i], worldNormals[i + 1], worldNormals[i + 2])
            nv.applyMatrix3(normalMatrix).normalize()
            worldNormals[i] = nv.x
            worldNormals[i + 1] = nv.y
            worldNormals[i + 2] = nv.z
          }
        }
        
        // ── Collect ALL material colour sources ──────────────────
        // Priority: geometry vertex colors > material properties
        // For material: finalColor = baseColor + emissive * emissiveIntensity
        const mat = (Array.isArray(child.material) ? child.material[0] : child.material) as any

        // 1. Base / diffuse color (linear)
        const linearBase = mat?.color ? mat.color.clone() : new THREE.Color(1, 1, 1)

        // 2. Emissive colour (linear) + intensity — kept separate for self-illumination
        const linearEmissive = mat?.emissive ? mat.emissive.clone() : new THREE.Color(0, 0, 0)
        const emissiveIntensity: number = mat?.emissiveIntensity ?? 1.0
        linearEmissive.multiplyScalar(emissiveIntensity)

        // Convert base and emissive from linear → sRGB separately
        const srgbColor = new THREE.Color().copyLinearToSRGB(linearBase)
        meshColors.push(srgbColor)
        const srgbEmissive = new THREE.Color().copyLinearToSRGB(linearEmissive)
        meshEmissiveColors.push(srgbEmissive)

        // 3. Per-vertex colors baked into geometry (already sRGB in most GLBs)
        const geoColors = geometry.attributes.color
        if (geoColors) {
          // color attribute can be RGB (itemSize 3) or RGBA (itemSize 4)
          const raw = geoColors.array as Float32Array
          const stride = geoColors.itemSize  // 3 or 4
          const vertCount = positions.length / 3
          const vcolors = new Float32Array(vertCount * 3)
          for (let vi = 0; vi < vertCount; vi++) {
            vcolors[vi * 3]     = raw[vi * stride]
            vcolors[vi * 3 + 1] = raw[vi * stride + 1]
            vcolors[vi * 3 + 2] = raw[vi * stride + 2]
          }
          meshVertexColors.push(vcolors)
        } else {
          meshVertexColors.push(null)
        }
        meshWorldNormals.push(worldNormals)

        const hasTexture = !!(mat?.map)
        console.log(`[GLB] mesh "${child.name}" | base(${linearBase.r.toFixed(3)},${linearBase.g.toFixed(3)},${linearBase.b.toFixed(3)}) emissive(${linearEmissive.r.toFixed(3)},${linearEmissive.g.toFixed(3)},${linearEmissive.b.toFixed(3)}) → sRGB(${srgbColor.r.toFixed(3)},${srgbColor.g.toFixed(3)},${srgbColor.b.toFixed(3)}) | vertexColors=${!!geoColors} texture=${hasTexture}`)
        
        // Build indices — generate them from vertex count if the geometry has none
        let rawIndices: Uint32Array
        if (geometry.index) {
          rawIndices = new Uint32Array(geometry.index.array)
        } else {
          // Non-indexed geometry: create sequential indices
          const vertCount = positions.length / 3
          rawIndices = new Uint32Array(vertCount)
          for (let j = 0; j < vertCount; j++) rawIndices[j] = j
        }
        
        // Build flat BVH in the format the raytracer worker expects.
        // This also reorders indices to match the BVH leaf ordering.
        const { bvhBuffer, indices: bvhIndices } = buildFlatBVH(positions, rawIndices)
        
        const meshData: MeshData = {
          name: child.name || `mesh_${meshes.length}`,
          positions,
          normals: worldNormals,
          uvs: geometry.attributes.uv 
            ? new Float32Array(geometry.attributes.uv.array) 
            : null,
          indices: bvhIndices,
          bakedData,
          bvhData: bvhBuffer,
        }
        meshes.push(meshData)
        
        // Clean up BVH
        if (geometry.boundsTree) {
          geometry.disposeBoundsTree()
        }
      }
    })
    
    // ── Extract lights from scene graph ─────────────────────
    const lights: SceneLight[] = []
    gltf.scene.traverse((child) => {
      if (child instanceof THREE.PointLight) {
        const wp = new THREE.Vector3()
        child.getWorldPosition(wp)
        const c = new THREE.Color().copyLinearToSRGB(child.color)
        lights.push({
          type: 'point',
          position: { x: wp.x, y: wp.y, z: wp.z },
          direction: { x: 0, y: -1, z: 0 },
          color: { r: c.r, g: c.g, b: c.b },
          intensity: child.intensity,
          distance: child.distance,
          decay: child.decay,
          angle: 0,
          penumbra: 0,
        })
      } else if (child instanceof THREE.DirectionalLight) {
        const wp = new THREE.Vector3()
        child.getWorldPosition(wp)
        const td = new THREE.Vector3()
        if (child.target) {
          child.target.getWorldPosition(td)
          td.sub(wp).normalize()
        } else {
          td.set(0, -1, 0)
        }
        const c = new THREE.Color().copyLinearToSRGB(child.color)
        lights.push({
          type: 'directional',
          position: { x: wp.x, y: wp.y, z: wp.z },
          direction: { x: td.x, y: td.y, z: td.z },
          color: { r: c.r, g: c.g, b: c.b },
          intensity: child.intensity,
          distance: 0,
          decay: 0,
          angle: 0,
          penumbra: 0,
        })
      } else if (child instanceof THREE.SpotLight) {
        const wp = new THREE.Vector3()
        child.getWorldPosition(wp)
        const td = new THREE.Vector3()
        if (child.target) {
          child.target.getWorldPosition(td)
          td.sub(wp).normalize()
        } else {
          td.set(0, -1, 0)
        }
        const c = new THREE.Color().copyLinearToSRGB(child.color)
        lights.push({
          type: 'spot',
          position: { x: wp.x, y: wp.y, z: wp.z },
          direction: { x: td.x, y: td.y, z: td.z },
          color: { r: c.r, g: c.g, b: c.b },
          intensity: child.intensity,
          distance: child.distance,
          decay: child.decay,
          angle: child.angle,
          penumbra: child.penumbra,
        })
      }
    })
    
    // No default lights — scenes are dark by default
    console.log(`[GLB] extracted ${lights.length} lights:`, lights.map(l => `${l.type}(${l.intensity})`).join(', '))
    
    // Build merged scene geometry: combine all positions + indices, build one BVH
    let totalPositionFloats = 0
    let totalIndexUints = 0
    for (const m of meshes) {
      totalPositionFloats += m.positions.length
      totalIndexUints += m.indices?.length ?? 0
    }
    
    const mergedPositions = new Float32Array(totalPositionFloats)
    const mergedIndices = new Uint32Array(totalIndexUints)
    // Per-vertex RGB colors (3 floats per vertex)
    const mergedColors = new Float32Array(totalPositionFloats) // same count as positions (3 per vert)
    // Per-vertex smooth normals (3 floats per vertex)
    const mergedNormals = new Float32Array(totalPositionFloats)
    // Per-vertex emissive RGB (3 floats per vertex)
    const mergedEmissive = new Float32Array(totalPositionFloats)
    // Per-vertex ambient occlusion (1 float per vertex)
    const mergedAO = new Float32Array(totalPositionFloats / 3) // one AO value per vertex
    let posOff = 0, idxOff = 0, vertBase = 0, aoOff = 0
    
    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi]
      const matColor = meshColors[mi] || new THREE.Color(0.8, 0.8, 0.8)
      const emissiveColor = meshEmissiveColors[mi] || new THREE.Color(0, 0, 0)
      const vcolors = meshVertexColors[mi] // per-vertex colors (sRGB) or null
      const wnormals = meshWorldNormals[mi] // world-space normals or null
      const bakedAO = m.bakedData?.ambientOcclusion || null
      mergedPositions.set(m.positions, posOff)
      // Fill per-vertex colors: prefer geometry vertex colors, fall back to material
      const vertCount = m.positions.length / 3
      for (let vi = 0; vi < vertCount; vi++) {
        if (vcolors) {
          // Geometry has per-vertex colours — use them directly
          mergedColors[posOff + vi * 3]     = vcolors[vi * 3]
          mergedColors[posOff + vi * 3 + 1] = vcolors[vi * 3 + 1]
          mergedColors[posOff + vi * 3 + 2] = vcolors[vi * 3 + 2]
        } else {
          // Flat material colour for every vertex of this mesh
          mergedColors[posOff + vi * 3]     = matColor.r
          mergedColors[posOff + vi * 3 + 1] = matColor.g
          mergedColors[posOff + vi * 3 + 2] = matColor.b
        }
        // Copy world-space normals (or zeros — raytracer will fall back to flat normal)
        if (wnormals) {
          mergedNormals[posOff + vi * 3]     = wnormals[vi * 3]
          mergedNormals[posOff + vi * 3 + 1] = wnormals[vi * 3 + 1]
          mergedNormals[posOff + vi * 3 + 2] = wnormals[vi * 3 + 2]
        }
        // Emissive (flat per-mesh material emissive)
        mergedEmissive[posOff + vi * 3]     = emissiveColor.r
        mergedEmissive[posOff + vi * 3 + 1] = emissiveColor.g
        mergedEmissive[posOff + vi * 3 + 2] = emissiveColor.b
        // Ambient Occlusion (per-vertex from baked data or 1.0 default)
        mergedAO[aoOff + vi] = bakedAO ? bakedAO[vi] : 1.0
      }
      if (m.indices) {
        for (let i = 0; i < m.indices.length; i++) {
          mergedIndices[idxOff + i] = m.indices[i] + vertBase
        }
        idxOff += m.indices.length
      }
      posOff += m.positions.length
      aoOff += vertCount
      vertBase += vertCount
    }
    
    const { bvhBuffer, indices: bvhIndices } = buildFlatBVH(mergedPositions, mergedIndices)
    
    const merged: MergedSceneData = {
      positions: mergedPositions,
      indices: bvhIndices,
      bvhData: bvhBuffer,
      colors: mergedColors,
      normals: mergedNormals,
      emissive: mergedEmissive,
      ambientOcclusion: mergedAO,
    }
    
    const extractedTriCount = totalIndexUints / 3
    const retention = originalTriCount > 0 ? ((extractedTriCount / originalTriCount) * 100).toFixed(1) : '100'
    console.log(`[GLB] merged scene: ${vertBase} verts, ${extractedTriCount} tris, ${bvhBuffer.length / 10} BVH nodes — ${retention}% of original ${originalTriCount} tris`)
    
    return { meshes, merged, lights }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * React hook for extracting GLB data with state management
 */
export function useGLBData(options: UseGLBDataOptions = {}): UseGLBDataReturn {
  const { shouldBake = false, bakeOptions = defaultBakeOptions } = options
  
  const [glbData, setGlbData] = useState<GLBData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const extract = useCallback(async (file: File): Promise<GLBData> => {
    setIsLoading(true)
    setError(null)
    
    try {
      const data = await extractGLBData(file, shouldBake, bakeOptions)
      setGlbData(data)
      return data
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to extract GLB data')
      setError(error)
      throw error
    } finally {
      setIsLoading(false)
    }
  }, [shouldBake, bakeOptions])

  const reset = useCallback(() => {
    setGlbData(null)
    setError(null)
  }, [])

  return {
    glbData,
    isLoading,
    error,
    extractGLBData: extract,
    reset
  }
}
