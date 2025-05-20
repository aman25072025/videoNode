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

// Logging utility
const log = (level, message, metadata = {}) => {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, level, message, ...metadata }));
};

let socketList = {};
let roomBroadcasters = {}; // roomId -> Set of broadcaster socket IDs

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is healthy' });
});

io.on('connection', (socket) => {
  console.log(`New User connected: ${socket.id}`);

  socket.on('disconnect', () => {
    // Remove from socket list
    delete socketList[socket.id];

    // Remove broadcaster if leaving
    for (const roomId in roomBroadcasters) {
      roomBroadcasters[roomId].delete(socket.id);
      if (roomBroadcasters[roomId].size === 0) {
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

    // Assign role
    let assignedRole = role || 'viewer';

    if (assignedRole === 'broadcaster') {
      if (!roomBroadcasters[roomId]) {
        roomBroadcasters[roomId] = new Set();
      }

      roomBroadcasters[roomId].add(socket.id);
      socketList[socket.id].role = 'broadcaster';

      socket.emit('FE-assign-role', {
        role: 'broadcaster',
        broadcasterIds: Array.from(roomBroadcasters[roomId])
      });

      log('info', 'Broadcaster joined room', {
        socketId: socket.id,
        userName,
        roomId,
        totalBroadcasters: roomBroadcasters[roomId].size
      });
    }

    if (assignedRole === 'viewer') {
      socketList[socket.id].role = 'viewer';

      const roomClients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
      const currentViewers = roomClients.filter(clientId =>
        socketList[clientId] && socketList[clientId].role === 'viewer'
      );

      socket.emit('FE-assign-role', {
        role: 'viewer',
        broadcasterIds: Array.from(roomBroadcasters[roomId] || []),
        viewerCount: currentViewers.length + 1
      });

      log('info', 'Viewer joining room', {
        socketId: socket.id,
        userName,
        roomId,
        viewerCount: currentViewers.length + 1
      });
    }

    // Broadcast user list
    try {
      const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
      const users = clients.map(client => ({
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

  // Signaling handlers
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

    if (roomBroadcasters[roomId]) {
      roomBroadcasters[roomId].delete(socket.id);
      if (roomBroadcasters[roomId].size === 0) {
        delete roomBroadcasters[roomId];
      }
    }

    socket.broadcast.to(roomId).emit('FE-user-leave', { userId: socket.id });
    socket.leave(roomId);
  });
});

http.listen(PORT, () => {
  console.log('Signaling server listening on port', PORT);
});
