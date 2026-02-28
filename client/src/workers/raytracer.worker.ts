/**
 * SHARD NODE WORKER — Path Tracer (True Glass, Volume Attenuation, Refraction)
 */

interface Vector3 { x: number; y: number; z: number; }
interface LightDef { type: 'point' | 'directional' | 'spot'; position: Vector3; direction: Vector3; color: { r: number; g: number; b: number }; intensity: number; distance: number; decay: number; angle: number; penumbra: number; }
interface WorkerPayload {
  type?: 'init_geometry' | 'render_tile';
  positions: Float32Array; bvhBuffer: Float32Array; indices: Uint32Array;
  colors?: Float32Array; normals?: Float32Array; emissive?: Float32Array; ao?: Float32Array;
  uvs?: Float32Array; textureIndices?: Float32Array; roughness?: Float32Array; metallic?: Float32Array;
  ormTextureIndices?: Float32Array; emissiveTextureIndices?: Float32Array;
  transmissionArray?: Float32Array; iorArray?: Float32Array; 
  attenuationColorArray?: Float32Array; attenuationDistanceArray?: Float32Array; // ── NEW
  textures?: { width: number, height: number, pixels: Uint8Array }[];
  lights?: LightDef[]; startX: number; startY: number; width: number; height: number;
  canvasWidth: number; canvasHeight: number; fov?: number;
  cameraPos?: Vector3; viewMatrix?: number[]; sunDir?: Vector3;
  camera?: { cameraPos?: Vector3; viewMatrix?: number[]; fov?: number; sunDir?: Vector3; };
}

const BVH_NODE_SIZE = 10;
const SHADOW_EPSILON = 0.001;

let positions: Float32Array | null = null; let bvhBuffer: Float32Array | null = null; let indices: Uint32Array | null = null;
let colors: Float32Array | undefined; let normals: Float32Array | undefined; let emissive: Float32Array | undefined; let ao: Float32Array | undefined;
let uvs: Float32Array | undefined; let textureIndices: Float32Array | undefined; let roughnessArray: Float32Array | undefined; let metallicArray: Float32Array | undefined;
let ormTextureIndices: Float32Array | undefined; let emissiveTextureIndices: Float32Array | undefined;
let transmissionArray: Float32Array | undefined; let iorArray: Float32Array | undefined;
let attenuationColorArray: Float32Array | undefined; let attenuationDistanceArray: Float32Array | undefined;
let textures: { width: number, height: number, pixels: Uint8Array }[] = [];

function refract(I: Vector3, N: Vector3, eta: number): Vector3 | null {
  const cosI = -dot(N, I); const sinT2 = eta * eta * (1.0 - cosI * cosI);
  if (sinT2 > 1.0) return null; 
  const cosT = Math.sqrt(1.0 - sinT2);
  return { x: eta * I.x + (eta * cosI - cosT) * N.x, y: eta * I.y + (eta * cosI - cosT) * N.y, z: eta * I.z + (eta * cosI - cosT) * N.z };
}
function reflect(I: Vector3, N: Vector3): Vector3 { const d = 2.0 * dot(I, N); return { x: I.x - d * N.x, y: I.y - d * N.y, z: I.z - d * N.z }; }

function sampleTextureBilinear(tex: any, u: number, v: number, isSRGB: boolean) {
  let u_wrap = u - Math.floor(u); let v_wrap = v - Math.floor(v);
  const u_img = u_wrap * tex.width - 0.5; const v_img = v_wrap * tex.height - 0.5;
  const x0 = Math.max(0, Math.floor(u_img)); const y0 = Math.max(0, Math.floor(v_img));
  const x1 = Math.min(tex.width - 1, x0 + 1); const y1 = Math.min(tex.height - 1, y0 + 1);
  const frac_x = u_img - Math.floor(u_img); const frac_y = v_img - Math.floor(v_img);
  const getPixel = (px: number, py: number) => {
    const idx = (py * tex.width + px) * 4;
    let r = tex.pixels[idx] / 255.0; let g = tex.pixels[idx + 1] / 255.0; let b = tex.pixels[idx + 2] / 255.0;
    if (isSRGB) { r = Math.pow(r, 2.2); g = Math.pow(g, 2.2); b = Math.pow(b, 2.2); }
    return { r, g, b };
  };
  const p00 = getPixel(x0, y0); const p10 = getPixel(x1, y0); const p01 = getPixel(x0, y1); const p11 = getPixel(x1, y1);
  const c0r = p00.r * (1 - frac_x) + p10.r * frac_x; const c0g = p00.g * (1 - frac_x) + p10.g * frac_x; const c0b = p00.b * (1 - frac_x) + p10.b * frac_x;
  const c1r = p01.r * (1 - frac_x) + p11.r * frac_x; const c1g = p01.g * (1 - frac_x) + p11.g * frac_x; const c1b = p01.b * (1 - frac_x) + p11.b * frac_x;
  return { r: c0r * (1 - frac_y) + c1r * frac_y, g: c0g * (1 - frac_y) + c1g * frac_y, b: c0b * (1 - frac_y) + c1b * frac_y };
}

