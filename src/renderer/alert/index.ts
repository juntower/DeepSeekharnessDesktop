import '../theme.css'
import './styles.css'
import type { AlertPayload } from '../../shared/contracts'

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function decodePayload(): AlertPayload {
  const encoded = new URLSearchParams(window.location.search).get('payload')
  if (encoded === null) throw new Error('missing alert payload')
  const value = JSON.parse(decodeBase64Url(encoded)) as Partial<AlertPayload>
  return {
    kind: value.kind === 'warning' || value.kind === 'danger' || value.kind === 'success' ? value.kind : 'info',
    title: typeof value.title === 'string' ? value.title : '系统通知',
    message: typeof value.message === 'string' ? value.message : '',
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    ...(typeof value.actionLabel === 'string' ? { actionLabel: value.actionLabel } : {}),
    ...(value.action === 'open-main' || value.action === 'restart-dsh' || value.action === 'open-settings' || value.action === 'check-updates'
      ? { action: value.action }
      : {})
  }
}

function element<T extends HTMLElement>(role: string): T {
  const found = document.querySelector<T>(`[data-role="${role}"]`)
  if (found === null) throw new Error(`missing alert element: ${role}`)
  return found
}

const payload = decodePayload()
const card = document.querySelector<HTMLElement>('.alert-card')
const kind = element('kind')
const title = element('title')
const message = element('message')
const detail = element('detail')
const actionButton = element<HTMLButtonElement>('action')
const actions = element('actions')
const dismiss = element<HTMLButtonElement>('dismiss')
const dismissSecondary = element<HTMLButtonElement>('dismiss-secondary')
const kindLabel: Record<AlertPayload['kind'], string> = {
  info: 'SYSTEM NOTICE',
  warning: 'ATTENTION REQUIRED',
  danger: 'CRITICAL ALERT',
  success: 'OPERATION COMPLETE'
}

if (card !== null) card.dataset.kind = payload.kind
kind.textContent = kindLabel[payload.kind]
title.textContent = payload.title
message.textContent = payload.message
if (payload.detail === undefined) {
  detail.remove()
} else {
  detail.textContent = payload.detail
}
if (payload.action === undefined || payload.actionLabel === undefined) {
  actions.classList.add('is-single')
  actionButton.remove()
} else {
  actionButton.textContent = payload.actionLabel
}

let closed = false
async function close(): Promise<void> {
  if (closed) return
  closed = true
  document.body.classList.add('is-leaving')
  await window.desktop.closeAlert().catch(() => undefined)
}
dismiss.addEventListener('click', () => { void close() })
dismissSecondary.addEventListener('click', () => { void close() })
actionButton.addEventListener('click', () => {
  if (payload.action === undefined || closed) return
  closed = true
  void window.desktop.runAlertAction(payload.action).catch(() => undefined)
})
window.setTimeout(() => { void close() }, payload.kind === 'danger' ? 15_000 : 9_000)
