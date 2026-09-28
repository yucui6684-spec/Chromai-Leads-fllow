// ============================================================================
// 科诺美线索系统 RBAC 升级 - QA 独立验证测试（Node 22，零依赖直接运行）
// 运行：node tests/test-rbac.js
// 覆盖：认证 / 读隔离边界 / 写合并与越权（原子性）/ 审计日志 / 前端语法 / 回归契约
// ============================================================================
import assert from 'node:assert';

import { signToken, verifyToken, requireAuth, loadUsers, buildDefaultUsers, sha256, DEFAULT_USERS }
  from '../functions/api/_auth.js';
import { regionOfMember, regionMembers, IMPORT_THRESHOLD } from '../functions/api/_config.js';
import { filterLeads, filterFollowups, diffDataset, checkWritePerm, mergeDataset, buildLeadIndex }
  from '../functions/api/_acl.js';
import { appendLogs, queryLogs, shardKey } from '../functions/api/_log.js';
import * as loginApi from '../functions/api/auth/login.js';
import * as leadsApi from '../functions/api/leads.js';
import * as fupsApi from '../functions/api/followups.js';
import * as logsApi from '../functions/api/logs.js';
import * as usersApi from '../functions/api/users.js';
import * as statusApi from '../functions/api/status.js';
import * as flowchartApi from '../functions/api/flowchart.js';
import * as mqlApi from '../functions/api/mql.js';

// ---------------------------------------------------------------------------
// 测试框架（极简）
// ---------------------------------------------------------------------------
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
// Blob 状态管理
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
// 测试数据（真实分布模拟）
// 注意：故意把「负责人」放在 index 12、「负责大区」放在 index 13（≠FALLBACK 的 13/14），
// 证明列定位是按表头名而非硬编码索引。
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
    fupRow('F001', 'L001', '王远帅'),   // 线索归王远帅
    fupRow('F002', 'L003', '刘力瑞'),   // 线索属汤显义区但行内负责人是管能区销售 → 继承优先
    fupRow('F003', '', '王远帅'),       // 线索编号为空 → 兜底按负责人
    fupRow('F004', 'L999', '刘力瑞'),   // 线索编号关联不上 → 兜底按负责人
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
  return j.token;
}
async function api(fn, path, opts) {
  const r = await fn.onRequest({ request: req(path, opts), env: ENV });
  let j = null;
  try { j = await r.json(); } catch (e) { /* 非 JSON */ }
  return { status: r.status, json: j, headers: r.headers };
}

// 自制 token（与 _auth.js 同构，用于过期/续期/伪造测试）
function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function craftToken(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const s = await hmac(secret || ENV.AUTH_SECRET, h + '.' + p);
  return h + '.' + p + '.' + s;
}
function payloadOf(token) {
  return JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}
function findRow(data, idCol, id) {
  return data.filter(r => String(r[0]).trim().toLowerCase() === String(id).toLowerCase());
}

// ============================================================================
group('一、认证：16 账号登录 / 错误密码 / token 篡改 / 过期 / 无 token');
// ============================================================================
{
  fullSeed();

  await t('16 个账号正确密码全部登录成功，角色与大区正确', async () => {
    const expect = {
      'yucui@chromai.com': ['admin', '于翠', null],
      'wangqiong@chromai.com': ['admin', '汪琼', null],
      'zhangxin@chromai.com': ['admin', '张欣', null],
      'tangxianyi@chromai.com': ['region', '汤显义', '汤显义'],
      'guanneng@chromai.com': ['region', '管能', '管能'],
      'muzhongren@chromai.com': ['region', '穆忠仁', '穆忠仁'],
      'liujiankai@chromai.com': ['region', '刘健凯', '刘健凯'],   // 海外大区总
      'wangyuanshuai@chromai.com': ['sales', '王远帅', '汤显义'],
      'gaodanfeng@chromai.com': ['sales', '高丹枫', '汤显义'],
      'huangjiangrui@chromai.com': ['sales', '黄江锐', '汤显义'],
      'wangze@chromai.com': ['sales', '王泽', '汤显义'],
      'huyulai@chromai.com': ['sales', '胡雨来', '汤显义'],
      'gaolei@chromai.com': ['sales', '高雷', '汤显义'],
      'liulirui@chromai.com': ['sales', '刘力瑞', '管能'],
      'zhangsaiyun@chromai.com': ['sales', '张塞云', null],       // IVD 业务，不归属任何大区
      'fangge@chromai.com': ['sales', '房戈', null]               // IVD 业务，不归属任何大区
    };
    for (const [email, [role, name, region]] of Object.entries(expect)) {
      const r = await loginApi.onRequest({ request: req('/api/auth/login', {
        method: 'POST', body: { email: email, password: 'chromai2019' } }), env: ENV });
      const j = await r.json();
      assert.strictEqual(r.status, 200, email + ' 应 200');
      assert.strictEqual(j.ok, true, email + ' 登录应成功');
      assert.ok(j.token && j.token.split('.').length === 3, email + ' 应返回三段式 token');
      assert.strictEqual(j.user.role, role, email + ' 角色');
      assert.strictEqual(j.user.name, name, email + ' 姓名');
      assert.strictEqual(j.user.region, region, email + ' 大区');
      const p = payloadOf(j.token);
      assert.strictEqual(p.sub, email); assert.strictEqual(p.role, role);
      assert.ok(p.exp > Math.floor(Date.now() / 1000), 'exp 应在未来');
      assert.ok(!('pwdHash' in j.user) && !('pwdHash' in j), '响应不得泄露 pwdHash');
    }
  });

  await t('邮箱大小写不敏感登录成功（TANGXIANYI@CHROMAI.COM）', async () => {
    const tk = await loginAs('TANGXIANYI@CHROMAI.COM');
    assert.ok(tk, '大写邮箱应可登录');
  });

  await t('错误密码 → 401 且不泄露是邮箱还是密码错', async () => {
    const r = await loginApi.onRequest({ request: req('/api/auth/login', {
      method: 'POST', body: { email: 'yucui@chromai.com', password: 'wrong-pass' } }), env: ENV });
    const j = await r.json();
    assert.strictEqual(r.status, 401);
    assert.strictEqual(j.ok, false);
    assert.ok(!/不存在/.test(j.error || ''), '不应区分邮箱不存在与密码错误');
  });

  await t('未知邮箱 → 401', async () => {
    const r = await loginApi.onRequest({ request: req('/api/auth/login', {
      method: 'POST', body: { email: 'hacker@chromai.com', password: 'chromai2019' } }), env: ENV });
    assert.strictEqual(r.status, 401);
  });

  await t('登录失败会写 login_failed 审计日志（含 IP）', async () => {
    await loginApi.onRequest({ request: req('/api/auth/login', {
      method: 'POST', body: { email: 'yucui@chromai.com', password: 'bad' },
      headers: { 'x-forwarded-for': '1.2.3.4' } }), env: ENV });
    const adminTk = await loginAs('yucui@chromai.com');
    const r = await api(logsApi, '/api/logs?event=login_failed', { token: adminTk });
    assert.strictEqual(r.status, 200);
    // 注意用 IP 精确定位本条（同账号同毫秒可能有多条 login_failed，排序不稳定）
    const item = r.json.items.find(e => e.email === 'yucui@chromai.com' && e.event === 'login_failed' && e.ip === '1.2.3.4');
    assert.ok(item, '应存在带 IP 1.2.3.4 的 login_failed 日志');
    assert.strictEqual(item.result, 'fail');
  });

  await t('登录成功会写 login_success 日志', async () => {
    const adminTk = await loginAs('yucui@chromai.com');
    const r = await api(logsApi, '/api/logs?event=login_success', { token: adminTk });
    const item = r.json.items.find(e => e.email === 'gaodanfeng@chromai.com');
    assert.ok(item, 'gaodanfeng 的 login_success 应被记录');
    assert.strictEqual(item.name, '高丹枫'); assert.strictEqual(item.role, 'sales');
  });

  await t('token 篡改 payload（sales 提权为 admin）→ 验签拒绝', async () => {
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const parts = tk.split('.');
    const p = payloadOf(tk); p.role = 'admin';
    const forged = parts[0] + '.' + b64url(JSON.stringify(p)) + '.' + parts[2];
    const out = await api(leadsApi, '/api/leads', { token: forged });
    assert.strictEqual(out.status, 401, '篡改 payload 应 401');
  });

  await t('token 伪造签名（随机 sig）→ 拒绝', async () => {
    const tk = await loginAs('yucui@chromai.com');
    const forged = tk.split('.').slice(0, 2).join('.') + '.' + '0'.repeat(64);
    const out = await api(usersApi, '/api/users', { token: forged });
    assert.strictEqual(out.status, 401);
  });

  await t('token 用攻击者自选密钥签发 → 拒绝', async () => {
    const forged = await craftToken({ sub: 'yucui@chromai.com', name: '于翠', role: 'admin',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 999999 }, 'attacker-secret');
    const out = await api(leadsApi, '/api/leads', { token: forged });
    assert.strictEqual(out.status, 401);
  });

  await t('过期 token → 拒绝', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await craftToken({ sub: 'yucui@chromai.com', name: '于翠', role: 'admin',
      iat: now - 800000, exp: now - 1000 });
    assert.strictEqual(await verifyToken(expired, ENV), null, 'verifyToken 过期应返回 null');
    const out = await api(leadsApi, '/api/leads', { token: expired });
    assert.strictEqual(out.status, 401);
  });

  await t('token 格式破坏（两段/垃圾）→ 拒绝', async () => {
    assert.strictEqual(await verifyToken('a.b', ENV), null);
    assert.strictEqual(await verifyToken('not-a-token', ENV), null);
    assert.strictEqual(await verifyToken('', ENV), null);
    assert.strictEqual(await verifyToken(null, ENV), null);
  });

  await t('剩余有效期 < 3.5 天 → requireAuth 滑动续签返回 X-New-Token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const nearExp = await craftToken({ sub: 'wangyuanshuai@chromai.com', name: '王远帅', role: 'sales',
      region: '汤显义', iat: now - 600000, exp: now + 86400 });
    const r = await req('/api/leads', { token: nearExp });
    const auth = await requireAuth(r, ENV);
    assert.ok(auth, '应鉴权通过');
    assert.ok(auth.newToken, '剩余<3.5天应返回新 token');
    const p2 = payloadOf(auth.newToken);
    assert.ok(p2.exp > now + 6 * 86400, '新 token 应为完整 7 天有效期');
  });

  await t('剩余有效期充足 → 不续签', async () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = await craftToken({ sub: 'yucui@chromai.com', name: '于翠', role: 'admin',
      iat: now, exp: now + 6 * 86400 });
    const auth = await requireAuth(req('/api/leads', { token: fresh }), ENV);
    assert.ok(auth && auth.newToken === null, '不应续签');
  });

  await t('无 token 访问全部业务 API → 401（status 除外）', async () => {
    for (const [fn, path] of [[leadsApi, '/api/leads'], [fupsApi, '/api/followups'],
      [logsApi, '/api/logs'], [usersApi, '/api/users'], [flowchartApi, '/api/flowchart'], [mqlApi, '/api/mql']]) {
      const out = await api(fn, path, {});
      assert.strictEqual(out.status, 401, path + ' 无 token 应 401');
    }
    const st = await api(statusApi, '/api/status', {});
    assert.strictEqual(st.status, 200, 'status 保持健康检查 200');
    assert.strictEqual(st.json.status, 'running');
  });
}

