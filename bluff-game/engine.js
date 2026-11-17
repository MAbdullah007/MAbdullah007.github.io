'use strict';
/*
 * Bluff (Cheat / I Doubt It) — authoritative game engine.
 * Pure logic, no UI, no network. Used identically by:
 *   - the browser client (single-player vs bots, and as a view renderer helper)
 *   - the Node multiplayer server (the ONLY authority in online games)
 *
 * RULESET (documented in README.md and the in-game How to Play):
 * - One standard 52-card deck, no jokers. 2-6 players. All cards are dealt.
 * - Rank sequence: plays must declare the current sequence rank, which starts
 *   at Ace at the beginning of each round and advances by one after every
 *   accepted play (A,2,3,...,K,A,...). A "round" ends when the pile leaves
 *   the table (challenge or four-of-a-kind burn); the next round restarts
 *   at Ace.
 * - On your turn you play 1-4 cards face down and declare them as that many
 *   of the current rank. The rank is fixed by the sequence; the bluff is
 *   whether the cards really are that rank.
 * - CUSTOM OPENING RULE: the first play on an empty pile must contain at
 *   least TWO cards (2, 3 or 4) — unless the player holds only one card in
 *   total, in which case that single card may be played.
 * - After every play, each other player in turn order chooses CHECK
 *   (challenge) or PASS. The first CHECK resolves immediately:
 *     - play was honest (all cards match the declared rank): checker takes
 *       the whole pile.
 *     - play was a bluff (any card differs): the player who played takes
 *       the whole pile.
 *   The winner of a challenge leads the next round.
 * - FOUR-OF-A-KIND: playing 4 cards is declared as four of the current rank
 *   and triggers the same CHECK/PASS responses, with one extra outcome:
 *   if EVERYONE passes, the play is believed and the entire pile is BURNED
 *   (removed from the game) as a reward; the four-player leads a new round.
 *   If someone CHECKs, normal challenge resolution applies (no burn).
 * - FINAL PLAY: a player who plays their last card(s) does NOT win until
 *   the play survives: all opponents PASS, or a CHECK fails (play honest).
 *   If a CHECK succeeds (bluff), they take the pile and the game continues.
 * - Invariant: hands + pile + burned always contain exactly the 52 unique
 *   cards. assertConservation() verifies this.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BluffEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SUITS = ['S', 'H', 'D', 'C']; // spades hearts diamonds clubs
  const SUIT_GLYPHS = { S: '♠', H: '♥', D: '♦', C: '♣' };

  function cardId(rank, suit) { return RANKS[rank] + SUITS[suit]; }
  function parseCard(id) {
    const suit = id.slice(-1);
    const rankLabel = id.slice(0, -1);
    return { id, rank: RANKS.indexOf(rankLabel), suit: SUITS.indexOf(suit) };
  }
  function createDeck() {
    const deck = [];
    for (let s = 0; s < 4; s++) for (let r = 0; r < 13; r++) deck.push(cardId(r, s));
    return deck;
  }
  // Deterministic RNG for tests; default RNG uses crypto where available.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function defaultRng() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const buf = new Uint32Array(1);
      return function () { crypto.getRandomValues(buf); return buf[0] / 4294967296; };
    }
    return Math.random;
  }
  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

  function newGame(playerDefs, opts) {
    opts = opts || {};
    if (!Array.isArray(playerDefs) || playerDefs.length < 2 || playerDefs.length > 6)
      throw err('BAD_PLAYER_COUNT', 'Bluff needs 2 to 6 players');
    const rng = opts.rng || defaultRng();
    const deck = shuffle(createDeck(), rng);
    const players = playerDefs.map((d, i) => ({
      idx: i,
      id: d.id || ('p' + i),
      name: d.name || ('Player ' + (i + 1)),
      isBot: !!d.isBot,
      difficulty: d.difficulty || 'medium',
      connected: true,
      hand: [],
    }));
    deck.forEach((c, i) => players[i % players.length].hand.push(c));
    players.forEach(p => sortHand(p.hand));
    return {
      players,
      pile: [],            // [{cards:[ids], by, rank, count, four}]
      burned: [],
      phase: 'play',       // play | respond | over
      turn: 0,
      nextRank: 0,         // sequence rank the next play must declare
      lastPlay: null,      // reference into pile (top play)
      respondQueue: [],    // player indices still to respond, in order
      pendingWin: null,    // player idx who emptied hand, awaiting survival
      winner: null,
      revealedCards: [],   // distinct card ids revealed by challenges (public knowledge)
      round: 1,
      log: [],             // public event log (reveals included, by design public)
      moveNo: 0,
    };
  }

  function sortHand(hand) {
    hand.sort((a, b) => {
      const ca = parseCard(a), cb = parseCard(b);
      return ca.rank - cb.rank || ca.suit - cb.suit;
    });
    return hand;
  }
  function pileSize(state) { return state.pile.reduce((n, p) => n + p.cards.length, 0); }
  function minPlayCount(state, playerIdx) {
    if (state.pile.length > 0) return 1;
    // Opening rule: at least 2, unless the player holds only 1 card total.
    return state.players[playerIdx].hand.length >= 2 ? 2 : 1;
  }

  function validatePlay(state, playerIdx, cardIds) {
    if (state.phase !== 'play') throw err('WRONG_PHASE', 'Not a play phase');
    if (state.turn !== playerIdx) throw err('NOT_YOUR_TURN', 'It is not your turn');
    if (!Array.isArray(cardIds) || cardIds.length < 1 || cardIds.length > 4)
      throw err('BAD_COUNT', 'Play 1 to 4 cards');
    if (new Set(cardIds).size !== cardIds.length) throw err('DUPLICATE_CARD', 'Duplicate card in play');
    const hand = state.players[playerIdx].hand;
    for (const c of cardIds) if (!hand.includes(c)) throw err('CARD_NOT_IN_HAND', 'Card not in your hand: ' + c);
    const min = minPlayCount(state, playerIdx);
    if (cardIds.length < min)
      throw err('OPENING_MIN_TWO', 'Opening play on an empty pile needs at least ' + min + ' cards');
    return true;
  }

  function applyPlay(state, playerIdx, cardIds) {
    validatePlay(state, playerIdx, cardIds);
    const p = state.players[playerIdx];
    p.hand = p.hand.filter(c => !cardIds.includes(c));
    const play = {
      cards: cardIds.slice(),
      by: playerIdx,
      rank: state.nextRank,
      count: cardIds.length,
      four: cardIds.length === 4,
    };
    state.pile.push(play);
    state.lastPlay = play;
    state.moveNo++;
    if (p.hand.length === 0) state.pendingWin = playerIdx;
    // Response phase: every other player, in turn order starting after the player.
    state.respondQueue = [];
    for (let k = 1; k < state.players.length; k++) {
      const idx = (playerIdx + k) % state.players.length;
      if (state.players[idx].hand.length > 0 || idx !== state.pendingWin) state.respondQueue.push(idx);
    }
    state.phase = 'respond';
    logEvent(state, { type: 'play', by: playerIdx, count: play.count, rank: play.rank, four: play.four });
    return play;
  }

  function currentResponder(state) {
    return state.phase === 'respond' && state.respondQueue.length ? state.respondQueue[0] : null;
  }

  function validateRespond(state, playerIdx, action) {
    if (state.phase !== 'respond') throw err('WRONG_PHASE', 'Not a response phase');
    if (currentResponder(state) !== playerIdx) throw err('NOT_YOUR_RESPONSE', 'Wait for your response turn');
    if (action !== 'pass' && action !== 'check') throw err('BAD_ACTION', 'Respond with pass or check');
    return true;
  }

  function applyRespond(state, playerIdx, action) {
    validateRespond(state, playerIdx, action);
    if (action === 'pass') {
      state.respondQueue.shift();
      logEvent(state, { type: 'pass', by: playerIdx });
      if (state.respondQueue.length === 0) resolveAllPass(state);
      return { resolved: state.phase !== 'respond' };
    }
    // CHECK: resolve the challenge immediately.
    return resolveChallenge(state, playerIdx);
  }

  function takePile(state, takerIdx) {
    const cards = [];
    for (const play of state.pile) cards.push(...play.cards);
    state.pile = [];
    state.lastPlay = null;
    state.players[takerIdx].hand.push(...cards);
    sortHand(state.players[takerIdx].hand);
    return cards.length;
  }

  function resolveChallenge(state, checkerIdx) {
    const play = state.lastPlay;
    const honest = play.cards.every(c => parseCard(c).rank === play.rank);
    const revealed = play.cards.slice();
    if (!state.revealedCards) state.revealedCards = [];
    for (const c of revealed) if (!state.revealedCards.includes(c)) state.revealedCards.push(c);
    let winnerIdx;
    if (honest) {
      winnerIdx = play.by;
      takePile(state, checkerIdx);
    } else {
      winnerIdx = checkerIdx;
      takePile(state, play.by);
    }
    logEvent(state, {
      type: 'challenge', by: checkerIdx, against: play.by, honest,
      revealed, rank: play.rank, count: play.count,
    });
    state.respondQueue = [];
    // Final-play survival: honest final play wins even though checker took the pile.
    if (state.pendingWin === play.by && honest) {
      const f = finishGame(state, play.by, 'final-play-survived');
      return { resolved: true, honest, revealed, winner: f.winner };
    }
    state.pendingWin = null;
    startRound(state, winnerIdx);
    return { resolved: true, honest, revealed };
  }

  function resolveAllPass(state) {
    const play = state.lastPlay;
    if (state.pendingWin === play.by) return finishGame(state, play.by, 'final-play-survived');
    state.pendingWin = null;
    if (play.four) {
      // Believed four-of-a-kind: burn the whole pile, four-player leads.
      const burnedNow = [];
      for (const pl of state.pile) burnedNow.push(...pl.cards);
      state.burned.push(...burnedNow);
      state.pile = [];
      state.lastPlay = null;
      logEvent(state, { type: 'four-burn', by: play.by, burned: burnedNow.length });
      startRound(state, play.by);
      return { resolved: true, burned: burnedNow.length };
    }
    state.nextRank = (play.rank + 1) % 13;
    state.turn = (play.by + 1) % state.players.length;
    state.phase = 'play';
    logEvent(state, { type: 'accepted', by: play.by });
    return { resolved: true };
  }

  function startRound(state, leaderIdx) {
    state.round++;
    state.nextRank = 0; // new round restarts the sequence at Ace
    state.turn = leaderIdx;
    state.phase = 'play';
    logEvent(state, { type: 'round', leader: leaderIdx, round: state.round });
  }

  function finishGame(state, winnerIdx, reason) {
    state.phase = 'over';
    state.winner = winnerIdx;
    logEvent(state, { type: 'win', by: winnerIdx, reason });
    return { resolved: true, winner: winnerIdx };
  }

  function logEvent(state, ev) {
    ev.move = state.moveNo;
    state.log.push(ev);
    if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  }

  function assertConservation(state) {
    const all = [];
    for (const p of state.players) all.push(...p.hand);
    for (const play of state.pile) all.push(...play.cards);
    all.push(...state.burned);
    if (all.length !== 52) throw err('CONSERVATION', 'Expected 52 cards, found ' + all.length);
    if (new Set(all).size !== 52) throw err('CONSERVATION', 'Duplicate cards detected');
    return true;
  }

  // Personalised view: NEVER includes another player's hand contents.
  function publicView(state, forIdx) {
    return {
      phase: state.phase,
      turn: state.turn,
      nextRank: state.nextRank,
      round: state.round,
      moveNo: state.moveNo,
      winner: state.winner,
      pendingWin: state.pendingWin,
      pileSize: pileSize(state),
      pilePlays: state.pile.map(pl => ({ by: pl.by, count: pl.count, rank: pl.rank, four: pl.four })),
      burnedCount: state.burned.length,
      responder: currentResponder(state),
      respondQueue: state.respondQueue.slice(),
      revealedCards: (state.revealedCards || []).slice(),
      lastPlay: state.lastPlay ? { by: state.lastPlay.by, count: state.lastPlay.count, rank: state.lastPlay.rank, four: state.lastPlay.four } : null,
      minPlay: state.phase === 'play' ? minPlayCount(state, state.turn) : null,
      players: state.players.map(p => ({
        idx: p.idx, name: p.name, isBot: p.isBot, connected: p.connected, difficulty: p.difficulty,
        count: p.hand.length, hand: p.idx === forIdx ? p.hand.slice() : undefined,
      })),
      log: state.log.slice(-30),
    };
  }

  /* ------------------------------ BOTS ------------------------------ */
  // Bots receive ONLY the public view (with their own hand) plus their
  // difficulty. They never see another player's cards. Revealed cards from
  // past challenges are public log information, which bots may count —
  // exactly like a human who pays attention.

  function seenRankCounts(view) {
    // Distinct publicly revealed cards only — the same card revealed twice
    // must not be counted twice.
    const seen = new Array(13).fill(0);
    for (const c of (view.revealedCards || [])) seen[parseCard(c).rank]++;
    return seen;
  }
  function myRankCounts(hand) {
    const counts = new Array(13).fill(0);
    for (const c of hand) counts[parseCard(c).rank]++;
    return counts;
  }

  function botPlay(view, myIdx, rng) {
    rng = rng || Math.random;
    const me = view.players[myIdx];
    const hand = me.hand.slice();
    const rank = view.nextRank;
    const diff = view.players[myIdx].difficulty || 'medium';
    const min = view.pileSize === 0 ? (hand.length >= 2 ? 2 : 1) : 1;
    const honest = hand.filter(c => parseCard(c).rank === rank);
    const others = hand.filter(c => parseCard(c).rank !== rank);
    // Cards ranked by "least useful to keep": ranks far from upcoming sequence.
    const junkFirst = others.slice().sort((a, b) => {
      const da = (parseCard(a).rank - rank + 13) % 13, db = (parseCard(b).rank - rank + 13) % 13;
      return db - da;
    });
    function honestPlay() {
      const n = honest.length;
      if (n < min) return null;
      if (diff === 'hard' || n <= 3 || rng() < 0.5) return honest.slice(0, Math.min(n, 4));
      return honest.slice(0, Math.max(min, n - 1));
    }
    function bluffPlay() {
      let n = min;
      if (diff !== 'easy' && rng() < 0.3) n = min + 1;
      n = Math.min(n, hand.length);
      // Hard dumps its least useful cards first; other levels pick randomly
      // so repeated bluffs are not perfectly predictable (or loop-prone).
      const pool = diff === 'hard' ? junkFirst.concat(honest) : shuffle(junkFirst.concat(honest), rng);
      return pool.slice(0, n);
    }

    if (diff === 'easy') {
      if (honest.length >= min && rng() < 0.8) return honestPlay();
      if (honest.length > 0 && rng() < 0.5) return honest.slice(0, honest.length).concat(junkFirst).slice(0, Math.max(min, honest.length));
      return bluffPlay();
    }
    if (diff === 'medium') {
      // Going out honestly is always worth it; a small hand may also be
      // dumped whole as a going-out bluff attempt.
      if (honest.length === hand.length && honest.length >= min) return honest.slice(0, Math.min(4, honest.length));
      if (hand.length <= 4 && hand.length >= min && rng() < 0.45) return hand.slice();
      if (honest.length >= min && rng() < 0.75) return honestPlay();
      if (honest.length > 0 && honest.length < min) return honest.concat(junkFirst).slice(0, min);
      return bluffPlay();
    }
    // hard
    if (honest.length >= min) {
      // Play all four of a kind when holding them: burn reward or strong dump.
      if (honest.length === 4) return honest.slice();
      const hp = honestPlay();
      if (hp) return hp;
    }
    if (honest.length > 0) return honest.concat(junkFirst).slice(0, min);
    // Bluff: if we can empty our hand, do it; otherwise minimum cards.
    if (hand.length <= 4 && hand.length >= min) return junkFirst.slice(0, hand.length);
    return bluffPlay();
  }

  function botRespond(view, myIdx, rng) {
    rng = rng || Math.random;
    const diff = view.players[myIdx].difficulty || 'medium';
    const play = view.lastPlay;
    if (!play) return 'pass';
    const seen = seenRankCounts(view);
    const mine = myRankCounts(view.players[myIdx].hand);
    // Only MY OWN cards provably cannot be in the play. (Revealed cards went
    // back into someone's hand and can honestly be played again, so they are
    // a soft suspicion signal only, never proof.)
    const maxPossible = 4 - mine[play.rank];
    const certainBluff = play.count > maxPossible;
    const isFinal = view.pendingWin === play.by;
    const pile = view.pileSize;

    if (certainBluff) return 'check';
    if (isFinal) {
      // Challenging a final play is almost always right: if it was honest
      // the game simply continues with me holding the pile.
      if (diff === 'easy') return rng() < 0.45 ? 'check' : 'pass';
      if (diff === 'medium') return rng() < 0.85 ? 'check' : 'pass';
      return pile >= 20 && rng() < 0.3 ? 'pass' : 'check';
    }
    if (play.four) {
      // Four-of-a-kind claim: bold by nature. (If I hold even one of the
      // rank, certainBluff above already caught it.) A big pile makes a
      // wrong check expensive, so check less then.
      const bigPileFactor = pile >= 14 ? 0.5 : pile >= 8 ? 0.75 : 1;
      if (diff === 'easy') return rng() < 0.2 * bigPileFactor ? 'check' : 'pass';
      if (diff === 'medium') return rng() < 0.45 * bigPileFactor ? 'check' : 'pass';
      return rng() < 0.55 * bigPileFactor ? 'check' : 'pass';
    }
    // Ordinary play: humans mostly PASS ordinary plays; suspicion should be
    // driven by information, above all by how many of the declared rank the
    // responder personally holds (each one squeezes the claim). A flat high
    // base rate makes every one of 5 responders likely to check, which ends
    // every round on the first play and stalls the game.
    const playerCards = view.players[play.by].count;
    let suspicion = 0.04 + play.count * 0.02 + mine[play.rank] * 0.10
      + (playerCards <= 2 ? 0.12 : 0) + (seen[play.rank] >= 3 ? 0.08 : 0);
    if (diff === 'easy') suspicion *= 0.6;
    if (diff === 'hard') suspicion *= 1.4;
    // A big pile makes a wrong check expensive — this is what lets piles
    // (and rounds) grow in real games, and lets players actually shed cards.
    if (pile >= 20) suspicion *= 0.3;
    else if (pile >= 14) suspicion *= 0.45;
    else if (pile >= 8) suspicion *= 0.7;
    return rng() < Math.min(suspicion, 0.9) ? 'check' : 'pass';
  }

  return {
    RANKS, SUITS, SUIT_GLYPHS, cardId, parseCard, createDeck, shuffle, mulberry32,
    newGame, sortHand, pileSize, minPlayCount, validatePlay, applyPlay,
    currentResponder, validateRespond, applyRespond, assertConservation, publicView,
    botPlay, botRespond,
  };
});
