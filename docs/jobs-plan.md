# Plan: internship pipeline (Jobs tab in briefly + Instagram sidecar)

Written 2026-09-19 from `docs/jobs-handoff.md`; architecture revised 2026-09-20 (pipeline
moved into briefly). This is the build plan; the handoff is the original brief. Where the two
disagree, this document wins and the "Changes from the handoff" section explains why.

## 1. Goal in one paragraph

New internship postings — from the ATSs of companies Owen watches, the ApplyGuy and
SimplifyJobs feeds, and `zero2sudo` Instagram stories — appear automatically in a Jobs tab
inside briefly, already scored against Owen's resume and preferences. One click opens the
posting in Aside with a prepared answer pack; Aside fills the application and stops before
submit. Owen reviews, submits, marks it applied. briefly runs the pipeline itself; only the
Instagram scraper is a separate, disposable sidecar.

## 2. What is verified and what is not

| Assumption | Status | Evidence / if false |
|---|---|---|
| Simplify 2027 feed exists and is structured | **Verified** 2026-09-19 | `SimplifyJobs/Summer2027-Internships`, branch `dev`, `.github/scripts/listings.json`, 12.7 MB. Fields: `company_name, title, url, terms, locations, active, is_visible, date_posted, date_updated, source, id`. No pay, deadline, or description. |
| ApplyGuy feed exists, is fast, links to employer | **Verified** 2026-09-20 | `ApplyGuy/2027-Internships` → `data/internships.json`, 685 entries, refreshed every 15 min, `listingUrl` points at the employer ATS. Fields: `id, company, title, category, location, season, posted, url, listingUrl`. |
| ATS APIs return full descriptions without auth | **Verified** 2026-09-20 | Greenhouse `boards-api.greenhouse.io/v1/boards/{co}/jobs?content=true` (Stripe: 5.3k-char description); Lever `api.lever.co/v0/postings/{co}?mode=json` (Palantir: 43 intern roles, `descriptionPlain`); Ashby `api.ashbyhq.com/posting-api/job-board/{co}` (OpenAI: `descriptionPlain`); Workday `POST {tenant}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` (NVIDIA: 1,015 intern hits; per-job detail at `/job/{path}`). |
| speedyapply has pay data | **Verified** | `speedyapply/2027-SWE-College-Jobs` README table, daily, `$/hr` column. Markdown only. |
| Jobright public repo usable | **Verified, low value** | `jobright-ai/2026-Software-Engineer-Internship` carries 2027 roles, daily, markdown; links go to `jobright.ai/jobs/info/{id}` (HTTP 200, JS app) — employer URL must be resolved from that page. |
| Aside can be launched with a task from another app | **Verified** | Aside CLI: `aside "<prompt>"` starts an agent task, `--session <id>` continues one. Install: `curl -fsSL https://releases.aside.com/install.sh \| bash`. Not yet installed on this Mac. |
| Aside can enforce "stop before submit" | **Verified false** | Permissions are tool-level Allow/Ask/Deny plus file-access modes. No form-submission gate. Stop-before-submit is prompt-level; supervise early runs. |
| Postings not on the four ATSs are readable with plain HTTP | **Measured — spike 1a** | Four ATSs cover 82% (ApplyGuy) / 64% (Simplify). Residual is mostly Oracle HCM (JS, unreadable via HTML; has its own REST API) and iCIMS (readable). See §8. |
| LLM verdicts are useful, not "apply to everything" | **Unverified — spike 1b** | Tighten rubric before the New section is trusted. |
| Burner can poll one user's stories without being blocked | **Unverified — spike 1d** | Instagram path dies; every other source remains. |
| Story link stickers return real URLs via instagrapi | **Unverified — spike 1d** | OCR of the story image, or dead. |
| Python 3.12 available | **Verified** | Homebrew `python@3.12`. System python is 3.9 — do not use. |

## 2a. Sources, tiered

What Owen cares about: catch postings **as early as possible** and **read them accurately**.
Aggregators sit downstream of the ATS by hours to a day, so the fastest signal is the ATS
itself; the most readable signal is also the ATS, because it returns the description as JSON.

