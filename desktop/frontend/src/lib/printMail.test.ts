import { beforeEach, afterEach, expect, spyOn, test } from 'bun:test'
import { loadPrintThread, mailPrintHtml, mailPrintText, printMail, printThread } from './printMail'
import type { Message, MessageTab } from '../types'
import { CONVERSATION_PAGE_SIZE } from './pagination'
import { thread$ } from '../states/thread'
import { accounts$ } from '../states/accounts'
import type { Account } from '../types'

beforeEach(() => {
  thread$.conversationModeOverrides.set({ a: 'html' })
})

const message: Message = {
  id: 'm',
  account_id: 'a',
  folder_id: 'inbox',
  thread_id: 't',
  from_name: 'Alice',
  from_addr: 'alice@example.com',
  to: 'bob@example.com',
  subject: 'Hello <world>',
  body: 'Reply\n\n> Entire quoted message',
  preview: '',
  date: 0,
  unread: false,
  starred: false,
  has_attachments: false,
}

afterEach(() => {
  window.dispatchEvent(new Event('afterprint'))
  delete (window as any).go
  thread$.conversationModeOverrides.set({})
  accounts$.set([])
})

test('includes headers, full quoted body, and attachment names', () => {
  const text = mailPrintText({
    ...message,
    cc: 'cc@example.com',
    bcc: 'bcc@example.com',
    attachments: [{ key: 'report', filename: 'report.pdf', mime: 'application/pdf', size: 42 }],
  })
  expect(text).toContain('Alice <alice@example.com>')
  expect(text).toContain('cc@example.com')
  expect(text).toContain('bcc@example.com')
  expect(text).toContain(message.body)
  expect(text).toContain('report.pdf')
})

test('extracts HTML-only text without scripts, styles, or image requests', () => {
  const text = mailPrintText({
    ...message,
    body: '',
    body_html:
      '<style>hidden css</style><script>bad()</script><p>First &amp; second</p><p>Third</p><img src="https://tracker.test/pixel">',
  })
  expect(text).toContain('First & second')
  expect(text).toContain('Third')
  expect(text).not.toContain('bad()')
  expect(text).not.toContain('hidden css')
  expect(text).not.toContain('tracker.test')
})

test('plain attachment summaries retain embedded images and standalone files', () => {
  const inline = { key: 'logo', filename: 'logo-proton.png', mime: 'image/png', size: 100 }
  const mail = { ...message, body_html: '<img src="/media/logo">', attachments: [inline] }
  expect(mailPrintText(mail)).toContain('Attachments:')
  expect(mailPrintText(mail)).toContain(inline.filename)
  const text = mailPrintText({
    ...mail,
    attachments: [
      inline,
      { key: 'photo', filename: 'photo.png', mime: 'image/png', size: 100 },
      { key: 'report', filename: 'report.pdf', mime: 'application/pdf', size: 42 },
    ],
  })
  expect(text).toContain('photo.png')
  expect(text).toContain('report.pdf')
  expect(text).toContain(inline.filename)
})

test('message printing follows account mode and conversation overrides', () => {
  const mail = { ...message, body_html: '<b>HTML</b>' }
  thread$.conversationModeOverrides.set({})
  accounts$.set([{ id: 'a', conversation_html: false } as Account])
  expect(mailPrintHtml(mail, true)).toBeUndefined()
  thread$.conversationModeOverrides.set({ a: 'html' })
  expect(mailPrintHtml(mail, false)).toContain('<b>HTML</b>')
  accounts$.set([{ id: 'a', conversation_html: true } as Account])
  thread$.conversationModeOverrides.set({ a: 'plain' })
  expect(mailPrintHtml(mail, true)).toBeUndefined()
})

