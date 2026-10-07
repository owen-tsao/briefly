# Instagram sidecar

Polls one Instagram account's stories (default `zero2sudo`) for job links and writes them to
`~/.briefly/instagram.json`. briefly picks that file up on its next Jobs scan; the app never
talks to Instagram itself.

This lives outside the app on purpose. It uses Instagram's private API through a burner
account, which can be challenged or banned at any time. When that happens the sidecar
pauses or halts itself and briefly's scan notice says which — nothing else is affected.

## Status

**Retired, 2026-10-01.** The approach worked: the first live poll on 2026-09-25 returned 25
stories, 19 with real ATS links (Ashby, Greenhouse, Amazon, SmartRecruiters, Google, iCIMS…),
so link stickers do come through for this account. The account did not: polling every 30
minutes, Instagram served a scraping warning after four days (Sep 29) and suspended the burner
two days later (Oct 1). The sidecar kept polling through the warning because its challenge
detection only looked at exception class names, and Instagram's enforcement pages arrive as a
generic `ClientJSONDecodeError` (fixed; see "When the session dies"). The launchd job is
disabled. zero2sudo links now come in through briefly's paste-a-link box instead.

If you try again: a new burner, the hourly plist, and expect the same lifetime — days to
weeks, not months. Screenshot-only stories still land in `~/.briefly/instagram-images/`.

## Setup

1. Create a burner Instagram account, kept out of Meta Accounts Center, and follow `zero2sudo`
   from it. Brand-new accounts get their *password* login refused by Instagram's risk system,
   so log in once in a browser and hand the session cookie to the sidecar (step 2). After that
   the burner does not need to be opened anywhere else.
2. From this folder, using a Python 3.10 or newer (macOS's built-in `python3` is 3.9, which only gets
   a retired `instagrapi` that Instagram rejects with "Your version of Instagram is out of date"):

```bash
/opt/homebrew/bin/python3.12 -m venv .venv      # brew install python@3.12 if missing
.venv/bin/pip install -r requirements.txt
.venv/bin/python poll.py --login          # prompts for a sessionid cookie, or username + password
```

   The first run logs in and saves a session to `~/.briefly/instagram-session.json`
   (mode 600). Later runs reuse it and need no credentials in the environment.

   **Prefer the cookie.** Instagram often refuses password logins from new accounts
   with "The password you entered is incorrect" even when it is right (see
   [instagrapi#2807](https://github.com/subzeroid/instagrapi/issues/2807)); a browser
   session is still accepted. To get one: sign in to instagram.com as the burner in a
   private window, open DevTools → Application → Cookies → `https://www.instagram.com`,
   copy the value of `sessionid`, paste it at the prompt, then close the private window
   without logging out (logging out invalidates the cookie).

   If you use the password path, type it at the prompt rather than putting it on the
   command line; zsh interprets `$`, `!`, `#` and quotes. If the log says "Your version
   of Instagram is out of date", ignore that part and read the "Instagram actually
   said: ..." suffix; that is the real reason.

3. Check `~/.briefly/instagram.json` has items with real `url`s. If every `url` is `null`,
   link stickers aren't coming through and the story images in `~/.briefly/instagram-images/`
   are all we have — that's the kill condition for this source until OCR is added.

4. Schedule it: copy `com.briefly.instagram.plist` to `~/Library/LaunchAgents/`, replace
   the three `/Users/YOU/...` paths, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.briefly.instagram.plist`.
   Log: `~/Library/Logs/briefly-instagram.log`. The agent runs hourly and once at login.

## When the session dies

Instagram's enforcement comes in stages, and the sidecar reacts to each by reading the page it
was redirected to (`e.response.url`), not just the exception type:

| Instagram does | Sidecar does | briefly shows |
|---|---|---|
| expires the session, asks for a challenge, or serves `/accounts/scraping_warning/` | pauses 24h (`~/.briefly/instagram-paused-until`) | "Instagram sidecar paused — …, retrying after …" |
| rate-limits | pauses 3h | same |
| serves `/accounts/suspended/` | halts for good (`~/.briefly/instagram-halted`) and stops returning items | "Instagram sidecar halted — Instagram suspended the burner account on …" |
| nothing, but the job isn't running | — | "instagram.json last written Nh ago — the sidecar's launchd job isn't running" |

A pause lifts itself. A halt does not: only `poll.py --login` clears it, because recovering from
a suspension means a human has a new account. To recover from a pause early, delete
`~/.briefly/instagram-paused-until`, grab a fresh `sessionid` from a browser login, and run
`poll.py --login`.

To stop the job: `launchctl bootout gui/$(id -u)/com.briefly.instagram && launchctl disable gui/$(id -u)/com.briefly.instagram`.
To start it again: `launchctl enable gui/$(id -u)/com.briefly.instagram && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.briefly.instagram.plist`.

## What it writes

```json
{ "version": 1, "generatedAt": "...", "target": "zero2sudo",
  "status": { "state": "ok | paused | halted", "reason": "...", "at": "...", "until": "..." },
  "items": [ { "storyId": "...", "url": "https://...", "title": "Apply here", "caption": "...",
               "dcLink": false, "referralNote": null, "imagePath": "~/.briefly/instagram-images/....jpg",
               "takenAt": "...", "seenAt": "..." } ] }
```

`generatedAt` is when items were last fetched; a failed poll updates `status` but leaves it alone.

Items are kept for 30 days. Stories with no link still get an entry (with `url: null` and the
image path) so nothing is lost; briefly ignores those until it can read images.