| Tier | Source | Poll | Why it's here | Unique contribution |
|---|---|---|---|---|
| A | **ATS direct, watchlist** (Greenhouse / Lever / Ashby / Workday) for companies in `profile/watchlist.md` | 15 min | Minutes after posting; full description free | Earliest possible; canonical job ids |
| A | **ApplyGuy JSON** | 15 min | Long tail of companies not on the watchlist; direct employer URLs | Breadth at speed |
| A | **zero2sudo Instagram** (Phase 5, burner) | 60 min | DC links, referral codes, invite-only events | The only source with DC/events |
| B | **Simplify JSON** | daily | Community-curated; `terms`; broad | Catches what the others miss |
| B | **speedyapply** (markdown) | daily | `$/hr` column | Pay — nobody else has it |
| B | **Jobright repo** (markdown) | daily | Owen rates Jobright; repo is a fraction of it | Occasional extra; resolve employer URL from its page |

Skipped on purpose: LinkedIn, Indeed, Handshake (login + ToS); aggregators-of-aggregators.
Jobright's real value is its matching, which `match.ts` replaces with Owen's own rules.

## 3. Architecture

One process for everything that is plain HTTP + LLM; one disposable sidecar for the one
source that can get banned.

```
briefly (Electron main, existing)                       instagram sidecar (Python, Phase 5)
  src/main/jobs/                                          ~150 lines, launchd hourly, burner
    sources/ats.ts        watchlist boards, 15 min          polls zero2sudo stories
    sources/applyguy.ts   15 min                            writes ~/.briefly/instagram.json
    sources/simplify.ts   daily                             (story items only: url, caption,
    sources/speedyapply.ts daily (pay)                       dcLink, image path, seenAt)
    sources/jobright.ts   daily                                     │
    sources/instagram.ts  reads instagram.json ◀──────────────────┘
    extract.ts            ATS-aware description fetch
    match.ts              verdict via existing llm.ts (safeStorage key)
    jobsStore.ts          items + user state, app data, atomic writes
  scheduler.ts            one more job on the existing tick (15 min), sleep-aware
  Jobs tab                New / In progress / Applied / Hidden
  Apply                   spawn `aside "<prompt>"`
  Add to Today            existing addTask()
~/.briefly/profile/       resume.md, preferences.md, answers.md, watchlist.md, resume.pdf
```

Why this shape: every non-Instagram source is a JSON or markdown fetch, and briefly already
has the LLM client, encrypted key, sleep-aware scheduler, notifications, and atomic-write
pattern. A second repo would duplicate all of it and hold the API key less securely. The
Instagram scraper is a private-API client on a burner that will be challenged or banned
periodically — it stays outside so its failures cannot touch briefly, and it communicates
through one file.

Trade-off accepted: polling stops when briefly is quit. It is a launch-at-login menu bar app,
so in practice it is always running. Wake-after-sleep is the same either way: nothing runs
with the lid closed; briefly's scheduler already catches up on resume.

### 3.0 Extraction strategy (`extract.ts`)

Detect the ATS from the URL and prefer its JSON API — no scraping, full description:

| URL matches | Call | Description field |
|---|---|---|
| `boards.greenhouse.io/{co}/jobs/{id}`, `job-boards.greenhouse.io/…` | `GET boards-api.greenhouse.io/v1/boards/{co}/jobs/{id}` | `content` (HTML → text) |
| `jobs.lever.co/{co}/{uuid}` | `GET api.lever.co/v0/postings/{co}/{uuid}` | `descriptionPlain` + `lists` |
| `jobs.ashbyhq.com/{co}/{uuid}` | `GET api.ashbyhq.com/posting-api/job-board/{co}` → find id | `descriptionPlain` |
| `{tenant}.wd{n}.myworkdayjobs.com/{site}/job/{path}` | `GET {tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job/{path}` | `jobPostingInfo.jobDescription` (HTML → text) |
| anything else | `GET` with browser UA, readability-style main-text extraction | body text if > 500 chars |

