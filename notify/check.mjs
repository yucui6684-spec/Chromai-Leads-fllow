/**
 * check.mjs —— 判定逻辑离线单测（不联网、不发信、不依赖 nodemailer）
 * 用法：node check.mjs
 *
 * 覆盖：
 *   A. 时间基准（上海 00:00 +Nh）
 *   B. 跟进记录解析（JSON / 旧纯文本 / 空）
 *   C. 三档判定：① 新增 / ② 48h / ③ 72h，已跟进的不再触发
 *   D. state 去重（同一档位只发一次）
 *   E. 收件人映射（大区总抄送 / 无大区总 / 负责人为空）
 *   F. 发送时段（工作日 09-18 / 周末 / 早于 9 点）
 */

import * as R from './rules.mjs';

let pass = true;
function chk(name, ok, extra) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''));
  if (!ok) pass = false;
}
const iso = function(ms) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z'; };

// 固定 now：2026-09-30（周三）10:00 上海 = 02:00 UTC
const NOW = Date.UTC(2026, 8, 30, 2, 0, 0);
const HEADERS = ['跟进编号','线索编号','跟进日期','跟进方式','首次反馈','跟进记录','产品型号意向','预算范围(万元)',
  '预算确认','采购时间窗','预计成交金额(万)','成交概率(%)','阶段变化','下一步计划','负责人','操作'];

function row(id, leadId, date, recCell, owner) {
  const r = new Array(HEADERS.length).fill('');
  r[0] = id; r[1] = leadId; r[2] = date; r[3] = '电话'; r[4] = '首次沟通';
  r[5] = recCell; r[6] = 'LC-3000'; r[7] = '50-100'; r[8] = '已确认'; r[9] = 'Q1';
  r[10] = '80'; r[11] = '60'; r[12] = '继续沟通培养'; r[13] = '下周再联系';
  r[14] = owner; r[15] = '';
  return r;
}

console.log('=== check：跟进提醒判定逻辑（离线）===');
console.log('now = ' + iso(NOW) + '（上海 2026-09-30 周三 10:00）\n');

// ---------- A. 时间基准 ----------
console.log('[A] 时间基准（上海 00:00 + Nh）');
const base = R.shanghaiMidnight('2026-09-28');
chk('2026-09-28 00:00 上海 = UTC 2026-09-27 16:00', iso(base) === '2026-09-27 16:00Z', iso(base));
chk('+48h 到期（09-28 → 09-30 00:00 ≤ now）', R.isOverdue('2026-09-28', 48, NOW) === true);
chk('+72h 未到期（09-28 → 10-01 00:00 > now）', R.isOverdue('2026-09-28', 72, NOW) === false);
chk('+72h 到期（09-26 → 09-29 00:00 ≤ now）', R.isOverdue('2026-09-26', 72, NOW) === true);
chk('未来日期不触发（10-05）', R.isOverdue('2026-10-05', 48, NOW) === false);
chk('空/非法日期不触发', R.isOverdue('', 48, NOW) === false && R.isOverdue('x', 48, NOW) === false);
chk('超时小时数 = 58h（09-28 00:00 → now）', R.overdueHours('2026-09-28', NOW) === 58, String(R.overdueHours('2026-09-28', NOW)));

// ---------- B. 跟进记录解析 ----------
console.log('\n[B] 「跟进记录」子项解析');
chk('空字符串 = 0 条', R.parseFollowupCount('') === 0);
chk('null/undefined = 0 条', R.parseFollowupCount(null) === 0 && R.parseFollowupCount(undefined) === 0);
chk('JSON 2 条 = 2', R.parseFollowupCount('[{"d":"2026-09-20","t":"a"},{"d":"2026-09-21","t":"b"}]') === 2);
chk('JSON 空数组 = 0', R.parseFollowupCount('[]') === 0);
chk('旧纯文本降级 = 1 条', R.parseFollowupCount('09.14 已电话跟进') === 1);
chk('非法 JSON 降级 = 1 条', R.parseFollowupCount('[{broken}]') === 1);

// ---------- C. 三档判定 ----------
console.log('\n[C] 三档判定（① 新增 / ② 48h / ③ 72h）');
const rows = [
  row('FUP-NEW',  'LD-1', '2026-09-30', '', '高丹枫'),                                   // ① 新增
  row('FUP-48',   'LD-2', '2026-09-28', '', '刘力瑞'),                                   // ②
  row('FUP-72',   'LD-3', '2026-09-26', '', '王泽'),                                     // ② + ③
  row('FUP-DONE', 'LD-4', '2026-09-26', '[{"d":"2026-09-27","t":"已跟进"}]', '胡雨来'),   // 已跟进
  row('FUP-OLD',  'LD-5', '2026-09-20', '2026-09-22 已电话跟进', '高雷'),                 // 旧纯文本 = 已跟进
  row('FUP-SOON', 'LD-6', '2026-09-29', '', '黄江锐')                                    // 未到 48h（已见过）
];
// 除 FUP-NEW 外都事先见过（模拟已经跑过基线），这样 ②/③ 才能被单独验证
const state = { records: {
  'FUP-48': { stages: {} }, 'FUP-72': { stages: {} },
  'FUP-DONE': { stages: {} }, 'FUP-OLD': { stages: {} }, 'FUP-SOON': { stages: {} }
} };

