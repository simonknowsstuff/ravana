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
    /** Pre-merged scene geometry with a single BVH — byte offsets in the binary buffer */
    merged: {
      positionsOffset: number
      positionsLength: number
      indicesOffset: number
      indicesLength: number
      bvhOffset: number
      bvhLength: number
      colorsOffset: number
      colorsLength: number
      normalsOffset: number
      normalsLength: number
      emissiveOffset: number
      emissiveLength: number
    }
  }
  /** Lights extracted from the GLB scene */
  lights: Array<{
    type: 'point' | 'directional' | 'spot'
    position: { x: number; y: number; z: number }
    direction: { x: number; y: number; z: number }
    color: { r: number; g: number; b: number }
    intensity: number
    distance: number
    decay: number
    angle: number
    penumbra: number
  }>
}
