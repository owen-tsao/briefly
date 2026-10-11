# briefly

A Mac menu bar task planner that reads your Apple Notes and uses an LLM to turn the mess into an organized board.

You keep dumping todos into Notes exactly like you already do. briefly reads them (read-only — it never modifies a note, and never touches locked notes), extracts real tasks, and organizes them into time zones — Today, Soon, Someday — with a day-pulse progress line and a "what changed" diff after every scan.

## Features

- **Time-zoned board** — tasks live in Today / Soon / Someday zones; deadlines due by tomorrow auto-promote into Today. Track, urgency, and zone are one-click dropdowns on every row, and manual picks are pinned so scans never reclassify them
- **Day pulse** — progress bar plus due-today/overdue counts, computed locally; "what changed" scan diff below it, dismissible per line
- **Daily repeating tasks** — mark a task as repeating and it reopens every morning after you check it off
- **Quick add** — type a task straight onto the board, no LLM round-trip
- **Edit in place** — click a task's text and retype it; manual edits are sticky and never overwritten by later scans
- **Deadline notifications** — one grouped native notification a day for tasks overdue or due by tomorrow
- **Source note jump** — click the note title on a task to open it in Apple Notes
- **Done this week** — collapsed day-by-day recap of completed tasks
- **Notes browser** — see every note, search them, and import tasks from a specific note on demand (even old ones outside the scan window)
- **Ask** — free-form questions over your notes, with a retrieval pass that finds relevant notes by content, not just title
- **Persistent state** — check off, snooze, or dismiss tasks; your choices survive rescans (a dismissed task stays dismissed even if the note still mentions it)
- **Menu bar native** — open-task badge count, ⌥B global hotkey, background auto-rescan, launch at login
- **Light/dark mode** with a proper theme, not just inverted colors
- **Private by design** — notes are read-only, locked notes are skipped, the API key is stored encrypted with macOS `safeStorage`

## Jobs tab

briefly also watches for internship postings so you don't have to refresh job boards. It pulls from the public ApplyGuy, SimplifyJobs, SpeedyApply, and Jobright feeds, plus the career pages of companies you list in a watchlist, then scores each new posting against your resume and preferences with the same LLM. Verdicts are **apply**, **flagged**, or **skip** with a one-line reason.

