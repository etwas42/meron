import { invoke } from './bridge'
import { CONVERSATION_PAGE_SIZE } from './pagination'
import { htmlToText } from './html'
import { t } from './i18n'
import { formatFullTimestamp, htmlReferencesMedia } from '../components/chat/messageHelpers'
import { showToast } from '../states/ui'
import { accounts$ } from '../states/accounts'
import { settings$ } from '../states/settings'
import { thread$ } from '../states/thread'
import { remoteContentAllowed } from '../components/chat/messageHelpers'
import { stripTrackingPixels } from '../components/chat/readerHtml'
import { applyRemoteContentPolicy } from '../components/chat/remoteContentCsp'
import type { Message, MessageTab } from '../types'

let disposePrint: (() => void) | undefined

function printAttachmentNames(mail: Message | MessageTab, renderedHtml = false): string[] {
  const html = 'from_addr' in mail ? mail.body_html : mail.bodyHtml
  return (mail.attachments ?? [])
    .filter((attachment) => !renderedHtml || !htmlReferencesMedia(html, attachment))
    .map((attachment) => attachment.filename)
}

// Plain mode and messages without HTML retain a text-only print document.
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
  let body = (message ? mail.body_missing : mail.bodyMissing) ? t('chat.couldNotPrintMessage') : mail.body
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
  const attachments = printAttachmentNames(mail)
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

export async function printMail(mail: Message | MessageTab, allowRemote?: boolean) {
  await printMails([mail], 'chat.couldNotPrintMessage', allowRemote)
}

/** Keep the backend-sanitized email and its CSS/CSP in a separate document. */
export function mailPrintHtml(mail: Message | MessageTab, allowRemote: boolean): string | undefined {
  const message = 'from_addr' in mail
  if (message) {
    const account = accounts$.peek().find((account) => account.id === mail.account_id)
    const mode =
      thread$.conversationModeOverrides.peek()[mail.account_id] ??
      (account ? ((account.conversation_html ?? true) ? 'html' : 'plain') : 'plain')
    if (mode === 'plain') return
  }
  if (message ? mail.body_missing : mail.bodyMissing || mail.viewMode === 'plain') return
  const html = message ? mail.body_html : mail.bodyHtml
  if (!html) return
  const doc = new DOMParser().parseFromString(
    applyRemoteContentPolicy(stripTrackingPixels(html), allowRemote),
    'text/html',
  )
  // Always enforce a print policy, including for HTML without a baked CSP.
  const policy = doc.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = `default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src 'self' data: ${allowRemote ? 'http: https:' : ''}; media-src 'self' data: blob: ${allowRemote ? 'http: https:' : ''}; font-src 'self' data:;`
  doc.head.prepend(policy)
  doc
    .querySelectorAll('script, iframe, object, embed, base, link, meta[http-equiv="refresh" i]')
    .forEach((el) => el.remove())
  doc.querySelectorAll('img').forEach((img) => {
    img.loading = 'eager'
  })
  const style = doc.createElement('style')
  style.textContent = `html, body { height: auto !important; overflow: visible !important; }
    body { margin: 0; overflow-wrap: anywhere; }
    img, video, table { max-width: 100% !important; }
    img { height: auto !important; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }`
  doc.head.append(style)
  return '<!doctype html>' + doc.documentElement.outerHTML
}

function printRemoteAllowed(mail: Message | MessageTab): boolean {
  if (!('from_addr' in mail)) return !!mail.revealRemote
  return (
    remoteContentAllowed(
      mail,
      accounts$.peek().find((account) => account.id === mail.account_id),
      settings$.remoteImageSenders.peek(),
    ) || !!thread$.revealedRemote.peek()[mail.id]
  )
}

async function printMails(
  mails: (Message | MessageTab)[],
  errorKey = 'chat.couldNotPrintMessage',
  allowRemote?: boolean,
) {
  disposePrint?.()
  const root = document.createElement('div')
  root.id = 'meron-print-document'
  const style = document.createElement('style')
  style.textContent = `
    #meron-print-document { position: absolute; left: -100000px; top: 0; width: 180mm; }
    @media print {
      @page { margin: 15mm; }
      html, body { height: auto !important; overflow: visible !important; background: white !important; }
      body > :not(#meron-print-document) { display: none !important; }
      #meron-print-document { position: static; width: auto; display: block !important; color: black; background: white; }
      #meron-print-document > section + section { break-before: page; page-break-before: always; }
      #meron-print-document pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere;
        font: 11pt/1.5 sans-serif; color: black; }
    }`
  root.append(style)
  const ready: Promise<void>[] = []
  const frames: HTMLIFrameElement[] = []
  const timers: number[] = []
  const measureFrames = (targets = frames) => {
    // Batch writes before reads to avoid a layout flush for every frame.
    for (const frame of targets) frame.style.height = '1px'
    const heights = targets.map((frame) => {
      const doc = frame.contentDocument
      return doc?.body ? Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight) : 1
    })
    targets.forEach((frame, index) => {
      frame.style.height = `${heights[index]}px`
    })
  }
  const beforePrint = () => measureFrames()
  for (const mail of mails) {
    const section = document.createElement('section')
    root.append(section)
    const content = document.createElement('pre')
    const html = mailPrintHtml(mail, allowRemote ?? printRemoteAllowed(mail))
    if (!html) {
      content.textContent = mailPrintText(mail)
      section.append(content)
      continue
    }
    content.textContent = mailPrintText({ ...mail, body: ' ', attachments: [] }).trimEnd()
    content.style.marginBottom = '16px'
    section.append(content)
    const frame = document.createElement('iframe')
    frame.title = mail.subject
    frame.setAttribute('sandbox', 'allow-same-origin')
    frame.style.cssText = 'display:block;width:100%;border:0;height:1px;'
    frames.push(frame)
    ready.push(
      new Promise<void>((resolve, reject) => {
        const finish = () => {
          window.clearTimeout(timeout)
          const doc = frame.contentDocument
          if (!doc?.body) {
            reject(new Error('Print HTML unavailable'))
            return
          }
          measureFrames([frame])
          resolve()
        }
        // Images may never finish loading; print the available document instead.
        const timeout = window.setTimeout(finish, 15000)
        timers.push(timeout)
        frame.onload = finish
      }),
    )
    frame.srcdoc = html
    section.append(frame)
    const attachmentNames = printAttachmentNames(mail, true)
    if (attachmentNames.length) {
      const attachments = document.createElement('pre')
      attachments.textContent = `\n${t('chat.printAttachments')}:\n${attachmentNames.join('\n')}`
      section.append(attachments)
    }
  }
  document.body.append(root)
  const cleanup = () => {
    root.remove()
    timers.forEach((timer) => window.clearTimeout(timer))
    window.removeEventListener('beforeprint', beforePrint)
    window.removeEventListener('afterprint', cleanup)
    if (disposePrint === cleanup) disposePrint = undefined
  }
  disposePrint = cleanup
  window.addEventListener('afterprint', cleanup, { once: true })
  window.addEventListener('beforeprint', beforePrint)
  try {
    await Promise.all(ready)
    if (!root.isConnected) return
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if ((window as any).go?.main?.App) {
      // NSPrintInfo supplies native margins. Restore CSS margins on fallback.
      const browserStyles = style.textContent
      style.textContent += '\n@media print { @page { margin: 0; } }'
      const native = await invoke<boolean>('mail.print')
      if (native) cleanup()
      else {
        style.textContent = browserStyles
        root.style.removeProperty('width')
        window.print()
      }
    } else window.print()
  } catch {
    cleanup()
    showToast(t(errorKey), 'error')
  }
}
