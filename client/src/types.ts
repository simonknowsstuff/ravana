export interface ScenePayload {
  timestamp: number
  version: string
  camera: {
    position: { x: number; y: number; z: number }
    target: { x: number; y: number; z: number }
    fov: number
    near: number
    far: number
    viewMatrix: number[]
    projectionMatrix: number[]
    cameraMatrix: number[]
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
      positionsOffset: number; positionsLength: number
      normalsOffset: number; normalsLength: number
      uvsOffset: number; uvsLength: number
      indicesOffset: number; indicesLength: number
      aoOffset: number; aoLength: number
      vertexColorsOffset: number; vertexColorsLength: number
      bvhOffset: number; bvhLength: number
    }>
    merged: {
      positionsOffset: number; positionsLength: number
      indicesOffset: number; indicesLength: number
      bvhOffset: number; bvhLength: number
      colorsOffset: number; colorsLength: number
      normalsOffset: number; normalsLength: number
      emissiveOffset: number; emissiveLength: number
      aoOffset: number; aoLength: number
      uvsOffset: number; uvsLength: number
      textureIndicesOffset: number; textureIndicesLength: number
      
      roughnessOffset: number; roughnessLength: number
      metallicOffset: number; metallicLength: number
      ormTextureIndicesOffset: number; ormTextureIndicesLength: number
      emissiveTextureIndicesOffset: number; emissiveTextureIndicesLength: number
      
      transmissionOffset: number; transmissionLength: number
      iorOffset: number; iorLength: number
      // ── NEW VOLUME DATA ──
      attenuationColorOffset: number; attenuationColorLength: number
      attenuationDistanceOffset: number; attenuationDistanceLength: number
      
      textures: Array<{
        width: number
        height: number
        pixelsOffset: number
        pixelsLength: number
      }>
    }
  }
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