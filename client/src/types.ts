// Payload structure for websocket transmission
export interface ScenePayload {
  timestamp: number
  version: string
  camera: {
    // Legacy position/rotation for debugging
    position: { x: number; y: number; z: number }
    target: { x: number; y: number; z: number }
    // Camera parameters
    fov: number
    near: number
    far: number
    // Matrices for ray tracing (column-major, 16 floats each)
    viewMatrix: number[]        // World to view space
    projectionMatrix: number[]  // View to clip space  
    cameraMatrix: number[]      // Camera to world (for ray origin/direction)
  } | null
  geometry: {
    meshCount: number
    totalVertices: number
    totalIndices: number
    meshes: Array<{
      name: string
      vertexCount: number
      indexCount: number
      hasNormals: boolean
      hasUvs: boolean
      hasBakedData: boolean
      hasBvhData: boolean
      // Byte offsets in the binary buffer
      positionsOffset: number
      positionsLength: number
      normalsOffset: number
      normalsLength: number
      uvsOffset: number
      uvsLength: number
      indicesOffset: number
      indicesLength: number
      aoOffset: number
      aoLength: number
      vertexColorsOffset: number
      vertexColorsLength: number
      bvhOffset: number
      bvhLength: number
    }>
  }
}
