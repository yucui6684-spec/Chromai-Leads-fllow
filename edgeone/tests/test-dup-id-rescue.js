// ============================================================================
// 重复编号兜底 - 验证（2026-09-29 事故）
// 运行：node tests/test-dup-id-rescue.js
//
// 事故回顾：前端用 fupsData.length + 1 生成跟进编号，而历史删除留下编号空洞
// （286 行、最大号却是 0289）→ 新增算出 0287，撞上已有记录。
// 服务端旧行为「body 内重复编号取第一行，其余丢弃」会静默丢数据：
// 不报错、不写日志、仍返回 200，前端随后被 PULL 整体覆盖 → 用户看到「新增凭空消失」。
//
// 修复：仅对 fup 生效，判据 = 「线索编号不同」→ 认定为另一条真实记录，
// 由服务端重新分配一个未占用的编号保存（renamedFrom 留痕），原记录不受影响。
// ============================================================================
import assert from 'node:assert';
import { diffDataset, checkWritePerm, mergeDataset, buildLeadIndex }
  from '../functions/api/_acl.js';

let PASSED = 0, FAILED = 0;
function t(name, fn) {
  try { fn(); PASSED++; console.log('  ✓ ' + name); }
  catch (e) { FAILED++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}

// 与生产一致的真实表头
const LH = ['线索编号', '线索来源', '活动名称', '客户名称(脱敏)', '联系人', '职位', '联系电话', '邮箱',
  '所属行业', '地域', '企业规模', '当前阶段', '线索评分(0-100)', '负责人', '负责大区', '创建日期', '备注'];
const FH = ['跟进编号', '线索编号', '跟进日期', '跟进方式', '首次反馈', '跟进记录', '产品型号意向',
  '预算范围(万元)', '预算确认', '采购时间窗', '预计成交金额(万)', '成交概率(%)', '阶段变化',
  '下一步计划', '负责人', '操作'];

const ADMIN = { name: '于翠', email: 'yucui@chromai.com', role: 'admin', region: null };

function leadRow(id, owner, region) {
  const r = LH.map(() => '');
  r[0] = id; r[11] = 'MQL'; r[13] = owner; r[14] = region || '';
  return r;
}
function fupRow(id, leadId, owner, first) {
  const r = FH.map(() => '');
  r[0] = id; r[1] = leadId; r[2] = '2026-09-28'; r[3] = '电话';
  r[4] = first || ''; r[14] = owner || '';
  return r;
}

// 模拟线上：编号有空洞——3 行但最大号是 0289（真实线上是 286 行 / 最大 0289）
const OLD_FUPS = [
  fupRow('FUP-2026-0287', 'LD-2026-2348', '管能', '有液相，检测药品'),
  fupRow('FUP-2026-0288', 'LD-2026-2349', '管能', '能用到液相色谱'),
  fupRow('FUP-2026-0289', 'LD-2026-2350', '穆忠仁', '能用到液相色谱')
];
const OLD_LEADS = [
  leadRow('LD-2026-2348', '管能', '管能'),
  leadRow('LD-2026-2349', '管能', '管能'),
  leadRow('LD-2026-2350', '穆忠仁', '穆忠仁'),
  leadRow('LD-2026-2351', '刘健凯', '刘健凯')
];

console.log('=== 一、复现事故：新增行撞上已有编号 ===');
t('旧逻辑会丢数据：body 内重复编号取第一行 → created=0（对照组）', () => {
  // 直接验证重复编号确实会被识别到 bodyIds.has 分支（本测试文件跑的是修复后代码，
  // 因此这里断言的是「新逻辑下它不再被丢弃」，见下一组）
  const leadIdx = buildLeadIndex({ headers: LH, data: OLD_LEADS });
  const newRow = fupRow('FUP-2026-0287', 'LD-2026-2351', '刘健凯', ''); // 撞号，但线索不同
  const d = diffDataset(ADMIN, { headers: FH, data: OLD_FUPS },
    { headers: FH, data: OLD_FUPS.concat([newRow]) }, 'fup', leadIdx);
  assert.strictEqual(d.creates.length, 1, '应识别为 1 条新增（而非丢弃）');
  assert.notStrictEqual(d.creates[0].id, 'fup-2026-0287', '不应沿用撞号编号');
  assert.strictEqual(d.creates[0].renamedFrom, 'FUP-2026-0287', '应记录原始撞号编号');
});

t('重新分配的编号不与现有任何编号冲突', () => {
  const leadIdx = buildLeadIndex({ headers: LH, data: OLD_LEADS });
  const newRow = fupRow('FUP-2026-0287', 'LD-2026-2351', '刘健凯', '');
  const d = diffDataset(ADMIN, { headers: FH, data: OLD_FUPS },
    { headers: FH, data: OLD_FUPS.concat([newRow]) }, 'fup', leadIdx);
  const existing = OLD_FUPS.map(r => r[0].toLowerCase());
  assert.ok(existing.indexOf(d.creates[0].id) < 0, '新编号 ' + d.creates[0].id + ' 不应撞号');
  assert.ok(/^fup-2026-0290$/.test(d.creates[0].id), '应分配 max+1 = 0290，实际 ' + d.creates[0].id);
});

t('原记录（0287）内容不受污染，仍保持自己的线索', () => {
  const leadIdx = buildLeadIndex({ headers: LH, data: OLD_LEADS });
  const newRow = fupRow('FUP-2026-0287', 'LD-2026-2351', '刘健凯', '');
  const d = diffDataset(ADMIN, { headers: FH, data: OLD_FUPS },
    { headers: FH, data: OLD_FUPS.concat([newRow]) }, 'fup', leadIdx);
  // 0287 未被 update（内容没变）
  assert.strictEqual(d.updates.filter(u => u.id === 'fup-2026-0287').length, 0,
    '0287 不应被新行覆盖（否则是数据污染，比丢失更糟）');
});

t('端到端：合并后 4 行，新行的线索编号是 LD-2026-2351，编号已改分配', () => {
  const leadIdx = buildLeadIndex({ headers: LH, data: OLD_LEADS });
  const newRow = fupRow('FUP-2026-0287', 'LD-2026-2351', '刘健凯', '');
  const oldPayload = { headers: FH, data: OLD_FUPS };
  const d = diffDataset(ADMIN, oldPayload, { headers: FH, data: OLD_FUPS.concat([newRow]) }, 'fup', leadIdx);
  const checked = checkWritePerm(ADMIN, d, 'fup', leadIdx);
  assert.strictEqual(checked.violations.length, 0, '不应有越权');
  assert.strictEqual(checked.creates.length, 1);
  assert.strictEqual(checked.creates[0].renamedFrom, 'FUP-2026-0287', 'renamedFrom 应一路传到日志');
  const merged = mergeDataset(oldPayload, d, checked, 'fup');
  assert.strictEqual(merged.data.length, 4, '合并后应为 4 行');
  const added = merged.data[3];
  assert.strictEqual(added[1], 'LD-2026-2351', '新行线索编号应保留');
  assert.strictEqual(added[14], '刘健凯', '新行负责人应保留');
  assert.strictEqual(added[0], 'FUP-2026-0290', '新行编号应为服务端改分配的 0290');
  // 原 0287 完好
  assert.strictEqual(merged.data[0][0], 'FUP-2026-0287');
  assert.strictEqual(merged.data[0][1], 'LD-2026-2348');
  assert.strictEqual(merged.data[0][4], '有液相，检测药品');
});

console.log('\n=== 二、不得误伤：同一行的写法变体仍视为同一行 ===');
t('fup：编号 trim/大小写变体且线索编号相同 → 不新增（保持原语义）', () => {
  const leadIdx = buildLeadIndex({ headers: LH, data: OLD_LEADS });
  const dupe = fupRow(' fup-2026-0287 ', 'LD-2026-2348', '管能', '有液相，检测药品');
  const d = diffDataset(ADMIN, { headers: FH, data: OLD_FUPS },
    { headers: FH, data: OLD_FUPS.concat([dupe]) }, 'fup', leadIdx);
  assert.strictEqual(d.creates.length, 0, '同一行变体不得产生新行');
});

t('fup：编号相同、线索相同但内容不同 → 仍不新增（避免整批推送误造重复行）', () => {
  const leadIdx = buildLeadIndex({ headers: LH, data: OLD_LEADS });
  const dupe = fupRow('FUP-2026-0287', 'LD-2026-2348', '管能', '改过的首次反馈');
  const d = diffDataset(ADMIN, { headers: FH, data: OLD_FUPS },
    { headers: FH, data: OLD_FUPS.concat([dupe]) }, 'fup', leadIdx);
  assert.strictEqual(d.creates.length, 0, '线索编号相同不应触发兜底');
});

console.log('\n=== 三、正常路径不受影响 ===');
t('正常新增（编号不撞号）走普通 create，无 renamedFrom', () => {
  const leadIdx = buildLeadIndex({ headers: LH, data: OLD_LEADS });
  const newRow = fupRow('FUP-2026-0290', 'LD-2026-2351', '刘健凯', '');
  const d = diffDataset(ADMIN, { headers: FH, data: OLD_FUPS },
    { headers: FH, data: OLD_FUPS.concat([newRow]) }, 'fup', leadIdx);
  assert.strictEqual(d.creates.length, 1);
  assert.strictEqual(d.creates[0].id, 'fup-2026-0290');
  assert.ok(!d.creates[0].renamedFrom, '正常新增不应有 renamedFrom');
});

t('普通编辑（update）不受影响', () => {
  const leadIdx = buildLeadIndex({ headers: LH, data: OLD_LEADS });
  const edited = fupRow('FUP-2026-0288', 'LD-2026-2349', '管能', '改后的首次反馈');
  const d = diffDataset(ADMIN, { headers: FH, data: OLD_FUPS },
    { headers: FH, data: [OLD_FUPS[0], edited, OLD_FUPS[2]] }, 'fup', leadIdx);
  assert.strictEqual(d.creates.length, 0);
  assert.strictEqual(d.updates.length, 1);
  assert.strictEqual(d.updates[0].id, 'fup-2026-0288');
});

console.log('\n============================================');
console.log('总计: ' + (PASSED + FAILED) + ' | 通过: ' + PASSED + ' | 失败: ' + FAILED);
console.log('============================================');
process.exit(FAILED ? 1 : 0);
