'use strict';
/* Engine unit tests — run: node test-engine.js */
const E = require('./engine.js');
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.log('FAIL: ' + name); }
}
function throwsCode(fn, code, name) {
  try { fn(); failed++; console.log('FAIL (no throw): ' + name); }
  catch (e) { ok(e.code === code, name + ' (got ' + e.code + ')'); }
}
function rig(hands, opts) {
  opts = opts || {};
  const players = hands.map((h, i) => ({
    idx: i, id: 'p' + i, name: 'P' + i, isBot: false, difficulty: 'medium',
    connected: true, hand: h.slice(),
  }));
  return {
    players,
    rules: { declarationMode: opts.mode || 'free' },
    pile: opts.pile || [], burned: opts.burned || [],
    phase: 'play', turn: opts.turn || 0,
    expectedRank: opts.expectedRank !== undefined ? opts.expectedRank : null,
    lastPlay: null, respondQueue: [], decisionFor: null, pendingWin: null, winner: null,
    revealedCards: [], round: 1, log: [], moveNo: 0,
  };
}
function rigPlayers(s, hands) {
  s.players = hands.map((h, i) =>
    ({ idx: i, id: 'p' + i, name: 'P' + i, isBot: false, difficulty: 'medium', connected: true, hand: h.slice() }));
  return s;
}

/* --- Deck --- */
{
  const d = E.createDeck();
  ok(d.length === 52, 'deck has 52 cards');
  ok(new Set(d).size === 52, 'deck cards unique');
  ok(d.every(c => { const p = E.parseCard(c); return p.rank >= 0 && p.rank <= 12 && p.suit >= 0 && p.suit <= 3; }), 'all cards valid rank/suit, no jokers');
}

/* --- Dealing + conservation for 2..6 players --- */
for (let n = 2; n <= 6; n++) {
  const defs = Array.from({ length: n }, (_, i) => ({ name: 'P' + i }));
  const s = E.newGame(defs, { rng: E.mulberry32(100 + n) });
  ok(E.assertConservation(s), 'conservation after deal, ' + n + ' players');
  const counts = s.players.map(p => p.hand.length);
  ok(Math.max(...counts) - Math.min(...counts) <= 1, 'deal is even, ' + n + ' players');
}

/* --- Exact distribution + fair rotation of extra cards --- */
{
  const EXPECTED = { 2: [26, 26], 3: [18, 17, 17], 4: [13, 13, 13, 13], 5: [11, 11, 10, 10, 10], 6: [9, 9, 9, 9, 8, 8] };
  const fullDeck = new Set(E.createDeck());
  for (let n = 2; n <= 6; n++) {
    const defs = Array.from({ length: n }, (_, i) => ({ name: 'P' + i }));
    let exactEveryTime = true, allCardsOnce = true;
    for (let g = 0; g < 60; g++) {
      const s = E.newGame(defs, { rng: E.mulberry32(7000 + n * 1000 + g) });
      const counts = s.players.map(p => p.hand.length).sort((a, b) => b - a);
      if (JSON.stringify(counts) !== JSON.stringify(EXPECTED[n])) exactEveryTime = false;
      const dealt = s.players.flatMap(p => p.hand);
      if (dealt.length !== 52 || new Set(dealt).size !== 52 || !dealt.every(c => fullDeck.has(c))) allCardsOnce = false;
    }
    ok(exactEveryTime, 'exact distribution ' + EXPECTED[n].join('/') + ' over 60 deals, ' + n + ' players');
    ok(allCardsOnce, 'every card dealt exactly once, ' + n + ' players');
  }
  // Fairness: over 600 deals the extra card(s) must rotate across all seats.
  for (const [n, big] of [[3, 18], [5, 11], [6, 9]]) {
    const defs = Array.from({ length: n }, (_, i) => ({ name: 'P' + i }));
    const bigCount = new Array(n).fill(0);
    for (let g = 0; g < 600; g++) {
      const s = E.newGame(defs, { rng: E.mulberry32(31000 + n * 10000 + g) });
      s.players.forEach(p => { if (p.hand.length === big) bigCount[p.idx]++; });
    }
    const expected = 600 * (52 % n) / n;
    ok(bigCount.every(c => c > expected * 0.55 && c < expected * 1.45),
      'extra cards rotate fairly, ' + n + ' players (per-seat ' + bigCount.join('/') + ', expected ~' + Math.round(expected) + ')');
    ok(bigCount[0] < 600, 'extra card not always to seat 0, ' + n + ' players');
  }
}

