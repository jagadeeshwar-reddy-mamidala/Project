/**
 * DrawGuess - Real-time multiplayer drawing & word-guessing game
 * Node.js + Express + Socket.io
 *
 * ALL authoritative game state lives on the server:
 *  - room/team membership
 *  - current phase + phase end timestamps
 *  - the secret word (never sent to non-drawers)
 *  - scores
 * Clients are "dumb" renderers driven by server broadcasts, which prevents
 * client-side timer desync and word-leaking/cheating.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 20000,
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PHASE = {
  LOBBY: 'lobby',
  SELECTING: 'selecting',   // 10s "get ready" notification
  WORD_CHOICE: 'word_choice', // 10s drawer picks word
  DRAWING: 'drawing',       // 60s drawing — guessing happens concurrently within this phase
  ROUND_END: 'round_end',   // brief reveal
  GAME_OVER: 'game_over',
};

const DURATIONS = {
  SELECTING: 10_000,
  WORD_CHOICE: 10_000,
  DRAWING: 60_000,
  ROUND_END: 5_000,
};

const WORD_BANK = [
  'apple', 'guitar', 'rainbow', 'elephant', 'bicycle', 'castle', 'rocket',
  'penguin', 'volcano', 'sandwich', 'butterfly', 'umbrella', 'dinosaur',
  'lighthouse', 'pirate', 'robot', 'snowman', 'dragon', 'octopus', 'wizard',
  'cactus', 'balloon', 'skateboard', 'campfire', 'jellyfish', 'kangaroo',
  'mountain', 'spaceship', 'waterfall', 'treasure', 'unicorn', 'volcano',
  'telescope', 'sunflower', 'hamburger', 'crown', 'anchor', 'compass',
  'firetruck', 'igloo', 'mermaid', 'ninja', 'pancake', 'pyramid', 'scarecrow',
  'submarine', 'tornado', 'windmill', 'zebra', 'astronaut', 'bagpipes',
  'chandelier', 'dolphin', 'earthquake', 'fireworks', 'glacier', 'hedgehog',
  'iceberg', 'jukebox', 'kaleidoscope', 'lantern', 'moustache', 'necklace',
  'origami', 'peacock', 'quicksand', 'saxophone', 'toothbrush', 'vampire',
];

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
/** @type {Map<string, Room>} */
const rooms = new Map();

function makeRoomId() {
  return crypto.randomBytes(3).toString('hex'); // short shareable code
}

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Sanitize a host-chosen passcode: lowercase, alphanumeric/dash only, 3-20 chars. */
function sanitizePasscode(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 20);
}

function createRoom(hostSocketId, hostName, customPasscode) {
  let id;
  if (customPasscode) {
    const clean = sanitizePasscode(customPasscode);
    if (clean.length < 3) return { error: 'Passcode must be at least 3 characters (letters/numbers).' };
    if (rooms.has(clean)) return { error: 'That passcode is already taken. Try a different one.' };
    id = clean;
  } else {
    do { id = makeRoomId(); } while (rooms.has(id));
  }
  const room = {
    id,
    hostId: hostSocketId,
    players: new Map(), // socketId -> { id, name, teamId }
    teams: new Map(),   // teamId -> { id, name, memberIds: Set, score }
    teamOrder: [],       // ordered list of teamIds for turn rotation
    state: PHASE.LOBBY,
    currentTeamIndex: -1,
    currentDrawerId: null,
    currentWord: null,
    wordOptions: [],
    phaseEndTime: null,
    totalRounds: 2,
    currentRound: 0,
    correctGuessers: new Set(),
    guessPhaseStartTime: null, // start of the drawing/guessing window, used for scoring
    usedWords: new Set(),
    teamLastDrawer: new Map(), // teamId -> last drawer socketId, so round 2 picks someone new
    timer: null, // active setTimeout handle
    createdAt: Date.now(),
  };
  rooms.set(id, room);
  return { room };
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, teamId: p.teamId };
}

function publicTeams(room) {
  return room.teamOrder.map((tid) => {
    const t = room.teams.get(tid);
    return {
      id: t.id,
      name: t.name,
      score: t.score,
      members: [...t.memberIds].map((sid) => {
        const p = room.players.get(sid);
        return p ? { id: p.id, name: p.name } : null;
      }).filter(Boolean),
    };
  });
}

