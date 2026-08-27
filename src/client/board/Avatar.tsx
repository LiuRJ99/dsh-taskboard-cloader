/**
 * SVG avatar with model / user initials and branded gradient backgrounds.
 *
 * @module dsh-taskboard/client/board/Avatar
 */
import { useId } from 'react'

/** Pick a branded or deterministic gradient pair for the given model/user key. */
function getAvatarGradient(key: string, isUser = false): [string, string] {
  if (isUser) {
    return ['#64748b', '#475569'] // Slate
  }
  const lower = key.toLowerCase()
  if (lower.includes('deepseek')) return ['#3b82f6', '#7c3aed']
  if (lower.includes('claude') || lower.includes('anthropic')) return ['#ea580c', '#c2410c']
  if (lower.includes('gpt') || lower.includes('openai') || lower.startsWith('o1') || lower.startsWith('o3')) return ['#10b981', '#059669']
  if (lower.includes('gemini') || lower.includes('google')) return ['#2563eb', '#9333ea']
  if (lower.includes('qwen') || lower.includes('qianwen') || lower.includes('aliyun')) return ['#6366f1', '#3b82f6']
  if (lower.includes('kimi') || lower.includes('moonshot')) return ['#06b6d4', '#0284c7']
  if (lower.includes('glm') || lower.includes('zhipu')) return ['#3b82f6', '#1d4ed8']
  if (lower.includes('mistral')) return ['#f59e0b', '#ef4444']
  if (lower.includes('llama') || lower.includes('meta')) return ['#3b82f6', '#06b6d4']

  const PALETTES: [string, string][] = [
    ['#8b5cf6', '#6d28d9'],
    ['#ec4899', '#be185d'],
    ['#06b6d4', '#0f766e'],
    ['#3b82f6', '#1e40af'],
    ['#10b981', '#047857'],
    ['#f59e0b', '#b45309'],
  ]
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i)
    hash |= 0
  }
  return PALETTES[Math.abs(hash) % PALETTES.length]!
}

/** Extract a clean single-character initial for display. */
export function getInitial(name?: string, isUser = false): string {
  if (isUser) return 'U'
  if (!name) return 'A'
  const match = name.match(/[a-zA-Z0-9]/)
  return match ? match[0]!.toUpperCase() : 'A'
}

export function InitialAvatar({
  name,
  isUser = false,
  size = 26,
  className,
}: {
  name?: string
  isUser?: boolean
  size?: number
  className?: string
}) {
  const rawId = useId()
  const gradId = `atb-avt-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const initial = getInitial(name, isUser)
  const [color1, color2] = getAvatarGradient(name ?? (isUser ? 'user' : 'agent'), isUser)
  const title = isUser ? '用户' : (name ? `模型：${name}` : 'Agent')

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label={title}
    >
      <title>{title}</title>
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={color1} />
          <stop offset="100%" stopColor={color2} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gradId})`} />
      <rect width="32" height="32" rx="8" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
      <text
        x="50%"
        y="52%"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#ffffff"
        fontSize="16"
        fontWeight="700"
        fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        style={{ userSelect: 'none' }}
      >
        {initial}
      </text>
    </svg>
  )
}