`descriptionAvailable` is true only when the text is > 500 chars. The same response
supplies `pay` (Ashby `compensation`, Workday/Greenhouse pay ranges in text), `location`,
and `postedAt` where present. Spike 1a measures the residual "anything else" bucket.

### 3.1 Files on disk

```
~/.briefly/                          (path configurable in Settings)
  profile/
    resume.md          Owen edits (any editor; briefly offers "Open in editor")
    preferences.md     Owen edits (seed in handoff §preferences.md)
    answers.md         Owen edits (standard application answers)
    watchlist.md       Owen edits: one company per line, optionally with its ATS board slug
                       (e.g. "Stripe greenhouse:stripe", "Palantir lever:palantir"). briefly
                       polls these boards directly every 15 min.
    resume.pdf         for upload by Aside
  instagram.json       sidecar writes (atomic). briefly reads. Phase 5.

~/Library/Application Support/briefly/
  jobs.json            briefly-owned: items (§3.2) + user state (§3.3) + source cursors
```

briefly hashes `profile/*` on every tick; any item whose `scoredWithProfileVersion` differs
is re-scored. No marker files.

### 3.2 Items (inside `jobs.json`)

```json
{
  "version": 1,
  "profileVersion": "sha1 of profile/*",
  "sources": { "ats": { "lastRun": "..." }, "applyguy": { "lastRun": "..." }, "simplify": { "lastRun": "..." } },
  "items": [
    {
      "id": "sha1 of normalized url, else sha1 of lower(company)+'|'+lower(title)",
      "source": "ats | applyguy | instagram | simplify | speedyapply | jobright",
      "alsoSeenIn": ["simplify"],
      "sourceRef": "ats job id, feed id, or story id",
      "company": "Stripe",
      "title": "Software Engineer Intern, Summer 2027",
      "url": "https://...",
      "dcLink": false,
      "referralNote": null,
      "postedAt": "2026-09-19T20:00:00Z",
      "deadline": null,
      "location": "Seattle / Remote",
      "pay": null,
      "term": "summer-2027 | winter-2027 | spring-2027 | co-op | unknown",
      "descriptionAvailable": true,
      "verdict": {
        "decision": "apply | flagged | skip",
        "blockers": [],
        "flags": [],
        "matched": ["Python", "distributed systems coursework"],
        "missing": ["Rust"],
        "summary": "one or two sentences"
      },
      "seenAt": "2026-09-19T20:05:00Z",
      "active": true,
      "scoredWithProfileVersion": "sha1 of profile/*"
    }
  ]
}
```

Rules:
- `descriptionAvailable: false` → `decision` may never be `apply`; at most `flagged` with
  flag `"couldn't read posting"`.
- `active` mirrors the feed's `active` where it exists (Instagram items stay active until
  `deadline` passes or 30 days). Inactive items are dropped after 60 days — safe because
  user state carries a `snapshot` (§3.3).
- URL normalization: follow redirects (incl. `l.instagram.com`, ApplyGuy `url` → use
  `listingUrl` directly, Jobright info page → employer URL), lowercase host, strip fragment
  and trailing slash, drop all query params except an allow-list (`gh_jid`; Lever and
  Workday ids are in the path). Then sha1. **When the ATS is recognized, the id is
  `sha1(ats + ':' + board + ':' + jobId)` instead** — canonical across every aggregator.
  Company+title id is the fallback only when both are non-trivial, and dedupe runs a second
  pass on it. `source` is whichever saw it first; `alsoSeenIn` accumulates the rest. The
  redirect follow and the description fetch are the same HTTP request — one call per posting.
- Field merge across sources: first non-null wins, except `pay` (speedyapply wins) and
  `dcLink`/`referralNote` (Instagram wins).
- Simplify items are re-extracted and re-scored only when `date_updated` changes. An
  `active` flip alone just updates the flag — no LLM call.

### 3.2a Events (parked, but captured from day one)

```json
{ "id": "sha1 of url or title+date", "source": "instagram", "title": "Jane Street Insight Day",
  "url": "https://...", "startsAt": "2026-10-03T17:00:00Z", "deadline": "2026-09-26",
  "inviteOnly": true, "note": "from story caption", "seenAt": "..." }
```

