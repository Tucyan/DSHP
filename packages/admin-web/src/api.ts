let csrf = ''
export function setCsrf(value: string) { csrf = value }
export class ApiError extends Error { constructor(readonly status: number, readonly code: string) { super(code) } }
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal })
  const result = await response.json()
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('admin-unauthorized'))
    throw new ApiError(response.status, result.code ?? result.error?.code ?? 'request_failed')
  }
  return result as T
}
export function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 409) return '内容已被其他操作更新，或任务正在执行。请刷新后重试。'
    if (error.status === 401) return '登录已失效，请重新输入 Token。'
    if (error.status === 429) return '请求过于频繁，请稍后再试。'
    if (error.status === 400) return '输入不符合要求，请检查字段内容。'
    if (error.status === 403) return '请求未通过安全校验，请刷新页面重新登录。'
    if (error.status === 404) return '内容不存在或已归档。'
    return '操作失败，请查看诊断记录。'
  }
  return '无法连接本地 Agent，请检查进程是否仍在运行。'
}
