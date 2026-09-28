// 科诺美线索系统 API - backup（服务端数据快照管理，仅管理员）
// GET  ?type=leads|followups        列出可用备份（key/时间/条数/操作人）
// POST { key, confirm:true }         将指定快照整份恢复回主数据（覆盖式，需显式确认）
//
// 说明：备份由 leads/followups 写入前自动生成（_backup.js），本端点只提供「查看 + 恢复」，
// 恢复为 admin 专属且写审计日志，用于异常同步/误操作后的整体回滚。

import { getStore } from "@edgeone/pages-blob";
import { optionsResp, json, unauthorized, authHeaders, requireAuth, getIp } from './_auth.js';
import { appendLog } from './_log.js';
import { touchScopeModified } from './_acl.js';
import { listBackups } from './_backup.js';

const VALID_TYPES = ['leads', 'followups'];

function typeOfKey(key) {
  if (typeof key !== 'string') return '';
  const m = /^backup\/(leads|followups)\//.exec(key);
  return m ? m[1] : '';
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResp();

  const store = getStore('chromai-leads');
  const auth = await requireAuth(request, env);
  if (!auth) return unauthorized();
  const user = auth.user;
  const xh = authHeaders(auth);

  if (user.role !== 'admin') {
    await appendLog(store, {
      email: user.email, name: user.name, role: user.role, event: 'forbidden',
      objectType: 'backup', objectId: '', detail: '非管理员访问备份管理接口',
      result: 'fail', ip: getIp(request)
    });
    return json({ ok: false, error: 'forbidden', message: '仅管理员可管理数据备份' }, 403, xh);
  }

  if (request.method === 'GET') {
    try {
      const url = new URL(request.url);
      const type = url.searchParams.get('type') || 'leads';
      if (VALID_TYPES.indexOf(type) < 0) return json({ ok: false, error: 'bad_type' }, 400, xh);
      const items = await listBackups(store, type);
      return json({ ok: true, type: type, items: items }, 200, xh);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500, xh);
    }
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const key = body.key;
      const type = typeOfKey(key);
      if (!type) return json({ ok: false, error: 'bad_key', message: '备份 key 非法' }, 400, xh);
      if (body.confirm !== true) {
        return json({ ok: false, error: 'confirm_required',
          message: '恢复为覆盖式操作，请显式传 confirm:true 后重试' }, 403, xh);
      }
      const snap = await store.get(key, { type: 'json', consistency: 'strong' });
      if (!snap || !Array.isArray(snap.data) || snap.data.length === 0) {
        return json({ ok: false, error: 'not_found', message: '备份不存在或为空' }, 404, xh);
      }
      const payload = { headers: snap.headers || [], data: snap.data };
      await store.set(type, JSON.stringify(payload));
      await touchScopeModified(store, [], type === 'leads'
        ? { leadsCount: payload.data.length }
        : { fupsCount: payload.data.length });

      await appendLog(store, {
        email: user.email, name: user.name, role: user.role, event: 'restore',
        objectType: type === 'leads' ? 'lead' : 'fup', objectId: key,
        detail: '从备份 ' + key + ' 恢复 ' + payload.data.length + ' 条记录（快照时间 ts=' + (snap.ts || 0) + '）',
        result: 'success', ip: getIp(request)
      });

      return json({ ok: true, type: type, key: key, restored: payload.data.length,
        snapshotTs: snap.ts || 0 }, 200, xh);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500, xh);
    }
  }

  return json({ error: 'Method not allowed' }, 405, xh);
}
