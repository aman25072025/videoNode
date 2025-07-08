// Initialize Express server and Socket.IO
const express = require('express');
const cors = require('cors');
const app = express();

// Configure CORS to allow connections from specific origins
app.use(cors({
  origin: [
    'http://localhost:3000', 
    'https://aman25072025.github.io', 
    'https://videonode.onrender.com'
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Create HTTP server and Socket.IO instance
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: [
      'http://localhost:3000', 
      'https://aman25072025.github.io', 
      'https://videonode.onrender.com'
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
  }
});

// Server configuration
const PORT = process.env.PORT || 5000;
const os = require('os');

// Structured logging utility
const log = (level, message, metadata = {}) => {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({
    timestamp,
    level,
    message,
    ...metadata
  }));
};

// Track connected users and room broadcasters
let socketList = {}; // Maps socket.id to user info
let roomBroadcasters = {}; // Maps roomId to broadcaster socket.id

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is healthy' });
});

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log(`New User connected: ${socket.id}`);

  // Handle user disconnection
  socket.on('disconnect', () => {
    // Remove user from tracking
    delete socketList[socket.id];
    // Remove broadcaster status if they were one
    for (const roomId in roomBroadcasters) {
      if (roomBroadcasters[roomId] === socket.id) {
        delete roomBroadcasters[roomId];
      }
    }
    console.log('User disconnected!');
  });

  // Handle room joining
  socket.on('BE-join-room', ({ roomId, userName, role }) => {
    // Log room join attempt
    log('info', 'User attempting to join room', { 
      socketId: socket.id, 
      userName, 
      requestedRole: role, 
      roomId 
    });

    // Join the specified room
    socket.join(roomId);

    // Store user information
    socketList[socket.id] = { 
      userName, 
      video: true, 
      audio: true,
      role: null,
      joinedAt: Date.now()
    };

    // Assign role (broadcaster or viewer)
    let assignedRole = role || (!roomBroadcasters[roomId] ? 'broadcaster' : 'viewer');

    if (assignedRole === 'broadcaster') {
      // Handle broadcaster assignment
      if (!roomBroadcasters[roomId]) {
        roomBroadcasters[roomId] = socket.id;
        socketList[socket.id].role = 'broadcaster';
        socket.emit('FE-assign-role', { 
          role: 'broadcaster', 
          broadcasterId: socket.id 
        });
        log('info', 'Broadcaster assigned to room', { 
          socketId: socket.id, 
          userName, 
          roomId 
        });
      } else {
        // Room already has a broadcaster, assign as viewer
        assignedRole = 'viewer';
        socketList[socket.id].role = 'viewer';
        socket.emit('FE-assign-role', { 
          role: 'viewer', 
          broadcasterId: roomBroadcasters[roomId] 
        });
        log('info', 'Broadcaster already exists, assigned as viewer', { 
          socketId: socket.id, 
          userName, 
          roomId,
          existingBroadcasterId: roomBroadcasters[roomId]
        });
      }
    }

    if (assignedRole === 'viewer') {
      // Handle viewer joining
      socketList[socket.id].role = 'viewer';
      const roomClients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
      const currentViewers = roomClients.filter(clientId => 
        socketList[clientId] && socketList[clientId].role === 'viewer'
      );

      log('info', 'Viewer joining room', { 
        socketId: socket.id, 
        userName, 
        roomId,
        broadcasterId: roomBroadcasters[roomId],
        currentViewerCount: currentViewers.length + 1
      });

      socket.emit('FE-assign-role', { 
        role: 'viewer', 
        broadcasterId: roomBroadcasters[roomId],
        viewerCount: currentViewers.length + 1
      });
    }

    try {
      // Notify other users in the room about new user
      const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
      const users = clients.map((client) => ({
        userId: client, 
        info: socketList[client]
      }));
      socket.broadcast.to(roomId).emit('FE-user-join', users);
    } catch (e) {
      // Handle error during user join notification
      log('error', 'Error broadcasting user join', {
        roomId,
        error: e.message
      });
      io.sockets.in(roomId).emit('FE-error-user-exist', { err: true });
    }
  });

  // Handle peer-to-peer call initiation
  socket.on('BE-call-user', ({ userToCall, from, signal }) => {
    log('info', 'Initiating call', { 
      fromSocketId: from, 
      toSocketId: userToCall 
    });
    io.to(userToCall).emit('FE-receive-call', {
      signal,
      from,
      info: socketList[socket.id],
    });
  });

  // Handle call acceptance
  socket.on('BE-accept-call', ({ signal, to }) => {
    io.to(to).emit('FE-call-accepted', {
      signal,
      answerId: socket.id,
    });
  });

  // Handle room leaving
  socket.on('BE-leave-room', ({ roomId, leaver }) => {
    log('info', 'User leaving room', { 
      socketId: socket.id, 
      userName: socketList[socket.id]?.userName, 
      roomId 
    });

    // Clean up user data
    delete socketList[socket.id];
    // Remove broadcaster status if they were one
    if (roomBroadcasters[roomId] === socket.id) {
      log('warn', 'Broadcaster left room', { roomId });
      delete roomBroadcasters[roomId];
    }

    // Notify other users in the room
    socket.broadcast.to(roomId).emit('FE-user-leave', { userId: socket.id });
    socket.leave(roomId);
  });

  // Handle hand-raising
  socket.on('BE-raise-hand', ({ roomId, userId, userName }) => {
    socket.to(roomId).emit('FE-raised-hand', { userId, userName });
  });
  
  // Handle speaker approval
  socket.on('BE-approve-speaker', ({ roomId, userId }) => {
    io.to(userId).emit('FE-speaker-approved');
  });

  // Handle speaker stop
  socket.on('BE-stop-speaking', ({ roomId, userId }) => {
    // Tell the viewer to stop broadcasting
    io.to(userId).emit('FE-viewer-stop-speaking');
  
    // Notify broadcaster to update approved speakers list
    const broadcasterId = roomBroadcasters[roomId];
    if (broadcasterId) {
      io.to(broadcasterId).emit('FE-viewer-stopped', { userId });
    }
  });

  socket.on('BE-decline-speaker', ({ roomId, userId }) => {
    io.to(userId).emit('FE-decline-speaker');
  });

});

http.listen(PORT, () => {
  console.log('Signaling server listening on port', PORT);
});


 /*BE and FE in the code stand for "Backend" and "Frontend" respectively. This is a common naming convention used to distinguish between server-side and client-side events in web applications.
 Here's how they're used in the code:
 BE- (Backend) events are sent from the frontend to the backend/server:
 BE-join-room: Frontend requests to join a room
 BE-call-user: Frontend requests to call another user
 BE-accept-call: Frontend accepts a call
 BE-leave-room: Frontend requests to leave a room
 BE-raise-hand: Frontend raises hand
 BE-approve-speaker: Frontend approves a speaker
 BE-stop-speaking: Frontend requests to stop speaking
 BE-decline-speaker: Frontend declines a speaker
 FE- (Frontend) events are sent from the backend to the frontend:
 FE-assign-role: Server assigns a role to the user
 FE-receive-call: Server notifies about incoming call
 FE-call-accepted: Server confirms call acceptance
 FE-user-join: Server notifies about new user joining
 FE-user-leave: Server notifies about user leaving
 FE-raised-hand: Server notifies about hand raised
 FE-speaker-approved: Server approves speaker
 FE-viewer-stop-speaking: Server tells viewer to stop
 FE-decline-speaker: Server notifies about speaker decline */