/* --- Opening rule --- */
{
  const s = rig([['AS', 'AH', '5C', '9D'], ['2S', '3S', '4S']]);
  throwsCode(() => E.applyPlay(s, 0, ['AS'], 0), 'OPENING_MIN_TWO', 'opening with 1 card rejected');
  E.applyPlay(s, 0, ['AS', 'AH'], 0);
  ok(s.pile.length === 1 && s.phase === 'respond', 'opening with 2 cards accepted');
}
{
  const s = rig([['AS', 'AH', 'AD', '9D'], ['2S', '3S']]);
  E.applyPlay(s, 0, ['AS', 'AH', 'AD'], 0);
  ok(s.lastPlay.count === 3, 'opening with 3 cards accepted');
}
{
  const s = rig([['AS'], ['2S', '3S', '4S', '5S', '6S', '7S', '8S', '9S', '10S', 'JS', 'QS', 'KS',
    '2H', '3H', '4H', '5H', '6H', '7H', '8H', '9H', '10H', 'JH', 'QH', 'KH',
    '2D', '3D', '4D', '5D', '6D', '7D', '8D', '9D', '10D', 'JD', 'QD', 'KD',
    '2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C', '10C', 'JC', 'QC', 'KC', 'AH', 'AD', 'AC']]);
  E.applyPlay(s, 0, ['AS'], 0);
  ok(s.pendingWin === 0, 'single-card holder may open with 1 card');
}
{
  const s = rig([['5C', '9D', '2H'], ['2S', '3S', '4S']],
    { pile: [{ cards: ['AS', 'AH'], by: 1, rank: 0, count: 2, four: false }] });
  s.lastPlay = s.pile[0];
  E.applyPlay(s, 0, ['2H'], 1);
  ok(s.lastPlay.count === 1, 'mid-round 1-card play allowed');
}
/* --- Illegal moves --- */
{
  const s = rig([['AS', 'AH', '5C'], ['2S', '3S', '4S']]);
  throwsCode(() => E.applyPlay(s, 1, ['2S', '3S'], 0), 'NOT_YOUR_TURN', 'out-of-turn play rejected');
  throwsCode(() => E.applyPlay(s, 0, ['AS', 'AS'], 0), 'DUPLICATE_CARD', 'duplicate card in one play rejected');
  throwsCode(() => E.applyPlay(s, 0, ['AS', 'KS'], 0), 'CARD_NOT_IN_HAND', 'card not in hand rejected');
  throwsCode(() => E.applyPlay(s, 0, ['AS', 'AH', '5C', '2S', '3S'], 0), 'BAD_COUNT', 'playing 5 cards rejected');
  throwsCode(() => E.applyPlay(s, 0, ['AS', 'AH'], 99), 'BAD_DECLARATION', 'invalid declaration rank rejected');
  throwsCode(() => E.applyRespond(s, 1, 'pass'), 'WRONG_PHASE', 'respond during play phase rejected');
  throwsCode(() => E.applyDecision(s, 0, 'burn'), 'WRONG_PHASE', 'decision during play phase rejected');
}

