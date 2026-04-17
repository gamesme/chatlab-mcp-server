/**
 * 消息格式化与压缩工具
 * 用于在 MCP server 层面对消息进行省 token 处理
 */

export interface FormattedMessage {
  id?: number
  senderName: string
  content: string | null
  timestamp: number
  senderPlatformId?: string
}

interface ProcessedMessage {
  senderName: string
  content: string
  timestamp: number
}

/** 最大消息内容长度（超出部分截断） */
const MAX_CONTENT_LENGTH = 200

/** 占位符文本（中英文） */
const PLACEHOLDERS = [
  '[图片]', '[语音]', '[视频]', '[文件]', '[表情]', '[动画表情]',
  '[位置]', '[名片]', '[红包]', '[转账]', '[撤回消息]',
  '[image]', '[voice]', '[video]', '[file]', '[sticker]',
  '[animated sticker]', '[location]', '[contact]', '[red packet]',
  '[transfer]', '[recalled message]', '[photo]', '[audio]', '[gif]',
]

/** 无意义的短回复（英文，不区分大小写） */
const MEANINGLESS_SHORT_EN = [
  'ok', 'k', 'yes', 'no', 'ya', 'yep', 'nope', 'lol',
  'haha', 'hehe', 'hmm', 'ah', 'oh', 'wow', 'thx', 'ty', 'np', 'gg', 'brb', 'idk',
]

/** 有意义的中文短回复 */
const MEANINGFUL_SHORT_ZH = ['好的', '不是', '是的', '可以', '不行', '好吧', '明白', '知道', '同意']

/**
 * 判断消息是否有意义（用于过滤）
 * 支持中英文内容过滤
 */
export function isValidMessage(content: string): boolean {
  const trimmed = content.trim()

  // 过滤空内容
  if (!trimmed) return false

  // 过滤单字/双字无意义回复（中文）
  if (trimmed.length <= 2) {
    if (!MEANINGFUL_SHORT_ZH.includes(trimmed)) return false
  }

  // 过滤短无意义回复（英文）
  const lowerTrimmed = trimmed.toLowerCase()
  if (MEANINGLESS_SHORT_EN.includes(lowerTrimmed)) return false

  // 过滤纯表情消息
  const emojiOnlyPattern = /^[\p{Emoji}\s[\]（）()]+$/u
  if (emojiOnlyPattern.test(trimmed)) return false

  // 过滤占位符文本
  if (PLACEHOLDERS.some((p) => lowerTrimmed === p.toLowerCase())) return false

  // 过滤系统消息（中文）
  const systemPatternsZh = [
    /^.*邀请.*加入了群聊$/,
    /^.*退出了群聊$/,
    /^.*撤回了一条消息$/,
    /^你撤回了一条消息$/,
  ]
  if (systemPatternsZh.some((p) => p.test(trimmed))) return false

  // 过滤系统消息（英文）
  const systemPatternsEn = [
    /^.*invited.*to the group$/i,
    /^.*left the group$/i,
    /^.*recalled a message$/i,
    /^you recalled a message$/i,
    /^.*joined the group$/i,
    /^.*has been removed$/i,
  ]
  if (systemPatternsEn.some((p) => p.test(trimmed))) return false

  return true
}

/**
 * 预处理消息：过滤无意义内容
 */
export function preprocessMessages(
  messages: Array<{ senderName: string; content: string | null; timestamp: number }>
): ProcessedMessage[] {
  return messages
    .filter((m) => m.content && isValidMessage(m.content))
    .map((m) => ({
      senderName: m.senderName,
      content: m.content!.trim(),
      timestamp: m.timestamp,
    }))
}

/**
 * 截断过长内容
 */
export function truncateContent(content: string, maxLength: number = MAX_CONTENT_LENGTH): string {
  if (content.length <= maxLength) return content
  return content.slice(0, maxLength) + '...'
}

/**
 * 格式化单条消息为简洁格式
 * 输出: "2025/3/3 07:25:04 张三: 消息内容"
 */