Stored as `events[]` in `jobs.json`. Minimal on purpose. No UI reads it yet; defining it now
means nothing is lost and the calendar work later starts from real data.

### 3.3 User state (inside `jobs.json`, keyed by item id)

```json
{
  "<item id>": {
    "status": "saved | applying | applied | oa | interview | offer | rejected | skipped | new",
    "note": "",
    "promotedTaskId": null,
    "openedInAsideAt": null,
    "snapshot": { "company": "Stripe", "title": "…", "url": "…", "term": "summer-2027", "source": "simplify" },
    "updatedAt": "..."
  }
}
```

- No entry → `new`. An explicit `"new"` entry exists only when Owen moves something back
  from Hidden.
- `snapshot` is written the moment status leaves `new`. The Applied section renders from
  the snapshot when the item has been pruned. Applied history survives pruning.
- User state always wins: the matcher may re-score, it may never change a status Owen set.

### 3.4 Matcher decision rule (revised)

```
hard blocker present                        → skip   (blocker named)
descriptionAvailable == false               → flagged ("couldn't read posting")
real engineering AND credible company
  AND (pay unknown OR pay >= ~$40/hr)       → apply  (soft flags listed, do not block)
otherwise                                   → flagged
known pay < ~$35/hr AND unknown brand       → counts as a hard blocker
```

Unknown pay is neutral. Almost no posting states pay; treating it as a failure would make
everything "flagged".

## 4. Phases

### Phase 0 — Owen, ~30 min, before any code

- [ ] Fill the facts block at the bottom of `preferences.md` (grad date, degree level, work
      authorization/sponsorship, co-op quarters, what Clad is in one line). Without these the
      matcher cannot judge eligibility.
- [ ] Write `answers.md`: identity + links, education, eligibility, standing policy (EEO,
      salary expectation, "how did you hear"), resume PDF path. Every wrong line here is a
      silent auto-reject.
- [ ] Write `watchlist.md`: the 30–50 companies you most want, one per line. I'll resolve
      their ATS board slugs in Phase 3 (or you add them if you know them).
- [ ] Install Aside CLI; run `aside "open example.com"` once to confirm it works signed in.
- [ ] Create the Instagram burner, follow `zero2sudo`, and leave it alone for 1–2 days.

### Phase 1 — Spikes, ~1 day, throwaway code, nothing in briefly

Order is by what kills the most.

**1a. ATS coverage + residual readability.**
Pull ApplyGuy's 685 entries and the last 14 days of Simplify; classify each `listingUrl`
by ATS (Greenhouse / Lever / Ashby / Workday / other). For the ATS ones, call the JSON API
for 5 each and confirm description text comes back. For 20 of the "other" bucket, try plain
HTTP + readability.
Measure: ATS share (expect ~80%); residual readable fraction.
Kill/shape: nothing kills this — it sizes how many postings end up "flagged — couldn't read
posting". If the residual is large and mostly one vendor (iCIMS, SmartRecruiters, Workable),
add that vendor's API in Phase 3.

**1b. Matcher on 10 known postings.**
Hand-label 10: 3 clear apply, 4 clear skip with distinct blockers (MS/PhD, citizenship,
non-engineering, stack mismatch), 3 flagged. Run the verdict prompt (Groq, same model
family briefly uses). Compare.
Kill: any hard-blocker posting scored `apply` → fix rubric before Phase 3.

**1c. Aside hand-off.**
`aside "Open <scratch Google Form URL>. Fill … Do not submit. Leave the review page open.
List every field you filled and anything you were unsure about."`
Measure: launches, loads URL, fills, stops; whether the CLI blocks the caller until done
(decides `spawn` detached vs. awaited); whether stdout returns a session id.
Fallback: `open -a Aside <url>` + prompt on clipboard + one notification.

