#!/usr/bin/env python3
"""
briefly Instagram sidecar — polls one account's stories for job links.

Writes ~/.briefly/instagram.json, which briefly reads on its next Jobs scan. This is
the only part of the jobs pipeline that lives outside the app, because it uses a
private API through a burner account and may be challenged or banned at any time.
Nothing in briefly depends on it succeeding.

Setup (one time, from this folder):
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python poll.py --login          # prompts for burner username/password
Then schedule hourly with the launchd plist next to this file (see README.md).

Rules baked in: one login, then a saved session forever; one request per poll;
never opens the burner in a browser; stops itself for 24h after a challenge or
scraping warning, and for good once the account is suspended.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BRIEFLY_DIR = Path.home() / ".briefly"
OUT_FILE = BRIEFLY_DIR / "instagram.json"
SESSION_FILE = BRIEFLY_DIR / "instagram-session.json"
IMAGES_DIR = BRIEFLY_DIR / "instagram-images"
PAUSE_FILE = BRIEFLY_DIR / "instagram-paused-until"
HALT_FILE = BRIEFLY_DIR / "instagram-halted"
TARGET = os.environ.get("BRIEFLY_IG_TARGET", "zero2sudo")
KEEP_DAYS = 30
DC_WORDS = re.compile(r"\b(dc|direct|dm|referral|refer)\b", re.I)


def log(msg: str) -> None:
    print(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}", file=sys.stderr)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def unwrap(url: str) -> str:
    """Instagram wraps outbound links as l.instagram.com/?u=<real>. Return the real one."""
    p = urlparse(url)
    if p.netloc.endswith("l.instagram.com"):
        real = parse_qs(p.query).get("u", [None])[0]
        if real:
            return real
    return url


def load_file() -> dict:
    if not OUT_FILE.exists():
        return {}
    try:
        data = json.loads(OUT_FILE.read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def load_existing() -> list[dict]:
    return load_file().get("items", [])


def write_status(state: str, reason: str, until: float | None = None) -> None:
    """Record the sidecar's health in the output file so briefly can say what is actually wrong.

    `generatedAt` is left alone: it means "when these items were last fetched", and a failed
    poll fetched nothing.
    """
    data = load_file()
    data.setdefault("version", 1)
    data.setdefault("target", TARGET)
    data.setdefault("items", [])
    status: dict = {"state": state, "reason": reason, "at": now_iso()}
    if until is not None:
        status["until"] = datetime.fromtimestamp(until, timezone.utc).isoformat()
    data["status"] = status
    atomic_write(OUT_FILE, data)


def paused() -> bool:
    if not PAUSE_FILE.exists():
        return False
    try:
        return time.time() < float(PAUSE_FILE.read_text().strip())
    except Exception:
        return False


def pause(hours: float) -> float:
    BRIEFLY_DIR.mkdir(parents=True, exist_ok=True)
    until = time.time() + hours * 3600
    PAUSE_FILE.write_text(str(until))
    return until


def halted() -> str | None:
    """A halt is permanent: only `--login` (i.e. a human with a new account) clears it."""
    if not HALT_FILE.exists():
        return None
    return HALT_FILE.read_text().strip() or "halted"


def halt(reason: str) -> None:
    BRIEFLY_DIR.mkdir(parents=True, exist_ok=True)
    HALT_FILE.write_text(reason)


def classify(e: Exception) -> tuple[str, str]:
    """Decide what a failed poll means: ("suspended" | "challenge" | "throttle" | "error", reason).

    Instagram's enforcement pages come back as HTTP 200 HTML after a redirect, so instagrapi
    raises a generic ClientJSONDecodeError whose message names the URL we *asked for*, not the
    page we *got*. The page we got is on `e.response.url`; that is where "suspended" and
    "scraping_warning" show up. The class name alone never catches these.
    """
    name = type(e).__name__
    response = getattr(e, "response", None)
    landed = str(getattr(response, "url", "") or "")
    text = f"{name} {e} {landed}".lower()
    if "/accounts/suspended" in landed or "suspended" in text:
        return "suspended", "Instagram suspended the burner account"
    if "scraping_warning" in landed or "scraping_warning" in text:
        return "challenge", "Instagram served a scraping warning"
    if any(k in text for k in ("challenge", "checkpoint", "login")):
        return "challenge", f"Instagram asked for a login or challenge ({name})"
    if any(k in text for k in ("wait", "throttl", "429")):
        return "throttle", f"Instagram asked to slow down ({name})"
    return "error", name


def server_said(cl) -> str:
    """Pull the human-readable sentences out of Instagram's last reply.

    The modern login flow answers with an opaque "bloks" UI blob. instagrapi
    cannot always classify it, and then re-raises the earlier, misleading
    "Your version of Instagram is out of date" error. The blob still contains
    the text the app would have shown ("We can't find an account...",
    "Sorry, your password was incorrect...", "Confirm it's you..."), so we
    surface that instead.
    """
    try:
        raw = cl.last_response.text
    except Exception:
        return ""
    txt = raw.encode().decode("unicode_escape", errors="ignore")
    hits = re.findall(r"[A-Z][a-z][^\"\\\n]{15,160}[.!?]", txt)
    seen: list[str] = []
    for h in hits:
        if h not in seen and "stop creating your account" not in h:
            seen.append(h)
    return " | ".join(seen[:4])


def login(cl, user: str, pw: str) -> None:
    try:
        cl.login(user, pw)
    except Exception as e:
        said = server_said(cl)
        if said:
            raise type(e)(f"{e} — Instagram actually said: {said}") from e
        raise


def client():
    from instagrapi import Client  # imported lazily so --help works without the venv

    cl = Client()
    cl.delay_range = [2, 5]
    if SESSION_FILE.exists():
        # Reuse the saved session as-is. If Instagram has expired it, the
        # stories request raises LoginRequired, poll() pauses, and the user
        # re-runs --login. No credential is needed or kept for this path.
        cl.load_settings(SESSION_FILE)
        return cl
    sessionid = os.environ.get("BRIEFLY_IG_SESSIONID", "").strip()
    if sessionid:
        # Cookie hand-off: Instagram sometimes refuses password login for new
        # accounts ("password incorrect" even when it is right) while a browser
        # session is accepted. The sessionid cookie skips the password gate.
        cl.login_by_sessionid(sessionid)
    else:
        user, pw = os.environ.get("BRIEFLY_IG_USER"), os.environ.get("BRIEFLY_IG_PASS")
        if not user or not pw:
            sys.exit("first run needs BRIEFLY_IG_USER and BRIEFLY_IG_PASS (or BRIEFLY_IG_SESSIONID) in the environment")
        login(cl, user, pw)
    BRIEFLY_DIR.mkdir(parents=True, exist_ok=True)
    cl.dump_settings(SESSION_FILE)
    os.chmod(SESSION_FILE, 0o600)
    return cl


def target_user_id(cl) -> int:
    """The target's numeric id never changes; look it up once so each poll is a single request."""
    cache = BRIEFLY_DIR / f"instagram-uid-{TARGET}"
    if cache.exists():
        try:
            return int(cache.read_text().strip())
        except ValueError:
            pass
    uid = int(cl.user_id_from_username(TARGET))
    BRIEFLY_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(str(uid))
    return uid