// ============================================================================
group('二、读隔离边界（GET 行级过滤）');
// ============================================================================
{
  fullSeed();

  await t('sales 王远帅 GET leads → 仅本人行 L001/L012，无他人行/未分配行', async () => {
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const r = await api(leadsApi, '/api/leads', { token: tk });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.headers, LH, 'headers 应原样返回');
    assert.strictEqual(r.json.data.length, 2, '应只有 2 行');
    assert.deepStrictEqual(r.json.data.map(x => x[0]).sort(), ['L001', 'L012']);
    r.json.data.forEach(row => assert.strictEqual(row[12], '王远帅'));
  });

  await t('region 汤显义 GET leads → 本大区 8 行（含 7 名销售+本人），不含管能/穆忠仁/未分配', async () => {
    const tk = await loginAs('tangxianyi@chromai.com');
    const r = await api(leadsApi, '/api/leads', { token: tk });
    assert.strictEqual(r.json.data.length, 8);
    r.json.data.forEach(row => assert.strictEqual(row[13], '汤显义'));
    const ids = r.json.data.map(x => x[0]).sort();
    assert.deepStrictEqual(ids, ['L001', 'L002', 'L003', 'L004', 'L005', 'L006', 'L007', 'L012']);
  });

  await t('region 管能 / 穆忠仁 GET leads → 各自本区行', async () => {
    const tk1 = await loginAs('guanneng@chromai.com');
    const r1 = await api(leadsApi, '/api/leads', { token: tk1 });
    assert.deepStrictEqual(r1.json.data.map(x => x[0]).sort(), ['L008', 'L009']);
    const tk2 = await loginAs('muzhongren@chromai.com');
    const r2 = await api(leadsApi, '/api/leads', { token: tk2 });
    assert.deepStrictEqual(r2.json.data.map(x => x[0]), ['L010']);
  });

  await t('未分配行（负责人/负责大区为空）仅 admin 可见', async () => {
    const adminTk = await loginAs('yucui@chromai.com');
    const ra = await api(leadsApi, '/api/leads', { token: adminTk });
    assert.ok(ra.json.data.some(x => x[0] === 'L011'), 'admin 应见未分配行 L011');
    for (const email of ['tangxianyi@chromai.com', 'guanneng@chromai.com', 'wangyuanshuai@chromai.com', 'liulirui@chromai.com']) {
      const tk = await loginAs(email);
      const r = await api(leadsApi, '/api/leads', { token: tk });
      assert.ok(!r.json.data.some(x => x[0] === 'L011'), email + ' 不应见未分配行');
    }
  });

  await t('admin GET leads → 全量 12 行，headers 形状与顺序不变（回归契约）', async () => {
    const tk = await loginAs('wangqiong@chromai.com');
    const r = await api(leadsApi, '/api/leads', { token: tk });
    assert.strictEqual(r.json.data.length, 12);
    assert.deepStrictEqual(r.json.headers, LH);
    assert.deepStrictEqual(r.json.data, seedLeads(), 'admin 视角应与升级前等价');
  });

  await t('fups 主规则：线索归属继承优先 —— F002（线索 L003 属汤显义区，行内负责人刘力瑞）汤显义可见、刘力瑞/管能不可见', async () => {
    const tkT = await loginAs('tangxianyi@chromai.com');
    const rT = await api(fupsApi, '/api/followups', { token: tkT });
    assert.ok(rT.json.data.some(x => x[0] === 'F002'), '汤显义应可见 F002（按线索继承）');
    const tkL = await loginAs('liulirui@chromai.com');
    const rL = await api(fupsApi, '/api/followups', { token: tkL });
    assert.ok(!rL.json.data.some(x => x[0] === 'F002'), '刘力瑞不应见 F002（继承优先于行内负责人）');
    const tkG = await loginAs('guanneng@chromai.com');
    const rG = await api(fupsApi, '/api/followups', { token: tkG });
    assert.ok(!rG.json.data.some(x => x[0] === 'F002'), '管能不应见 F002');
  });

  await t('fups 兜底：线索编号为空（F003）/关联不上（F004）→ 按行内负责人判定', async () => {
    const tkW = await loginAs('wangyuanshuai@chromai.com');
    const rW = await api(fupsApi, '/api/followups', { token: tkW });
    assert.deepStrictEqual(rW.json.data.map(x => x[0]).sort(), ['F001', 'F003'], '王远帅应见 F001(继承)+F003(兜底)');
    const tkL = await loginAs('liulirui@chromai.com');
    const rL = await api(fupsApi, '/api/followups', { token: tkL });
    assert.deepStrictEqual(rL.json.data.map(x => x[0]).sort(), ['F004', 'F005'],
      '刘力瑞应见 F004(兜底)+F005(其名下线索 L008 的跟进，继承)');
    const tkG = await loginAs('guanneng@chromai.com');
    const rG = await api(fupsApi, '/api/followups', { token: tkG });
    assert.deepStrictEqual(rG.json.data.map(x => x[0]).sort(), ['F004', 'F005'], '管能应见 F004(兜底)+F005(继承)');
    const tkM = await loginAs('muzhongren@chromai.com');
    const rM = await api(fupsApi, '/api/followups', { token: tkM });
    assert.deepStrictEqual(rM.json.data.map(x => x[0]), ['F006']);
  });

  await t('fups 汤显义整体可见集 = F001/F002/F003/F007（4 行），admin 全量 7 行', async () => {
    const tkT = await loginAs('tangxianyi@chromai.com');
    const rT = await api(fupsApi, '/api/followups', { token: tkT });
    assert.deepStrictEqual(rT.json.data.map(x => x[0]).sort(), ['F001', 'F002', 'F003', 'F007']);
    const tkA = await loginAs('yucui@chromai.com');
    const rA = await api(fupsApi, '/api/followups', { token: tkA });
    assert.strictEqual(rA.json.data.length, 7);
    assert.deepStrictEqual(rA.json.headers, FH);
  });

  await t('无 leads 数据时 fups 读取不报错（全部走兜底）', async () => {
    resetBlob();
    rawSet('followups', { headers: FH.slice(), data: seedFups() });
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const r = await api(fupsApi, '/api/followups', { token: tk });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.data.map(x => x[0]).sort(), ['F001', 'F003'],
      '无 leads 时全走兜底：王远帅仅见行内负责人=本人的 F001/F003');
  });
}

