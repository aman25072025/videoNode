const express = require('express');
const cors = require('cors');
const app = express();

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

// Logging utility
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
    for (const roomId in roomBroadcasters) {
      if (roomBroadcasters[roomId] === socket.id) {
        delete roomBroadcasters[roomId];
      }
    }
    console.log('User disconnected!');
  });

  socket.on('BE-join-room', ({ roomId, userName, role }) => {
    log('info', 'User attempting to join room', { 
      socketId: socket.id, 
      userName, 
      requestedRole: role, 
      roomId 
    });

    socket.join(roomId);

    socketList[socket.id] = { 
      userName, 
      video: true, 
      audio: true,
      role: null,
      joinedAt: Date.now()
    };

    let assignedRole = role || (!roomBroadcasters[roomId] ? 'broadcaster' : 'viewer');

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
      const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
      const users = clients.map((client) => ({
        userId: client, 
        info: socketList[client]
      }));
      socket.broadcast.to(roomId).emit('FE-user-join', users);
    } catch (e) {
      log('error', 'Error broadcasting user join', {
        roomId,
        error: e.message
      });
      io.sockets.in(roomId).emit('FE-error-user-exist', { err: true });
    }
  });

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

  socket.on('BE-raise-hand', ({ roomId, userId, userName }) => {
    socket.to(roomId).emit('FE-raised-hand', { userId, userName });
  });
  
  socket.on('BE-approve-speaker', ({ roomId, userId }) => {
    io.to(userId).emit('FE-speaker-approved');
  });

  socket.on('BE-stop-speaking', ({ roomId, userId }) => {
    // Tell the viewer to stop (turn off their mic/cam)
    io.to(userId).emit('FE-viewer-stop-speaking');
  
    // Tell the broadcaster to update their approved speakers list
    const broadcasterId = roomBroadcasters[roomId];
    if (broadcasterId) {
      io.to(broadcasterId).emit('FE-viewer-stopped', { userId });
    }
  });

  socket.on('BE-decline-speaker', ({ roomId, userId }) => {
    io.to(userId).emit('FE-speaker-declined');
  });

});

http.listen(PORT, () => {
  console.log('Signaling server listening on port', PORT);
});