- The same posting from several feeds is merged into one row. Hourly pay comes from SpeedyApply when it has it, otherwise briefly reads it out of the description (pay-transparency laws put a range in most postings now)
- Eligible postings are split into **Apply now** and **Also eligible**. Apply now means the screen passed *and* there's a reason to move fast: the company is on your Tier 1 or Tier 2 list, the stated pay meets your floor (default $50/hr), you've applied to that company before, it's on your watchlist, or it came from zero2sudo. Nothing skips the screen — those are ranking signals, not shortcuts. The list shows the newest arrivals first (by the day briefly first saw them), strongest signal first within a day, so opening the app answers "what came in since I last looked". Apply-now postings that are less than a day old also trigger a notification the moment they're scored
- Boards you apply on are pinned automatically: when you mark a Greenhouse, Lever, Ashby or Workday posting as applied, that board is added to `watchlist.md` under an "Auto" heading and polled directly from then on. Delete a line to stop; it won't be re-added
- Scans run every 5 minutes by default. Company boards and ApplyGuy are checked every tick; the large READMEs every 15 minutes, and only re-downloaded when the file actually changed (the feed host answers "not modified" otherwise), so frequent polling stays cheap for everyone
- Postings are scored a few at a time in the background, newest first, so a free-tier API key is enough
- Track your own status per posting — Saved, Applying, Applied, OA, Interview, Offer — with a note. Your status always wins; a rescan never changes it, and Applied history survives a posting disappearing from the feeds
- "Add to Today" puts an apply task on your board, with the deadline if the posting has one. It's always a click, never automatic
- **Paste a link** into the search box to add a posting the feeds don't carry (a role a friend sent you, a company that isn't on any board). The card appears immediately with the company and title guessed from the link, gets screened like everything else, and picks up the real title, location and posted date when the page is read. Apply works right away; screening is advice on a pasted card, not a gate. A pasted posting is never hidden automatically (a matcher "skip" lands in Flagged with the reason) and never expires for being "no longer listed", since no feed lists it. Pasting a link that's already on the board brings that row back up instead of duplicating it
- **Apply** opens the posting in briefly's own browser window (a separate Chromium profile that keeps you signed in to the application systems you use) and fills the form from `answers.md`: contact details, education, work authorization, EEO answers, the resume PDF named in `answers.md`. Essay-style questions are drafted from `voice.md` plus live research of the posting and the company's site; leftover multiple-choice questions get one model pass constrained to the policies you wrote down. Filled fields are outlined green, anything the model decided is yellow, and a bar at the top lists what is still yours. Nothing is ever submitted for you — you press Submit, and the card flips to Applied when the confirmation page appears. Greenhouse, Lever, Ashby and Workday are handled with their quirks; iCIMS and anything else open the same way and are filled page by page with the bar's "Fill this page" button, since those systems want an account first and then walk you through steps. The browser never types into a site other than the one the application started on, so a bad link from a public feed cannot pull your details onto a stranger's page.
- **Apply with Aside** (in the card menu) is the manual escape hatch: it hands the posting to [Aside](https://aside.com) with a prompt built from the same files. Aside is told to type from `answers.md`, upload only your resume PDF, and stop before submitting; it may sign in only on a recognised applicant-tracking hostname. Aside has no hard submit gate, so supervise it.

Your profile lives in `~/.briefly/profile/` as markdown files you edit in any editor: `resume.md` and `preferences.md` (what the matcher reads — hard blockers, soft flags, pay floor), `rules.md` (deterministic filters, your Tier 1 and Tier 2 lists, and the Apply-now pay floor), `watchlist.md` (companies whose careers boards briefly polls directly, like `Stripe greenhouse:stripe`; this is where a posting shows up first, because the public feeds lag company boards by hours to a day), `answers.md` (standard application answers Aside fills from), and `voice.md` (facts and style rules Aside uses to draft "why us" / "tell us about a project" answers in your words). Settings has buttons to open each one. Editing the resume or preferences re-scores every active posting on the next scan; editing `rules.md` re-runs the rule checks (no API cost).

Instagram (`zero2sudo` stories) is handled by a small separate script in `tools/instagram-sidecar/` because it uses a private API through a burner account and may get banned; see its README. It is written but not yet running.

Current limits: the Instagram sidecar needs a burner account and one `pip install` before it does anything; postings on Oracle HCM and some company-hosted pages can't be read, so they're flagged as triage-only; verdicts are only as good as your `resume.md` and `preferences.md`.

## Setup

1. `npm install`
2. Get a free API key at [console.groq.com](https://console.groq.com) (no credit card)
3. `npm run dev`
4. Click the `✓ briefly` item in the menu bar, open Settings, paste your key
5. Hit "Scan my notes" — the first scan triggers a one-time macOS permission prompt to let the app read Notes

Any OpenAI-compatible endpoint works: point the base URL in Settings at OpenAI, Cerebras, or a local server instead of Groq. Once a key is saved, the model dropdown lists live models from your provider.

## How it works

```
Apple Notes --(osascript/JXA, read-only)--> Electron main
    --(recent note bodies + library title index)--> LLM
    --(task merge JSON + scan diff)--> task store (JSON on disk)
    --> menu bar popover (React + Tailwind)
```

On each scan the LLM receives your current open tasks alongside fresh notes and returns a merge — new tasks, updated ones, and ones that no longer appear. User state always wins over the model: done and dismissed tasks are never resurrected, and tasks you've renamed keep your wording.

Ask questions run a two-pass flow: a retrieval call picks relevant notes from the full library index (titles are matched semantically — a note called "spots" can answer a question about viewpoints), then those notes' contents are used to answer.

The Jobs pipeline lives in `src/main/jobs/`: `sources/` fetch feeds and watchlist boards, `extract.ts` reads posting text via the Greenhouse/Lever/Ashby/Workday JSON APIs (plain HTML as a fallback), `match.ts` scores postings in small batches, and `pipeline.ts` runs it all on a 15-minute tick that pauses while the popover is open. Design notes and spike results are in `docs/jobs-plan.md`.

## Scripts

- `npm run dev` — run with hot reload
- `npm run build` — production build
- `npm run typecheck` — type-check main + renderer
- `npm run package` — build the signed-adhoc `.app` and `.dmg` into `dist/`

The packaged app lands in `dist/mac-arm64/briefly.app`; copy it over `/Applications/briefly.app` after packaging, or the Dock keeps launching the previous build. Two dev-only helpers in `scripts/` drive a running copy: `cdp-eval.mjs` runs JavaScript in the popover (launch with `--remote-debugging-port=9333`), and `profile-main.mjs` CPU-profiles the main process for a few seconds (launch with `--inspect=9229`). Neither flag is for day-to-day use; both let any local process control the app.
