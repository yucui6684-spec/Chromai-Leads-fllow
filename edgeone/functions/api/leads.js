// 科诺美线索系统 API - leads（线索池）
// GET：鉴权 + 按角色行级过滤（只裁剪 data 行，headers 原样返回）。
// POST：服务端按行身份合并写回（前端「全量加载+全量覆盖」协议不变）——
//   读旧全量 → 以旧数据判定可见集 → diff 入参子集 → 字段锁定/越权校验 → 合并回全量 →
//   触达 meta.scopeModified → 服务端生成审计日志。任一候选行越权 → 整体原子拒绝 403。
import { getStore } from "@edgeone/pages-blob";
import { optionsResp, json, unauthorized, authHeaders, requireAuth, getIp } from './_auth.js';
import { diffDataset, checkWritePerm, mergeDataset, filterLeads, touchScopeModified } from './_acl.js';
import { appendLogs, appendLog } from './_log.js';
import { snapshotBeforeWrite, purgeOldBackups } from './_backup.js';
import { IMPORT_THRESHOLD, BULK_DELETE_THRESHOLD } from './_config.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResp();

  const store = getStore('chromai-leads');
  const auth = await requireAuth(request, env);
  if (!auth) return unauthorized();
  const user = auth.user;
  const xh = authHeaders(auth);

  if (request.method === 'GET') {
    try {
      const data = await store.get('leads', { type: 'json', consistency: 'strong' });
      // store.get 返回 null（key 不存在）属合法空，返回 200 空数据
      const filtered = data ? filterLeads(user, data) : { data: [], headers: [] };
      return json(filtered, 200, xh);
    } catch (e) {
      // 存储异常必须返回 5xx（严禁伪装成 200 空数据，防止前端误判为“服务器无数据”）
      return json({ data: null, headers: null, ok: false, error: 'storage_error', detail: e.message }, 500, xh);
    }
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const old = (await store.get('leads', { type: 'json', consistency: 'strong' })) || { headers: [], data: [] };
      const d = diffDataset(user, old, body, 'lead');
      const checked = checkWritePerm(user, d, 'lead');

      if (checked.violations.length) {
        await appendLog(store, {
          email: user.email, name: user.name, role: user.role, event: 'forbidden',
          objectType: 'lead', objectId: checked.violations.map(v => v.id).slice(0, 5).join(','),
          result: 'fail', ip: getIp(request)
        });
        return json({ ok: false, error: 'forbidden', violations: checked.violations }, 403, xh);
      }

      // 批量删除保护：单次删除 ≥ 阈值必须显式确认（body.confirmBulkDelete === true）。
      // 前端仅在用户主动执行删除/批量删除时设置该标记；自动同步/旧快照全量覆盖一律不带 → 拒绝。
      if (checked.deletes.length >= BULK_DELETE_THRESHOLD && body.confirmBulkDelete !== true) {
        await appendLog(store, {
          email: user.email, name: user.name, role: user.role, event: 'forbidden',
          objectType: 'lead', objectId: '',
          detail: '单次删除 ' + checked.deletes.length + ' 条线索未确认，已被批量删除保护拦截',
          result: 'fail', ip: getIp(request)
        });
        return json({
          ok: false, error: 'bulk_delete_confirm_required',
          deletes: checked.deletes.length, threshold: BULK_DELETE_THRESHOLD,
          message: '单次删除 ' + checked.deletes.length + ' 条线索需显式确认，请通过删除/批量删除按钮重新操作'
        }, 403, xh);
      }

      const merged = mergeDataset(old, d, checked, 'lead');
      // 写入前保留旧全量快照（上一版本 + 当日初始状态），备份失败不阻断写入
      await snapshotBeforeWrite(store, 'leads', old, user);
      await store.set('leads', JSON.stringify(merged));
      await purgeOldBackups(store);
      await touchScopeModified(store, checked.touches, { leadsCount: merged.data.length });

      // 审计日志（服务端生成，防前端漏报）；单次新增 ≥10 行聚合为一条 import
      const ip = getIp(request);
      const base = { email: user.email, name: user.name, role: user.role, objectType: 'lead', result: 'success', ip: ip };
      const entries = [];
      if (checked.creates.length >= IMPORT_THRESHOLD) {
        entries.push(Object.assign({}, base, { event: 'import', objectId: '', detail: '批量新增 ' + checked.creates.length + ' 条线索' }));
      } else {
        checked.creates.forEach(c => entries.push(Object.assign({}, base, { event: 'create', objectId: c.id })));
      }
      checked.updates.forEach(u => entries.push(Object.assign({}, base, { event: 'update', objectId: u.id, diff: u.diff })));
      checked.deletes.forEach(del => entries.push(Object.assign({}, base, { event: 'delete', objectId: del.id })));
      await appendLogs(store, entries);

      return json({
        ok: true, count: merged.data.length,
        created: checked.creates.length, updated: checked.updates.length, deleted: checked.deletes.length
      }, 200, xh);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500, xh);
    }
  }

  return json({ error: 'Method not allowed' }, 405, xh);
}
