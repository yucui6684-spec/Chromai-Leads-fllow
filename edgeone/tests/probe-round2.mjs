// QA 第二轮对抗性探测（不计入正式用例）：验证修复的绕过面
import assert from 'node:assert';
import * as loginApi from '../functions/api/auth/login.js';
import * as leadsApi from '../functions/api/leads.js';
import * as fupsApi from '../functions/api/followups.js';

const g = globalThis; g.__BLOB_STORES = new Map();
function rawSet(k, o) { if (!g.__BLOB_STORES.has('chromai-leads')) g.__BLOB_STORES.set('chromai-leads', new Map()); g.__BLOB_STORES.get('chromai-leads').set(k, JSON.stringify(o)); }
function rawGet(k) { const v = g.__BLOB_STORES.get('chromai-leads').get(k); return v == null ? null : JSON.parse(v); }
const ENV = { AUTH_SECRET: 'qa-test-secret-0123456789' };
const LH = ['线索编号','来源','公司','联系人','职位','电话','微信','邮箱','需求','状态','创建时间','最后跟进','负责人','负责大区','备注'];
const FH = ['跟进编号','线索编号','跟进时间','跟进方式','跟进内容','负责人'];
function leadRow(id, owner, region) { const r = LH.map(()=>''); r[0]=id; r[9]='新建'; r[12]=owner; r[13]=region; return r; }
function fupRow(id, lid, owner) { const r = FH.map(()=>''); r[0]=id; r[1]=lid; r[4]='x'; r[5]=owner; return r; }

