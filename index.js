const http = require('http');
const path = require('path');
const express = require('express');
const fs = require('fs');
const { Transform } = require('stream');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);

// Configuration
const PORT = process.env.PORT || 8080;
const CAMERAS = {
  1: '/dev/video0',
  2: '/dev/video1',
  3: '/dev/video2',
};

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Serve static studio files
app.use(express.static(__dirname));

// Health check endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    availableCameras: Object.keys(CAMERAS),
    endpoints: [
      '/stream/camera_<number>',
      '/stream?camera_number=<number>',
      '/api/ice-servers',
      '/ws'
    ]
  });
});

// Production WebRTC ICE configuration (Google STUN + custom TURN support)
app.get('/api/ice-servers', (req, res) => {
  const googleStunServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ];

  const iceServers = [...googleStunServers];

  // If custom TURN credentials provided via environment
  if (process.env.TURN_URL) {
    iceServers.unshift({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_PASSWORD || ''
    });
  }

  res.json({ iceServers });
});

// Stream endpoints
app.get('/stream/camera_:number', (req, res) => {
  const cameraNumber = parseInt(req.params.number);
  streamCamera(cameraNumber, req, res);
});

app.get('/stream', (req, res) => {
  const cameraNumber = parseInt(req.query.camera_number || '1');
  streamCamera(cameraNumber, req, res);
});

/**
 * JPEG Frame Parser Transform Stream
 * Extracts individual JPEG frames from raw camera data
 */
class JPEGFrameParser extends Transform {
  constructor() {
    super();
    this.buffer = Buffer.alloc(0);
    this.SOI = Buffer.from([0xFF, 0xD8]); // Start of Image marker
    this.EOI = Buffer.from([0xFF, 0xD9]); // End of Image marker
  }

  _transform(chunk, encoding, callback) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    
    // Find and extract complete JPEG frames
    let startIndex = this.buffer.indexOf(this.SOI);
    
    while (startIndex !== -1) {
      // Look for end of JPEG after the start
      const endIndex = this.buffer.indexOf(this.EOI, startIndex + 2);
      
      if (endIndex !== -1) {
        // Extract complete JPEG frame
        const frame = this.buffer.slice(startIndex, endIndex + 2);
        this.push(frame);
        
        // Remove processed frame from buffer
        this.buffer = this.buffer.slice(endIndex + 2);
        
        // Look for next frame
        startIndex = this.buffer.indexOf(this.SOI);
      } else {
        // Incomplete frame, wait for more data
        break;
      }
    }
    
    // Keep partial frame in buffer
    if (startIndex === -1 && this.buffer.length > 0) {
      // No SOI found, clear old data but keep last bit in case SOI is split
      const keepSize = Math.min(this.buffer.length, 1024);
      this.buffer = this.buffer.slice(-keepSize);
    }
    
    callback();
  }
}

/**
 * Stream camera directly from device
 */
function streamCamera(cameraNumber, req, res) {
  const devicePath = CAMERAS[cameraNumber];
  
  if (!devicePath) {
    return res.status(404).json({ 
      error: 'Camera not found',
      availableCameras: Object.keys(CAMERAS)
    });
  }

  // Check if device exists
  if (!fs.existsSync(devicePath)) {
    return res.status(404).json({ 
      error: `Camera device not found: ${devicePath}`,
      message: 'Make sure the camera is connected and accessible'
    });
  }

  // Set MJPEG stream headers
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Connection': 'close'
  });

  // Open camera device as readable stream
  const cameraStream = fs.createReadStream(devicePath, {
    highWaterMark: 64 * 1024 // 64KB buffer
  });

  // Parse JPEG frames
  const frameParser = new JPEGFrameParser();
  
  let frameCount = 0;

  // Handle parsed frames
  frameParser.on('data', (frame) => {
    try {
      frameCount++;
      // Send frame with MJPEG boundary
      res.write('--myboundary\r\n');
      res.write('Content-Type: image/jpeg\r\n');
      res.write(`Content-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write('\r\n');
    } catch (err) {
      // Client disconnected
      cameraStream.destroy();
      frameParser.destroy();
    }
  });

  // Pipe camera data through frame parser
  cameraStream.pipe(frameParser);

  // Error handling
  cameraStream.on('error', (err) => {
    console.error(`Error reading from camera ${cameraNumber}:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Failed to read from camera',
        message: err.message 
      });
    }
  });

  frameParser.on('error', (err) => {
    console.error(`Frame parser error for camera ${cameraNumber}:`, err.message);
  });

  // Clean up when client disconnects
  req.on('close', () => {
    console.log(`Client disconnected from camera ${cameraNumber} (sent ${frameCount} frames)`);
    cameraStream.destroy();
    frameParser.destroy();
  });

  // Log successful connection
  console.log(`Client connected to camera ${cameraNumber}`);
}

// WebSocket Signaling & RPC Server
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // roomId -> Set of ws clients

// Keep-alive ping interval to prevent NAT timeout
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

wss.on('connection', (ws) => {
  let currentRoom = 'vyz-studio';
  let clientPeerId = null;

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.roomId) {
        currentRoom = msg.roomId;
      }
      if (msg.fromPeerId) {
        clientPeerId = msg.fromPeerId;
        ws.peerId = clientPeerId;
      }

      if (!rooms.has(currentRoom)) {
        rooms.set(currentRoom, new Set());
      }
      rooms.get(currentRoom).add(ws);

      // Broadcast message to other peers in the room
      const roomClients = rooms.get(currentRoom);
      if (roomClients) {
        roomClients.forEach((client) => {
          if (client !== ws && client.readyState === 1 /* OPEN */) {
            try {
              client.send(JSON.stringify(msg));
            } catch (sendErr) {
              console.warn('[WebSocket] Error forwarding signal to peer:', sendErr.message);
            }
          }
        });
      }
    } catch (err) {
      console.error('[WebSocket] Failed to parse message:', err.message);
    }
  });

  ws.on('close', () => {
    if (rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(ws);
      
      // Notify other peers in room that this peer left
      if (clientPeerId) {
        const leaveMsg = JSON.stringify({
          type: 'PEER_LEFT',
          fromPeerId: clientPeerId,
          roomId: currentRoom
        });
        rooms.get(currentRoom).forEach((client) => {
          if (client.readyState === 1) {
            try {
              client.send(leaveMsg);
            } catch (e) {}
          }
        });
      }

      if (rooms.get(currentRoom).size === 0) {
        rooms.delete(currentRoom);
      }
    }
  });

  ws.on('error', (err) => {
    console.warn(`[WebSocket] Client socket error (${clientPeerId || 'unannounced'}):`, err.message);
  });
});

// Process safety error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.warn('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
});

// Start server
server.listen(PORT, () => {
  console.log(`VYZ Studio running on http://localhost:${PORT}`);
  console.log(`WebSocket signaling available at ws://localhost:${PORT}/ws`);
  console.log(`Available cameras:`, Object.keys(CAMERAS));
  Object.keys(CAMERAS).forEach(num => {
    console.log(`  - http://localhost:${PORT}/stream/camera_${num}`);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  process.exit(0);
});