**1d. Instagram burner.** *(needs `instagrapi` — ask before installing)*
Login with saved session → `user_stories(<zero2sudo user id>)` → do `links[].webUri` come
back? Repeat three times, an hour apart, from the home IP.
Kill: challenge/ban in week one → Phase 5 is cancelled. Also: never open the burner in a
browser on this machine; if the *real* account ever gets a security prompt, stop the poller.

Deliverable: a short results table appended to §8 of this file.

### Phase 2 — briefly Jobs tab on fixture data, ~1 day

Files:
- `src/shared/jobs.ts` — `JobItem`, `JobStatus`, `JobUserState`, `JobsView` types.
- `src/main/jobs/jobsStore.ts` — owns `jobs.json` (atomic writes, same pattern as
  `taskStore`): items, user state, source cursors. Merge: user state wins; `snapshot` on
  status leaving `new`; prune after 60 days inactive; `version` check with a "newer than I
  understand" guard.
- `src/main/jobs/profile.ts` — `~/.briefly/profile/` path (configurable), create on first
  run with the seed `preferences.md` and empty templates for the others, hash `profile/*`,
  last-modified per file.
- `src/main/ipc.ts` — `jobs:get`, `jobs:setStatus`, `jobs:setNote`, `jobs:promote`,
  `jobs:apply` (Phase 4), `jobs:openProfile`, `jobs:scanNow`. Input validation like existing
  handlers.
- `src/preload/index.ts`, `src/renderer/src/global.d.ts` — expose the above.
- `src/renderer/src/components/JobsView.tsx` — sections New / In progress / Applied /
  Hidden; counts; search over company+title; row expand (summary, matched/missing,
  blockers/flags, source, link); status dropdown reusing `MetaMenu`; same chips and theme.
  Empty state when there are no items yet: "Add companies to watchlist.md" + Open button.
- `src/renderer/src/App.tsx` — fifth tab "Jobs".
- `src/main/settings.ts` + `SettingsView.tsx` — profile dir path; four "Open in editor"
  buttons for `profile/*.md` (via `shell.openPath`) with last-modified time; "Include new
  jobs in menu bar count" toggle (default off); "Scan for jobs" interval (15 min default, Off).
- `fixtures/jobs.sample.json` — ~15 rows covering every section, DC link, unreadable
  posting, pruned-applied case. Loaded via a dev-only IPC so the tab can be built before any
  source exists.

Section rules:
- **New**: no state (or `new`) and `verdict.decision ∈ {apply, flagged}`. Sort: `dcLink`
  first, then nearest `deadline` (nulls last), then newest `postedAt`. Actions: Apply, Save,
  Skip, Add to Today.
- **In progress**: `status ∈ {saved, applying}`; show `openedInAsideAt` for applying.
  Actions: Apply, Mark applied, Skip, Add to Today.
- **Applied**: `status ∈ {applied, oa, interview, offer, rejected}`; grouped by company;
  outcome dropdown; collapsible; renders from `snapshot` when the item is gone.
- **Hidden** (collapsed): *Not a fit* (`decision == skip`, no state, last 30 days only — this
  list otherwise grows by hundreds) and *Skipped* (`status == skipped`). Any row can return
  to New.
- "Add to Today" calls existing `addTask()` with text `"Apply: <company> — <title>"`,
  `sourceNote: 'jobs'`, and stores `promotedTaskId`. Reconcile must skip `sourceNote: 'jobs'`
  (like it skips `'quick add'`).

Testing: reuse the stubbed-`electron` esbuild harness from the work-day/reconcile work to
unit-test `jobsStore` merge rules (user state wins, snapshot on leave-new, pruned item stays
in Applied) without launching the app.

Acceptance: tab renders fixtures correctly in light and dark; every action persists to
`jobs.json`; deleting an applied item from the fixture keeps it in Applied via snapshot;
empty profile dir is created with templates on first run; typecheck clean.

### Phase 3 — sources inside briefly, fast ones first, ~1.5 days

All TypeScript in `src/main/jobs/`, **no new dependencies** — `fetch` for JSON, one regex
per markdown table.