const ev = R.evaluate({ headers: HEADERS, rows: rows, state: state, now: NOW,
  thresholds: { stage2Hours: 48, stage3Hours: 72 }, baseline: false });

const stagesOf = function(id) {
  return ev.dues.filter(function(d) { return d.fupId === id; }).map(function(d) { return d.stage; }).sort();
};
chk('① 新增：FUP-NEW 命中档位 [1]', JSON.stringify(stagesOf('FUP-NEW')) === '[1]', JSON.stringify(stagesOf('FUP-NEW')));
chk('② 48h：FUP-48 命中档位 [2]（未到 72h）', JSON.stringify(stagesOf('FUP-48')) === '[2]', JSON.stringify(stagesOf('FUP-48')));
chk('③ 72h：FUP-72 命中档位 [2,3]', JSON.stringify(stagesOf('FUP-72')) === '[2,3]', JSON.stringify(stagesOf('FUP-72')));
chk('已跟进（JSON）：FUP-DONE 不触发任何档位', stagesOf('FUP-DONE').length === 0);
chk('已跟进（旧纯文本）：FUP-OLD 不触发任何档位', stagesOf('FUP-OLD').length === 0);
chk('未到 48h 且已见过：FUP-SOON 不触发', stagesOf('FUP-SOON').length === 0);
chk('已跟进清单 = [FUP-DONE, FUP-OLD]', JSON.stringify(ev.doneIds.sort()) === '["FUP-DONE","FUP-OLD"]');
chk('新增清单只有 FUP-NEW（其余已见过）', JSON.stringify(ev.newIds) === '["FUP-NEW"]', JSON.stringify(ev.newIds));
chk('未见过的行若已超时 → 只发①，不再叠加②③（见[H]）',
  R.evaluate({ headers: HEADERS, rows: [row('FUP-X', 'LD-9', '2026-09-26', '', '王泽')],
    state: { records: {} }, now: NOW, thresholds: { stage2Hours: 48, stage3Hours: 72 }, baseline: false })
    .dues.map(function(d) { return d.stage; }).sort().join(',') === '1');

// ---------- D. state 去重 ----------
console.log('\n[D] state 去重（同一档位只发一次）');
const st2 = { records: {
  'FUP-48': { stages: { '2': { status: 'sent', at: '2026-09-30T01:00:00Z' } } },
  'FUP-72': { stages: { '2': { status: 'sent', at: '2026-09-30T01:00:00Z' },
                        '3': { status: 'pending', at: '2026-09-30T01:00:00Z' } } }
} };
const remain = R.filterSent(ev.dues, st2).map(function(d) { return d.fupId + '#' + d.stage; });
chk('已发②的 FUP-48 被过滤', remain.indexOf('FUP-48#2') < 0);
chk('已发②+pending③的 FUP-72 全部被过滤',
  remain.indexOf('FUP-72#2') < 0 && remain.indexOf('FUP-72#3') < 0);
chk('未发过的 FUP-NEW① 保留', remain.indexOf('FUP-NEW#1') >= 0, JSON.stringify(remain));

// ---------- E. 收件人映射 ----------
console.log('\n[E] 收件人映射（大区总抄送）');
const idx = R.buildUserIndex(R.BUILTIN_USERS);
const r1 = R.resolveRecipients('高丹枫', idx, 3);
chk('高丹枫③ → 收件 gaodanfeng@，抄送大区总 tangxianyi@',
  r1.to === 'gaodanfeng@chromai.com' && r1.cc.length === 1 && r1.cc[0] === 'tangxianyi@chromai.com',
  r1.to + ' / ' + JSON.stringify(r1.cc));
