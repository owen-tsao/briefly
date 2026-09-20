# Instagram sidecar

Polls one Instagram account's stories (default `zero2sudo`) for job links and writes them to
`~/.briefly/instagram.json`. briefly picks that file up on its next Jobs scan; the app never
talks to Instagram itself.

This lives outside the app on purpose. It uses Instagram's private API through a burner
account, which can be challenged or banned at any time. When that happens the sidecar
pauses itself and briefly shows "instagram.json is stale" — nothing else is affected.

## Status

**Written, not yet run.** It depends on `instagrapi`, which is not installed anywhere on
this machine, and on a burner account that doesn't exist yet. The field names it reads
(`Story.stickers[].story_link.url`, `Story.links[].webUri`, `Story.thumbnail_url`) were
checked against instagrapi's `types.py`; whether link stickers actually come back populated
for this account is spike 1d in `docs/jobs-plan.md` and is still unverified.

## Setup

1. Create a burner Instagram account. Follow `zero2sudo` from it. Never open the burner in a
   browser on this Mac.
2. From this folder:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
BRIEFLY_IG_USER=<burner> BRIEFLY_IG_PASS=<password> .venv/bin/python poll.py --login
```

   The first run logs in and saves a session to `~/.briefly/instagram-session.json`
   (mode 600). Later runs reuse it and need no credentials in the environment.

3. Check `~/.briefly/instagram.json` has items with real `url`s. If every `url` is `null`,
   link stickers aren't coming through and the story images in `~/.briefly/instagram-images/`
   are all we have — that's the kill condition for this source until OCR is added.

4. Schedule it: copy `com.briefly.instagram.plist` to `~/Library/LaunchAgents/`, replace
   the three `/Users/YOU/...` paths, then `launchctl load ~/Library/LaunchAgents/com.briefly.instagram.plist`.
   Log: `~/Library/Logs/briefly-instagram.log`.

## What it writes

```json
{ "version": 1, "generatedAt": "...", "target": "zero2sudo",
  "items": [ { "storyId": "...", "url": "https://...", "title": "Apply here", "caption": "...",
               "dcLink": false, "referralNote": null, "imagePath": "~/.briefly/instagram-images/....jpg",
               "takenAt": "...", "seenAt": "..." } ] }
```

Items are kept for 30 days. Stories with no link still get an entry (with `url: null` and the
image path) so nothing is lost; briefly ignores those until it can read images.
