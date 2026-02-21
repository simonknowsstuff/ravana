/**
 * SHARD NODE WORKER (WITH TELEMETRY & FAILSAFES)
 */

interface Vector3 { x: number; y: number; z: number; }

interface WorkerPayload {
  positions: Float32Array;
  bvhBuffer: Float32Array;
  indices: Uint32Array;
  startX: number; startY: number; width: number; height: number;
  canvasWidth: number; canvasHeight: number;
  cameraPos?: Vector3; viewMatrix?: number[]; sunDir?: Vector3;
  // legacy/server support: camera object may be provided instead
  camera?: {
    cameraPos?: Vector3;
    viewMatrix?: number[];
    sunDir?: Vector3;
  };
}

const BVH_NODE_SIZE = 10; 

self.onmessage = (event: MessageEvent<WorkerPayload | any>) => {
  // support both flat payload and server-wrapped camera object
  let positions: Float32Array, bvhBuffer: Float32Array, indices: Uint32Array;
  let startX:number, startY:number, width:number, height:number, canvasWidth:number, canvasHeight:number;
  let cameraPos: Vector3 | undefined, viewMatrix: number[] | undefined, sunDir: Vector3 | undefined;

  // payload could include camera property
  if (event.data.camera) {
    ({ positions, bvhBuffer, indices, startX, startY, width, height, canvasWidth, canvasHeight } = event.data);
    ({ cameraPos, viewMatrix, sunDir } = event.data.camera);
  } else {
    ({ positions, bvhBuffer, indices, startX, startY, width, height, canvasWidth, canvasHeight, cameraPos, viewMatrix, sunDir } = event.data);
  }

  if (!viewMatrix) {
    console.warn('[Worker] viewMatrix missing, defaulting to identity');
    viewMatrix = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  }
  if (!cameraPos) {
    console.warn('[Worker] cameraPos missing, defaulting to origin');
    cameraPos = { x: 0, y: 0, z: 0 };
  }
  if (!sunDir) {
    console.warn('[Worker] sunDir missing, defaulting to [0,1,0]');
    sunDir = { x: 0, y: 1, z: 0 };
  }

  // --- 1. TELEMETRY LOGS ---
  // If you plug your phone into your laptop and open Chrome Inspect, you will see these.
  console.log(`[Worker] Started chunk [${startX}, ${startY}]`);
  console.log(`[Worker] Positions: ${positions.length} floats`);
  console.log(`[Worker] BVH Nodes: ${bvhBuffer.length / BVH_NODE_SIZE}`);
  console.log(`[Worker] Indices count: ${indices.length} (triangles = ${indices.length/3})`);
  console.log(`[Worker] Chunk dims w=${width} h=${height}`);
  
  if (bvhBuffer.length < 10) {
    console.error("[Worker] FATAL: BVH Buffer is empty or invalid!");
    return;
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  const stack = new Uint32Array(64); 
  let pixelIdx = 0;

  for (let y = startY; y < startY + height; y++) {
    console.log(`[Worker] starting row ${y}`);
    for (let x = startX; x < startX + width; x++) {
      
      const rd = getRayDirection(x, y, canvasWidth, canvasHeight, viewMatrix);
      // occasional log to track progress per row
      if ((x - startX) % 32 === 0) {
        console.log(`[Worker] pixel ${x},${y} rd=${rd.x.toFixed(2)},${rd.y.toFixed(2)},${rd.z.toFixed(2)}`);
      }
      let closestT = Infinity;
      let hitNormal: Vector3 = { x: 0, y: 0, z: 0 };

      let stackPtr = 0;
      stack[stackPtr++] = 0; 

      // --- 2. THE FAILSAFE ---
      let safetyCounter = 0; 

      while (stackPtr > 0) {
        // Emergency brake to prevent silent freezing
        if (safetyCounter++ > 10000) {
           console.error(`[Worker] INFINITE LOOP DETECTED at pixel [${x}, ${y}]! Aborting ray.`);
           break; 
        }

        if (stackPtr > stack.length) {
          console.error(`[Worker] STACK OVERFLOW at pixel [${x}, ${y}] ptr=${stackPtr} (max=${stack.length})`);
          break;
        }

        const nodeIdx = stack[--stackPtr];
        const base = nodeIdx * BVH_NODE_SIZE;
        console.log(`[Worker] visiting node ${nodeIdx} (base=${base}) for pixel [${x},${y}]`);

        if (!intersectBox(cameraPos, rd, bvhBuffer, base)) continue; 

        const isLeaf = bvhBuffer[base + 9] !== 0;

        if (isLeaf) {
          const offset = bvhBuffer[base + 7];
          const count = bvhBuffer[base + 8];
          console.log(`[Worker] leaf node ${nodeIdx} contains ${count} triangles at offset ${offset}`);

          // Secondary failsafe: If offset is NaN, the BVH is corrupt
          if (isNaN(offset) || isNaN(count)) {
             console.error("[Worker] Corrupt BVH Leaf detected!");
             break;
          }

          for (let i = offset; i < offset + count; i++) {
            const i3 = i * 3;
            const aIdx = indices[i3] * 3;
            const bIdx = indices[i3 + 1] * 3;
            const cIdx = indices[i3 + 2] * 3;

            const t = intersectTriangle(
              cameraPos, rd,
              { x: positions[aIdx], y: positions[aIdx + 1], z: positions[aIdx + 2] },
              { x: positions[bIdx], y: positions[bIdx + 1], z: positions[bIdx + 2] },
              { x: positions[cIdx], y: positions[cIdx + 1], z: positions[cIdx + 2] }
            );

            if (t !== null && t < closestT) {
              closestT = t;
              hitNormal = calculateNormal(positions, aIdx, bIdx, cIdx);
            }
          }
        } else {
          console.log(`[Worker] internal node ${nodeIdx}: pushing children ${nodeIdx+1} and ${bvhBuffer[base+6]}`);
          stack[stackPtr++] = nodeIdx + 1; 
          stack[stackPtr++] = bvhBuffer[base + 6]; 
        }
      }

      // --- SHADING ---
      if (closestT < Infinity) {
        const diffuse = Math.max(0.2, dot(hitNormal, sunDir));
        pixels[pixelIdx++] = 180 * diffuse; 
        pixels[pixelIdx++] = 180 * diffuse; 
        pixels[pixelIdx++] = 220 * diffuse; 
        pixels[pixelIdx++] = 255;           
      } else {
        pixels[pixelIdx++] = 15; pixels[pixelIdx++] = 15; 
        pixels[pixelIdx++] = 25; pixels[pixelIdx++] = 255;
      }
      // log final color occasionally
      if ((x - startX) % 64 === 0) {
        console.log(`[Worker] color for pixel ${x},${y} = [${pixels[pixelIdx-4]},${pixels[pixelIdx-3]},${pixels[pixelIdx-2]}]`);
      }
    }
  }

  console.log(`[Worker] Finished chunk [${startX}, ${startY}]`);
  self.postMessage({ buffer: pixels.buffer, startX, startY, width, height }, [pixels.buffer] as any);
};

// --- MATH HELPERS ---
function getRayDirection(x: number, y: number, w: number, h: number, matrix: number[]): Vector3 {
  const nx = (x / w) * 2 - 1;
  const ny = 1 - (y / h) * 2;
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