def poll() -> int:
    why = halted()
    if why:
        log(f"halted: {why} — a new account and `poll.py --login` are needed; skipping")
        return 0
    if paused():
        log("paused after a recent challenge; skipping")
        return 0
    # launchd fires on a fixed clock; a little jitter keeps the pattern from being a metronome.
    if os.environ.get("BRIEFLY_IG_JITTER", "1") != "0" and sys.stdin.isatty() is False:
        time.sleep(random.uniform(0, 240))
    try:
        cl = client()
        uid = target_user_id(cl)
        stories = cl.user_stories(uid)
    except Exception as e:
        kind, reason = classify(e)
        # instagrapi already dumps the full HTML page to the log; keep our own line readable.
        log(f"{type(e).__name__}: {str(e)[:300]} [{kind}]")
        if kind == "suspended":
            halt(reason)
            write_status("halted", reason)
            log("halted for good — the account is suspended, so polling can only make things worse")
        elif kind == "challenge":
            until = pause(24)
            write_status("paused", reason, until)
            log("paused for 24h — do NOT open the burner in a browser on this machine")
        elif kind == "throttle":
            until = pause(3)
            write_status("paused", reason, until)
            log("paused for 3h")
        return 1

    existing = {f"{it['storyId']}:{it.get('url')}": it for it in load_existing()}
    seen_stories = {it["storyId"] for it in existing.values()}
    now = now_iso()
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    new = 0
    for s in stories:
        sid = str(s.pk)
        if sid in seen_stories:
            continue
        # Link stickers are the primary payload; legacy `links` is the swipe-up field.
        urls: list[tuple[str, str | None]] = []
        for st in s.stickers or []:
            if st.story_link and st.story_link.url:
                urls.append((unwrap(str(st.story_link.url)), st.story_link.link_title))
        for ln in s.links or []:
            urls.append((unwrap(str(ln.webUri)), None))
        # The same link often appears both as a sticker and as the legacy
        # swipe-up field; keep the first (sticker, which carries the title).
        deduped: dict[str, str | None] = {}
        for url, title in urls:
            deduped.setdefault(url, title)
        urls = list(deduped.items())
        # Screenshot-only story: keep the image so it can be read later, no URL yet.
        image_path = None
        if s.thumbnail_url:
            try:
                image_path = str(cl.story_download_by_url(str(s.thumbnail_url), filename=sid, folder=IMAGES_DIR))
            except Exception as e:
                log(f"thumbnail download failed for {sid}: {e}")
        titles = " ".join(t for _, t in urls if t)
        for url, title in urls or [(None, None)]:
            item = {
                "storyId": sid,
                "url": url,
                "title": title,
                "caption": titles or None,
                "dcLink": bool(DC_WORDS.search(titles)),
                "referralNote": titles if DC_WORDS.search(titles) else None,
                "imagePath": image_path,
                "takenAt": s.taken_at.astimezone(timezone.utc).isoformat(),
                "seenAt": now,
            }
            existing[f"{sid}:{url}"] = item
            new += 1

    cutoff = time.time() - KEEP_DAYS * 86400
    items = [
        it
        for it in existing.values()
        if datetime.fromisoformat(it["seenAt"]).timestamp() > cutoff
    ]
    atomic_write(
        OUT_FILE,
        {
            "version": 1,
            "generatedAt": now,
            "target": TARGET,
            "status": {"state": "ok", "reason": "", "at": now},
            "items": items,
        },
    )
    log(f"{len(stories)} stories live, {new} new items, {len(items)} kept")
    return 0


