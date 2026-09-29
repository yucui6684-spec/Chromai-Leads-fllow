// 科诺美线索系统 - 共享授权模块（行级可见性过滤 / diff / 服务端合并写回 / 字段锁定）
//
// 核心原则：
// 1. 列定位一律按表头名（用户可增删自定义列，禁止硬编码列索引）。
// 2. 前端是「全量加载 + 全量 POST 覆盖」协议；GET 过滤后前端只持有可见子集，
//    因此 POST 必须「读旧全量 → 以旧数据判定可见集 → diff 入参子集 → 校验 → 合并回全量」，
//    调用者不可见的行永远以服务端旧值为准，绝不被覆盖。
// 3. 行身份 = 编号列 trim().toLowerCase()；headers 合并 = 并集保序；行级 last-write-wins。

import { H, FALLBACK, regionMembers } from './_config.js';

// 与前端 leadCol/fupCol 同语义：按表头名定位列索引
export function colIndex(headers, name, fallback) {
  if (!Array.isArray(headers)) return fallback;
  const i = headers.indexOf(name);
  return i >= 0 ? i : fallback;
}

function cell(row, i) {
  if (!Array.isArray(row) || i < 0 || i >= row.length || row[i] == null) return '';
  return String(row[i]);
}

export function leadId(row, hd)     { return cell(row, colIndex(hd, H.LEAD_ID, FALLBACK.LEAD_ID)); }
export function leadOwner(row, hd)  { return cell(row, colIndex(hd, H.LEAD_OWNER, FALLBACK.LEAD_OWNER)); }
export function leadRegion(row, hd) { return cell(row, colIndex(hd, H.LEAD_REGION, FALLBACK.LEAD_REGION)); }
export function fupId(row, hd)      { return cell(row, colIndex(hd, H.FUP_ID, FALLBACK.FUP_ID)); }
export function fupLeadId(row, hd)  { return cell(row, colIndex(hd, H.FUP_LEAD_ID, FALLBACK.FUP_LEAD_ID)); }
export function fupOwner(row, hd)   { return cell(row, colIndex(hd, H.FUP_OWNER, FALLBACK.FUP_OWNER)); }

// ---- 行归属判定 ----
// admin 全量；region：负责大区 == 本人姓名；sales：负责人 == 本人姓名；
// 未分配（负责人/负责大区为空）自然不满足 region/sales 条件 → 仅 admin 可见。
export function visibleLead(user, row, headers) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'region') return leadRegion(row, headers) === (user.region || user.name);
  if (user.role === 'sales') return leadOwner(row, headers) === user.name;
  return false;
}

// GET /api/leads 过滤：只裁剪 data 行，headers 原样返回
export function filterLeads(user, payload) {
  const headers = (payload && Array.isArray(payload.headers)) ? payload.headers : [];
  const data = (payload && Array.isArray(payload.data)) ? payload.data : [];
  if (user.role === 'admin') return { headers: headers, data: data };
  return { headers: headers, data: data.filter(r => visibleLead(user, r, headers)) };
}

// Map<线索编号 trim/lower, leadRow> + leads 表头（供 fup 归属判定复用）
export function buildLeadIndex(leadsPayload) {
  const headers = (leadsPayload && Array.isArray(leadsPayload.headers)) ? leadsPayload.headers : [];
  const data = (leadsPayload && Array.isArray(leadsPayload.data)) ? leadsPayload.data : [];
  const map = new Map();
  data.forEach(r => {
    const id = leadId(r, headers).trim().toLowerCase();
    if (id) map.set(id, r);
  });
  return { map: map, headers: headers };
}

// fups 行归属：主规则按线索编号关联 leads 行继承归属；兜底按行内负责人判定
export function visibleFup(user, fupRow, fupHeaders, leadIdx) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const lid = fupLeadId(fupRow, fupHeaders).trim().toLowerCase();
  const lead = (lid && leadIdx) ? leadIdx.map.get(lid) : null;
  if (lead) return visibleLead(user, lead, leadIdx.headers);
  // 兜底：线索编号为空或关联不上（历史脏数据）
  const owner = fupOwner(fupRow, fupHeaders);
  if (user.role === 'region') return regionMembers(user.region || user.name).indexOf(owner) >= 0;
  if (user.role === 'sales') return owner === user.name;
  return false;
}