// ============================================================================
group('三、写合并与越权（最高优先级：原子性 / 子集合并 / 字段锁定）');
// ============================================================================
{
  // ---- 3.1 子集回传合并：绝不毁掉其他大区数据 ----
  await t('【核心】sales 只回传自己子集（改 1 行）→ 其他 10 行逐行逐字段原封不动', async () => {
    fullSeed();
    const snapshot = JSON.parse(JSON.stringify(seedLeads()));
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    assert.strictEqual(got.json.data.length, 2);
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows[0][9] = '已联系'; // 修改 L001 的状态
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: rows }
    });
    assert.strictEqual(post.status, 200, 'POST 应成功');
    assert.strictEqual(post.json.updated, 1);
    assert.strictEqual(post.json.count, 12, '总量应保持 12');
    const after = rawGet('leads');
    assert.strictEqual(after.data.length, 12);
    // L001 已更新
    const l1 = after.data.find(x => x[0] === 'L001');
    assert.strictEqual(l1[9], '已联系');
    // 其他 11 行逐字段比对（含其他大区 L008-L010、未分配 L011）
    for (const oldRow of snapshot) {
      if (oldRow[0] === 'L001') continue;
      const now = after.data.find(x => x[0] === oldRow[0]);
      assert.ok(now, '行 ' + oldRow[0] + ' 不应丢失');
      assert.deepStrictEqual(now, oldRow, '行 ' + oldRow[0] + ' 应原封不动');
    }
  });

  await t('【核心】sales POST 夹带修改他人行（L002 高丹枫）→ 403 + forbidden 日志 + 数据零变更', async () => {
    fullSeed();
    const snapshot = JSON.parse(JSON.stringify(seedLeads()));
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    const stolen = JSON.parse(JSON.stringify(snapshot.find(x => x[0] === 'L002')));
    stolen[9] = '被篡改';
    rows.push(stolen);
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: rows }
    });
    assert.strictEqual(post.status, 403, '夹带他人行应整体 403');
    assert.strictEqual(post.json.error, 'forbidden');
    assert.ok(post.json.violations.some(v => v.id === 'l002'), 'violations 应含 L002');
    const after = rawGet('leads');
    assert.deepStrictEqual(after.data, snapshot, '任何行都不得被修改（原子拒绝）');
    const adminTk = await loginAs('yucui@chromai.com');
    const lg = await api(logsApi, '/api/logs?event=forbidden', { token: adminTk });
    const item = lg.json.items.find(e => e.email === 'wangyuanshuai@chromai.com' && e.objectType === 'lead');
    assert.ok(item, '应写 forbidden 日志');
    assert.ok(String(item.objectId).toLowerCase().indexOf('l002') >= 0, 'forbidden 日志应记录越权对象');
  });

  await t('【核心】原子性：合法更新 + 越权行混在同一 POST → 全部拒绝，合法更新也不生效', async () => {
    fullSeed();
    const snapshot = JSON.parse(JSON.stringify(seedLeads()));
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows[0][9] = '合法修改';
    const stolen = JSON.parse(JSON.stringify(snapshot.find(x => x[0] === 'L009')));
    stolen[9] = '非法修改';
    rows.push(stolen);
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: rows }
    });
    assert.strictEqual(post.status, 403);
    assert.deepStrictEqual(rawGet('leads').data, snapshot, '原子拒绝：合法部分也不得落库');
  });

  // ---- 3.2 字段锁定 ----
  await t('sales 把自己行负责人改派给外大区（刘力瑞）→ 锁回本人', async () => {
    fullSeed();
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows[0][12] = '刘力瑞'; // L001 负责人 → 管能区销售
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: rows }
    });
    assert.strictEqual(post.status, 200);
    const l1 = rawGet('leads').data.find(x => x[0] === 'L001');
    assert.strictEqual(l1[12], '王远帅', '外大区改派应被锁回本人');
    assert.strictEqual(l1[13], '汤显义', '负责大区应强制本人所属大区');
  });

  await t('sales 把自己行负责人改派给同大区同事（高丹枫）→ 放行', async () => {
    fullSeed();
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows[0][12] = '高丹枫'; // L001 → 同大区
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: rows }
    });
    assert.strictEqual(post.status, 200, '同大区改派应放行');
    const l1 = rawGet('leads').data.find(x => x[0] === 'L001');
    assert.strictEqual(l1[12], '高丹枫');
    assert.strictEqual(l1[13], '汤显义');
  });

  await t('sales 新增行负责人写外大区销售 → 锁回本人；写本人 → 保留', async () => {
    fullSeed();
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const newRow1 = leadRow('L100', '刘力瑞', '管能');  // 外大区 → 锁回
    const newRow2 = leadRow('L101', '王远帅', '');      // 大区留空 → 强制补齐
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: [newRow1, newRow2] }
    });
    assert.strictEqual(post.status, 200);
    assert.strictEqual(post.json.created, 2);
    const data = rawGet('leads').data;
    const l100 = data.find(x => x[0] === 'L100');
    const l101 = data.find(x => x[0] === 'L101');
    assert.strictEqual(l100[12], '王远帅', '外大区负责人应锁回本人');
    assert.strictEqual(l100[13], '汤显义');
    assert.strictEqual(l101[13], '汤显义', '负责大区应强制补齐');
  });

  await t('region 汤显义把行负责人改成非本大区（刘力瑞）→ 403 且数据不变', async () => {
    fullSeed();
    const snapshot = JSON.parse(JSON.stringify(seedLeads()));
    const tk = await loginAs('tangxianyi@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows[0][12] = '刘力瑞'; // L001 → 管能区
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: rows }
    });
    assert.strictEqual(post.status, 403, 'region 改派非本大区应 403');
    assert.deepStrictEqual(rawGet('leads').data, snapshot);
  });

  await t('region 汤显义改派本大区（L002 高丹枫→高雷）→ 放行；region 新增行负责人非本大区 → 403', async () => {
    fullSeed();
    const tk = await loginAs('tangxianyi@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    const l2 = rows.find(x => x[0] === 'L002');
    l2[12] = '高雷';
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: rows }
    });
    assert.strictEqual(post.status, 200);
    assert.strictEqual(rawGet('leads').data.find(x => x[0] === 'L002')[12], '高雷');

    // 新增越权
    const post2 = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: [leadRow('L200', '刘力瑞', '管能')] }
    });
    assert.strictEqual(post2.status, 403, 'region 新增非本大区负责人应 403');
    assert.ok(!rawGet('leads').data.some(x => x[0] === 'L200'));
  });

  await t('region 新增行负责人为空 → 兜底为本人（不产生未分配孤儿行）', async () => {
    fullSeed();
    const tk = await loginAs('tangxianyi@chromai.com');
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: [leadRow('L201', '', '')] }
    });
    assert.strictEqual(post.status, 200);
    const l = rawGet('leads').data.find(x => x[0] === 'L201');
    assert.strictEqual(l[12], '汤显义');
    assert.strictEqual(l[13], '汤显义');
  });

  // ---- 3.3 headers 增删列 ----
  await t('POST 新增自定义列 → headers 并集保序，其他行新列补空、不串列', async () => {
    fullSeed();
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const newH = LH.concat(['自定义列A']);
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows[0].push('A1'); // L001 增加新列值
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: newH, data: rows }
    });
    assert.strictEqual(post.status, 200);
    const after = rawGet('leads');
    assert.deepStrictEqual(after.headers, LH.concat(['自定义列A']), '列并集保序');
    const l1 = after.data.find(x => x[0] === 'L001');
    assert.strictEqual(l1[15], 'A1');
    const l8 = after.data.find(x => x[0] === 'L008');
    assert.strictEqual(l8[15], '', '其他行新列应为空');
    assert.strictEqual(l8[12], '刘力瑞', '其他行负责人列不得串位');
    assert.strictEqual(l8[13], '管能', '其他行负责大区列不得串位');
    assert.strictEqual(after.data.length, 12, '行数不变');
  });

  await t('POST 删除自定义列（body 缺列）→ 旧列数据保留不丢', async () => {
    fullSeed();
    rawSet('leads', { headers: LH.concat(['自定义列A']), data: seedLeads().map(r => r.concat(['旧值' + r[0]])) });
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    // 前端删掉了「自定义列A」和「备注」，POST 只带前 13 列
    const bodyH = LH.slice(0, 13);
    const rows = got.json.data.map(r => r.slice(0, 13));
    rows[0][9] = '改状态';
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: bodyH, data: rows }
    });
    assert.strictEqual(post.status, 200);
    const after = rawGet('leads');
    assert.deepStrictEqual(after.headers, LH.concat(['自定义列A']), '被删列仍保留在表头');
    const l1 = after.data.find(x => x[0] === 'L001');
    assert.strictEqual(l1[9], '改状态', '提交的修改生效');
    assert.strictEqual(l1[14], '备注-L001', '未提交的备注列沿用旧值');
    assert.strictEqual(l1[15], '旧值L001', '未提交的自定义列沿用旧值');
    const l9 = after.data.find(x => x[0] === 'L009');
    assert.strictEqual(l9[15], '旧值L009', '他人行自定义列不丢');
  });

  // ---- 3.4 删除语义 ----
  await t('sales 删除自己的行（POST 不带 L012）→ L012 删除，他人行原封不动', async () => {
    fullSeed();
    const snapshot = JSON.parse(JSON.stringify(seedLeads()));
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = got.json.data.filter(x => x[0] !== 'L012'); // 只回传 L001
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: rows }
    });
    assert.strictEqual(post.status, 200);
    assert.strictEqual(post.json.deleted, 1);
    const after = rawGet('leads');
    assert.ok(!after.data.some(x => x[0] === 'L012'), 'L012 应被删除');
    for (const oldRow of snapshot) {
      if (oldRow[0] === 'L012') continue;
      const now = after.data.find(x => x[0] === oldRow[0]);
      assert.ok(now && JSON.stringify(now) === JSON.stringify(oldRow), '行 ' + oldRow[0] + ' 应原封不动');
    }
  });

  await t('body.data=[]：可见集非空的账号回传空数组 → 仅删本人可见行，其他大区数据毫发无损', async () => {
    fullSeed();
    const snapshot = JSON.parse(JSON.stringify(seedLeads()));
    const tk = await loginAs('muzhongren@chromai.com'); // 只可见 L010
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: [] }
    });
    assert.strictEqual(post.status, 200, '空数组应正常处理不报错');
    const after = rawGet('leads');
    assert.ok(!after.data.some(x => x[0] === 'L010'), '本人可见行 L010 被删除（全量覆盖协议语义）');
    assert.strictEqual(after.data.length, 11);
    for (const oldRow of snapshot) {
      if (oldRow[0] === 'L010') continue;
      const now = after.data.find(x => x[0] === oldRow[0]);
      assert.ok(now && JSON.stringify(now) === JSON.stringify(oldRow), '其他行 ' + oldRow[0] + ' 必须原封不动');
    }
    // 可见集已空，再次空数组 POST → 合法无副作用
    const post2 = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: [] }
    });
    assert.strictEqual(post2.status, 200);
    assert.strictEqual(rawGet('leads').data.length, 11, '不得再删任何行');
  });

  await t('sales 无法通过 POST 删除他人行：子集天然不含他人行；夹带他人 id 的新行不算删除', async () => {
    fullSeed();
    const tk = await loginAs('wangyuanshuai@chromai.com');
    // 直接调底层：oldVisible 判定确保删除仅限可见集
    const old = rawGet('leads');
    const user = { email: 'wangyuanshuai@chromai.com', name: '王远帅', role: 'sales', region: '汤显义' };
    const d = diffDataset(user, old, { headers: LH.slice(), data: [] }, 'lead');
    const checked = checkWritePerm(user, d, 'lead');
    const merged = mergeDataset(old, d, checked, 'lead');
    assert.deepStrictEqual(merged.data.map(x => x[0]).sort(),
      ['L002', 'L003', 'L004', 'L005', 'L006', 'L007', 'L008', 'L009', 'L010', 'L011'],
      'sales 空回传只删 L001/L012，其他全部保留');
  });

  // ---- 3.5 fups 写路径 ----
  await t('fups 写合并：sales 回传子集修改 F001 → 其他 fups 行原封不动，leads 不受影响', async () => {
    fullSeed();
    const fupsSnap = JSON.parse(JSON.stringify(seedFups()));
    const leadsSnap = JSON.parse(JSON.stringify(seedLeads()));
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const got = await api(fupsApi, '/api/followups', { token: tk });
    assert.deepStrictEqual(got.json.data.map(x => x[0]).sort(), ['F001', 'F003']);
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows[0][4] = '新跟进内容';
    const post = await api(fupsApi, '/api/followups', {
      method: 'POST', token: tk, body: { headers: FH.slice(), data: rows }
    });
    assert.strictEqual(post.status, 200);
    assert.strictEqual(post.json.updated, 1);
    const after = rawGet('followups');
    assert.strictEqual(after.data.length, 7);
    assert.strictEqual(after.data.find(x => x[0] === 'F001')[4], '新跟进内容');
    for (const oldRow of fupsSnap) {
      if (oldRow[0] === 'F001') continue;
      const now = after.data.find(x => x[0] === oldRow[0]);
      assert.ok(now && JSON.stringify(now) === JSON.stringify(oldRow), 'fup ' + oldRow[0] + ' 应原封不动');
    }
    assert.deepStrictEqual(rawGet('leads').data, leadsSnap, 'leads 不受 fups 写影响');
  });

  await t('fups 越权：sales 夹带 F005（管能区线索 L008 的跟进）→ 403 原子拒绝', async () => {
    fullSeed();
    const fupsSnap = JSON.parse(JSON.stringify(seedFups()));
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const got = await api(fupsApi, '/api/followups', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    const stolen = JSON.parse(JSON.stringify(fupsSnap.find(x => x[0] === 'F005')));
    stolen[4] = '越权改写';
    rows.push(stolen);
    const post = await api(fupsApi, '/api/followups', {
      method: 'POST', token: tk, body: { headers: FH.slice(), data: rows }
    });
    assert.strictEqual(post.status, 403);
    assert.deepStrictEqual(rawGet('followups').data, fupsSnap, 'fups 数据零变更');
  });

  await t('fups sales 负责人锁：F001 负责人改成刘力瑞 → 锁回王远帅', async () => {
    fullSeed();
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const got = await api(fupsApi, '/api/followups', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows[0][5] = '刘力瑞';
    const post = await api(fupsApi, '/api/followups', {
      method: 'POST', token: tk, body: { headers: FH.slice(), data: rows }
    });
    assert.strictEqual(post.status, 200);
    assert.strictEqual(rawGet('followups').data.find(x => x[0] === 'F001')[5], '王远帅');
  });

  await t('admin POST leads 全量回传（升级前老协议）→ 全部行按提交值覆盖，等价于升级前行为', async () => {
    fullSeed();
    const tk = await loginAs('yucui@chromai.com');
    const rows = JSON.parse(JSON.stringify(seedLeads()));
    rows.find(x => x[0] === 'L011')[9] = '已分配';
    rows.find(x => x[0] === 'L008')[12] = '管能'; // admin 改派不受限
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: rows }
    });
    assert.strictEqual(post.status, 200);
    assert.strictEqual(post.json.updated, 2);
    const after = rawGet('leads');
    assert.strictEqual(after.data.find(x => x[0] === 'L011')[9], '已分配');
    assert.strictEqual(after.data.find(x => x[0] === 'L008')[12], '管能');
  });

  await t('GET 后原样 POST 回去（无修改）→ 0 更新 0 删除，数据零漂移', async () => {
    fullSeed();
    for (const email of ['wangyuanshuai@chromai.com', 'tangxianyi@chromai.com', 'guanneng@chromai.com']) {
      const tk = await loginAs(email);
      const got = await api(leadsApi, '/api/leads', { token: tk });
      const post = await api(leadsApi, '/api/leads', {
        method: 'POST', token: tk, body: { headers: got.json.headers, data: got.json.data }
      });
      assert.strictEqual(post.status, 200, email);
      assert.strictEqual(post.json.updated, 0, email + ' 不应产生更新');
      assert.strictEqual(post.json.deleted, 0, email + ' 不应产生删除');
      assert.strictEqual(post.json.created, 0, email + ' 不应产生新增');
    }
    assert.deepStrictEqual(rawGet('leads').data, seedLeads(), '数据应零漂移');
  });
}