def main() -> int:
    global TARGET
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--login", action="store_true", help="log in once and save the session, then poll")
    ap.add_argument("--target", default=TARGET, help="account whose stories to read")
    args = ap.parse_args()
    TARGET = args.target
    if args.login:
        # A fresh login is the only thing that lifts a halt or pause: it means a human has a
        # working account again.
        for stale in (SESSION_FILE, HALT_FILE, PAUSE_FILE):
            if stale.exists():
                stale.unlink()
    if args.login and sys.stdin.isatty() and not os.environ.get("BRIEFLY_IG_SESSIONID"):
        # Prompting avoids zsh interpreting $, !, # or quotes inside the password.
        import getpass

        sid = input("Instagram 'sessionid' cookie (paste the full Cookie Value; press Enter to use a password instead): ").strip()
        if sid:
            print(f"received {len(sid)} chars starting with {sid[:6]}… (expect ~85+ chars starting with digits)")
            os.environ["BRIEFLY_IG_SESSIONID"] = sid
        else:
            if not os.environ.get("BRIEFLY_IG_USER"):
                os.environ["BRIEFLY_IG_USER"] = input("Instagram burner username: ").strip()
            if not os.environ.get("BRIEFLY_IG_PASS"):
                os.environ["BRIEFLY_IG_PASS"] = getpass.getpass("Instagram burner password (hidden): ")
    return poll()


if __name__ == "__main__":
    sys.exit(main())