```
src/main/jobs/
  sources/ats.ts         watchlist → Greenhouse/Lever/Ashby/Workday board APIs, 15 min
  sources/applyguy.ts    data/internships.json, 15 min, diff on id
  sources/simplify.ts    listings.json (12.7 MB — stream/parse once a day), filter + diff on id / date_updated
  sources/speedyapply.ts README table, daily → pay by (company, title)
  sources/jobright.ts    README table, daily → resolve employer URL from jobright page
  sources/instagram.ts   reads ~/.briefly/instagram.json (Phase 5)
  extract.ts             url → ATS-aware JSON or HTML → {text, descriptionAvailable, pay?, deadline?, term}
  match.ts               posting + profile/* → verdict, via existing completeJson()
  normalize.ts           canonical id, url normalization, ATS detection
  pipeline.ts            one tick: due sources → new/changed → extract → match → store → notify
```

Build order inside the phase: `ats.ts` + `extract.ts` + `normalize.ts` (the watchlist is
where the earliest wins are) → `applyguy.ts` → dedupe across the two → `simplify.ts` →
`speedyapply.ts` (pay) → `jobright.ts`. Each source keeps a `lastRun` cursor in `jobs.json`;
the 15-min scheduler tick runs only the sources that are due. The tick defers while the
popover is open, exactly like auto-rescan.

Rules:
- **First-run cap**: only postings posted in the last 14 days, and a title pre-filter
  (`intern` AND any of software/engineer/ML/AI/data/quant/research) *before* any LLM call.
  Otherwise the first run is hundreds of Groq calls and a flooded New section.
- Per-run LLM cap (e.g. 40) with the rest carried to the next run. Groq's free tier is
  rate-limited per minute and per day; the cap plus the 15-min cadence stays inside it
  because only *new or changed* postings reach the LLM — polling itself is free.
- Be polite to ATS APIs: one request per board per tick, browser-like UA, back off on 429.
- API key: briefly's existing `safeStorage`-encrypted key. Nothing new to manage.
- LLM calls run in the main process, async, capped per tick, and only for new/changed
  postings; they never block the UI.
- Re-score when `profileVersion` changes; never touch user state.

Acceptance: 15-min ticks for 24 h without a crash; real items appear in the Phase 2 tab;
a posting present in ApplyGuy, Simplify, and the watchlist shows as **one** row with
`alsoSeenIn` filled; a watchlist posting appears in briefly before it appears on Simplify;
log line per tick with counts per source.

### Phase 4 — Apply hand-off, ~half day — **built 2026-09-20, awaiting first supervised run**

1. `jobs:apply` sets `status: applying`, `openedInAsideAt: now`, writes `snapshot`.
2. Prompt = fixed instruction block + `answers.md` + `resume.pdf` path + posting fields +
   `verdict.matched` + `verdict.summary` + `referralNote`.
3. `spawn('aside', [prompt], { detached: true, stdio: 'ignore' })` (or awaited, per 1c).
   No shell, so nothing lands in shell history. The prompt is visible in `ps` for the
   process lifetime — acceptable on a personal Mac; if not, write it to a temp file in an
   Aside-approved folder and tell Aside to read it.
   If `aside` is missing → clipboard fallback + notification.
4. Instruction block ends: *Fill every field you can from the answers provided. Do not
   submit. Leave the final review page open. Then list every field you filled and anything
   you were unsure about.*
5. Owen reviews, submits, clicks **Mark applied**.

Acceptance: five real applications supervised end to end; the "unsure fields" list is
read every time; no submission happened without Owen clicking.

### Phase 5 — Instagram sidecar (only if 1d passed) — **written 2026-09-20, not yet run live**

Tiny Python script (`tools/instagram-sidecar/`, in this repo, own venv, only `instagrapi`):
hourly via launchd (stories live 24 h; 30 min is only more ban risk), saved session, no
re-login per poll, unwrap `l.instagram.com`, `dcLink: true` when the story says DC/direct,
`referralNote` from caption. Writes `~/.briefly/instagram.json` atomically; briefly's
`sources/instagram.ts` ingests it on the next tick. Screenshot-only stories: record the image
path and `descriptionAvailable: false` for now; OCR/vision is a later, separate dependency
decision. Recruiting events → `events[]`.