// ============================================================================
group('四、审计日志（事件 / diff / import 聚合 / 权限）');
// ============================================================================
{
  await t('update 事件含字段级 {field, old, new} diff', async () => {
    fullSeed();
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows[0][9] = '已联系';
    await api(leadsApi, '/api/leads', { method: 'POST', token: tk, body: { headers: LH.slice(), data: rows } });
    const adminTk = await loginAs('yucui@chromai.com');
    const r = await api(logsApi, '/api/logs?event=update', { token: adminTk });
    const item = r.json.items.find(e => e.email === 'wangyuanshuai@chromai.com' && e.objectId === 'l001');
    assert.ok(item, '应存在 L001 的 update 日志');
    assert.strictEqual(item.role, 'sales');
    const d = item.diff.find(x => x.field === '状态');
    assert.ok(d, 'diff 应含状态字段');
    assert.strictEqual(d.old, '新建');
    assert.strictEqual(d.new, '已联系');
  });

  await t('create / delete 事件正确生成', async () => {
    fullSeed();
    const tk = await loginAs('wangyuanshuai@chromai.com');
    await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: [leadRow('L900', '王远帅', '汤显义')] }
    });
    const got = await api(leadsApi, '/api/leads', { token: tk });
    await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: got.json.data.filter(x => x[0] === 'L001') }
    }); // 删掉 L012 与 L900
    const adminTk = await loginAs('yucui@chromai.com');
    const r = await api(logsApi, '/api/logs', { token: adminTk, });
    const items = r.json.items;
    const create = items.find(e => e.event === 'create' && e.objectId === 'l900');
    assert.ok(create, 'L900 create 事件应存在');
    const del = items.filter(e => e.event === 'delete' && ['l012', 'l900'].indexOf(e.objectId) >= 0);
    assert.strictEqual(del.length, 2, 'L012 与 L900 的 delete 事件应各一条');
  });

  await t('单次 POST 新增 ≥10 行 → 聚合为一条 import 日志（<10 行则逐行 create）', async () => {
    fullSeed();
    const tk = await loginAs('yucui@chromai.com');
    const batch = [];
    for (let i = 1; i <= 12; i++) batch.push(leadRow('B' + String(i).padStart(3, '0'), '高丹枫', '汤显义'));
    // 批量删除保护整改后：POST 必须回传完整可见快照（旧数据 + 新行），
    // 只传新行会把 12 条旧行误判为删除（≥10 条无确认会被服务端整体拒绝）
    const cur = await api(leadsApi, '/api/leads', { token: tk });
    await api(leadsApi, '/api/leads', { method: 'POST', token: tk, body: { headers: LH.slice(), data: cur.json.data.concat(batch) } });
    // 小批量（同样带完整快照）
    const cur2 = await api(leadsApi, '/api/leads', { token: tk });
    await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: cur2.json.data.concat([leadRow('B900', '高丹枫', '汤显义')]) }
    });
    const r = await api(logsApi, '/api/logs', { token: tk });
    const imp = r.json.items.filter(e => e.event === 'import');
    assert.strictEqual(imp.length, 1, '12 行批量应聚合为 1 条 import');
    assert.ok(/12/.test(imp[0].detail || ''), 'import detail 应含行数');
    const creates = r.json.items.filter(e => e.event === 'create' && e.objectId === 'b900');
    assert.strictEqual(creates.length, 1, '单行新增应记 create 而非 import');
    assert.strictEqual(IMPORT_THRESHOLD, 10);
  });

  await t('GET /api/logs 非 admin → 403', async () => {
    fullSeed();
    for (const email of ['tangxianyi@chromai.com', 'wangyuanshuai@chromai.com']) {
      const tk = await loginAs(email);
      const r = await api(logsApi, '/api/logs', { token: tk });
      assert.strictEqual(r.status, 403, email + ' 查日志应 403');
    }
  });

  await t('POST /api/logs 仅放行 session 级事件；身份取自 token 不可伪造', async () => {
    fullSeed();
    const tk = await loginAs('gaodanfeng@chromai.com');
    const bad = await api(logsApi, '/api/logs', {
      method: 'POST', token: tk, body: { event: 'update', objectId: 'L001', diff: [{ field: 'x', old: '1', new: '2' }] }
    });
    assert.strictEqual(bad.status, 403, '伪造 update 事件应 403');
    const okLogout = await api(logsApi, '/api/logs', {
      method: 'POST', token: tk,
      body: { event: 'logout', email: 'yucui@chromai.com', name: '于翠', role: 'admin' } // 夹带伪造身份
    });
    assert.strictEqual(okLogout.status, 200, 'logout 应放行');
    const adminTk = await loginAs('yucui@chromai.com');
    const r = await api(logsApi, '/api/logs?event=logout', { token: adminTk });
    const item = r.json.items[0];
    assert.strictEqual(item.email, 'gaodanfeng@chromai.com', '身份必须取自 token 而非 body');
    assert.strictEqual(item.role, 'sales');
  });

  await t('日志按日分片 key 正确（UTC+8 日界）且 admin 可按邮箱/事件过滤', async () => {
    fullSeed();
    await loginAs('gaodanfeng@chromai.com'); // 产生一条可过滤的 login_success
    const adminTk = await loginAs('yucui@chromai.com');
    const r = await api(logsApi, '/api/logs?email=gaodanfeng&event=login_success', { token: adminTk });
    assert.ok(r.json.items.length >= 1);
    r.json.items.forEach(e => {
      assert.strictEqual(e.email, 'gaodanfeng@chromai.com');
      assert.strictEqual(e.event, 'login_success');
    });
    const key = shardKey(Date.now());
    assert.ok(/^logs\/\d{4}-\d{2}-\d{2}$/.test(key), '分片 key 形如 logs/YYYY-MM-DD');
  });

  await t('logout 事件由前端上报路径可用（logs POST 已覆盖），forbidden 事件记录越权者身份', async () => {
    fullSeed();
    const tk = await loginAs('wangze@chromai.com'); // 王泽：本人行 L004
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    const stolen = JSON.parse(JSON.stringify(seedLeads().find(x => x[0] === 'L011'))); // 未分配行仅 admin
    stolen[9] = 'x';
    rows.push(stolen);
    await api(leadsApi, '/api/leads', { method: 'POST', token: tk, body: { headers: LH.slice(), data: rows } });
    const adminTk = await loginAs('yucui@chromai.com');
    const r = await api(logsApi, '/api/logs?event=forbidden', { token: adminTk });
    const item = r.json.items.find(e => e.email === 'wangze@chromai.com');
    assert.ok(item, '王泽的 forbidden 应被记录');
    assert.strictEqual(item.result, 'fail');
  });
}