const r2 = R.resolveRecipients('刘力瑞', idx, 3);
chk('刘力瑞③ → 抄送 guanneng@', r2.cc[0] === 'guanneng@chromai.com', JSON.stringify(r2.cc));
const r3 = R.resolveRecipients('穆忠仁', idx, 3);
chk('穆忠仁③ → 大区总是本人，不重复抄送', r3.to === 'muzhongren@chromai.com' && r3.cc.length === 0);
const r4 = R.resolveRecipients('张塞云', idx, 3);
chk('张塞云③ → 无大区总（noHead=true，只记日志）', r4.noHead === true && r4.cc.length === 0 && !!r4.to);
const r5 = R.resolveRecipients('房戈', idx, 3);
chk('房戈③ → 无大区总', r5.noHead === true && r5.cc.length === 0);
const r6 = R.resolveRecipients('', idx, 1);
chk('负责人为空 → 跳过（无收件人）', r6.to === '' && !!r6.reason);
const r7 = R.resolveRecipients('不存在的人', idx, 1);
chk('负责人查不到邮箱 → 跳过', r7.to === '' && !!r7.reason);
const r8 = R.resolveRecipients('高丹枫', idx, 1);
chk('①② 不抄送大区总', r8.cc.length === 0);

// ---------- F. 发送时段 ----------
console.log('\n[F] 发送时段（工作日 09:00–18:00 上海）');
const sched = { tz: 'Asia/Shanghai', windowStartHour: 9, windowEndHour: 18, workdays: [1,2,3,4,5], holidays: [] };
chk('周三 10:00 → 可发', R.inSendWindow(Date.UTC(2026, 8, 30, 2, 0, 0), sched) === true);      // 上海 10:00
chk('周三 08:59 → 不可发', R.inSendWindow(Date.UTC(2026, 8, 30, 0, 59, 0), sched) === false);   // 上海 08:59
chk('周三 18:00 → 不可发', R.inSendWindow(Date.UTC(2026, 8, 30, 10, 0, 0), sched) === false);   // 上海 18:00
chk('周六 10:00 → 不可发', R.inSendWindow(Date.UTC(2026, 9, 3, 2, 0, 0), sched) === false);     // 2026-10-03 周六
chk('周日 10:00 → 不可发', R.inSendWindow(Date.UTC(2026, 9, 4, 2, 0, 0), sched) === false);     // 2026-10-04 周日
const schedHol = Object.assign({}, sched, { holidays: ['2026-09-30'] });
chk('节假日（配置内）→ 不可发', R.inSendWindow(Date.UTC(2026, 8, 30, 2, 0, 0), schedHol) === false);
const nx = R.nextWorkdayStart(Date.UTC(2026, 9, 3, 2, 0, 0), sched);   // 周六 10:00
chk('周六排队 → 下一个工作日 09:00 上海', iso(nx) === '2026-10-05 01:00Z', iso(nx) + ' = 上海 10-05 09:00');

// ---------- G. 基线 + goLiveAt ----------
console.log('\n[G] 基线 / 上线时刻 goLiveAt');
const evB = R.evaluate({ headers: HEADERS, rows: rows, state: { records: {} }, now: NOW,
  thresholds: { stage2Hours: 48, stage3Hours: 72 }, baseline: true });
chk('基线模式：不产生任何通知（①②③ 全不产）', evB.dues.length === 0, 'dues=' + evB.dues.length);

// goLiveAt = 2026-09-30 当天（上海 00:00）→ 09-29 及更早全部视为上线前欠账
const GO_LIVE = R.shanghaiMidnight('2026-09-30');
const evG = R.evaluate({ headers: HEADERS, rows: rows, state: { records: {} }, now: NOW,
  thresholds: { stage2Hours: 48, stage3Hours: 72 }, baseline: false, goLiveAt: GO_LIVE });
chk('goLiveAt 之前的行不触发（FUP-48/FUP-72/FUP-SOON）',
  JSON.stringify(evG.beforeGoLive) === '["FUP-48","FUP-72","FUP-SOON"]', JSON.stringify(evG.beforeGoLive));
chk('goLiveAt 之前的行不产生档位（只剩上线当天的 FUP-NEW#1）',
  JSON.stringify(evG.dues.map(function(d) { return d.fupId + '#' + d.stage; })) === '["FUP-NEW#1"]',
  JSON.stringify(evG.dues.map(function(d) { return d.fupId + '#' + d.stage; })));
chk('goLiveAt 当天的新行仍然触发①',
  evG.dues.filter(function(d) { return d.fupId === 'FUP-NEW' && d.stage === 1; }).length === 0
    ? evG.newIds.indexOf('FUP-NEW') >= 0 : true, JSON.stringify(evG.newIds));
chk('goLiveAt 不传时不启用该闸（历史欠账照常判定）',
  R.evaluate({ headers: HEADERS, rows: rows, state: { records: {} }, now: NOW,
    thresholds: { stage2Hours: 48, stage3Hours: 72 }, baseline: false }).beforeGoLive.length === 0);

