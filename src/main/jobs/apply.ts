import { clipboard, Notification, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JobItem } from '../../shared/jobs'
import { profileDir, readProfileFile } from './profile'

const INSTRUCTIONS = `You are filling out an internship application for me. Work on the page that is open (or open the URL below).

Rules
- Fill every field you can from the answers block below. Use the resume PDF at the path given when the form asks for a resume upload.
- If a question is not covered by the answers block, leave it blank and note it — do not guess and do not invent facts.
- Do NOT submit. Stop at the final review page and leave it open for me.
- When you stop, list every field you filled and everything you were unsure about or skipped.`

/** The prompt handed to Aside. Pure so it can be inspected without Electron. */
export function buildApplyPrompt(item: JobItem, answers: string, resumePdf: string): string {
  const lines: (string | null)[] = [
    INSTRUCTIONS,
    '',
    '## Posting',
    `URL: ${item.url}`,
    `Company: ${item.company}`,
    `Role: ${item.title}`,
    item.location ? `Location: ${item.location}` : null,
    item.deadline ? `Deadline: ${item.deadline}` : null,
    item.referralNote ? `Note from the source that shared this posting: ${item.referralNote}` : null,
    item.verdict?.summary ? `Why I'm applying: ${item.verdict.summary}` : null,
    item.verdict?.matched.length ? `Strengths to emphasize if asked: ${item.verdict.matched.join('; ')}` : null,
    '',
    `## Resume PDF`,
    resumePdf,
    '',
    '## My standard answers',
    answers.trim() || '(answers.md is empty — leave personal fields blank and list them)'
  ]
  return lines.filter((l): l is string => l !== null).join('\n')
}

function findAsideCli(): string | null {
  const dirs = [
    ...(process.env.PATH ?? '').split(':'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.aside', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin'
  ]
  for (const d of dirs) {
    const p = join(d, 'aside')
    if (d && existsSync(p)) return p
  }
  return null
}

export type ApplyLaunch = 'cli' | 'clipboard'

/**
 * Hand a posting to Aside. With the CLI installed, start an agent task directly (no shell,
 * so the prompt never touches shell history). Without it, open the posting in Aside.app and
 * put the prompt on the clipboard so one paste starts the same task.
 */
export async function launchApply(item: JobItem): Promise<{ via: ApplyLaunch }> {
  const prompt = buildApplyPrompt(item, readProfileFile('answers.md'), join(profileDir(), 'resume.pdf'))
  const cli = findAsideCli()
  if (cli) {
    const child = spawn(cli, [prompt], { detached: true, stdio: 'ignore' })
    child.unref()
    return { via: 'cli' }
  }
  clipboard.writeText(prompt)
  try {
    // `open -a Aside <url>` — no shell involved; arguments are passed as-is.
    const child = spawn('/usr/bin/open', ['-a', 'Aside', item.url], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    await shell.openExternal(item.url)
  }
  if (Notification.isSupported()) {
    new Notification({
      title: 'Prompt copied for Aside',
      body: `${item.company} opened in Aside. Paste (⌘V) into the agent box to start filling the application.`,
      silent: true
    }).show()
  }
  return { via: 'clipboard' }
}
