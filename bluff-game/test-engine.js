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
    players, pile: opts.pile || [], burned: opts.burned || [],
    phase: 'play', turn: opts.turn || 0, nextRank: opts.nextRank || 0,
    lastPlay: null, respondQueue: [], pendingWin: null, winner: null,
    round: 1, log: [], moveNo: 0,
  };
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

/* --- Opening rule --- */
{
  // P0 has aces + others; empty pile: 1 card must be rejected.
  const s = rig([['AS', 'AH', '5C', '9D'], ['2S', '3S', '4S']]);
  throwsCode(() => E.applyPlay(s, 0, ['AS']), 'OPENING_MIN_TWO', 'opening with 1 card rejected');
  E.applyPlay(s, 0, ['AS', 'AH']);
  ok(s.pile.length === 1 && s.phase === 'respond', 'opening with 2 cards accepted');
}
{
  const s = rig([['AS', 'AH', 'AD', '9D'], ['2S', '3S']]);
  E.applyPlay(s, 0, ['AS', 'AH', 'AD']);
  ok(s.lastPlay.count === 3, 'opening with 3 cards accepted');
}
{
  const s = rig([['AS', 'AH', 'AD', 'AC'], ['2S', '3S']]);
  E.applyPlay(s, 0, ['AS', 'AH', 'AD', 'AC']);
  ok(s.lastPlay.four === true, 'opening with 4 cards accepted and flagged four');
}
{
  // Player holding exactly 1 card may open with it (documented exception).
  const s = rig([['AS'], ['2S', '3S', '4S', '5S', '6S', '7S', '8S', '9S', '10S', 'JS', 'QS', 'KS',
    '2H', '3H', '4H', '5H', '6H', '7H', '8H', '9H', '10H', 'JH', 'QH', 'KH',
    '2D', '3D', '4D', '5D', '6D', '7D', '8D', '9D', '10D', 'JD', 'QD', 'KD',
    '2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C', '10C', 'JC', 'QC', 'KC', 'AH', 'AD', 'AC']]);
  E.applyPlay(s, 0, ['AS']);
  ok(s.pendingWin === 0, 'single-card holder may open with 1 card');
}
{
  // Non-opening play (pile non-empty) may be 1 card.
  const s = rig([['5C', '9D', '2H'], ['2S', '3S', '4S']],
    { pile: [{ cards: ['AS', 'AH'], by: 1, rank: 0, count: 2, four: false }], nextRank: 1 });
  s.lastPlay = s.pile[0];
  E.applyPlay(s, 0, ['2H']);
  ok(s.lastPlay.count === 1, 'mid-round 1-card play allowed');
}
/* --- Illegal moves --- */
{
  const s = rig([['AS', 'AH', '5C'], ['2S', '3S', '4S']]);
  throwsCode(() => E.applyPlay(s, 1, ['2S', '3S']), 'NOT_YOUR_TURN', 'out-of-turn play rejected');
  throwsCode(() => E.applyPlay(s, 0, ['AS', 'AS']), 'DUPLICATE_CARD', 'duplicate card in one play rejected');
  throwsCode(() => E.applyPlay(s, 0, ['AS', 'KS']), 'CARD_NOT_IN_HAND', 'card not in hand rejected');
  throwsCode(() => E.applyPlay(s, 0, ['AS', 'AH', '5C', '2S', '3S']), 'BAD_COUNT', 'playing 5 cards rejected');
  throwsCode(() => E.applyRespond(s, 1, 'pass'), 'WRONG_PHASE', 'respond during play phase rejected');
}

/* --- Challenge: honest play -> checker takes pile --- */
{
  const s = rig([['AS', 'AH', '9C'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['AS', 'AH']); // honest: two Aces, declares 2xA
  ok(E.currentResponder(s) === 1, 'responder is next player');
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === true, 'honest play detected');
  ok(s.players[1].hand.length === 5, 'checker takes pile on honest play');
  ok(s.pile.length === 0 && s.turn === 0, 'honest player leads next round');
  ok(s.nextRank === 0, 'new round restarts at Ace');
}
/* --- Challenge: bluff -> player takes pile --- */
{
  const s = rig([['AS', '9C', '9D'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['AS', '9C']); // declares 2xA, actually A+9 = bluff
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === false, 'bluff detected');
  ok(s.players[0].hand.length === 3, 'bluffer takes pile back');
  ok(s.turn === 1, 'checker leads next round after catching bluff');
}
/* --- All pass: rank advances, turn advances --- */
{
  const s = rig([['AS', 'AH', '9C'], ['2S', '3S', '4S'], ['5D', '6D', '7D']]);
  // rebuild as 3-player rig
  s.players = [['AS', 'AH', '9C'], ['2S', '3S', '4S'], ['5D', '6D', '7D']].map((h, i) =>
    ({ idx: i, id: 'p' + i, name: 'P' + i, isBot: false, difficulty: 'medium', connected: true, hand: h }));
  E.applyPlay(s, 0, ['AS', 'AH']);
  E.applyRespond(s, 1, 'pass');
  ok(s.phase === 'respond' && E.currentResponder(s) === 2, 'response passes in turn order');
  E.applyRespond(s, 2, 'pass');
  ok(s.phase === 'play' && s.turn === 1 && s.nextRank === 1, 'after all pass: next player, rank advances to 2');
  ok(E.pileSize(s) === 2, 'pile stays after all pass on normal play');
}

/* --- Four-of-a-kind: all pass -> pile burned --- */
{
  const s = rig([['QS', 'QH', 'QD', 'QC', '3C'], ['2S', '3S', '4S']], { nextRank: 11 });
  E.applyPlay(s, 0, ['QS', 'QH', 'QD', 'QC']);
  ok(s.lastPlay.four === true, 'four play flagged');
  E.applyRespond(s, 1, 'pass');
  ok(s.burned.length === 4 && s.pile.length === 0, 'believed four-of-a-kind burns the pile');
  ok(s.turn === 0 && s.nextRank === 0, 'four-player leads new round at Ace');
  ok(s.players[0].hand.length === 1, 'four-player keeps remaining card');
}
/* --- Four-of-a-kind: checked and genuine -> checker takes pile, no burn --- */
{
  const s = rig([['QS', 'QH', 'QD', 'QC', '3C'], ['2S', '3S', '4S']], { nextRank: 11 });
  E.applyPlay(s, 0, ['QS', 'QH', 'QD', 'QC']);
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === true && s.burned.length === 0, 'checked genuine four: no burn');
  ok(s.players[1].hand.length === 7, 'checker takes pile on genuine four');
}
/* --- Four-of-a-kind: checked and bluff -> player takes pile --- */
{
  const s = rig([['QS', 'QH', 'QD', '9C', '3C'], ['2S', '3S', '4S']], { nextRank: 11 });
  E.applyPlay(s, 0, ['QS', 'QH', 'QD', '9C']); // declares 4xQ, actually 3xQ+9
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === false && s.players[0].hand.length === 5, 'bluffed four: player takes pile');
}

