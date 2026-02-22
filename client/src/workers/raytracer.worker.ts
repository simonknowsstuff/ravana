/**
 * SHARD NODE WORKER — Multi-light raytracer with point/directional/spot support
 */

interface Vector3 { x: number; y: number; z: number; }

interface LightDef {
  type: 'point' | 'directional' | 'spot';
  position: Vector3;
  direction: Vector3;
  color: { r: number; g: number; b: number };
  intensity: number;
  distance: number;   // 0 = infinite range
  decay: number;
  angle: number;       // spot half-angle (radians)
  penumbra: number;    // spot penumbra 0-1
}

interface WorkerPayload {
  type?: 'init_geometry' | 'render_tile';
  positions: Float32Array;
  bvhBuffer: Float32Array;
  indices: Uint32Array;
  colors?: Float32Array;
  normals?: Float32Array;
  emissive?: Float32Array;
  ao?: Float32Array;
  lights?: LightDef[];
  startX: number; startY: number; width: number; height: number;
  canvasWidth: number; canvasHeight: number;
  fov?: number;
  cameraPos?: Vector3; viewMatrix?: number[]; sunDir?: Vector3;
  camera?: { cameraPos?: Vector3; viewMatrix?: number[]; fov?: number; sunDir?: Vector3; };
}

const BVH_NODE_SIZE = 10;
const SHADOW_EPSILON = 0.005;

// ── GLOBAL WORKER STATE ───────────────────────────────────────────
// These persist in the Web Worker thread memory across all messages
let positions: Float32Array | null = null;
let bvhBuffer: Float32Array | null = null;
let indices: Uint32Array | null = null;
let colors: Float32Array | undefined;
let normals: Float32Array | undefined;
let emissive: Float32Array | undefined;
let ao: Float32Array | undefined;

