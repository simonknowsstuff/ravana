import * as THREE from 'three'
import { MeshBVH, computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'

// Add BVH methods to Three.js prototypes
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

export interface BakeOptions {
  samples: number
  maxDistance: number
  intensity: number
}

export interface BakedData {
  ambientOcclusion: Float32Array
  vertexColors: Float32Array
  bvhNodeCount: number
  raycastSamples: number
}

/**
 * Serialize MeshBVH to a compact Uint8Array for transmission
 */
export function serializeBVH(bvh: MeshBVH): Uint8Array {
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

/**
 * Bake ambient occlusion and vertex colors using BVH-accelerated raycasting
 */
export function bakeMeshWithBVH(
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
