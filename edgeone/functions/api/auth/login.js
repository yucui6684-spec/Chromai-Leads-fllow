// 科诺美线索系统 API - auth/login（邮箱+密码登录，签发 HMAC token）
// 失败统一 401「邮箱或密码错误」（不区分邮箱不存在/密码错）；
// 登录成功/失败均由服务端直接写审计日志（防漏报）。
import { getStore } from "@edgeone/pages-blob";
import { optionsResp, json, sha256, signToken, loadUsers, getIp } from '../_auth.js';
import { appendLog } from '../_log.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResp();

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const store = getStore('chromai-leads');
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const ip = getIp(request);

  const users = await loadUsers(store);
  const user = users.find(u => (u.email || '').toLowerCase() === email);
  const pwdHash = await sha256(email + ':' + password);

  if (!user || user.pwdHash !== pwdHash) {
    await appendLog(store, {
      email: email, name: '', role: '', event: 'login_failed',
      objectType: 'session', result: 'fail', ip: ip
    });
    return json({ ok: false, error: '邮箱或密码错误' }, 401);
  }

  const token = await signToken(user, env);
  await appendLog(store, {
    email: user.email, name: user.name, role: user.role, event: 'login_success',
    objectType: 'session', result: 'success', ip: ip
  });
  return json({
    ok: true,
    token: token,
    user: { email: user.email, name: user.name, role: user.role, region: user.region || null }
  }, 200);
}
