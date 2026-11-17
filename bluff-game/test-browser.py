#!/usr/bin/env python3
"""Browser tests: (1) full bot game with declarations + burn/add decisions,
(2) 4-player table layout at 320/360/390/430 px + long names,
(3) online room with TWO independent browser sessions (create, join by
code/link, lobby sync, min-3 rule, start, privacy, state sync)."""
import subprocess, sys, time, os, signal, re
from playwright.sync_api import sync_playwright

PORT = 18098
ROOT = os.path.expanduser("~/workspace/bluff-game")
shots = os.path.join(ROOT, "test-shots")
os.makedirs(shots, exist_ok=True)
EXE = os.path.expanduser("~/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell")

server = subprocess.Popen(
    ["node", "server.js"], cwd=os.path.join(ROOT, "server"),
    env={**os.environ, "PORT": str(PORT)},
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
fails = []
def check(cond, name):
    print(("  ok - " if cond else "  FAIL - ") + name)
    if not cond:
        fails.append(name)

def human_act(page):
    """One policy step for whichever human this page controls."""
    banner = page.inner_text("#turnBanner")
    if banner.startswith("Your turn"):
        m = re.search(r"at least (\d+)", banner)
        need = int(m.group(1)) if m else 1
        cards = page.locator(".pcard")
        total = cards.count()
        if total == 0:
            return
        n = min(total, max(need, 2))
        first_rank = None
        for i in range(n):
            r = cards.nth(i).locator(".r").inner_text()
            if first_rank is None:
                first_rank = r
            cards.nth(i).click()
            page.wait_for_timeout(60)
        # declaration: if no chip is lit, click the chip matching the first card
        if page.locator("#rankGrid .rankChip.on").count() == 0 and page.locator("#rankGrid").is_visible():
            chip = page.locator("#rankGrid .rankChip", has_text=re.compile("^" + re.escape(first_rank) + "$")).first
            chip.click()
        btn = page.locator("#actionBar .btn").first
        try:
            if btn.is_enabled(timeout=1200):
                btn.click()
        except Exception:
            pass
    elif "Everyone passed!" in banner:
        my_cards = page.locator(".pcard").count()
        label = "Burn pile" if my_cards <= 6 else "Add more cards"
        page.locator("#actionBar .btn", has_text=label).first.click()
    elif "Your call" in banner or "CHECK it" in banner:
        page.locator("#actionBar .btn", has_text="PASS").first.click()

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=EXE)

        """ ---------- 1) full bot game ---------- """
        page = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        page.set_default_timeout(9000)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")
        check(page.title().startswith("Bluff"), "page loads, title: " + page.title())
        page.click("#howBtn")
        page.wait_for_selector("#howModal:not(.hidden)")
        how = page.inner_text("#howModal")
        check("declare" in how.lower() and "Burn the pile" in how, "How to Play explains declarations and burn/add")
        page.click("#closeHowBtn")
        page.fill("#nameInput", "Tester")
        check(page.locator("#avatarPick button").count() == 10, "avatar picker shows 10 avatars")
        page.click("#avatarPick button[data-a='🦸']")
        saved_avatar = page.evaluate("JSON.parse(localStorage.getItem('bluff-settings')).avatar")
        check(saved_avatar == "🦸", "chosen avatar is saved")
        page.click("#playBotsBtn")
        page.wait_for_selector("#gameWrap:not(.hidden)")
        page.wait_for_selector(".pcard")
        n_cards = page.locator(".pcard").count()
        check(10 <= n_cards <= 26, f"hand dealt ({n_cards} cards in a 3-player game)")
        check(page.locator(".opp").count() == 2, "two bot opponents shown")
        check(page.locator(".opp .avatar .face").count() == 2, "bot opponents show emoji avatars")
        page.click("#rxnToggle")
        page.wait_for_selector("#rxnPanel:not(.hidden)")
        check(page.locator("#rxnPanel .rxnChip[data-kind='phrase']").count() == 12, "reaction panel lists 12 phrases")
        page.click("#rxnPanel .rxnChip[data-kind='phrase'][data-i='3']")
        page.wait_for_function("document.querySelector('#myBubble').classList.contains('show')")
        check(page.inner_text("#myBubble") == "Pakray gaye!", "my reaction bubble shows the tapped phrase")
        page.screenshot(path=os.path.join(shots, "1-table-start.png"))

        won = False
        saw_declare_panel = False
        saw_decision = False
        for step in range(1600):
            if page.locator("#winnerModal:not(.hidden)").count():
                won = True
                break
            if page.locator("#declPanel:not(.hidden)").count():
                saw_declare_panel = True
            banner = page.inner_text("#turnBanner")
            if "Everyone passed!" in banner:
                saw_decision = True
            human_act(page)
            page.wait_for_timeout(130)
        check(won, "bot game in the browser reaches the winner screen")
        check(saw_declare_panel, "declaration panel appeared on human turns")
        check(saw_decision, "burn/add decision appeared during the game")
        if won:
            check(len(page.inner_text("#winnerName")) > 0, "winner announced: " + page.inner_text("#winnerName"))
            page.screenshot(path=os.path.join(shots, "2-winner.png"))
            page.click("#playAgainBtn")
            page.wait_for_timeout(900)
            check(page.locator("#winnerModal.hidden").count() == 1 and page.locator(".pcard").count() > 0,
                  "Play Again deals a fresh game")
        check(not errors, "no JavaScript page errors" + (": " + "; ".join(errors[:3]) if errors else ""))
        page.close()

        """ ---------- 2) four-player layout at mobile widths ---------- """
        lp = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        lp.set_default_timeout(9000)
        lp.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")
        lp.fill("#nameInput", "BartholomewMaxim")
        lp.locator("#botCountSeg button[data-v='3']").click()
        lp.click("#playBotsBtn")
        lp.wait_for_selector(".pcard")
        check(lp.locator(".opp").count() == 3, "4-player game shows 3 opponents around the table")
        for w in (320, 360, 390, 430):
            lp.set_viewport_size({"width": w, "height": 800})
            lp.wait_for_timeout(350)
            m = lp.evaluate("""() => {
              const de = document.documentElement;
              const opps = Array.from(document.querySelectorAll('.opp')).map(el => {
                const r = el.getBoundingClientRect();
                return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
              });
              const pile = document.querySelector('#pileArea').getBoundingClientRect();
              return { sw: de.scrollWidth, iw: window.innerWidth, opps, pileIn: pile.left >= 0 && pile.right <= window.innerWidth };
            }""")
            check(m["sw"] <= m["iw"] + 1, f"no horizontal overflow at {w}px (scrollWidth {m['sw']})")
            check(all(0 <= o["left"] and o["right"] <= w + 1 for o in m["opps"]), f"all opponents inside the viewport at {w}px")
            check(m["pileIn"], f"central pile visible at {w}px")
            if w in (320, 390):
                lp.screenshot(path=os.path.join(shots, f"3-layout-{w}.png"))
        # Long names truncate instead of breaking the chip
        trunc = lp.evaluate("""() => {
          const nm = document.querySelector('.opp .nm');
          nm.textContent = 'BartholomewMaximilian';
          const chip = nm.closest('.opp');
          return { truncated: nm.scrollWidth > nm.clientWidth, chipW: chip.offsetWidth };
        }""")
        check(trunc["truncated"] and trunc["chipW"] <= 96, "long opponent names truncate inside the chip")
        lp.close()

        """ ---------- 3) online room, two independent sessions ---------- """
        ctxA = browser.new_context(viewport={"width": 390, "height": 844})
        ctxB = browser.new_context(viewport={"width": 390, "height": 844})
        A = ctxA.new_page(); B = ctxB.new_page()
        A.set_default_timeout(12000); B.set_default_timeout(12000)
        errs2 = []
        A.on("pageerror", lambda e: errs2.append("A: " + str(e)))
        B.on("pageerror", lambda e: errs2.append("B: " + str(e)))
        A.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")
        A.fill("#nameInput", "HostA")
        A.click("#avatarPick button[data-a='🦸']")
        A.click("#createRoomBtn")
        A.wait_for_selector("#lobbyScreen:not(.hidden)")
        code = A.inner_text("#lobbyCode").strip()
        check(re.fullmatch(r"[A-Z2-9]{5}", code) is not None, "host created a room, code " + code)
        status1 = A.inner_text("#lobbyStatus")
        check("Waiting for players" in status1, "lobby shows the waiting message with 1 player")
        check(not A.locator("#startGameBtn").is_enabled(), "start disabled with 1 player")

        B.goto(f"http://127.0.0.1:{PORT}/?room={code}", wait_until="networkidle")
        check(B.input_value("#joinCodeInput") == code, "invitation link pre-fills the room code")
        B.fill("#nameInput", "GuestB")
        B.click("#joinRoomBtn")
        B.wait_for_selector("#lobbyScreen:not(.hidden)")
        A.wait_for_function("document.querySelectorAll('#lobbyPlayers .prow').length === 2")
        B.wait_for_function("document.querySelectorAll('#lobbyPlayers .prow').length === 2")
        check(True, "both sessions see the same 2-player lobby")
        faces_b = B.eval_on_selector_all("#lobbyPlayers .prow .avatar .face", "els => els.map(e => e.textContent)")
        check("🦸" in faces_b, "guest sees the host's chosen avatar in the lobby")
        status2 = A.inner_text("#lobbyStatus")
        check("at least one more player" in status2, "lobby shows 'waiting for at least one more player' with 2 players")
        check(not A.locator("#startGameBtn").is_enabled(), "start still disabled with 2 players (minimum is 3)")

        A.click("#addBotBtn")
        A.wait_for_function("document.querySelectorAll('#lobbyPlayers .prow').length === 3")
        B.wait_for_function("document.querySelectorAll('#lobbyPlayers .prow').length === 3")
        check(A.locator("#startGameBtn").is_enabled(), "start enabled at 3 players (host + guest + bot)")
        A.click("#startGameBtn")
        A.wait_for_selector("#gameWrap:not(.hidden)")
        B.wait_for_selector("#gameWrap:not(.hidden)")
        A.wait_for_selector(".pcard"); B.wait_for_selector(".pcard")
        a_cards = set(A.eval_on_selector_all(".pcard", "els => els.map(e => e.dataset.card)"))
        b_cards = set(B.eval_on_selector_all(".pcard", "els => els.map(e => e.dataset.card)"))
        check(len(a_cards) >= 8 and len(b_cards) >= 8, "both players received their own hands")
        check(a_cards.isdisjoint(b_cards), "the two hands are different (no shared/duplicated cards)")
        b_dom = B.eval_on_selector_all("[data-card]", "els => els.map(e => e.dataset.card)")
        check(not any(c in b_dom for c in a_cards), "A's private cards never appear in B's page")
        # Reaction sync: host taps a phrase; it must appear by his avatar on B's screen.
        A.click("#rxnToggle")
        A.click("#rxnPanel .rxnChip[data-kind='phrase'][data-i='0']")
        B.wait_for_function("!!document.querySelector('.opp .bubble.show')", timeout=8000)
        b_bubble = B.eval_on_selector(".opp .bubble.show", "e => e.textContent")
        check(b_bubble == "Oye hoye!", "host's reaction appears by his avatar on the guest's screen")
        # Drive until a public play lands; both screens must agree.
        synced = False
        for step in range(160):
            da = A.inner_text("#declareLine").strip()
            db = B.inner_text("#declareLine").strip()
            if da and da == db and "declared" in da:
                synced = True
                break
            human_act(A); human_act(B)
            A.wait_for_timeout(150); B.wait_for_timeout(150)
        check(synced, "both sessions show the same public declaration (state is synchronized)")
        A.screenshot(path=os.path.join(shots, "4-online-A.png"))
        B.screenshot(path=os.path.join(shots, "5-online-B.png"))
        check(not errs2, "no JavaScript errors in the online sessions" + (": " + "; ".join(errs2[:3]) if errs2 else ""))
        ctxA.close(); ctxB.close()
        browser.close()
finally:
    server.send_signal(signal.SIGTERM)

print("\nBrowser tests:", "ALL PASSED" if not fails else f"{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
