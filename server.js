const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6,
  pingTimeout: 120000,
  pingInterval: 25000
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== ROOM MANAGEMENT ==========
const rooms = new Map(); // roomId -> roomData

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function getRoomList() {
  const list = [];
  rooms.forEach((room, id) => {
    if (room.isPublic && room.phase === 'lobby') {
      list.push({
        id,
        hostName: room.hostName,
        playerCount: room.players.size,
        maxPlayers: room.maxPlayers || 12,
        gameMode: room.gameMode || 1
      });
    }
  });
  return list;
}

function broadcastRoomList() {
  io.emit('room_list', getRoomList());
}

// ========== API PROXY (for horn racing) ==========
const activeApiCalls = new Map(); // callId -> AbortController

app.post('/api/proxy', async (req, res) => {
  const { apiUrl, apiKey, model, maxTokens, prompt, callId } = req.body;
  if (!apiUrl || !apiKey || !prompt) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const controller = new AbortController();
  if (callId) activeApiCalls.set(callId, controller);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || 'gpt-3.5-turbo',
        max_tokens: maxTokens || 65536,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
    if (callId) activeApiCalls.delete(callId);
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return res.status(response.status).json({ error: `API ${response.status}: ${errText.substring(0, 500)}` });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    if (callId) activeApiCalls.delete(callId);
    if (err.name === 'AbortError') {
      return res.status(499).json({ error: 'Request aborted (racing)' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/abort', (req, res) => {
  const { callIds } = req.body;
  if (!callIds || !Array.isArray(callIds)) return res.status(400).json({ error: 'Missing callIds' });
  let aborted = 0;
  callIds.forEach(id => {
    const ctrl = activeApiCalls.get(id);
    if (ctrl) { ctrl.abort(); activeApiCalls.delete(id); aborted++; }
  });
  res.json({ aborted });
});

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentSlot = -1;
  let playerName = '';

  socket.emit('room_list', getRoomList());

  // Create room
  socket.on('create_room', (data, cb) => {
    const { name, isPublic, password, gameMode } = data;
    let roomId;
    do { roomId = generateRoomId(); } while (rooms.has(roomId));

    const room = {
      id: roomId,
      hostId: socket.id,
      hostName: name || 'Host',
      isPublic: isPublic !== false,
      password: isPublic !== false ? null : (password || '000000'),
      phase: 'lobby',
      gameMode: gameMode || 1,
      maxPlayers: 12,
      players: new Map(), // socketId -> { slot, name, ready }
      slotMap: {}, // slot -> socketId
      gameState: null, // synced from host
      settings: {}
    };

    // Host takes slot 0
    room.players.set(socket.id, { slot: 0, name: name || 'Host', ready: true });
    room.slotMap[0] = socket.id;

    rooms.set(roomId, room);
    currentRoom = roomId;
    currentSlot = 0;
    playerName = name || 'Host';
    socket.join(roomId);

    cb({ success: true, roomId, slot: 0, isHost: true });
    broadcastRoomList();
    broadcastRoomPlayers(roomId);
  });

  // Join room
  socket.on('join_room', (data, cb) => {
    const { roomId, name, password } = data;
    const room = rooms.get(roomId);
    if (!room) return cb({ success: false, error: '房间不存在' });
    if (room.phase !== 'lobby') return cb({ success: false, error: '游戏已开始' });
    if (!room.isPublic && room.password && room.password !== password) {
      return cb({ success: false, error: '密码错误' });
    }
    // Check if player already in room
    if (room.players.has(socket.id)) {
      return cb({ success: false, error: '你已在房间中' });
    }
    // Find first available slot
    const maxSlots = room.maxPlayers || 12;
    let slot = -1;
    for (let i = 0; i < maxSlots; i++) {
      if (!room.slotMap[i]) { slot = i; break; }
    }
    if (slot === -1) return cb({ success: false, error: '房间已满' });

    room.players.set(socket.id, { slot, name: name || `玩家${slot + 1}`, ready: false });
    room.slotMap[slot] = socket.id;
    currentRoom = roomId;
    currentSlot = slot;
    playerName = name || `玩家${slot + 1}`;
    socket.join(roomId);

    cb({ success: true, roomId, slot, isHost: false });
    broadcastRoomList();
    broadcastRoomPlayers(roomId);
  });

  // Leave room
  socket.on('leave_room', () => {
    leaveCurrentRoom();
  });

  // Update player info (name, ready)
  socket.on('update_player', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (data.name !== undefined) { p.name = data.name; playerName = data.name; }
    if (data.ready !== undefined) p.ready = data.ready;
    broadcastRoomPlayers(currentRoom);
  });

  // Host updates settings
  socket.on('update_room_settings', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    if (data.gameMode !== undefined) room.gameMode = data.gameMode;
    if (data.maxPlayers !== undefined) room.maxPlayers = data.maxPlayers;
    if (data.settings) room.settings = { ...room.settings, ...data.settings };
    broadcastRoomPlayers(currentRoom);
  });

  // Host starts the game
  socket.on('start_game', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    room.phase = 'playing';
    io.to(currentRoom).emit('game_started', { hostId: room.hostId });
    broadcastRoomList();
  });

  // Host broadcasts game state to all players
  socket.on('sync_game_state', (state) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    room.gameState = state;
    // Send public state to all non-host players
    room.players.forEach((p, sid) => {
      if (sid !== socket.id) {
        const playerState = buildPlayerView(state, p.slot);
        io.to(sid).emit('game_state_update', playerState);
      }
    });
  });

  // Non-host player sends action to host
  socket.on('player_action', (action) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    // Forward to host
    io.to(room.hostId).emit('remote_player_action', {
      slot: p.slot,
      socketId: socket.id,
      ...action
    });
  });

  // Horn button - any player can trigger
  socket.on('horn_boost', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    // Forward to host to trigger racing
    io.to(room.hostId).emit('horn_boost_triggered', { fromSlot: currentSlot });
    // Also broadcast horn animation to all players
    io.to(currentRoom).emit('horn_effect', { fromSlot: currentSlot });
  });

  // Chat message in room
  socket.on('room_chat', (msg) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('room_chat', { name: playerName, slot: currentSlot, msg });
  });

  // Host resets game
  socket.on('game_reset', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    room.phase = 'lobby';
    room.gameState = null;
    io.to(currentRoom).emit('game_reset');
    broadcastRoomList();
    broadcastRoomPlayers(currentRoom);
  });

  // Disconnect
  socket.on('disconnect', () => {
    leaveCurrentRoom();
  });

  function leaveCurrentRoom() {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) { currentRoom = null; return; }

    const p = room.players.get(socket.id);
    if (p) {
      delete room.slotMap[p.slot];
      room.players.delete(socket.id);
    }
    socket.leave(currentRoom);

    // If host left, destroy room or transfer
    if (room.hostId === socket.id) {
      if (room.players.size > 0) {
        // Transfer host to first remaining player
        const [newHostId, newHostData] = room.players.entries().next().value;
        room.hostId = newHostId;
        room.hostName = newHostData.name;
        io.to(newHostId).emit('became_host');
        io.to(currentRoom).emit('host_changed', { hostSlot: newHostData.slot, hostName: newHostData.name });
      } else {
        rooms.delete(currentRoom);
      }
    }

    broadcastRoomPlayers(currentRoom);
    broadcastRoomList();
    currentRoom = null;
    currentSlot = -1;
  }
});

