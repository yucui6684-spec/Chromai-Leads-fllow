// 科诺美线索系统 API - mql（MQL评分标准配置）
// GET：所有登录用户可读（不过滤）；POST：仅 admin 可写，触达 meta.scopeModified.cfg。
import { getStore } from "@edgeone/pages-blob";
import { optionsResp, json, unauthorized, authHeaders, requireAuth, getIp } from './_auth.js';
import { touchScopeModified } from './_acl.js';
import { appendLog } from './_log.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResp();

  const store = getStore('chromai-leads');
  const auth = await requireAuth(request, env);
  if (!auth) return unauthorized();
  const user = auth.user;
  const xh = authHeaders(auth);

  if (request.method === 'GET') {
    try {
      const data = await store.get('mql', { type: 'json', consistency: 'strong' });
      return json(data ? data : { data: null }, 200, xh);
    } catch (e) {
      return json({ data: null, error: e.message }, 200, xh);
    }
  }

  if (request.method === 'POST') {
    if (user.role !== 'admin') {
      await appendLog(store, {
        email: user.email, name: user.name, role: user.role, event: 'forbidden',
        objectType: 'session', detail: '尝试写入MQL评分配置（仅管理员）',
        result: 'fail', ip: getIp(request)
      });
      return json({ ok: false, error: 'forbidden', violations: [{ id: 'mql', field: '*', reason: '仅管理员可修改评分配置' }] }, 403, xh);
    }
    try {
      const body = await request.json();
      await store.set('mql', JSON.stringify(body));
      await touchScopeModified(store, [], { cfg: true });
      return json({ ok: true }, 200, xh);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500, xh);
    }
  }

  return json({ error: 'Method not allowed' }, 405, xh);
}
