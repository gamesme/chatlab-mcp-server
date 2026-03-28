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
