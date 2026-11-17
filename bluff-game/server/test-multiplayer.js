'use strict';
/* Multiplayer integration test — run: node test-multiplayer.js
   Spawns the real server (with short stall timers), connects WebSocket
   clients, and plays full games, including the burn/add decision flow. */
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 18099;
const URL = 'ws://127.0.0.1:' + PORT;
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const rankOf = (card) => RANKS.indexOf(card.slice(0, -1));
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
  waitFor(pred, what, timeout = 9000) {
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
const conserve = (v) => v.players.reduce((n, p) => n + p.count, 0) + v.pileSize + v.burnedCount === 52;

async function main() {
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), RESPOND_TIMEOUT_MS: '2500', DECIDE_TIMEOUT_MS: '2500', PLAY_TIMEOUT_MS: '25000' },
    stdio: 'pipe',
  });
  server.stderr.on('data', d => process.stderr.write('[server] ' + d));
  await sleep(900);
  try {
    /* ============ Room 1: lobby, privacy, full game with a bot ============ */
    const A = new Client('A'); await A.connect();
    const B = new Client('B'); await B.connect();
    const C = new Client('C'); await C.connect();

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

    A.clearMsgs();
    A.send({ type: 'start' });
    const errMin = await A.waitFor(m => m.type === 'error' && /at least 3/.test(m.message), 'min-3 start error');
    ok(!!errMin, 'two players cannot start — minimum is 3 (server-enforced)');

    A.send({ type: 'addBot', difficulty: 'easy' });
    await A.waitFor(m => m.type === 'lobby' && m.players.length === 3, 'bot added');
    ok(true, 'host can add a bot to fill a seat');

    A.clearMsgs(); B.clearMsgs();
    A.send({ type: 'start' });
    const viewA = (await A.waitFor(m => m.type === 'view', 'A first view')).view;
    await B.waitFor(m => m.type === 'view', 'B first view');
    const viewB = B.view;
    ok(viewA.players[0].hand.length >= 8, 'A receives own hand (' + viewA.players[0].hand.length + ' cards)');
    ok(viewA.players[1].hand === undefined && viewA.players[2].hand === undefined, 'A cannot see other hands');
    const bJson = JSON.stringify(viewB);
    ok(viewA.players[0].hand.every(c => !bJson.includes('"' + c + '"')), 'B\'s view contains none of A\'s cards (privacy)');
    ok(conserve(viewA), 'all 52 cards accounted for across players, pile and burned');

    // --- server-side rule enforcement ---
    const turnIdx = viewA.turn;
    const turnClient = turnIdx === 0 ? A : turnIdx === 1 ? B : null;
    const otherHuman = turnIdx === 0 ? B : A;
    if (turnClient) {
      turnClient.clearMsgs();
      const hand = turnClient.view.players[turnIdx].hand;
      turnClient.send({ type: 'play', cards: [hand[0]], declaredRank: 0, actionId: 'open-1' });
      const e = await turnClient.waitFor(m => m.type === 'error' && /at least 2/.test(m.message), 'opening rule error');
      ok(!!e, 'server rejects a 1-card opening play (custom opening rule)');
      turnClient.send({ type: 'play', cards: hand.slice(0, 2), declaredRank: 13, actionId: 'open-bad' });
      const eBad = await turnClient.waitFor(m => m.type === 'error' && /declaration/i.test(m.message), 'bad declaration error');
      ok(!!eBad, 'server rejects an out-of-range declaration');
      otherHuman.clearMsgs();
      const oHand = otherHuman.view.players[otherHuman === A ? 0 : 1].hand;
      otherHuman.send({ type: 'play', cards: oHand.slice(0, 2), declaredRank: 0, actionId: 'oot-1' });
      const e2 = await otherHuman.waitFor(m => m.type === 'error' && /not your turn/.test(m.message), 'out of turn error');
      ok(!!e2, 'server rejects out-of-turn play');
      // Legal opening: declare the two Kings-style — declare a rank the cards
      // may not match (free declaration), then replay the same actionId.
      turnClient.clearMsgs();
      turnClient.send({ type: 'play', cards: hand.slice(0, 2), declaredRank: (rankOf(hand[0]) + 1) % 13, actionId: 'open-2' });
      const v2 = (await turnClient.waitFor(m => m.type === 'view' && m.view.phase === 'respond', 'respond phase')).view;
      ok(v2.lastPlay.rank === (rankOf(hand[0]) + 1) % 13, 'server accepts a free (possibly bluffing) declaration');
      const moveNo = v2.moveNo;
      turnClient.send({ type: 'play', cards: hand.slice(0, 2), declaredRank: 0, actionId: 'open-2' });
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

    // --- play room 1 to completion (policy handles play/respond/decide) ---
    const clients = { 0: A, 1: B2 };
    let over = null, guard = 0;
    while (!over && guard < 900) {
      guard++;
      await sleep(110);
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
          cl.send({ type: 'play', cards: hand.slice(0, n), declaredRank: rankOf(hand[0]), actionId: 'auto-' + guard + '-' + idx });
        } else if (v.phase === 'respond' && v.responder === idx) {
          cl.send({ type: 'respond', action: 'pass', actionId: 'auto-r-' + guard + '-' + idx });
        } else if (v.phase === 'decide' && v.decisionFor === idx) {
          const choice = v.players[idx].count > 6 ? 'add' : 'burn';
          cl.send({ type: 'decide', choice, actionId: 'auto-d-' + guard + '-' + idx });
        }
      }
    }
    ok(!!over && over.phase === 'over' && over.winner !== null, 'full online game (with burn/add decisions) reaches a winner (seat ' + (over && over.winner) + ')');

    A.clearMsgs();
    A.send({ type: 'rematch' });
    const rv = (await A.waitFor(m => m.type === 'view' && m.view.phase === 'play', 'rematch view')).view;
    ok(rv.players.reduce((n, p) => n + p.count, 0) === 52 && rv.moveNo === 0, 'rematch deals a fresh 52-card game');
    A.close(); B2.close(); C.close();

    /* ===== Room 2: the burn/add decision flow, 3 humans (the minimum) ===== */
    const D = new Client('D'); await D.connect();
    const F = new Client('F'); await F.connect();
    const G = new Client('G'); await G.connect();
    D.send({ type: 'create', name: 'Dana' });
    const joinedD = await D.waitFor(m => m.type === 'joined', 'D joined');
    ok(typeof joinedD.roomId === 'string' && joinedD.roomId.length >= 32 && joinedD.roomId !== joinedD.code,
      'room has a separate internal ID distinct from the shareable code');
    F.send({ type: 'join', code: joinedD.code, name: 'Faraz' });
    const joinedF = await F.waitFor(m => m.type === 'joined', 'F joined');
    G.send({ type: 'join', code: joinedD.code, name: 'Gita' });
    const joinedG = await G.waitFor(m => m.type === 'joined', 'G joined');
    const tokens = { [joinedD.idx]: joinedD.token, [joinedF.idx]: joinedF.token, [joinedG.idx]: joinedG.token };
    D.send({ type: 'start' });
    await D.waitFor(m => m.type === 'view', 'D first view');
    await F.waitFor(m => m.type === 'view', 'F first view');
    await G.waitFor(m => m.type === 'view', 'G first view');
    const byIdx = { 0: D, 1: F, 2: G };
    const first = D.view.turn;
    const others = [0, 1, 2].filter(i => i !== first);
    const P = byIdx[first], Q = byIdx[others[0]], R = byIdx[others[1]];
    const joinedByIdx = { [joinedD.idx]: joinedD, [joinedF.idx]: joinedF };
    // Everyone passes in responder order -> decide phase for the maker.
    async function allPass(tag) {
      for (let step = 0; step < 3; step++) {
        const v = P.view;
        if (v.phase === 'decide') return v;
        const resp = v.responder;
        if (resp === null || resp === undefined) break;
        byIdx[resp].send({ type: 'respond', action: 'pass', actionId: tag + '-pass-' + step });
        await sleep(250);
      }
      return (await P.waitFor(m => m.type === 'view' && m.view.phase === 'decide', 'decide view')).view;
    }

    let hand = P.view.players[first].hand;
    P.send({ type: 'play', cards: hand.slice(0, 2), declaredRank: rankOf(hand[0]), actionId: 'r2-play' });
    const decideView = await allPass('r2');
    ok(decideView.decisionFor === first && decideView.pileSize === 2, 'all-pass returns the burn/add decision to the player who played');
    // During the decision: a challenge must be rejected, and a non-owner
    // cannot decide.
    Q.clearMsgs();
    Q.send({ type: 'respond', action: 'check', actionId: 'r2-late-check' });
    const eLate = await Q.waitFor(m => m.type === 'error', 'late challenge error');
    ok(/not possible|not your/i.test(eLate.message), 'challenge during a pending burn/add decision is rejected');
    Q.clearMsgs();
    Q.send({ type: 'decide', choice: 'burn', actionId: 'r2-steal' });
    const eSteal = await Q.waitFor(m => m.type === 'error' && /not your decision/i.test(m.message), 'steal decision error');
    ok(!!eSteal, 'only the decision owner can burn or add');
    // Owner burns — twice with different actionIds: second must fail.
    P.clearMsgs();
    P.send({ type: 'decide', choice: 'burn', actionId: 'r2-burn' });
    const afterBurn = (await P.waitFor(m => m.type === 'view' && m.view.phase === 'play' && m.view.burnedCount === 2, 'post-burn view')).view;
    ok(afterBurn.pileSize === 0 && afterBurn.burnedCount === 2 && afterBurn.turn === first, 'BURN: pile burned, same player opens fresh');
    P.clearMsgs();
    P.send({ type: 'decide', choice: 'burn', actionId: 'r2-burn-again' });
    const eAgain = await P.waitFor(m => m.type === 'error', 'stale decision error');
    ok(!!eAgain, 'a second burn after the decision resolved is rejected (no double-resolve)');
    // Fresh opening must respect min-2, then the ADD flow.
    hand = P.view.players[first].hand;
    P.clearMsgs();
    P.send({ type: 'play', cards: [hand[0]], declaredRank: 0, actionId: 'r2-open-1' });
    const eOpen = await P.waitFor(m => m.type === 'error' && /at least 2/.test(m.message), 'post-burn opening error');
    ok(!!eOpen, 'opening minimum of 2 applies after a burn');
    P.send({ type: 'play', cards: hand.slice(0, 2), declaredRank: rankOf(hand[0]), actionId: 'r2-open-2' });
    await allPass('r2b');
    P.send({ type: 'decide', choice: 'add', actionId: 'r2-add' });
    await P.waitFor(m => m.type === 'view' && m.view.phase === 'play' && m.view.turn === first, 'add returns turn');
    hand = P.view.players[first].hand;
    P.send({ type: 'play', cards: [hand[0]], declaredRank: rankOf(hand[0]), actionId: 'r2-add-play' });
    const grown = (await Q.waitFor(m => m.type === 'view' && m.view.phase === 'respond' && m.view.pileSize === 3, 'grown pile view')).view;
    ok(grown.pileSize === 3 && conserve(grown), 'ADD MORE: pile preserved and grows to 3, cards conserved');
    // P's own view must reach the same state before we read the responder
    // from it — views arrive per-client and P can lag a message behind Q.
    await P.waitFor(m => m.type === 'view' && m.view.phase === 'respond' && m.view.pileSize === 3 && m.view.responder !== null, 'grown pile view (P)');

    // Disconnect during the response cycle: whoever must respond next
    // drops; the 2.5s stall timer auto-passes them, the remaining responder
    // passes, and the decision still reaches the maker.
    const respIdx = P.view.responder;
    byIdx[respIdx].close();
    await sleep(3200); // stall timeout fires -> auto-pass for the dropped player
    await allPass('r2c');
    ok(P.view.phase === 'decide', 'disconnected responder auto-passes after the stall timeout; game not stuck');
    {
      const back = new Client('back'); await back.connect();
      back.send({ type: 'rejoin', code: joinedD.code, token: tokens[respIdx] });
      const bv = (await back.waitFor(m => m.type === 'view', 'rejoin view')).view;
      ok(bv.players[respIdx].hand.length > 0, 'disconnected player rejoins with their hand intact');
      back.close();
    }
    D.close(); F.close(); G.close();

    /* ===== Room 3: capacity, concurrent joins, code collisions ===== */
    {
      const host = new Client('H'); await host.connect();
      host.send({ type: 'create', name: 'Host' });
      const jh = await host.waitFor(m => m.type === 'joined', 'H joined');
      const joiners = [];
      for (let i = 0; i < 5; i++) {
        const c = new Client('J' + i); await c.connect();
        c.send({ type: 'join', code: jh.code, name: 'Guest' + i });
        await c.waitFor(m => m.type === 'joined', 'guest ' + i + ' joined');
        joiners.push(c);
      }
      ok(true, 'six players can join a room (maximum)');
      const seventh = new Client('J7'); await seventh.connect();
      seventh.send({ type: 'join', code: jh.code, name: 'Seventh' });
      const eFull = await seventh.waitFor(m => m.type === 'error' && /full/i.test(m.message), 'full room error');
      ok(!!eFull, 'a seventh player is rejected: room full');
      seventh.close(); host.close(); joiners.forEach(c => c.close());
    }
    {
      // Concurrent joins racing for the last seat: exactly one may succeed.
      const host = new Client('H2'); await host.connect();
      host.send({ type: 'create', name: 'Host2' });
      const jh = await host.waitFor(m => m.type === 'joined', 'H2 joined');
      for (let i = 0; i < 4; i++) {
        const c = new Client('K' + i); await c.connect();
        c.send({ type: 'join', code: jh.code, name: 'Filler' + i });
        await c.waitFor(m => m.type === 'joined', 'filler ' + i + ' joined');
        c.close();
      }
      // NOTE: closed fillers keep their seats (reconnect grace), so the room
      // now has 5 seats taken and exactly 1 free.
      const r1 = new Client('R1'); await r1.connect();
      const r2 = new Client('R2'); await r2.connect();
      r1.send({ type: 'join', code: jh.code, name: 'Racer1' });
      r2.send({ type: 'join', code: jh.code, name: 'Racer2' });
      await sleep(1200);
      const wins = [r1, r2].filter(c => c.joined).length;
      const losses = [r1, r2].filter(c => c.msgs.some(m => m.type === 'error' && /full/i.test(m.message))).length;
      ok(wins === 1 && losses === 1, 'concurrent joins for the last seat: exactly one succeeds (' + wins + ' in, ' + losses + ' rejected)');
      host.close(); r1.close(); r2.close();
    }
    {
      // Fun layer: avatars sync, setAvatar, reaction relay + cooldown + whitelist.
      const H = new Client('H'); await H.connect();
      const G1 = new Client('G1'); await G1.connect();
      const G2 = new Client('G2'); await G2.connect();
      H.send({ type: 'create', name: 'Host', avatar: '🦸' });
      const jh2 = await H.waitFor(m => m.type === 'joined', 'H joined');
      G1.send({ type: 'join', code: jh2.code, name: 'Guest1', avatar: '👩' });
      await G1.waitFor(m => m.type === 'joined', 'G1 joined');
      G2.send({ type: 'join', code: jh2.code, name: 'Guest2', avatar: 'not-an-avatar' });
      await G2.waitFor(m => m.type === 'joined', 'G2 joined');
      const lob = await H.waitFor(m => m.type === 'lobby' && m.players.length === 3, 'fun lobby of 3');
      ok(lob.players[0].avatar === '🦸' && lob.players[1].avatar === '👩', 'chosen avatars appear in the lobby');
      ok(lob.players[2].avatar === '🧑', 'invalid avatar falls back to the default');
      G1.send({ type: 'setAvatar', avatar: '🥷' });
      await H.waitFor(m => m.type === 'lobby' && m.players[1] && m.players[1].avatar === '🥷', 'setAvatar broadcast');
      ok(true, 'setAvatar in the lobby updates everyone');
      H.clearMsgs(); G1.clearMsgs(); G2.clearMsgs();
      H.send({ type: 'reaction', kind: 'phrase', i: 3 });
      const r1 = await G1.waitFor(m => m.type === 'reaction', 'G1 gets reaction', 4000);
      ok(r1.idx === 0 && r1.kind === 'phrase' && r1.i === 3, 'reaction relayed to other players with sender index');
      await G2.waitFor(m => m.type === 'reaction', 'G2 gets reaction', 4000);
      await sleep(300);
      ok(!H.msgs.some(m => m.type === 'reaction'), 'reaction is not echoed back to the sender');
      H.clearMsgs(); G1.clearMsgs();
      H.send({ type: 'reaction', kind: 'emoji', i: 0 });
      await sleep(500);
      ok(!G1.msgs.some(m => m.type === 'reaction'), 'second reaction inside the cooldown is dropped');
      await sleep(2100);
      G1.clearMsgs();
      H.send({ type: 'reaction', kind: 'phrase', i: 99 });
      await sleep(500);
      ok(!G1.msgs.some(m => m.type === 'reaction'), 'out-of-range reaction index is dropped');
      H.send({ type: 'reaction', kind: 'emoji', i: 1 });
      const r2 = await G1.waitFor(m => m.type === 'reaction' && m.kind === 'emoji' && m.i === 1, 'emoji reaction', 4000);
      ok(!!r2, 'emoji reaction relayed after the cooldown');
      H.send({ type: 'start' });
      const fv = (await H.waitFor(m => m.type === 'view', 'fun game view')).view;
      ok(fv.players[0].avatar === '🦸' && fv.players[1].avatar === '🥷', 'avatars are present in game views');
      H.close(); G1.close(); G2.close();
    }
    {
      // Many rooms at once: codes and internal IDs must never collide.
      const codes = new Set(), ids = new Set();
      const hosts = [];
      for (let i = 0; i < 12; i++) {
        const c = new Client('M' + i); await c.connect();
        c.send({ type: 'create', name: 'Maker' + i });
        const j = await c.waitFor(m => m.type === 'joined', 'maker ' + i + ' joined');
        codes.add(j.code); ids.add(j.roomId); hosts.push(c);
      }
      ok(codes.size === 12 && ids.size === 12, '12 simultaneously created rooms: all codes and internal IDs unique');
      hosts.forEach(c => c.close());
    }
  } finally {
    server.kill();
  }
  console.log('\nMultiplayer tests: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('TEST ERROR', e); process.exit(1); });
