// 科诺美线索系统 API - users（账号清单，仅 admin 只读）
// 编辑走配置变更（本期不做在线账号管理）；pwdHash 绝不下发。
import { getStore } from "@edgeone/pages-blob";
import { optionsResp, json, unauthorized, authHeaders, requireAuth, loadUsers } from './_auth.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResp();

  const auth = await requireAuth(request, env);
  if (!auth) return unauthorized();
  const xh = authHeaders(auth);

  if (request.method !== 'GET') {
    return json({ ok: false, error: 'Method not allowed' }, 405, xh);
  }
  if (auth.user.role !== 'admin') {
    return json({ ok: false, error: 'forbidden' }, 403, xh);
  }

  const store = getStore('chromai-leads');
  const users = await loadUsers(store);
  return json({
    users: users.map(u => ({
      email: u.email,
      name: u.name,
      role: u.role,
      region: u.region || null,
      subordinates: u.subordinates || []
    }))
  }, 200, xh);
}
