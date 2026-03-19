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
let waitingRoom = null; // room code waiting for a second player

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
    clearTimeout(room.grabTimeout);
    rooms.delete(code);
    if (waitingRoom === code) waitingRoom = null;
  }
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('findMatch', (data) => {
    const ts = data.targetScore || 10;

    // Try to join a waiting room
    if (waitingRoom && rooms.has(waitingRoom)) {
      const room = rooms.get(waitingRoom);
      if (!room.guest) {
        // Join existing room
        room.guest = socket.id;
        room.targetScore = ts;
        socket.join(waitingRoom);
        currentRoom = waitingRoom;
        waitingRoom = null;

        // Tell both players: 2/2
        io.to(currentRoom).emit('matchUpdate', { players: 2 });

        // Start game
        io.to(room.host).emit('gameStart', {
          playerNum: 1,
          mode: 'classic',
          targetScore: room.targetScore
        });
        io.to(room.guest).emit('gameStart', {
          playerNum: 2,
          mode: 'classic',
          targetScore: room.targetScore
        });

        room.nextRoundTimer = setTimeout(() => startOnlineRound(currentRoom), 800);
        return;
      }
    }

    // No waiting room available — create one
    const code = generateCode();
    const room = {
      code,
      mode: 'classic',
      targetScore: ts,
      host: socket.id,
      guest: null,
      p1Score: 0,
      p2Score: 0,
      roundNum: 0,
      p1Streak: 0,
      p2Streak: 0,
      p1Time: 0,
      p2Time: 0,
      objectShown: false,
      roundSettled: false,
      roundTimer: null,
      fakeoutTimers: [],
      nextRoundTimer: null,
      grabTimeout: null,
      objectIndex: 0
    };

    rooms.set(code, room);
    socket.join(code);
    currentRoom = code;
    waitingRoom = code;

    socket.emit('matchUpdate', { players: 1 });
  });

  socket.on('grab', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.roundSettled) return;

    const playerNum = data.playerNum;

    if (data.falseStart) {
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

      if (room.p1Score >= room.targetScore) {
        setTimeout(() => endOnlineGame(currentRoom, 1), 800);
        return;
      }
      if (room.p2Score >= room.targetScore) {
        setTimeout(() => endOnlineGame(currentRoom, 2), 800);
        return;
      }

      room.nextRoundTimer = setTimeout(() => startOnlineRound(currentRoom), 2500);
      return;
    }

    // Normal grab
    if (!room.objectShown) return;

    const rt = data.reactionTime;
    if (rt < 100) return;

    if (playerNum === 1) {
      room.p1Time = rt;
    } else {
      room.p2Time = rt;
    }

    if (room.p1Time > 0 && room.p2Time > 0) {
      settleOnlineRound(currentRoom);
    } else {
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

    room.p1Score = 0;
    room.p2Score = 0;
    room.roundNum = 0;
    room.p1Streak = 0;
    room.p2Streak = 0;

    io.to(room.host).emit('rematchStart', {
      playerNum: 1,
      mode: 'classic',
      targetScore: room.targetScore
    });
    io.to(room.guest).emit('rematchStart', {
      playerNum: 2,
      mode: 'classic',
      targetScore: room.targetScore
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

    room.grabTimeout = setTimeout(() => {
      if (!room.roundSettled) {
        room.roundSettled = true;
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

  if (room.p1Score >= room.targetScore) {
    setTimeout(() => endOnlineGame(code, 1), 800);
    return;
  }
  if (room.p2Score >= room.targetScore) {
    setTimeout(() => endOnlineGame(code, 2), 800);
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
