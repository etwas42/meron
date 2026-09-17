import { afterEach, beforeEach, expect, it } from 'bun:test'
import { useState } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { RecipientInput } from './RecipientInput'

function Field({ onTab }: { onTab: () => void }) {
  const [value, setValue] = useState('')
  return <RecipientInput value={value} onChange={setValue} accountId="a" onTab={onTab} />
}

beforeEach(() => {
  ;(window as any).go = {
    main: { App: { Invoke: async () => ({ contacts: [{ name: '', addr: 'alice@example.com' }] }) } },
  }
})
afterEach(cleanup)

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160))
  })
}
async function showSuggestions(input: HTMLElement) {
  await act(async () => {
    input.focus()
  })
  fireEvent.change(input, { target: { value: 'al' } })
  await settle()
}

it('accepts with Tab, stays closed, then advances on the next Tab', async () => {
  let advances = 0
  const view = render(<Field onTab={() => advances++} />)
  const input = view.getByRole('textbox') as HTMLInputElement
  await showSuggestions(input)
  expect(view.queryByRole('list')).not.toBeNull()
  fireEvent.keyDown(input, { key: 'Tab' })
  expect(input.value).toBe('alice@example.com, ')
  await settle()
  expect(view.queryByRole('list')).toBeNull()
  fireEvent.keyDown(input, { key: 'Tab' })
  expect(advances).toBe(1)
  expect(input.value).toBe('alice@example.com, ')
  fireEvent.change(input, { target: { value: 'alice@example.com, al' } })
  await settle()
  expect(view.queryByRole('list')).not.toBeNull()
})

it('leaves Shift+Tab to native navigation when suggestions are open', async () => {
  let advances = 0
  const view = render(<Field onTab={() => advances++} />)
  const input = view.getByRole('textbox') as HTMLInputElement
  await showSuggestions(input)
  expect(view.queryByRole('list')).not.toBeNull()
  expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(true)
  expect(input.value).toBe('al')
  expect(advances).toBe(0)
  expect(view.queryByRole('list')).toBeNull()
})