// ============================================================================
group('五、配置类 API 与账号接口');
// ============================================================================
{
  await t('flowchart/mql：登录用户可读，非 admin POST → 403 + forbidden 日志，admin POST → 放行', async () => {
    fullSeed();
    const tkS = await loginAs('huangjiangrui@chromai.com');
    const rGet = await api(flowchartApi, '/api/flowchart', { token: tkS });
    assert.strictEqual(rGet.status, 200, 'sales 读流程图应放行');
    const rPost = await api(flowchartApi, '/api/flowchart', {
      method: 'POST', token: tkS, body: { nodes: [] }
    });
    assert.strictEqual(rPost.status, 403);
    const rMql = await api(mqlApi, '/api/mql', { method: 'POST', token: tkS, body: { rules: [] } });
    assert.strictEqual(rMql.status, 403);
    const tkA = await loginAs('yucui@chromai.com');
    const rOk = await api(flowchartApi, '/api/flowchart', {
      method: 'POST', token: tkA, body: { nodes: [1, 2] }
    });
    assert.strictEqual(rOk.status, 200);
    const back = await api(flowchartApi, '/api/flowchart', { token: tkA });
    assert.deepStrictEqual(back.json, { nodes: [1, 2] }, '配置应可写读回');
    const lg = await api(logsApi, '/api/logs?event=forbidden', { token: tkA });
    assert.ok(lg.json.items.some(e => e.email === 'huangjiangrui@chromai.com'), 'forbidden 日志应记录');
  });

  await t('/api/users：admin 可见 16 账号且无 pwdHash；非 admin → 403', async () => {
    fullSeed();
    const tkA = await loginAs('zhangxin@chromai.com');
    const r = await api(usersApi, '/api/users', { token: tkA });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.users.length, 16);
    assert.strictEqual(DEFAULT_USERS.length, 16);
    r.json.users.forEach(u => assert.ok(!('pwdHash' in u), '不得下发 pwdHash'));
    const names = r.json.users.map(u => u.name);
    for (const n of ['于翠', '汪琼', '张欣', '汤显义', '穆忠仁', '管能', '王远帅', '高丹枫', '黄江锐', '王泽', '胡雨来', '高雷', '刘力瑞',
                     '刘健凯', '张塞云', '房戈'])
      assert.ok(names.indexOf(n) >= 0, '账号 ' + n + ' 应在清单');
    // 新增成员的角色/大区口径
    const ljk = r.json.users.find(u => u.email === 'liujiankai@chromai.com');
    assert.strictEqual(ljk.role, 'region'); assert.strictEqual(ljk.region, '刘健凯');
    const zsy = r.json.users.find(u => u.email === 'zhangsaiyun@chromai.com');
    assert.strictEqual(zsy.role, 'sales'); assert.strictEqual(zsy.region, null, 'IVD 销售不归属任何大区');
    const fg = r.json.users.find(u => u.email === 'fangge@chromai.com');
    assert.strictEqual(fg.role, 'sales'); assert.strictEqual(fg.region, null, 'IVD 销售不归属任何大区');
    const tkS = await loginAs('gaolei@chromai.com');
    const r2 = await api(usersApi, '/api/users', { token: tkS });
    assert.strictEqual(r2.status, 403);
  });

  await t('users 自愈：Blob 无 users 键时首次登录自动播种（幂等，不覆盖已有）', async () => {
    resetBlob();
    const tk = await loginAs('tangxianyi@chromai.com'); // 触发 loadUsers 自愈
    assert.ok(tk);
    const users = rawGet('users').users;
    assert.strictEqual(users.length, 16);
    // 管理员改密后不被覆盖（模拟管理员已改 user[0] 的 hash）
    const stored = rawGet('users');
    stored.users[0].pwdHash = 'custom-hash';
    rawSet('users', stored);
    const tk2 = await loginAs('tangxianyi@chromai.com');
    assert.ok(tk2);
    assert.strictEqual(rawGet('users').users[0].pwdHash, 'custom-hash', '已有 users 不得被自愈覆盖');
  });

  await t('users 增量自愈：已存在 users 时，配置新增的账号按 email 补入且不改动已有账号', async () => {
    resetBlob();
    // 先造一份「旧版」11 账号库（模拟线上早于本次扩充的 users）
    const old = (await buildDefaultUsers()).filter(u =>
      !['liujiankai@chromai.com', 'zhangsaiyun@chromai.com', 'fangge@chromai.com'].includes(u.email));
    old[0].pwdHash = 'admin-changed-hash';
    rawSet('users', { users: old });
    assert.strictEqual(old.length, 13);
    await loginAs('tangxianyi@chromai.com');               // 触发 loadUsers 增量合并
    const after = rawGet('users').users;
    assert.strictEqual(after.length, 16, '新账号应被补入');
    assert.strictEqual(after[0].pwdHash, 'admin-changed-hash', '已有账号的密码哈希不得被覆盖');
    ['liujiankai@chromai.com', 'zhangsaiyun@chromai.com', 'fangge@chromai.com'].forEach(e =>
      assert.ok(after.some(u => u.email === e), e + ' 应被补入'));
    // 补入后新账号立即可登录
    const tk = await loginAs('fangge@chromai.com');
    assert.ok(tk, '补入的账号应可立即登录');
    // 幂等：再触发一次不应重复追加
    await loginAs('tangxianyi@chromai.com');
    assert.strictEqual(rawGet('users').users.length, 16, '重复触发不得重复追加');
  });

  await t('status：带 token 返回角色分片 lastModified；写入后对应分片被触达', async () => {
    fullSeed();
    const tkW = await loginAs('wangyuanshuai@chromai.com');
    const before = await api(statusApi, '/api/status', { token: tkW });
    assert.strictEqual(before.status, 200);
    assert.ok(typeof before.json.lastModified === 'number');
    const t0 = before.json.lastModified;
    // 管能区写入 → 管能分片触达，王远帅分片不动
    const tkG = await loginAs('guanneng@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tkG });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows[0][9] = '管能改';
    await api(leadsApi, '/api/leads', { method: 'POST', token: tkG, body: { headers: LH.slice(), data: rows } });
    const afterW = await api(statusApi, '/api/status', { token: tkW });
    assert.strictEqual(afterW.json.lastModified, t0, '他人大区写入不应触达王远帅分片');
    const afterG = await api(statusApi, '/api/status', { token: tkG });
    assert.ok(afterG.json.lastModified > t0, '本人大区写入应触达分片');
    const adminTk = await loginAs('yucui@chromai.com');
    const afterA = await api(statusApi, '/api/status', { token: adminTk });
    assert.ok(afterA.json.lastModified > t0, 'admin 分片任何写都触达');
  });

  await t('改派触达双方：sales 把行改派给高丹枫后 S:高丹枫 分片应更新', async () => {
    fullSeed();
    const tkW = await loginAs('wangyuanshuai@chromai.com');
    const tkD = await loginAs('gaodanfeng@chromai.com');
    const beforeD = await api(statusApi, '/api/status', { token: tkD });
    const got = await api(leadsApi, '/api/leads', { token: tkW });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows[0][12] = '高丹枫';
    await api(leadsApi, '/api/leads', { method: 'POST', token: tkW, body: { headers: LH.slice(), data: rows } });
    const afterD = await api(statusApi, '/api/status', { token: tkD });
    assert.ok(afterD.json.lastModified > beforeD.json.lastModified, '被改派人分片应被触达');
    // 高丹枫现在能看到 L001
    const gotD = await api(leadsApi, '/api/leads', { token: tkD });
    assert.ok(gotD.json.data.some(x => x[0] === 'L001'), '改派后高丹枫应可见 L001');
  });
}