self.onmessage = (event: MessageEvent<WorkerPayload | any>) => {
  const { type } = event.data;

  if (type === 'init_geometry') {
    positions = event.data.positions; bvhBuffer = event.data.bvhBuffer; indices = event.data.indices;
    colors = event.data.colors; normals = event.data.normals; emissive = event.data.emissive; ao = event.data.ao;
    uvs = event.data.uvs; textureIndices = event.data.textureIndices; roughnessArray = event.data.roughness; metallicArray = event.data.metallic;
    ormTextureIndices = event.data.ormTextureIndices; emissiveTextureIndices = event.data.emissiveTextureIndices;
    transmissionArray = event.data.transmissionArray; iorArray = event.data.iorArray;
    attenuationColorArray = event.data.attenuationColorArray; attenuationDistanceArray = event.data.attenuationDistanceArray;
    textures = event.data.textures || []; return;
  }

  let { startX, startY, width, height, canvasWidth, canvasHeight, lights } = event.data;
  let cameraPos: Vector3, viewMatrix: number[], sunDir: Vector3, fov: number;
  if (event.data.camera) ({ cameraPos, viewMatrix, fov, sunDir } = event.data.camera); else ({ cameraPos, viewMatrix, fov, sunDir } = event.data);
  if (!positions || !bvhBuffer || !indices) return;
  lights = lights || [];
  if (!viewMatrix) viewMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (!cameraPos) cameraPos = { x: 0, y: 0, z: 0 };
  if (!fov || fov <= 0) fov = 50;

  function isOccluded(origin: Vector3, dir: Vector3, maxDist: number): boolean {
    const stack = new Uint32Array(64); let stackPtr = 0; stack[stackPtr++] = 0; let steps = 0;
    while (stackPtr > 0) {
      if (steps++ > 10000) break;
      const nodeIdx = stack[--stackPtr]; const base = nodeIdx * BVH_NODE_SIZE;
      if (!intersectBox(origin, dir, bvhBuffer!, base)) continue;
      if (bvhBuffer![base + 9] !== 0) {
        const off = bvhBuffer![base + 7], cnt = bvhBuffer![base + 8];
        for (let i = off; i < off + cnt; i++) {
          const i3 = i * 3; const aIdx = indices![i3] * 3, bIdx = indices![i3 + 1] * 3, cIdx = indices![i3 + 2] * 3;
          const t = intersectTriangle(origin, dir, { x: positions![aIdx], y: positions![aIdx + 1], z: positions![aIdx + 2] }, { x: positions![bIdx], y: positions![bIdx + 1], z: positions![bIdx + 2] }, { x: positions![cIdx], y: positions![cIdx + 1], z: positions![cIdx + 2] });
          if (t !== null && t > SHADOW_EPSILON && t < maxDist) {
            const vertIndexA = indices![i3];
            const trans = (transmissionArray && transmissionArray.length > 0) ? transmissionArray[vertIndexA] : 0.0;
            if (trans < 0.5) return true; // Glass doesn't completely block shadow rays
          }
        }
      } else { stack[stackPtr++] = nodeIdx + 1; stack[stackPtr++] = bvhBuffer![base + 6]; }
    }
    return false;
  }

  const pixels = new Uint8ClampedArray(width * height * 4); const mainStack = new Uint32Array(64); let pixelIdx = 0;
  
  const SAMPLES_PER_PIXEL = 4; 
  const SHADOW_SOFTNESS = 0.01; 
  const MAX_BOUNCES = 8; 

  for (let y = startY; y < startY + height; y++) {
    for (let x = startX; x < startX + width; x++) {
      let pixelTotalR = 0, pixelTotalG = 0, pixelTotalB = 0;

      for (let s = 0; s < SAMPLES_PER_PIXEL; s++) {
        const jx = x + Math.random(); const jy = y + Math.random();
        let currentPos = cameraPos; let currentDir = getRayDirection(jx, jy, canvasWidth, canvasHeight, viewMatrix, fov);
        let throughputR = 1.0, throughputG = 1.0, throughputB = 1.0;
        let sampleR = 0, sampleG = 0, sampleB = 0;
        let rayEscaped = false;

        for (let bounce = 0; bounce < MAX_BOUNCES; bounce++) {
          let closestT = Infinity; let hitNormal: Vector3 = { x: 0, y: 0, z: 0 }; let hitVertA = 0;
          let hitU = 0, hitV = 0; let hitA = 0, hitB = 0, hitC = 0;
          let stackPtr = 0; mainStack[stackPtr++] = 0; let safety = 0;
          
          while (stackPtr > 0) {
            if (safety++ > 10000) break;
            const nodeIdx = mainStack[--stackPtr]; const base = nodeIdx * BVH_NODE_SIZE;
            if (!intersectBox(currentPos, currentDir, bvhBuffer!, base)) continue;
            if (bvhBuffer![base + 9] !== 0) {
              const off = bvhBuffer![base + 7], cnt = bvhBuffer![base + 8];
              for (let i = off; i < off + cnt; i++) {
                const i3 = i * 3; const aIdx = indices![i3] * 3, bIdx = indices![i3 + 1] * 3, cIdx = indices![i3 + 2] * 3;
                const hit = intersectTriangleBary(currentPos, currentDir, { x: positions![aIdx], y: positions![aIdx + 1], z: positions![aIdx + 2] }, { x: positions![bIdx], y: positions![bIdx + 1], z: positions![bIdx + 2] }, { x: positions![cIdx], y: positions![cIdx + 1], z: positions![cIdx + 2] });
                if (hit !== null && hit.t < closestT) {
                  closestT = hit.t; hitU = hit.u; hitV = hit.v; hitA = aIdx; hitB = bIdx; hitC = cIdx; hitVertA = indices![i3];
                  hitNormal = calculateNormal(positions!, aIdx, bIdx, cIdx);
                }
              }
            } else { mainStack[stackPtr++] = nodeIdx + 1; mainStack[stackPtr++] = bvhBuffer![base + 6]; }
          }

          if (closestT < Infinity) {
            const hitP: Vector3 = { x: currentPos.x + currentDir.x * closestT, y: currentPos.y + currentDir.y * closestT, z: currentPos.z + currentDir.z * closestT };
            const w0 = 1 - hitU - hitV; const w1 = hitU; const w2 = hitV;
            let shadingNormal = hitNormal;
            if (normals && normals.length > 0) {
              const nA: Vector3 = { x: normals[hitA], y: normals[hitA + 1], z: normals[hitA + 2] }; const nB: Vector3 = { x: normals[hitB], y: normals[hitB + 1], z: normals[hitB + 2] }; const nC: Vector3 = { x: normals[hitC], y: normals[hitC + 1], z: normals[hitC + 2] };
              shadingNormal = normalize({ x: w0 * nA.x + w1 * nB.x + w2 * nC.x, y: w0 * nA.y + w1 * nB.y + w2 * nC.y, z: w0 * nA.z + w1 * nB.z + w2 * nC.z });
            }

            const geoN = dot(hitNormal, currentDir) > 0 ? { x: -hitNormal.x, y: -hitNormal.y, z: -hitNormal.z } : hitNormal;
            const N = dot(shadingNormal, currentDir) > 0 ? { x: -shadingNormal.x, y: -shadingNormal.y, z: -shadingNormal.z } : shadingNormal;
            const vertIndexA = hitA / 3;
            let u = 0, v = 0;
            if (uvs && uvs.length > 0) {
              const uvIdxA = vertIndexA * 2, uvIdxB = (hitB / 3) * 2, uvIdxC = (hitC / 3) * 2;
              u = w0 * uvs[uvIdxA] + w1 * uvs[uvIdxB] + w2 * uvs[uvIdxC]; v = w0 * uvs[uvIdxA + 1] + w1 * uvs[uvIdxB + 1] + w2 * uvs[uvIdxC + 1];
            }

            let albR = 0.78, albG = 0.78, albB = 0.78;
            const diffuseIdx = (textureIndices && textureIndices.length > 0) ? textureIndices[vertIndexA] : -1;
            if (diffuseIdx >= 0 && diffuseIdx < textures.length) {
              const colorSample = sampleTextureBilinear(textures[diffuseIdx], u, v, true);
              albR = colorSample.r; albG = colorSample.g; albB = colorSample.b;
            } else if (colors && colors.length > 0) {
              const ci = hitVertA * 3; albR = colors[ci]; albG = colors[ci + 1]; albB = colors[ci + 2];
            }

            let transmission = (transmissionArray && transmissionArray.length > 0) ? transmissionArray[vertIndexA] : 0.0;
            let ior = (iorArray && iorArray.length > 0) ? iorArray[vertIndexA] : 1.5;

            // ── GLASS / REFRACTION PATH ──
            if (transmission > 0.1) {
              const isInside = dot(currentDir, hitNormal) > 0;
              const refractionNormal = isInside ? { x: -shadingNormal.x, y: -shadingNormal.y, z: -shadingNormal.z } : shadingNormal;
              const eta = isInside ? ior : 1.0 / ior;

              // GLINT ON GLASS SURFACE
              if (!isInside) {
                for (const light of lights) {
                  let L: Vector3, attenuation = 1.0;
                  if (light.type === 'directional') {
                    L = normalize({ x: -light.direction.x, y: -light.direction.y, z: -light.direction.z }); attenuation = Math.min(light.intensity, 3.0); 
                  } else {
                    const toLight = sub(light.position, hitP); const lightDist = Math.sqrt(dot(toLight, toLight)); L = { x: toLight.x / lightDist, y: toLight.y / lightDist, z: toLight.z / lightDist };
                    attenuation = light.distance > 0 && lightDist > light.distance ? 0 : light.intensity / Math.max(0.1, dot(toLight, toLight));
                  }
                  const NdotL = Math.max(0, dot(refractionNormal, L));
                  if (NdotL > 0) {
                    const V = normalize(sub(currentPos, hitP)); const H = normalize({ x: L.x + V.x, y: L.y + V.y, z: L.z + V.z });
                    const specular = Math.pow(Math.max(0.001, dot(refractionNormal, H)), 250.0) * attenuation;
                    sampleR += throughputR * specular * light.color.r; sampleG += throughputG * specular * light.color.g; sampleB += throughputB * specular * light.color.b;
                  }
                }
              }

              // TRUE VOLUME ATTENUATION (Beer-Lambert Math)
              if (isInside) {
                 let attDist = (attenuationDistanceArray && attenuationDistanceArray.length > 0) ? attenuationDistanceArray[vertIndexA] : Infinity;
                 let attR = 1.0, attG = 1.0, attB = 1.0;
                 if (attenuationColorArray && attenuationColorArray.length > 0) {
                   const ci = vertIndexA * 3; attR = attenuationColorArray[ci]; attG = attenuationColorArray[ci + 1]; attB = attenuationColorArray[ci + 2];
                 }

                 if (attDist > 0 && attDist < Infinity) {
                   // Calculate physically accurate fractional absorption based on distance traveled
                   const power = closestT / attDist;
                   throughputR *= Math.pow(Math.max(0.001, attR), power);
                   throughputG *= Math.pow(Math.max(0.001, attG), power);
                   throughputB *= Math.pow(Math.max(0.001, attB), power);
                 }
              }

              const cosTheta = Math.min(1.0, Math.max(0.0, -dot(currentDir, refractionNormal)));
              const R0 = Math.pow((1.0 - eta) / (1.0 + eta), 2.0);
              const R = R0 + (1.0 - R0) * Math.pow(1.0 - cosTheta, 5.0);

              if (Math.random() < R) {
                currentDir = reflect(currentDir, refractionNormal);
                currentPos = { x: hitP.x + refractionNormal.x * SHADOW_EPSILON, y: hitP.y + refractionNormal.y * SHADOW_EPSILON, z: hitP.z + refractionNormal.z * SHADOW_EPSILON };
              } else {
                const refracted = refract(currentDir, refractionNormal, eta);
                if (refracted) {
                  currentDir = refracted;
                  currentPos = { x: hitP.x - refractionNormal.x * SHADOW_EPSILON, y: hitP.y - refractionNormal.y * SHADOW_EPSILON, z: hitP.z - refractionNormal.z * SHADOW_EPSILON };
                } else {
                  currentDir = reflect(currentDir, refractionNormal);
                  currentPos = { x: hitP.x + refractionNormal.x * SHADOW_EPSILON, y: hitP.y + refractionNormal.y * SHADOW_EPSILON, z: hitP.z + refractionNormal.z * SHADOW_EPSILON };
                }
              }
              continue; 
            }

            // ── SOLID PBR PATH ──
            let roughness = (roughnessArray && roughnessArray.length > 0) ? roughnessArray[vertIndexA] : 0.5;
            let metallic = (metallicArray && metallicArray.length > 0) ? metallicArray[vertIndexA] : 0.0;
            let aoFactor = (ao && ao.length > 0) ? ao[hitVertA] : 1.0;
            const ormIdx = (ormTextureIndices && ormTextureIndices.length > 0) ? ormTextureIndices[vertIndexA] : -1;
            if (ormIdx >= 0 && ormIdx < textures.length) {
              const ormSample = sampleTextureBilinear(textures[ormIdx], u, v, false);
              aoFactor *= ormSample.r; roughness *= ormSample.g; metallic *= ormSample.b;
            }
            
            roughness = Math.max(0.04, Math.min(1.0, roughness)); metallic = Math.max(0.0, Math.min(1.0, metallic));
            const F0 = metallic > 0.5 ? { r: albR, g: albG, b: albB } : { r: 0.04, g: 0.04, b: 0.04 };
            let surfaceR = albR * 0.15 * aoFactor; let surfaceG = albG * 0.15 * aoFactor; let surfaceB = albB * 0.15 * aoFactor;

            for (const light of lights) {
              let L: Vector3, lightDist: number, attenuation = 1.0, spotFactor = 1.0;
              if (light.type === 'directional') {
                L = normalize({ x: -light.direction.x, y: -light.direction.y, z: -light.direction.z }); lightDist = 1e6; attenuation = Math.min(light.intensity, 3.0); 
              } else {
                const toLight = sub(light.position, hitP); lightDist = Math.sqrt(dot(toLight, toLight)); L = { x: toLight.x / lightDist, y: toLight.y / lightDist, z: toLight.z / lightDist };
                attenuation = light.distance > 0 && lightDist > light.distance ? 0 : light.intensity / Math.max(0.1, dot(toLight, toLight));
              }
              if (attenuation * spotFactor < 0.001) continue;
              const NdotL = Math.max(0, dot(N, L));
              if (NdotL <= 0) continue;
              
              const jitteredL = normalize({ x: L.x + (Math.random() - 0.5) * SHADOW_SOFTNESS, y: L.y + (Math.random() - 0.5) * SHADOW_SOFTNESS, z: L.z + (Math.random() - 0.5) * SHADOW_SOFTNESS });
              if (isOccluded({ x: hitP.x + geoN.x * SHADOW_EPSILON, y: hitP.y + geoN.y * SHADOW_EPSILON, z: hitP.z + geoN.z * SHADOW_EPSILON }, jitteredL, lightDist)) continue;

              const V = normalize(sub(currentPos, hitP)); const H = normalize({ x: L.x + V.x, y: L.y + V.y, z: L.z + V.z });
              const NdotH = Math.max(0.001, dot(N, H)); const VdotH = Math.max(0.001, dot(V, H)); const NdotV = Math.max(0.001, dot(N, V));
              const safeRoughness = Math.max(0.08, roughness); const alpha2 = Math.pow(safeRoughness * safeRoughness, 2);
              const D = alpha2 / (Math.pow(NdotH * NdotH * (alpha2 - 1.0) + 1.0, 2) * Math.PI);
              const fresnel = (a: number) => a + (1.0 - a) * Math.pow(Math.max(0, 1.0 - VdotH), 5.0);
              const F = { r: fresnel(F0.r), g: fresnel(F0.g), b: fresnel(F0.b) };
              const k = Math.pow(safeRoughness + 1.0, 2) / 8.0; const G = 1.0 / (NdotV * (1.0 - k) + k) / (NdotL * (1.0 - k) + k);
              
              const denominator = Math.max(0.001, 4.0 * NdotV * NdotL);
              let specBrdfR = Math.min(10.0, (D * F.r * G) / denominator); let specBrdfG = Math.min(10.0, (D * F.g * G) / denominator); let specBrdfB = Math.min(10.0, (D * F.b * G) / denominator);
              const kD_r = (1.0 - F.r) * (1.0 - metallic); const kD_g = (1.0 - F.g) * (1.0 - metallic); const kD_b = (1.0 - F.b) * (1.0 - metallic);
              const radiance = attenuation * spotFactor * NdotL;

              surfaceR += ((albR * kD_r) / Math.PI + specBrdfR) * light.color.r * radiance;
              surfaceG += ((albG * kD_g) / Math.PI + specBrdfG) * light.color.g * radiance;
              surfaceB += ((albB * kD_b) / Math.PI + specBrdfB) * light.color.b * radiance;
            }

            let emiR = 0, emiG = 0, emiB = 0;
            const emiIdx = (emissiveTextureIndices && emissiveTextureIndices.length > 0) ? emissiveTextureIndices[vertIndexA] : -1;
            if (emiIdx >= 0 && emiIdx < textures.length) {
              const emiSample = sampleTextureBilinear(textures[emiIdx], u, v, true); emiR = emiSample.r; emiG = emiSample.g; emiB = emiSample.b;
            } else if (emissive && emissive.length > 0) {
              const ei = hitVertA * 3; if (ei + 2 < emissive.length) { emiR = emissive[ei]; emiG = emissive[ei + 1]; emiB = emissive[ei + 2]; }
            }
            surfaceR += emiR * 5.0; surfaceG += emiG * 5.0; surfaceB += emiB * 5.0;

            sampleR += throughputR * surfaceR; sampleG += throughputG * surfaceG; sampleB += throughputB * surfaceB;
            rayEscaped = true; 
            break; 

          } else {
            rayEscaped = true; 
            const gradient = 0.2 + Math.max(0, currentDir.y) * 0.5;
            sampleR += throughputR * gradient; sampleG += throughputG * gradient; sampleB += throughputB * (gradient + 0.15);
            break;
          }
        } 

        if (!rayEscaped) {
           const gradient = 0.2 + Math.max(0, currentDir.y) * 0.5;
           sampleR += throughputR * gradient; sampleG += throughputG * gradient; sampleB += throughputB * (gradient + 0.15);
        }

        pixelTotalR += sampleR; pixelTotalG += sampleG; pixelTotalB += sampleB;
      }

      pixelTotalR /= SAMPLES_PER_PIXEL; pixelTotalG /= SAMPLES_PER_PIXEL; pixelTotalB /= SAMPLES_PER_PIXEL;
      const aces = (v: number) => (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
      pixels[pixelIdx++] = Math.min(255, Math.max(0, Math.round(Math.pow(aces(pixelTotalR), 1 / 2.2) * 255)));
      pixels[pixelIdx++] = Math.min(255, Math.max(0, Math.round(Math.pow(aces(pixelTotalG), 1 / 2.2) * 255)));
      pixels[pixelIdx++] = Math.min(255, Math.max(0, Math.round(Math.pow(aces(pixelTotalB), 1 / 2.2) * 255)));
      pixels[pixelIdx++] = 255;
    }
  }
  self.postMessage({ buffer: pixels.buffer, startX, startY, width, height }, [pixels.buffer] as any);
};

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
  // HIGH-POLY FIX: Increased precision to 1e-8 so tiny triangles aren't ignored
  if (Math.abs(a) < 1e-8) return null; 
  const f = 1.0 / a, s = sub(ro, v0), u = f * dot(s, h); if (u < 0 || u > 1) return null;
  const q = cross(s, e1), v = f * dot(rd, q); if (v < 0 || u + v > 1) return null;
  const t = f * dot(e2, q); return t > 1e-5 ? t : null; 
}

function intersectTriangleBary(ro: Vector3, rd: Vector3, v0: Vector3, v1: Vector3, v2: Vector3): { t: number; u: number; v: number } | null {
  const e1 = sub(v1, v0), e2 = sub(v2, v0), h = cross(rd, e2), a = dot(e1, h);
  // HIGH-POLY FIX: Increased precision to 1e-8
  if (Math.abs(a) < 1e-8) return null; 
  const f = 1.0 / a, s = sub(ro, v0), u = f * dot(s, h); if (u < 0 || u > 1) return null;
  const q = cross(s, e1), v = f * dot(rd, q); if (v < 0 || u + v > 1) return null;
  const t = f * dot(e2, q); return t > 1e-5 ? { t, u, v } : null;
}