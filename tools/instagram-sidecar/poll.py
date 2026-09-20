#!/usr/bin/env python3
"""
briefly Instagram sidecar — polls one account's stories for job links.

Writes ~/.briefly/instagram.json, which briefly reads on its next Jobs scan. This is
the only part of the jobs pipeline that lives outside the app, because it uses a
private API through a burner account and may be challenged or banned at any time.
Nothing in briefly depends on it succeeding.

Setup (one time, from this folder):
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    BRIEFLY_IG_USER=<burner> BRIEFLY_IG_PASS=<pw> .venv/bin/python poll.py --login
Then schedule hourly with the launchd plist next to this file (see README.md).

Rules baked in: one login, then a saved session forever; one request per poll;
never opens the burner in a browser; stops itself for 24h after a challenge.
"""
from __future__ import annotations

import argparse
import json
import os
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
TARGET = os.environ.get("BRIEFLY_IG_TARGET", "zero2sudo")
KEEP_DAYS = 30
DC_WORDS = re.compile(r"\b(dc|direct|dm|referral|refer)\b", re.I)


def log(msg: str) -> None:
    print(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}", file=sys.stderr)


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


def load_existing() -> list[dict]:
    if not OUT_FILE.exists():
        return []
    try:
        return json.loads(OUT_FILE.read_text()).get("items", [])
    except Exception:
        return []


def paused() -> bool:
    if not PAUSE_FILE.exists():
        return False
    try:
        return time.time() < float(PAUSE_FILE.read_text().strip())
    except Exception:
        return False


def pause(hours: float) -> None:
    PAUSE_FILE.write_text(str(time.time() + hours * 3600))


def client():
    from instagrapi import Client  # imported lazily so --help works without the venv

    cl = Client()
    cl.delay_range = [2, 5]
    if SESSION_FILE.exists():
        cl.load_settings(SESSION_FILE)
        # Reuses the saved session; only re-authenticates if the server rejected it.
        cl.login(os.environ.get("BRIEFLY_IG_USER", ""), os.environ.get("BRIEFLY_IG_PASS", ""))
    else:
        user, pw = os.environ.get("BRIEFLY_IG_USER"), os.environ.get("BRIEFLY_IG_PASS")
        if not user or not pw:
            sys.exit("first run needs BRIEFLY_IG_USER and BRIEFLY_IG_PASS in the environment")
        cl.login(user, pw)
        BRIEFLY_DIR.mkdir(parents=True, exist_ok=True)
        cl.dump_settings(SESSION_FILE)
        os.chmod(SESSION_FILE, 0o600)
    return cl


def poll() -> int:
    if paused():
        log("paused after a recent challenge; skipping")
        return 0
    try:
        cl = client()
        uid = cl.user_id_from_username(TARGET)
        stories = cl.user_stories(uid)
    except Exception as e:  # ChallengeRequired, LoginRequired, PleaseWaitFewMinutes, ...
        name = type(e).__name__
        log(f"{name}: {e}")
        if "Challenge" in name or "Login" in name or "Checkpoint" in name:
            pause(24)
            log("paused for 24h — do NOT open the burner in a browser on this machine")
        elif "Wait" in name or "Throttl" in name:
            pause(3)
        return 1

    existing = {f"{it['storyId']}:{it.get('url')}": it for it in load_existing()}
    seen_stories = {it["storyId"] for it in existing.values()}
    now = datetime.now(timezone.utc).isoformat()
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
    atomic_write(OUT_FILE, {"version": 1, "generatedAt": now, "target": TARGET, "items": items})
    log(f"{len(stories)} stories live, {new} new items, {len(items)} kept")
    return 0


def main() -> int:
    global TARGET
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--login", action="store_true", help="log in once and save the session, then poll")
    ap.add_argument("--target", default=TARGET, help="account whose stories to read")
    args = ap.parse_args()
    TARGET = args.target
    if args.login and SESSION_FILE.exists():
        SESSION_FILE.unlink()
    return poll()


if __name__ == "__main__":
    sys.exit(main())