// ============================================================================
group('六、共享库单元测试（边界条件）');
// ============================================================================
{
  await t('colIndex 按表头名定位，缺失时用 fallback；脏数据 cell 越界安全', async () => {
    const { colIndex } = await import('../functions/api/_acl.js');
    assert.strictEqual(colIndex(LH, '负责人', 13), 12);
    assert.strictEqual(colIndex(LH, '不存在列', 13), 13);
    assert.strictEqual(colIndex(null, '负责人', 13), 13);
  });

  await t('行身份 trim + 大小写不敏感（l001 与 L001 视为同一行，防止重复行）', async () => {
    fullSeed();
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    const dupe = JSON.parse(JSON.stringify(rows[0]));
    dupe[0] = ' l001 '; // 同一行换写法
    dupe[9] = '大小写变体';
    const post = await api(leadsApi, '/api/leads', {
      method: 'POST', token: tk, body: { headers: LH.slice(), data: rows.concat([dupe]) }
    });
    assert.strictEqual(post.status, 200);
    assert.strictEqual(post.json.created, 0, '同一编号不得新增重复行');
    assert.strictEqual(rawGet('leads').data.length, 12);
  });

  await t('regionOfMember / regionMembers 映射正确（与 16 账号口径一致）', async () => {
    assert.deepStrictEqual(regionMembers('汤显义'), ['高丹枫', '高雷', '王泽', '王远帅', '黄江锐', '胡雨来', '汤显义']);
    assert.strictEqual(regionOfMember('刘力瑞'), '管能');
    assert.strictEqual(regionOfMember('穆忠仁'), '穆忠仁');
    assert.strictEqual(regionOfMember('刘健凯'), '刘健凯', '海外大区总归属本人大区');
    assert.deepStrictEqual(regionMembers('刘健凯'), ['刘健凯']);
    assert.strictEqual(regionOfMember('张塞云'), '', 'IVD 销售不归属任何大区');
    assert.strictEqual(regionOfMember('房戈'), '', 'IVD 销售不归属任何大区');
    assert.strictEqual(regionOfMember('于翠'), '');
    // 未知大区防御性回退为 [本人]（避免映射缺失导致完全无可用名单）
    assert.deepStrictEqual(regionMembers('未知大区'), ['未知大区']);
    assert.deepStrictEqual(regionMembers(null), []);
  });

  await t('verifyToken 签发的 token 自验通过；token 跨 secret 不通用', async () => {
    const users = await buildDefaultUsers();
    const u = users.find(x => x.email === 'yucui@chromai.com');
    const tk = await signToken(u, ENV);
    const p = await verifyToken(tk, ENV);
    assert.ok(p && p.sub === 'yucui@chromai.com');
    assert.strictEqual(await verifyToken(tk, { AUTH_SECRET: 'other' }), null, '换密钥后旧 token 应失效');
    // 密码哈希口径：email:password 小写
    const h = await sha256('yucui@chromai.com:chromai2019');
    assert.strictEqual(u.pwdHash, h);
  });

  await t('logs appendLogs 多条批量追加 + queryLogs 分页', async () => {
    resetBlob();
    const entries = [];
    for (let i = 0; i < 60; i++) entries.push({ email: 'x@chromai.com', event: 'update', objectType: 'lead', objectId: 'L' + i });
    await appendLogs({ get: async () => null, set: async () => {}, list: async () => ({ keys: [] }), delete: async () => {} }, entries);
    const todayKey = shardKey(Date.now());
    const r = await queryLogs({
      get: async (k) => { assert.ok(/^logs\/\d{4}-\d{2}-\d{2}$/.test(k)); return k === todayKey ? entries.slice(0, 30) : null; },
      set: async () => {}
    }, { pageSize: '10', page: '2' });
    assert.strictEqual(r.total, 30);
    assert.strictEqual(r.items.length, 10);
    assert.strictEqual(r.page, 2);
  });
}

