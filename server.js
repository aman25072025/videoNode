const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: '*' } });
const PORT = process.env.PORT || 5000;

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
    socketList[socket.id] = { userName, video: true, audio: true };

    // Respect requested role if provided
    let assignedRole = role;
    if (!role) {
      // Fallback to auto-assign
      assignedRole = !roomBroadcasters[roomId] ? 'broadcaster' : 'viewer';
    }

    if (assignedRole === 'broadcaster') {
      // Only allow one broadcaster per room
      if (!roomBroadcasters[roomId]) {
        roomBroadcasters[roomId] = socket.id;
        socket.emit('FE-assign-role', { role: 'broadcaster', broadcasterId: socket.id });
        log('info', 'Broadcaster assigned to room', { 
          socketId: socket.id, 
          userName, 
          roomId 
        });
      } else {
        // Room already has a broadcaster, force viewer role
        assignedRole = 'viewer';
        socket.emit('FE-assign-role', { role: 'viewer', broadcasterId: roomBroadcasters[roomId] });
        log('info', 'Broadcaster already exists, assigned as viewer', { 
          socketId: socket.id, 
          userName, 
          roomId,
          existingBroadcasterId: roomBroadcasters[roomId]
        });
      }
    }
    if (assignedRole === 'viewer') {
      // Track all viewers in the room
      const roomClients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
      const currentViewers = roomClients.filter(clientId => 
        socketList[clientId] && socketList[clientId].role === 'viewer'
      );

      log('info', 'Viewer joining room', { 
        socketId: socket.id, 
        userName, 
        roomId,
        broadcasterId: roomBroadcasters[roomId],
        currentViewerCount: currentViewers.length
      });

      socket.emit('FE-assign-role', { 
        role: 'viewer', 
        broadcasterId: roomBroadcasters[roomId],
        viewerCount: currentViewers.length
      });

      // Update the role in socketList
      socketList[socket.id].role = 'viewer';
    }

    // Set User List
    try {
      const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
      const users = [];
      clients.forEach((client) => {
        users.push({ userId: client, info: socketList[client] });
      });
      socket.broadcast.to(roomId).emit('FE-user-join', users);
    } catch (e) {
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
