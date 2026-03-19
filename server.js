const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ ONLINE MULTIPLAYER ============
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function cleanupRoom(code) {
  const room = rooms.get(code);
  if (room) {
    clearTimeout(room.roundTimer);
    room.fakeoutTimers.forEach(clearTimeout);
    clearTimeout(room.nextRoundTimer);
    rooms.delete(code);
  }
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('createRoom', (data) => {
    const code = generateCode();
    const room = {
      code,
      mode: data.mode || 'classic',
      targetScore: data.targetScore || 10,
      host: socket.id,
      guest: null,
      p1Score: 0,
      p2Score: 0,
      roundNum: 0,
      totalRounds: 30,
      p1Streak: 0,
      p2Streak: 0,
      p1Time: 0,
      p2Time: 0,
      objectShown: false,
      roundSettled: false,
      roundTimer: null,
      fakeoutTimers: [],
      nextRoundTimer: null,
      objectIndex: 0
    };

    if (room.mode === 'sudden') { room.targetScore = 1; room.totalRounds = 1; }
    else if (room.mode === 'marathon') { room.targetScore = 9999; room.totalRounds = 30; }
    else { room.totalRounds = 9999; }

    rooms.set(code, room);
    socket.join(code);
    currentRoom = code;
    socket.emit('roomCreated', { code });
  });

  socket.on('joinRoom', (data) => {
    const code = data.code.toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('joinError', { message: 'Room not found' });
      return;
    }
    if (room.guest) {
      socket.emit('joinError', { message: 'Room is full' });
      return;
    }

    room.guest = socket.id;
    socket.join(code);
    currentRoom = code;

    // Notify both players the game is starting
    io.to(room.host).emit('gameStart', {
      playerNum: 1,
      mode: room.mode,
      targetScore: room.mode === 'classic' ? room.targetScore : (room.mode === 'sudden' ? 1 : 9999)
    });
    io.to(room.guest).emit('gameStart', {
      playerNum: 2,
      mode: room.mode,
      targetScore: room.mode === 'classic' ? room.targetScore : (room.mode === 'sudden' ? 1 : 9999)
    });

    // Start first round after a short delay
    room.nextRoundTimer = setTimeout(() => startOnlineRound(code), 800);
  });

  socket.on('grab', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.roundSettled) return;

    const playerNum = data.playerNum;

    if (data.falseStart) {
      // Handle false start
      room.roundSettled = true;
      clearTimeout(room.roundTimer);
      room.fakeoutTimers.forEach(clearTimeout);
      room.fakeoutTimers = [];

      if (playerNum === 1) {
        room.p1Score = Math.max(0, room.p1Score - 1);
        room.p2Score++;
        room.p1Streak = 0;
        room.p2Streak++;
      } else {
        room.p2Score = Math.max(0, room.p2Score - 1);
        room.p1Score++;
        room.p2Streak = 0;
        room.p1Streak++;
      }

      io.to(currentRoom).emit('falseStartResult', {
        offender: playerNum,
        p1Score: room.p1Score,
        p2Score: room.p2Score,
        p1Streak: room.p1Streak,
        p2Streak: room.p2Streak
      });

      // Check win
      if (room.mode !== 'marathon') {
        const ts = room.mode === 'classic' ? room.targetScore : 1;
        if (room.p1Score >= ts) {
          setTimeout(() => endOnlineGame(currentRoom, 1), 800);
          return;
        }
        if (room.p2Score >= ts) {
          setTimeout(() => endOnlineGame(currentRoom, 2), 800);
          return;
        }
      }

      room.nextRoundTimer = setTimeout(() => startOnlineRound(currentRoom), 2500);
      return;
    }

    // Normal grab
    if (!room.objectShown) return;

    const rt = data.reactionTime;
    if (rt < 100) return; // Too fast, ignore

    if (playerNum === 1) {
      room.p1Time = rt;
    } else {
      room.p2Time = rt;
    }

    // Check if both players have grabbed or settle after timeout
    if (room.p1Time > 0 && room.p2Time > 0) {
      settleOnlineRound(currentRoom);
    } else {
      // Give opponent 2 seconds to respond
      if (!room.grabTimeout) {
        room.grabTimeout = setTimeout(() => {
          if (!room.roundSettled) settleOnlineRound(currentRoom);
        }, 2000);
      }
    }
  });

  socket.on('rematch', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.host || !room.guest) return;

    // Reset room state
    room.p1Score = 0;
    room.p2Score = 0;
    room.roundNum = 0;
    room.p1Streak = 0;
    room.p2Streak = 0;

    io.to(room.host).emit('rematchStart', {
      playerNum: 1,
      mode: room.mode,
      targetScore: room.mode === 'classic' ? room.targetScore : (room.mode === 'sudden' ? 1 : 9999)
    });
    io.to(room.guest).emit('rematchStart', {
      playerNum: 2,
      mode: room.mode,
      targetScore: room.mode === 'classic' ? room.targetScore : (room.mode === 'sudden' ? 1 : 9999)
    });

    room.nextRoundTimer = setTimeout(() => startOnlineRound(currentRoom), 800);
  });

  socket.on('leaveRoom', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        socket.to(currentRoom).emit('opponentDisconnected');
        cleanupRoom(currentRoom);
      }
      socket.leave(currentRoom);
      currentRoom = null;
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        socket.to(currentRoom).emit('opponentDisconnected');
        cleanupRoom(currentRoom);
      }
    }
  });
});

