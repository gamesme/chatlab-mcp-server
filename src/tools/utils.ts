import { ChatLabError } from '../client.js'
import type { ChatLabClient } from '../client.js'

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

export async function sqlInternal(
  client: Pick<ChatLabClient, 'post'>,
  sessionId: string,
  sql: string
): Promise<any[]> {
  const result: any = await client.post(`/api/v1/sessions/${sessionId}/sql`, { sql })
  const data = result?.data

  // API returns { columns: [...], rows: [[...], [...]] } — convert 2D array to object array
  if (Array.isArray(data?.columns) && Array.isArray(data?.rows)) {
    return data.rows.map((row: any[]) =>
      Object.fromEntries(data.columns.map((col: string, i: number) => [col, row[i]]))
    )
  }

  if (Array.isArray(data)) return data
  if (Array.isArray(data?.rows)) return data.rows
  return []
}
