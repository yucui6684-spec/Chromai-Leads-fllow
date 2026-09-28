// ============================================================================
// 科诺美线索系统 RBAC 修复回归 — 跨线索注入 & region 清空负责人
// 运行：node tests/test-rbac-fixes.js
// 对应修复：
//   1. fup creates 行「线索编号」必须指向操作者可见线索（admin 不限），否则 403
//   2. region 不允许清空「负责人」（强制锁回原值）；admin 可清空
//   3. （加固）fup update 行变更「线索编号」指向不可见线索 → 403
// 注：本文件用例可直接并入 tests/test-rbac.js（同款断言风格）。
// ============================================================================
import { filterLeads, diffDataset, checkWritePerm, mergeDataset, buildLeadIndex }
  from '../functions/api/_acl.js';

let PASSED = 0, FAILED = 0;
function t(name, cond) {
  if (cond) { PASSED++; console.log('  ✓ ' + name); }
  else { FAILED++; console.log('  ✗ ' + name); }
}

// ---- 测试数据（与 QA 套件同布局：故意把负责人/负责大区放在 12/13，验证按表头名定位）----
const LH = ['线索编号', '来源', '公司名称', '联系人', '职位', '电话', '微信', '邮箱',
  '需求描述', '状态', '创建时间', '最后跟进', '负责人', '负责大区', '备注'];
function leadRow(id, owner, region) {
  const r = LH.map(() => '');
  r[0] = id; r[12] = owner; r[13] = region; r[14] = '备注-' + id;
  return r;
}
const leads = {
  headers: LH.slice(),
  data: [
    leadRow('L001', '王远帅', '汤显义'),
    leadRow('L008', '刘力瑞', '管能'),
    leadRow('L011', '', '')          // 未分配：仅 admin 可见
  ]
};
const FH = ['跟进编号', '线索编号', '跟进时间', '跟进方式', '跟进内容', '负责人'];
function fupRow(id, leadId, owner, content) {
  const r = FH.map(() => '');
  r[0] = id; r[1] = leadId; r[4] = content || ('跟进-' + id); r[5] = owner;
  return r;
}
const fups = {
  headers: FH.slice(),
  data: [
    fupRow('F001', 'L001', '王远帅'),   // 王远帅自己线索的跟进
    fupRow('F005', 'L008', '管能')
  ]
};

const admin  = { email: 'yucui@chromai.com',         name: '于翠',   role: 'admin',  region: null };
const region = { email: 'tangxianyi@chromai.com',    name: '汤显义', role: 'region', region: '汤显义' };
const sales  = { email: 'wangyuanshuai@chromai.com', name: '王远帅', role: 'sales',  region: '汤显义' };

const leadIdx = buildLeadIndex(leads);

console.log('\n== 修复回归：fup 跨线索注入 / region 清空负责人 ==');

// ---- 用例 1：sales 给他人线索（L008 刘力瑞/管能区）新增跟进 → 403 ----
// body = sales 可见子集（F001）+ 新行（真实前端协议：只回传可见行）
{
  const body = { headers: FH.slice(), data: [fupRow('F001', 'L001', '王远帅'), fupRow('F999', 'L008', '王远帅')] };
  const d = diffDataset(sales, fups, body, 'fup', leadIdx);
  const c = checkWritePerm(sales, d, 'fup', leadIdx);
  const v = c.violations.find(v => v.id === 'f999');
  t('sales 跨线索 create → 403 violation', !!v && v.field === '线索编号' && v.reason.indexOf('L008') >= 0);
  t('sales 跨线索 create 未落库', c.creates.every(x => x.id !== 'f999'));
  t('sales 正常可见行不受牵连（原子拒绝仅因 f999）', c.violations.every(x => x.id === 'f999'));
}
// ---- 用例 2：admin 给他人线索新增跟进 → 放行 ----
{
  const body = { headers: FH.slice(), data: fups.data.concat([fupRow('F998', 'L008', '刘力瑞')]) };
  const d = diffDataset(admin, fups, body, 'fup', leadIdx);
  const c = checkWritePerm(admin, d, 'fup', leadIdx);
  t('admin 跨线索 create 放行', c.violations.length === 0 && c.creates.some(x => x.id === 'f998'));
}
// ---- 用例 3：region 清空负责人 → 强制锁回原值（不 403、不产生孤儿行）----
{
  const visible = filterLeads(region, leads);            // region 可见 L001
  const body = JSON.parse(JSON.stringify(visible));
  body.data[0][12] = '';                                 // 清空负责人
  const d = diffDataset(region, leads, body, 'lead');
  const c = checkWritePerm(region, d, 'lead');
  // 锁回原值后净变更为 0 → 不产生 update（写库无操作，行保持原样）
  t('region 清空负责人 → 无越权、净变更为空', c.violations.length === 0 && c.updates.length === 0);
  const m = mergeDataset(leads, d, c, 'lead');
  const l1 = m.data.find(r => r[0] === 'L001');
  t('region 清空负责人 → 合并后负责人保持 王远帅', !!l1 && l1[12] === '王远帅');
  t('region 清空负责人 → 负责大区保持 汤显义', !!l1 && l1[13] === '汤显义');
}
// ---- 用例 4：admin 清空负责人 → 放行 ----
{
  const body = JSON.parse(JSON.stringify(leads));
  body.data[0][12] = '';                                 // 清空 L001 负责人
  const d = diffDataset(admin, leads, body, 'lead');
  const c = checkWritePerm(admin, d, 'lead');
  const u = c.updates.find(x => x.id === 'l001');
  t('admin 清空负责人放行', c.violations.length === 0 && !!u && u.row[12] === '');
}
// ---- 用例 5（加固）：sales 把自己跟进的线索编号改挂到他人线索 → 403 ----
{
  const body = { headers: FH.slice(), data: [fupRow('F001', 'L008', '王远帅')] };
  const d = diffDataset(sales, fups, body, 'fup', leadIdx);
  const c = checkWritePerm(sales, d, 'fup', leadIdx);
  const v = c.violations.find(v => v.id === 'f001');
  t('sales 变更线索编号指向他人线索 → 403', !!v && v.field === '线索编号');
}
// ---- 用例 6（对照）：sales 给自己线索（L001）新增跟进 → 放行 ----
// body = sales 可见子集（F001）+ 新行（真实前端协议）
{
  const body = { headers: FH.slice(), data: [fupRow('F001', 'L001', '王远帅'), fupRow('F997', 'L001', '王远帅')] };
  const d = diffDataset(sales, fups, body, 'fup', leadIdx);
  const c = checkWritePerm(sales, d, 'fup', leadIdx);
  t('sales 给自己线索新增跟进放行', c.violations.length === 0 && c.creates.some(x => x.id === 'f997'));
}
// ---- 用例 7（对照）：region 清空后大区字段与合并完整性 ----
{
  const visible = filterLeads(region, leads);
  const body = JSON.parse(JSON.stringify(visible));
  body.data[0][12] = ''; body.data[0][9] = '已跟进';     // 清空负责人 + 正常改状态
  const d = diffDataset(region, leads, body, 'lead');
  const c = checkWritePerm(region, d, 'lead');
  const m = mergeDataset(leads, d, c, 'lead');
  const l1 = m.data.find(r => r[0] === 'L001');
  t('region 清空+正常编辑：负责人锁回且正常字段生效',
    c.violations.length === 0 && l1[12] === '王远帅' && l1[9] === '已跟进');
  t('合并后总行数不变', m.data.length === leads.data.length);
}

console.log('\nRESULT: ' + PASSED + ' pass, ' + FAILED + ' fail');
process.exit(FAILED ? 1 : 0);
