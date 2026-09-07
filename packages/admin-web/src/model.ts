interface ContentBlock { type: string; text?: string; [key: string]: unknown }
export interface SessionEvent { seq: number; type: string; time?: string | number; data?: { content?: ContentBlock[]; message?: { content?: ContentBlock[] }; [key: string]: unknown } }
export function mergeEvents(previous: SessionEvent[], incoming: SessionEvent[]) { return [...new Map([...previous, ...incoming].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq) }
export function safeMessage(event: SessionEvent) {
  const content = event.type === 'user/message' ? event.data?.content : event.data?.message?.content
  return content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? ''
}
export function promptDifference(before: string, after: string) {
  const a = before.split('\n'); const b = after.split('\n')
  return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => ({ before: a[i] ?? '', after: b[i] ?? '', line: i + 1 })).filter(row => row.before !== row.after)
}
export function date(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return '暂无'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : '暂无'
}
export const labels: Record<string, string> = { running: '运行中', starting: '启动中', stopping: '正在停止', stopped: '已停止', ready: '已连接', connecting: '连接中', unknown: '未知', error: '异常', completed: '已完成', failed: '失败', denied: '策略阻止', duplicate: '重复触发', foreground: '前台', background: '后台', preferences: '偏好', contexts: '长期上下文', decisions: '重要决策', events: '关键事件', archive: '归档', normal: '普通', high: '高', low: '低', quiet_hours: '安静时段', cooldown: '冷却中', daily_cap: '今日联系已达上限' }
export const label = (value: unknown) => labels[String(value)] ?? String(value ?? '暂无')
