# Email updates

An outside assistant can keep the Jobs tracker in sync with Owen's email by writing one JSON file. briefly reads it. It never writes the file back, and it never edits the file in place.

```
~/.briefly/email-updates.json
```

Override the path with `BRIEFLY_EMAIL_FILE` (useful for tests). briefly reads it when the app launches, at the start of every jobs scan, and when you press **Email** on the Tracker.

## File

```json
{
  "version": 1,
  "generatedAt": "2026-11-04T18:00:00.000Z",
  "entries": [
    {
      "id": "gmail:stripe:swe-intern",
      "company": "Stripe",
      "role": "Software Engineer Intern",
      "status": "oa",
      "eventAt": "2026-11-04",
      "appliedAt": "2026-10-02",
      "subject": "Thanks for applying to Stripe",
      "emailAt": "2026-11-04T15:04:00Z",
      "note": "bring a laptop",
      "deadline": {
        "at": "2026-11-12T21:42:00-08:00",
        "kind": "OA",
        "platform": "HackerRank",
        "display": "Nov 12, 9:42 PM PT"
      }
    }
  ]
}
```

`version` must be `1`. Any other version, invalid JSON, a missing `entries` array, or a file over 2 MB is rejected and `jobs.json` is not opened.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable dedupe key for this application (or this event, if you want a separate task). Repeating the same id updates the same row and the same task. |
| `company` | yes | Company name as the email states it. |
| `role` | no | Empty when the email didn't name one. |
| `status` | yes | `applied`, `oa`, `interview` (or `interviewing`), `offer`, or `rejected`. |
| `eventAt` | yes | When that status happened. `YYYY-MM-DD`, or an ISO-8601 time **with a timezone** (`Z` or `±hh:mm`). |
| `appliedAt` | no | When the application was sent, if the email says. Not overwritten once the tracker has one. |
| `subject`, `emailAt` | no | The source message. Kept for the next run's fingerprint; not copied onto the tracker note. |
| `note` | no | Extra text (a recruiter name, "bring a laptop"). Appended to the tracker note. |
| `deadline` | no | A future OA due date or an interview time. See below. |

`deadline.at` is `YYYY-MM-DD` when the email has no clock time, or an ISO-8601 instant with a timezone when it does. A time with no timezone is ignored (the status is still imported) because it would mean a different hour on every machine. `kind` defaults from the status (`OA`, `Interview`, `Offer`). `platform` is the assessment site. `display` is optional text shown in the task ("Dec 3, 2:58 PM PT") so the label doesn't depend on the machine's timezone.

Duplicate ids in one file collapse to the newest `eventAt`.

## What briefly does

Matching, in order:

1. The row this `id` was linked to last time.
2. The deterministic id briefly uses for a row that came from this entry.
3. Company + role, after normalizing (`J.P. Morgan` / `JPMorgan Chase`, `SWE Intern` / `Software Engineer Intern`, a leading requisition number, `Summer 2027`). A one-character typo matches only for longer company names. Two different roles at one company stay two rows. If several rows fit and none is an obvious winner, the entry is skipped rather than guessed.

Status only moves forward: Applied → OA → Interview. **Rejected** and **Offer** may replace any stage, including each other, but only when this email is newer than the status already taken from email. An older rejection does not wipe a newer interview. A status you set yourself (the tracker dropdown) is kept when your edit is newer than `eventAt`. Feed rescans still never change a status.

A new unmatched application is added to the tracker. The same file applied twice changes nothing.

Processed ids are stored on `jobs.json` under `emailImports` (fingerprint, tracker row, task id). That record is written in the same save as the status change. The email file is not modified, so a crash cannot leave a half-written drop.

## Tasks and notifications

A deadline that is still ahead becomes a task on the Job Applications track:

- A date-only deadline uses the existing 9am notification (due today, due tomorrow, overdue). The task's `deadline` is that calendar day.
- A clock time also sets `dueAt`. The same 3 hour / 1 hour / 15 minute reminders school uses for a timed assignment then fire for this task ("OA in 3 hours"). A stage missed while the machine was asleep is not announced late.

Tasks are deduped by the entry `id`. A newer entry that changes the time moves the task. A completed, dismissed, or deleted task is not created again. A rejected application does not get a task. A deadline that is already past is written onto the tracker note only, so a first import of old mail does not fill the board with overdue tasks.

Use one stable `id` per application if a later email should move that application's task. Use a new `id` only when the email is a separate thing you want reminded about on its own.

## From the CSVs

`scripts/email-updates-from-csv.ts` maps the two Gmail exports. `applications.csv` supplies company, role, applied date, status, last update, and the evidence subject. `oa_list.csv` adds the platform and a deadline when the cell is a real date or a count of days from the invite. "rolling" and blank cells stay notes.

```
node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/email-updates-from-csv.ts \
  --applications applications.csv --oa oa_list.csv --out ~/.briefly/email-updates.json
```

`fixtures/email-updates.sample.json` is that mapping of the exports checked in with the repo.

## Tests

```
npm test
```

That runs the parser, the matcher, status rules, idempotency, a torn file, and the clock-time reminders. `npm run typecheck` covers the app. There is no separate lint script.

## Limits

- Company and role matching is normalization plus a short suffix list, not an open search. "Software Engineer Intern" does not attach to "Software Engineer Intern, Infrastructure", and a blank role does not pick one of several roles at that company.
- A date-only `eventAt` counts as the start of that local day. A status you set later the same day wins over it.
- Offer and Rejected replace each other only when the email is newer. Interview does not replace either.
- Past deadlines do not create tasks. A rejection does not check off a task that was already created; checking it off is what stops a later run from making another.
- The daily notification is still date-based. Only entries with a zoned clock time get the "in 3 hours" reminder.
- `jobs.json.bak` is still only the previous save. A scan that imports and then records the scan overwrites that backup, same as any other write.
