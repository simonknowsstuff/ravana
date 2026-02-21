import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

// Serve static files from the dist folder (after build)
app.use(express.static(join(__dirname, 'dist')));

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Handle model upload events
  socket.on('model:upload', (data) => {
    console.log('Model uploaded:', data.fileName);
    // Broadcast to all other clients
    socket.broadcast.emit('model:uploaded', data);
  });

  // Handle model view events
  socket.on('model:view', (data) => {
    console.log('Model viewed:', data);
    io.emit('model:viewing', data);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Socket.io server ready for connections');
});
