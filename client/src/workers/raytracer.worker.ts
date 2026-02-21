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
  positions: Float32Array;
  bvhBuffer: Float32Array;
  indices: Uint32Array;
  colors?: Float32Array;
  normals?: Float32Array;
  emissive?: Float32Array;
  lights?: LightDef[];
  startX: number; startY: number; width: number; height: number;
  canvasWidth: number; canvasHeight: number;
  fov?: number;
  cameraPos?: Vector3; viewMatrix?: number[]; sunDir?: Vector3;
  camera?: { cameraPos?: Vector3; viewMatrix?: number[]; fov?: number; sunDir?: Vector3; };
}

const BVH_NODE_SIZE = 10;
const SHADOW_EPSILON = 0.005;  // offset to avoid self-intersection

self.onmessage = (event: MessageEvent<WorkerPayload | any>) => {
  let positions: Float32Array, bvhBuffer: Float32Array, indices: Uint32Array;
  let colors: Float32Array | undefined;
  let normals: Float32Array | undefined;
  let emissive: Float32Array | undefined;
  let lights: LightDef[] = [];
  let startX:number, startY:number, width:number, height:number, canvasWidth:number, canvasHeight:number;
  let fov: number | undefined;
  let cameraPos: Vector3 | undefined, viewMatrix: number[] | undefined, sunDir: Vector3 | undefined;

  if (event.data.camera) {
    ({ positions, bvhBuffer, indices, colors, normals, emissive, lights, startX, startY, width, height, canvasWidth, canvasHeight } = event.data);
    ({ cameraPos, viewMatrix, fov, sunDir } = event.data.camera);
  } else {
    ({ positions, bvhBuffer, indices, colors, normals, emissive, lights, startX, startY, width, height, canvasWidth, canvasHeight, fov, cameraPos, viewMatrix, sunDir } = event.data);
  }
  lights = lights || [];

  if (!viewMatrix) viewMatrix = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  if (!cameraPos) cameraPos = { x: 0, y: 0, z: 0 };
  if (!sunDir) sunDir = { x: 0, y: 1, z: 0 };
  sunDir = normalize(sunDir);

  if (!fov || fov <= 0) fov = 50;
  console.log(`[Worker] chunk [${startX},${startY}] ${width}x${height} | ${indices.length/3} tris, ${lights.length} lights, fov=${fov}`);

  if (bvhBuffer.length < 10) { console.error("[Worker] FATAL: empty BVH"); return; }

  // ── Shadow-ray test: returns true if point is occluded ───
  function isOccluded(origin: Vector3, dir: Vector3, maxDist: number): boolean {
    const stack = new Uint32Array(64);
    let stackPtr = 0;
    stack[stackPtr++] = 0;
    let steps = 0;
    while (stackPtr > 0) {
      if (steps++ > 10000) break;
      const nodeIdx = stack[--stackPtr];
      const base = nodeIdx * BVH_NODE_SIZE;
      if (!intersectBox(origin, dir, bvhBuffer, base)) continue;
      const isLeaf = bvhBuffer[base + 9] !== 0;
      if (isLeaf) {
        const off = bvhBuffer[base + 7], cnt = bvhBuffer[base + 8];
        for (let i = off; i < off + cnt; i++) {
          const i3 = i * 3;
          const aIdx = indices[i3]*3, bIdx = indices[i3+1]*3, cIdx = indices[i3+2]*3;
          const t = intersectTriangle(
            origin, dir,
            { x: positions[aIdx], y: positions[aIdx+1], z: positions[aIdx+2] },
            { x: positions[bIdx], y: positions[bIdx+1], z: positions[bIdx+2] },
            { x: positions[cIdx], y: positions[cIdx+1], z: positions[cIdx+2] }
          );
          if (t !== null && t > SHADOW_EPSILON && t < maxDist) return true;
        }
      } else {
        stack[stackPtr++] = nodeIdx + 1;
        stack[stackPtr++] = bvhBuffer[base + 6];
      }
    }
    return false;
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  const mainStack = new Uint32Array(64);
  let pixelIdx = 0;

  for (let y = startY; y < startY + height; y++) {
    for (let x = startX; x < startX + width; x++) {

      const rd = getRayDirection(x, y, canvasWidth, canvasHeight, viewMatrix, fov!);
      let closestT = Infinity;
      let hitNormal: Vector3 = { x: 0, y: 0, z: 0 };
      let hitVertA = 0;
      // Barycentric coords at hit (u,v) → weights: w0 = 1-u-v, w1 = u, w2 = v
      let hitU = 0, hitV = 0;
      let hitA = 0, hitB = 0, hitC = 0; // vertex indices * 3

      // ── Primary ray BVH traversal ──
      let stackPtr = 0;
      mainStack[stackPtr++] = 0;
      let safety = 0;
      while (stackPtr > 0) {
        if (safety++ > 10000) break;
        if (stackPtr > mainStack.length) break;
        const nodeIdx = mainStack[--stackPtr];
        const base = nodeIdx * BVH_NODE_SIZE;
        if (!intersectBox(cameraPos!, rd, bvhBuffer, base)) continue;
        const isLeaf = bvhBuffer[base + 9] !== 0;
        if (isLeaf) {
          const off = bvhBuffer[base + 7], cnt = bvhBuffer[base + 8];
          if (isNaN(off) || isNaN(cnt)) break;
          for (let i = off; i < off + cnt; i++) {
            const i3 = i * 3;
            const aIdx = indices[i3]*3, bIdx = indices[i3+1]*3, cIdx = indices[i3+2]*3;
            const hit = intersectTriangleBary(
              cameraPos!, rd,
              { x: positions[aIdx], y: positions[aIdx+1], z: positions[aIdx+2] },
              { x: positions[bIdx], y: positions[bIdx+1], z: positions[bIdx+2] },
              { x: positions[cIdx], y: positions[cIdx+1], z: positions[cIdx+2] }
            );
            if (hit !== null && hit.t < closestT) {
              closestT = hit.t;
              hitU = hit.u;
              hitV = hit.v;
              hitA = aIdx; hitB = bIdx; hitC = cIdx;
              hitVertA = indices[i3];
              // Compute flat face normal as fallback
              hitNormal = calculateNormal(positions, aIdx, bIdx, cIdx);
            }
          }
        } else {
          mainStack[stackPtr++] = nodeIdx + 1;
          mainStack[stackPtr++] = bvhBuffer[base + 6];
        }
      }

      // ── Shading ──
      if (closestT < Infinity) {
        // Hit point
        const hitP: Vector3 = {
          x: cameraPos!.x + rd.x * closestT,
          y: cameraPos!.y + rd.y * closestT,
          z: cameraPos!.z + rd.z * closestT,
        };

        // Interpolate smooth vertex normals if available
        let shadingNormal = hitNormal; // flat face normal fallback
        if (normals && normals.length > 0) {
          const nA: Vector3 = { x: normals[hitA], y: normals[hitA+1], z: normals[hitA+2] };
          const nB: Vector3 = { x: normals[hitB], y: normals[hitB+1], z: normals[hitB+2] };
          const nC: Vector3 = { x: normals[hitC], y: normals[hitC+1], z: normals[hitC+2] };
          // Check that normals are non-zero (zero = no smooth data available)
          const lenA = nA.x*nA.x + nA.y*nA.y + nA.z*nA.z;
          const lenB = nB.x*nB.x + nB.y*nB.y + nB.z*nB.z;
          const lenC = nC.x*nC.x + nC.y*nC.y + nC.z*nC.z;
          if (lenA > 0.001 && lenB > 0.001 && lenC > 0.001) {
            const w0 = 1 - hitU - hitV, w1 = hitU, w2 = hitV;
            shadingNormal = normalize({
              x: w0 * nA.x + w1 * nB.x + w2 * nC.x,
              y: w0 * nA.y + w1 * nB.y + w2 * nC.y,
              z: w0 * nA.z + w1 * nB.z + w2 * nC.z,
            });
          }
        }

        // Ensure normals face camera
        // Geometric face normal — always used for shadow bias (robust against smooth normal artifacts)
        const geoN = dot(hitNormal, rd) > 0
          ? { x: -hitNormal.x, y: -hitNormal.y, z: -hitNormal.z }
          : hitNormal;
        // Smooth shading normal — used for lighting appearance
        const N = dot(shadingNormal, rd) > 0
          ? { x: -shadingNormal.x, y: -shadingNormal.y, z: -shadingNormal.z }
          : shadingNormal;

        // Base albedo from vertex colors
        let albR = 0.78, albG = 0.78, albB = 0.78;
        if (colors && colors.length > 0) {
          const ci = hitVertA * 3;
          if (ci + 2 < colors.length) {
            albR = colors[ci]; albG = colors[ci+1]; albB = colors[ci+2];
          }
        }

        // Accumulate lighting from all lights
        let totalR = 0, totalG = 0, totalB = 0;
        const ambient = 0.12;
        totalR += albR * ambient;
        totalG += albG * ambient;
        totalB += albB * ambient;

        for (const light of lights) {
          let L: Vector3;       // direction from hit to light
          let lightDist: number;
          let attenuation = 1.0;
          let spotFactor = 1.0;

          if (light.type === 'directional') {
            // Direction is from light towards scene — flip for shading
            L = normalize({ x: -light.direction.x, y: -light.direction.y, z: -light.direction.z });
            lightDist = 1e6;
            attenuation = light.intensity;
          } else {
            // Point or Spot
            const toLight = sub(light.position, hitP);
            lightDist = Math.sqrt(dot(toLight, toLight));
            L = { x: toLight.x / lightDist, y: toLight.y / lightDist, z: toLight.z / lightDist };

            // Distance attenuation (physically based)
            if (light.distance > 0 && lightDist > light.distance) {
              attenuation = 0;
            } else {
              const decay = light.decay > 0 ? light.decay : 2;
              attenuation = light.intensity / Math.max(1, Math.pow(lightDist, decay));
            }

            // Spot cone attenuation
            if (light.type === 'spot' && light.angle > 0) {
              const spotDir = normalize(light.direction);
              const cosAngle = -dot(L, spotDir); // angle between -L and spot direction
              const cosCone = Math.cos(light.angle);
              const cosPenumbra = Math.cos(light.angle * (1 - light.penumbra));
              if (cosAngle < cosCone) {
                spotFactor = 0;
              } else if (cosAngle < cosPenumbra) {
                spotFactor = (cosAngle - cosCone) / (cosPenumbra - cosCone);
                spotFactor = spotFactor * spotFactor; // smooth
              }
            }
          }

          if (attenuation * spotFactor < 0.001) continue;

          // Geometric NdotL for termination (avoids terminator artifacts on smooth surfaces)
          const geoNdotL = dot(geoN, L);
          // Smooth NdotL for shading
          const NdotL = Math.max(0, dot(N, L));
          // Skip if both geometric and smooth normals face away from light
          if (geoNdotL <= 0 && NdotL <= 0) continue;

          // Shadow test — bias along GEOMETRIC face normal for robust self-shadow avoidance
          const shadowOrigin: Vector3 = {
            x: hitP.x + geoN.x * SHADOW_EPSILON,
            y: hitP.y + geoN.y * SHADOW_EPSILON,
            z: hitP.z + geoN.z * SHADOW_EPSILON,
          };
          if (isOccluded(shadowOrigin, L, lightDist)) continue;

          const diffuse = NdotL * attenuation * spotFactor;

          // Specular (Blinn-Phong)
          const V = normalize(sub(cameraPos!, hitP));
          const H = normalize({ x: L.x + V.x, y: L.y + V.y, z: L.z + V.z });
          const NdotH = Math.max(0, dot(N, H));
          const specular = Math.pow(NdotH, 32) * attenuation * spotFactor * 0.3;

          totalR += albR * light.color.r * diffuse + light.color.r * specular;
          totalG += albG * light.color.g * diffuse + light.color.g * specular;
          totalB += albB * light.color.b * diffuse + light.color.b * specular;
        }

        // If no scene lights contributed (fallback sun), add a soft directional
        if (lights.length === 0) {
          const NdotS = Math.max(0, dot(N, sunDir!));
          totalR += albR * NdotS * 0.6 + albR * 0.3;
          totalG += albG * NdotS * 0.6 + albG * 0.3;
          totalB += albB * NdotS * 0.6 + albB * 0.3;
        }

        // Add emissive (self-illumination — independent of lighting / shadows)
        if (emissive && emissive.length > 0) {
          const ei = hitVertA * 3;
          if (ei + 2 < emissive.length) {
            totalR += emissive[ei];
            totalG += emissive[ei + 1];
            totalB += emissive[ei + 2];
          }
        }

        // Tone-map (simple Reinhard) and gamma correct
        const tonemap = (v: number) => v / (v + 1);
        pixels[pixelIdx++] = Math.min(255, Math.round(tonemap(totalR) * 255));
        pixels[pixelIdx++] = Math.min(255, Math.round(tonemap(totalG) * 255));
        pixels[pixelIdx++] = Math.min(255, Math.round(tonemap(totalB) * 255));
        pixels[pixelIdx++] = 255;
      } else {
        // Sky gradient
        const t = 0.5 * (rd.y + 1.0);
        pixels[pixelIdx++] = Math.round((1.0 - t) * 40 + t * 135);
        pixels[pixelIdx++] = Math.round((1.0 - t) * 45 + t * 180);
        pixels[pixelIdx++] = Math.round((1.0 - t) * 60 + t * 230);
        pixels[pixelIdx++] = 255;
      }
    }
  }

  console.log(`[Worker] Finished chunk [${startX}, ${startY}]`);
  self.postMessage({ buffer: pixels.buffer, startX, startY, width, height }, [pixels.buffer] as any);
};

// --- MATH HELPERS ---
function getRayDirection(x: number, y: number, w: number, h: number, matrix: number[], fov: number): Vector3 {
  const aspect = w / h;
  const halfTan = Math.tan(fov * Math.PI / 360); // fov is in degrees
  // Map pixel center to camera-space direction, then rotate to world space
  const nx = ((x + 0.5) / w * 2 - 1) * aspect * halfTan;
  const ny = (1 - (y + 0.5) / h * 2) * halfTan;
  const dx = matrix[0] * nx + matrix[4] * ny - matrix[8];
  const dy = matrix[1] * nx + matrix[5] * ny - matrix[9];
  const dz = matrix[2] * nx + matrix[6] * ny - matrix[10];
  return normalize({ x: dx, y: dy, z: dz });
}
function intersectBox(ro: Vector3, rd: Vector3, bvh: Float32Array, base: number): boolean {
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const invD = 1.0 / (i === 0 ? rd.x : i === 1 ? rd.y : rd.z);
    const min = bvh[base + i];
    const max = bvh[base + i + 3];
    let t1 = (min - (i === 0 ? ro.x : i === 1 ? ro.y : ro.z)) * invD;
    let t2 = (max - (i === 0 ? ro.x : i === 1 ? ro.y : ro.z)) * invD;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  }
  return tmax >= tmin && tmax > 0;
}
function intersectTriangle(ro: Vector3, rd: Vector3, v0: Vector3, v1: Vector3, v2: Vector3): number | null {
  const e1 = sub(v1, v0);
  const e2 = sub(v2, v0);
  const h = cross(rd, e2);
  const a = dot(e1, h);
  if (a > -0.00001 && a < 0.00001) return null;
  const f = 1.0 / a;
  const s = sub(ro, v0);
  const u = f * dot(s, h);
  if (u < 0.0 || u > 1.0) return null;
  const q = cross(s, e1);
  const v = f * dot(rd, q);
  if (v < 0.0 || u + v > 1.0) return null;
  const t = f * dot(e2, q);
  return t > 0.00001 ? t : null;
}
/** Triangle intersection returning barycentric coords for normal interpolation */
function intersectTriangleBary(ro: Vector3, rd: Vector3, v0: Vector3, v1: Vector3, v2: Vector3): { t: number; u: number; v: number } | null {
  const e1 = sub(v1, v0);
  const e2 = sub(v2, v0);
  const h = cross(rd, e2);
  const a = dot(e1, h);
  if (a > -0.00001 && a < 0.00001) return null;
  const f = 1.0 / a;
  const s = sub(ro, v0);
  const u = f * dot(s, h);
  if (u < 0.0 || u > 1.0) return null;
  const q = cross(s, e1);
  const v = f * dot(rd, q);
  if (v < 0.0 || u + v > 1.0) return null;
  const t = f * dot(e2, q);
  return t > 0.00001 ? { t, u, v } : null;
}
const dot = (a: Vector3, b: Vector3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vector3, b: Vector3): Vector3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const sub = (a: Vector3, b: Vector3): Vector3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const normalize = (v: Vector3): Vector3 => {
  const l = Math.sqrt(dot(v, v));
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const calculateNormal = (pos: Float32Array, a: number, b: number, c: number): Vector3 => {
  const vA = { x: pos[a], y: pos[a+1], z: pos[a+2] };
  const vB = { x: pos[b], y: pos[b+1], z: pos[b+2] };
  const vC = { x: pos[c], y: pos[c+1], z: pos[c+2] };
  return normalize(cross(sub(vB, vA), sub(vC, vA)));
};