// ============================================================================
group('七、前端语法与残留检查（index.html）');
// ============================================================================
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const htmlPath = new URL('../index.html', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

  await t('所有 <script> 块通过 new Function() 语法校验', async () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const blocks = [];
    const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m[1].trim()) blocks.push(m[1]);
    }
    assert.ok(blocks.length >= 1, '应存在 script 块');
    blocks.forEach((code, i) => {
      try { new Function(code); }
      catch (e) { throw new Error('script 块 #' + (i + 1) + ' 语法错误: ' + e.message); }
    });
  });

  await t('无旧版 chromai2019 单口令残留；登录走 /api/auth/login', async () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(!html.includes('chromai2019'), '前端不得残留统一口令');
    assert.ok(html.includes("/api/auth/login"), '应调用登录 API');
    assert.ok(html.includes('Bearer '), 'apiFetch 应携带 Bearer');
  });

  await t('apiFetch 覆盖所有数据请求（除登录外无裸 fetch）', async () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const lines = html.split('\n');
    lines.forEach((line, i) => {
      if (/fetch\(/.test(line) && !/apiFetch/.test(line) && !/function apiFetch/.test(line) && !/var resp = await fetch\(/.test(line) && !/await fetch\(API_BASE \+ '\/api\/auth\/login'/.test(line)) {
        throw new Error('第 ' + (i + 1) + ' 行存在绕过 apiFetch 的请求: ' + line.trim());
      }
    });
  });

  await t('角色 UI：日志 Tab 仅 admin 可见；账号切换清缓存', async () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(/logsTab.*display.*isAdmin/s.test(html.replace(/\n/g, ' ')) || html.includes("logsTabEl.style.display = isAdmin() ? '' : 'none'"), '日志 Tab 应按 admin 显隐');
    assert.ok(html.includes('chromai_data_owner'), '账号切换应隔离本地缓存');
  });
}

