/**
 * SHARD NODE WORKER
 * Goal: Mathematical Ray-Triangle Intersection via BVH Traversal
 */

// --- TYPES & INTERFACES ---
interface Vector3 {
  x: number;
  y: number;
  z: number;
}

interface WorkerPayload {
  positions: Float32Array;
  bvhBuffer: Float32Array;
  indices: Uint32Array;
  startX: number;
  startY: number;
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
  cameraPos: Vector3;
  viewMatrix: number[] | Float32Array;
  sunDir: Vector3;
}

// Memory Layout Constants for three-mesh-bvh
const BVH_NODE_SIZE = 10; 

self.onmessage = (event: MessageEvent<WorkerPayload>) => {
  const {
    positions,     
    bvhBuffer,     
    indices,       
    startX, startY, 
    width, height, 
    canvasWidth, canvasHeight,
    cameraPos,     
    viewMatrix,    
    sunDir         
  } = event.data;

  const pixels = new Uint8ClampedArray(width * height * 4);
  const stack = new Uint32Array(64); 
  let pixelIdx = 0;

  // --- THE MAIN RENDER LOOP ---
  for (let y = startY; y < startY + height; y++) {
    for (let x = startX; x < startX + width; x++) {
      
      const rd = getRayDirection(x, y, canvasWidth, canvasHeight, viewMatrix);
      
      let closestT = Infinity;
      let hitNormal: Vector3 = { x: 0, y: 0, z: 0 };

      // 2. BVH TRAVERSAL
      let stackPtr = 0;
      stack[stackPtr++] = 0; // Push root node index

      while (stackPtr > 0) {
        const nodeIdx = stack[--stackPtr];
        const base = nodeIdx * BVH_NODE_SIZE;

        if (!intersectBox(cameraPos, rd, bvhBuffer, base)) {
          continue; 
        }

        const isLeaf = bvhBuffer[base + 9] !== 0;

        if (isLeaf) {
          const offset = bvhBuffer[base + 7];
          const count = bvhBuffer[base + 8];

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
          stack[stackPtr++] = nodeIdx + 1; 
          stack[stackPtr++] = bvhBuffer[base + 6]; 
        }
      }

      // 3. SHADING THE PIXEL
      if (closestT < Infinity) {
        const diffuse = Math.max(0.2, dot(hitNormal, sunDir));
        pixels[pixelIdx++] = 180 * diffuse; // R
        pixels[pixelIdx++] = 180 * diffuse; // G
        pixels[pixelIdx++] = 220 * diffuse; // B 
        pixels[pixelIdx++] = 255;           // A
      } else {
        pixels[pixelIdx++] = 15; pixels[pixelIdx++] = 15; 
        pixels[pixelIdx++] = 25; pixels[pixelIdx++] = 255;
      }
    }
  }

  self.postMessage({ 
    buffer: pixels.buffer, 
    startX, startY, width, height 
  }, [pixels.buffer] as any);
};

// --- MATH HELPERS ---

function getRayDirection(x: number, y: number, w: number, h: number, matrix: number[] | Float32Array): Vector3 {
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