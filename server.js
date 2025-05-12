const express = require('express');
const app = express();
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
const PORT = process.env.PORT || 5000;
const os = require('os');

// Enhanced logging utility
const log = (level, message, metadata = {}) => {
    const timestamp = new Date().toISOString();
    console.log(JSON.stringify({
        timestamp,
        level,
        message,
        ...metadata
    }));
};

let socketList = {};
let roomBroadcasters = {}; // roomId -> broadcaster socket.id

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is healthy' });
});

io.on('connection', (socket) => {
  console.log(`New User connected: ${socket.id}`);

  socket.on('disconnect', () => {
    delete socketList[socket.id];
    // Remove broadcaster if leaving
    for (const roomId in roomBroadcasters) {
      if (roomBroadcasters[roomId] === socket.id) {
        delete roomBroadcasters[roomId];
      }
    }
    console.log('User disconnected!');
  });

  // Join Room
  socket.on('BE-join-room', ({ roomId, userName, role }) => {
    log('info', 'User attempting to join room', { 
      socketId: socket.id, 
      userName, 
      requestedRole: role, 
      roomId 
    });

    socket.join(roomId);
    
    // Initialize user in socketList with more detailed tracking
    socketList[socket.id] = { 
      userName, 
      video: true, 
      audio: true,
      role: null,  // Will be set dynamically
      joinedAt: Date.now()
    };

    // Determine role assignment
    let assignedRole = role || (!roomBroadcasters[roomId] ? 'broadcaster' : 'viewer');

    // Broadcaster logic
    if (assignedRole === 'broadcaster') {
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
        // Fallback to viewer if broadcaster exists
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

    // Viewer logic
    if (assignedRole === 'viewer') {
      socketList[socket.id].role = 'viewer';
      
      // Get all clients in the room
      const roomClients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
      
      // Count current viewers
      const currentViewers = roomClients.filter(clientId => 
        socketList[clientId] && socketList[clientId].role === 'viewer'
      );

      log('info', 'Viewer joining room', { 
        socketId: socket.id, 
        userName, 
        roomId,
        broadcasterId: roomBroadcasters[roomId],
        currentViewerCount: currentViewers.length + 1  // Include current viewer
      });

      socket.emit('FE-assign-role', { 
        role: 'viewer', 
        broadcasterId: roomBroadcasters[roomId],
        viewerCount: currentViewers.length + 1
      });
    }

    // Broadcast user list to room
    try {
      const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
      const users = clients.map((client) => ({
        userId: client, 
        info: socketList[client]
      }));
      
      // Broadcast to all clients in the room except the new user
      socket.broadcast.to(roomId).emit('FE-user-join', users);
    } catch (e) {
      log('error', 'Error broadcasting user join', {
        roomId,
        error: e.message
      });
      io.sockets.in(roomId).emit('FE-error-user-exist', { err: true });
    }
  });

  // Signaling events
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

  socket.on('BE-accept-call', ({ signal, to }) => {
    io.to(to).emit('FE-call-accepted', {
      signal,
      answerId: socket.id,
    });
  });

  socket.on('BE-leave-room', ({ roomId, leaver }) => {
    log('info', 'User leaving room', { 
      socketId: socket.id, 
      userName: socketList[socket.id]?.userName, 
      roomId 
    });
    
    delete socketList[socket.id];
    if (roomBroadcasters[roomId] === socket.id) {
      log('warn', 'Broadcaster left room', { roomId });
      delete roomBroadcasters[roomId];
    }
    socket.broadcast.to(roomId).emit('FE-user-leave', { userId: socket.id });
    socket.leave(roomId);
  });
});

http.listen(PORT, () => {
  console.log('Signaling server listening on port', PORT);
});
