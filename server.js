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

// Store socket information
let socketList = {};
let roomBroadcasters = {}; // roomId -> broadcaster socket.id
let roomActiveSpeakers = {}; // roomId -> active speaker socket.id (only one viewer can be active at a time)
let raisedHands = {}; // roomId -> array of socket IDs who raised hands

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is healthy' });
});

io.on('connection', (socket) => {
  log('info', 'New user connected', { socketId: socket.id });

  socket.on('disconnect', () => {
    // Clean up when user disconnects
    const userInfo = socketList[socket.id];
    if (userInfo) {
      // If this user was a broadcaster, remove them from the room
      for (const roomId in roomBroadcasters) {
        if (roomBroadcasters[roomId] === socket.id) {
          delete roomBroadcasters[roomId];
          log('info', 'Broadcaster disconnected', { roomId, socketId: socket.id });
        }
      }

      // If this user was the active speaker, clear that status
      for (const roomId in roomActiveSpeakers) {
        if (roomActiveSpeakers[roomId] === socket.id) {
          delete roomActiveSpeakers[roomId];
          io.to(roomId).emit('FE-viewer-muted', { viewerId: socket.id });
          log('info', 'Active speaker disconnected', { roomId, socketId: socket.id });
        }
      }

      // Remove from raised hands in all rooms
      for (const roomId in raisedHands) {
        raisedHands[roomId] = raisedHands[roomId].filter(id => id !== socket.id);
      }
    }

    delete socketList[socket.id];
    log('info', 'User disconnected', { socketId: socket.id });
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
      audio: false, // Default to muted for viewers
      role: null,
      joinedAt: Date.now()
    };

    let assignedRole = role || (!roomBroadcasters[roomId] ? 'broadcaster' : 'viewer');

    if (assignedRole === 'broadcaster') {
      if (!roomBroadcasters[roomId]) {
        roomBroadcasters[roomId] = socket.id;
        socketList[socket.id].role = 'broadcaster';
        socketList[socket.id].audio = true; // Broadcaster starts unmuted
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

    // Clean up speaker status if this user was speaking
    if (roomActiveSpeakers[roomId] === socket.id) {
      delete roomActiveSpeakers[roomId];
      io.to(roomId).emit('FE-viewer-muted', { viewerId: socket.id });
    }

    // Clean up raised hands
    if (raisedHands[roomId]) {
      raisedHands[roomId] = raisedHands[roomId].filter(id => id !== socket.id);
    }

    delete socketList[socket.id];
    if (roomBroadcasters[roomId] === socket.id) {
      log('warn', 'Broadcaster left room', { roomId });
      delete roomBroadcasters[roomId];
      
      // Mute all viewers when broadcaster leaves
      io.to(roomId).emit('FE-all-viewers-muted');
      roomActiveSpeakers[roomId] = null;
    }

    socket.broadcast.to(roomId).emit('FE-user-leave', { userId: socket.id });
    socket.leave(roomId);
  });

  // New event handlers for speaker management
  socket.on('BE-request-to-speak', ({ roomId, requester }) => {
    log('info', 'Viewer requesting to speak', { roomId, requester });
    
    if (!raisedHands[roomId]) {
      raisedHands[roomId] = [];
    }
    
    // Add to raised hands if not already there
    if (!raisedHands[roomId].includes(requester)) {
      raisedHands[roomId].push(requester);
      
      // Notify broadcaster
      const broadcasterId = roomBroadcasters[roomId];
      if (broadcasterId) {
        io.to(broadcasterId).emit('FE-speaking-request', { requester });
      }
      
      log('info', 'Speaking request added', { 
        roomId, 
        requester, 
        currentRaisedHands: raisedHands[roomId] 
      });
    }
  });

  socket.on('BE-cancel-speaking-request', ({ roomId, requester }) => {
    log('info', 'Viewer canceling speaking request', { roomId, requester });
    
    if (raisedHands[roomId]) {
      raisedHands[roomId] = raisedHands[roomId].filter(id => id !== requester);
      
      // Notify broadcaster
      const broadcasterId = roomBroadcasters[roomId];
      if (broadcasterId) {
        io.to(broadcasterId).emit('FE-speaking-request-canceled', { requester });
      }
      
      log('info', 'Speaking request canceled', { 
        roomId, 
        requester, 
        currentRaisedHands: raisedHands[roomId] 
      });
    }
  });

  socket.on('BE-mute-all-viewers', ({ roomId }) => {
    log('info', 'Muting all viewers in room', { roomId, broadcasterId: socket.id });
    
    // Clear active speaker
    delete roomActiveSpeakers[roomId];
    
    // Clear all raised hands
    if (raisedHands[roomId]) {
      raisedHands[roomId] = [];
    }
    
    // Notify all viewers to mute
    io.to(roomId).emit('FE-all-viewers-muted');
    
    // Notify broadcaster that all viewers are now muted
    io.to(socket.id).emit('FE-all-viewers-muted-confirmation');
  });

  socket.on('BE-unmute-viewer', ({ roomId, viewerId }) => {
    log('info', 'Unmuting viewer', { roomId, viewerId, broadcasterId: socket.id });
    
    // Mute the current active speaker if there is one
    if (roomActiveSpeakers[roomId] && roomActiveSpeakers[roomId] !== viewerId) {
      const previousSpeaker = roomActiveSpeakers[roomId];
      io.to(previousSpeaker).emit('FE-viewer-muted', { viewerId: previousSpeaker });
    }
    
    // Set new active speaker
    roomActiveSpeakers[roomId] = viewerId;
    
    // Remove from raised hands if they were there
    if (raisedHands[roomId]) {
      raisedHands[roomId] = raisedHands[roomId].filter(id => id !== viewerId);
    }
    
    // Notify the viewer to unmute
    io.to(viewerId).emit('FE-viewer-unmuted', { viewerId });
    
    // Notify room about new active speaker
    io.to(roomId).emit('FE-active-speaker-changed', { viewerId });
    
    log('info', 'Viewer unmuted and set as active speaker', { 
      roomId, 
      viewerId,
      activeSpeaker: roomActiveSpeakers[roomId]
    });
  });

  socket.on('BE-mute-viewer', ({ roomId, viewerId }) => {
    log('info', 'Muting viewer', { roomId, viewerId, broadcasterId: socket.id });
    
    // Clear active speaker if this is the current one
    if (roomActiveSpeakers[roomId] === viewerId) {
      delete roomActiveSpeakers[roomId];
    }
    
    // Notify the viewer to mute
    io.to(viewerId).emit('FE-viewer-muted', { viewerId });
    
    // Notify room about active speaker change
    io.to(roomId).emit('FE-active-speaker-changed', { viewerId: null });
    
    log('info', 'Viewer muted', { roomId, viewerId });
  });

  socket.on('BE-viewer-muted-self', ({ roomId, viewerId }) => {
    log('info', 'Viewer muted themselves', { roomId, viewerId });
    
    // Clear active speaker if this is the current one
    if (roomActiveSpeakers[roomId] === viewerId) {
      delete roomActiveSpeakers[roomId];
      io.to(roomId).emit('FE-active-speaker-changed', { viewerId: null });
    }
    
    // Remove from raised hands if they were there
    if (raisedHands[roomId]) {
      raisedHands[roomId] = raisedHands[roomId].filter(id => id !== viewerId);
      io.to(roomBroadcasters[roomId]).emit('FE-speaking-request-canceled', { requester: viewerId });
    }
  });

  socket.on('BE-speaking-request-denied', ({ roomId, viewerId }) => {
    log('info', 'Speaking request denied', { roomId, viewerId });
    io.to(viewerId).emit('FE-speaking-request-denied');
  });
});

http.listen(PORT, () => {
  console.log('Signaling server listening on port', PORT);
});