function roomSnapshot(room, forSocketId) {
  const isDrawer = forSocketId === room.currentDrawerId;
  const isHost = forSocketId === room.hostId;
  return {
    roomId: room.id,
    hostId: room.hostId,
    isHost,
    state: room.state,
    teams: publicTeams(room),
    players: [...room.players.values()].map(publicPlayer),
    currentTeamId: room.currentTeamIndex >= 0 ? room.teamOrder[room.currentTeamIndex] : null,
    currentDrawerId: room.currentDrawerId,
    phaseEndTime: room.phaseEndTime,
    totalRounds: room.totalRounds,
    currentRound: room.currentRound,
    // Word is masked unless you are the drawer, or round has ended (reveal)
    wordOptions: isDrawer && room.state === PHASE.WORD_CHOICE ? room.wordOptions : [],
    wordMask: room.currentWord && room.state !== PHASE.WORD_CHOICE
      ? maskWord(room.currentWord, room.state)
      : null,
    revealedWord: (room.state === PHASE.ROUND_END || room.state === PHASE.GAME_OVER) ? room.currentWord : null,
    youAreDrawer: isDrawer,
    correctGuesserIds: [...room.correctGuessers],
  };
}

function maskWord(word, state) {
  if (state === PHASE.DRAWING) {
    return word.replace(/[a-zA-Z]/g, '_ ').trim();
  }
  return word;
}

function broadcastState(room) {
  for (const sid of room.players.keys()) {
    io.to(sid).emit('roomState', roomSnapshot(room, sid));
  }
  // also let anyone in the socket.io room (spectator-ish) get generic state
  io.to(room.id).emit('teamsUpdated', publicTeams(room));
}