export function formatMessageCompact(
  msg: FormattedMessage,
  locale: string = 'zh-CN'
): string {
  const time = new Date(msg.timestamp * 1000).toLocaleString(locale, {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const content = msg.content || '[无内容]'
  const truncated = truncateContent(content)
  return `${time} ${msg.senderName}: ${truncated}`
}

/**
 * 合并同一发送者的连续消息
 */
export function mergeConsecutiveMessages(
  messages: ProcessedMessage[]
): Array<{ senderName: string; contents: string[]; timestamp: number }> {
  const merged: Array<{ senderName: string; contents: string[]; timestamp: number }> = []

  for (const msg of messages) {
    const last = merged[merged.length - 1]
    if (last && last.senderName === msg.senderName) {
      last.contents.push(msg.content)
    } else {
      merged.push({
        senderName: msg.senderName,
        contents: [msg.content],
        timestamp: msg.timestamp,
      })
    }
  }

  return merged
}

/**
 * 将合并后的消息转为字符串
 * 同一发送者的多条消息用分号连接
 */
function formatMergedMessage(
  merged: { senderName: string; contents: string[]; timestamp: number },
  locale: string = 'zh-CN'
): string {
  const time = new Date(merged.timestamp * 1000).toLocaleString(locale, {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const combinedContent = merged.contents.join('; ')
  const truncated = truncateContent(combinedContent, MAX_CONTENT_LENGTH * 2)
  return `${time} ${merged.senderName}: ${truncated}`
}

/**
 * 格式化消息为纯文本对话流
 * 支持合并同一发送者的连续消息以节省 token
 */
export function formatMessagesAsPlainText(
  messages: FormattedMessage[],
  options: {
    locale?: string
    mergeConsecutive?: boolean
    filterInvalid?: boolean
  } = {}
): string {
  const { locale = 'zh-CN', mergeConsecutive = true, filterInvalid = true } = options

  if (messages.length === 0) return ''

  // 预处理
  let processed: ProcessedMessage[] = messages.map((m) => ({
    senderName: m.senderName,
    content: m.content || '[无内容]',
    timestamp: m.timestamp,
  }))

  if (filterInvalid) {
    processed = processed.filter((m) => isValidMessage(m.content))
  }

  if (processed.length === 0) return ''

  // 格式化
  if (mergeConsecutive) {
    const merged = mergeConsecutiveMessages(processed)
    return merged.map((m) => formatMergedMessage(m, locale)).join('\n')
  } else {
    return processed
      .map((m) => formatMessageCompact({ ...m, content: m.content }, locale))
      .join('\n')
  }
}

/**
 * 生成对话摘要统计
 */
export function generateConversationStats(
  messages: FormattedMessage[],
  formattedText: string
): {
  originalCount: number
  validCount: number
  estimatedTokens: number
  compressionRatio: number
} {
  const validCount = messages.filter((m) => m.content && isValidMessage(m.content)).length
  const originalCount = messages.length

  // 粗略估算：中文约 2 tokens/字符，英文约 0.25 tokens/字符
  // 这里使用简化估算
  const estimatedTokens = Math.ceil(formattedText.length * 0.6)

  const compressionRatio = originalCount > 0 ? validCount / originalCount : 1

  return {
    originalCount,
    validCount,
    estimatedTokens,
    compressionRatio,
  }
}

/**
 * 将工具结果格式化为 LLM 友好的纯文本
 * 参考主项目的 formatToolResultAsText 实现
 */
export function formatToolResultAsText(details: Record<string, unknown>): string {
  const lines: string[] = []
  const messages = details.messages as string[] | undefined

  for (const [key, value] of Object.entries(details)) {
    if (key === 'messages') continue
    if (value === undefined || value === null) continue

    if (typeof value === 'object') {
      if ('start' in (value as Record<string, unknown>) && 'end' in (value as Record<string, unknown>)) {
        const range = value as { start: string; end: string }
        lines.push(`${key}: ${range.start} ~ ${range.end}`)
      } else if (Array.isArray(value)) {
        lines.push(`${key}: ${value.join(', ')}`)
      } else {
        lines.push(`${key}: ${JSON.stringify(value)}`)
      }
    } else {
      lines.push(`${key}: ${value}`)
    }
  }

  if (messages && messages.length > 0) {
    lines.push('')
    let lastDate = ''
    for (const msg of messages) {
      const spaceIdx = msg.indexOf(' ')
      const secondSpaceIdx = msg.indexOf(' ', spaceIdx + 1)
      if (spaceIdx > 0 && secondSpaceIdx > 0) {
        const date = msg.slice(0, spaceIdx)
        const rest = msg.slice(spaceIdx + 1)
        if (date !== lastDate) {
          lines.push(`--- ${date} ---`)
          lastDate = date
        }
        lines.push(rest)
      } else {
        lines.push(msg)
      }
    }
  }

  return lines.join('\n')
}

/**
 * 格式化会话列表为纯文本
 */
export function formatSessionsAsText(sessions: Array<{
  id: string
  name: string
  platform: string
  messageCount: number
  memberCount: number
  importedAt?: number
}>): string {
  if (sessions.length === 0) return 'No sessions found.'

  const lines: string[] = [`Found ${sessions.length} sessions:`, '']

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]
    lines.push(`${i + 1}. ${s.name}`)
    lines.push(`   Platform: ${s.platform}`)
    lines.push(`   Messages: ${s.messageCount} | Members: ${s.memberCount}`)
    if (s.importedAt) {
      const date = new Date(s.importedAt * 1000).toLocaleDateString('zh-CN')
      lines.push(`   Imported: ${date}`)
    }
    lines.push(`   ID: ${s.id}`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 格式化会话详情为纯文本
 */
export function formatSessionAsText(session: {
  id: string
  name: string
  platform: string
  type: string
  messageCount: number
  memberCount: number
  importedAt?: number
}): string {
  const lines: string[] = [
    `Session: ${session.name}`,
    `ID: ${session.id}`,
    `Platform: ${session.platform}`,
    `Type: ${session.type}`,
    `Messages: ${session.messageCount}`,
    `Members: ${session.memberCount}`,
  ]

  if (session.importedAt) {
    const date = new Date(session.importedAt * 1000).toLocaleString('zh-CN')
    lines.push(`Imported: ${date}`)
  }

  return lines.join('\n')
}

/**
 * 格式化成员列表为纯文本
 */
export function formatMembersAsText(members: Array<{
  platformId: string
  name?: string
  role?: string
  messageCount?: number
}>): string {
  if (members.length === 0) return 'No members found.'

  const lines: string[] = [`Total ${members.length} members:`, '']

  for (let i = 0; i < members.length; i++) {
    const m = members[i]
    const displayName = m.name || m.platformId
    const role = m.role ? ` [${m.role}]` : ''
    const msgCount = m.messageCount !== undefined ? ` (${m.messageCount} messages)` : ''
    lines.push(`${i + 1}. ${displayName}${role}${msgCount}`)
  }

  return lines.join('\n')
}

/**
 * 格式化统计概览为纯文本
 */
export function formatStatsOverviewAsText(stats: {
  messageCount: number
  memberCount: number
  timeRange?: { start: number; end: number }
  messageTypeDistribution?: Record<string, number>
  topMembers?: Array<{ platformId: string; name: string; messageCount: number; percentage: number }>
}): string {
  const lines: string[] = [
    '=== Chat Statistics ===',
    '',
    `Total Messages: ${stats.messageCount}`,
    `Total Members: ${stats.memberCount}`,
  ]

  if (stats.timeRange) {
    const start = new Date(stats.timeRange.start * 1000).toLocaleDateString('zh-CN')
    const end = new Date(stats.timeRange.end * 1000).toLocaleDateString('zh-CN')
    lines.push(`Time Range: ${start} ~ ${end}`)
  }

  if (stats.messageTypeDistribution && Object.keys(stats.messageTypeDistribution).length > 0) {
    lines.push('')
    lines.push('Message Types:')
    for (const [type, count] of Object.entries(stats.messageTypeDistribution)) {
      lines.push(`  ${type}: ${count}`)
    }
  }

  if (stats.topMembers && stats.topMembers.length > 0) {
    lines.push('')
    lines.push('Top Members:')
    for (let i = 0; i < stats.topMembers.length; i++) {
      const m = stats.topMembers[i]
      lines.push(`  ${i + 1}. ${m.name}: ${m.messageCount} (${m.percentage}%)`)
    }
  }

  return lines.join('\n')
}
