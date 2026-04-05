import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import RaytracerWorker from './workers/raytracer.worker.ts?worker'



export default function WorkerNode() {
  const [status, setStatus] = useState<string>('Connecting to Swarm...');
  const [tilesProcessed, setTilesProcessed] = useState<number>(0);
  const [isConnected, setIsConnected] = useState(false);
  const [errorLog, setErrorLog] = useState<string>('');
  
  const socketRef = useRef<Socket | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const worker = new RaytracerWorker();
    workerRef.current = worker;

    const serverUrl = import.meta.env.VITE_WS_SERVER_URL || `http://${window.location.hostname}:3000`;
    
    let socket: Socket | null = null;
    // Delay initialization just enough to prevent React 18 Strict Mode double-render 
    // from instantly creating and destroying a websocket before it connects
    const initTimeout = setTimeout(() => {
      socket = io(serverUrl, {
        transports: ['websocket'],
        upgrade: false
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        setIsConnected(true);
        setStatus('Connected. Awaiting payload...');
        socket!.emit('register_worker');
      });

      socket.on('disconnect', () => {
        setIsConnected(false);
        setStatus('Lost connection to Swarm.');
      });

      socket.on('error', (err) => {
        setErrorLog(`Socket error: ${err}`);
      });

      socket.on('connect_error', (err) => {
        setErrorLog(`Connection error: ${err}`);
      });

      socket.on('assign_tile', (task, callback) => {
        if (!task.fileUrl) {
           if (callback) callback({ status: 'rejected', reason: 'No fileUrl provided' });
           return;
        }
        if (callback) callback({ status: 'accepted' });
        
        const fullUrl = task.fileUrl.startsWith('http') ? task.fileUrl : `${serverUrl}${task.fileUrl}`;
        
        setStatus(`Crunching tile [${task.startX}, ${task.startY}]...`);
        workerRef.current?.postMessage({
          type: 'render_tile',
          fileUrl: fullUrl,
          startX: task.startX, startY: task.startY, width: task.width, height: task.height,
          canvasWidth: task.canvasWidth, canvasHeight: task.canvasHeight,
          camera: task.camera, sunDir: task.sunDir, lights: task.lights,
        });
      });
    }, 50);

    workerRef.current.onmessage = (event) => {
      const { buffer, startX, startY, width, height } = event.data;
      if (socketRef.current) socketRef.current.emit('tile_finished', { buffer, startX, startY, width, height });
      setTilesProcessed((prev) => prev + 1);
      setStatus('Tile complete. Requesting next...');
    };

    workerRef.current.onerror = (error) => {
      setErrorLog(`Web Worker crashed: ${error.message}`);
      setStatus('ERROR: Web Worker crashed');
    };

    return () => {
      clearTimeout(initTimeout);
      if (socket) socket.disconnect();
      workerRef.current?.terminate();
    };
  }, []);

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6 text-center font-sans">
      <div className={`w-24 h-24 mb-8 rounded-full border-4 border-t-transparent animate-spin ${isConnected ? 'border-cyan-500' : 'border-slate-600'}`}></div>
      <h1 className="text-4xl font-bold text-white mb-3 tracking-tight">Shard Node</h1>
      <p className="text-cyan-400 font-mono text-lg mb-4 h-6">{status}</p>
      
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