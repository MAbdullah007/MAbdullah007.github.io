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
node test-engine.js                 # engine tests + bot fuzz (repo root)
node server/test-multiplayer.js     # live multiplayer integration tests
python3 test-browser.py             # Playwright: bot game, layout, 2-session room
```

## Deploy the multiplayer server (free tier: Render, one blueprint)

GitHub Pages (and other static hosts) can host the client, but a WebSocket
game server needs a real Node host. This repo ships a `render.yaml`
blueprint at its root, so deployment is:

1. Sign up at render.com (free).
2. **New → Blueprint**, pick this repository, **Apply**.
3. Done — Render builds `bluff-game/server` and starts it. You get a URL
   like `https://bluff-game.onrender.com`. Opening it serves the game, and
   Create Room / Join work immediately: when the page is served by the game
   server, the client connects back to the same host automatically.

(Manual alternative: New → Web Service, root directory `bluff-game/server`,
build `npm install`, start `npm start`, Free plan, health check `/healthz`.)

Notes: free instances sleep when idle, so the first visit after a break can
take ~30 seconds to wake. Rooms are held in memory — a server restart clears
active rooms (games in progress end). That is an accepted trade-off for a
free, database-free design.

## The rules (exactly as implemented)

- One standard **52-card deck**, no jokers, **2–6 players**, all cards dealt.
  Online rooms need **3–6 players** to start (the host can add bots to fill
  seats); bot games work with any count.
- **Declarations are separate from the actual cards.** On your turn you play
  **1–4 cards face down** and declare a rank. The actual cards stay secret;
  opponents see only the count and the declared rank. Two declaration
  styles, chosen when the game is created:
  - **Free bluff (default):** declare *any* rank on any play — play two
    Kings, declare two Queens.
  - **Sequence:** the first play of a round declares any rank; each later
    play in the round must declare the previous declared rank + 1.
- **Opening rule (custom):** the first play on an empty pile must contain
  **at least 2 cards** (2, 3 or 4). Only exception: a player holding exactly
  one card in total may play that single card. Enforced by the engine/server,
  not just the UI.
- **CHECK / PASS:** after every play, each other player in turn order chooses
  CHECK (challenge) or PASS. The first CHECK flips the played cards and
  compares them against the **declaration**:
  - all cards match the declared rank → the play was honest → the **checker
    takes the whole pile**;
  - any card differs → it was a bluff → the **player who played takes the
    whole pile**.
  The winner of a challenge leads the next round.
- **Everyone passes — BURN or ADD decision:** if nobody checks a play of
  1–3 cards, control returns to the player who made it. They choose:
  - **BURN PILE:** the whole active pile moves to the burned zone (tracked,
    never returns to play) and the *same player* opens a fresh play — the
    opening rule (min 2 cards) applies again.
  - **ADD MORE CARDS:** the same player plays more cards onto the existing
    pile with a new declaration, starting a new response cycle.
  The decision repeats after every all-pass, and every ADD moves at least
  one card from a hand to the pile, so the game always progresses. A
  challenge can never overlap a pending decision (the phases are exclusive
  in the engine's state machine), and a stalled decision auto-burns after
  30 s on the server.
- **Four of a kind (custom):** playing 4 cards declares four of a rank.
  Responses are the same CHECK/PASS, with one extra outcome: if
  **everyone passes**, the claim is believed and the **entire pile is
  burned automatically** (no decision needed); the four-player leads the
  next round. If someone CHECKs, the normal challenge decides who takes
  the pile (no burn).
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
- Rooms: each room has an internal UUID (server-side identity) plus a
  short 5-character shareable code (unambiguous alphabet, uniqueness
  checked against all live rooms) used in the invite link (`?room=CODE`).
  The host starts the game (minimum 3 seats), can add bots to fill seats,
  and can start a rematch. Host-only actions are enforced on the server;
  the code alone never authorizes anything — privileged actions require
  the connection that owns the host seat, and game actions require the
  seat's private token session.
- Every action carries an `actionId`; duplicates are ignored, so retries and
  double-taps cannot duplicate a move. Joins are serialized by the server:
  capacity (6) is enforced atomically, so two simultaneous joins racing
  for the last seat produce exactly one success.
- Reconnection: a private per-seat token (stored in the browser) restores
  your seat and hand. A response turn auto-passes after 30 s, a burn/add
  decision auto-burns after 30 s, and a play turn auto-plays a simple
  legal move after 90 s, so one dropped phone never freezes the table.
  Leaving mid-game converts your seat to a bot so the game can finish
  (announced in the lobby rules); leaving the lobby hands host to the
  next non-bot seat. Idle rooms are cleaned up after 45 minutes.
- Room lifecycle: Waiting → In Progress → Completed; abandoned rooms are
  swept automatically. `GET /healthz` reports server health for hosts.

## Fun layer (display only — never affects the game)

- **Avatars:** pick one of 10 standard Unicode emoji faces on the home
  screen or in the lobby; it appears beside your name in the lobby and at
  the table, synchronised by the server (validated against a fixed list).
  Bots get animal emoji avatars. No uploads, no photos, no external service.
- **Reactions:** one-tap Roman Urdu phrases ("Oye hoye!", "Pakray gaye!",
  "Wah ustad!"…) and emojis, shown as a speech bubble by your avatar for
  ~3 seconds. Online, the server relays only an index into the fixed list
  (no free text), with a 2-second per-player cooldown. Bots in bot games
  react to caught bluffs and wins.
- **Feedback & sound:** CSS effects (pile shake on a caught bluff, green
  glow on an honest check, burn flash, winner emoji burst) and Web Audio
  synthesised tones — card play, challenge, win/lose, room join, reaction
  pop. Sound toggle on the home screen and in game; reaction sounds have
  their own toggle inside the reaction panel. Audio only ever starts
  after a user tap (browser autoplay rules), and any audio failure is
  swallowed — the game never depends on it.

## Project layout

```
engine.js               Pure game engine + bots (browser & server share it)
test-engine.js          Engine tests + 160-game bot fuzz (both declaration modes)
client/                 The web app (single index.html, engine.js copy,
                        manifest + service worker for PWA/offline bot play)
server/server.js        HTTP static server + WebSocket rooms (authoritative)
server/test-multiplayer.js  Live integration tests with real WS clients
test-browser.py         Playwright tests: full bot game, 4-player layout at
                        320-430px, and a two-session online room flow
render.yaml             One-click Render blueprint for the public server
```

## Assets & licenses

No third-party assets are used. Cards are drawn with HTML/CSS and suit
glyphs (♠ ♥ ♦ ♣); sounds are synthesised with the Web Audio API; icons are
generated locally. Avatars and reaction emojis are standard Unicode
characters rendered by the device's own emoji font (no image files, no
downloads); the reaction phrases are original text written for this game.
The only runtime dependency is
[`ws`](https://github.com/websockets/ws) (MIT) for the server. The game code
itself is original.