/* --- Final play: survives all-pass -> win --- */
{
  const s = rig([['AS', 'AH'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['AS', 'AH']);
  ok(s.pendingWin === 0 && s.phase === 'respond', 'final play does not win immediately');
  E.applyRespond(s, 1, 'pass');
  ok(s.phase === 'over' && s.winner === 0, 'final play surviving all-pass wins');
}
/* --- Final play: caught bluffing -> no win, takes pile --- */
{
  const s = rig([['AS', '9H'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['AS', '9H']);
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === false && s.phase !== 'over', 'caught final bluff: game continues');
  ok(s.players[0].hand.length === 2, 'caught final bluffer takes pile');
}
/* --- Final play: honest but checked -> still wins --- */
{
  const s = rig([['AS', 'AH'], ['2S', '3S', '4S']]);
  E.applyPlay(s, 0, ['AS', 'AH']);
  const res = E.applyRespond(s, 1, 'check');
  ok(res.honest === true && s.phase === 'over' && s.winner === 0, 'honest final play wins even when checked');
}
/* --- Only the current responder may respond --- */
{
  const s = rig([['AS', 'AH', '9C'], ['2S', '3S', '4S'], ['5D', '6D', '7D']]);
  s.players = [['AS', 'AH', '9C'], ['2S', '3S', '4S'], ['5D', '6D', '7D']].map((h, i) =>
    ({ idx: i, id: 'p' + i, name: 'P' + i, isBot: false, difficulty: 'medium', connected: true, hand: h }));
  E.applyPlay(s, 0, ['AS', 'AH']);
  throwsCode(() => E.applyRespond(s, 2, 'check'), 'NOT_YOUR_RESPONSE', 'out-of-order response rejected');
  throwsCode(() => E.applyRespond(s, 0, 'pass'), 'NOT_YOUR_RESPONSE', 'player cannot respond to own play');
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
}

/* --- Hard bot: certain bluff is always checked --- */
{
  // Declared 3 Queens, but bot holds 2 Queens and 1 was revealed earlier:
  // only 1 Queen could possibly be in the play -> certain bluff.
  const view = {
    phase: 'respond', lastPlay: { by: 0, count: 3, rank: 11, four: false },
    pendingWin: null, pileSize: 3,
    players: [
      { idx: 0, name: 'X', count: 5, difficulty: 'medium' },
      { idx: 1, name: 'Bot', count: 4, difficulty: 'hard', hand: ['QS', 'QH', '2C', '3D'] },
    ],
    revealedCards: ['QD'],
    log: [{ type: 'challenge', revealed: ['QD', '5S', '6S'], honest: false }],
  };
  ok(E.botRespond(view, 1, E.mulberry32(1)) === 'check', 'hard bot checks a provably impossible claim');
}

/* --- Bot fuzz: full games terminate, rules always obeyed, cards conserved --- */
{
  const diffs = ['easy', 'medium', 'hard'];
  let games = 0, actions = 0;
  for (let g = 0; g < 120; g++) {
    const n = 2 + (g % 5);
    const defs = Array.from({ length: n }, (_, i) => ({ name: 'B' + i, isBot: true, difficulty: diffs[(g + i) % 3] }));
    const rng = E.mulberry32(1000 + g);
    const s = E.newGame(defs, { rng });
    let guard = 0;
    while (s.phase !== 'over' && guard < 20000) {
      guard++;
      if (s.phase === 'play') {
        const view = E.publicView(s, s.turn);
        view.players[s.turn].difficulty = defs[s.turn].difficulty;
        const cards = E.botPlay(view, s.turn, rng);
        E.applyPlay(s, s.turn, cards); // throws if illegal
      } else {
        const r = E.currentResponder(s);
        const view = E.publicView(s, r);
        view.players[r].difficulty = defs[r].difficulty;
        E.applyRespond(s, r, E.botRespond(view, r, rng));
      }
      E.assertConservation(s);
      actions++;
    }
    ok(s.phase === 'over', 'bot game ' + g + ' (' + n + 'p) terminates with a winner');
    ok(s.players[s.winner].hand.length === 0, 'bot game ' + g + ' winner has empty hand');
    games++;
  }
  console.log('Bot fuzz: ' + games + ' games, ' + actions + ' actions, all conserved');
}

console.log('\nEngine tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
