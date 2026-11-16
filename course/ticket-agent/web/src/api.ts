// 所有请求都带 Cookie（credentials: 'include'），身份由服务端会话决定。
// 前端从不传 userId/tenantId 给业务接口，传了服务端也不信。
export interface Me {
  id: string;
  name: string;
  tenantId: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `请求失败（${res.status}）`);
  return data as T;
}

export const api = {
  users: () => request<Array<{ id: string; name: string }>>('/api/users'),
  login: (userId: string) => request<Me>('/api/login', { userId }),
  me: () => request<Me>('/api/me'),
  createRun: (question: string) => request<{ runId: string }>('/api/runs', { question }),
  approve: (runId: string, callId: string, approved: boolean) => request(`/api/runs/${runId}/approvals`, { callId, approved }),
  cancel: (runId: string) => request(`/api/runs/${runId}/cancel`, {}),
};