// GET /api/followups 过滤
export function filterFollowups(user, fupsPayload, leadsPayload) {
  const headers = (fupsPayload && Array.isArray(fupsPayload.headers)) ? fupsPayload.headers : [];
  const data = (fupsPayload && Array.isArray(fupsPayload.data)) ? fupsPayload.data : [];
  if (user.role === 'admin') return { headers: headers, data: data };
  const leadIdx = buildLeadIndex(leadsPayload);
  return { headers: headers, data: data.filter(r => visibleFup(user, r, headers, leadIdx)) };
}

// ---- headers 并集保序 + 行数组按表头名重映射 ----
function unionHeaders(oldH, bodyH) {
  const out = Array.isArray(oldH) ? oldH.slice() : [];
  (Array.isArray(bodyH) ? bodyH : []).forEach(h => {
    if (h && out.indexOf(h) < 0) out.push(h);
  });
  return out;
}

function remapRow(row, fromH, toH) {
  const out = new Array(toH.length).fill('');
  toH.forEach((h, i) => {
    const j = fromH.indexOf(h);
    if (j >= 0 && Array.isArray(row) && row[j] != null) out[i] = String(row[j]);
  });
  return out;
}

// ---- diff：以「旧数据」判定调用者可见集，再与 body 子集按行身份对齐 ----
// type: 'lead' | 'fup'；leadIdx 仅 fup 需要（归属关联判定）
export function diffDataset(user, oldPayload, bodyPayload, type, leadIdx) {
  const oldH = (oldPayload && Array.isArray(oldPayload.headers)) ? oldPayload.headers : [];
  const oldData = (oldPayload && Array.isArray(oldPayload.data)) ? oldPayload.data : [];
  const bodyH = (bodyPayload && Array.isArray(bodyPayload.headers)) ? bodyPayload.headers : [];
  const bodyData = (bodyPayload && Array.isArray(bodyPayload.data)) ? bodyPayload.data : [];
  const headers = unionHeaders(oldH, bodyH);

  const idOf = type === 'lead'
    ? (r, hd) => leadId(r, hd).trim().toLowerCase()
    : (r, hd) => fupId(r, hd).trim().toLowerCase();
  const visible = type === 'lead'
    ? (r, hd) => visibleLead(user, r, hd)
    : (r, hd) => visibleFup(user, r, hd, leadIdx);

  const oldAll = new Map();     // id -> oldRow（全量，识别越权用）
  const oldVisible = new Map(); // id -> oldRow（按旧数据判定可见，防止他人刚改派导致误判）
  oldData.forEach(r => {
    const id = idOf(r, oldH);
    if (!id) return;
    oldAll.set(id, r);
    if (visible(r, oldH)) oldVisible.set(id, r);
  });

  const creates = [], updates = [], deletes = [], violations = [];
  const bodyIds = new Set();

  // ---- 重复编号兜底（2026-09-29 事故修复）----
  // 前端曾用 fupsData.length + 1 生成跟进编号，历史删除留下编号空洞 → 新增时撞上已有编号。
  // 旧行为「body 内重复编号取第一行，其余直接丢弃」会**静默丢数据**：不报错、不写日志、仍返回 200，
  // 前端随后又被 PULL 整体覆盖，表现为「新增记录凭空消失」。
  // 现改为：若该行与库中同号行内容不同 → 视作真实新增，由服务端重新分配一个未占用的编号保存并留痕；
  // 若内容一致 → 确属重复推送的同一行，跳过（保持原语义）。
  const idCol = type === 'lead'
    ? colIndex(bodyH, H.LEAD_ID, FALLBACK.LEAD_ID)
    : colIndex(bodyH, H.FUP_ID, FALLBACK.FUP_ID);

  // 分配一个当前未被占用的新编号（沿用 LD-/FUP- + 年份 + 4 位序号）
  const allocNewId = function() {
    const prefix = type === 'lead' ? 'LD' : 'FUP';
    const year = new Date().getFullYear();
    const re = new RegExp('^' + prefix + '-\\d{4}-(\\d+)$');
    let maxNum = 0;
    const bump = function(idStr) {
      const mm = String(idStr || '').trim().toUpperCase().match(re);
      if (mm) maxNum = Math.max(maxNum, parseInt(mm[1], 10));
    };
    oldAll.forEach(function(_v, k) { bump(k); });
    bodyIds.forEach(function(k) { bump(k); });
    return prefix + '-' + year + '-' + String(maxNum + 1).padStart(4, '0');
  };

  bodyData.forEach(br => {
    const id = idOf(br, bodyH);
    if (!id) return;              // 无编号行无法定位身份，忽略（不入库也不算删除）
    if (bodyIds.has(id)) {
      // 仅对跟进记录（fup）兜底：
      //  - lead 主键由前端 max+1 生成，不会撞号；且 lead 有既有用例
      //    「l001 / L001 / ' l001 ' 视为同一行，不得新增重复行」，必须保持原语义。
      //  - 判据取「线索编号不同」：说明这是另一条真实记录被前端错配了已有编号
      //    （前端曾用 length+1 生成编号，历史删除留下空洞 → 撞上已有记录）。
      const oldR = oldAll.get(id);
      const liOld = colIndex(oldH, H.FUP_LEAD_ID, FALLBACK.FUP_LEAD_ID);
      const liBody = colIndex(bodyH, H.FUP_LEAD_ID, FALLBACK.FUP_LEAD_ID);
      const leadA = oldR && liOld >= 0 ? String(oldR[liOld] || '').trim().toLowerCase() : '';
      const leadB = (type === 'fup' && liBody >= 0) ? String(br[liBody] || '').trim().toLowerCase() : '';
      if (type === 'fup' && leadA !== leadB) {
        const newId = allocNewId();
        if (!newId) return;
        bodyIds.add(newId.toLowerCase());
        const rr = Array.isArray(br) ? br.slice() : [];
        if (idCol >= 0) rr[idCol] = newId;
        creates.push({
          id: newId.toLowerCase(), row: remapRow(rr, bodyH, headers),
          renamedFrom: String(id).toUpperCase()
        });
        return;
      }
      return;   // 其余保持原语义：body 内重复编号取第一行
    }
    bodyIds.add(id);
    if (oldVisible.has(id)) {
      // update 候选：未在 bodyH 出现的列沿用旧值（headers 并集保序，前端删列不丢数据）
      const oldR = remapRow(oldVisible.get(id), oldH, headers);
      const merged = oldR.slice();
      bodyH.forEach((h, bi) => {
        const ti = headers.indexOf(h);
        if (ti >= 0 && br[bi] != null) merged[ti] = String(br[bi]);
      });
      const diff = [];
      headers.forEach((h, i) => {
        if ((oldR[i] || '') !== (merged[i] || '')) diff.push({ field: h, old: oldR[i] || '', new: merged[i] || '' });
      });
      if (diff.length) updates.push({ id: id, oldRow: oldR, row: merged, diff: diff });
    } else if (oldAll.has(id)) {
      // 编号在 old 全量中存在但对该用户不可见 → 越权
      violations.push({ id: id, field: '*', reason: '该记录不在你的数据范围内，禁止修改' });
    } else {
      creates.push({ id: id, row: remapRow(br, bodyH, headers) });
    }
  });
  // delete 候选：旧可见集中未出现在 body 的行（body.data=[] 且可见集为空时属合法，不触发删除）
  oldVisible.forEach((r, id) => {
    if (!bodyIds.has(id)) deletes.push({ id: id, row: remapRow(r, oldH, headers) });
  });

  return { headers: headers, creates: creates, updates: updates, deletes: deletes,
           violations: violations, oldH: oldH, oldData: oldData };
}

