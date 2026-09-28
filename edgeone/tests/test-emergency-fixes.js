// ============================================================================
// 科诺美线索系统 2026-09-23 紧急修复回归 — 空数据/自动种子/批量删除保护/计数自愈/密码
// 运行：node tests/test-emergency-fixes.js
// 对应修复：
//   A. 前端自动种子逻辑彻底移除（源码级检查）
//   B. 空数组合法返回（穆忠仁 0 条）+ 接口异常返回 500（不再伪装 200 空数据）
//   C. 服务端批量删除保护：单次删除 ≥10 条必须 body.confirmBulkDelete === true
//   D. status 计数自愈：以真实数据行数为准，meta 漂移自动修正（245 vs 184 问题）
//   E. 修改密码 / 管理员重置密码（/api/auth/password）
//   F. 销售更新触达 region/admin（scopeModified 分片，跨角色同步可见）
// ============================================================================
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import * as loginApi from '../functions/api/auth/login.js';
import * as passwordApi from '../functions/api/auth/password.js';
import * as leadsApi from '../functions/api/leads.js';
import * as fupsApi from '../functions/api/followups.js';
import * as statusApi from '../functions/api/status.js';
import { queryLogs } from '../functions/api/_log.js';
import { BULK_DELETE_THRESHOLD } from '../functions/api/_config.js';

let PASSED = 0, FAILED = 0;
const FAILURES = [];
const groups = [];
function group(name) { groups.push(name); console.log('\n== ' + name + ' =='); }
async function t(name, fn) {
  try {
    await fn();
    PASSED++;
    console.log('  ✓ ' + name);
  } catch (e) {
    FAILED++;
    FAILURES.push({ name: name, error: String(e && e.message || e) });
    console.log('  ✗ ' + name + '\n      ' + (e && e.message || e));
  }
}
const ENV = { AUTH_SECRET: 'qa-test-secret-0123456789' };

// ---------------------------------------------------------------------------
// Blob 状态管理（与 mock @edgeone/pages-blob 对齐）
// ---------------------------------------------------------------------------
const g = globalThis;
function resetBlob() { g.__BLOB_STORES = new Map(); }
function blobMap() { return g.__BLOB_STORES.get('chromai-leads'); }
function rawSet(key, obj) {
  if (!g.__BLOB_STORES.has('chromai-leads')) g.__BLOB_STORES.set('chromai-leads', new Map());
  blobMap().set(key, JSON.stringify(obj));
}
function rawGet(key) {
  const m = blobMap();
  const v = m ? m.get(key) : undefined;
  return v === undefined ? null : JSON.parse(v);
}

// ---------------------------------------------------------------------------
// 测试数据（负责人 index 12 / 负责大区 index 13，证明按表头名定位列）
// ---------------------------------------------------------------------------
const LH = ['线索编号', '来源', '公司名称', '联系人', '职位', '电话', '微信', '邮箱',
  '需求描述', '状态', '创建时间', '最后跟进', '负责人', '负责大区', '备注'];
