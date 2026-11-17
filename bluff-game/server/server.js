'use strict';
/*
 * Bluff! multiplayer server.
 * - Serves the web client (../client) over HTTP on the same port.
 * - WebSocket rooms with AUTHORITATIVE game state: the engine runs here,
 *   clients only ever receive their own personalised view (their hand +
 *   public information). Other players' cards are never sent.
 * - Every game action carries an actionId; duplicates are ignored, so a
 *   reconnect or a double-tap can never duplicate a move.
 * - Disconnected players keep their seat (rejoin with a private token).
 *   Response turns auto-pass after 30s and play turns auto-play a simple
 *   legal move after 90s, so one dropped phone never freezes the table.
 *   If a player leaves for good mid-game, their seat becomes a bot.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = require('../engine.js');

const PORT = process.env.PORT || 8080;
/* Stall timers (overridable for tests): a response auto-passes, a play turn
   auto-plays a simple legal move, a burn/add decision auto-burns. */
const RESPOND_TIMEOUT_MS = Number(process.env.RESPOND_TIMEOUT_MS || 30000);
const PLAY_TIMEOUT_MS = Number(process.env.PLAY_TIMEOUT_MS || 90000);
const DECIDE_TIMEOUT_MS = Number(process.env.DECIDE_TIMEOUT_MS || 30000);
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SERVE = new Set(['index.html', 'engine.js', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png']);

const httpServer = http.createServer((req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size })); }
    if (p === '/' || p === '') p = '/index.html';
    const name = path.basename(p);
    if (!SERVE.has(name)) { res.writeHead(404); return res.end('Not found'); }
    fs.readFile(path.join(CLIENT_DIR, name), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) { res.writeHead(400); res.end('Bad request'); }
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 });

/* ---------------- rooms ---------------- */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rooms = new Map();
const BOT_NAMES = ['Zara', 'Omar', 'Felix', 'Priya', 'Boris', 'Luna'];
/* Fun layer (display only — never touches game state): emoji avatars and
   one-tap reactions. Clients send only an INDEX into these fixed lists,
   so no arbitrary text or image can ever be injected. Keep the counts in
   sync with the client (client/index.html: AVATARS / PHRASES / REACTION_EMOJIS). */
const AVATARS = ['🧑', '👨', '👩', '🧕', '👳', '🧔', '😎', '🤠', '🥷', '🦸'];
const BOT_AVATARS = ['🦊', '🐯', '🐼', '🐸', '🦁', '🐨'];
const PHRASE_COUNT = 12;
const REACTION_EMOJI_COUNT = 8;
const REACTION_COOLDOWN_MS = 2000;
function cleanAvatar(a) { return AVATARS.includes(a) ? a : '🧑'; }