self.onmessage = (event: MessageEvent<WorkerPayload | any>) => {
  const { type } = event.data;

  // ── 1. INITIALIZE GEOMETRY ─────────────────────────────────────
  if (type === 'init_geometry') {
    positions = event.data.positions;
    bvhBuffer = event.data.bvhBuffer;
    indices = event.data.indices;
    colors = event.data.colors;
    normals = event.data.normals;
    emissive = event.data.emissive;
    ao = event.data.ao;
    console.log(`[Worker-Web] Geometry primed: ${positions!.length / 3} vertices.`);
    return;
  }

  // ── 2. RENDER TILE ─────────────────────────────────────────────
  // Extracting local variables for this specific task
  let { startX, startY, width, height, canvasWidth, canvasHeight, lights } = event.data;
  let cameraPos: Vector3, viewMatrix: number[], sunDir: Vector3, fov: number;

  // Handle nested or flat camera data
  if (event.data.camera) {
    ({ cameraPos, viewMatrix, fov, sunDir } = event.data.camera);
  } else {
    ({ cameraPos, viewMatrix, fov, sunDir } = event.data);
  }

  // 🛑 THE CRASH PROTECTOR: Stop if we haven't received geometry yet
  if (!positions || !bvhBuffer || !indices) {
    console.warn(`[Worker-Web] Dropped tile [${startX}, ${startY}]: Geometry not initialized.`);
    return;
  }

  // Default fallbacks
  lights = lights || [];
  if (!viewMatrix) viewMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (!cameraPos) cameraPos = { x: 0, y: 0, z: 0 };
  if (!sunDir) sunDir = { x: 0, y: 1, z: 0 };
  sunDir = normalize(sunDir);
  if (!fov || fov <= 0) fov = 50;

  // ── Shadow-ray test ──
  function isOccluded(origin: Vector3, dir: Vector3, maxDist: number): boolean {
    const stack = new Uint32Array(64);
    let stackPtr = 0;
    stack[stackPtr++] = 0;
    let steps = 0;
    while (stackPtr > 0) {
      if (steps++ > 10000) break;
      const nodeIdx = stack[--stackPtr];
      const base = nodeIdx * BVH_NODE_SIZE;
      if (!intersectBox(origin, dir, bvhBuffer!, base)) continue;
      const isLeaf = bvhBuffer![base + 9] !== 0;
      if (isLeaf) {
        const off = bvhBuffer![base + 7], cnt = bvhBuffer![base + 8];
        for (let i = off; i < off + cnt; i++) {
          const i3 = i * 3;
          const aIdx = indices![i3] * 3, bIdx = indices![i3 + 1] * 3, cIdx = indices![i3 + 2] * 3;
          const t = intersectTriangle(
            origin, dir,
            { x: positions![aIdx], y: positions![aIdx + 1], z: positions![aIdx + 2] },
            { x: positions![bIdx], y: positions![bIdx + 1], z: positions![bIdx + 2] },
            { x: positions![cIdx], y: positions![cIdx + 1], z: positions![cIdx + 2] }
          );
          if (t !== null && t > SHADOW_EPSILON && t < maxDist) return true;
        }
      } else {
        stack[stackPtr++] = nodeIdx + 1;
        stack[stackPtr++] = bvhBuffer![base + 6];
      }
    }
    return false;
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  const mainStack = new Uint32Array(64);
  let pixelIdx = 0;

  for (let y = startY; y < startY + height; y++) {
    for (let x = startX; x < startX + width; x++) {
      const rd = getRayDirection(x, y, canvasWidth, canvasHeight, viewMatrix, fov);
      let closestT = Infinity;
      let hitNormal: Vector3 = { x: 0, y: 0, z: 0 };
      let hitVertA = 0;
      let hitU = 0, hitV = 0;
      let hitA = 0, hitB = 0, hitC = 0;

      let stackPtr = 0;
      mainStack[stackPtr++] = 0;
      let safety = 0;
      while (stackPtr > 0) {
        if (safety++ > 10000) break;
        const nodeIdx = mainStack[--stackPtr];
        const base = nodeIdx * BVH_NODE_SIZE;
        if (!intersectBox(cameraPos, rd, bvhBuffer!, base)) continue;
        const isLeaf = bvhBuffer![base + 9] !== 0;
        if (isLeaf) {
          const off = bvhBuffer![base + 7], cnt = bvhBuffer![base + 8];
          for (let i = off; i < off + cnt; i++) {
            const i3 = i * 3;
            const aIdx = indices![i3] * 3, bIdx = indices![i3 + 1] * 3, cIdx = indices![i3 + 2] * 3;
            const hit = intersectTriangleBary(
              cameraPos, rd,
              { x: positions![aIdx], y: positions![aIdx + 1], z: positions![aIdx + 2] },
              { x: positions![bIdx], y: positions![bIdx + 1], z: positions![bIdx + 2] },
              { x: positions![cIdx], y: positions![cIdx + 1], z: positions![cIdx + 2] }
            );
            if (hit !== null && hit.t < closestT) {
              closestT = hit.t;
              hitU = hit.u;
              hitV = hit.v;
              hitA = aIdx; hitB = bIdx; hitC = cIdx;
              hitVertA = indices![i3];
              hitNormal = calculateNormal(positions!, aIdx, bIdx, cIdx);
            }
          }
        } else {
          mainStack[stackPtr++] = nodeIdx + 1;
          mainStack[stackPtr++] = bvhBuffer![base + 6];
        }
      }

      if (closestT < Infinity) {
        const hitP: Vector3 = {
          x: cameraPos.x + rd.x * closestT,
          y: cameraPos.y + rd.y * closestT,
          z: cameraPos.z + rd.z * closestT,
        };

        let shadingNormal = hitNormal;
        if (normals && normals.length > 0) {
          const nA: Vector3 = { x: normals[hitA], y: normals[hitA + 1], z: normals[hitA + 2] };
          const nB: Vector3 = { x: normals[hitB], y: normals[hitB + 1], z: normals[hitB + 2] };
          const nC: Vector3 = { x: normals[hitC], y: normals[hitC + 1], z: normals[hitC + 2] };
          const w0 = 1 - hitU - hitV, w1 = hitU, w2 = hitV;
          shadingNormal = normalize({
            x: w0 * nA.x + w1 * nB.x + w2 * nC.x,
            y: w0 * nA.y + w1 * nB.y + w2 * nC.y,
            z: w0 * nA.z + w1 * nB.z + w2 * nC.z,
          });
        }

        const geoN = dot(hitNormal, rd) > 0 ? { x: -hitNormal.x, y: -hitNormal.y, z: -hitNormal.z } : hitNormal;
        const N = dot(shadingNormal, rd) > 0 ? { x: -shadingNormal.x, y: -shadingNormal.y, z: -shadingNormal.z } : shadingNormal;

        let albR = 0.78, albG = 0.78, albB = 0.78;
        if (colors && colors.length > 0) {
          const ci = hitVertA * 3;
          albR = colors[ci]; albG = colors[ci + 1]; albB = colors[ci + 2];
        }

        let aoFactor = 1.0;
        if (ao && ao.length > 0) aoFactor = ao[hitVertA];

        const roughness = 0.5;
        const metallic = 0.0;
        const F0 = metallic > 0.5 ? { r: 0.9, g: 0.9, b: 0.9 } : { r: 0.04, g: 0.04, b: 0.04 };

        let totalR = 0, totalG = 0, totalB = 0;
        const ambientStrength = 0.15 * aoFactor;
        totalR += albR * ambientStrength;
        totalG += albG * ambientStrength;
        totalB += albB * ambientStrength;

        for (const light of lights) {
          let L: Vector3, lightDist: number, attenuation = 1.0, spotFactor = 1.0;
          if (light.type === 'directional') {
            L = normalize({ x: -light.direction.x, y: -light.direction.y, z: -light.direction.z });
            lightDist = 1e6;
            attenuation = light.intensity;
          } else {
            const toLight = sub(light.position, hitP);
            lightDist = Math.sqrt(dot(toLight, toLight));
            L = { x: toLight.x / lightDist, y: toLight.y / lightDist, z: toLight.z / lightDist };
            attenuation = light.distance > 0 && lightDist > light.distance ? 0 : light.intensity / Math.max(1, Math.pow(lightDist, light.decay || 2));
            if (light.type === 'spot') {
              const cosAngle = -dot(L, normalize(light.direction));
              const cosCone = Math.cos(light.angle), cosPenumbra = Math.cos(light.angle * (1 - light.penumbra));
              spotFactor = cosAngle < cosCone ? 0 : cosAngle < cosPenumbra ? Math.pow((cosAngle - cosCone) / (cosPenumbra - cosCone), 2) : 1;
            }
          }
          if (attenuation * spotFactor < 0.001) continue;
          const NdotL = Math.max(0, dot(N, L));
          if (NdotL <= 0 || isOccluded({ x: hitP.x + geoN.x * SHADOW_EPSILON, y: hitP.y + geoN.y * SHADOW_EPSILON, z: hitP.z + geoN.z * SHADOW_EPSILON }, L, lightDist)) continue;

          const V = normalize(sub(cameraPos, hitP)), H = normalize({ x: L.x + V.x, y: L.y + V.y, z: L.z + V.z });
          const NdotH = Math.max(0.001, dot(N, H)), VdotH = Math.max(0.001, dot(V, H)), NdotV = Math.max(0.001, dot(N, V));
          const alpha2 = Math.pow(roughness * roughness, 2);
          const D = alpha2 / (Math.pow(NdotH * NdotH * (alpha2 - 1.0) + 1.0, 2) * 3.14159);
          const fresnel = (a: number) => a + (1.0 - a) * Math.pow(Math.max(0, 1.0 - VdotH), 5.0);
          const k = Math.pow(roughness + 1.0, 2) / 8.0;
          const G = 1.0 / (NdotV * (1.0 - k) + k) / (NdotL * (1.0 - k) + k);
          const specBrdf = D * fresnel(F0.r) * G / (4.0 * NdotV * NdotL);

          totalR += (albR * (1.0 - metallic) * NdotL * attenuation * spotFactor / 3.14159 + specBrdf * attenuation * spotFactor) * light.color.r;
          totalG += (albG * (1.0 - metallic) * NdotL * attenuation * spotFactor / 3.14159 + specBrdf * attenuation * spotFactor) * light.color.g;
          totalB += (albB * (1.0 - metallic) * NdotL * attenuation * spotFactor / 3.14159 + specBrdf * attenuation * spotFactor) * light.color.b;
        }

        const aces = (v: number) => (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
        pixels[pixelIdx++] = Math.min(255, Math.round(Math.pow(aces(totalR), 1 / 2.2) * 255));
        pixels[pixelIdx++] = Math.min(255, Math.round(Math.pow(aces(totalG), 1 / 2.2) * 255));
        pixels[pixelIdx++] = Math.min(255, Math.round(Math.pow(aces(totalB), 1 / 2.2) * 255));
        pixels[pixelIdx++] = 255;
      } else {
        pixels[pixelIdx++] = 18; pixels[pixelIdx++] = 18; pixels[pixelIdx++] = 20; pixels[pixelIdx++] = 255;
      }
    }
  }
  self.postMessage({ buffer: pixels.buffer, startX, startY, width, height }, [pixels.buffer] as any);
};

// --- MATH HELPERS ---
const dot = (a: Vector3, b: Vector3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vector3, b: Vector3): Vector3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const sub = (a: Vector3, b: Vector3): Vector3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const normalize = (v: Vector3): Vector3 => { const l = Math.sqrt(dot(v, v)); return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const calculateNormal = (pos: Float32Array, a: number, b: number, c: number): Vector3 => normalize(cross(sub({ x: pos[b], y: pos[b + 1], z: pos[b + 2] }, { x: pos[a], y: pos[a + 1], z: pos[a + 2] }), sub({ x: pos[c], y: pos[c + 1], z: pos[c + 2] }, { x: pos[a], y: pos[a + 1], z: pos[a + 2] })));
function getRayDirection(x: number, y: number, w: number, h: number, m: number[], fov: number): Vector3 {
  const aspect = w / h, halfTan = Math.tan(fov * Math.PI / 360);
  const nx = ((x + 0.5) / w * 2 - 1) * aspect * halfTan, ny = (1 - (y + 0.5) / h * 2) * halfTan;
  return normalize({ x: m[0] * nx + m[4] * ny - m[8], y: m[1] * nx + m[5] * ny - m[9], z: m[2] * nx + m[6] * ny - m[10] });
}
function intersectBox(ro: Vector3, rd: Vector3, bvh: Float32Array, base: number): boolean {
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const invD = 1.0 / (i === 0 ? rd.x : i === 1 ? rd.y : rd.z);
    const t1 = (bvh[base + i] - (i === 0 ? ro.x : i === 1 ? ro.y : ro.z)) * invD, t2 = (bvh[base + i + 3] - (i === 0 ? ro.x : i === 1 ? ro.y : ro.z)) * invD;
    tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
  }
  return tmax >= tmin && tmax > 0;
}
function intersectTriangle(ro: Vector3, rd: Vector3, v0: Vector3, v1: Vector3, v2: Vector3): number | null {
  const e1 = sub(v1, v0), e2 = sub(v2, v0), h = cross(rd, e2), a = dot(e1, h);
  if (Math.abs(a) < 1e-5) return null;
  const f = 1.0 / a, s = sub(ro, v0), u = f * dot(s, h);
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1), v = f * dot(rd, q);
  if (v < 0 || u + v > 1) return null;
  const t = f * dot(e2, q); return t > 1e-5 ? t : null;
}
function intersectTriangleBary(ro: Vector3, rd: Vector3, v0: Vector3, v1: Vector3, v2: Vector3): { t: number; u: number; v: number } | null {
  const e1 = sub(v1, v0), e2 = sub(v2, v0), h = cross(rd, e2), a = dot(e1, h);
  if (Math.abs(a) < 1e-5) return null;
  const f = 1.0 / a, s = sub(ro, v0), u = f * dot(s, h);
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1), v = f * dot(rd, q);
  if (v < 0 || u + v > 1) return null;
  const t = f * dot(e2, q); return t > 1e-5 ? { t, u, v } : null;
}