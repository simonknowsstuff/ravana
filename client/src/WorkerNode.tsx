import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

// Define the shape of our geometry cache
interface GeometryCache {
  positions: Float32Array;
  bvhBuffer: Float32Array;
  indices: Uint32Array;
}

export default function WorkerNode() {
  const [status, setStatus] = useState<string>('Connecting to Swarm...');
  const [tilesProcessed, setTilesProcessed] = useState<number>(0);
  
  const socketRef = useRef<Socket | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const geoCacheRef = useRef<GeometryCache | null>(null);

  useEffect(() => {
    // 1. INITIALIZE THE PHYSICS ENGINE (Web Worker)
    // Using Vite's standard syntax for importing web workers
    workerRef.current = new Worker(new URL('./raytracer.worker.ts', import.meta.url), { 
      type: 'module' 
    });

    // 2. CONNECT TO THE TRAFFIC COP (Node.js Server)
    // Replace with your actual local IP address running the server
    const socket = io('http://192.168.1.X:3000'); 
    socketRef.current = socket;

    socket.on('connect', () => {
      setStatus('Connected. Awaiting Orders.');
      socket.emit('register_worker');
    });

    // 3. RECEIVE THE HEAVY PAYLOAD (Once per render)
    socket.on('sync_geometry', (payload) => {
      setStatus('Downloading Geometry Payload...');
      
      // Socket.io sends binary data as raw ArrayBuffers. 
      // We MUST wrap them back into their Typed Arrays before the Worker can use them.
      geoCacheRef.current = {
        positions: new Float32Array(payload.positions),
        bvhBuffer: new Float32Array(payload.bvhBuffer),
        indices: new Uint32Array(payload.indices)
      };
      
      setStatus('Payload Cached. Ready to crunch.');
    });

    // 4. RECEIVE A MICRO-CHUNK TASK
    socket.on('assign_tile', (task) => {
      if (!geoCacheRef.current) {
        console.error("Received task, but have no geometry cache!");
        // We will address this trap below
        return;
      }

      setStatus(`Crunching Chunk [${task.startX}, ${task.startY}]...`);

      // Combine the tiny task coordinates with our heavy geometry cache
      // and send it all into the isolated Worker thread
      workerRef.current?.postMessage({
        ...task,
        positions: geoCacheRef.current.positions,
        bvhBuffer: geoCacheRef.current.bvhBuffer,
        indices: geoCacheRef.current.indices
      });
    });

    // 5. RECEIVE COMPLETED PIXELS FROM THE WORKER
    workerRef.current.onmessage = (event) => {
      const { buffer, startX, startY, width, height } = event.data;
      
      // Blast the raw pixel buffer straight back to the server
      socket.emit('tile_finished', {
        buffer,
        startX,
        startY,
        width,
        height
      });

      setTilesProcessed((prev) => prev + 1);
      setStatus('Chunk complete. Requesting next...');
    };

    // Cleanup on unmount
    return () => {
      socket.disconnect();
      workerRef.current?.terminate();
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6 text-center">
      <div className="w-24 h-24 mb-8 rounded-full border-4 border-purple-500 border-t-transparent animate-spin"></div>
      
      <h1 className="text-3xl font-bold text-white mb-2">Shard Node</h1>
      <p className="text-purple-400 font-mono text-xl mb-8">{status}</p>
      
      <div className="bg-slate-800 rounded-xl p-6 w-full max-w-sm border border-slate-700">
        <h2 className="text-slate-400 text-sm uppercase tracking-wider mb-2">My Contribution</h2>
        <p className="text-5xl font-black text-white">{tilesProcessed} <span className="text-lg text-slate-500 font-normal">tiles</span></p>
      </div>
    </div>
  );
}