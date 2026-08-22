# DrawGuess — Real-Time Multiplayer Drawing & Word-Guessing Game

Full-stack Node.js/Express/Socket.io app. Vanilla HTML/CSS/JS on the frontend —
no build step required.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3000**. To test multiplayer locally, open the
same URL in several tabs (or share your LAN IP / a tunnel like ngrok for
other devices).

Node 18+ recommended. No database — all state lives in server memory
(`Map`s in `server.js`), which is fine for a single-process deployment;
swap in Redis if you need to scale across multiple server instances.

## How it satisfies the spec

### 1. Rooms & teams
- The room creator becomes **host** — the host sets a custom **passcode**
  (e.g. `friday-night`) instead of a random code; that exact passcode is
  what everyone else types into "Join Room". The host is never a member of
  any team — they only manage the game (create teams, start it, watch the
  scoreboard).
- Only the host can create teams (`createTeam` is rejected server-side for
  anyone else) — from the "Teams" box on the Create Room screen before
  hosting, and/or from the lobby team panel any time after. **No default
  teams are auto-created** — if the host adds none, the team list stays
  empty until they add some.
- Players can only pick/join a team that already exists — there's no
  "create team" control in their UI at all, and the server rejects a
  `joinTeam` call from the host.
- Team size is unbounded (a `Set` of member socket ids) for 60+ players
  across many teams; the team panel scrolls independently.
- If the host disconnects, the next connected player is promoted to host
  and automatically pulled out of their team (host still can't be on a team).

### 2. Turn mechanics (all timers are server-authoritative)
Server drives a state machine per room:
`lobby → selecting(10s) → word_choice(10s) → drawing(60s, guessing is live the whole time) → round_end(5s) → (next team) ... → game_over`

- **Selecting (10s)**: server randomly picks a drawer from the current
  team's members — and specifically avoids repeating the same drawer for
  that team's very next turn (so with the default 2 rounds, each team's
  two turns are drawn by two different members, whenever the team has more
  than one player). It broadcasts an announcement + highlights them in the
  team list, and emits `yourTurnComing` **only to that socket**, which
  triggers a Web-Audio beep (and a vibration on supporting mobile devices).
- **Word choice (10s)**: 3 words are sent in the `roomState` payload, but
  the server only *includes* `wordOptions` in the snapshot sent to the
  drawer's own socket — everyone else's snapshot has an empty array, so
  they render "Drawer is choosing a word...". If no `chooseWord` arrives in
  10s, the server auto-picks.
- **Drawing + guessing (60s, combined)**: only the drawer's strokes are
  accepted (`socket.id !== room.currentDrawerId` is rejected server-side,
  not just hidden in the UI) and relayed via `socket.to(room.id).emit('draw', ...)`
  for near-zero-latency sync. Everyone else on the drawer's team can guess
  **the whole 60 seconds** — there's no separate locked "guessing phase"
  afterward; the guess box is live from the moment drawing starts. A synced
  countdown ring (`#timerRing`) is driven by a `phaseEndTime` timestamp from
  the server, so every client's timer agrees regardless of local drift.

### 3. Dynamic scoring (10-second buckets over the 60s window)
`pointsForElapsed()` in `server.js` scores a correct guess by how many
seconds into the 60s drawing window it landed, computed from the server's
own `guessPhaseStartTime` (never trusted from the client):

| Guessed within | Points |
|---|---|
| 0–10s | 50 |
| 10–20s | 40 |
| 20–30s | 30 |
| 30–40s | 20 |
| 40–50s | 10 |
| 50–60s | 1 |
| after 60s / wrong | 0 |

Correct guessers are added to `room.correctGuessers` and locked out of
further guessing/points that round; if the whole team (minus the drawer)
has guessed, the round ends early automatically.

**Guessing is restricted to the currently-drawing team only** — this is
enforced in `submitGuess()` on the server (`player.teamId !== currentTeamId`
is rejected outright, not just hidden client-side), so other teams can't
flood the shared guess feed with noise while they're spectating a turn
that isn't theirs. The guess box is visibly disabled for everyone except
the active team, with a "spectating" placeholder explaining why.

### 4. Anti-cheat / state integrity
Everything that matters — secret word, phase, timers, scores, whose turn it
is, who already guessed — lives only in the `rooms` Map on the server.
Clients only ever receive a filtered, per-socket snapshot
(`roomSnapshot(room, socketId)`), so opening devtools network/WS traffic
never leaks the word to non-drawers.

### 5. UI/UX
- Dark/light toggle (persisted in `localStorage`) via a `data-theme`
  attribute and CSS variables.
- **Turn announcement**: when a new team's turn starts (the 10s "get
  ready" phase), a full-panel overlay shows the team's name in large
  animated text plus every member's name as a chip, with the randomly
  chosen drawer highlighted — visible to the whole room, not just that
  team. At the same moment, the browser speaks it aloud via the Web
  Speech API ("Java Team, get ready!"), with a 🔊/🔇 toggle in the top bar
  (persisted in `localStorage`) for anyone who'd rather mute it.
- Team cards show live member lists, highlight the current drawer with a
  pulsing glow on the active team's card, and mark players who've already
  guessed correctly. Only the host sees the "add team" control; players
  only ever see a "Join this team" button.
- Central canvas with brush color, brush size, eraser, and clear — clear is
  synced to everyone via `clearCanvas`.
- A synced circular countdown + phase pill + round counter sit above the
  canvas; a toast/announcement banner shows turn changes and word reveals;
  a scoreboard strip runs along the bottom; a game-over modal shows the
  final ranked scoreboard.
- Default rounds per team is **2**, editable by the host (1–20) before
  starting.

## Notable implementation choices / things to extend
- Word bank (`WORD_BANK`) is a small built-in list of ~65 easy/medium
  words — swap in a bigger list or a difficulty setting easily.
- One shared canvas per room (classic skribbl-style) — all teams watch the
  same drawer each turn, guess simultaneously, and only the drawer's own
  team scores off that round (guesses are still visible as chat to
  everyone). If you want simultaneous *parallel* drawing per team instead
  of one drawer at a time, split `room.state` per team.
- The "different drawer per round" rule only guarantees the *immediately
  previous* drawer for that team isn't picked again — with exactly 2
  rounds (the default) this reliably gives two different people per team,
  as long as the team has more than one member.
- No persistence — restarting the server clears all rooms. Add Redis/a DB
  if you need rooms to survive restarts or to run multiple server
  processes behind a load balancer (Socket.io's Redis adapter is the
  standard fix for horizontal scaling of the 60+ concurrent players case).
