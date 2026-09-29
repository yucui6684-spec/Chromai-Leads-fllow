/**
 * selftest.mjs —— 发一封「真实格式」的测试邮件，用来验证 SMTP 通道与邮件排版
 *
 * 用法：node selftest.mjs
 * 收件人：config.selftest.to（缺省用 config.admin.email）
 *
 * 说明：
 *   - 内容取自线上真实数据（自动挑 3 条未跟进且已超时的记录），但**只发给测试收件人**，不会打扰销售
 *   - 主题带【测试】前缀，正文顶部有醒目提示，避免被误认为真实提醒
 */
import fs from 'fs';
import * as R from './rules.mjs';
import * as Mailer from './mailer.mjs';

const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const base = (cfg.site && cfg.site.baseUrl) || 'https://leads.chromai.com';
const to = (cfg.selftest && cfg.selftest.to) || (cfg.admin && cfg.admin.email);
const SAMPLE_N = 3;

async function getJson(p, token) {
  const res = await fetch(base + p, { headers: { Authorization: 'Bearer ' + token } });
  return res.json();
}

function colIndex(headers, name) {
  return Array.isArray(headers) ? headers.indexOf(name) : -1;
}

const lg = await fetch(base + ((cfg.site && cfg.site.loginPath) || '/api/auth/login'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: cfg.admin.email, password: cfg.admin.password })
});
const lgBody = await lg.json();
if (!lgBody.token) {
  console.error('登录失败，无法取数：', lg.status, JSON.stringify(lgBody).slice(0, 200));
  process.exit(1);
}
const token = lgBody.token;

const [fups, leads] = await Promise.all([
  getJson((cfg.site && cfg.site.followupsPath) || '/api/followups', token),
  getJson((cfg.site && cfg.site.leadsPath) || '/api/leads', token)
]);

// 线索池：线索编号 → 客户名称 / 联系人 / 联系电话
const LH = leads.headers || [];
const C_LID = colIndex(LH, '线索编号');
const C_NAME = colIndex(LH, '客户名称(脱敏)');
const C_CT = colIndex(LH, '联系人');
const C_PH = colIndex(LH, '联系电话');
const leadMap = new Map();
(leads.data || []).forEach(function(r) {
  const id = String(r[C_LID] || '').trim().toLowerCase();
  if (!id) return;
  leadMap.set(id, {
    customer: C_NAME >= 0 ? String(r[C_NAME] || '').trim() : '',
    contact: C_CT >= 0 ? String(r[C_CT] || '').trim() : '',
    phone: C_PH >= 0 ? String(r[C_PH] || '').trim() : ''
  });
});

// 跟进表列
const FH = fups.headers || [];
const F_ID = colIndex(FH, '跟进编号');
const F_LD = colIndex(FH, '线索编号');
const F_DT = colIndex(FH, '跟进日期');
const F_RC = FH.indexOf('跟进记录') >= 0 ? FH.indexOf('跟进记录') : FH.indexOf('跟进内容09.14');
const F_OW = colIndex(FH, '负责人');
const F_MDL = colIndex(FH, '产品型号意向');
const F_BUD = colIndex(FH, '预算范围(万元)');
const F_WIN = colIndex(FH, '采购时间窗');
const F_FB = FH.indexOf('首次反馈') >= 0 ? FH.indexOf('首次反馈') : FH.indexOf('跟进内容');
const F_PL = colIndex(FH, '下一步计划');

// 挑 SAMPLE_N 条「未跟进」的做样例（超时久的优先）
const cands = (fups.data || [])
  .filter(function(r) {
    const rec = F_RC >= 0 ? String(r[F_RC] || '').trim() : '';
    let n = 0;
    if (rec) { try { const a = JSON.parse(rec); n = Array.isArray(a) ? a.length : 1; } catch (e) { n = 1; } }
    return n === 0 && String(r[F_OW] || '').trim() && String(r[F_DT] || '').trim();
  })
  .sort(function(a, b) {
    return R.overdueHours(String(b[F_DT] || ''), Date.now()) - R.overdueHours(String(a[F_DT] || ''), Date.now());
  })
  .slice(0, SAMPLE_N);

if (!cands.length) {
  console.error('线上没有「未跟进」的样例记录，无法生成测试邮件');
  process.exit(1);
}

const stage = 2;
const items = cands.map(function(r) {
  const lead = leadMap.get(String(r[F_LD] || '').trim().toLowerCase()) || { customer: '', contact: '', phone: '' };
  return {
    stage: stage,
    fupId: String(r[F_ID] || '').trim(),
    leadId: String(r[F_LD] || '').trim(),
    owner: String(r[F_OW] || '').trim(),
    followDate: String(r[F_DT] || '').trim(),
    overdueHours: R.overdueHours(String(r[F_DT] || ''), Date.now()),
    customer: lead.customer,
    contact: lead.contact,
    phone: lead.phone,
    model: F_MDL >= 0 ? String(r[F_MDL] || '').trim() : '',
    budget: F_BUD >= 0 ? String(r[F_BUD] || '').trim() : '',
    window: F_WIN >= 0 ? String(r[F_WIN] || '').trim() : '',
    firstFeedback: F_FB >= 0 ? String(r[F_FB] || '').trim() : '',
    nextPlan: F_PL >= 0 ? String(r[F_PL] || '').trim() : '',
    publicUrl: (cfg.site && cfg.site.publicUrl) || 'https://leads.chromai.com/'
  };
});

const subject = '【测试】' + R.buildSubjectMulti(stage, items.length, items[0].customer);
const text = '※ 本邮件为「线索提醒发送通道」测试，请忽略。\n'
  + '※ 内容为线上真实数据样例，仅发送给你，不会打扰销售。\n\n'
  + R.buildTextMulti(stage, items[0].owner, items);
const html = '<p style="margin:0 0 12px;padding:8px 10px;background:#fff7ed;border-left:3px solid #f59e0b;'
  + 'font-size:12px;color:#92400e">本邮件为「线索提醒发送通道」测试，请忽略。内容为线上真实数据样例，仅发送给你。</p>'
  + R.buildHtmlMulti(stage, items[0].owner, items);

console.log('收件人：', to);
console.log('主题  ：', subject);
console.log('样例  ：', items.map(function(x) { return x.fupId + '(' + x.customer + ')'; }).join(', '));

const res = await Mailer.sendOnce(cfg.smtp, {
  from: cfg.smtp.from,
  to: to,
  subject: subject,
  text: text,
  html: html
});
if (res.ok) {
  console.log('✅ 测试邮件已发送，messageId =', res.messageId);
} else {
  console.error('❌ 发送失败：', res.error);
  process.exit(1);
}
