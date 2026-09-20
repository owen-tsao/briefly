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

- The same posting from several feeds is merged into one row (SpeedyApply supplies hourly pay when it has it)
- Postings are scored a few at a time in the background, watchlist companies first, so a free-tier API key is enough
- Track your own status per posting — Saved, Applying, Applied, OA, Interview, Offer — with a note. Your status always wins; a rescan never changes it, and Applied history survives a posting disappearing from the feeds
- "Add to Today" puts an apply task on your board, with the deadline if the posting has one. It's always a click, never automatic

Your profile lives in `~/.briefly/profile/` as four markdown files you edit in any editor: `resume.md` and `preferences.md` (what the matcher reads — hard blockers, soft flags, pay floor), `watchlist.md` (one company per line, optionally pinned to its ATS board like `Stripe greenhouse:stripe`), and `answers.md` (standard application answers, for a later Apply hand-off). Settings has buttons to open each one. Editing the resume or preferences re-scores everything on the next scan.

Current limits: an Apply button that fills the form for you is planned but not built; Instagram story ingestion (`zero2sudo`) is designed as a separate sidecar and not shipped yet; postings on Oracle HCM and some company-hosted pages can't be read, so they're flagged as triage-only.

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