function leadRow(id, owner, region, status) {
  const r = LH.map((_, i) => '');
  r[0] = id; r[9] = status || '新建'; r[12] = owner; r[13] = region; r[14] = '备注-' + id;
  return r;
}
function seedLeads() {
  return [
    leadRow('L001', '王远帅', '汤显义'),
    leadRow('L002', '高丹枫', '汤显义'),
    leadRow('L003', '高雷', '汤显义'),
    leadRow('L004', '王泽', '汤显义'),
    leadRow('L005', '黄江锐', '汤显义'),
    leadRow('L006', '胡雨来', '汤显义'),
    leadRow('L007', '汤显义', '汤显义'),
    leadRow('L008', '刘力瑞', '管能'),
    leadRow('L009', '管能', '管能'),
    leadRow('L010', '穆忠仁', '穆忠仁'),
    leadRow('L011', '', ''),          // 未分配行：仅 admin 可见
    leadRow('L012', '王远帅', '汤显义')
  ];
}
const FH = ['跟进编号', '线索编号', '跟进时间', '跟进方式', '跟进内容', '负责人'];
function fupRow(id, leadId, owner, content) {
  const r = FH.map((_, i) => '');
  r[0] = id; r[1] = leadId; r[4] = content || '跟进-' + id; r[5] = owner;
  return r;
}
function seedFups() {
  return [
    fupRow('F001', 'L001', '王远帅'),
    fupRow('F002', 'L003', '刘力瑞'),
    fupRow('F003', '', '王远帅'),
    fupRow('F004', 'L999', '刘力瑞'),
    fupRow('F005', 'L008', '管能'),
    fupRow('F006', 'L010', '穆忠仁'),
    fupRow('F007', 'L002', '高丹枫')
  ];
}
function fullSeed() {
  resetBlob();
  rawSet('leads', { headers: LH.slice(), data: seedLeads() });
  rawSet('followups', { headers: FH.slice(), data: seedFups() });
}

// ---------------------------------------------------------------------------
// 请求辅助
// ---------------------------------------------------------------------------
function req(path, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers);
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
  const init = { method: opts.method || 'GET', headers: headers };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }
  return new Request('https://qa.example' + path, init);
}
async function loginAs(email, password) {
  const r = await loginApi.onRequest({ request: req('/api/auth/login', {
    method: 'POST', body: { email: email, password: password === undefined ? 'chromai2019' : password }
  }), env: ENV });
  const j = await r.json();
  return j;
}
async function api(fn, path, opts) {
  const r = await fn.onRequest({ request: req(path, opts), env: ENV });
  let j = null;
  try { j = await r.json(); } catch (e) { /* 非 JSON */ }
  return { status: r.status, json: j, headers: r.headers };
}

// index.html 源码（前端契约检查用）
const htmlPath = new URL('../index.html', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const HTML = readFileSync(htmlPath, 'utf8');

// ============================================================================
group('一、修复A：自动种子逻辑彻底移除（源码级检查）');
// ============================================================================
{
  await t('index.html 无 _autoSeedDone / 自动种子推送分支残留', async () => {
    assert.ok(!HTML.includes('_autoSeedDone'), '不应再包含 _autoSeedDone');
    assert.ok(!HTML.includes('自动推送本地数据'), 'init() 不应再自动推送本地数据');
    assert.ok(!/"已将本地数据同步到服务器"/.test(HTML), '自动种子 toast 文案应删除');
  });

  await t('推送前置防线：_pulledFromServer 未拉取成功不推送（源码存在且强制）', async () => {
    assert.ok(HTML.includes('let _pulledFromServer = false'), '应声明 _pulledFromServer');
    assert.ok(/if\s*\(!_pulledFromServer\)\s*\{/.test(HTML), 'syncToServer 应有未拉取拦截分支');
    assert.ok(HTML.includes('防止本地旧快照覆盖线上数据'), '拦截分支应带防覆盖注释');
  });

  await t('所有 <script> 块通过语法校验', async () => {
    const blocks = [];
    const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(HTML)) !== null) { if (m[1].trim()) blocks.push(m[1]); }
    assert.ok(blocks.length >= 1);
    blocks.forEach((code, i) => {
      try { new Function(code); }
      catch (e) { throw new Error('script 块 #' + (i + 1) + ' 语法错误: ' + e.message); }
    });
  });
}

