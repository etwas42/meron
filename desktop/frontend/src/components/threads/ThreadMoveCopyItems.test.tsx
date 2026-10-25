import { afterEach, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Account, Folder } from '../../types'
import { accounts$ } from '../../states/accounts'
import { mail$ } from '../../states/mail'
import { recentThreadTransfers$ } from '../../states/recentThreadTransfers'
import { ThreadMoveCopyItems } from './ThreadMoveCopyItems'

afterEach(() => {
  accounts$.set([])
  mail$.foldersByAccount.set({})
  recentThreadTransfers$.set([])
})

it('shows only two valid, account-scoped recent actions directly after the flyout rows', () => {
  accounts$.set([
    { id: 'acc', email: 'me@example.com' },
    { id: 'other', email: 'other@example.com' },
  ] as Account[])
  const folder = (id: string): Folder => ({ id, name: id, account_id: 'acc', role: '', unread: 0 })
  mail$.foldersByAccount.set({ acc: ['INBOX', 'Work', 'Receipts', 'Older'].map(folder) })
  recentThreadTransfers$.set([
    { action: 'move', sourceAccountId: 'other', targetAccountId: 'other', targetFolderId: 'Work' },
    ...['INBOX', 'Deleted', 'Work', 'Receipts', 'Older'].map((targetFolderId) => ({
      action: targetFolderId === 'Receipts' ? ('copy' as const) : ('move' as const),
      sourceAccountId: 'acc',
      targetAccountId: 'acc',
      targetFolderId,
    })),
  ])
  const html = renderToStaticMarkup(
    <ThreadMoveCopyItems threadId="acc#INBOX#thread" accountId="acc" folderId="INBOX" close={() => {}} />,
  )
  const container = document.createElement('div')
  container.innerHTML = html
  expect(Array.from(container.querySelectorAll('button')).map((button) => button.textContent)).toEqual([
    'Move to...',
    'Copy to...',
    'Move to “Work”',
    'Copy to “Receipts”',
  ])
})

it('offers other accounts in Move to and forwards the selected account', async () => {
  accounts$.set([
    { id: 'acc', email: 'me@example.com' },
    { id: 'other', email: 'other@example.com' },
  ] as Account[])
  const folders = (account_id: string): Folder[] =>
    ['INBOX', 'Work'].map((id) => ({ id, name: id, account_id, role: '', unread: 0 }))
  mail$.foldersByAccount.set({ acc: folders('acc'), other: folders('other') })
  const moves: string[][] = []
  const view = render(
    <ThreadMoveCopyItems
      threadId="acc#INBOX#thread"
      accountId="acc"
      folderId="INBOX"
      close={() => {}}
      onMove={(...args) => {
        moves.push(args)
      }}
    />,
  )
  try {
    fireEvent.click(view.getByText('Move to...'))
    await waitFor(() => expect(view.getByText('other@example.com')).toBeTruthy())
    // The source INBOX is excluded; the other account's INBOX remains pickable.
    fireEvent.click(view.getByText('INBOX'))
    expect(moves).toEqual([['acc#INBOX#thread', 'other', 'INBOX']])
  } finally {
    cleanup()
  }
})