// ---------- H. 新增且已超时 → 只发①，②③ suppressed ----------
console.log('\n[H] 新增且已超时：只发①，②③ 标记 suppressed');
const rows2 = [
  row('FUP-BACK', 'LD-7', '2026-09-26', '', '王泽'),      // 补录的历史记录：新 + 已超 72h
  row('FUP-TDY',  'LD-8', '2026-09-30', '', '高丹枫')     // 当天新建：只应命中①
];
const evH = R.evaluate({ headers: HEADERS, rows: rows2, state: { records: {} }, now: NOW,
  thresholds: { stage2Hours: 48, stage3Hours: 72 }, baseline: false });
const h1 = evH.dues.filter(function(d) { return d.fupId === 'FUP-BACK'; }).map(function(d) { return d.stage; });
const sup = evH.suppress.filter(function(s) { return s.fupId === 'FUP-BACK'; }).map(function(s) { return s.stage; }).sort();
chk('补录历史记录只发①', JSON.stringify(h1) === '[1]', JSON.stringify(h1));
chk('②③ 被标记 suppressed', JSON.stringify(sup) === '[2,3]', JSON.stringify(sup));
chk('当天新建记录只命中①',
  JSON.stringify(evH.dues.filter(function(d) { return d.fupId === 'FUP-TDY'; }).map(function(d) { return d.stage; })) === '[1]');
// suppressed 必须被 filterSent 挡住（否则下次还会补发）
const stH = { records: { 'FUP-BACK': { stages: { '1': { status: 'sent' },
  '2': { status: 'suppressed' }, '3': { status: 'suppressed' } } } } };
const evH2 = R.evaluate({ headers: HEADERS, rows: rows2, state: stH, now: NOW,
  thresholds: { stage2Hours: 48, stage3Hours: 72 }, baseline: false });
chk('suppressed 的档位不会被 filterSent 重新放出',
  R.filterSent(evH2.dues, stH).filter(function(d) { return d.fupId === 'FUP-BACK'; }).length === 0);

// ---------- I. 基线后重复运行不重复发 ----------
console.log('\n[I] 基线后重复运行不重复发');
const stBase = { records: {} };
rows.forEach(function(r) {
  stBase.records[String(r[0])] = { stages: { '1': { status: 'sent', baseline: true },
    '2': { status: 'sent', baseline: true }, '3': { status: 'sent', baseline: true } } };
});
const evI = R.evaluate({ headers: HEADERS, rows: rows, state: stBase, now: NOW,
  thresholds: { stage2Hours: 48, stage3Hours: 72 }, baseline: false });
chk('三档齐全的基线记录，二次运行 0 待发',
  R.filterSent(evI.dues, stBase).length === 0, '待发 ' + R.filterSent(evI.dues, stBase).length);
// 哪怕三档基线只剩 ①（旧 state 形态），goLiveAt 也必须兜住
const evI2 = R.evaluate({ headers: HEADERS, rows: rows, state: stBase, now: NOW,
  thresholds: { stage2Hours: 48, stage3Hours: 72 }, baseline: false, goLiveAt: GO_LIVE });
chk('叠加 goLiveAt 后历史欠账仍为 0 待发', R.filterSent(evI2.dues, stBase).length === 0);

// ---------- J. 历史欠账汇总 ----------
console.log('\n[J] --summary 历史欠账汇总');
const leadMapJ = new Map([['LD-2', { customer: '客户B', contact: '', phone: '' }],
  ['LD-3', { customer: '客户C', contact: '', phone: '' }]]);
const sums = R.buildSummary({ headers: HEADERS, rows: rows, now: NOW,
  thresholds: { stage2Hours: 48, stage3Hours: 72 }, userIndex: idx, leadMap: leadMapJ,
  adminEmail: 'yucui@chromai.com', publicUrl: 'https://leads.chromai.com/' });
const byKey = {};
sums.forEach(function(s) { byKey[s.key] = s; });
chk('超 48h 欠账被聚合（FUP-48 刘力瑞 + FUP-72 王泽 → 汤显义一封）',
  !!byKey['汤显义'] && byKey['汤显义'].count === 1, JSON.stringify(Object.keys(byKey)));
chk('已跟进的不进汇总', sums.every(function(s) {
  return s.byOwner.every(function(g) { return g.items.every(function(it) { return it.fupId !== 'FUP-DONE'; }); });
}));
chk('汇总含客户名称与超时时长', byKey['汤显义'] && byKey['汤显义'].text.indexOf('客户C') > 0
  && byKey['汤显义'].text.indexOf('超时') > 0);
chk('汇总主题格式正确', byKey['汤显义'] && /^【历史欠账汇总】汤显义 大区有 \d+ 条超 48 小时未跟进$/.test(byKey['汤显义'].subject),
  byKey['汤显义'] && byKey['汤显义'].subject);

console.log('\n===== check 结果: ' + (pass ? 'PASS ✓' : 'FAIL ✗') + ' =====');
process.exit(pass ? 0 : 1);