// ============================================================================
group('二、修复B：空数组合法 + 接口异常 500（异常与空数据严格区分）');
// ============================================================================
{
  fullSeed();

  await t('穆忠仁（region，本大区无跟进）GET /api/followups → 200 且 data=[]（合法空，不清空为 null）', async () => {
    // 场景：数据里没有任何属于穆忠仁大区的跟进记录（去掉 F006）
    const fups = rawGet('followups');
    fups.data = fups.data.filter(r => r[0] !== 'F006');
    rawSet('followups', fups);
    const lg = await loginAs('muzhongren@chromai.com');
    const r = await api(fupsApi, '/api/followups', { token: lg.token });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.data), 'data 应为数组');
    assert.strictEqual(r.json.data.length, 0, '穆忠仁应看到 0 条（服务端过滤）');
  });

  await t('穆忠仁 GET /api/leads 仅返回本大区 1 条（L010），不显示他人数据', async () => {
    const lg = await loginAs('muzhongren@chromai.com');
    const r = await api(leadsApi, '/api/leads', { token: lg.token });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.length, 1);
    assert.strictEqual(r.json.data[0][0], 'L010');
  });

  await t('前端 syncFromServer 接受合法空数组（无 .length > 0 判断）', async () => {
    assert.ok(HTML.includes('leadsRes && Array.isArray(leadsRes.data)'), 'leads 应按 Array.isArray 判定（含空数组）');
    assert.ok(HTML.includes('fupsRes && Array.isArray(fupsRes.data)'), 'fups 应按 Array.isArray 判定（含空数组）');
    assert.ok(!HTML.includes('fupsRes.data.length > 0'), '不得再有 fups 非空才更新的判断');
    assert.ok(!HTML.includes('leadsRes.data.length > 0'), '不得再有 leads 非空才更新的判断');
    assert.ok(HTML.includes('fetchJsonOk'), '应使用区分异常/空数据的请求封装');
  });

  await t('leads GET 存储异常 → 500 + storage_error（不再伪装 200 空数据）', async () => {
    fullSeed();
    const lg = await loginAs('yucui@chromai.com');
    // 毒化 blob：store.get 一律抛错（requireAuth 走 users 自愈不阻塞）
    g.__BLOB_STORES.set('chromai-leads', {
      get() { throw new Error('blob down'); },
      set() { throw new Error('blob down'); },
      delete() {},
      list() { return { keys: [] }; }
    });
    const r = await api(leadsApi, '/api/leads', { token: lg.token });
    assert.strictEqual(r.status, 500, '存储异常必须 500');
    assert.strictEqual(r.json.error, 'storage_error');
    assert.ok(!Array.isArray(r.json.data), '异常响应的 data 不得是数组（防止前端误判为空）');
    fullSeed();
  });

  await t('followups GET 存储异常 → 500 + storage_error', async () => {
    fullSeed();
    const lg = await loginAs('yucui@chromai.com');
    g.__BLOB_STORES.set('chromai-leads', {
      get() { throw new Error('blob down'); },
      set() { throw new Error('blob down'); },
      delete() {},
      list() { return { keys: [] }; }
    });
    const r = await api(fupsApi, '/api/followups', { token: lg.token });
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.json.error, 'storage_error');
    fullSeed();
  });

  await t('Blob 无 leads/followups 键（全新部署）→ 200 合法空（null≠异常）', async () => {
    resetBlob();
    const lg = await loginAs('yucui@chromai.com');
    const r1 = await api(leadsApi, '/api/leads', { token: lg.token });
    assert.strictEqual(r1.status, 200);
    assert.ok(Array.isArray(r1.json.data) && r1.json.data.length === 0);
    const r2 = await api(fupsApi, '/api/followups', { token: lg.token });
    assert.strictEqual(r2.status, 200);
    assert.ok(Array.isArray(r2.json.data) && r2.json.data.length === 0);
  });
}

