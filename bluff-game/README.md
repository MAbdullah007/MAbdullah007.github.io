# Bluff! — the bluffing card game

A complete, mobile-friendly web version of **Bluff** (also known as *Cheat* or
*I Doubt It*). Play against AI bots offline, or create a private room and send
your friends a link — they join in their browser, no install, no sign-up.

## Play it

- **Bot mode** works fully offline once the page has loaded (it is a PWA).
- **Friend mode** needs the game server running (see below). The web client
  and the server are one package: the server also serves the client.

## Quick start (local)

```bash
cd server
npm install
npm start            # serves the game at http://localhost:8080
```

Open that address, type your name, and either start a bot game or create a
room. Friends on the same network can open `http://<your-ip>:8080` and join
with the room code.

### Run the tests

```bash
node test-engine.js                 # 294 engine + bot tests (repo root)
node server/test-multiplayer.js     # 17 live multiplayer integration tests
python3 test-browser.py             # Playwright: full bot game in a phone viewport
```

## Deploy the multiplayer server (free tier example: Render)

GitHub Pages (and other static hosts) can host the client, but a WebSocket
game server needs a real Node host. Render's free tier works:

1. Push this folder to a GitHub repository.
2. On render.com: **New → Web Service**, pick the repository.
3. Root directory: `server` · Build command: `npm install` · Start command:
   `npm start`. Pick the **Free** instance type.
4. Deploy. You get a URL like `https://bluff-game.onrender.com` — opening it
   serves the game, and online rooms work on the same address (the client
   connects back to the host it was served from when the Server field is set
   to `wss://bluff-game.onrender.com`).

Notes: free instances sleep when idle, so the first visit after a break can
take ~30 seconds to wake. Rooms are held in memory — a server restart clears
active rooms (games in progress end). That is an accepted trade-off for a
free, database-free design.

## The rules (exactly as implemented)

- One standard **52-card deck**, no jokers, **2–6 players**, all cards dealt.
- **Rank sequence:** every play declares the current sequence rank. A round
  starts at **Aces** and the rank advances by one after each accepted play
  (A, 2, 3, …, K, then wraps). A new round restarts at Aces.
- On your turn you play **1–4 cards face down**, declared as that many of the
  current rank. They don't have to match — that's the bluff.
- **Opening rule (custom):** the first play on an empty pile must contain
  **at least 2 cards** (2, 3 or 4). Only exception: a player holding exactly
  one card in total may play that single card. Enforced by the engine/server,
  not just the UI.
- **CHECK / PASS:** after every play, each other player in turn order chooses
  CHECK (challenge) or PASS. The first CHECK flips the played cards:
  - all cards match the declared rank → the play was honest → the **checker
    takes the whole pile**;
  - any card differs → it was a bluff → the **player who played takes the
    whole pile**.
  The winner of a challenge leads the next round. If everyone passes, the
  play stands and the sequence advances.
- **Four of a kind (custom):** playing 4 cards declares four of the current
  rank. Responses are the same CHECK/PASS, with one extra outcome: if
  **everyone passes**, the claim is believed and the **entire pile is burned**
  (removed from the game permanently); the four-player leads the next round.
  If someone CHECKs, the normal challenge decides who takes the pile (no
  burn). This behaviour lives in one place in `engine.js`
  (`resolveAllPass` / the `four` flag) so it can be adjusted easily.
- **Winning:** playing your last card is not enough — the play must survive.
  You win if everyone passes your final play, or if a CHECK shows it was
  honest. If a CHECK catches the bluff, you take the pile and play continues.
- **Invariant:** hands + pile + burned always hold exactly the 52 unique
  cards. The engine verifies this in tests after every action.

### Bots

Easy, Medium and Hard bots all obey the same engine rules and decide **only**
from public information (their own hand, the pile, declarations, and cards
revealed by earlier challenges). Hard bots count revealed cards and detect
provably impossible claims; no bot ever sees another player's hand.

### Multiplayer design

- The Node server is **authoritative**: it runs the engine and sends each
  player a personalised view containing only their own hand plus public
  state. Hidden cards never leave the server.
- Rooms: 5-letter code + invite link (`?room=CODE`). Host starts the game,
  can add bots to fill seats, and can start a rematch.
- Every action carries an `actionId`; duplicates are ignored, so retries and
  double-taps cannot duplicate a move.
- Reconnection: a private per-seat token (stored in the browser) restores
  your seat and hand. A response turn auto-passes after 30 s and a play turn
  auto-plays a simple legal move after 90 s, so one dropped phone never
  freezes the table. Leaving mid-game converts your seat to a bot so the
  game can finish. Idle rooms are cleaned up automatically.

## Project layout

```
engine.js               Pure game engine + bots (browser & server share it)
test-engine.js          Engine unit tests + 120-game bot fuzz
client/                 The web app (single index.html, engine.js copy,
                        manifest + service worker for PWA/offline bot play)
server/server.js        HTTP static server + WebSocket rooms (authoritative)
server/test-multiplayer.js  Live integration tests with real WS clients
test-browser.py         Playwright end-to-end test (mobile viewport)
```

## Assets & licenses

No third-party assets are used. Cards are drawn with HTML/CSS and suit
glyphs (♠ ♥ ♦ ♣); sounds are synthesised with the Web Audio API; icons are
generated locally. The only runtime dependency is
[`ws`](https://github.com/websockets/ws) (MIT) for the server. The game code
itself is original.