/* --- NEW: free declarations (select Kings, declare Queens) --- */
{
  const s = rig([['KS', 'KH', '5C'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['KS', 'KH'], 11); // actual Kings, declared Queens
  ok(s.lastPlay.rank === 11 && s.lastPlay.cards.join() === 'KS,KH', 'declaration stored separately from actual cards');
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === false, 'challenge compares ACTUAL cards to declaration: K,K declared as Q is a bluff');
  ok(res.revealed.join() === 'KS,KH', 'challenge reveals the actual Kings');
  ok(s.players[0].hand.length === 3, 'caught bluffer takes the pile');
}
{
  const s = rig([['KS', 'KH', '5C'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['KS', 'KH'], 12); // declared Kings honestly
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === true, 'K,K declared as Kings is honest');
  ok(s.players[1].hand.length === 5, 'checker takes pile on honest play');
}
/* --- NEW: sequence mode declarations --- */
{
  const s = rig([['7S', '7H', '8C', '9D'], ['2S', '3S', '4S']], { mode: 'sequence' });
  E.applyPlay(s, 0, ['7S', '7H'], 6); // round opens: any rank allowed, declares 7s
  ok(s.expectedRank === 7, 'sequence mode: next declaration must be 8s');
  E.applyRespond(s, 1, 'pass');
  ok(s.phase === 'decide' && s.decisionFor === 0, 'all pass leads to decision in sequence mode too');
  E.applyDecision(s, 0, 'add');
  throwsCode(() => E.applyPlay(s, 0, ['9D'], 8), 'BAD_DECLARATION', 'sequence mode rejects declaring 9s when 8s are due');
  E.applyPlay(s, 0, ['8C'], 7);
  ok(s.lastPlay.rank === 7, 'sequence mode accepts the due rank');
}

/* --- Challenge outcomes (classic) --- */
{
  const s = rig([['AS', 'AH', '9C'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['AS', 'AH'], 0);
  ok(E.currentResponder(s) === 1, 'responder is next player');
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === true && s.players[1].hand.length === 5, 'honest play: checker takes pile');
  ok(s.pile.length === 0 && s.turn === 0 && s.phase === 'play', 'honest player leads next round');
}
{
  const s = rig([['AS', '9C', '9D'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['AS', '9C'], 0);
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === false && s.players[0].hand.length === 3 && s.turn === 1, 'bluff: player takes pile, checker leads');
}

/* --- NEW: all-pass -> decide -> ADD -> decide again -> BURN --- */
{
  const s = rigPlayers(rig([[], [], []]), [['AS', 'AH', '9C', '4D', '5D'], ['2S', '3S', '5S'], ['6D', '7D', '8D']]);
  E.applyPlay(s, 0, ['AS', 'AH'], 0);
  E.applyRespond(s, 1, 'pass');
  ok(s.phase === 'respond' && E.currentResponder(s) === 2, 'responses proceed in turn order');
  E.applyRespond(s, 2, 'pass');
  ok(s.phase === 'decide' && s.decisionFor === 0, 'all pass: decision returns to the player who played');
  ok(E.pileSize(s) === 2, 'pile intact during decision');
  throwsCode(() => E.applyRespond(s, 1, 'check'), 'WRONG_PHASE', 'challenge during a pending decision is rejected');
  throwsCode(() => E.applyDecision(s, 1, 'burn'), 'NOT_YOUR_DECISION', 'only the decision owner may decide');
  // ADD MORE CARDS
  E.applyDecision(s, 0, 'add');
  ok(s.phase === 'play' && s.turn === 0, 'ADD returns the same player to play');
  E.applyPlay(s, 0, ['9C'], 8); // adds a 9, declares 9s (free mode)
  ok(E.pileSize(s) === 3 && s.lastPlay.count === 1 && s.lastPlay.rank === 8, 'ADD grows the pile and records the new declaration');
  E.applyRespond(s, 1, 'pass');
  E.applyRespond(s, 2, 'pass');
  ok(s.phase === 'decide' && s.decisionFor === 0, 'decision repeats after another all-pass');
  // BURN PILE
  E.applyDecision(s, 0, 'burn');
  ok(s.pile.length === 0 && s.burned.length === 3, 'BURN moves the whole pile to the burned zone');
  ok(s.phase === 'play' && s.turn === 0, 'burner starts the fresh play');
  ok(!s.players.some(p => p.hand.some(c => s.burned.includes(c))), 'burned cards are in no hand');
  throwsCode(() => E.applyPlay(s, 0, ['4D'], 3), 'OPENING_MIN_TWO', 'opening minimum of 2 applies after a burn');
  E.applyPlay(s, 0, ['4D', '5D'], 3);
  ok(s.phase === 'respond' && s.pendingWin === 0, 'fresh play after burn proceeds (and happens to be a final play)');
}

/* --- Four-of-a-kind --- */
{
  const s = rig([['QS', 'QH', 'QD', 'QC', '3C'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['QS', 'QH', 'QD', 'QC'], 11);
  ok(s.lastPlay.four === true, 'four play flagged');
  E.applyRespond(s, 1, 'pass');
  ok(s.burned.length === 4 && s.pile.length === 0, 'believed four-of-a-kind burns the pile automatically');
  ok(s.phase === 'play' && s.turn === 0, 'four: no decision phase, four-player opens fresh');
}
{
  const s = rig([['QS', 'QH', 'QD', 'QC', '3C'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['QS', 'QH', 'QD', 'QC'], 11);
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === true && s.burned.length === 0 && s.players[1].hand.length === 7, 'checked genuine four: checker takes pile, no burn');
}
{
  const s = rig([['QS', 'QH', 'QD', '9C', '3C'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['QS', 'QH', 'QD', '9C'], 11);
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === false && s.players[0].hand.length === 5, 'bluffed four: player takes pile');
}

/* --- Final play --- */
{
  const s = rig([['AS', 'AH'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['AS', 'AH'], 0);
  ok(s.pendingWin === 0 && s.phase === 'respond', 'final play does not win immediately');
  E.applyRespond(s, 1, 'pass');
  ok(s.phase === 'over' && s.winner === 0, 'final play surviving all-pass wins (no burn/add decision)');
}
{
  const s = rig([['AS', '9H'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['AS', '9H'], 0);
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === false && s.phase !== 'over' && s.players[0].hand.length === 2, 'caught final bluff: no win, takes pile');
}
{
  const s = rig([['AS', 'AH'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['AS', 'AH'], 0);
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === true && s.phase === 'over' && s.winner === 0, 'honest final play wins even when checked');
}
{
  // Final card played via ADD MORE CARDS, then survives.
  const s = rig([['AS', 'AH', '9C'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['AS', 'AH'], 0);
  E.applyRespond(s, 1, 'pass');
  ok(s.phase === 'decide', 'decision reached with one card left');
  E.applyDecision(s, 0, 'add');
  E.applyPlay(s, 0, ['9C'], 8);
  ok(s.pendingWin === 0, 'ADD can play the final card');
  E.applyRespond(s, 1, 'pass');
  ok(s.phase === 'over' && s.winner === 0, 'final card via ADD wins when it survives');
}
/* --- Only the current responder may respond --- */
{
  const s = rigPlayers(rig([[], [], []]), [['AS', 'AH', '9C'], ['2S', '3S', '4S'], ['5D', '6D', '7D']]);
  E.applyPlay(s, 0, ['AS', 'AH'], 0);
  throwsCode(() => E.applyRespond(s, 2, 'check'), 'NOT_YOUR_RESPONSE', 'out-of-order response rejected');
  throwsCode(() => E.applyRespond(s, 0, 'pass'), 'NOT_YOUR_RESPONSE', 'player cannot respond to own play');
}

/* --- Repeated burn/add cycles stay stable (no state drift) --- */
{
  const deck = E.createDeck();
  const hands = [deck.slice(0, 20), deck.slice(20, 36), deck.slice(36)];
  const s = rigPlayers(rig([[], [], []]), hands);
  for (let cycle = 0; cycle < 5; cycle++) {
    const turnPlayer = s.turn;
    const hand = s.players[turnPlayer].hand;
    const n = Math.min(hand.length, E.pileSize(s) === 0 ? 2 : 1);
    E.applyPlay(s, turnPlayer, hand.slice(0, n), cycle % 13);
    for (let k = 1; k < 3; k++) E.applyRespond(s, (turnPlayer + k) % 3, 'pass');
    ok(s.phase === 'decide' && s.decisionFor === turnPlayer, 'cycle ' + cycle + ': decision returns to maker');
    E.applyDecision(s, turnPlayer, cycle % 2 === 0 ? 'add' : 'burn');
    E.assertConservation(s);
  }
  ok(true, 'five repeated burn/add cycles conserve all 52 cards');
}

/* --- Privacy: public view never leaks other hands --- */
{
  const defs = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  const s = E.newGame(defs, { rng: E.mulberry32(7) });
  const viewB = E.publicView(s, 1);
  const aCards = s.players[0].hand, cCards = s.players[2].hand;
  const json = JSON.stringify(viewB);
  ok(aCards.every(c => !json.includes('"' + c + '"')), 'view for B contains none of A\'s cards');
  ok(cCards.every(c => !json.includes('"' + c + '"')), 'view for B contains none of C\'s cards');
  ok(viewB.players[1].hand.length === s.players[1].hand.length, 'view includes own hand');
  ok(viewB.players[0].hand === undefined && viewB.players[0].count === aCards.length, 'others shown as counts only');
  ok(viewB.declarationMode === 'free', 'view exposes the declaration mode');
}

/* --- Bots: certain bluff detection + decision sanity --- */
{
  const view = {
    phase: 'respond', lastPlay: { by: 0, count: 3, rank: 11, four: false },
    pendingWin: null, pileSize: 3, revealedCards: ['QD'],
    players: [
      { idx: 0, name: 'X', count: 5, difficulty: 'medium' },
      { idx: 1, name: 'Bot', count: 4, difficulty: 'hard', hand: ['QS', 'QH', '2C', '3D'] },
    ],
    log: [],
  };
  ok(E.botRespond(view, 1, E.mulberry32(1)) === 'check', 'hard bot checks a provably impossible claim (holds 2 of the 4 Queens)');
  const dv = { pileSize: 20, players: [{ idx: 0, name: 'B', count: 9, difficulty: 'hard', hand: ['AS', '2C', '3D', '4H', '5S', '6C', '7D', '8H', '9S'] }] };
  ok(E.botDecide(dv, 0, E.mulberry32(3)) === 'burn', 'hard bot burns a big pile');
  for (const d of ['easy', 'medium', 'hard']) {
    const v2 = { pileSize: 3, players: [{ idx: 0, name: 'B', count: 6, difficulty: d, hand: ['AS', 'AH', '3D', '4H', '5S', '6C'] }] };
    const c = E.botDecide(v2, 0, E.mulberry32(9));
    ok(c === 'burn' || c === 'add', d + ' bot decision is always a legal choice');
  }
  // Bot declarations: with no honest pair available, bots pad a single card
  // with junk and declare a rank the cards do not match — a real bluff.
  const distinctHand = ['KS', 'QH', '3D', '5C', '7S', '9H'];
  const vHard = {
    phase: 'play', pileSize: 0, declarationMode: 'free', expectedRank: null,
    players: [{ idx: 0, name: 'B', count: 6, difficulty: 'hard', hand: distinctHand }],
    revealedCards: [], log: [],
  };
  const bpHard = E.botPlay(vHard, 0, E.mulberry32(5));
  ok(bpHard.cards.length >= 2 && bpHard.cards.some(c => E.parseCard(c).rank !== bpHard.rank),
    'hard bot makes a deceptive declaration when it has no honest play');
  let sawBluffDeclare = false;
  for (let seed = 0; seed < 40 && !sawBluffDeclare; seed++) {
    const v3 = {
      phase: 'play', pileSize: 0, declarationMode: 'free', expectedRank: null,
      players: [{ idx: 0, name: 'B', count: 6, difficulty: 'easy', hand: distinctHand }],
      revealedCards: [], log: [],
    };
    const bp = E.botPlay(v3, 0, E.mulberry32(seed));
    if (bp.cards.length && bp.cards.some(c => E.parseCard(c).rank !== bp.rank)) sawBluffDeclare = true;
    ok(bp.cards.length >= 2, 'bot opening respects min-2 (seed ' + seed + ')');
  }
  ok(sawBluffDeclare, 'easy bot also makes deceptive declarations in free mode');
}

/* --- Bot fuzz: full games in BOTH declaration modes terminate, rules
       obeyed, cards conserved, every phase has a defined actor --- */
{
  const diffs = ['easy', 'medium', 'hard'];
  let games = 0, actions = 0;
  for (let g = 0; g < 160; g++) {
    const n = 2 + (g % 5);
    const mode = g % 2 === 0 ? 'free' : 'sequence';
    const defs = Array.from({ length: n }, (_, i) => ({ name: 'B' + i, isBot: true, difficulty: diffs[(g + i) % 3] }));
    const rng = E.mulberry32(2000 + g);
    const s = E.newGame(defs, { rng, declarationMode: mode });
    let guard = 0;
    while (s.phase !== 'over' && guard < 30000) {
      guard++;
      // Every live phase must name exactly one actor (no undefined waits).
      if (s.phase === 'play') ok(s.turn !== null && s.players[s.turn].hand.length > 0, 'fuzz: play phase has an actor with cards');
      if (s.phase === 'respond') ok(E.currentResponder(s) !== null, 'fuzz: respond phase has a responder');
      if (s.phase === 'decide') ok(s.decisionFor !== null, 'fuzz: decide phase has an owner');
      if (s.phase === 'play') {
        const bp = E.botPlay(E.publicView(s, s.turn), s.turn, rng);
        E.applyPlay(s, s.turn, bp.cards, bp.rank); // throws if illegal
      } else if (s.phase === 'respond') {
        const r = E.currentResponder(s);
        E.applyRespond(s, r, E.botRespond(E.publicView(s, r), r, rng));
      } else if (s.phase === 'decide') {
        E.applyDecision(s, s.decisionFor, E.botDecide(E.publicView(s, s.decisionFor), s.decisionFor, rng));
      }
      E.assertConservation(s);
      actions++;
    }
    ok(s.phase === 'over', 'bot game ' + g + ' (' + n + 'p, ' + mode + ') terminates with a winner');
    ok(s.players[s.winner].hand.length === 0, 'bot game ' + g + ' winner has empty hand');
    games++;
  }
  console.log('Bot fuzz: ' + games + ' games, ' + actions + ' actions, all conserved');
}

console.log('\nEngine tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