function broadcastToast(room, message, extra = {}) {
  io.to(room.id).emit('announcement', { message, ...extra });
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

function activeTeamsWithMembers(room) {
  return room.teamOrder.filter((tid) => room.teams.get(tid).memberIds.size > 0);
}

function startGame(room, totalRounds) {
  const active = activeTeamsWithMembers(room);
  if (active.length === 0) return { error: 'Need at least one team with a player to start.' };
  room.totalRounds = Math.max(1, Math.min(20, totalRounds || 2));
  room.currentRound = 1;
  room.currentTeamIndex = -1;
  room.usedWords = new Set();
  room.teamLastDrawer = new Map();
  advanceTurn(room);
  return { ok: true };
}

function advanceTurn(room) {
  clearRoomTimer(room);
  const active = activeTeamsWithMembers(room);
  if (active.length === 0) {
    endGame(room);
    return;
  }

  room.currentTeamIndex++;
  if (room.currentTeamIndex >= room.teamOrder.length) {
    room.currentTeamIndex = 0;
    room.currentRound++;
    if (room.currentRound > room.totalRounds) {
      endGame(room);
      return;
    }
  }

  const teamId = room.teamOrder[room.currentTeamIndex];
  const team = room.teams.get(teamId);
  if (!team || team.memberIds.size === 0) {
    // skip empty teams
    advanceTurn(room);
    return;
  }

  const members = [...team.memberIds];
  // Prefer someone who hasn't drawn for this team yet this game (so round 2
  // is a different player than round 1), falling back to anyone if the
  // whole roster has already had a turn (or the team only has one member).
  const lastDrawer = room.teamLastDrawer.get(teamId);
  let pool = members;
  if (members.length > 1 && lastDrawer) {
    const fresh = members.filter((id) => id !== lastDrawer);
    if (fresh.length > 0) pool = fresh;
  }
  const drawerId = pool[Math.floor(Math.random() * pool.length)];
  room.teamLastDrawer.set(teamId, drawerId);
  room.currentDrawerId = drawerId;
  room.currentWord = null;
  room.wordOptions = [];
  room.correctGuessers = new Set();
  room.state = PHASE.SELECTING;
  room.phaseEndTime = Date.now() + DURATIONS.SELECTING;

  const drawer = room.players.get(drawerId);
  broadcastState(room);
  broadcastToast(room, `Team ${team.name}, get ready! ${drawer ? drawer.name : 'Someone'} is drawing next!`, {
    type: 'get-ready', teamName: team.name, drawerName: drawer ? drawer.name : '',
  });
  // notify the drawer's device specifically to play a sound
  io.to(drawerId).emit('yourTurnComing');

  room.timer = setTimeout(() => startWordChoice(room), DURATIONS.SELECTING);
}

function pickWordOptions(room) {
  const pool = WORD_BANK.filter((w) => !room.usedWords.has(w));
  const source = pool.length >= 3 ? pool : WORD_BANK;
  const options = [];
  const copy = [...source];
  while (options.length < 3 && copy.length > 0) {
    const idx = Math.floor(Math.random() * copy.length);
    options.push(copy.splice(idx, 1)[0]);
  }
  return options;
}

function startWordChoice(room) {
  clearRoomTimer(room);
  room.state = PHASE.WORD_CHOICE;
  room.wordOptions = pickWordOptions(room);
  room.phaseEndTime = Date.now() + DURATIONS.WORD_CHOICE;
  broadcastState(room);
  room.timer = setTimeout(() => {
    // auto-pick if drawer didn't choose
    if (!room.currentWord) {
      const w = room.wordOptions[Math.floor(Math.random() * room.wordOptions.length)];
      chooseWord(room, room.currentDrawerId, w, true);
    }
  }, DURATIONS.WORD_CHOICE);
}

function chooseWord(room, socketId, word, isAuto = false) {
  if (room.state !== PHASE.WORD_CHOICE) return;
  if (socketId !== room.currentDrawerId) return;
  if (!room.wordOptions.includes(word)) return;
  if (room.currentWord) return; // already chosen
  room.currentWord = word;
  room.usedWords.add(word);
  startDrawingPhase(room, isAuto);
}

function startDrawingPhase(room, wasAuto) {
  clearRoomTimer(room);
  room.state = PHASE.DRAWING;
  room.phaseEndTime = Date.now() + DURATIONS.DRAWING;
  room.guessPhaseStartTime = Date.now(); // guessing is live for the whole drawing window
  broadcastState(room);
  if (wasAuto) {
    broadcastToast(room, `Time's up! Word was auto-selected.`, { type: 'auto-word' });
  }
  room.timer = setTimeout(() => endRound(room), DURATIONS.DRAWING);
}

function endRound(room) {
  clearRoomTimer(room);
  room.state = PHASE.ROUND_END;
  room.phaseEndTime = Date.now() + DURATIONS.ROUND_END;
  broadcastState(room);
  broadcastToast(room, `The word was "${room.currentWord}"!`, { type: 'reveal', word: room.currentWord });
  room.timer = setTimeout(() => advanceTurn(room), DURATIONS.ROUND_END);
}

function endGame(room) {
  clearRoomTimer(room);
  room.state = PHASE.GAME_OVER;
  room.currentDrawerId = null;
  room.phaseEndTime = null;
  broadcastState(room);
  broadcastToast(room, `Game over! Check the final scoreboard.`, { type: 'game-over' });
}

// Scoring over the 60s drawing/guessing window, in 10-second buckets:
// guessed within  0–10s -> 50 pts, 10–20s -> 40, 20–30s -> 30, 30–40s -> 20,
// 40–50s -> 10, 50–60s -> 1 pt (floor, never 0 for a correct guess in-window).
function pointsForElapsed(elapsedMs) {
  const elapsedSec = elapsedMs / 1000;
  if (elapsedSec > 60) return 0;
  const bucket = Math.max(1, Math.ceil(elapsedSec / 10)); // 1..6
  return Math.max(1, 60 - bucket * 10);
}

function submitGuess(room, socketId, rawText) {
  if (room.state !== PHASE.DRAWING) return { ignored: true };
  if (socketId === room.currentDrawerId) return { ignored: true };
  const player = room.players.get(socketId);
  if (!player) return { ignored: true };

  // Only the currently-drawing team's own members may guess at all — other
  // teams are spectating this turn and must not be able to post guesses
  // (correct or not) into the shared feed.
  const currentTeamId = room.teamOrder[room.currentTeamIndex];
  if (player.teamId !== currentTeamId) return { ignored: true };

  if (room.correctGuessers.has(socketId)) return { ignored: true }; // already solved

  const text = String(rawText || '').trim();
  if (!text) return { ignored: true };

  const isCorrect = text.toLowerCase() === String(room.currentWord || '').toLowerCase();
  if (!isCorrect) {
    return { correct: false, text };
  }

  const elapsed = Date.now() - room.guessPhaseStartTime;
  const points = pointsForElapsed(elapsed);
  room.correctGuessers.add(socketId);

  const team = room.teams.get(player.teamId);
  if (team) team.score += points;

  return { correct: true, points, text };
}

// ---------------------------------------------------------------------------
// Team helpers
// ---------------------------------------------------------------------------
function addTeam(room, name) {
  const clean = String(name || '').trim().slice(0, 24) || `Team ${room.teams.size + 1}`;
  const id = makeId();
  room.teams.set(id, { id, name: clean, memberIds: new Set(), score: 0 });
  room.teamOrder.push(id);
  return id;
}

function removePlayerFromTeams(room, socketId) {
  for (const t of room.teams.values()) {
    t.memberIds.delete(socketId);
  }
}

// ---------------------------------------------------------------------------
// Socket.io wiring
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('createRoom', ({ name, passcode, teamNames }, cb) => {
    const result = createRoom(socket.id, name, passcode);
    if (result.error) {
      cb && cb({ error: result.error });
      return;
    }
    const room = result.room;
    if (Array.isArray(teamNames) && teamNames.length > 0) {
      teamNames.slice(0, 30).forEach((tn) => {
        if (String(tn || '').trim()) addTeam(room, tn);
      });
    }
    // No default teams — the host adds teams here or later from the lobby.
    joinRoomInternal(room, name, cb, true);
  });

  socket.on('joinRoom', ({ roomId, name }, cb) => {
    const room = getRoom((roomId || '').trim().toLowerCase());
    if (!room) {
      cb && cb({ error: 'Room not found. Check the code/link and try again.' });
      return;
    }
    joinRoomInternal(room, name, cb, false);
  });

  function joinRoomInternal(room, name, cb, isCreator) {
    currentRoomId = room.id;
    socket.join(room.id);
    const player = {
      id: socket.id,
      name: String(name || 'Player').trim().slice(0, 20) || 'Player',
      teamId: null,
    };
    room.players.set(socket.id, player);
    if (isCreator) room.hostId = socket.id;

    cb && cb({ ok: true, roomId: room.id, isHost: room.hostId === socket.id });
    broadcastState(room);
    socket.to(room.id).emit('announcement', { message: `${player.name} joined the room.`, type: 'join' });
  }

  socket.on('createTeam', ({ name }) => {
    const room = getRoom(currentRoomId);
    if (!room) return;
    if (socket.id !== room.hostId) return; // only the host may create teams
    addTeam(room, name);
    broadcastState(room);
  });

  socket.on('joinTeam', ({ teamId }) => {
    const room = getRoom(currentRoomId);
    if (!room) return;
    if (socket.id === room.hostId) return; // the host manages the game, not a team
    const player = room.players.get(socket.id);
    if (!player) return;
    if (!room.teams.has(teamId)) return;
    removePlayerFromTeams(room, socket.id);
    room.teams.get(teamId).memberIds.add(socket.id);
    player.teamId = teamId;
    broadcastState(room);
  });

  socket.on('startGame', ({ totalRounds }, cb) => {
    const room = getRoom(currentRoomId);
    if (!room) return;
    if (socket.id !== room.hostId) {
      cb && cb({ error: 'Only the host can start the game.' });
      return;
    }
    const result = startGame(room, totalRounds);
    cb && cb(result);
  });

  socket.on('chooseWord', ({ word }) => {
    const room = getRoom(currentRoomId);
    if (!room) return;
    chooseWord(room, socket.id, word, false);
  });

  socket.on('draw', (stroke) => {
    const room = getRoom(currentRoomId);
    if (!room) return;
    if (socket.id !== room.currentDrawerId) return;
    if (room.state !== PHASE.DRAWING) return;
    socket.to(room.id).emit('draw', stroke);
  });

  socket.on('clearCanvas', () => {
    const room = getRoom(currentRoomId);
    if (!room) return;
    if (socket.id !== room.currentDrawerId) return;
    if (room.state !== PHASE.DRAWING) return;
    io.to(room.id).emit('clearCanvas');
  });

  socket.on('submitGuess', ({ text }) => {
    const room = getRoom(currentRoomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const result = submitGuess(room, socket.id, text);
    if (result.ignored) return;

    if (result.correct) {
      io.to(room.id).emit('guessResult', {
        playerId: socket.id, playerName: player.name, correct: true, points: result.points,
      });
      broadcastState(room); // updates score + locks their input via correctGuesserIds
      // if everyone on the drawer's team has guessed, end round early
      const team = room.teams.get(player.teamId);
      if (team) {
        const guessableMembers = [...team.memberIds].filter((id) => id !== room.currentDrawerId);
        const allGuessed = guessableMembers.length > 0
          && guessableMembers.every((id) => room.correctGuessers.has(id));
        if (allGuessed) endRound(room);
      }
    } else {
      // broadcast as regular chat/wrong guess (not revealing correctness to others beyond wrong)
      io.to(room.id).emit('chatMessage', { playerId: socket.id, playerName: player.name, text: result.text });
    }
  });

  socket.on('disconnect', () => {
    const room = getRoom(currentRoomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    room.players.delete(socket.id);
    removePlayerFromTeams(room, socket.id);

    if (player) {
      socket.to(room.id).emit('announcement', { message: `${player.name} left the room.`, type: 'leave' });
    }

    if (room.hostId === socket.id) {
      // promote the next connected player to host, and pull them out of any
      // team since the host doesn't play/draw/guess
      const next = [...room.players.keys()][0];
      room.hostId = next || null;
      if (next) {
        removePlayerFromTeams(room, next);
        const nextPlayer = room.players.get(next);
        if (nextPlayer) nextPlayer.teamId = null;
      }
    }

    if (room.currentDrawerId === socket.id && (room.state === PHASE.SELECTING
        || room.state === PHASE.WORD_CHOICE || room.state === PHASE.DRAWING)) {
      broadcastToast(room, 'The drawer disconnected — skipping to the next turn.', { type: 'skip' });
      advanceTurn(room);
      return;
    }

    if (room.players.size === 0) {
      clearRoomTimer(room);
      rooms.delete(room.id);
      return;
    }

    broadcastState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`DrawGuess server running on http://localhost:${PORT}`);
});
