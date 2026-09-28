// 科诺美线索系统 API - logs（审计日志）
// GET：仅 admin，支持 from/to/email/event 筛选 + 分页（按 ts 倒序）。
// POST：仅放行 session 级事件（logout/export），身份一律取自 token（忽略 body 身份字段，防伪造）。
import { getStore } from "@edgeone/pages-blob";
import { optionsResp, json, unauthorized, authHeaders, requireAuth, getIp } from './_auth.js';
import { SESSION_EVENTS } from './_config.js';
import { appendLog, queryLogs } from './_log.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResp();

  const store = getStore('chromai-leads');
  const auth = await requireAuth(request, env);
  if (!auth) return unauthorized();
  const user = auth.user;
  const xh = authHeaders(auth);

  if (request.method === 'GET') {
    if (user.role !== 'admin') {
      return json({ ok: false, error: 'forbidden' }, 403, xh);
    }
    const url = new URL(request.url);
    const result = await queryLogs(store, {
      from: url.searchParams.get('from') || '',
      to: url.searchParams.get('to') || '',
      email: url.searchParams.get('email') || '',
      event: url.searchParams.get('event') || '',
      page: url.searchParams.get('page') || '1',
      pageSize: url.searchParams.get('pageSize') || '50'
    });
    return json(result, 200, xh);
  }

  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) { body = {}; }
    const event = body && body.event;
    if (SESSION_EVENTS.indexOf(event) < 0) {
      return json({ ok: false, error: 'event not allowed' }, 403, xh);
    }
    await appendLog(store, {
      email: user.email, name: user.name, role: user.role, event: event,
      objectType: 'session', result: 'success', ip: getIp(request)
    });
    return json({ ok: true }, 200, xh);
  }

  return json({ error: 'Method not allowed' }, 405, xh);
}