If the sidecar dies, briefly notices `instagram.json` going stale (>3 h) and shows a small
"Instagram feed stale" note in the Jobs tab. Nothing else is affected.

### Phase 6 — Polish — **done except Oracle HCM**

Menu bar badge includes New count behind the setting; new-item notification via the existing
notifications module (respects the toggle); README updated. Not done: an Oracle HCM adapter
(8% of Simplify, JS-rendered). Add only if that residual matters after a week of real use.

## 5. Changes from the handoff, and why

1. **No `profile-changed` marker.** Redundant with `scoredWithProfileVersion`; removes a
   cross-process write.
2. **No `alerts.py`.** One notification system (briefly's), one toggle.
3. **`snapshot` in user state.** Otherwise pruning items erases Applied history.
4. **`descriptionAvailable` + rule that unreadable postings can't be `apply`.** Simplify
   provides no description; many job pages are JS-rendered. Title-only "apply" is a guess.
5. **Pay rule: unknown is neutral.** Almost no posting states pay; the handoff rule would
   flag nearly everything.
6. **URL normalization spelled out.** "Normalized url" was a phrase, not a rule.
7. **Atomic writes required.** Watcher + half-written JSON = blank tab.
8. **Aside via CLI, not clipboard.** CLI exists (verified). Clipboard stays as fallback.
9. **"Open in editor" instead of Settings textareas for `profile/*.md`.** A 400 px popover
   is a poor resume editor. Inline editing, if any, only for `answers.md`.
10. **Instagram poll hourly, not 30–60 min.** Less ban risk, same coverage.
11. **First-run cap and title pre-filter** before any LLM call.
12. **`version`/`generatedAt`/`profileVersion` envelope** on the store so briefly can
    show "last scan" and detect schema changes.
13. **`events.json` gets a minimal schema now** instead of "figure it out later", so Phase 5
    writes something the future calendar work can read.
14. **Hidden → Not a fit is capped to 30 days.** Otherwise it becomes a graveyard of hundreds.

Review pass (2026-09-19) added items 13–14 plus: missing-directory and schema-version
handling in the watcher, `date_updated`-driven re-scoring, the Aside cost decision, the
`ps`-visibility note on the Apply prompt, and a unit-test approach for `jobsStore`.

Source pass (2026-09-20), after Owen asked where we pull from:
15. **Six sources instead of two, tiered by speed** (§2a). ATS-direct watchlist and ApplyGuy
    every 15 min; Simplify, speedyapply, Jobright daily; Instagram hourly.
16. **ATS-aware extraction** (§3.0). Greenhouse/Lever/Ashby/Workday all return the full
    description as public JSON — verified live. "Read the posting accurately" is mostly
    solved without scraping; spike 1a now sizes the residual instead.
17. **Canonical ids from ATS job ids** when recognized, `alsoSeenIn` for provenance,
    explicit field-merge precedence (pay from speedyapply, DC/referral from Instagram).
18. **`watchlist.md`** as a fourth profile file; Phase 0 asks Owen for the company list.
19. **Jobright kept but demoted**: public repo is a daily markdown fraction with indirect
    links; its matching is what `match.ts` replaces.

Architecture pass (2026-09-20), after Owen asked why this isn't just part of briefly:
20. **Pipeline lives in briefly; only Instagram is a sidecar.** The two-process argument was
    really about one source. Every other source is a JSON/markdown fetch, and briefly already
    has the LLM client, encrypted key, sleep-aware scheduler, notifications, and atomic writes.
    Result: zero new dependencies for the pipeline, no `~/.intern-radar` contract, no
    second key. The sidecar communicates through one file and can die without consequence.

Decisions kept as-is: jobs are not tasks; promotion is an explicit click; never auto-submit;
events parked; Jobright deferred as a primary source; user state wins; burner only.

## 6. Guardrails

- Burner account only. Home IP, saved session, no re-login per poll, hourly. Never open
  the burner in a browser on this Mac.
- Never auto-submit. Read the "unsure fields" list every time; free-text answers are where
  agents sound generic or invent.
- `~/.briefly/profile/` is personal data and lives outside the repo. `answers.md` (phone,
  address, work authorization) is sent to Aside's models on every Apply — inherent to the
  design, decided consciously. `resume.md` + `preferences.md` go to Groq for matching — same
  boundary as Notes today.
- No API keys in files. briefly's `safeStorage` key is the only key.
- Ask before adding dependencies: `instagrapi` for the sidecar, any OCR/vision, anything in
  briefly. The pipeline itself adds none.
- briefly's README promises read-only Notes access. Still true. Say what changed.

## 7. Open decisions for Owen

- Go/no-go on `instagrapi` (new dependency, burner account).
- **Aside cost per Apply.** Aside tasks consume plan credits; Aside also supports bringing
  your own API key (Settings → AI providers). Decide before Phase 4 whether Apply runs on
  credits or a BYO key — at tens of applications this is real money either way.
- Whether "Add to Today" tasks should get a default deadline when the posting has one.
- Calendar provider for events (Google vs Apple) — not needed until events UI exists.
- Whether Applied rows should offer "follow up in 2 weeks" as a task. Out of scope for now.

## 8. Spike results

_(fill in after Phase 1)_

| Spike | Result | Decision |
|---|---|---|
| 1a ATS coverage + residual readability | **2026-09-20.** Four-ATS share: ApplyGuy 82% (689 urls: Workday 401, Greenhouse 94, Ashby 54, Lever 14), Simplify-14d 64% (1,126 urls: Workday 563, Greenhouse 95, Ashby 41, Lever 23). All four JSON APIs returned real descriptions on 5/5 samples (1.4k–14k chars; one Lever at 465). Residual by vendor: Oracle HCM 8% of Simplify (JS-rendered, 0 chars via HTML), iCIMS 3% (server-rendered, readable), then long tail. Several "other" URLs are Greenhouse embeds (`?gh_jid=`) — resolvable to the Greenhouse API if the board slug is known. Plain-HTML residual: 13/20 returned >1.5k chars, but the largest were SPA payloads, so treat plain HTML as best-effort. | Build the four ATS adapters first. Add Greenhouse-embed resolution (`gh_jid` + company→slug guess) in Phase 3 — cheap, recovers a visible chunk of "other". Oracle HCM has a public REST endpoint; add as a fifth adapter if the 8% matters after a week of real data. Everything else: plain HTML, `descriptionAvailable` only if >500 chars of body text, else flagged. |
| 1b Matcher on 10 postings | **Not run.** Meaningless until `resume.md`/`preferences.md` are filled in; today every verdict carries the "Resume not filled in" flag. First real scan on empty templates: 37 scored → 21 apply / 15 flagged / 1 skip, i.e. too generous, as expected with no blockers defined. | Run after Owen fills the profile: pick 10 postings from New, hand-label, compare. If any hard-blocker posting scores `apply`, tighten the rubric in `match.ts` before trusting New. |
| 1c Aside hand-off | **Partially verified 2026-09-20.** Aside.app is installed; the `aside` CLI is not (not in PATH, not in the bundle — it comes from Aside's install script). Built both paths: CLI `spawn` when present, otherwise `open -a Aside <url>` + prompt on clipboard + notification. Prompt builder verified on a real posting. The launch itself is untested — needs a click in the app. | Install the CLI (`curl -fsSL https://releases.aside.com/install.sh \| bash`) when ready; briefly picks it up automatically. Until then the clipboard path works with one paste. Supervise the first five runs. |
| 1d Instagram burner | **Sidecar written, not run live.** `tools/instagram-sidecar/poll.py` verified end to end against a stubbed `instagrapi` (login → session file 600 → link unwrapping → DC detection → atomic JSON → briefly reader merges onto the Stripe row by ATS id). Field names checked against instagrapi `types.py`. Whether link stickers come back populated for `zero2sudo` is still the open question. | Owen: create the burner, `pip install` in the sidecar venv (new dependency — go/no-go is his), run `--login` once, check `url`s are non-null. Kill if every url is null or a challenge appears in week one. |