// ---- 写权限校验 + 字段锁定（服务端强制，不信任前端）----
// sales：负责人允许值=本大区名单，越界强制改写为本人；负责大区强制改写为所属大区。
// region：负责人允许值=本人 subordinates（含本人），越界 → 403；清空 → 强制锁回原值（防行孤儿化）；
//         负责大区强制改写为本人姓名。
// admin：不限（可清空负责人、可跨线索挂跟进）。
// 负责人未变更的 update 行不校验负责人（避免历史脏数据阻塞其他字段编辑）。
// fup 专属：creates 行 + update 行变更「线索编号」时，目标线索必须对操作者可见
//           （防跨线索注入：给他人线索挂跟进记录；线索编号为空/关联不上时靠负责人兜底锁定）。
export function checkWritePerm(user, d, type, leadIdx) {
  const violations = d.violations.slice();
  const updates = [], creates = [], touches = [];
  const headers = d.headers;
  const oi = colIndex(headers, H.LEAD_OWNER, type === 'lead' ? FALLBACK.LEAD_OWNER : FALLBACK.FUP_OWNER);
  const ri = type === 'lead' ? colIndex(headers, H.LEAD_REGION, FALLBACK.LEAD_REGION) : -1;
  const li = type === 'fup' ? colIndex(headers, H.FUP_LEAD_ID, FALLBACK.FUP_LEAD_ID) : -1;
  const OWNER_FIELD = '负责人';
  const LEAD_FIELD = '线索编号';

  // fup「线索编号」指向的线索可见性校验：不可见 → 返回 violation；可见/无引用 → null
  function leadRefViolation(row, id) {
    if (type !== 'fup' || user.role === 'admin' || !leadIdx || li < 0) return null;
    const lid = cell(row, li).trim().toLowerCase();
    if (!lid) return null;                       // 空编号：靠负责人兜底锁定归属
    const lead = leadIdx.map.get(lid);
    if (!lead) return null;                      // 关联不上（历史脏数据同类）：同上兜底
    if (visibleLead(user, lead, leadIdx.headers)) return null;
    return { id: id, field: LEAD_FIELD,
             reason: '线索编号 ' + cell(row, li) + ' 不在你的数据范围内，禁止为其新增/变更跟进记录' };
  }

  d.updates.forEach(u => {
    const ownerChanged = u.diff.some(f => f.field === OWNER_FIELD);
    const row = u.row.slice();
    // fup 变更线索编号 → 新目标线索必须可见（防改挂他人线索）
    if (type === 'fup' && u.diff.some(f => f.field === LEAD_FIELD)) {
      const lv = leadRefViolation(row, u.id);
      if (lv) { violations.push(lv); return; }
    }
    if (user.role === 'sales') {
      if (ownerChanged && regionMembers(user.region).indexOf(row[oi]) < 0) row[oi] = user.name;
      if (ri >= 0) row[ri] = user.region || '';
    } else if (user.role === 'region') {
      if (ownerChanged && !row[oi]) {
        // 不允许清空负责人（防行变「未分配」孤儿化仅 admin 可见），强制锁回原值，与 sales 锁回语义对齐
        row[oi] = u.oldRow[oi] || user.name;
      } else if (ownerChanged && regionMembers(user.region || user.name).indexOf(row[oi]) < 0) {
        violations.push({ id: u.id, field: OWNER_FIELD, reason: '负责人只能改派给本大区成员' });
        return;
      }
      if (ri >= 0) row[ri] = user.region || user.name;
    }
    // diff 按最终行重算（含锁定改写）
    const diff = [];
    headers.forEach((h, i) => {
      if ((u.oldRow[i] || '') !== (row[i] || '')) diff.push({ field: h, old: u.oldRow[i] || '', new: row[i] || '' });
    });
    touches.push({ owner: u.oldRow[oi] || '', region: ri >= 0 ? (u.oldRow[ri] || '') : '' });
    touches.push({ owner: row[oi] || '', region: ri >= 0 ? (row[ri] || '') : '' });
    if (diff.length) updates.push({ id: u.id, row: row, diff: diff });
  });

  d.creates.forEach(c => {
    const row = c.row.slice();
    // fup 新增行：线索编号指向的线索必须可见（防跨线索注入——sales 给他人线索建跟进）
    const lv = leadRefViolation(row, c.id);
    if (lv) { violations.push(lv); return; }
    if (user.role === 'sales') {
      if (regionMembers(user.region).indexOf(row[oi]) < 0) row[oi] = user.name;
      if (ri >= 0) row[ri] = user.region || '';
    } else if (user.role === 'region') {
      if (row[oi] && regionMembers(user.region || user.name).indexOf(row[oi]) < 0) {
        violations.push({ id: c.id, field: OWNER_FIELD, reason: '新增记录的负责人只能属于本大区' });
        return;
      }
      if (!row[oi]) row[oi] = user.name; // 空负责人兜底为本人，避免产生「未分配」孤儿行
      if (ri >= 0) row[ri] = user.region || user.name;
    }
    touches.push({ owner: row[oi] || '', region: ri >= 0 ? (row[ri] || '') : '' });
    creates.push({ id: c.id, row: row, renamedFrom: c.renamedFrom || '' });
  });

  // delete 候选已在 diff 阶段按旧数据可见性限定（sales 只能删本人行 / region 只能删本大区行）
  // 2026-09-23 权限收紧：跟进记录（MQLs）删除仅管理员，销售/大区总一律拒绝（整体 403 + 审计留痕）
  const deletes = [];
  d.deletes.forEach(del => {
    if (type === 'fup' && user.role !== 'admin') {
      violations.push({ id: del.id, field: '*', reason: '仅管理员可删除跟进记录（MQLs），本次删除已被拒绝' });
      return;
    }
    touches.push({ owner: del.row[oi] || '', region: ri >= 0 ? (del.row[ri] || '') : '' });
    deletes.push(del);
  });

  return { headers: headers, updates: updates, creates: creates, deletes: deletes,
           violations: violations, touches: touches };
}

