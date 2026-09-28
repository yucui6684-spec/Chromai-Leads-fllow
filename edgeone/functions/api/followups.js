// 科诺美线索系统 API - followups（跟进记录 / MQLs）
// GET：鉴权 + 按角色过滤（主规则按线索编号关联 leads 继承归属，兜底按行内负责人）。
// POST：与 leads 同语义的服务端合并写回 + 字段锁定 + 越权原子拒绝 + 审计日志。
//   fups 行归属判定需关联 leads（每次 POST = 2 次 Blob 读 + 1 次写，O(n) 内存操作）。
import { getStore } from "@edgeone/pages-blob";
import { optionsResp, json, unauthorized, authHeaders, requireAuth, getIp } from './_auth.js';
import { diffDataset, checkWritePerm, mergeDataset, filterFollowups, buildLeadIndex, touchScopeModified } from './_acl.js';
import { appendLogs, appendLog } from './_log.js';
import { snapshotBeforeWrite, purgeOldBackups } from './_backup.js';
import { IMPORT_THRESHOLD, BULK_DELETE_THRESHOLD, regionOfMember, H } from './_config.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResp();

  const store = getStore('chromai-leads');
  const auth = await requireAuth(request, env);
  if (!auth) return unauthorized();
  const user = auth.user;
  const xh = authHeaders(auth);

  if (request.method === 'GET') {
    try {
      const [fups, leads] = await Promise.all([
        store.get('followups', { type: 'json', consistency: 'strong' }),
        store.get('leads', { type: 'json', consistency: 'strong' })
      ]);
      const filtered = fups ? filterFollowups(user, fups, leads) : { data: [], headers: [] };
      return json(filtered, 200, xh);
    } catch (e) {
      // 存储异常必须返回 5xx（严禁伪装成 200 空数据，防止前端误判为“服务器无数据”）
      return json({ data: null, headers: null, ok: false, error: 'storage_error', detail: e.message }, 500, xh);
    }
  }

  if (request.method === 'POST') {
    try {
      // request.json() 可能返回 null / 数组 / 标量（JSON 字面量 `null`、`"x"`、`123`）；
      // 下游一律按对象取值（body.headers / body.data / body.confirmBulkDelete / body.replaceAll），
      // 故在此统一归一为对象，避免 undefined 解引用与非对象属性访问异常。
      const raw = await request.json();
      const body = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
      const [oldFups, leads] = await Promise.all([
        store.get('followups', { type: 'json', consistency: 'strong' }),
        store.get('leads', { type: 'json', consistency: 'strong' })
      ]);
      const old = oldFups || { headers: [], data: [] };
      const leadIdx = buildLeadIndex(leads);
      const d = diffDataset(user, old, body, 'fup', leadIdx);
      const checked = checkWritePerm(user, d, 'fup', leadIdx);

      if (checked.violations.length) {
        await appendLog(store, {
          email: user.email, name: user.name, role: user.role, event: 'forbidden',
          objectType: 'fup', objectId: checked.violations.map(v => v.id).slice(0, 5).join(','),
          detail: checked.violations.slice(0, 3).map(v => v.id + '：' + (v.reason || '越权')).join('；'),
          result: 'fail', ip: getIp(request)
        });
        return json({ ok: false, error: 'forbidden', violations: checked.violations }, 403, xh);
      }

      // 批量删除保护：单次删除 ≥ 阈值必须显式确认（body.confirmBulkDelete === true）。
      if (checked.deletes.length >= BULK_DELETE_THRESHOLD && body.confirmBulkDelete !== true) {
        await appendLog(store, {
          email: user.email, name: user.name, role: user.role, event: 'forbidden',
          objectType: 'fup', objectId: '',
          detail: '单次删除 ' + checked.deletes.length + ' 条跟进记录未确认，已被批量删除保护拦截',
          result: 'fail', ip: getIp(request)
        });
        return json({
          ok: false, error: 'bulk_delete_confirm_required',
          deletes: checked.deletes.length, threshold: BULK_DELETE_THRESHOLD,
          message: '单次删除 ' + checked.deletes.length + ' 条跟进记录需显式确认，请通过删除/批量删除按钮重新操作'
        }, 403, xh);
      }

      const merged = mergeDataset(old, d, checked, 'fup');
      // 写入前保留旧全量快照（上一版本 + 当日初始状态），备份失败不阻断写入
      await snapshotBeforeWrite(store, 'followups', old, user);
      await store.set('followups', JSON.stringify(merged));
      await purgeOldBackups(store);
      // fups 行无大区列：按负责人反查所属大区，补齐 R: 分片触达（大区总轮询可感知）
      const touches = checked.touches.map(t => ({
        owner: t.owner, region: t.region || regionOfMember(t.owner)
      }));
      await touchScopeModified(store, touches, { fupsCount: merged.data.length });

      const ip = getIp(request);
      const base = { email: user.email, name: user.name, role: user.role, objectType: 'fup', result: 'success', ip: ip };
      const entries = [];
      if (checked.creates.length >= IMPORT_THRESHOLD) {
        entries.push(Object.assign({}, base, { event: 'import', objectId: '', detail: '批量新增 ' + checked.creates.length + ' 条跟进记录' }));
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
