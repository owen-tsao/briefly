# Handoff: internship pipeline in briefly (`intern-radar` + Jobs tab)

Written 2026-09-19. Move this into the briefly repo (e.g. `docs/jobs-handoff.md`) and start there.

## What we're building and why

Owen follows an Instagram account (`zero2sudo`) that posts internship openings, direct-consideration (DC) links, and invite-only recruiting events on stories. Those links are time-sensitive and often exclusive. Checking stories manually is slow and easy to miss. Most other openings show up first in the public SimplifyJobs GitHub repo.

Goal: new postings appear automatically in a **Jobs tab inside briefly**, already scored against Owen's resume and preferences. One click on a posting opens it in **Aside** (agentic browser) with a prepared answer pack so it fills the application and stops before submit. Owen reviews, submits, and marks it applied.

briefly stays the control center. It does not scrape anything itself.

## Decisions already made

- **Two processes, one shared folder.** `intern-radar` (new Python repo, runs on the Mac via launchd) does all scraping, extraction, and scoring. briefly only reads its output and owns user state. Reason: the Instagram piece uses a private API through a throwaway account and will break or get banned periodically; it must not be able to take briefly down with it.
- **Jobs are not tasks.** Postings get their own tab with their own state file. They are never auto-added to the task board. Owen promotes a posting to a task with an explicit click ("Add to Today"). The pipeline never pushes into tasks.
- **Events are captured but parked.** Recruiting events go to `events.json` from day one so nothing is lost, but no calendar UI is built yet. Calendar provider (Google vs Apple) is undecided.
- **Never Owen's real Instagram account.** The scraper uses a dedicated burner. If the burner gets blocked in the first week, the automated Instagram path is dead and the fallback is Simplify + manual screenshots into the same matcher.
- **Never auto-submit an application.** Aside fills, Owen submits. Wrong eligibility answers (sponsorship, grad date) are silent auto-rejects.
- **Jobright is deferred.** Login-gated, no API, mostly duplicates Simplify.

## The contract between the two processes

```
~/.intern-radar/
  profile/
    resume.md          Owen edits (briefly Settings textarea or any editor)
    preferences.md     Owen edits (seed text below)
    answers.md         Owen edits (standard application answers, see below)
    resume.pdf         for upload
  items.json           intern-radar writes, briefly reads. Never written by briefly.
  events.json          intern-radar writes, briefly reads. Parked.
  profile-changed      marker file; briefly touches it when profile/* changes,
                       intern-radar re-scores all open items on next run and deletes it
```

briefly keeps its own `jobs-state.json` in its normal app-data location, keyed by item id. Same principle briefly already uses for tasks: **user state always wins; model state can refresh.** The matcher may re-score a posting, it may never change a status Owen set.

### `items.json` item shape

```json
{
  "id": "sha1 of normalized url, or company+title fallback",
  "source": "instagram | simplify",
  "sourceRef": "story id or simplify listing id",
  "company": "Stripe",
  "title": "Software Engineer Intern, Summer 2027",
  "url": "https://...",
  "dcLink": true,
  "referralNote": "code from story, if any",
  "postedAt": "2026-09-19T20:00:00Z",
  "deadline": "2026-09-26",
  "location": "Seattle / Remote",
  "pay": "$55/hr",
  "term": "summer-2027 | winter-2027 | spring-2027 | co-op",
  "verdict": {
    "decision": "apply | flagged | skip",
    "blockers": ["ineligible: MS/PhD only"],
    "flags": ["off AI/ML lane"],
    "matched": ["Python", "distributed systems coursework"],
    "missing": ["Rust"],
    "summary": "one or two sentences"
  },
  "seenAt": "2026-09-19T20:05:00Z",
  "scoredWithProfileVersion": "hash of profile/*"
}
```

Dedupe on normalized URL first, `company + title` second. The same posting will arrive from both Instagram and Simplify.

### `jobs-state.json` (briefly-owned)

```json
{
  "<item id>": {
    "status": "new | saved | applying | applied | oa | interview | offer | rejected | skipped",
    "note": "free text",
    "promotedTaskId": "briefly task id, if Add to Today was clicked",
    "updatedAt": "..."
  }
}
```

Items with no entry are `new`.

## Jobs tab: layout and behavior

Owen wants this clean and easy to organize. Three visible sections, one collapsed.

**New** — `status == new` and `verdict.decision` is `apply` or `flagged`.
Sort: DC links first, then nearest deadline, then newest. Each row shows company, title, term, pay, a decision chip (Apply / Flagged with the flag text on hover), deadline if any, a DC badge if any. Row actions: **Apply**, **Save**, **Skip**, **Add to Today**.

**In progress** — `status in {saved, applying}`.
Same row, plus a small "opened in Aside" timestamp for `applying`. Actions: **Apply** (again), **Mark applied**, **Skip**, **Add to Today**.

**Applied** — `status in {applied, oa, interview, offer, rejected}`.
Grouped by company, outcome chip on each row (Applied / OA / Interview / Offer / Rejected), date. Status is a one-click dropdown like the existing task dropdowns. Collapsible by default once it gets long.

**Hidden** (collapsed) — two filters inside: *Not a fit* (`verdict.decision == skip`, status still new) and *Skipped* (`status == skipped`). Kept so Owen can spot-check the matcher. Any row here can be moved back to New.

General:
- Section headers show counts. Menu bar badge may include the New count, behind a setting.
- Search box across company and title.
- Clicking a row expands it: full summary, matched/missing, blockers/flags, source (Instagram story or Simplify), link.
- Status changes and notes go only to `jobs-state.json`.
- Follow the existing task-row visual language: same dropdown component, same chip style, light/dark theme.