test('HTML printing preserves formatting and images even when a plain body exists', () => {
  const html = mailPrintHtml(
    {
      ...message,
      body_html:
        '<style>p { color: purple }</style><p><strong>Calendar</strong></p><img src="/media/logo" width="200" height="100">',
    },
    false,
  )!
  const doc = new DOMParser().parseFromString(html, 'text/html')
  expect(doc.querySelector('strong')?.textContent).toBe('Calendar')
  expect(doc.querySelector('img')?.getAttribute('src')).toBe('/media/logo')
  expect(doc.querySelector('img')?.getAttribute('loading')).toBe('eager')
  expect(html).toContain('color: purple')
  expect(html).not.toContain(message.body)
})

test('printing honors plain mode, missing bodies, and text-only messages', () => {
  const tab = { body: 'Plain', bodyHtml: '<b>HTML</b>', viewMode: 'plain' } as MessageTab
  expect(mailPrintHtml(tab, false)).toBeUndefined()
  expect(mailPrintHtml({ ...tab, viewMode: 'html' }, false)).toContain('<b>HTML</b>')
  expect(mailPrintHtml({ ...tab, viewMode: 'html', bodyMissing: true }, false)).toBeUndefined()
  expect(mailPrintHtml({ ...message, body_html: '<b>HTML</b>', body_missing: true }, false)).toBeUndefined()
  expect(mailPrintHtml(message, false)).toBeUndefined()
  const missingTab = { ...tab, bodyMissing: true, body: 'Stale body' }
  expect(mailPrintText(missingTab)).toContain('Could not print')
  expect(mailPrintText(missingTab)).not.toContain('Stale body')
})

