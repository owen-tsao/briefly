/// <reference lib="dom" />
/**
 * Runs INSIDE the application page (via page.evaluate) and returns every fillable control with
 * the best label we can find for it. ATS-agnostic on purpose: Greenhouse, Ashby, Lever, and
 * Workday all render ordinary inputs under ordinary labels once you stop caring about class names.
 *
 * Must stay self-contained (no imports, no closures over Node values): Playwright serialises the
 * function source and runs it in the browser.
 */

export type FieldKind = 'text' | 'textarea' | 'select' | 'combobox' | 'radio' | 'checkbox' | 'checkbox-group' | 'file' | 'date'

export interface FormField {
  /** Index into the page's data-briefly attribute set; stable until the DOM re-renders. */
  idx: number
  kind: FieldKind
  type: string
  name: string
  id: string
  label: string
  /** Text around the field (section heading, help text), for disambiguation. */
  context: string
  required: boolean
  /** For select/combobox/radio/checkbox-group: the choices as the user sees them. */
  options: { value: string; label: string; idx?: number }[]
  value: string
  placeholder: string
  autocomplete: string
  maxLength: number
}

export const BRIEFLY_ATTR = 'data-briefly'

export function scanFormsScript(): FormField[] {
  const ATTR = 'data-briefly'
  const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').replace(/[*✱]+/g, '').trim()
  const visible = (el: Element): boolean => {
    // File inputs are routinely hidden behind a styled button or drop zone — Workday's is
    // display:none — so they count regardless of how they are hidden; the filler sets them directly.
    if ((el as HTMLInputElement).type === 'file') return true
    const r = (el as HTMLElement).getBoundingClientRect()
    const cs = getComputedStyle(el as HTMLElement)
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
    return r.width > 0 && r.height > 0
  }
  /** Text of `root` minus the control's own subtree, so a <label> wrapping a <select> doesn't read as "GenderSelect…MaleFemale". */
  const textExcluding = (root: Element, skip: Element): string => {
    let t = ''
    const walk = (n: Node): void => {
      if (n === skip) return
      if (n.nodeType === Node.TEXT_NODE) t += n.textContent ?? ''
      else n.childNodes.forEach(walk)
    }
    walk(root)
    return clean(t)
  }
  const labelFor = (el: HTMLElement): string => {
    const id = el.id
    const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null
    if (byFor) return textExcluding(byFor, el)
    const labelled = el.getAttribute('aria-labelledby')
    if (labelled) {
      const t = labelled
        .split(/\s+/)
        .map((x) => document.getElementById(x)?.textContent ?? '')
        .join(' ')
      if (clean(t)) return clean(t)
    }
    const aria = el.getAttribute('aria-label')
    if (aria) return clean(aria)
    const wrap = el.closest('label')
    if (wrap) {
      const inner = wrap.querySelector('[class*="label" i]')
      if (inner && !inner.contains(el) && clean(inner.textContent)) return clean(inner.textContent)
      return textExcluding(wrap, el)
    }
    // Walk up a few levels looking for a label-like element that precedes the control.
    let node: HTMLElement | null = el
    for (let i = 0; i < 4 && node; i++) {
      const parent: HTMLElement | null = node.parentElement
      if (!parent) break
      const cand = parent.querySelector('label, legend, [class*="label" i], [data-automation-id*="label" i], h2, h3, h4, .question, [class*="question" i] > p:first-child')
      if (cand && !cand.contains(el) && cand.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        const t = clean(cand.textContent)
        if (t && t.length < 300) return t
      }
      node = parent
    }
    return clean(el.getAttribute('placeholder') ?? el.getAttribute('name') ?? '')
  }
  const contextFor = (el: HTMLElement): string => {
    const box = el.closest('fieldset, section, [class*="field" i], [class*="question" i], [data-automation-id*="formField" i], li, .form-group') as HTMLElement | null
    if (!box) return ''
    return clean(box.innerText).slice(0, 300)
  }

  // Keep numbers already on the page so a rescan (for fields that appear after an answer) does not
  // invalidate indices the filler is still holding; new elements get numbers past the current max.
  let n = 0
  document.querySelectorAll(`[${ATTR}]`).forEach((e) => {
    n = Math.max(n, Number(e.getAttribute(ATTR)) + 1 || 0)
  })
  const tag = (el: Element): number => {
    const has = el.getAttribute(ATTR)
    if (has) return Number(has)
    el.setAttribute(ATTR, String(n))
    return n++
  }

  const out: FormField[] = []
  const seenGroups = new Set<string>()
  const controls = Array.from(
    document.querySelectorAll<HTMLElement>('input, textarea, select, [role="combobox"], [role="listbox"], button[aria-haspopup="listbox"], [role="radiogroup"]')
  )
  for (const el of controls) {
    if (!visible(el)) continue
    const tagName = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') ?? (tagName === 'input' ? 'text' : tagName)).toLowerCase()
    const isListboxButton = tagName === 'button' && el.getAttribute('aria-haspopup') === 'listbox'
    if (type === 'hidden' || type === 'submit' || (type === 'button' && !isListboxButton) || type === 'password' || type === 'search' || type === 'image' || type === 'reset') continue
    if (el.closest('[aria-hidden="true"]') && type !== 'file') continue
    const name = el.getAttribute('name') ?? ''
    const required =
      el.hasAttribute('required') ||
      el.getAttribute('aria-required') === 'true' ||
      /[*✱]\s*$/.test(el.closest('label, .field, [class*="field" i], [class*="question" i]')?.querySelector('label, [class*="label" i]')?.textContent?.trim() ?? '') ||
      Boolean(el.closest('[class*="question" i], .field, li')?.querySelector('.required, [class*="required" i]:not(input)'))

    if (type === 'radio' || (type === 'checkbox' && name)) {
      const groupKey = name || el.closest('fieldset, [role="radiogroup"], [role="group"]')?.id || labelFor(el)
      if (seenGroups.has(type + groupKey)) continue
      seenGroups.add(type + groupKey)
      const members = name
        ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="${type}"][name="${CSS.escape(name)}"]`))
        : [el as HTMLInputElement]
      const group = el.closest('fieldset, [role="radiogroup"], [role="group"], .field, [class*="field" i], [class*="question" i]') as HTMLElement | null
      // The question text is a legend/label-ish element that precedes the options and contains none
      // of them. Lever puts it in a sibling `.application-label` one level above the options' box,
      // so walk up a few ancestors rather than trusting the nearest container.
      let groupCaption = ''
      let scope: HTMLElement | null = group ?? el.parentElement
      for (let i = 0; i < 4 && scope && !groupCaption; i++) {
        const cands = Array.from(scope.querySelectorAll('legend, [class*="label" i], label:not([for]), p, h3, h4, [class*="question" i] > div:first-child'))
        const hit = cands.find((c) => !members.some((m) => c.contains(m)) && c.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && clean(c.textContent).length > 1)
        if (hit) groupCaption = clean(hit.textContent).slice(0, 300)
        scope = scope.parentElement
      }
      const options = members
        .filter(visible)
        .map((m) => ({ value: m.value, label: clean(m.closest('label')?.textContent ?? (m.id ? document.querySelector(`label[for="${CSS.escape(m.id)}"]`)?.textContent : '') ?? m.value), idx: tag(m) }))
      // A single checkbox (consent, acknowledgement) is its own field, not a group.
      if (type === 'checkbox' && members.length === 1) {
        out.push({ idx: tag(el), kind: 'checkbox', type, name, id: el.id, label: labelFor(el), context: contextFor(el), required, options: [], value: (el as HTMLInputElement).checked ? 'on' : '', placeholder: '', autocomplete: '', maxLength: 0 })
        continue
      }
      const groupLabel = groupCaption || labelFor(el)
      out.push({ idx: tag(group ?? el), kind: type === 'radio' ? 'radio' : 'checkbox-group', type, name, id: group?.id ?? el.id, label: groupLabel, context: contextFor(el), required, options, value: members.find((m) => m.checked)?.value ?? '', placeholder: '', autocomplete: '', maxLength: 0 })
      continue
    }
    if (type === 'checkbox') {
      out.push({ idx: tag(el), kind: 'checkbox', type, name, id: el.id, label: labelFor(el), context: contextFor(el), required, options: [], value: (el as HTMLInputElement).checked ? 'on' : '', placeholder: '', autocomplete: '', maxLength: 0 })
      continue
    }
    if (type === 'file') {
      out.push({ idx: tag(el), kind: 'file', type, name, id: el.id, label: labelFor(el) || clean(el.closest('[class*="upload" i], [class*="attach" i], .field, section')?.textContent).slice(0, 80), context: contextFor(el), required, options: [], value: (el as HTMLInputElement).value ? 'set' : '', placeholder: '', autocomplete: '', maxLength: 0 })
      continue
    }
    if (tagName === 'select') {
      const sel = el as HTMLSelectElement
      out.push({ idx: tag(el), kind: 'select', type, name, id: el.id, label: labelFor(el), context: contextFor(el), required, options: Array.from(sel.options).filter((o) => o.value !== '').map((o) => ({ value: o.value, label: clean(o.textContent) })), value: sel.value, placeholder: '', autocomplete: sel.autocomplete, maxLength: 0 })
      continue
    }
    const isCombo = isListboxButton || el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox' || el.getAttribute('aria-autocomplete') === 'list' || el.getAttribute('role') === 'listbox'
    if (isCombo) {
      // Workday's listbox button shows the current choice ("United States of America") or a "Select One" placeholder.
      const shown = clean(el.textContent)
      const current = tagName === 'input' ? (el as HTMLInputElement).value : /^select( one)?$/i.test(shown) ? '' : shown
      out.push({ idx: tag(el), kind: 'combobox', type, name, id: el.id, label: labelFor(el), context: contextFor(el), required, options: [], value: current, placeholder: el.getAttribute('placeholder') ?? '', autocomplete: '', maxLength: 0 })
      continue
    }
    if (tagName === 'textarea' || el.getAttribute('contenteditable') === 'true') {
      out.push({ idx: tag(el), kind: 'textarea', type, name, id: el.id, label: labelFor(el), context: contextFor(el), required, options: [], value: (el as HTMLTextAreaElement).value ?? '', placeholder: el.getAttribute('placeholder') ?? '', autocomplete: '', maxLength: Number(el.getAttribute('maxlength') ?? 0) })
      continue
    }
    if (tagName === 'input') {
      out.push({ idx: tag(el), kind: type === 'date' || type === 'month' ? 'date' : 'text', type, name, id: el.id, label: labelFor(el), context: contextFor(el), required, options: [], value: (el as HTMLInputElement).value, placeholder: el.getAttribute('placeholder') ?? '', autocomplete: (el as HTMLInputElement).autocomplete, maxLength: Number(el.getAttribute('maxlength') ?? 0) })
    }
  }
  return out
}
