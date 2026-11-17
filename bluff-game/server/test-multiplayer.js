'use strict';
/* Multiplayer integration test — run: node test-multiplayer.js
   Spawns the real server, connects 3 WebSocket clients (2 humans + checks
   around a server-side bot), and plays a full game. */
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 18099;
const URL = 'ws://127.0.0.1:' + PORT;
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ok - ' + name); }
  else { failed++; console.log('  FAIL - ' + name); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Client {
  constructor(name) { this.name = name; this.msgs = []; this.waiters = []; this.view = null; this.lobby = null; this.joined = null; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        this.msgs.push(m);
        if (m.type === 'view') this.view = m.view;
        if (m.type === 'lobby') this.lobby = m;
        if (m.type === 'joined') this.joined = m;
        this.waiters = this.waiters.filter(w => { if (w.pred(m)) { w.resolve(m); return false; } return true; });
      });
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  waitFor(pred, what, timeout = 8000) {
    const existing = this.msgs.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => reject(new Error(this.name + ' timed out waiting for ' + what)), timeout);
    });
  }
  clearMsgs() { this.msgs = []; }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function main() {
  const server = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
  server.stderr.on('data', d => process.stderr.write('[server] ' + d));
  await sleep(900);
  try {
    const A = new Client('A'); await A.connect();
    const B = new Client('B'); await B.connect();
    const C = new Client('C'); await C.connect();

    // --- create + join ---
    A.send({ type: 'create', name: 'Alice' });
    const joinedA = await A.waitFor(m => m.type === 'joined', 'A joined');
    ok(joinedA.isHost && /^[A-Z2-9]{5}$/.test(joinedA.code), 'host creates room, gets 5-char code ' + joinedA.code);
    const code = joinedA.code;

    C.send({ type: 'join', code: 'ZZZZZ', name: 'Eve' });
    const errC = await C.waitFor(m => m.type === 'error', 'bad code error');
    ok(/Room not found/.test(errC.message), 'invalid room code gives a helpful error');

    B.send({ type: 'join', code, name: 'Bilal' });
    const joinedB = await B.waitFor(m => m.type === 'joined', 'B joined');
    ok(joinedB.idx === 1 && !joinedB.isHost, 'second player joins as non-host');
    await A.waitFor(m => m.type === 'lobby' && m.players.length === 2, 'A sees 2 players in lobby');
    ok(true, 'lobby syncs to all players');

    B.send({ type: 'start' });
    const errB = await B.waitFor(m => m.type === 'error' && /Only the host/.test(m.message), 'non-host start error');
    ok(!!errB, 'non-host cannot start the game');

    A.send({ type: 'addBot', difficulty: 'easy' });
    await A.waitFor(m => m.type === 'lobby' && m.players.length === 3, 'bot added');
    ok(true, 'host can add a bot to fill a seat');

    // --- start ---
    A.clearMsgs(); B.clearMsgs();
    A.send({ type: 'start' });
    const viewA = (await A.waitFor(m => m.type === 'view', 'A first view')).view;
    const viewB = (await B.waitFor(m => m.type === 'view', 'B first view')).view;
    ok(viewA.players[0].hand.length >= 8, 'A receives own hand (' + viewA.players[0].hand.length + ' cards)');
    ok(viewA.players[1].hand === undefined && viewA.players[2].hand === undefined, 'A cannot see other hands');
    const bJson = JSON.stringify(viewB);
    ok(viewA.players[0].hand.every(c => !bJson.includes('"' + c + '"')), 'B\'s view contains none of A\'s cards (privacy)');
    const total = viewA.players.reduce((n, p) => n + p.count, 0);
    ok(total === 52, 'all 52 cards accounted for across players');

    // --- opening rule enforced server-side ---
    const turnIdx = viewA.turn;
    const turnClient = turnIdx === 0 ? A : turnIdx === 1 ? B : null;
    const otherHuman = turnIdx === 0 ? B : A;
    if (turnClient) {
      turnClient.clearMsgs();
      const hand = turnClient.view.players[turnIdx].hand;
      turnClient.send({ type: 'play', cards: [hand[0]], actionId: 'open-1' });
      const e = await turnClient.waitFor(m => m.type === 'error' && /at least 2/.test(m.message), 'opening rule error');
      ok(!!e, 'server rejects a 1-card opening play (custom opening rule)');
      otherHuman.clearMsgs();
      const oHand = otherHuman.view.players[otherHuman === A ? 0 : 1].hand;
      otherHuman.send({ type: 'play', cards: oHand.slice(0, 2), actionId: 'oot-1' });
      const e2 = await otherHuman.waitFor(m => m.type === 'error' && /not your turn/.test(m.message), 'out of turn error');
      ok(!!e2, 'server rejects out-of-turn play');
      // legal opening play, then the SAME action replayed (duplicate protection)
      turnClient.clearMsgs();
      turnClient.send({ type: 'play', cards: hand.slice(0, 2), actionId: 'open-2' });
      const v2 = (await turnClient.waitFor(m => m.type === 'view' && m.view.phase === 'respond', 'respond phase')).view;
      const moveNo = v2.moveNo;
      turnClient.send({ type: 'play', cards: hand.slice(0, 2), actionId: 'open-2' });
      await sleep(500);
      ok(turnClient.view.moveNo === moveNo, 'replayed actionId does not duplicate the move');
    } else {
      ok(true, 'bot opens the game (opening-rule client checks skipped)');
    }

    // --- disconnect + rejoin mid-game ---
    const bToken = joinedB.token, bIdx = joinedB.idx;
    const bHandBefore = B.view.players[bIdx].hand.slice().sort().join(',');
    B.close();
    await sleep(600);
    const B2 = new Client('B2'); await B2.connect();
    B2.send({ type: 'rejoin', code, token: bToken });
    const reView = (await B2.waitFor(m => m.type === 'view', 'B rejoin view')).view;
    ok(reView.players[bIdx].hand.slice().sort().join(',') === bHandBefore, 'reconnect restores the same seat and hand');

    // --- play to completion with a simple always-pass policy ---
    const clients = { 0: A, 1: B2 };
    let over = null, guard = 0;
    const conserve = (v) => v.players.reduce((n, p) => n + p.count, 0) + v.pileSize + v.burnedCount === 52;
    while (!over && guard < 600) {
      guard++;
      await sleep(120);
      for (const [idxStr, cl] of Object.entries(clients)) {
        const idx = Number(idxStr);
        const v = cl.view;
        if (!v) continue;
        if (v.phase === 'over') { over = v; break; }
        if (!conserve(v)) { ok(false, 'card conservation in live views'); over = v; break; }
        if (v.phase === 'play' && v.turn === idx) {
          const hand = v.players[idx].hand;
          const need = v.minPlay || 1;
          const n = Math.min(hand.length, Math.max(need, 2));
          cl.send({ type: 'play', cards: hand.slice(0, n), actionId: 'auto-' + guard + '-' + idx });
        } else if (v.phase === 'respond' && v.responder === idx) {
          cl.send({ type: 'respond', action: 'pass', actionId: 'auto-r-' + guard + '-' + idx });
        }
      }
    }
    ok(!!over && over.phase === 'over' && over.winner !== null, 'full online game reaches a winner (seat ' + (over && over.winner) + ')');
    ok(conserve(A.view) || A.view.phase === 'over', 'final view consistent');

    // --- rematch ---
    A.clearMsgs();
    A.send({ type: 'rematch' });
    const rv = (await A.waitFor(m => m.type === 'view' && m.view.phase === 'play', 'rematch view')).view;
    ok(rv.players.reduce((n, p) => n + p.count, 0) === 52 && rv.moveNo === 0, 'rematch deals a fresh 52-card game');

    A.close(); B2.close(); C.close();
  } finally {
    server.kill();
  }
  console.log('\nMultiplayer tests: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('TEST ERROR', e); process.exit(1); });
