export interface RenderConfig {
  render: {
    defaultResolution: {
      width: number;
      height: number;
    };
    defaultSamples: number;
    defaultTileSize: number;
    maxSamples: number;
    minSamples: number;
    sampleStep: number;
    minTileSize: number;
    maxTileSize: number;
    tileStep: number;
    minResolution: number;
    maxWidth: number;
    maxHeight: number;
    resolutionStep: number;
    warningSamples: number;
    warningPixels: number;
    warningTileSize: number;
  };
  lighting: {
    defaultExposure: number;
    minExposure: number;
    maxExposure: number;
    exposureStep: number;
    defaultLightScale: number;
    minLightScale: number;
    maxLightScale: number;
    lightScaleStep: number;
  };
  pathtracer: {
    bounces: number;
    transmissiveBounces: number;
    filterGlossyFactor: number;
    dynamicLowRes: boolean;
    minSamples: number;
    warningBounces: number;
  };
  shadows: {
    enabled: boolean;
    mapSize: number;
    type: string;
    bias: number;
    normalBias: number;
    radius: number;
    cameraNear: number;
    cameraFar: number;
    warningMapSize: number;
  };
  baking: {
    samples: number;
    maxDistance: number;
    intensity: number;
  };
  renderer: {
    antialias: boolean;
    antialiasOptions: Array<{
      name: string;
      value: boolean;
      description: string;
    }>;
    toneMappingOptions: Array<{
      name: string;
      value: string;
      description: string;
    }>;
    shadowMapOptions: Array<{
      name: string;
      value: string;
      description: string;
    }>;
    powerPreference: string;
    stencil: boolean;
    depth: boolean;
    failIfMajorPerformanceCaveat: boolean;
    outputColorSpace: string;
    toneMapping: string;
    toneMappingExposure: number;
  };
  presets: {
    resolutions: Array<{
      name: string;
      width: number;
      height: number;
    }>;
    quality: Array<{
      name: string;
      description: string;
      samples: number;
      rayBounces: number;
      shadowMapSize: number;
      shadowMapType: string;
      antialias: boolean;
      toneMapping: string;
    }>;
  };
  description: string;
}

declare const renderConfig: RenderConfig;
export default renderConfig;
