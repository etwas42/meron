import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { mail$ } from '../../states/mailState'
import { ui$ } from '../../states/ui'
import { AppHotkeys } from './AppHotkeys'

const original = (window as any).go
let calls: string[] = []

beforeEach(() => {
  calls = []
  ;(window as any).go = { main: { App: { Invoke: async (command: string) => void calls.push(command) } } }
  ui$.selectedAccount.set('acct')
  ui$.selectedFolder.set('inbox')
  ui$.selectedThread.set('acct#INBOX#7')
  mail$.threads.set([{ id: 'acct#INBOX#7', account_id: 'acct', folder_id: 'inbox' } as any])
})

afterEach(() => {
  cleanup()
  ui$.calendarOpen.set(false)
  ui$.selectedThread.set('')
  mail$.threads.set([])
  ;(window as any).go = original
})

describe('AppHotkeys', () => {
  it('keeps mail shortcuts off the mail the calendar hides', async () => {
    ui$.calendarOpen.set(true)
    render(<AppHotkeys />)
    fireEvent.keyDown(document.body, { key: 'e' })
    fireEvent.keyDown(document.body, { key: '#', shiftKey: true })
    fireEvent.keyDown(document.body, { key: 'Delete' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.filter((command) => command.startsWith('mail.'))).toEqual([])
    expect(ui$.selectedThread.peek()).toBe('acct#INBOX#7')
  })

  it('still archives the selected thread with the calendar closed', async () => {
    render(<AppHotkeys />)
    fireEvent.keyDown(document.body, { key: 'e' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toContain('mail.archive')
  })
})
