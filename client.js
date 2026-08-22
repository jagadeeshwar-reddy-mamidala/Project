(() => {
  const socket = io();

  // ---------------- State ----------------
  let myId = null;
  let myTeamId = null;
  let latest = null; // last roomState snapshot
  let countdownInterval = null;
  let drawing = false;
  let lastPoint = null;
  let tool = { color: '#1f2937', size: 6, erasing: false };

  // ---------------- DOM refs ----------------
  const $ = (sel) => document.querySelector(sel);
  const entryScreen = $('#entryScreen');
  const gameScreen = $('#gameScreen');
  const entryError = $('#entryError');
  const roomCodeBadge = $('#roomCodeBadge');
  const announcementEl = $('#announcement');

  const teamsList = $('#teamsList');
  const noTeamsNote = $('#noTeamsNote');
  const createTeamRow = $('#createTeamRow');
  const hostControls = $('#hostControls');
  const nonHostWaiting = $('#nonHostWaiting');
  const startGameBtn = $('#startGameBtn');
  const waitingMsg = $('#waitingMsg');
  const shareLink = $('#shareLink');

  const phaseLabel = $('#phaseLabel');
  const roundLabel = $('#roundLabel');
  const timerFg = $('#timerFg');
  const timerText = $('#timerText');
  const drawerBanner = $('#drawerBanner');
  const wordMaskDisplay = $('#wordMaskDisplay');
  const wordChoiceOverlay = $('#wordChoiceOverlay');
  const wordOptionsRow = $('#wordOptionsRow');
  const waitingForWordOverlay = $('#waitingForWordOverlay');
  const turnIntroOverlay = $('#turnIntroOverlay');
  const turnIntroTeamName = $('#turnIntroTeamName');
  const turnIntroMembers = $('#turnIntroMembers');
  const toolBar = $('#toolBar');
  const canvas = $('#drawCanvas');
  const ctx = canvas.getContext('2d');

  const chatFeed = $('#chatFeed');
  const guessForm = $('#guessForm');
  const guessInput = $('#guessInput');
  const guessSendBtn = $('#guessSendBtn');
  const scoreboardBar = $('#scoreboardBar');

  const gameOverModal = $('#gameOverModal');
  const finalScores = $('#finalScores');

  const CIRC = 2 * Math.PI * 20;
  timerFg.style.strokeDasharray = `${CIRC}`;

  // ---------------- Theme ----------------
  const savedTheme = localStorage.getItem('dg-theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  $('#themeToggle').textContent = savedTheme === 'dark' ? '☀️' : '🌙';
  $('#themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('dg-theme', next);
    $('#themeToggle').textContent = next === 'dark' ? '☀️' : '🌙';
  });

  // ---------------- Voice (turn announcements) ----------------
  let voiceEnabled = localStorage.getItem('dg-voice') !== 'off';
  const voiceToggleBtn = $('#voiceToggle');
  voiceToggleBtn.textContent = voiceEnabled ? '🔊' : '🔇';
  voiceToggleBtn.addEventListener('click', () => {
    voiceEnabled = !voiceEnabled;
    localStorage.setItem('dg-voice', voiceEnabled ? 'on' : 'off');
    voiceToggleBtn.textContent = voiceEnabled ? '🔊' : '🔇';
    if (!voiceEnabled && window.speechSynthesis) window.speechSynthesis.cancel();
  });

  function speak(text) {
    if (!voiceEnabled) return;
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel(); // don't stack announcements
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.0;
      utter.pitch = 1.05;
      utter.volume = 1;
      window.speechSynthesis.speak(utter);
    } catch (err) { /* speech not available */ }
  }

  // ---------------- Entry screen tabs ----------------
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $('#createTab').classList.toggle('hidden', tab !== 'create');
      $('#joinTab').classList.toggle('hidden', tab !== 'join');
    });
  });

  // Prefill room id from URL (?room=xxxx) -> switch to Join tab
  const urlParams = new URLSearchParams(window.location.search);
  const prefillRoom = urlParams.get('room');
  if (prefillRoom) {
    document.querySelector('[data-tab="join"]').click();
  }

  function showError(msg) {
    entryError.textContent = msg;
    entryError.classList.remove('hidden');
  }
  function clearError() { entryError.classList.add('hidden'); }

  // ---------------- Create tab: pending teams builder ----------------
  const createNameInput = $('#createName');
  const createPasscodeInput = $('#createPasscode');
  const pendingTeamNameInput = $('#pendingTeamName');
  const pendingTeamsList = $('#pendingTeamsList');
  const createRoomBtn = $('#createRoomBtn');
  let pendingTeams = [];

  function renderPendingTeams() {
    pendingTeamsList.innerHTML = '';
    pendingTeams.forEach((name, idx) => {
      const chip = document.createElement('span');
      chip.className = 'pending-team-chip';
      chip.innerHTML = `${escapeHtml(name)} <button type="button" aria-label="Remove">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        pendingTeams.splice(idx, 1);
        renderPendingTeams();
      });
      pendingTeamsList.appendChild(chip);
    });
  }

  function addPendingTeam() {
    const val = pendingTeamNameInput.value.trim();
    if (!val) return;
    if (pendingTeams.some((t) => t.toLowerCase() === val.toLowerCase())) {
      pendingTeamNameInput.value = '';
      return;
    }
    pendingTeams.push(val);
    pendingTeamNameInput.value = '';
    renderPendingTeams();
  }
  $('#addPendingTeamBtn').addEventListener('click', addPendingTeam);
  pendingTeamNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addPendingTeam(); }
  });

  function updateCreateBtnState() {
    const nameOk = createNameInput.value.trim().length > 0;
    const passOk = createPasscodeInput.value.trim().length >= 3;
    createRoomBtn.disabled = !(nameOk && passOk);
    const hint = $('#createReqHint');
    if (hint) hint.classList.toggle('hidden', nameOk && passOk);
  }
  ['input', 'change', 'keyup', 'paste'].forEach((evt) => {
    createNameInput.addEventListener(evt, () => { clearError(); updateCreateBtnState(); });
    createPasscodeInput.addEventListener(evt, () => { clearError(); updateCreateBtnState(); });
  });
  updateCreateBtnState();

  createRoomBtn.addEventListener('click', () => {
    const name = createNameInput.value.trim();
    const passcode = createPasscodeInput.value.trim();
    if (!name) return showError('Please enter your name.');
    if (passcode.length < 3) return showError('Passcode must be at least 3 characters.');
    createRoomBtn.disabled = true;
    socket.emit('createRoom', { name, passcode, teamNames: pendingTeams }, (res) => {
      createRoomBtn.disabled = false;
      if (res.error) return showError(res.error);
      enterGame(res.roomId);
    });
  });

  // ---------------- Join tab ----------------
  const joinNameInput = $('#joinName');
  const joinRoomIdInput = $('#joinRoomId');
  const joinRoomBtn = $('#joinRoomBtn');

  function updateJoinBtnState() {
    const nameOk = joinNameInput.value.trim().length > 0;
    const codeOk = joinRoomIdInput.value.trim().length >= 3;
    joinRoomBtn.disabled = !(nameOk && codeOk);
    const hint = $('#joinReqHint');
    if (hint) hint.classList.toggle('hidden', nameOk && codeOk);
  }
  ['input', 'change', 'keyup', 'paste'].forEach((evt) => {
    joinNameInput.addEventListener(evt, () => { clearError(); updateJoinBtnState(); });
    joinRoomIdInput.addEventListener(evt, () => { clearError(); updateJoinBtnState(); });
  });
  if (prefillRoom) joinRoomIdInput.value = prefillRoom;
  updateJoinBtnState();

  joinRoomBtn.addEventListener('click', () => {
    const name = joinNameInput.value.trim();
    const roomId = joinRoomIdInput.value.trim().toLowerCase();
    if (!name) return showError('Please enter your name.');
    if (!roomId) return showError('Please enter the passcode.');
    joinRoomBtn.disabled = true;
    socket.emit('joinRoom', { roomId, name }, (res) => {
      joinRoomBtn.disabled = false;
      if (res.error) return showError(res.error);
      enterGame(res.roomId);
    });
  });

  function enterGame(roomId) {
    myId = socket.id;
    entryScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    roomCodeBadge.textContent = `Room: ${roomId}`;
    roomCodeBadge.classList.remove('hidden');
    const link = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    shareLink.value = link;
    window.history.replaceState({}, '', `?room=${roomId}`);
  }

  $('#copyLinkBtn').addEventListener('click', () => {
    shareLink.select();
    navigator.clipboard?.writeText(shareLink.value).catch(() => {});
    $('#copyLinkBtn').textContent = 'Copied!';
    setTimeout(() => { $('#copyLinkBtn').textContent = 'Copy'; }, 1500);
  });

  // ---------------- Team UI ----------------
  $('#createTeamBtn').addEventListener('click', () => {
    const input = $('#newTeamName');
    if (!input.value.trim()) return;
    socket.emit('createTeam', { name: input.value.trim() });
    input.value = '';
  });

  function renderTeams(state) {
    teamsList.innerHTML = '';
    noTeamsNote.classList.toggle('hidden', state.teams.length > 0);
    state.teams.forEach((team) => {
      const card = document.createElement('div');
      card.className = 'team-card';
      if (team.id === myTeamId) card.classList.add('mine');
      if (team.id === state.currentTeamId && state.state !== 'lobby' && state.state !== 'game_over') {
        card.classList.add('active-turn');
      }

      const top = document.createElement('div');
      top.className = 'team-card-top';
      top.innerHTML = `<span>${escapeHtml(team.name)}</span><span class="team-score">${team.score} pts</span>`;
      card.appendChild(top);

      const members = document.createElement('div');
      members.className = 'team-members';
      team.members.forEach((m) => {
        const chip = document.createElement('span');
        chip.className = 'member-chip';
        if (m.id === state.currentDrawerId) chip.classList.add('drawer');
        if (m.id === myId) chip.classList.add('you');
        if (state.correctGuesserIds && state.correctGuesserIds.includes(m.id) && m.id !== state.currentDrawerId) {
          chip.classList.add('guessed');
        }
        chip.textContent = (m.id === state.currentDrawerId ? '✏️ ' : '') + m.name;
        members.appendChild(chip);
      });
      if (team.members.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'muted small';
        empty.textContent = 'No players yet';
        members.appendChild(empty);
      }
      card.appendChild(members);

      // The host manages the game and never joins a team — only non-host
      // players get a join button, and only for teams that aren't already theirs.
      if (!state.isHost) {
        const joinBtn = document.createElement('button');
        joinBtn.className = 'join-team-btn';
        joinBtn.textContent = team.id === myTeamId ? '✓ Your team' : 'Join this team';
        joinBtn.disabled = team.id === myTeamId;
        joinBtn.addEventListener('click', () => socket.emit('joinTeam', { teamId: team.id }));
        card.appendChild(joinBtn);
      }

      teamsList.appendChild(card);
    });
  }

  function renderScoreboard(state) {
    scoreboardBar.innerHTML = '';
    const sorted = [...state.teams].sort((a, b) => b.score - a.score);
    sorted.forEach((t) => {
      const pill = document.createElement('div');
      pill.className = 'score-pill';
      pill.innerHTML = `${escapeHtml(t.name)}<span class="val">${t.score}</span>`;
      scoreboardBar.appendChild(pill);
    });
  }

  // ---------------- Host controls ----------------
  function renderHostControls(state) {
    createTeamRow.classList.toggle('hidden', !state.isHost);
    if (state.isHost) {
      hostControls.classList.remove('hidden');
      nonHostWaiting.classList.add('hidden');
      const anyPlayers = state.teams.some((t) => t.members.length > 0);
      const inLobby = state.state === 'lobby' || state.state === 'game_over';
      startGameBtn.disabled = !anyPlayers || !inLobby;
      waitingMsg.classList.toggle('hidden', anyPlayers);
      waitingMsg.textContent = state.teams.length === 0
        ? 'Create at least one team, then wait for players to join it.'
        : 'Add at least one player to a team to enable Start.';
      startGameBtn.textContent = state.state === 'game_over' ? 'Start New Game' : 'Start Game';
    } else {
      hostControls.classList.add('hidden');
      if (state.state === 'lobby') {
        nonHostWaiting.classList.remove('hidden');
      } else {
        nonHostWaiting.classList.add('hidden');
      }
    }
  }

  startGameBtn.addEventListener('click', () => {
    const totalRounds = parseInt($('#roundsInput').value, 10) || 2;
    startGameBtn.disabled = true;
    socket.emit('startGame', { totalRounds }, (res) => {
      if (res && res.error) {
        showAnnouncement(res.error);
        startGameBtn.disabled = false;
      }
    });
  });

  // ---------------- Phase / timer rendering ----------------
  function phaseText(state) {
    switch (state.state) {
      case 'lobby': return 'Lobby';
      case 'selecting': return 'Get Ready';
      case 'word_choice': return 'Choosing Word';
      case 'drawing': return 'Drawing & Guessing';
      case 'round_end': return 'Round Result';
      case 'game_over': return 'Game Over';
      default: return state.state;
    }
  }

  function updateTimerRing(remainingMs, totalMs) {
    if (totalMs <= 0) {
      timerText.textContent = '--';
      timerFg.style.strokeDashoffset = '0';
      return;
    }
    const frac = Math.max(0, Math.min(1, remainingMs / totalMs));
    timerFg.style.strokeDashoffset = `${CIRC * (1 - frac)}`;
    timerText.textContent = Math.ceil(remainingMs / 1000);
    timerFg.style.stroke = frac < 0.25 ? 'var(--danger)' : 'var(--accent)';
  }

  const PHASE_TOTALS = {
    selecting: 10000, word_choice: 10000, drawing: 60000, round_end: 5000,
  };

  function startCountdown(state) {
    clearInterval(countdownInterval);
    if (!state.phaseEndTime) { updateTimerRing(0, 0); return; }
    const total = PHASE_TOTALS[state.state] || 10000;
    const tick = () => {
      const remaining = state.phaseEndTime - Date.now();
      updateTimerRing(Math.max(0, remaining), total);
      if (remaining <= 0) clearInterval(countdownInterval);
    };
    tick();
    countdownInterval = setInterval(tick, 200);
  }

  // ---------------- Main state renderer ----------------
  function renderState(state) {
    latest = state;
    myTeamId = (state.players.find((p) => p.id === myId) || {}).teamId || null;

    renderTeams(state);
    renderScoreboard(state);
    renderHostControls(state);
    startCountdown(state);

    phaseLabel.textContent = phaseText(state);
    roundLabel.textContent = state.totalRounds ? `Round ${state.currentRound} / ${state.totalRounds}` : '';

    // Drawer banner (word-choice / drawing only — the turn-intro overlay
    // covers the "selecting" moment with a bigger announcement)
    const drawer = state.players.find((p) => p.id === state.currentDrawerId);
    if (drawer && ['word_choice', 'drawing'].includes(state.state)) {
      drawerBanner.textContent = state.youAreDrawer
        ? "🎨 It's your turn to draw!"
        : `🎨 ${drawer.name} is drawing`;
      drawerBanner.classList.remove('hidden');
    } else {
      drawerBanner.classList.add('hidden');
    }

    // Turn intro overlay — big team-name + member-list announcement shown
    // to everyone the moment a new team's turn begins.
    turnIntroOverlay.classList.add('hidden');
    if (state.state === 'selecting') {
      const team = state.teams.find((t) => t.id === state.currentTeamId);
      if (team) {
        turnIntroTeamName.textContent = team.name;
        turnIntroMembers.innerHTML = '';
        team.members.forEach((m) => {
          const chip = document.createElement('span');
          chip.className = 'turn-intro-member-chip' + (m.id === state.currentDrawerId ? ' is-drawer' : '');
          chip.textContent = (m.id === state.currentDrawerId ? '✏️ ' : '') + m.name;
          turnIntroMembers.appendChild(chip);
        });
        turnIntroOverlay.classList.remove('hidden');
      }
      clearLocalCanvas();
    }

    // Word mask / options overlays
    wordChoiceOverlay.classList.add('hidden');
    waitingForWordOverlay.classList.add('hidden');
    wordMaskDisplay.classList.add('hidden');

    if (state.state === 'word_choice') {
      if (state.youAreDrawer && state.wordOptions && state.wordOptions.length) {
        renderWordOptions(state.wordOptions);
        wordChoiceOverlay.classList.remove('hidden');
      } else {
        waitingForWordOverlay.classList.remove('hidden');
      }
    } else if (state.wordMask && state.state === 'drawing') {
      wordMaskDisplay.textContent = state.youAreDrawer ? `Your word: ${state.revealedWord || ''}` : state.wordMask;
      wordMaskDisplay.classList.remove('hidden');
    } else if (state.state === 'round_end' && state.revealedWord) {
      wordMaskDisplay.textContent = `The word was: ${state.revealedWord}`;
      wordMaskDisplay.classList.remove('hidden');
    }

    // Canvas / toolbar access
    const canDraw = state.youAreDrawer && state.state === 'drawing';
    toolBar.classList.toggle('hidden', !canDraw);
    canvas.style.cursor = canDraw ? 'crosshair' : 'default';
    canvas.style.pointerEvents = canDraw ? 'auto' : 'none';

    // Guess input lockdown — guessing is live for the whole 60s drawing
    // phase, but ONLY for members of the team that's currently drawing.
    // Every other team (and the host) is spectating this turn and can't
    // type into the guess box at all — the server enforces this too.
    const iAmDrawer = state.youAreDrawer;
    const alreadyGuessed = state.correctGuesserIds && state.correctGuesserIds.includes(myId);
    const onCurrentTeam = !state.isHost && myTeamId && myTeamId === state.currentTeamId;
    const canGuess = state.state === 'drawing' && onCurrentTeam && !iAmDrawer && !alreadyGuessed;
    guessInput.disabled = !canGuess;
    guessSendBtn.disabled = !canGuess;

    if (state.state === 'lobby') {
      guessInput.placeholder = state.isHost
        ? "You're hosting — sit back and manage the game"
        : 'Waiting for game to start...';
    } else if (state.isHost) {
      guessInput.placeholder = "You're hosting — sit back and manage the game";
    } else if (iAmDrawer) {
      guessInput.placeholder = "You're drawing — can't guess!";
    } else if (!onCurrentTeam) {
      const activeTeam = state.teams.find((t) => t.id === state.currentTeamId);
      guessInput.placeholder = activeTeam
        ? `Only ${activeTeam.name} can guess this round — spectating`
        : 'Spectating this round...';
    } else if (alreadyGuessed) {
      guessInput.placeholder = 'You already guessed correctly!';
    } else if (state.state === 'drawing') {
      guessInput.placeholder = 'Type your guess...';
    } else {
      guessInput.placeholder = 'Waiting for the drawing round to start...';
    }

    if (state.state === 'game_over') {
      showGameOver(state);
    } else {
      gameOverModal.classList.add('hidden');
    }
  }

  function renderWordOptions(options) {
    wordOptionsRow.innerHTML = '';
    options.forEach((w) => {
      const btn = document.createElement('button');
      btn.className = 'word-option-btn';
      btn.textContent = w;
      btn.addEventListener('click', () => {
        socket.emit('chooseWord', { word: w });
        wordChoiceOverlay.classList.add('hidden');
      });
      wordOptionsRow.appendChild(btn);
    });
  }

  function showGameOver(state) {
    const sorted = [...state.teams].sort((a, b) => b.score - a.score);
    finalScores.innerHTML = '';
    sorted.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'final-score-row' + (i === 0 ? ' winner' : '');
      row.innerHTML = `<span>${i === 0 ? '🏆 ' : ''}${escapeHtml(t.name)}</span><span>${t.score} pts</span>`;
      finalScores.appendChild(row);
    });
    gameOverModal.classList.remove('hidden');
  }
  $('#closeGameOverBtn').addEventListener('click', () => gameOverModal.classList.add('hidden'));

  // ---------------- Socket events ----------------
  socket.on('roomState', (state) => renderState(state));

  socket.on('teamsUpdated', () => { /* covered by roomState broadcast to each player */ });

  socket.on('announcement', (data) => {
    showAnnouncement(data.message);
    if (data.type === 'get-ready' && data.teamName) {
      speak(`${data.teamName}, get ready!`);
    }
  });

  socket.on('yourTurnComing', () => {
    playBeep();
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  });

  socket.on('draw', (stroke) => drawStroke(stroke, false));
  socket.on('clearCanvas', () => clearLocalCanvas());

  socket.on('chatMessage', ({ playerName, text }) => {
    addChatLine(`<span class="name">${escapeHtml(playerName)}:</span> ${escapeHtml(text)}`, 'normal');
  });

  socket.on('guessResult', ({ playerName, correct, points }) => {
    if (correct) {
      addChatLine(`<span class="name">${escapeHtml(playerName)}</span> guessed correctly! +${points} pts`, 'correct');
    }
  });

  let announceTimeout = null;
  function showAnnouncement(msg) {
    clearTimeout(announceTimeout);
    announcementEl.textContent = msg;
    announcementEl.classList.remove('hidden');
    announceTimeout = setTimeout(() => announcementEl.classList.add('hidden'), 3200);
  }

  function addChatLine(html, kind) {
    const div = document.createElement('div');
    div.className = 'chat-msg' + (kind === 'correct' ? ' correct' : kind === 'system' ? ' system' : '');
    div.innerHTML = html;
    chatFeed.appendChild(div);
    chatFeed.scrollTop = chatFeed.scrollHeight;
  }

  guessForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = guessInput.value.trim();
    if (!text) return;
    socket.emit('submitGuess', { text });
    guessInput.value = '';
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------- Canvas drawing ----------------
  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const point = e.touches ? e.touches[0] : e;
    return {
      x: (point.clientX - rect.left) * scaleX,
      y: (point.clientY - rect.top) * scaleY,
    };
  }

  function canIDraw() {
    return latest && latest.youAreDrawer && latest.state === 'drawing';
  }

  function beginDraw(e) {
    if (!canIDraw()) return;
    drawing = true;
    lastPoint = getPos(e);
  }
  function moveDraw(e) {
    if (!drawing || !canIDraw()) return;
    e.preventDefault();
    const p = getPos(e);
    const stroke = {
      x0: lastPoint.x, y0: lastPoint.y, x1: p.x, y1: p.y,
      color: tool.erasing ? '#ffffff' : tool.color,
      size: tool.erasing ? tool.size * 3 : tool.size,
    };
    drawStroke(stroke, true);
    socket.emit('draw', stroke);
    lastPoint = p;
  }
  function endDraw() { drawing = false; lastPoint = null; }

  canvas.addEventListener('mousedown', beginDraw);
  canvas.addEventListener('mousemove', moveDraw);
  window.addEventListener('mouseup', endDraw);
  canvas.addEventListener('touchstart', beginDraw, { passive: true });
  canvas.addEventListener('touchmove', moveDraw, { passive: false });
  canvas.addEventListener('touchend', endDraw);

  function drawStroke(stroke) {
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(stroke.x0, stroke.y0);
    ctx.lineTo(stroke.x1, stroke.y1);
    ctx.stroke();
  }

  function clearLocalCanvas() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  clearLocalCanvas();

  $('#colorPicker').addEventListener('input', (e) => {
    tool.color = e.target.value;
    tool.erasing = false;
    $('#eraserBtn').classList.remove('active');
  });
  $('#brushSize').addEventListener('input', (e) => { tool.size = parseInt(e.target.value, 10); });
  $('#eraserBtn').addEventListener('click', () => {
    tool.erasing = !tool.erasing;
    $('#eraserBtn').classList.toggle('active', tool.erasing);
  });
  $('#clearCanvasBtn').addEventListener('click', () => {
    if (!canIDraw()) return;
    clearLocalCanvas();
    socket.emit('clearCanvas');
  });

  // ---------------- Sound (Web Audio beep, no external asset needed) ----------------
  let audioCtx = null;
  function playBeep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.3, audioCtx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
      o.connect(g); g.connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.4);
      // second beep
      setTimeout(() => {
        const o2 = audioCtx.createOscillator();
        const g2 = audioCtx.createGain();
        o2.type = 'sine'; o2.frequency.value = 1046.5;
        g2.gain.setValueAtTime(0.0001, audioCtx.currentTime);
        g2.gain.exponentialRampToValueAtTime(0.3, audioCtx.currentTime + 0.02);
        g2.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.3);
        o2.connect(g2); g2.connect(audioCtx.destination);
        o2.start(); o2.stop(audioCtx.currentTime + 0.35);
      }, 220);
    } catch (err) { /* audio not available */ }
  }
})();
