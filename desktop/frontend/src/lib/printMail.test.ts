import { afterEach, expect, spyOn, test } from 'bun:test'
import { loadPrintThread, mailPrintText, printMail, printThread } from './printMail'
import type { Message } from '../types'
import { CONVERSATION_PAGE_SIZE } from './pagination'

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
