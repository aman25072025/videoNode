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

// Room management structure
const rooms = {};

const createRoom = (roomId) => {
  rooms[roomId] = {
    broadcaster: null,
    viewers: new Map(),      // socketId -> {socketId, userData, isAuthorized}
    pendingViewers: new Map(), // socketId -> {socketId, userData}
    raisedHands: new Map(),   // socketId -> {socketId, userData}
    isLocked: false,
    createdAt: Date.now()
  };
};

// Helper function to get user info
const getUserInfo = (socketId) => {
  return {
    socketId,
    userName: `User-${socketId.substring(0, 5)}`,
    joinedAt: Date.now()
  };
};

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is healthy' });
});

io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on('disconnect', () => {
    // Clean up from all rooms
    Object.keys(rooms).forEach(roomId => {
      const room = rooms[roomId];
      if (room.broadcaster === socket.id) {
        // Broadcaster left - notify all and clean up
        io.to(roomId).emit('FE-broadcaster-left');
        delete rooms[roomId];
      } else {
        // Viewer left
        if (room.viewers.has(socket.id)) {
          room.viewers.delete(socket.id);
          io.to(roomId).emit('FE-viewer-left', { userId: socket.id });
        }
        room.pendingViewers.delete(socket.id);
        room.raisedHands.delete(socket.id);
      }
    });
    console.log(`User disconnected: ${socket.id}`);
  });

  socket.on('BE-join-room', ({ roomId, userName, role }) => {
    if (!rooms[roomId]) {
      createRoom(roomId);
    }
    const room = rooms[roomId];

    socket.join(roomId);
    const userData = { socketId: socket.id, userName, joinedAt: Date.now() };

    // Handle broadcaster join
    if (role === 'broadcaster' || (!room.broadcaster && role !== 'viewer')) {
      if (!room.broadcaster) {
        room.broadcaster = socket.id;
        room.isLocked = false; // Reset lock state when new broadcaster joins
        
        socket.emit('FE-assign-role', { 
          role: 'broadcaster',
          roomState: {
            isLocked: room.isLocked,
            viewers: Array.from(room.viewers.values()),
            pendingViewers: Array.from(room.pendingViewers.values()),
            raisedHands: Array.from(room.raisedHands.values())
          }
        });
        console.log(`Broadcaster ${socket.id} joined room ${roomId}`);
        return;
      } else {
        // If broadcaster exists, force viewer role
        role = 'viewer';
      }
    }

    // Handle viewer join
    if (role === 'viewer') {
      if (room.isLocked) {
        // Room is locked - add to pending
        room.pendingViewers.set(socket.id, userData);
        socket.emit('FE-pending-approval', { 
          broadcasterId: room.broadcaster,
          userName: rooms[roomId].broadcaster.userName
        });
        
        // Notify broadcaster
        io.to(room.broadcaster).emit('FE-new-pending-viewer', {
          user: userData
        });
        console.log(`Viewer ${socket.id} pending approval in room ${roomId}`);
      } else {
        // Auto-approve if room not locked
        room.viewers.set(socket.id, { ...userData, isAuthorized: true });
        socket.emit('FE-assign-role', { 
          role: 'viewer',
          isAuthorized: true,
          broadcasterId: room.broadcaster
        });
        console.log(`Viewer ${socket.id} auto-approved in room ${roomId}`);
      }
    }
  });

  // Broadcaster controls
  socket.on('BE-toggle-room-lock', ({ roomId, lockState }) => {
    if (rooms[roomId]?.broadcaster === socket.id) {
      rooms[roomId].isLocked = lockState;
      io.to(roomId).emit('FE-room-lock-updated', { isLocked: lockState });
      console.log(`Room ${roomId} lock state: ${lockState}`);
    }
  });

  socket.on('BE-approve-viewer', ({ roomId, userId, approve }) => {
    const room = rooms[roomId];
    if (room?.broadcaster === socket.id && room.pendingViewers.has(userId)) {
      const userData = room.pendingViewers.get(userId);
      room.pendingViewers.delete(userId);

      if (approve) {
        room.viewers.set(userId, { ...userData, isAuthorized: true });
        io.to(userId).emit('FE-viewer-approved');
        console.log(`Viewer ${userId} approved in room ${roomId}`);
      } else {
        io.to(userId).emit('FE-viewer-rejected');
        console.log(`Viewer ${userId} rejected in room ${roomId}`);
      }
    }
  });

  // Hand raising
  socket.on('BE-raise-hand', ({ roomId }) => {
    const room = rooms[roomId];
    if (room && room.viewers.has(socket.id)) {
      const userData = room.viewers.get(socket.id);
      room.raisedHands.set(socket.id, userData);
      io.to(room.broadcaster).emit('FE-hand-raised', {
        user: userData
      });
      console.log(`Viewer ${socket.id} raised hand in room ${roomId}`);
    }
  });

  socket.on('BE-lower-hand', ({ roomId }) => {
    const room = rooms[roomId];
    if (room && room.raisedHands.has(socket.id)) {
      room.raisedHands.delete(socket.id);
      io.to(room.broadcaster).emit('FE-hand-lowered', {
        userId: socket.id
      });
    }
  });

  // WebRTC signaling (keep your existing implementation)
  socket.on('BE-call-user', ({ userToCall, from, signal }) => {
    io.to(userToCall).emit('FE-receive-call', {
      signal,
      from,
      info: getUserInfo(socket.id)
    });
  });

  socket.on('BE-accept-call', ({ signal, to }) => {
    io.to(to).emit('FE-call-accepted', {
      signal,
      answerId: socket.id
    });
  });

  socket.on('BE-leave-room', ({ roomId }) => {
    const room = rooms[roomId];
    if (room) {
      if (room.broadcaster === socket.id) {
        io.to(roomId).emit('FE-broadcaster-left');
        delete rooms[roomId];
      } else {
        if (room.viewers.has(socket.id)) {
          room.viewers.delete(socket.id);
          io.to(roomId).emit('FE-viewer-left', { userId: socket.id });
        }
        room.pendingViewers.delete(socket.id);
        room.raisedHands.delete(socket.id);
      }
    }
    socket.leave(roomId);
  });
});

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});