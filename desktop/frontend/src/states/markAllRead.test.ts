import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Message } from '../types'
import { accounts$ } from './accounts'
import { mail$ } from './mail'
import { markAllRead } from './mailFlags'
import { ui$ } from './ui'

const account = (id: string) => ({
  id,
  email: `${id}@example.com`,
  display_name: id,
  provider: 'custom',
  auth_type: 'password',
  imap_host: '',
  imap_port: 993,
  smtp_host: '',
  smtp_port: 465,
  tls: true,
})

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'acc-1:INBOX:thread-1#1',
  account_id: 'acc-1',
  folder_id: 'INBOX',
  thread_id: 'acc-1#INBOX#thread-1',
  from_name: 'Sender',
  from_addr: 'sender@example.com',
  to: 'me@example.com',
  subject: 'Subject',
  preview: '',
  body: '',
  date: 1,
  unread: true,
  starred: false,
  has_attachments: false,
  ...overrides,
})

describe('markAllRead', () => {
  let previousGo: unknown
  let release = () => {}

  beforeEach(() => {
    previousGo = (window as any).go
    accounts$.set([account('acc-1'), account('acc-2')] as any)
    ui$.selectedAccount.set('unified')
    ui$.selectedFolder.set('inbox')
    mail$.folders.set([{ id: 'inbox', account_id: 'unified', name: 'Inbox', role: 'inbox', unread: 57 }])
    mail$.foldersByAccount.set({
      'acc-1': [{ id: 'INBOX', account_id: 'acc-1', name: 'Inbox', role: 'inbox', unread: 50 }],
      'acc-2': [{ id: 'INBOX', account_id: 'acc-2', name: 'Inbox', role: 'inbox', unread: 7 }],
    })
    mail$.threads.set([
      message(),
      message({ id: 'acc-2:INBOX:t2#1', account_id: 'acc-2', thread_id: 'acc-2#INBOX#t2' }),
    ])
    mail$.messages.set(mail$.threads.get())
    const gate = new Promise<void>((resolve) => (release = resolve))
    ;(window as any).go = {
      main: {
        App: {
          Invoke: async (command: string, payload: any) => {
            if (command === 'mail.folderList') {
              return {
                folders: [{ id: 'INBOX', account_id: payload.account_id, name: 'Inbox', role: 'inbox', unread: 0 }],
              }
            }
            if (command === 'mail.markAllRead') await gate
            return {}
          },
        },
      },
    }
  })

  afterEach(() => {
    release()
    if (previousGo === undefined) delete (window as any).go
    else (window as any).go = previousGo
  })

  it('clears the side navigation folder badges before the backend answers', async () => {
    const pending = markAllRead()

    expect(mail$.foldersByAccount['acc-1'][0].unread.get()).toBe(0)
    expect(mail$.foldersByAccount['acc-2'][0].unread.get()).toBe(0)
    expect(mail$.folders[0].unread.get()).toBe(0)
    release()
    await pending
  })
})