function broadcastRoomPlayers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const list = [];
  room.players.forEach((p, sid) => {
    list.push({
      slot: p.slot,
      name: p.name,
      ready: p.ready,
      isHost: sid === room.hostId,
      isMe: false // will be overridden client-side
    });
  });
  list.sort((a, b) => a.slot - b.slot);
  io.to(roomId).emit('room_players', {
    players: list,
    roomId: room.id,
    isPublic: room.isPublic,
    gameMode: room.gameMode,
    hostSlot: room.players.get(room.hostId)?.slot || 0,
    phase: room.phase,
    settings: room.settings
  });
}

function buildPlayerView(state, slot) {
  if (!state) return null;
  // Build a view for a specific player slot
  // Only include information they should see
  const view = {
    phase: state.phase,
    round: state.round,
    step: state.step,
    players: state.players?.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      alive: p.alive,
      canVote: p.canVote,
      idiotRevealed: p.idiotRevealed,
      isHuman: p.isHuman,
      // Only reveal role for own player, or if dead+revealDead, or if game over
      role: (p.id === slot || (state.revealDead && !p.alive) || state.phase === 'gameOver') ? p.role : null
    })),
    mySlot: slot,
    myRole: state.players?.[slot]?.role || null,
    myAlive: state.players?.[slot]?.alive ?? true,
    speeches: state.speeches || [],
    votes: state.votes || {},
    voteOrder: state.voteOrder || [],
    nightResultMsg: state.nightResultMsg || '',
    gameResult: state.gameResult,
    lastWordsList: state.lastWordsList || [],
    dayVoteHistory: state.dayVoteHistory || [],
    votingActive: state.votingActive || false,
    // Wolf-specific info
    wolfTeam: state.players?.[slot]?.role === 'werewolf'
      ? state.players.filter(p => p.role === 'werewolf' && p.id !== slot).map(p => ({ id: p.id, name: p.name, alive: p.alive }))
      : null,
    // Seer-specific info
    seerHistory: state.players?.[slot]?.role === 'seer' ? (state.seerHistory || []) : null,
    // Witch-specific info
    witchInfo: state.players?.[slot]?.role === 'witch' ? {
      hasSave: state.witchHasSave,
      hasPoison: state.witchHasPoison,
      nightKill: state.nightKill
    } : null,
    // What action is expected from this player
    pendingAction: state.pendingActions?.[slot] || null,
    // Night progress
    nightProgressPct: state.nightProgressPct || 0,
    nightProgressLabel: state.nightProgressLabel || '',
    // Speech order preview
    speechOrder: state.speechOrder || [],
    // Whose turn to speak
    currentSpeaker: state.currentSpeaker || null,
    // Game history (filtered)
    gameHistory: state.gameHistory || [],
    // Log
    log: state.log || [],
    showLog: state.showLog || false,
    // Settings
    revealDead: state.revealDead || false,
    enableLW: state.enableLW || false,
    apiAutoMode: state.apiAutoMode || false,
  };
  return view;
}

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size }));

// Cleanup stale rooms periodically
setInterval(() => {
  rooms.forEach((room, id) => {
    if (room.players.size === 0) rooms.delete(id);
  });
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐺 Werewolf Online Server running on port ${PORT}`);
});