test('HTML print CSP respects current remote policy and isolates active content', () => {
  const mail = {
    ...message,
    body_html: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: http: https:; style-src 'unsafe-inline'">
    <script>bad()</script><iframe></iframe>
    <img src="https://example.com/banner" width="600" height="200">`,
  }
  for (const allowed of [false, true]) {
    const doc = new DOMParser().parseFromString(mailPrintHtml(mail, allowed)!, 'text/html')
    expect(doc.querySelector('script, iframe')).toBeNull()
    const policies = Array.from(doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'))
    expect(policies).toHaveLength(2)
    for (const policy of policies) {
      const images = policy
        .getAttribute('content')!
        .split(';')
        .find((part) => part.trim().startsWith('img-src'))!
      expect(images.includes('https:')).toBe(allowed)
    }
  }
})

test('native printing gets an escaped document, replaces previous jobs, and cleans up', async () => {
  const calls: string[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string) => {
          calls.push(command)
          return true
        },
      },
    },
  }
  let printedText = ''
  ;(window as any).go.main.App.Invoke = async (command: string) => {
    calls.push(command)
    expect(document.querySelector('#meron-print-document img')).toBeNull()
    printedText = document.querySelector('#meron-print-document pre')?.textContent ?? ''
    return true
  }
  await printMail({ ...message, body: '<img src=x onerror=alert(1)>' })
  expect(calls).toEqual(['mail.print'])
  expect(printedText).toContain('<img src=x')
  expect(document.getElementById('meron-print-document')).toBeNull()
  await printMail(message)
  expect(document.querySelectorAll('#meron-print-document')).toHaveLength(0)
  window.dispatchEvent(new Event('afterprint'))
  expect(document.getElementById('meron-print-document')).toBeNull()
})

test('HTML print jobs wait for isolated frames and include headers and attachments', async () => {
  let printed = false
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async () => {
          const frame = document.querySelector<HTMLIFrameElement>('#meron-print-document iframe')!
          expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
          expect(frame.srcdoc).toContain('<strong>Formatted body</strong>')
          expect(document.querySelector('#meron-print-document pre')?.textContent).toContain(
            'Alice <alice@example.com>',
          )
          expect(document.querySelector('#meron-print-document')?.textContent).toContain('report.pdf')
          expect(document.querySelector('#meron-print-document')?.textContent).not.toContain('logo-proton.png')
          printed = true
          return true
        },
      },
    },
  }
  const job = printMail({
    ...message,
    body_html: '<strong>Formatted body</strong><img src="/media/logo">',
    attachments: [
      { key: 'report', filename: 'report.pdf', mime: 'application/pdf', size: 42 },
      { key: 'logo', filename: 'logo-proton.png', mime: 'image/png', size: 100 },
    ],
  })
  expect(printed).toBe(false)
  // Happy DOM does not provide browser layout; signal the frame's load explicitly.
  document.querySelector('#meron-print-document iframe')!.dispatchEvent(new Event('load'))
  await job
  expect(printed).toBe(true)
  expect(document.getElementById('meron-print-document')).toBeNull()
})

test('thread printing fetches all pages, deduplicates, and prints oldest first', async () => {
  const requests: any[] = []
  let sections: (string | null)[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          if (command === 'mail.print') {
            sections = [...document.querySelectorAll('#meron-print-document pre')].map((section) => section.textContent)
            return true
          }
          requests.push(payload)
          return payload.before_cursor
            ? {
                messages: [
                  { ...message, id: 'old', date: 1, body: 'Oldest' },
                  { ...message, id: 'new', date: 2, body: 'Duplicate' },
                ],
              }
            : { messages: [{ ...message, id: 'new', date: 2, body: 'Newest' }], next_cursor: 'older' }
        },
      },
    },
  }
  await printThread('original-thread')
  expect(requests.map((request) => request.thread_id)).toEqual(['original-thread', 'original-thread'])
  expect(requests.every((request) => request.limit === CONVERSATION_PAGE_SIZE && request.for_print === true)).toBe(true)
  expect(requests[1].before_cursor).toBe('older')
  expect(sections).toHaveLength(2)
  expect(sections[0]).toContain('Oldest')
  expect(sections[1]).toContain('Newest')
})

test('slow resources still print and beforeprint remeasures frame height', async () => {
  let finishLoading: (() => void) | undefined
  const timeout = spyOn(window, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    if (delay === 15000) finishLoading = callback
    return 0
  }) as typeof window.setTimeout)
  const print = spyOn(window, 'print').mockImplementation(() => {
    const frame = document.querySelector<HTMLIFrameElement>('#meron-print-document iframe')!
    const body = frame.contentDocument!.body
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 1200 })
    window.dispatchEvent(new Event('beforeprint'))
    expect(frame.style.height).toBe('1200px')
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 600 })
    window.dispatchEvent(new Event('beforeprint'))
    expect(frame.style.height).toBe('600px')
    window.dispatchEvent(new Event('afterprint'))
  })
  try {
    const job = printMail({ ...message, body_html: '<p>Available body</p>' })
    finishLoading!()
    await job
    expect(print).toHaveBeenCalledTimes(1)
  } finally {
    timeout.mockRestore()
    print.mockRestore()
  }
})

test('non-native printing calls window.print directly and cleans up afterprint', async () => {
  ;(window as any).go = { main: { App: { Invoke: async () => false } } }
  const print = spyOn(window, 'print').mockImplementation(() => {
    expect(document.querySelector('#meron-print-document pre')?.textContent).toContain(message.body)
    window.dispatchEvent(new Event('afterprint'))
  })
  try {
    await printMail(message)
    expect(print).toHaveBeenCalledTimes(1)
    expect(document.getElementById('meron-print-document')).toBeNull()
  } finally {
    print.mockRestore()
  }
})

test('prints unavailable-body notices and rejects repeated cursors', async () => {
  let printed = false
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string) => {
          if (command === 'mail.print') printed = true
          return { messages: [{ ...message, body_missing: true }] }
        },
      },
    },
  }
  expect(await loadPrintThread('t')).toHaveLength(1)
  expect(mailPrintText({ ...message, body_missing: true })).not.toContain(message.body)
  await printThread('t')
  expect(printed).toBe(true)
  ;(window as any).go.main.App.Invoke = async () => ({ messages: [message], next_cursor: 'same' })
  await expect(loadPrintThread('t')).rejects.toThrow('Repeated thread cursor')
})