function req(path, opts={}) {
  const headers = Object.assign({}, opts.headers);
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
  if (opts.body) headers['Content-Type'] = 'application/json';
  return new Request('https://x' + path, { method: opts.method||'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
}
async function loginAs(email) {
  const r = await loginApi.onRequest({ request: req('/api/auth/login', { method:'POST', body:{ email, password:'chromai2019' } }), env: ENV });
  return (await r.json()).token;
}
async function api(fn, path, opts={}) {
  const r = await fn.onRequest({ request: req(path, opts), env: ENV });
  return { status: r.status, json: await r.json().catch(() => null) };
}

function seed() {
  g.__BLOB_STORES = new Map();
  rawSet('leads', { headers: LH.slice(), data: [
    leadRow('L001','王远帅','汤显义'), leadRow('L002','高丹枫','汤显义'), leadRow('L008','刘力瑞','管能')
  ]});
  rawSet('followups', { headers: FH.slice(), data: [ fupRow('F001','L001','王远帅') ]});
}

const R = [];
function check(name, cond, detail) { R.push((cond ? '✓ ' : '✗ ') + name + (cond ? '' : ' —— ' + detail)); }

// 探测A：原始注入场景端到端复验（王远帅给管能区 L008 建跟进 → 应 403）
seed();
let tk = await loginAs('wangyuanshuai@chromai.com');
let r = await api(fupsApi, '/api/followups', { method:'POST', token: tk, body:{ headers: FH.slice(), data:[ fupRow('F001','L001','王远帅'), fupRow('F100','L008','王远帅') ]}});
check('A1 sales 跨线索注入（原漏洞）→ 403', r.status === 403, JSON.stringify(r.json));
check('A2 数据未落库', !rawGet('followups').data.some(x => x[0] === 'F100'));

// 探测B：sales 改挂 update（F001 线索编号 L001→L008）→ 403（端到端）
seed();
r = await api(fupsApi, '/api/followups', { method:'POST', token: tk, body:{ headers: FH.slice(), data:[ fupRow('F001','L008','王远帅') ]}});
check('B1 sales update 改挂他人线索 → 403', r.status === 403, JSON.stringify(r.json));
check('B2 线索编号未被改写', rawGet('followups').data.find(x => x[0]==='F001')[1] === 'L001');

// 探测C：region 角色改挂（汤显义把 F001 线索编号改成 L008）→ 403（修复不止覆盖 sales）
seed();
const tkT = await loginAs('tangxianyi@chromai.com');
r = await api(fupsApi, '/api/followups', { method:'POST', token: tkT, body:{ headers: FH.slice(), data:[ fupRow('F001','L008','汤显义') ]}});
check('C1 region update 改挂外大区线索 → 403', r.status === 403, JSON.stringify(r.json));

// 探测D：region 跨线索 create → 403
seed();
r = await api(fupsApi, '/api/followups', { method:'POST', token: tkT, body:{ headers: FH.slice(), data:[ fupRow('F001','L001','王远帅'), fupRow('F101','L008','汤显义') ]}});
check('D1 region 跨线索 create → 403', r.status === 403, JSON.stringify(r.json));

// 探测E：合法路径不受影响——sales 给自己线索建跟进、指向空编号/无效编号的兜底
seed();
r = await api(fupsApi, '/api/followups', { method:'POST', token: tk, body:{ headers: FH.slice(), data:[ fupRow('F001','L001','王远帅'), fupRow('F102','L001','王远帅'), fupRow('F103','','王远帅'), fupRow('F104','LXYZ','王远帅') ]}});
check('E1 合法+兜底新增 → 200', r.status === 200, JSON.stringify(r.json));
check('E2 兜底行负责人锁本人', rawGet('followups').data.filter(x => ['F103','F104'].includes(x[0])).every(x => x[5] === '王远帅'));

// 探测F：region 清空负责人端到端（含同批正常编辑）
seed();
const got = await api(leadsApi, '/api/leads', { token: tkT });
const rows = JSON.parse(JSON.stringify(got.json.data));
rows[0][12] = ''; rows[0][9] = '已跟进';
r = await api(leadsApi, '/api/leads', { method:'POST', token: tkT, body:{ headers: LH.slice(), data: rows }});
const l1 = rawGet('leads').data.find(x => x[0]==='L001');
check('F1 region 清空负责人 → 200 且锁回原值', r.status === 200 && l1[12] === '王远帅', 'status=' + r.status + ' owner=' + l1[12]);
check('F2 同批正常编辑生效', l1[9] === '已跟进');
check('F3 行未孤儿化（region 仍可见）', (await api(leadsApi, '/api/leads', { token: tkT })).json.data.some(x => x[0]==='L001'));

// 探测G：region 把负责人改成空格（whitespace）——绕过 !row[oi] 判定？
seed();
const got2 = await api(leadsApi, '/api/leads', { token: tkT });
const rows2 = JSON.parse(JSON.stringify(got2.json.data));
rows2[0][12] = '   '; // 非空字符串但全是空格
r = await api(leadsApi, '/api/leads', { method:'POST', token: tkT, body:{ headers: LH.slice(), data: rows2 }});
const l1g = rawGet('leads').data.find(x => x[0]==='L001');
// visibleLead 用 cell()→String() 不 trim 负责人：'   ' !== '汤显义' → region 不可见该行
const regionView = (await api(leadsApi, '/api/leads', { token: tkT })).json.data.some(x => x[0]==='L001');
check('G1 region 负责人置为纯空格 → 仍锁回/403（不得产生实质孤儿行）', r.status === 200 ? (l1g[12] !== '   ') : r.status === 403, 'status=' + r.status + ' owner=[' + l1g[12] + '] regionStillSees=' + regionView);

// 探测H：sales 清空自己行负责人 → 锁回本人（原始逻辑已覆盖，复验）
seed();
const got3 = await api(leadsApi, '/api/leads', { token: tk });
const rows3 = JSON.parse(JSON.stringify(got3.json.data));
rows3[0][12] = '';
r = await api(leadsApi, '/api/leads', { method:'POST', token: tk, body:{ headers: LH.slice(), data: rows3 }});
check('H1 sales 清空负责人 → 锁回本人', rawGet('leads').data.find(x => x[0]==='L001')[12] === '王远帅');

// 探测I：admin 可跨线索挂跟进（不受新校验限制）
seed();
const tkA = await loginAs('yucui@chromai.com');
r = await api(fupsApi, '/api/followups', { method:'POST', token: tkA, body:{ headers: FH.slice(), data: rawGet('followups').data.concat([fupRow('F105','L008','刘力瑞')]) }});
check('I1 admin 跨线索 create → 200', r.status === 200, JSON.stringify(r.json));

// 探测J：leads POST 不受 leadRef 校验影响（type=lead 直接跳过）
seed();
r = await api(leadsApi, '/api/leads', { method:'POST', token: tk, body:{ headers: LH.slice(), data: [ leadRow('L001','王远帅','汤显义'), leadRow('L300','王远帅','汤显义') ]}});
check('J1 sales 正常新增 lead → 200', r.status === 200, JSON.stringify(r.json));

import fs from 'node:fs';
fs.writeFileSync('probe2-result.txt', R.join('\n') + '\n\nPROBE_FAILS=' + R.filter(x => x.startsWith('✗')).length + '\n', 'utf8');
process.exit(R.some(x => x.startsWith('✗')) ? 1 : 0);