function startOnlineRound(code) {
  const room = rooms.get(code);
  if (!room || !room.host || !room.guest) return;

  room.roundNum++;
  room.objectShown = false;
  room.roundSettled = false;
  room.p1Time = 0;
  room.p2Time = 0;
  clearTimeout(room.grabTimeout);
  room.grabTimeout = null;

  io.to(code).emit('roundStart', { roundNum: room.roundNum });

  const delay = 1500 + Math.random() * 3500;
  const numFakeouts = Math.random() < 0.35 ? 1 : (Math.random() < 0.15 ? 2 : 0);

  room.fakeoutTimers = [];
  for (let i = 0; i < numFakeouts; i++) {
    const ft = setTimeout(() => {
      if (!room.roundSettled && !room.objectShown) {
        io.to(code).emit('fakeout');
      }
    }, 600 + Math.random() * (delay - 800));
    room.fakeoutTimers.push(ft);
  }

  room.roundTimer = setTimeout(() => {
    if (room.roundSettled) return;
    room.objectShown = true;
    room.objectIndex = Math.floor(Math.random() * 6);
    io.to(code).emit('objectAppear', { objectIndex: room.objectIndex });

    // Auto-settle after 5 seconds if neither player grabs
    room.grabTimeout = setTimeout(() => {
      if (!room.roundSettled) {
        room.roundSettled = true;
        // Nobody grabbed, just start next round
        room.nextRoundTimer = setTimeout(() => startOnlineRound(code), 1000);
      }
    }, 5000);
  }, delay);
}

function settleOnlineRound(code) {
  const room = rooms.get(code);
  if (!room || room.roundSettled) return;
  room.roundSettled = true;
  clearTimeout(room.grabTimeout);
  room.grabTimeout = null;

  let winner;
  if (room.p1Time > 0 && room.p2Time > 0) {
    winner = room.p1Time <= room.p2Time ? 1 : 2;
  } else if (room.p1Time > 0) {
    winner = 1;
  } else if (room.p2Time > 0) {
    winner = 2;
  } else {
    // Neither grabbed (shouldn't happen normally)
    room.nextRoundTimer = setTimeout(() => startOnlineRound(code), 1500);
    return;
  }

  if (winner === 1) {
    room.p1Score++;
    room.p1Streak++;
    room.p2Streak = 0;
  } else {
    room.p2Score++;
    room.p2Streak++;
    room.p1Streak = 0;
  }

  const timeDiff = (room.p1Time > 0 && room.p2Time > 0) ? Math.abs(room.p1Time - room.p2Time) : 0;

  io.to(code).emit('roundResult', {
    winner,
    p1Score: room.p1Score,
    p2Score: room.p2Score,
    p1Streak: room.p1Streak,
    p2Streak: room.p2Streak,
    p1Time: room.p1Time,
    p2Time: room.p2Time,
    timeDiff
  });

  // Check win
  if (room.mode !== 'marathon') {
    const ts = room.targetScore;
    if (room.p1Score >= ts) {
      setTimeout(() => endOnlineGame(code, 1), 800);
      return;
    }
    if (room.p2Score >= ts) {
      setTimeout(() => endOnlineGame(code, 2), 800);
      return;
    }
  }

  // Marathon round limit
  if (room.mode === 'marathon' && room.roundNum >= room.totalRounds) {
    setTimeout(() => {
      const w = room.p1Score > room.p2Score ? 1 : (room.p2Score > room.p1Score ? 2 : 0);
      endOnlineGame(code, w);
    }, 1000);
    return;
  }

  room.nextRoundTimer = setTimeout(() => startOnlineRound(code), 1800);
}

function endOnlineGame(code, winner) {
  const room = rooms.get(code);
  if (!room) return;

  io.to(code).emit('gameOver', {
    winner,
    p1Score: room.p1Score,
    p2Score: room.p2Score
  });
}

server.listen(PORT, () => {
  console.log(`Quick Grab running on port ${PORT}`);
});