## The Apply click

1. Set status `applying`, record timestamp.
2. Build the prompt: fixed instruction block + everything from `answers.md` + resume path + this posting's fields + `verdict.matched` and `summary` + `referralNote`.
3. Hand off to Aside.
   - Preferred: Aside URL scheme or CLI that starts a task with a URL and prompt. **Unverified** — check Aside's help center (it mentions developer tools and routines).
   - Fallback that always works: `open -a Aside <url>`, put the prompt on the clipboard, one native notification "paste into Aside to start."
4. The instruction block ends with: *Fill every field you can from the answers provided. Do not submit. Leave the final review page open. Then list every field you filled and anything you were unsure about.*
5. Owen reviews, submits, clicks **Mark applied**.

Also check whether Aside's approval gating for "sensitive actions" can be scoped to form submission. If yes, "stop before submit" is enforced by the browser, not just the prompt.

### `answers.md` should contain

Identity and links (name, email, phone, LinkedIn, GitHub, portfolio, location). Education (school, degree, major, GPA, grad month/year, start dates acceptable). Eligibility (work authorization, sponsorship now/future, relocation, preferred locations, quarters available for co-op). Standing policy (EEO/voluntary questions, salary expectation, "how did you hear about us"). Resume PDF path.

## `preferences.md` seed

Drop in as-is, then add the facts block at the bottom.

```
Apply if all three hold
- Real engineering: you'd write production or research code, not analyst, ops, GRC, or consulting-deliverable work.
- Credible company: recognizable brand, or a startup with serious backing (known investors, real revenue, or a founder with a track record).
- Pay roughly $40/hr or better.

Skip only for hard blockers
- Ineligible: grad-date window, degree level (MS/PhD), citizenship, location rule.
- Non-engineering role.
- Explicit stack mismatch where the posting requires a language you don't have (Nasdaq's C#/Vue, Bedrock's Rust/CUDA).
- Co-op that eats a school quarter you haven't planned to take off.
- Direct competitor to Clad.
- Under about $35/hr at an unknown brand.

Soft flags, mention once, don't block
- Off your AI/ML lane. Prestige below FAANG. Location outside Seattle/Bay/NYC.

Timing
- Summer 2027 is primary. Winter/Spring 2027 is live as a secondary
  (Datadog, Figma, Databricks, Vercel, Tesla, SpaceX Spring all submitted).

Facts the matcher needs for eligibility checks (fill in)
- Grad date:
- Degree level:
- Work authorization / sponsorship:
- Quarters I can take off for a co-op:
- Clad is: (one line, so "direct competitor" is checkable)
```

Matcher decision rule: all three "apply" conditions hold and no hard blocker → `apply`. Any hard blocker → `skip` with the blocker named. Otherwise → `flagged` with the soft flags listed.

## intern-radar (the other repo, for reference)

```
sources/instagram.py   burner via instagrapi, saved session, poll every 30-60 min,
                       unwrap l.instagram.com links, OCR/vision for screenshot-only stories
sources/simplify.py    poll .github/scripts/listings.json in SimplifyJobs/Summer2027-Internships
                       (confirm exact repo name for the 2027 cycle), diff against seen ids
extract.py             url/image/text -> structured posting fields
match.py               posting + profile/* -> verdict (Groq or any OpenAI-compatible endpoint,
                       same as briefly)
store.py               dedupe, append to items.json / events.json
alerts.py              DC link or decision==apply -> push notification within the poll window
```

Build order by risk: burner spike (fetch stories once, confirm link URLs come back) → matcher tested on ~10 postings with known answers → Simplify feed → Instagram poller → alerts → Jobs tab → Apply hand-off.

## Unverified assumptions and kill conditions

| Assumption | Status | If false |
|---|---|---|
| A burner can poll one user's stories without being blocked | Unverified — spike | Automated Instagram path dies; Simplify + manual screenshots remain |
| Story link stickers return real URLs via instagrapi | Unverified — spike | Fall back to OCR of the story image |
| Aside can be launched with a task from another app | Unverified — check help center | Clipboard fallback, costs one paste |
| Aside approval gates can cover form submission | Unverified | "Stop before submit" is prompt-level; supervise early runs |
| LLM verdicts are useful, not "apply to everything" | Test against known postings | Tighten prompt / add rubric before trusting the New section |
| Simplify `listings.json` stays structured | Verified (public, maintained) | — |

## Guardrails

- Burner account only. Never the real one. Home IP, saved session, no re-login per poll.
- Never auto-submit. Review the "unsure fields" list every time; free-text answers are where agents sound generic or invent things.
- `profile/` is personal data. Keep it out of any repo (gitignore). No API keys in files; briefly already stores its key with `safeStorage`.
- Ask before adding dependencies (instagrapi, OCR/vision option, anything in briefly).
- briefly's README currently promises read-only access to Notes. The Jobs tab doesn't change that, but if a calendar write is added later, say so in the README.

## First steps in the briefly repo

1. Read the existing task store and the user-state-wins merge logic; mirror it for `jobs-state.json`.
2. Add a file watcher on `~/.intern-radar/items.json` (path configurable in Settings).
3. Build the Jobs tab with the four sections above using fixture data before intern-radar exists.
4. Add Settings textareas for `resume.md`, `preferences.md`, `answers.md` that write to `profile/` and touch `profile-changed`.
5. Implement Apply with the clipboard fallback first; upgrade to a direct Aside launch once verified.
