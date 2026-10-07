// DEV ONLY. Builds a cdp-eval expression that parses one syllabus text through the running app.
// Usage: node scripts/syllabus-expr.mjs <file> <courseHint> > /tmp/expr.js
import { readFileSync } from 'node:fs'
const text = readFileSync(process.argv[2], 'utf8')
const hint = process.argv[3]
process.stdout.write(`window.briefly.parseSyllabus({ text: ${JSON.stringify(text)}, courseHint: ${JSON.stringify(hint)} }).then(r => JSON.stringify(r))`)