// ---- 合并回全量：不可见行原样保留；可见行替换/删除；新行追加 ----
export function mergeDataset(oldPayload, d, checked, type) {
  const headers = checked.headers;
  const oldH = d.oldH;
  const updMap = new Map();
  checked.updates.forEach(u => updMap.set(u.id, u.row));
  const delSet = new Set();
  checked.deletes.forEach(x => delSet.add(x.id));
  const idOf = type === 'lead'
    ? (r) => leadId(r, oldH).trim().toLowerCase()
    : (r) => fupId(r, oldH).trim().toLowerCase();

  const out = [];
  d.oldData.forEach(r => {
    const id = idOf(r);
    if (id && delSet.has(id)) return;              // 删除
    if (id && updMap.has(id)) { out.push(updMap.get(id)); return; } // 更新
    out.push(remapRow(r, oldH, headers));          // 不可见行/未变更行原样保留
  });
  checked.creates.forEach(c => out.push(c.row));   // 新行追加
  return { headers: headers, data: out };
}

// ---- meta.scopeModified 分片时间戳触达 ----
// touches: [{owner, region}]（旧值与新值并集，改派场景双方都触达）
// opts: { leadsCount?, fupsCount?, cfg? }
export async function touchScopeModified(store, touches, opts) {
  try {
    const meta = (await store.get('meta', { type: 'json', consistency: 'strong' })) || {};
    const now = Date.now();
    meta.lastModified = now;
    meta.scopeModified = meta.scopeModified || {};
    meta.scopeModified.admin = now;
    (touches || []).forEach(t => {
      if (!t) return;
      if (t.region) meta.scopeModified['R:' + t.region] = now;
      if (t.owner) meta.scopeModified['S:' + t.owner] = now;
    });
    if (opts && opts.cfg) meta.scopeModified.cfg = now;
    if (opts && typeof opts.leadsCount === 'number') meta.leadsCount = opts.leadsCount;
    if (opts && typeof opts.fupsCount === 'number') meta.fupsCount = opts.fupsCount;
    await store.set('meta', JSON.stringify(meta));
  } catch (e) { /* meta 更新失败不影响主流程 */ }
}
