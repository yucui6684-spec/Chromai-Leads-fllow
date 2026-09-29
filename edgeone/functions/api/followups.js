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

      // ---- admin 整表替换通道（列改名 / 删列专用；显式确认 + 全量覆盖）----
      // 背景：_acl.js 的 unionHeaders 是「旧表头全保留 + 新表头追加」的并集语义
      //      （设计上用于防止前端误删列丢数据，是正确的，不可改动），
      //      因此常规 POST 永远无法完成「列改名 / 删列」——改名只会追加新列。
      // 本分支是管理员唯一的整表覆盖入口：不 diff、不 merge，直接用 body 的
      // headers + data 覆盖 followups，写入前保留快照，可回滚到上一版本。
      //
      // 安全约束（任一不满足即 return，绝不落到下方 diff/merge 主流程，且不写任何数据）：
      //   1) 仅 admin；2) replaceAll === true；3) confirmReplace === true；
      //   4) headers/data 均为数组且 headers 非空；5) headers 必须含主键列「跟进编号」；
      //   6) 传入 expectRows/expectCols 时行数/列数必须精确匹配（防前端旧快照误覆盖）。
      //
      // 扩展提示：给 leads 加同样通道时整段照抄即可，仅需把 store key 改 'leads'、
      // objectType 改 'lead'、主键常量改 H.LEAD_ID，并改用 leads 的 touch 逻辑。
      if (body.replaceAll === true) {
        // 1) 角色门禁（非管理员即使带 replaceAll 也在此终止）
        if (user.role !== 'admin') {
          return json({ ok: false, error: 'forbidden', message: '整表替换仅管理员可用' }, 403, xh);
        }
        // 2) 显式二次确认（防误触 / 防自动化脚本静默覆盖）
        if (body.confirmReplace !== true) {
          return json({ ok: false, error: 'replace_confirm_required', message: '整表替换需显式确认 confirmReplace:true' }, 403, xh);
        }
        // 3) 载荷结构校验（整表替换不接受部分提交）
        if (!Array.isArray(body.headers) || !Array.isArray(body.data) || body.headers.length === 0) {
          return json({ ok: false, error: 'bad_request', message: 'replaceAll 必须提供完整的 headers 与 data' }, 400, xh);
        }
        // 4) 主键列校验（缺失将导致后续 diff/权限判定无法定位行身份，直接拒绝）
        if (body.headers.indexOf(String(H.FUP_ID)) < 0) {
          return json({ ok: false, error: 'bad_request', message: 'headers 缺少主键列「跟进编号」' }, 400, xh);
        }
        // 5) 行数自校验（调用方传了 expectRows 才校验；不传则不校验）
        if (typeof body.expectRows === 'number' && body.data.length !== body.expectRows) {
          return json({
            ok: false, error: 'row_count_mismatch',
            expect: body.expectRows, actual: body.data.length,
            message: '行数与预期不符，已拒绝写入'
          }, 409, xh);
        }
        // 6) 列数自校验（与行数同形式；error 保持同名以兼容调用方统一判定）
        if (typeof body.expectCols === 'number' && body.headers.length !== body.expectCols) {
          return json({
            ok: false, error: 'row_count_mismatch',
            expect: body.expectCols, actual: body.headers.length,
            message: '列数与预期不符，已拒绝写入'
          }, 409, xh);
        }

        // 写入前保留旧全量快照（上一版本 + 当日初始状态），备份失败不阻断写入
        await snapshotBeforeWrite(store, 'followups', old, user);
        await store.set('followups', JSON.stringify({ headers: body.headers, data: body.data }));
        await purgeOldBackups(store);
        // 整表替换影响全量：owner/region 留空 → 仅触达 admin 分片，并同步 fupsCount
        await touchScopeModified(store, [{ owner: '', region: '' }], { fupsCount: body.data.length });
        await appendLog(store, {
          email: user.email, name: user.name, role: user.role, event: 'restore',
          objectType: 'fup', objectId: '', result: 'success', ip: getIp(request),
          detail: 'admin 整表替换：' + body.data.length + ' 行 / ' + body.headers.length + ' 列'
            + '（原 ' + ((old.data || []).length) + ' 行 / ' + ((old.headers || []).length) + ' 列）'
        });
        return json({
          ok: true, count: body.data.length, replaced: true,
          before: { rows: (old.data || []).length, cols: (old.headers || []).length }
        }, 200, xh);
      }

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
        checked.creates.forEach(c => entries.push(Object.assign({}, base, {
          event: 'create', objectId: c.id,
          // 前端编号撞车时服务端会重新分配编号保存（防静默丢失），此处留痕便于排查
          detail: c.renamedFrom ? ('前端提交编号 ' + c.renamedFrom + ' 与已有记录重复，服务端已改分配为 ' + c.id.toUpperCase()) : ''
        })));
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
