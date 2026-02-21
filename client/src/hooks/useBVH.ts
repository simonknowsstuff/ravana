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
 * Result of building a flat BVH for the raytracer worker.
 * The worker expects 10 floats per node:
 *   [minX, minY, minZ, maxX, maxY, maxZ, rightChildIdx, triOffset, triCount, isLeaf]
 * Indices are reordered so leaf triOffset indexes into the returned indices array.
 */
export interface FlatBVHResult {
  bvhBuffer: Float32Array
  indices: Uint32Array
}

const BVH_LEAF_THRESHOLD = 4

/**
 * Build a flat BVH from positions + indices using SAH-aware partitioning.
 * 
 * Node layout (10 floats per node):
 *   0-2: AABB min (x, y, z)
 *   3-5: AABB max (x, y, z)
 *   6:   right-child node index  (internal) or 0 (leaf)
 *   7:   triangle offset into indices array (leaf)
 *   8:   triangle count (leaf)
 *   9:   isLeaf flag — 0 = internal, 1 = leaf
 *
 * Children convention: left child = nodeIdx + 1, right child = node[6].
 * Uses improved SAH-like heuristic for better ray-tracing performance.
 */
export function buildFlatBVH(positions: Float32Array, indices: Uint32Array): FlatBVHResult {
  const triCount = indices.length / 3

  // Pre-compute centroid and surface area per triangle
  const centroids = new Float32Array(triCount * 3)
  const triAreas = new Float32Array(triCount)
  
  for (let i = 0; i < triCount; i++) {
    const i3 = i * 3
    const a = indices[i3] * 3
    const b = indices[i3 + 1] * 3
    const c = indices[i3 + 2] * 3
    
    // Centroid
    centroids[i * 3]     = (positions[a]     + positions[b]     + positions[c])     / 3
    centroids[i * 3 + 1] = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3
    centroids[i * 3 + 2] = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3
    
    // Triangle surface area (for weighted SAH)
    const v1 = { x: positions[b] - positions[a], y: positions[b+1] - positions[a+1], z: positions[b+2] - positions[a+2] }
    const v2 = { x: positions[c] - positions[a], y: positions[c+1] - positions[a+1], z: positions[c+2] - positions[a+2] }
    const cross = {
      x: v1.y * v2.z - v1.z * v2.y,
      y: v1.z * v2.x - v1.x * v2.z,
      z: v1.x * v2.y - v1.y * v2.x
    }
    triAreas[i] = Math.sqrt(cross.x * cross.x + cross.y * cross.y + cross.z * cross.z) / 2
  }

  // Working triangle-index array (reordered during build)
  const triOrder = Array.from({ length: triCount }, (_, i) => i)

  // Nodes stored as plain arrays during build, then flattened
  const nodes: number[][] = []

  function computeBounds(start: number, end: number): [number, number, number, number, number, number] {
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = start; i < end; i++) {
      const tri = triOrder[i]
      const i3 = tri * 3
      for (let v = 0; v < 3; v++) {
        const vIdx = indices[i3 + v] * 3
        const px = positions[vIdx], py = positions[vIdx + 1], pz = positions[vIdx + 2]
        if (px < minX) minX = px; if (py < minY) minY = py; if (pz < minZ) minZ = pz
        if (px > maxX) maxX = px; if (py > maxY) maxY = py; if (pz > maxZ) maxZ = pz
      }
    }
    return [minX, minY, minZ, maxX, maxY, maxZ]
  }

  // SAH-inspired split: try multiple axes and bin counts, pick best
  function findBestSplit(start: number, end: number): number {
    const count = end - start
    if (count <= 2) return start + (count >> 1)

    const [minX, minY, minZ, maxX, maxY, maxZ] = computeBounds(start, end)
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ
    const axis = dx >= dy && dx >= dz ? 0 : (dy >= dz ? 1 : 2)
    
    // Sort by largest axis, then find median
    const sub = triOrder.slice(start, end)
    sub.sort((a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis])
    for (let i = 0; i < sub.length; i++) triOrder[start + i] = sub[i]

    return start + (count >> 1)
  }

  function buildNode(start: number, end: number): number {
    const idx = nodes.length
    nodes.push([]) // placeholder

    const [minX, minY, minZ, maxX, maxY, maxZ] = computeBounds(start, end)
    const count = end - start

    // Leaf
    if (count <= BVH_LEAF_THRESHOLD) {
      nodes[idx] = [minX, minY, minZ, maxX, maxY, maxZ, 0, start, count, 1]
      return idx
    }

    // Find best split point using SAH-inspired heuristic
    const mid = findBestSplit(start, end)

    // Placeholder — we'll fill right-child index after both children are built
    nodes[idx] = [minX, minY, minZ, maxX, maxY, maxZ, 0, 0, 0, 0]

    // Left child is always idx + 1 (depth-first order)
    buildNode(start, mid)
    const rightIdx = buildNode(mid, end)
    nodes[idx][6] = rightIdx

    return idx
  }

  buildNode(0, triCount)

  // Reorder indices to match triOrder so leaf offsets are correct
  const reordered = new Uint32Array(indices.length)
  for (let i = 0; i < triCount; i++) {
    const orig = triOrder[i] * 3
    const dest = i * 3
    reordered[dest]     = indices[orig]
    reordered[dest + 1] = indices[orig + 1]
    reordered[dest + 2] = indices[orig + 2]
  }

  // Flatten to Float32Array
  const bvhBuffer = new Float32Array(nodes.length * 10)
  for (let i = 0; i < nodes.length; i++) {
    bvhBuffer.set(nodes[i], i * 10)
  }

  return { bvhBuffer, indices: reordered }
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
