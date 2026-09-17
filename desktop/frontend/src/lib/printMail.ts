import { invoke } from './bridge'
import { CONVERSATION_PAGE_SIZE } from './pagination'
import { htmlToText } from './html'
import { t } from './i18n'
import { formatFullTimestamp } from '../components/chat/messageHelpers'
import { showToast } from '../states/ui'
import type { Message, MessageTab } from '../types'

let disposePrint: (() => void) | undefined

// A text-only print document avoids executing message HTML or fetching trackers.
// Keep it outside React's root so print styles can hide all application chrome.
export function mailPrintText(mail: Message | MessageTab): string {
  const message = 'from_addr' in mail
  const from = message
    ? mail.from_name
      ? `${mail.from_name} <${mail.from_addr}>`
      : mail.from_addr
    : mail.fromRaw || mail.from
  const rows = [
    mail.subject || t('threads.noSubject'),
    `${t('composer.fields.from')}: ${from}`,
    ...(['to', 'cc', 'bcc'] as const).flatMap((key) =>
      mail[key] ? [`${t(`composer.fields.${key}`)}: ${mail[key]}`] : [],
    ),
    (message ? mail.reply_to : mail.replyTo) ? `${t('chat.replyTo')}: ${message ? mail.reply_to : mail.replyTo}` : '',
    mail.date ? formatFullTimestamp(mail.date) : '',
  ].filter(Boolean)
  let body = message && mail.body_missing ? t('chat.couldNotPrintMessage') : mail.body
  if (!body) {
    const html = new DOMParser().parseFromString((message ? mail.body_html : mail.bodyHtml) || '', 'text/html')
    html
      .querySelectorAll('script, style, img, iframe, object, embed, link, video, audio, source')
      .forEach((el) => el.remove())
    html.querySelectorAll('*').forEach((el) => {
      for (const attribute of Array.from(el.attributes)) el.removeAttribute(attribute.name)
    })
    body = htmlToText(html.body.innerHTML)
  }
  const attachments = (mail.attachments ?? []).map((attachment) => attachment.filename)
  return `${rows.join('\n')}\n\n${body}${attachments.length ? `\n\n${t('chat.printAttachments')}:\n${attachments.join('\n')}` : ''}`
}

export async function loadPrintThread(threadId: string): Promise<Message[]> {
  const messages = new Map<string, Message>()
  const cursors = new Set<string>()
  let cursor = ''
  do {
    if (cursors.has(cursor)) throw new Error('Repeated thread cursor')
    cursors.add(cursor)
    const page = await invoke<{ messages: Message[]; next_cursor?: string }>('mail.threadRead', {
      thread_id: threadId,
      limit: CONVERSATION_PAGE_SIZE,
      for_print: true,
      ...(cursor ? { before_cursor: cursor } : {}),
    })
    for (const message of page.messages) {
      if (!messages.has(message.id)) messages.set(message.id, message)
    }
    cursor = page.next_cursor ?? ''
  } while (cursor)
  if (!messages.size) throw new Error('Thread is empty')
  return [...messages.values()].sort((a, b) => a.date - b.date)
}

export async function printThread(threadId: string) {
  try {
    await printMails(await loadPrintThread(threadId), 'chat.couldNotPrintThread')
  } catch {
    showToast(t('chat.couldNotPrintThread'), 'error')
  }
}

export async function printMail(mail: Message | MessageTab) {
  await printMails([mail])
}

async function printMails(mails: (Message | MessageTab)[], errorKey = 'chat.couldNotPrintMessage') {
  disposePrint?.()
  const root = document.createElement('div')
  root.id = 'meron-print-document'
  const style = document.createElement('style')
  style.textContent = `
    #meron-print-document { display: none; }
    @media print {
      @page { margin: 15mm; }
      html, body { height: auto !important; overflow: visible !important; background: white !important; }
      body > :not(#meron-print-document) { display: none !important; }
      #meron-print-document { display: block !important; color: black; background: white; }
      #meron-print-document pre + pre { break-before: page; page-break-before: always; }
      #meron-print-document pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere;
        font: 11pt/1.5 sans-serif; color: black; }
    }`
  root.append(style)
  for (const mail of mails) {
    const content = document.createElement('pre')
    content.textContent = mailPrintText(mail)
    root.append(content)
  }
  document.body.append(root)
  const cleanup = () => {
    root.remove()
    window.removeEventListener('afterprint', cleanup)
    if (disposePrint === cleanup) disposePrint = undefined
  }
  disposePrint = cleanup
  window.addEventListener('afterprint', cleanup, { once: true })
  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if ((window as any).go?.main?.App) {
      // NSPrintInfo supplies native margins. Restore CSS margins on fallback.
      const browserStyles = style.textContent
      style.textContent += '\n@media print { @page { margin: 0; } }'
      const native = await invoke<boolean>('mail.print')
      if (native) cleanup()
      else {
        style.textContent = browserStyles
        window.print()
      }
    } else window.print()
  } catch {
    cleanup()
    showToast(t(errorKey), 'error')
  }
}