// ============================================================================
group('三、修复C：批量删除保护（单次删除 ≥' + BULK_DELETE_THRESHOLD + ' 条必须显式确认）');
// ============================================================================
{
  await t('admin 全量 POST 漏掉 10 行（模拟旧快照覆盖，无确认）→ 403 bulk_delete_confirm_required，数据未变', async () => {
    fullSeed();
    const lg = await loginAs('yucui@chromai.com');
    const keep = seedLeads().slice(0, 2); // 12 条只回传 2 条 → 10 条被判删除
    const r = await api(leadsApi, '/api/leads', {
      method: 'POST', token: lg.token,
      body: { headers: LH.slice(), data: keep }
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error, 'bulk_delete_confirm_required');
    assert.strictEqual(r.json.deletes, 10);
    assert.strictEqual(rawGet('leads').data.length, 12, '服务端数据必须未被改动（原子拒绝）');
  });

  await t('拦截动作写入 forbidden 审计日志（含批量删除保护明细）', async () => {
    const store = (await import('@edgeone/pages-blob')).getStore('chromai-leads');
    const res = await queryLogs(store, { event: 'forbidden' });
    assert.ok(res.items.length >= 1, '应有 forbidden 日志');
    assert.ok(res.items.some(it => (it.detail || '').indexOf('批量删除保护') >= 0 || (it.detail || '').indexOf('未确认') >= 0),
      '日志应包含批量删除保护明细');
  });

  await t('admin 显式确认（confirmBulkDelete:true）→ 200，10 条删除成功', async () => {
    const lg = await loginAs('yucui@chromai.com');
    const keep = seedLeads().slice(0, 2);
    const r = await api(leadsApi, '/api/leads', {
      method: 'POST', token: lg.token,
      body: { headers: LH.slice(), data: keep, confirmBulkDelete: true }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.deleted, 10);
    assert.strictEqual(rawGet('leads').data.length, 2);
  });

  await t('低于阈值：单次删除 9 条（无确认）→ 200 正常放行', async () => {
    fullSeed();
    const lg = await loginAs('yucui@chromai.com');
    const keep = seedLeads().slice(0, 3); // 9 条删除
    const r = await api(leadsApi, '/api/leads', {
      method: 'POST', token: lg.token,
      body: { headers: LH.slice(), data: keep }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(rawGet('leads').data.length, 3);
  });

  await t('followups 同样拦截：admin POST 空 data（15 条全删，无确认）→ 403', async () => {
    fullSeed();
    const fups = rawGet('followups');
    const big = [];
    for (let i = 0; i < 15; i++) big.push(fupRow('F1' + String(i).padStart(2, '0'), 'L001', '王远帅'));
    fups.data = big;
    rawSet('followups', fups);
    const lg = await loginAs('yucui@chromai.com');
    const r = await api(fupsApi, '/api/followups', {
      method: 'POST', token: lg.token,
      body: { headers: FH.slice(), data: [] }
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error, 'bulk_delete_confirm_required');
    assert.strictEqual(rawGet('followups').data.length, 15);
  });

  await t('sales 删自己 10 条（无确认）→ 403；确认后 → 200（行级权限不变）', async () => {
    fullSeed();
    const mine = [];
    for (let i = 0; i < 12; i++) mine.push(leadRow('W' + String(i).padStart(3, '0'), '王远帅', '汤显义'));
    rawSet('leads', { headers: LH.slice(), data: mine });
    const lg = await loginAs('wangyuanshuai@chromai.com');
    const keep = mine.slice(0, 2);
    const r1 = await api(leadsApi, '/api/leads', {
      method: 'POST', token: lg.token, body: { headers: LH.slice(), data: keep }
    });
    assert.strictEqual(r1.status, 403, '10 条删除无确认应拒绝');
    assert.strictEqual(rawGet('leads').data.length, 12);
    const r2 = await api(leadsApi, '/api/leads', {
      method: 'POST', token: lg.token, body: { headers: LH.slice(), data: keep, confirmBulkDelete: true }
    });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(rawGet('leads').data.length, 2);
  });

  await t('RBAC 保持：sales 漏传不等于删除他人行（他人行不可见，不产生 deletes）', async () => {
    fullSeed();
    const lg = await loginAs('wangyuanshuai@chromai.com');
    // sales 只回传自己的 2 行；他人 10 行不在可见集 → 不应产生任何 deletes
    const mine = seedLeads().filter(r => r[12] === '王远帅');
    const r = await api(leadsApi, '/api/leads', {
      method: 'POST', token: lg.token, body: { headers: LH.slice(), data: mine }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.deleted, 0, '他人行不得被误判为删除');
    assert.strictEqual(rawGet('leads').data.length, 12, '全量数据不变');
  });

  await t('前端仅在显式删除操作时设置确认标记（源码级）', async () => {
    assert.ok(HTML.includes('_confirmBulkDeleteAt = Date.now()'), '删除/批量删除应打确认时间戳');
    const occurrences = (HTML.match(/_confirmBulkDeleteAt = Date\.now\(\)/g) || []).length;
    assert.ok(occurrences >= 4, '单条删除×2 + 批量删除×2 均应打标记，实际 ' + occurrences);
    assert.ok(HTML.includes("confirmBulkDelete: confirmBulk"), 'syncToServer 应携带确认标记');
  });
}

// ============================================================================
group('四、修复D：status 计数自愈（meta 245 vs 实际 184 类漂移）');
// ============================================================================
{
  await t('meta 计数漂移（999/245）→ status 返回真实计数（12/7）', async () => {
    fullSeed();
    rawSet('meta', { lastModified: 1000, leadsCount: 999, fupsCount: 245, scopeModified: { admin: 1000, cfg: 500 } });
    const lg = await loginAs('yucui@chromai.com');
    const r = await api(statusApi, '/api/status', { token: lg.token });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.leadsCount, 12, '应以真实行数为准');
    assert.strictEqual(r.json.fupsCount, 7);
  });

  await t('status 调用后 meta 已被自动修正（自愈持久化）', async () => {
    const meta = rawGet('meta');
    assert.strictEqual(meta.leadsCount, 12, 'meta.leadsCount 应已修正');
    assert.strictEqual(meta.fupsCount, 7, 'meta.fupsCount 应已修正');
    assert.strictEqual(meta.lastModified, 1000, '自愈不得破坏 lastModified/scopeModified');
    assert.strictEqual(meta.scopeModified.admin, 1000);
  });

  await t('正常写入路径：POST 删 1 条后 status 计数与实际一致', async () => {
    fullSeed();
    const lg = await loginAs('yucui@chromai.com');
    const keep = seedLeads().slice(1); // 删 L001（1 条，无需确认）
    const r1 = await api(leadsApi, '/api/leads', {
      method: 'POST', token: lg.token, body: { headers: LH.slice(), data: keep }
    });
    assert.strictEqual(r1.status, 200);
    const r2 = await api(statusApi, '/api/status', { token: lg.token });
    assert.strictEqual(r2.json.leadsCount, 11);
    const meta = rawGet('meta');
    assert.strictEqual(meta.leadsCount, 11, 'POST 后 meta 应一致');
  });

  await t('自愈失败不阻塞：实际数据读取异常时回退 meta 计数', async () => {
    fullSeed();
    rawSet('meta', { lastModified: 1000, leadsCount: 55, fupsCount: 44 });
    g.__BLOB_STORES.set('chromai-leads', {
      get(key) {
        if (key === 'meta') return JSON.stringify({ lastModified: 1000, leadsCount: 55, fupsCount: 44 });
        throw new Error('blob down');
      },
      set() { throw new Error('blob down'); },
      delete() {},
      list() { return { keys: [] }; }
    });
    const lg = await loginAs('yucui@chromai.com');
    const r = await api(statusApi, '/api/status', { token: lg.token });
    assert.strictEqual(r.status, 200, '自愈失败不得 5xx');
    assert.strictEqual(r.json.leadsCount, 55, '回退 meta 计数');
    assert.strictEqual(r.json.fupsCount, 44);
    fullSeed();
  });
}

// ============================================================================
group('五、修复E：修改密码 / 管理员重置密码');
// ============================================================================
{
  await t('本人改密：原密码错误 → 401', async () => {
    fullSeed();
    const lg = await loginAs('wangyuanshuai@chromai.com');
    const r = await api(passwordApi, '/api/auth/password', {
      method: 'POST', token: lg.token,
      body: { currentPassword: 'wrong-password', newPassword: 'brand-new-99' }
    });
    assert.strictEqual(r.status, 401);
  });

  await t('本人改密：新密码 <6 位 → 400', async () => {
    const lg = await loginAs('wangyuanshuai@chromai.com');
    const r = await api(passwordApi, '/api/auth/password', {
      method: 'POST', token: lg.token,
      body: { currentPassword: 'chromai2019', newPassword: '123' }
    });
    assert.strictEqual(r.status, 400);
  });

  await t('本人改密：新密码与原密码相同 → 400', async () => {
    const lg = await loginAs('wangyuanshuai@chromai.com');
    const r = await api(passwordApi, '/api/auth/password', {
      method: 'POST', token: lg.token,
      body: { currentPassword: 'chromai2019', newPassword: 'chromai2019' }
    });
    assert.strictEqual(r.status, 400);
  });

  await t('本人改密：正确 → 200；旧密码登录失败、新密码登录成功', async () => {
    const lg = await loginAs('wangyuanshuai@chromai.com');
    const r = await api(passwordApi, '/api/auth/password', {
      method: 'POST', token: lg.token,
      body: { currentPassword: 'chromai2019', newPassword: 'wang-2026-new' }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    const oldTry = await loginAs('wangyuanshuai@chromai.com', 'chromai2019');
    assert.strictEqual(oldTry.ok, false, '旧密码应失效');
    const newTry = await loginAs('wangyuanshuai@chromai.com', 'wang-2026-new');
    assert.strictEqual(newTry.ok, true, '新密码应可登录');
  });

  await t('非 admin 重置他人密码 → 403，目标密码未变', async () => {
    fullSeed();
    const lg = await loginAs('tangxianyi@chromai.com'); // region 试图重置销售密码
    const r = await api(passwordApi, '/api/auth/password', {
      method: 'POST', token: lg.token,
      body: { targetEmail: 'wangyuanshuai@chromai.com', newPassword: 'hacked-12345' }
    });
    assert.strictEqual(r.status, 403);
    const still = await loginAs('wangyuanshuai@chromai.com', 'chromai2019');
    assert.strictEqual(still.ok, true, '目标账号密码必须未变');
  });

  await t('admin 重置销售密码 → 200；销售用新密码登录成功', async () => {
    const lg = await loginAs('yucui@chromai.com');
    const r = await api(passwordApi, '/api/auth/password', {
      method: 'POST', token: lg.token,
      body: { targetEmail: 'gaodanfeng@chromai.com', newPassword: 'reset-by-admin-1' }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.reset, true);
    const newTry = await loginAs('gaodanfeng@chromai.com', 'reset-by-admin-1');
    assert.strictEqual(newTry.ok, true);
    const oldTry = await loginAs('gaodanfeng@chromai.com', 'chromai2019');
    assert.strictEqual(oldTry.ok, false);
  });

  await t('admin 重置不存在账号 → 404', async () => {
    const lg = await loginAs('yucui@chromai.com');
    const r = await api(passwordApi, '/api/auth/password', {
      method: 'POST', token: lg.token,
      body: { targetEmail: 'nobody@chromai.com', newPassword: 'whatever-123' }
    });
    assert.strictEqual(r.status, 404);
  });

  await t('改密/重置写入审计日志（objectType=user）', async () => {
    const store = (await import('@edgeone/pages-blob')).getStore('chromai-leads');
    const res = await queryLogs(store, {});
    const userLogs = res.items.filter(it => it.objectType === 'user');
    assert.ok(userLogs.length >= 2, '应有改密/重置日志');
    assert.ok(userLogs.some(it => (it.detail || '').indexOf('管理员重置') >= 0), '重置日志应含明细');
    assert.ok(userLogs.some(it => it.event === 'update' || it.event === 'forbidden'), '事件类型正确');
  });

  await t('非本人未带 targetEmail 时必须走原密码校验（不可裸改自己）', async () => {
    fullSeed();
    const lg = await loginAs('gaolei@chromai.com');
    const r = await api(passwordApi, '/api/auth/password', {
      method: 'POST', token: lg.token, body: { newPassword: 'no-current-pwd-9' }
    });
    assert.strictEqual(r.status, 401, '缺原密码应拒绝');
    const still = await loginAs('gaolei@chromai.com', 'chromai2019');
    assert.strictEqual(still.ok, true, '密码未变');
  });
}

// ============================================================================
group('六、销售更新触达 region/admin（跨角色同步可见性）');
// ============================================================================
{
  await t('sales 更新本人线索 → S:本人 / R:大区 / admin 三分片触达，无关大区不受影响', async () => {
    fullSeed();
    // 建立基线 meta（admin 空操作 POST 触发 touchScopeModified）
    const adminLg = await loginAs('yucui@chromai.com');
    await api(leadsApi, '/api/leads', {
      method: 'POST', token: adminLg.token,
      body: { headers: LH.slice(), data: seedLeads() }
    });
    const before = rawGet('meta');

    await new Promise(res => setTimeout(res, 10)); // 确保时间戳可分辨递增

    const salesLg = await loginAs('wangyuanshuai@chromai.com');
    const updated = seedLeads();
    updated[0][9] = '已跟进'; // 王远帅改 L001 状态
    const r = await api(leadsApi, '/api/leads', {
      method: 'POST', token: salesLg.token, body: { headers: LH.slice(), data: updated.filter(x => x[12] === '王远帅') }
    });
    assert.strictEqual(r.status, 200);
    const after = rawGet('meta');
    const sm = after.scopeModified || {};
    assert.ok((sm['S:王远帅'] || 0) > (before.scopeModified['S:王远帅'] || 0), 'S:王远帅 应触达');
    assert.ok((sm['R:汤显义'] || 0) > (before.scopeModified['R:汤显义'] || 0), 'R:汤显义 应触达（大区总同步可见）');
    assert.ok((sm.admin || 0) > (before.scopeModified.admin || 0), 'admin 分片应触达（管理员同步可见）');
    assert.strictEqual(sm['R:管能'] || 0, before.scopeModified['R:管能'] || 0, '管能大区不应被触达');
  });

  await t('region 轮询感知变化：汤显义 lastModified 增加，管能不变', async () => {
    const txyLg = await loginAs('tangxianyi@chromai.com');
    const gnLg = await loginAs('guanneng@chromai.com');
    const beforeT = (await api(statusApi, '/api/status', { token: txyLg.token })).json.lastModified;
    const beforeG = (await api(statusApi, '/api/status', { token: gnLg.token })).json.lastModified;
    // 王远帅再更新一次
    const salesLg = await loginAs('wangyuanshuai@chromai.com');
    const updated = seedLeads();
    updated[0][9] = '商机推进';
    await new Promise(res => setTimeout(res, 5)); // 确保 ts 递增
    const r = await api(leadsApi, '/api/leads', {
      method: 'POST', token: salesLg.token, body: { headers: LH.slice(), data: updated.filter(x => x[12] === '王远帅') }
    });
    assert.strictEqual(r.status, 200);
    const afterT = (await api(statusApi, '/api/status', { token: txyLg.token })).json.lastModified;
    const afterG = (await api(statusApi, '/api/status', { token: gnLg.token })).json.lastModified;
    assert.ok(afterT > beforeT, '汤显义应感知到变化');
    assert.strictEqual(afterG, beforeG, '管能不应感知到变化');
  });
}

// ============================================================================
console.log('\n============================================');
console.log('总计: ' + (PASSED + FAILED) + ' | 通过: ' + PASSED + ' | 失败: ' + FAILED);
console.log('============================================');
if (FAILURES.length) {
  console.log('失败明细:');
  FAILURES.forEach(f => console.log('  ✗ ' + f.name + ' — ' + f.error));
}
process.exit(FAILED ? 1 : 0);
