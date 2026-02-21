import { useState, useCallback } from 'react'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as THREE from 'three'
import { BakedData, BakeOptions, bakeMeshWithBVH, serializeBVH } from './useBVH'

export interface MeshData {
  name: string
  positions: Float32Array
  normals: Float32Array | null
  uvs: Float32Array | null
  indices: Uint16Array | Uint32Array | null
  bakedData?: BakedData
  bvhData?: Uint8Array // Serialized BVH tree for raytracing
}

export interface GLBData {
  meshes: MeshData[]
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
          bakedData = bakeMeshWithBVH(geometry, gltf.scene, bakeOptions)
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
