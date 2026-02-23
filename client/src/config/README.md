# Render Configuration

This file contains all quality and performance settings for the Ravana rendering system. All values are optimized for mobile device compatibility by default.

## Configuration Sections

### `render`
Controls rendering resolution and sample quality.
- **defaultResolution**: 1280×720 (720p) - Mobile-safe default
- **defaultSamples**: 8 - Balanced quality/performance
- **maxSamples**: 64 - Upper limit for quality presets
- **defaultTileSize**: 64px - Optimal tile size for distribution

### `lighting`
Controls exposure and light intensity.
- **defaultLightScale**: 0.01 - Most GLTF lights need heavy reduction
- Ranges: -10 to +10 EV, 0.001 to 10× light scale

### `pathtracer`
GPU pathtracer settings.
- **bounces**: 4 - Ray bounces (mobile-safe, provides indirect lighting)  
- **transmissiveBounces**: 4 - Bounces through transparent materials
- **filterGlossyFactor**: 0.5 - Reduces fireflies

Note: Quality presets override bounce settings (3-8 bounces depending on preset)

### `shadows`
Shadow quality settings.
- **mapSize**: 1024 - Shadow map resolution (mobile-compatible)
- **type**: BasicShadowMap - Simpler algorithm for mobile reliability
- **enabled**: true - Shadows on by default

### `baking`
BVH building and ambient occlusion settings.
- **samples**: 32 - AO raycast samples (faster preprocessing)
- **maxDistance**: 2.0 - AO search radius
- **intensity**: 1.0 - AO strength

### `renderer`
WebGL renderer configuration.
- **antialias**: false - Performance optimization for mobile
- **powerPreference**: "default" - Compatible with all devices
- **failIfMajorPerformanceCaveat**: false - Don't fail on slow devices

### `presets`
Quick resolution and quality presets for UI.

**Resolution Presets:**
- 720p: 1280×720 (Mobile-friendly)
- 1080p: 1920×1080 (Desktop standard)
- 1440p: 2560×1440 (High-end desktop)
- 4K: 3840×2160 (Professional workstation)

**Quality Presets:**
- **Fast Preview**: 4 samples, 2 bounces, 512 shadow map, BasicShadowMap, no AA
  - Very fast but noisy/grainy preview
  - Use for quick composition testing
  - Will be noticeably lower quality
  
- **Mobile**: 6 samples, 3 bounces, 1024 shadow map, BasicShadowMap, no AA
  - Optimized for phones, tablets, and low-end devices
  - Prevents black tiles and GPU context loss
  - Decent quality for simple scenes
  
- **Balanced**: 16 samples, 6 bounces, 2048 shadow map, PCFShadowMap, MSAA
  - Good quality with reduced noise
  - Best balance of speed and visual quality
  - Recommended for most final renders
  
- **High Quality**: 32 samples, 8 bounces, 2048 shadow map, PCFShadowMap, MSAA
  - Clean result with good indirect lighting
  - Higher quality but slower render time
  - For final renders with complex lighting

## Understanding Quality Settings

**When to see visible differences:**

Quality differences are MOST visible in scenes with:
- **Complex indirect lighting** (light bouncing between surfaces)
- **Glossy/reflective surfaces** (mirrors, metal, water)
- **Transparent materials** (glass, liquids)
- **Soft shadows** from large light sources
- **Color bleeding** between objects

Quality differences are SUBTLE in scenes with:
- Simple direct lighting only
- Matte surfaces
- Small or no shadows
- Bright, evenly lit environments

**What each setting does:**
- **Samples**: Reduces noise/grain. Low samples = grainy, high samples = smooth
- **Ray Bounces**: Affects indirect lighting. Only visible if light bounces between surfaces
- **Shadow Map Size**: Only affects shadow sharpness. Hard to see unless zoomed in
- **Anti-aliasing**: Only smooths edges, doesn't affect overall quality

## Advanced Settings (UI Controls)

The dashboard provides additional rendering controls under "More Settings":

### Anti-Aliasing
- **None**: No anti-aliasing (best performance, some aliasing)
- **MSAA**: Multisample anti-aliasing (smooth edges, slight performance cost)

### Tone Mapping
Controls how HDR colors are mapped to screen:
- **NoToneMapping**: Linear, no tone mapping
- **LinearToneMapping**: Simple linear scaling
- **ReinhardToneMapping**: Natural, slightly desaturated look
- **CineonToneMapping**: Film-like color grading
- **ACESFilmicToneMapping**: Industry standard, cinematic look (default)

### Shadow Quality
- **Type**: BasicShadowMap (fast), PCFShadowMap (smooth), PCFSoftShadowMap (softest)
- **Resolution**: 512-8192 pixels - Higher = sharper but more memory

### Ray Bounces
- **Range**: 1-64 bounces (presets use 2-8)
- Higher = more realistic indirect lighting, but slower
- Only matters if light bounces between surfaces in your scene
- Default: 4 (mobile-safe)

## Quick Quality Selection

The easiest way to adjust quality is using the preset selector in the UI:

1. **Fast Preview** - Use for quick testing and composition (will be noticeably noisy)
2. **Mobile** - For phones/tablets or if experiencing issues
3. **Balanced** - Recommended for most final renders (good quality, reasonable speed)
4. **High Quality** - For complex scenes with indirect lighting (slower but cleaner)

You can also fine-tune individual settings after selecting a preset.

**Pro Tip**: Start with "Fast Preview" (4 samples) to test your scene. If it looks good but grainy, the higher presets will clean it up. If it already looks clean at 4 samples, higher settings won't add much visible quality.

## Adjusting Settings

To change the default quality level, edit `renderConfig.json` or use the quality preset selector in the UI.

**Manual quality adjustments:**

To permanently change defaults for desktop use:
```json
{
  "render": { 
    "defaultResolution": { "width": 1920, "height": 1080 },
    "defaultSamples": 16
  },
  "shadows": { "mapSize": 2048, "type": "PCFShadowMap" },
  "pathtracer": { "bounces": 8 },
  "renderer": { "antialias": true, "powerPreference": "high-performance" }
}
```

For even lower quality (very weak devices):
```json
{
  "render": { 
    "defaultResolution": { "width": 960, "height": 540 },
    "defaultSamples": 4
  },
  "shadows": { "mapSize": 512, "type": "BasicShadowMap" },
  "pathtracer": { "bounces": 2 },
  "renderer": { "antialias": false }
}
```

For maximum quality (production renders):
```json
{
  "render": { 
    "defaultResolution": { "width": 3840, "height": 2160 },
    "defaultSamples": 64,
    "maxSamples": 128
  },
  "shadows": { "mapSize": 8192, "type": "PCFSoftShadowMap" },
  "pathtracer": { "bounces": 64 },
  "renderer": { "antialias": true }
}
```

## Current Settings
Optimized for: **Mobile devices and maximum compatibility**
- Default settings work on phones, tablets, laptops, and desktops
- WebGL context loss handling prevents failures on mobile
- Quality presets allow easy adjustment per render
- Advanced settings provide fine-grained control

## Mobile Compatibility

The default settings are already optimized for mobile devices. If you experience issues:
- Ensure you're using the "Mobile" preset
- Try lowering resolution below 720p (e.g., 640×480)
- Reduce samples to 4 if GPU timeouts occur
- Check that shadow map size is 1024 or lower

Common mobile issues:
- **Black tiles**: Usually caused by shadow maps >1024 or insufficient GPU memory
- **Context loss**: Handled automatically, but may require page refresh
- **Slow rendering**: Normal on mobile; try "Mobile" preset with lower resolution
