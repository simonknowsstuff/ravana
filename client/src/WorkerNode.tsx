import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

interface GeometryCache {
  positions: Float32Array;
  indices: Uint32Array;
  bvhBuffer: Float32Array;
}

export default function WorkerNode() {
  const [status, setStatus] = useState<string>('Connecting to Swarm...');
  const [tilesProcessed, setTilesProcessed] = useState<number>(0);
  const [isConnected, setIsConnected] = useState(false);
  const [errorLog, setErrorLog] = useState<string>(''); // Added for debugging
  
  const socketRef = useRef<Socket | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const geoCacheRef = useRef<GeometryCache | null>(null);
  
  // THE WAITING ROOM: Holds a task if it arrives before the geometry
  const pendingTaskRef = useRef<any>(null);

  useEffect(() => {
    workerRef.current = new Worker(new URL('./raytracer.worker.ts', import.meta.url), { 
      type: 'module' 
    });

    const serverUrl = import.meta.env.VITE_WS_SERVER_URL || `http://${window.location.hostname}:3000`;
    const socket = io(serverUrl,{
        transports:['websocket']
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      setStatus('Connected. Awaiting payload...');
      socket.emit('register_worker');
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      setStatus('Lost connection to Swarm.');
    });

    // 3. THE UNPACKER
    socket.on('sync_geometry', (payload) => {
      try {
        setStatus('Unpacking Geometry...');
        const { metadata, buffer } = payload;
        
        // Safety check: Is the buffer actually an ArrayBuffer?
        // Socket.io sometimes wraps binary in a Buffer object on the wire
        const rawBuffer = buffer instanceof ArrayBuffer ? buffer : new Uint8Array(buffer).buffer;
        
        const meshMeta = metadata.geometry.meshes[0];
        if (!meshMeta) throw new Error("Metadata missing meshes array");

        const positionsBuffer = rawBuffer.slice(meshMeta.positionsOffset, meshMeta.positionsOffset + meshMeta.positionsLength);
        const bvhBufferSliced = rawBuffer.slice(meshMeta.bvhOffset, meshMeta.bvhOffset + meshMeta.bvhLength);
        
        let indicesBuffer = new ArrayBuffer(0);
        if (meshMeta.indicesLength > 0) {
          indicesBuffer = rawBuffer.slice(meshMeta.indicesOffset, meshMeta.indicesOffset + meshMeta.indicesLength);
        }

        geoCacheRef.current = {
          positions: new Float32Array(positionsBuffer),
          bvhBuffer: new Float32Array(bvhBufferSliced),
          indices: new Uint32Array(indicesBuffer)
        };
        
        setStatus('Geometry Cached.');
        
        // RACE CONDITION RESOLVER: Did a task arrive while we were unpacking?
        if (pendingTaskRef.current) {
          setStatus(`Crunching queued tile [${pendingTaskRef.current.startX}, ${pendingTaskRef.current.startY}]...`);
          workerRef.current?.postMessage({
            ...pendingTaskRef.current,
            positions: geoCacheRef.current.positions,
            bvhBuffer: geoCacheRef.current.bvhBuffer,
            indices: geoCacheRef.current.indices
          });
          pendingTaskRef.current = null; // Clear the waiting room
        }

      } catch (err: any) {
        console.error("Unpack error:", err);
        setErrorLog(`Unpack Error: ${err.message}`);
        setStatus('Error during unpacking.');
      }
    });

    // 4. RECEIVE A MICRO-CHUNK TASK
    socket.on('assign_tile', (task) => {
      if (!geoCacheRef.current) {
        console.warn("Race condition: Task arrived before geometry. Queuing it.");
        setStatus('Task arrived early. Holding...');
        // Put the task in the waiting room
        pendingTaskRef.current = task;
        return;
      }

      setStatus(`Crunching tile [${task.startX}, ${task.startY}]...`);

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
      
      socket.emit('tile_finished', {
        buffer,
        startX,
        startY,
        width,
        height
      });

      setTilesProcessed((prev) => prev + 1);
      setStatus('Tile complete. Requesting next...');
    };

    return () => {
      socket.disconnect();
      workerRef.current?.terminate();
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6 text-center font-sans">
      <div className={`w-24 h-24 mb-8 rounded-full border-4 border-t-transparent animate-spin ${isConnected ? 'border-cyan-500' : 'border-slate-600'}`}></div>
      
      <h1 className="text-4xl font-bold text-white mb-3 tracking-tight">Shard Node</h1>
      <p className="text-cyan-400 font-mono text-lg mb-4 h-6">{status}</p>
      
      {/* Dynamic Error Log Output */}
      {errorLog && (
        <p className="text-red-400 font-mono text-xs mb-6 max-w-sm bg-red-900/30 p-2 rounded border border-red-700">
          {errorLog}
        </p>
      )}
      
      <div className="bg-slate-800 rounded-2xl p-8 w-full max-w-sm border border-slate-700 shadow-xl relative overflow-hidden mt-4">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-cyan-500 via-purple-500 to-cyan-500 opacity-50"></div>
        
        <h2 className="text-slate-400 text-xs font-bold uppercase tracking-widest mb-3">Compute Contribution</h2>
        <div className="flex items-baseline justify-center space-x-2">
          <p className="text-7xl font-black text-white">{tilesProcessed}</p>
          <span className="text-xl text-slate-500 font-medium">tiles</span>
        </div>
      </div>

      <div className="mt-12 flex items-center space-x-2 opacity-50">
        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
        <span className="text-slate-400 text-sm font-mono">{isConnected ? 'Uplink Established' : 'Offline'}</span>
      </div>
    </div>
  );
}