// ============================================================================
group('八、第二轮安全修复回归（fup 跨线索注入 / region 清空负责人）');
// ============================================================================
{
  // 库级测试：与工程师 test-rbac-fixes.js 同场景（已并入），数据布局与主套件一致
  const leads = {
    headers: LH.slice(),
    data: [
      leadRow('L001', '王远帅', '汤显义'),
      leadRow('L008', '刘力瑞', '管能'),
      leadRow('L011', '', '')          // 未分配：仅 admin 可见
    ]
  };
  const fups = {
    headers: FH.slice(),
    data: [
      fupRow('F001', 'L001', '王远帅'),   // 王远帅自己线索的跟进
      fupRow('F005', 'L008', '管能')
    ]
  };
  const U = {
    admin:  { email: 'yucui@chromai.com',         name: '于翠',   role: 'admin',  region: null },
    region: { email: 'tangxianyi@chromai.com',    name: '汤显义', role: 'region', region: '汤显义' },
    sales:  { email: 'wangyuanshuai@chromai.com', name: '王远帅', role: 'sales',  region: '汤显义' }
  };
  const idx = buildLeadIndex(leads);

  await t('修复1：sales 跨线索 create（指向管能区 L008）→ 403 violation 且未落库', async () => {
    const body = { headers: FH.slice(), data: [fupRow('F001', 'L001', '王远帅'), fupRow('F999', 'L008', '王远帅')] };
    const d = diffDataset(U.sales, fups, body, 'fup', idx);
    const c = checkWritePerm(U.sales, d, 'fup', idx);
    const v = c.violations.find(x => x.id === 'f999');
    assert.ok(v, '应产生 f999 violation');
    assert.strictEqual(v.field, '线索编号');
    assert.ok(v.reason.indexOf('L008') >= 0, 'reason 应指明 L008');
    assert.ok(c.creates.every(x => x.id !== 'f999'), '越权行不得落库');
    assert.ok(c.violations.every(x => x.id === 'f999'), '原子拒绝仅因 f999');
  });

  await t('修复1：admin 跨线索 create → 放行（设计允许）', async () => {
    const body = { headers: FH.slice(), data: fups.data.concat([fupRow('F998', 'L008', '刘力瑞')]) };
    const d = diffDataset(U.admin, fups, body, 'fup', idx);
    const c = checkWritePerm(U.admin, d, 'fup', idx);
    assert.strictEqual(c.violations.length, 0);
    assert.ok(c.creates.some(x => x.id === 'f998'));
  });

  await t('修复1（加固）：sales update 变更线索编号指向他人线索 → 403', async () => {
    const body = { headers: FH.slice(), data: [fupRow('F001', 'L008', '王远帅')] };
    const d = diffDataset(U.sales, fups, body, 'fup', idx);
    const c = checkWritePerm(U.sales, d, 'fup', idx);
    const v = c.violations.find(x => x.id === 'f001');
    assert.ok(v && v.field === '线索编号', '改挂他人线索应 403');
  });

  await t('修复1（对照）：sales 给自己线索（L001）新增跟进 → 放行', async () => {
    const body = { headers: FH.slice(), data: [fupRow('F001', 'L001', '王远帅'), fupRow('F997', 'L001', '王远帅')] };
    const d = diffDataset(U.sales, fups, body, 'fup', idx);
    const c = checkWritePerm(U.sales, d, 'fup', idx);
    assert.strictEqual(c.violations.length, 0);
    assert.ok(c.creates.some(x => x.id === 'f997'));
  });

  await t('修复2：region 清空负责人 → 强制锁回原值，无孤儿化', async () => {
    const visible = filterLeads(U.region, leads);
    const body = JSON.parse(JSON.stringify(visible));
    body.data[0][12] = '';
    const d = diffDataset(U.region, leads, body, 'lead');
    const c = checkWritePerm(U.region, d, 'lead');
    assert.strictEqual(c.violations.length, 0, '锁回而非 403');
    assert.strictEqual(c.updates.length, 0, '锁回后净变更为空');
    const m = mergeDataset(leads, d, c, 'lead');
    const l1 = m.data.find(r => r[0] === 'L001');
    assert.strictEqual(l1[12], '王远帅', '负责人保持原值');
    assert.strictEqual(l1[13], '汤显义', '负责大区保持');
  });

  await t('修复2：admin 清空负责人 → 放行', async () => {
    const body = JSON.parse(JSON.stringify(leads));
    body.data[0][12] = '';
    const d = diffDataset(U.admin, leads, body, 'lead');
    const c = checkWritePerm(U.admin, d, 'lead');
    const u = c.updates.find(x => x.id === 'l001');
    assert.strictEqual(c.violations.length, 0);
    assert.ok(u && u.row[12] === '');
  });

  await t('修复2：region 清空负责人 + 同批正常编辑 → 锁回且正常字段生效，行数不变', async () => {
    const visible = filterLeads(U.region, leads);
    const body = JSON.parse(JSON.stringify(visible));
    body.data[0][12] = ''; body.data[0][9] = '已跟进';
    const d = diffDataset(U.region, leads, body, 'lead');
    const c = checkWritePerm(U.region, d, 'lead');
    const m = mergeDataset(leads, d, c, 'lead');
    const l1 = m.data.find(r => r[0] === 'L001');
    assert.strictEqual(c.violations.length, 0);
    assert.strictEqual(l1[12], '王远帅');
    assert.strictEqual(l1[9], '已跟进');
    assert.strictEqual(m.data.length, leads.data.length);
  });

  // ---- QA 追加端到端复验（HTTP 层，走完整 followups.js/leads.js 管线）----
  await t('修复1 端到端：sales 给管能区线索建跟进 → 403 + 数据未落库', async () => {
    fullSeed2();
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const r = await api(fupsApi, '/api/followups', {
      method: 'POST', token: tk,
      body: { headers: FH.slice(), data: [fupRow('F001', 'L001', '王远帅'), fupRow('F100', 'L008', '王远帅')] }
    });
    assert.strictEqual(r.status, 403, '原注入漏洞应已堵住');
    assert.strictEqual(r.json.error, 'forbidden');
    assert.ok(!rawGet('followups').data.some(x => x[0] === 'F100'), '越权行不得落库');
  });

  await t('修复1 端到端：sales update 改挂他人线索 → 403 且原值未变', async () => {
    fullSeed2();
    const tk = await loginAs('wangyuanshuai@chromai.com');
    const r = await api(fupsApi, '/api/followups', {
      method: 'POST', token: tk,
      body: { headers: FH.slice(), data: [fupRow('F001', 'L008', '王远帅')] }
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(rawGet('followups').data.find(x => x[0] === 'F001')[1], 'L001', '线索编号不得被改写');
  });

  await t('修复1 端到端：region 改挂外大区线索（update+create 双路径）→ 403', async () => {
    fullSeed2();
    const tk = await loginAs('tangxianyi@chromai.com');
    const r1 = await api(fupsApi, '/api/followups', {
      method: 'POST', token: tk, body: { headers: FH.slice(), data: [fupRow('F001', 'L008', '汤显义')] }
    });
    assert.strictEqual(r1.status, 403, 'region update 改挂应 403');
    const r2 = await api(fupsApi, '/api/followups', {
      method: 'POST', token: tk,
      body: { headers: FH.slice(), data: [fupRow('F001', 'L001', '王远帅'), fupRow('F101', 'L008', '汤显义')] }
    });
    assert.strictEqual(r2.status, 403, 'region create 跨线索应 403');
  });

  await t('修复2 端到端：region 清空负责人 → 200 且锁回、正常字段生效、行仍可见', async () => {
    fullSeed2();
    const tk = await loginAs('tangxianyi@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows[0][12] = ''; rows[0][9] = '已跟进';
    const r = await api(leadsApi, '/api/leads', { method: 'POST', token: tk, body: { headers: LH.slice(), data: rows } });
    assert.strictEqual(r.status, 200, '清空应锁回而非报错');
    const l1 = rawGet('leads').data.find(x => x[0] === 'L001');
    assert.strictEqual(l1[12], '王远帅', '锁回原负责人');
    assert.strictEqual(l1[9], '已跟进', '同批正常编辑生效');
    const view = await api(leadsApi, '/api/leads', { token: tk });
    assert.ok(view.json.data.some(x => x[0] === 'L001'), '行不得孤儿化（region 仍可见）');
  });

  // fullSeed2：八组专用小数据集（含跨大区线索与未分配行）
  function fullSeed2() {
    resetBlob();
    rawSet('leads', { headers: LH.slice(), data: [
      leadRow('L001', '王远帅', '汤显义'),
      leadRow('L008', '刘力瑞', '管能'),
      leadRow('L011', '', '')
    ]});
    rawSet('followups', { headers: FH.slice(), data: [fupRow('F001', 'L001', '王远帅')] });
  }
}

// ============================================================================
group('九、新增成员：海外大区总（刘健凯）与 IVD 业务销售（张塞云/房戈）');
// ============================================================================
{
  // 海外大区 2 条 + 汤显义区 1 条 + 管能区 1 条 + IVD 2 条 + 未分配 1 条
  function seedNewMembers() {
    resetBlob();
    rawSet('leads', { headers: LH.slice(), data: [
      leadRow('H001', '刘健凯', '刘健凯'),   // 海外
      leadRow('H002', '', '刘健凯'),         // 海外（待分配负责人）
      leadRow('L001', '王远帅', '汤显义'),
      leadRow('L008', '刘力瑞', '管能'),
      leadRow('V001', '张塞云', ''),         // IVD（无大区）
      leadRow('V002', '房戈', ''),           // IVD（无大区）
      leadRow('L011', '', '')                // 未分配
    ]});
    rawSet('followups', { headers: FH.slice(), data: [
      fupRow('F001', 'H001', '刘健凯'),
      fupRow('F002', 'V001', '张塞云'),
      fupRow('F003', 'L001', '王远帅')
    ]});
  }

  await t('刘健凯（海外大区总）只读到本大区 2 条，看不到其它大区/IVD/未分配', async () => {
    seedNewMembers();
    const tk = await loginAs('liujiankai@chromai.com');
    const r = await api(leadsApi, '/api/leads', { token: tk });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.data.map(x => x[0]).sort(), ['H001', 'H002']);
    r.json.data.forEach(row => assert.strictEqual(row[13], '刘健凯'));
  });

  await t('刘健凯 改派负责人给非本大区成员（王远帅）→ 403 且数据不变', async () => {
    seedNewMembers();
    const tk = await loginAs('liujiankai@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows.find(x => x[0] === 'H002')[12] = '王远帅';
    const r = await api(leadsApi, '/api/leads', { method: 'POST', token: tk, body: { headers: LH.slice(), data: rows } });
    assert.strictEqual(r.status, 403, '大区总不得改派给外大区成员');
    assert.strictEqual(rawGet('leads').data.find(x => x[0] === 'H002')[12], '', '数据不得被改写');
  });

  await t('刘健凯 给本大区线索建跟进 → 放行；给他人线索建跟进 → 403', async () => {
    seedNewMembers();
    const tk = await loginAs('liujiankai@chromai.com');
    // 前端协议：全量提交（可见行 + 新增行），否则缺失行会被判为删除
    const got = await api(fupsApi, '/api/followups', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows.push(fupRow('F101', 'H001', '刘健凯'));
    const ok = await api(fupsApi, '/api/followups', { method: 'POST', token: tk,
      body: { headers: FH.slice(), data: rows } });
    assert.strictEqual(ok.status, 200, '本大区线索应放行');
    assert.ok(rawGet('followups').data.some(x => x[0] === 'F101'), '本大区跟进应落库');

    const rows2 = JSON.parse(JSON.stringify(got.json.data));
    rows2.push(fupRow('F102', 'L001', '刘健凯'));
    const bad = await api(fupsApi, '/api/followups', { method: 'POST', token: tk,
      body: { headers: FH.slice(), data: rows2 } });
    assert.strictEqual(bad.status, 403, '他人线索应 403');
  });

  await t('张塞云（IVD，无大区）只读到本人名下 1 条，看不到任何大区数据', async () => {
    seedNewMembers();
    const tk = await loginAs('zhangsaiyun@chromai.com');
    const r = await api(leadsApi, '/api/leads', { token: tk });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.data.map(x => x[0]), ['V001']);
    const f = await api(fupsApi, '/api/followups', { token: tk });
    assert.deepStrictEqual(f.json.data.map(x => x[0]), ['F002'], '跟进按线索继承归属');
  });

  await t('张塞云 新增线索写他人负责人 → 锁回本人；负责大区强制为空', async () => {
    seedNewMembers();
    const tk = await loginAs('zhangsaiyun@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows.push(leadRow('V101', '房戈', '汤显义'));   // 试图挂到别人/别的区
    const r = await api(leadsApi, '/api/leads', { method: 'POST', token: tk, body: { headers: LH.slice(), data: rows } });
    assert.strictEqual(r.status, 200);
    const v101 = rawGet('leads').data.find(x => x[0] === 'V101');
    assert.strictEqual(v101[12], '张塞云', '无大区销售的负责人应锁回本人');
    assert.strictEqual(v101[13], '', '无大区销售的负责大区应为空');
  });

  await t('张塞云 更新本人行：正常字段生效，负责人/负责大区不被篡改成他人', async () => {
    seedNewMembers();
    const tk = await loginAs('zhangsaiyun@chromai.com');
    const got = await api(leadsApi, '/api/leads', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows[0][9] = '已跟进'; rows[0][12] = '房戈'; rows[0][13] = '管能';
    const r = await api(leadsApi, '/api/leads', { method: 'POST', token: tk, body: { headers: LH.slice(), data: rows } });
    assert.strictEqual(r.status, 200);
    const v1 = rawGet('leads').data.find(x => x[0] === 'V001');
    assert.strictEqual(v1[9], '已跟进', '正常字段应生效');
    assert.strictEqual(v1[12], '张塞云', '负责人不得越权改派');
    assert.strictEqual(v1[13], '', '负责大区不得越权改写');
  });

  await t('张塞云 给他人线索（L001）建跟进 → 403 且未落库', async () => {
    seedNewMembers();
    const tk = await loginAs('zhangsaiyun@chromai.com');
    const got = await api(fupsApi, '/api/followups', { token: tk });
    const rows = JSON.parse(JSON.stringify(got.json.data));
    rows.push(fupRow('F201', 'L001', '张塞云'));
    const r = await api(fupsApi, '/api/followups', { method: 'POST', token: tk,
      body: { headers: FH.slice(), data: rows } });
    assert.strictEqual(r.status, 403);
    assert.ok(!rawGet('followups').data.some(x => x[0] === 'F201'), '越权跟进不得落库');
  });

  await t('房戈 与 张塞云 互不可见（同一 IVD 业务但各自归属本人名下）', async () => {
    seedNewMembers();
    const tkF = await loginAs('fangge@chromai.com');
    const r = await api(leadsApi, '/api/leads', { token: tkF });
    assert.deepStrictEqual(r.json.data.map(x => x[0]), ['V002']);
    const tkZ = await loginAs('zhangsaiyun@chromai.com');
    const r2 = await api(leadsApi, '/api/leads', { token: tkZ });
    assert.deepStrictEqual(r2.json.data.map(x => x[0]), ['V001']);
  });

  await t('admin 全量可见：含海外大区、IVD 业务与未分配行', async () => {
    seedNewMembers();
    const tk = await loginAs('yucui@chromai.com');
    const r = await api(leadsApi, '/api/leads', { token: tk });
    assert.strictEqual(r.json.data.length, 7);
    ['H001', 'H002', 'V001', 'V002', 'L011'].forEach(id =>
      assert.ok(r.json.data.some(x => x[0] === id), id + ' 应对 admin 可见'));
  });
}

// ============================================================================
// 汇总
// ============================================================================
console.log('\n============================================');
console.log('总计: ' + (PASSED + FAILED) + ' | 通过: ' + PASSED + ' | 失败: ' + FAILED);
if (FAILURES.length) {
  console.log('\n失败清单:');
  FAILURES.forEach(f => console.log('  ✗ ' + f.name + '\n      ' + f.error));
}
console.log('============================================');
process.exit(FAILED > 0 ? 1 : 0);
