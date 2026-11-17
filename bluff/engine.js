'use strict';
/*
 * Bluff (Cheat / I Doubt It) — authoritative game engine.
 * Pure logic, no UI, no network. Used identically by:
 *   - the browser client (single-player vs bots, and as a view renderer helper)
 *   - the Node multiplayer server (the ONLY authority in online games)
 *
 * RULESET (documented in README.md and the in-game How to Play):
 * - One standard 52-card deck, no jokers. 2-6 players. All cards are dealt.
 * - DECLARATIONS: the actual cards played and the declared rank are kept
 *   separate. A challenge always compares the ACTUAL cards against the
 *   DECLARED rank. Two modes, chosen per game (rules.declarationMode):
 *     - 'free' (default): any rank may be declared on any play. You may
 *       play two Kings and declare them as two Queens.
 *     - 'sequence': the first play of a round may declare any rank; each
 *       later play in the same round must declare the previous declared
 *       rank + 1 (wrapping K -> A). state.expectedRank holds the required
 *       rank, or null when any rank may be declared.
 * - On your turn you play 1-4 cards face down and declare a rank.
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
 * - ALL PASS — BURN OR ADD DECISION: if everyone passes a play of 1-3
 *   cards, control returns to the player who made the play (phase
 *   'decide'). They choose:
 *     - BURN PILE: the whole active pile moves to the burned zone (cards
 *       stay accounted for, never return to play), and the SAME player
 *       opens a fresh play on the empty pile (opening rule applies).
 *     - ADD MORE CARDS: the same player plays more cards onto the existing
 *       pile with a new declaration, starting a new response cycle.
 *   The decision is repeatable: after an ADD, another all-pass returns the
 *   decision to the same player again. Every ADD moves at least one card
 *   from a hand to the pile, so the cycle cannot loop without progress.
 * - FOUR-OF-A-KIND: playing 4 cards declares four of a rank and triggers
 *   the same CHECK/PASS responses, with one extra outcome: if EVERYONE
 *   passes, the play is believed and the entire pile is BURNED
 *   automatically (the special reward — no decision needed); the
 *   four-player leads a new round. If someone CHECKs, normal challenge
 *   resolution applies (no burn).
 * - FINAL PLAY: a player who plays their last card(s) does NOT win until
 *   the play survives: all opponents PASS, or a CHECK fails (play honest).
 *   If a CHECK succeeds (bluff), they take the pile and the game continues.
 * - State machine: phases are 'play' -> 'respond' -> ('play' via challenge
 *   or four-burn | 'decide' via all-pass | 'over'), and 'decide' -> 'play'
 *   (burn or add). Every phase names exactly one actor: turn, responder,
 *   or decisionFor. No phase waits without an owner.
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
    // Round-robin from a RANDOM starting seat: hand sizes stay within one
    // card of each other (52 = e.g. 18/17/17 for 3 players, 13 each for 4),
    // but the extra cards rotate fairly instead of always landing on seat 0.
    const dealStart = Math.floor(rng() * players.length);
    deck.forEach((c, i) => players[(dealStart + i) % players.length].hand.push(c));
    players.forEach(p => sortHand(p.hand));
    return {
      players,
      rules: { declarationMode: opts.declarationMode === 'sequence' ? 'sequence' : 'free' },
      pile: [],            // [{cards:[ids], by, rank (DECLARED), count, four}]
      burned: [],
      phase: 'play',       // play | respond | decide | over
      turn: 0,
      expectedRank: null,  // sequence mode: rank the next play must declare (null = any)
      lastPlay: null,      // reference into pile (top play)
      respondQueue: [],    // player indices still to respond, in order
      decisionFor: null,   // player idx who must choose burn/add (decide phase)
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

  function validatePlay(state, playerIdx, cardIds, declaredRank) {
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
    if (!Number.isInteger(declaredRank) || declaredRank < 0 || declaredRank > 12)
      throw err('BAD_DECLARATION', 'Declare a rank from A to K');
    if (state.rules && state.rules.declarationMode === 'sequence' &&
        state.expectedRank !== null && state.expectedRank !== undefined &&
        declaredRank !== state.expectedRank)
      throw err('BAD_DECLARATION', 'This round you must declare ' + RANKS[state.expectedRank]);
    return true;
  }

  function applyPlay(state, playerIdx, cardIds, declaredRank) {
    validatePlay(state, playerIdx, cardIds, declaredRank);
    const p = state.players[playerIdx];
    p.hand = p.hand.filter(c => !cardIds.includes(c));
    const play = {
      cards: cardIds.slice(),
      by: playerIdx,
      rank: declaredRank, // DECLARED rank — the actual cards stay in .cards
      count: cardIds.length,
      four: cardIds.length === 4,
    };
    state.pile.push(play);
    state.lastPlay = play;
    state.moveNo++;
    state.decisionFor = null;
    if (state.rules && state.rules.declarationMode === 'sequence')
      state.expectedRank = (declaredRank + 1) % 13;
    if (p.hand.length === 0) state.pendingWin = playerIdx;
    // Response phase: every other player, in turn order starting after the player.
    state.respondQueue = [];
    for (let k = 1; k < state.players.length; k++) {
      const idx = (playerIdx + k) % state.players.length;
      state.respondQueue.push(idx);
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
    // Everyone passed: control returns to the player who made the play.
    // They now choose BURN PILE or ADD MORE CARDS (the 'decide' phase).
    state.phase = 'decide';
    state.decisionFor = play.by;
    state.turn = play.by;
    logEvent(state, { type: 'decide', by: play.by });
    return { resolved: true, decision: true };
  }

  function validateDecision(state, playerIdx, choice) {
    if (state.phase !== 'decide') throw err('WRONG_PHASE', 'No burn/add decision is pending');
    if (state.decisionFor !== playerIdx) throw err('NOT_YOUR_DECISION', 'It is not your decision');
    if (choice !== 'burn' && choice !== 'add') throw err('BAD_ACTION', 'Choose burn or add');
    return true;
  }

  function applyDecision(state, playerIdx, choice) {
    validateDecision(state, playerIdx, choice);
    state.decisionFor = null;
    state.moveNo++;
    if (choice === 'burn') {
      const burnedNow = [];
      for (const pl of state.pile) burnedNow.push(...pl.cards);
      state.burned.push(...burnedNow);
      state.pile = [];
      state.lastPlay = null;
      logEvent(state, { type: 'burn', by: playerIdx, burned: burnedNow.length });
      // Fresh play cycle for the SAME player; the pile is empty, so the
      // opening rule (minimum 2 cards) applies to their next play.
      startRound(state, playerIdx);
      return { resolved: true, burned: burnedNow.length };
    }
    // ADD: same player plays again onto the existing pile. The pile is
    // untouched; their upcoming play starts a new response cycle.
    state.phase = 'play';
    state.turn = playerIdx;
    logEvent(state, { type: 'add', by: playerIdx });
    return { resolved: true, add: true };
  }

  function startRound(state, leaderIdx) {
    state.round++;
    state.expectedRank = null; // new round: any rank may be declared first
    state.decisionFor = null;
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
      expectedRank: state.expectedRank === undefined ? null : state.expectedRank,
      decisionFor: state.decisionFor,
      declarationMode: state.rules ? state.rules.declarationMode : 'free',
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
    const diff = view.players[myIdx].difficulty || 'medium';
    const min = view.pileSize === 0 ? (hand.length >= 2 ? 2 : 1) : 1;
    // Which rank to build the play around: the forced sequence rank if the
    // rules demand one, otherwise the rank this bot holds most of.
    const counts = myRankCounts(hand);
    let forced = null;
    if ((view.declarationMode || 'free') === 'sequence' && view.expectedRank !== null && view.expectedRank !== undefined)
      forced = view.expectedRank;
    let rank = forced;
    if (rank === null) {
      rank = 0;
      for (let r = 1; r < 13; r++) if (counts[r] > counts[rank]) rank = r;
    }
    const honest = hand.filter(c => parseCard(c).rank === rank);
    const others = hand.filter(c => parseCard(c).rank !== rank);
    // Cards ranked by "least useful to keep": ranks far from the build rank.
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
    function pick() {
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
    const cards = pick();
    // Declaration: forced in sequence mode. Otherwise, if the chosen cards
    // all share one rank, declare it honestly; else declare the build rank
    // (a bluff). Easy bots sometimes declare a random rank instead.
    let declared = forced !== null ? forced : rank;
    if (forced === null) {
      const ranks = cards.map(c => parseCard(c).rank);
      if (ranks.every(r => r === ranks[0])) declared = ranks[0];
      else if (diff === 'easy' && rng() < 0.25) declared = Math.floor(rng() * 13);
      else if (diff === 'hard') {
        // Declare the rank opponents can least disprove: the one with the
        // most copies not yet publicly revealed and not in this play.
        const seen = seenRankCounts(view);
        let best = declared, bestScore = -1;
        for (let r = 0; r < 13; r++) {
          const score = 4 - seen[r] - counts[r];
          if (score > bestScore) { bestScore = score; best = r; }
        }
        declared = best;
      }
    }
    return { cards, rank: declared };
  }

  // Bot choice in the burn/add decision phase. Heuristics only; both
  // choices are always legal here, so a bot can never get stuck.
  function botDecide(view, myIdx, rng) {
    rng = rng || Math.random;
    const diff = view.players[myIdx].difficulty || 'medium';
    const pile = view.pileSize;
    const hand = view.players[myIdx].hand.length;
    if (diff === 'easy') return rng() < 0.5 ? 'burn' : 'add';
    // Endgame: when few cards remain in circulation, burning is the only
    // choice that permanently shrinks the game. Without this, medium/hard
    // bots keep choosing 'add' under their push-on rules and a small pile
    // can circulate forever (pre-existing sequence-mode stalemate).
    const inPlay = 52 - (view.burnedCount || 0);
    if (inPlay <= 16 && rng() < 0.85) return 'burn';
    if (diff === 'medium') {
      if (pile >= 10) return 'burn';            // bank a big pile safely
      if (hand <= 3) return 'add';              // close to going out: push on
      return rng() < 0.65 ? 'add' : 'burn';
    }
    // hard: burn when the pile is worth banking or the hand reopens well
    // (holds a pair or better for the fresh min-2 opening); otherwise add.
    if (pile >= 7) return 'burn';
    const counts = myRankCounts(view.players[myIdx].hand);
    const bestPair = Math.max(...counts);
    if (bestPair >= 2 && rng() < 0.6) return 'burn';
    return 'add';
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
      // Challenging a final play is usually right: if it was honest the
      // game simply continues with me holding the pile. But near-certain
      // checks from EVERY responder deadlock the endgame: when all players
      // hold exactly 2 mismatched cards, the min-2 opening rule forces a
      // bluffed final play that can then never survive. Human-like rates
      // (still check-leaning) let an occasional bluff slip through and win.
      if (diff === 'easy') return rng() < 0.45 ? 'check' : 'pass';
      if (diff === 'medium') return rng() < 0.65 ? 'check' : 'pass';
      return pile >= 20 && rng() < 0.45 ? 'pass' : (rng() < 0.8 ? 'check' : 'pass');
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
    currentResponder, validateRespond, applyRespond, validateDecision, applyDecision,
    assertConservation, publicView,
    botPlay, botRespond, botDecide,
  };
});
