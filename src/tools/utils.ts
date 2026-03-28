import { ChatLabError } from '../client.js'

export function toolError(
  e: unknown,
  sessionId?: string
): { content: [{ type: 'text'; text: string }]; isError: true } {
  let message: string
  if (e instanceof ChatLabError && e.status === 404 && sessionId !== undefined) {
    message = `Session not found: ${sessionId}`
  } else {
    message = e instanceof Error ? e.message : 'Unknown error'
  }
  return { content: [{ type: 'text' as const, text: message }], isError: true as const }
}

interface CompactMessage {
  timestamp: number
  senderName: string
  content: string | null
}

interface CompactSessionHeader {
  total?: number
  returnedCount?: number
  startTs?: number
  endTs?: number
  participants?: string[]
}

const MAX_CONTENT_LEN = 200

function fmtDate(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function formatMessagesCompact(
  messages: CompactMessage[],
  header?: CompactSessionHeader
): string {
  const lines: string[] = []

  if (header) {
    const parts: string[] = []
    if (header.total !== undefined) parts.push(`total: ${header.total}`)
    if (header.returnedCount !== undefined) parts.push(`returnedCount: ${header.returnedCount}`)
    if (header.startTs !== undefined && header.endTs !== undefined)
      parts.push(`timeRange: ${fmtDate(header.startTs)} ~ ${fmtDate(header.endTs)}`)
    if (parts.length > 0) lines.push(parts.join('  '))
    if (header.participants?.length) lines.push(`participants: ${header.participants.join(', ')}`)
    lines.push('')
  }

  let lastDate = ''
  for (const msg of messages) {
    const d = fmtDate(msg.timestamp)
    if (d !== lastDate) {
      lines.push(`--- ${d} ---`)
      lastDate = d
    }
    const c = msg.content ?? ''
    lines.push(
      `${fmtTime(msg.timestamp)} ${msg.senderName}: ${c.length > MAX_CONTENT_LEN ? c.slice(0, MAX_CONTENT_LEN) + '…' : c}`
    )
  }

  return lines.join('\n')
}
