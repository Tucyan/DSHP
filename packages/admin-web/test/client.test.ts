import { describe, expect, it } from 'vitest'
import { date, mergeEvents, normalizeModelSelection, promptDifference, safeMessage } from '../src/model.js'
describe('admin presentation model', () => {
  it('formats native DSH numeric timestamps as well as ISO strings', () => {
    const timestamp = Date.parse('2026-09-07T12:00:00Z')
    expect(date(timestamp)).toBe(date('2026-09-07T12:00:00Z'))
    expect(date(timestamp)).not.toBe('暂无')
    expect(date(undefined)).toBe('暂无')
    expect(date('invalid')).toBe('暂无')
  })
  it('merges incremental events without duplicates, preserving sequence order', () => {
    expect(mergeEvents([{ seq: 2, type: 'assistant/message' }], [{ seq: 1, type: 'user/message' }, { seq: 2, type: 'assistant/message' }]).map(event => event.seq)).toEqual([1, 2])
  })
  it('extracts only returned plain text instead of rendering injected HTML or images', () => {
    expect(safeMessage({ seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '<script>bad</script>' }, { type: 'image', url: 'https://remote/track' }] } })).toBe('<script>bad</script>')
    expect(safeMessage({ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply' }] } } })).toBe('reply')
  })
  it('shows old and new prompt lines without claiming unchanged text is modified', () => {
    expect(promptDifference('a\nb', 'a\nc')).toEqual([{ before: 'b', after: 'c', line: 2 }])
  })
  it('normalizes model settings without accepting blank identifiers', () => {
    expect(normalizeModelSelection({ provider: ' deepseek-official ', model: ' deepseek-v4.1-flash-expires-on-0910 ', reasoningEffort: ' high ' })).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash-expires-on-0910', reasoningEffort: 'high' })
    expect(normalizeModelSelection({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: '   ' })).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(() => normalizeModelSelection({ provider: ' ', model: 'deepseek-chat', reasoningEffort: '' })).toThrow('模型提供方和模型 ID 不能为空')
  })
})