function newCode() {
  let code;
  do { code = Array.from(crypto.randomBytes(5)).map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(''); }
  while (rooms.has(code));
  return code;
}
function cleanName(n) {
  const s = String(n || '').replace(/[<>&"']/g, '').trim().slice(0, 16);
  return s || 'Player';
}
function makeRoom(hostName, declarationMode, avatar) {
  const room = {
    id: crypto.randomUUID(), // internal room ID (the code is only the shareable key)
    code: newCode(), seats: [], state: null, started: false,
    declarationMode: declarationMode === 'sequence' ? 'sequence' : 'free',
    hostSeat: 0, lastActivity: Date.now(), botTimer: null, turnTimer: null,
  };
  room.seats.push(makeSeat(hostName, false, undefined, avatar));
  rooms.set(room.code, room);
  return room;
}
function makeSeat(name, isBot, difficulty, avatar) {
  return {
    token: crypto.randomBytes(12).toString('hex'),
    name: cleanName(name), isBot: !!isBot, difficulty: difficulty || 'medium',
    avatar: isBot ? BOT_AVATARS[Math.floor(Math.random() * BOT_AVATARS.length)] : cleanAvatar(avatar),
    lastReactionAt: 0,
    ws: null, connected: false, seenActions: new Set(), actionOrder: [],
  };
}
function seatIdx(room, seat) { return room.seats.indexOf(seat); }
function send(seat, obj) {
  if (seat.ws && seat.ws.readyState === 1) { try { seat.ws.send(JSON.stringify(obj)); } catch (e) {} }
}
function sendError(seat, message) { send(seat, { type: 'error', message }); }

function lobbyPayload(room, forSeat) {
  return {
    type: 'lobby', code: room.code, youIdx: seatIdx(room, forSeat), youAreHost: seatIdx(room, forSeat) === room.hostSeat,
    declarationMode: room.declarationMode,
    players: room.seats.map((s, i) => ({ name: s.name, avatar: s.avatar, isBot: s.isBot, difficulty: s.difficulty, connected: s.connected || s.isBot, isHost: i === room.hostSeat })),
  };
}
function broadcastLobby(room) { for (const s of room.seats) if (!s.isBot) send(s, lobbyPayload(room, s)); }
function broadcastViews(room) {
  if (!room.state) return;
  syncSeatFlags(room);
  for (const s of room.seats) {
    if (s.isBot) continue;
    const v = E.publicView(room.state, seatIdx(room, s));
    v.players.forEach((p, i) => { p.avatar = room.seats[i].avatar; }); // display-only field
    send(s, { type: 'view', view: v });
  }
}
function syncSeatFlags(room) {
  // Keep the engine's player records aligned with seats (names/connection).
  room.state.players.forEach((p, i) => {
    p.name = room.seats[i].name;
    p.connected = room.seats[i].isBot ? true : room.seats[i].connected;
    p.isBot = room.seats[i].isBot;
    p.difficulty = room.seats[i].difficulty;
  });
}
function anyHumanConnected(room) { return room.seats.some(s => !s.isBot && s.connected); }

/* ---------------- game flow ---------------- */
function startGame(room) {
  const defs = room.seats.map(s => ({ name: s.name, isBot: s.isBot, difficulty: s.difficulty }));
  room.state = E.newGame(defs, { declarationMode: room.declarationMode });
  room.started = true;
  room.lastActivity = Date.now();
  broadcastViews(room);
  schedule(room);
}
function currentActor(room) {
  const s = room.state;
  if (!s || s.phase === 'over') return null;
  if (s.phase === 'play') return s.turn;
  if (s.phase === 'respond') return E.currentResponder(s);
  if (s.phase === 'decide') return s.decisionFor;
  return null;
}
function schedule(room) {
  clearTimeout(room.botTimer); clearTimeout(room.turnTimer);
  if (!room.state || room.state.phase === 'over') return;
  if (!anyHumanConnected(room)) return; // pause until someone is watching
  const s = room.state;
  const actor = currentActor(room);
  if (actor === null) return;
  const seat = room.seats[actor];
  if (seat.isBot) {
    room.botTimer = setTimeout(() => botAct(room, actor), 650 + Math.random() * 550);
  } else {
    // Humans get time to think; timers only fire if they stall (or are away).
    const ms = s.phase === 'respond' ? RESPOND_TIMEOUT_MS : s.phase === 'decide' ? DECIDE_TIMEOUT_MS : PLAY_TIMEOUT_MS;
    room.turnTimer = setTimeout(() => autoAct(room, actor), ms);
  }
}
function botAct(room, idx) {
  const s = room.state;
  if (!s || s.phase === 'over') return;
  try {
    if (s.phase === 'play' && s.turn === idx) {
      const bp = E.botPlay(E.publicView(s, idx), idx);
      E.applyPlay(s, idx, bp.cards, bp.rank);
    } else if (s.phase === 'respond' && E.currentResponder(s) === idx) {
      E.applyRespond(s, idx, E.botRespond(E.publicView(s, idx), idx));
    } else if (s.phase === 'decide' && s.decisionFor === idx) {
      E.applyDecision(s, idx, E.botDecide(E.publicView(s, idx), idx));
    } else return;
  } catch (e) { console.error('bot error', e); return; }
  room.lastActivity = Date.now();
  broadcastViews(room);
  schedule(room);
}
function autoAct(room, idx) {
  const s = room.state;
  if (!s || s.phase === 'over') return;
  const seat = room.seats[idx];
  try {
    if (s.phase === 'respond' && E.currentResponder(s) === idx) {
      E.applyRespond(s, idx, 'pass'); // stalled response = pass
    } else if (s.phase === 'decide' && s.decisionFor === idx) {
      E.applyDecision(s, idx, 'burn'); // stalled decision = burn the pile (safe default)
    } else if (s.phase === 'play' && s.turn === idx) {
      // Stalled turn: play a simple legal move for them (easy-bot logic).
      const v = E.publicView(s, idx);
      const saved = v.players[idx].difficulty; v.players[idx].difficulty = 'easy';
      const bp = E.botPlay(v, idx); v.players[idx].difficulty = saved;
      E.applyPlay(s, idx, bp.cards, bp.rank);
    } else return;
  } catch (e) { console.error('auto-act error', e); return; }
  if (seat) send(seat, { type: 'error', message: 'You were away, so the game moved for you.' });
  broadcastViews(room);
  schedule(room);
}
function dedupe(seat, actionId) {
  if (!actionId) return false; // no id: treat as new (still validated by engine)
  if (seat.seenActions.has(actionId)) return true;
  seat.seenActions.add(actionId); seat.actionOrder.push(actionId);
  if (seat.actionOrder.length > 200) seat.seenActions.delete(seat.actionOrder.shift());
  return false;
}

/* ---------------- connection handling ---------------- */
wss.on('connection', (ws) => {
  let room = null, seat = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try { handle(msg); } catch (e) { console.error('handle error', e); if (seat) sendError(seat, 'Something went wrong on the server.'); }

    function handle(m) {
      switch (m.type) {
        case 'create': {
          if (room) return sendError(seat || { ws }, 'Already in a room.');
          room = makeRoom(m.name, m.declarationMode, m.avatar);
          seat = room.seats[0];
          seat.ws = ws; seat.connected = true;
          send(seat, { type: 'joined', code: room.code, roomId: room.id, idx: 0, token: seat.token, isHost: true });
          broadcastLobby(room);
          break;
        }
        case 'join': {
          const r = rooms.get(String(m.code || '').toUpperCase());
          if (!r) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found. Check the code and try again.' })); return; }
          // Rejoin with token?
          if (m.token) {
            const existing = r.seats.find(s => !s.isBot && s.token === m.token);
            if (existing) { attach(r, existing); return; }
          }
          if (r.started) { ws.send(JSON.stringify({ type: 'error', message: 'That game has already started. Ask the host for a new room.' })); return; }
          if (r.seats.length >= 6) { ws.send(JSON.stringify({ type: 'error', message: 'That room is full (6 players max).' })); return; }
          room = r;
          seat = makeSeat(m.name, false, undefined, m.avatar);
          room.seats.push(seat);
          attach(room, seat, true);
          break;
        }
        case 'rejoin': {
          const r = rooms.get(String(m.code || '').toUpperCase());
          if (!r || !m.token) { ws.send(JSON.stringify({ type: 'error', message: 'Could not find your seat in that room.' })); return; }
          const existing = r.seats.find(s => !s.isBot && s.token === m.token);
          if (!existing) { ws.send(JSON.stringify({ type: 'error', message: 'Could not find your seat in that room.' })); return; }
          attach(r, existing);
          break;
        }
        case 'setAvatar': {
          // Lobby-only cosmetic change; validated against the fixed list.
          if (!room || !seat || room.started) return;
          seat.avatar = cleanAvatar(m.avatar);
          broadcastLobby(room);
          break;
        }
        case 'reaction': {
          // One-tap fun reaction: an index into the fixed phrase/emoji
          // lists, relayed to the OTHER seats only. Per-seat cooldown
          // stops spam. Carries no game information whatsoever.
          if (!room || !seat) return;
          const kind = m.kind === 'emoji' ? 'emoji' : 'phrase';
          const limit = kind === 'emoji' ? REACTION_EMOJI_COUNT : PHRASE_COUNT;
          if (!Number.isInteger(m.i) || m.i < 0 || m.i >= limit) return;
          const now = Date.now();
          if (now - seat.lastReactionAt < REACTION_COOLDOWN_MS) return;
          seat.lastReactionAt = now;
          const idx = seatIdx(room, seat);
          for (const s of room.seats) if (!s.isBot && s !== seat) send(s, { type: 'reaction', idx, kind, i: m.i });
          break;
        }
        case 'addBot': {
          if (!room || !seat) return;
          if (seatIdx(room, seat) !== room.hostSeat) return sendError(seat, 'Only the host can add bots.');
          if (room.started) return sendError(seat, 'The game has already started.');
          if (room.seats.length >= 6) return sendError(seat, 'Room is full (6 players max).');
          const diff = ['easy', 'medium', 'hard'].includes(m.difficulty) ? m.difficulty : 'medium';
          const name = BOT_NAMES.find(n => !room.seats.some(s => s.name === n)) || ('Bot ' + room.seats.length);
          room.seats.push(makeSeat(name, true, diff));
          broadcastLobby(room);
          break;
        }
        case 'removeBot': {
          if (!room || !seat) return;
          if (seatIdx(room, seat) !== room.hostSeat) return sendError(seat, 'Only the host can remove bots.');
          if (room.started) return sendError(seat, 'The game has already started.');
          const target = room.seats[m.idx];
          if (target && target.isBot) { room.seats.splice(m.idx, 1); broadcastLobby(room); }
          break;
        }
        case 'start': {
          if (!room || !seat) return;
          if (seatIdx(room, seat) !== room.hostSeat) return sendError(seat, 'Only the host can start the game.');
          if (room.started) return sendError(seat, 'The game has already started.');
          if (room.seats.length < 3) return sendError(seat, 'Need at least 3 players to start. Invite more friends or add bots to fill seats.');
          startGame(room);
          break;
        }
        case 'play': {
          if (!room || !seat || !room.state) return;
          if (dedupe(seat, m.actionId)) return; // duplicate request: ignore silently
          const idx = seatIdx(room, seat);
          const declaredRank = Number.isInteger(m.declaredRank) ? m.declaredRank : -1;
          try { E.applyPlay(room.state, idx, Array.isArray(m.cards) ? m.cards.slice(0, 4) : [], declaredRank); }
          catch (e) { return sendError(seat, friendlyErr(e)); }
          room.lastActivity = Date.now();
          broadcastViews(room); schedule(room);
          break;
        }
        case 'decide': {
          if (!room || !seat || !room.state) return;
          if (dedupe(seat, m.actionId)) return;
          const idx = seatIdx(room, seat);
          try { E.applyDecision(room.state, idx, m.choice === 'add' ? 'add' : 'burn'); }
          catch (e) { return sendError(seat, friendlyErr(e)); }
          room.lastActivity = Date.now();
          broadcastViews(room); schedule(room);
          break;
        }
        case 'respond': {
          if (!room || !seat || !room.state) return;
          if (dedupe(seat, m.actionId)) return;
          const idx = seatIdx(room, seat);
          try { E.applyRespond(room.state, idx, m.action === 'check' ? 'check' : 'pass'); }
          catch (e) { return sendError(seat, friendlyErr(e)); }
          room.lastActivity = Date.now();
          broadcastViews(room); schedule(room);
          break;
        }
        case 'rematch': {
          if (!room || !seat) return;
          if (seatIdx(room, seat) !== room.hostSeat) return sendError(seat, 'Only the host can start a rematch.');
          if (!room.state || room.state.phase !== 'over') return sendError(seat, 'The game is not over yet.');
          startGame(room);
          break;
        }
        case 'leave': {
          if (!room || !seat) return;
          leaveRoom();
          break;
        }
      }
    }
    function attach(r, s, isNew) {
      room = r; seat = s;
      if (seat.ws && seat.ws !== ws) { try { seat.ws.close(); } catch (e) {} }
      seat.ws = ws; seat.connected = true;
      send(seat, { type: 'joined', code: room.code, roomId: room.id, idx: seatIdx(room, seat), token: seat.token, isHost: seatIdx(room, seat) === room.hostSeat });
      if (room.started && room.state) { broadcastViews(room); schedule(room); }
      else broadcastLobby(room);
      if (isNew) room.lastActivity = Date.now();
    }
    function leaveRoom() {
      const r = room, s = seat;
      room = null; seat = null;
      if (!r || !s) return;
      const idx = seatIdx(r, s);
      s.ws = null; s.connected = false;
      if (!r.started) {
        r.seats.splice(idx, 1);
        if (idx === r.hostSeat) { const nh = r.seats.findIndex(x => !x.isBot); r.hostSeat = nh >= 0 ? nh : 0; }
        if (r.seats.length === 0) { rooms.delete(r.code); return; }
        broadcastLobby(r);
      } else {
        // Mid-game departure: the seat becomes a bot so the game can finish.
        s.isBot = true; s.difficulty = 'medium';
        if (idx === r.hostSeat) { const nh = r.seats.findIndex(x => !x.isBot); r.hostSeat = nh >= 0 ? nh : 0; }
        broadcastViews(r); schedule(r);
      }
    }
    ws._leaveRoom = leaveRoom;
    ws._detach = () => {
      if (!room || !seat) return;
      seat.connected = false;
      if (seat.ws === ws) seat.ws = null;
      if (room.started) { broadcastViews(room); schedule(room); }
      else broadcastLobby(room);
    };
  });
  ws.on('close', () => { if (ws._detach) ws._detach(); });
});

function friendlyErr(e) {
  const map = {
    OPENING_MIN_TWO: 'Opening play on an empty pile needs at least 2 cards.',
    NOT_YOUR_TURN: 'It is not your turn yet.',
    NOT_YOUR_RESPONSE: 'Wait for your turn to respond.',
    CARD_NOT_IN_HAND: 'That card is not in your hand.',
    BAD_COUNT: 'You can play 1 to 4 cards.',
    DUPLICATE_CARD: 'Pick each card only once.',
    WRONG_PHASE: 'That move is not possible right now.',
    BAD_DECLARATION: 'That declaration is not allowed right now.',
    NOT_YOUR_DECISION: 'It is not your decision to make.',
  };
  return map[e.code] || 'Move not allowed.';
}

/* Room cleanup: drop rooms idle for 45+ minutes with nobody connected. */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > 45 * 60 * 1000 && !anyHumanConnected(room)) rooms.delete(code);
  }
}, 60 * 1000);

httpServer.listen(PORT, () => {
  console.log('Bluff! server listening on port ' + PORT + ' (HTTP client + WebSocket on the same port)');
});
