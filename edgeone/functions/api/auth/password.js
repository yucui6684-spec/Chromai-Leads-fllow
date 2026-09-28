// 科诺美线索系统 API - auth/password（修改密码 / 管理员重置密码）
// POST body:
//   本人改密：{ currentPassword, newPassword }        —— 需验证原密码；
//   管理员重置：{ targetEmail, newPassword }          —— 仅 admin，无需原密码；
// 规则：新密码 ≥ 6 位、不得与原密码相同；写回 users blob；全部服务端强制 + 审计日志。
import { getStore } from "@edgeone/pages-blob";
import { optionsResp, json, unauthorized, authHeaders, requireAuth, loadUsers, sha256, getIp } from '../_auth.js';
import { appendLog } from '../_log.js';

const MIN_PWD_LEN = 6;

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResp();
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const auth = await requireAuth(request, env);
  if (!auth) return unauthorized();
  const user = auth.user;
  const xh = authHeaders(auth);

  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const newPassword = String(body.newPassword || '');
  const currentPassword = String(body.currentPassword || '');
  const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
  const ip = getIp(request);

  if (newPassword.length < MIN_PWD_LEN) {
    return json({ ok: false, error: '新密码长度至少 ' + MIN_PWD_LEN + ' 位' }, 400, xh);
  }

  const store = getStore('chromai-leads');
  const users = await loadUsers(store);

  const selfEmail = (user.email || '').toLowerCase();
  const isReset = !!targetEmail && targetEmail !== selfEmail;
  let target;

  if (isReset) {
    // 重置他人密码：仅 admin
    if (user.role !== 'admin') {
      await appendLog(store, {
        email: user.email, name: user.name, role: user.role, event: 'forbidden',
        objectType: 'user', objectId: targetEmail,
        detail: '非管理员尝试重置他人密码', result: 'fail', ip: ip
      });
      return json({ ok: false, error: 'forbidden', message: '只有管理员可以重置他人密码' }, 403, xh);
    }
    target = users.find(u => (u.email || '').toLowerCase() === targetEmail);
    if (!target) return json({ ok: false, error: '目标账号不存在' }, 404, xh);
  } else {
    // 修改本人密码：必须验证原密码
    target = users.find(u => (u.email || '').toLowerCase() === selfEmail);
    if (!target) return json({ ok: false, error: '账号不存在' }, 404, xh);
    const curHash = await sha256(selfEmail + ':' + currentPassword);
    if (target.pwdHash !== curHash) {
      await appendLog(store, {
        email: user.email, name: user.name, role: user.role, event: 'update',
        objectType: 'user', objectId: selfEmail,
        detail: '修改密码失败（原密码错误）', result: 'fail', ip: ip
      });
      return json({ ok: false, error: '原密码错误' }, 401, xh);
    }
  }

  // 新密码与原密码相同 → 拒绝
  const newHash = await sha256(target.email.toLowerCase() + ':' + newPassword);
  if (target.pwdHash === newHash) {
    return json({ ok: false, error: '新密码不能与原密码相同' }, 400, xh);
  }

  target.pwdHash = newHash;
  try {
    await store.set('users', JSON.stringify({ users: users }));
  } catch (e) {
    return json({ ok: false, error: '保存失败，请稍后重试' }, 500, xh);
  }

  await appendLog(store, {
    email: user.email, name: user.name, role: user.role, event: 'update',
    objectType: 'user', objectId: target.email,
    detail: isReset ? ('管理员重置 ' + target.name + ' 的密码') : ('本人修改密码'),
    result: 'success', ip: ip
  });

  return json({ ok: true, target: target.email, reset: isReset }, 200, xh);
}
