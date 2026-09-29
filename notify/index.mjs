#!/usr/bin/env node
/**
 * index.mjs —— MQLs 跟进提醒主流程
 *
 * 用法：
 *   node index.mjs           正常跑（按发送时段决定是否真发）
 *   node index.mjs --dry     只打印待发清单，不发信
 *   node index.mjs --init    只建立基线（把当前全量跟进编号记为已发①），不发信
 *   node index.mjs --fixture <file.json>   用本地假数据跑（离线验证用，不连服务器）
 *
 * 三封邮件规则见 rules.mjs 顶部注释。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as R from './rules.mjs';
import * as Mailer from './mailer.mjs';
import * as Hub from './hub.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'state.json');
const LOGS_DIR = path.join(__dirname, 'logs');

const STAGE_NAME = { 1: '① 新增', 2: '② 48h', 3: '③ 72h' };

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const ARGS = {
  dry: argv.includes('--dry') || argv.includes('--dry-run'),
  init: argv.includes('--init'),
  fixture: (function() {
    const i = argv.indexOf('--fixture');
    return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
  })(),
  summary: argv.includes('--summary'),
  // --summary-mode=head 可切回「按大区总聚合」的旧行为；默认 owner（发负责人、抄送大区总）
  summaryMode: (function() {
    const m = /--summary-mode[= ]+(\S+)/.exec(argv.join(' '));
    return m ? String(m[1]).trim() : '';
  })(),
  // --only-new：本次只处理档位①（新增），用于高频轮询「新增即时发信」
  onlyNew: argv.includes('--only-new') || argv.includes('--stage1'),
  limit: (function() {
    const i = argv.indexOf('--limit');
    return i >= 0 && argv[i + 1] ? parseInt(argv[i + 1], 10) : 0;
  })()
};

// ---------------- 日志 ----------------
let LOG_FILE = '';
function log(line) {
  const t = new Date().toISOString();
  const out = '[' + t + '] ' + line;
  console.log(out);
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, out + '\n', 'utf8'); } catch (e) { /* ignore */ }
  }
}

// ---------------- 配置 / 状态 ----------------
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('缺少 config.json，请先复制 config.example.json 并填写（config.json 已 gitignore）');
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg.schedule = cfg.schedule || {};
  cfg.thresholds = cfg.thresholds || { stage2Hours: 48, stage3Hours: 72 };
  cfg.hub = cfg.hub || { enabled: false };
  cfg.options = cfg.options || {};
  return cfg;
}

function emptyState() {
  return { version: 1, createdAt: '', updatedAt: '', baselineAt: '', meta: { goLiveAt: 0 }, records: {}, pending: [] };
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return emptyState();
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    s.records = s.records || {};
    s.pending = Array.isArray(s.pending) ? s.pending : [];
    s.meta = s.meta || { goLiveAt: 0 };
    return s;
  } catch (e) {
    log('state.json 解析失败，按空状态处理（不丢数据，仅重新基线化风险）: ' + e.message);
    return emptyState();
  }
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

// ---------------- 数据获取 ----------------
async function apiLogin(cfg) {
  const url = cfg.site.baseUrl.replace(/\/+$/, '') + cfg.site.loginPath;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cfg.admin.email, password: cfg.admin.password })
  });
  const j = await res.json().catch(function() { return {}; });
  if (!res.ok || !j.token) {
    throw new Error('登录失败 HTTP ' + res.status + ' ' + (j.error || ''));
  }
  return j.token;
}

async function apiGet(cfg, token, pathname) {
  const url = cfg.site.baseUrl.replace(/\/+$/, '') + pathname;
  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!res.ok) throw new Error('GET ' + pathname + ' 失败 HTTP ' + res.status);
  return await res.json();
}

async function fetchAll(cfg) {
  if (ARGS.fixture) {
    const fx = JSON.parse(fs.readFileSync(path.resolve(ARGS.fixture), 'utf8'));
    log('使用本地假数据: ' + ARGS.fixture);
    return {
      followups: fx.followups || { headers: [], data: [] },
      leads: fx.leads || { headers: [], data: [] },
      users: fx.users || null
    };
  }
  const token = await apiLogin(cfg);
  log('登录成功（admin ' + cfg.admin.email + '，token 已获取，不打印）');
  const [followups, leads] = await Promise.all([
    apiGet(cfg, token, cfg.site.followupsPath),
    apiGet(cfg, token, cfg.site.leadsPath)
  ]);
  let users = null;
  try {
    const u = await apiGet(cfg, token, cfg.site.usersPath);
    if (u && Array.isArray(u.users) && u.users.length) users = u.users;
  } catch (e) {
    log('/api/users 拉取失败，回落到内置账号表: ' + e.message);
  }
  if (!users) {
    users = R.BUILTIN_USERS;
    log('使用内置账号表（' + users.length + ' 人）');
  } else {
    log('使用线上账号表（' + users.length + ' 人）');
  }
  return { followups: followups, leads: leads, users: users };
}

/** 线索编号 → 线索行字段（客户名称/联系人/联系电话） */
function buildLeadMap(leads) {
  const headers = (leads && leads.headers) || [];
  const map = new Map();
  const C_ID = R.colIndex(headers, '线索编号');
  const C_NAME = R.colIndexAny(headers, ['客户名称(脱敏)', '客户名称']);
  const C_CONTACT = R.colIndex(headers, '联系人');
  const C_PHONE = R.colIndexAny(headers, ['联系电话', '电话']);
  ((leads && leads.data) || []).forEach(function(row) {
    if (!Array.isArray(row) || C_ID < 0) return;
    const id = String(row[C_ID] || '').trim();
    if (!id) return;
    map.set(id, {
      customer: C_NAME >= 0 ? String(row[C_NAME] || '').trim() : '',
      contact: C_CONTACT >= 0 ? String(row[C_CONTACT] || '').trim() : '',
      phone: C_PHONE >= 0 ? String(row[C_PHONE] || '').trim() : ''
    });
  });
  return map;
}

// ---------------- 通知构造 ----------------
function buildNotification(stage, row, headers, leadMap, cfg, userIndex) {
  const C_ID = R.colIndex(headers, '跟进编号');
  const C_LD = R.colIndex(headers, '线索编号');
  const C_DT = R.colIndex(headers, '跟进日期');
  const C_OW = R.colIndex(headers, '负责人');
  const C_FB = R.colIndexAny(headers, ['首次反馈', '跟进内容']);
  const C_MDL = R.colIndex(headers, '产品型号意向');
  const C_BUD = R.colIndexAny(headers, ['预算范围(万元)', '预算范围']);
  const C_WIN = R.colIndex(headers, '采购时间窗');
  const C_PL = R.colIndex(headers, '下一步计划');

  const ownerName = C_OW >= 0 ? String(row[C_OW] || '').trim() : '';
  const rc = R.resolveRecipients(ownerName, userIndex, stage);
  if (!rc.to) return { skip: true, reason: rc.reason || '无收件人', fupId: String(row[C_ID] || '') };

  const leadId = C_LD >= 0 ? String(row[C_LD] || '').trim() : '';
  const lead = leadMap.get(leadId) || { customer: '', contact: '', phone: '' };
  const ctx = {
    stage: stage,
    fupId: String(row[C_ID] || '').trim(),
    leadId: leadId,
    owner: ownerName,
    followDate: C_DT >= 0 ? String(row[C_DT] || '').trim() : '',
    overdueHours: R.overdueHours(C_DT >= 0 ? String(row[C_DT] || '') : '', Date.now()),
    customer: lead.customer,
    contact: lead.contact,
    phone: lead.phone,
    model: C_MDL >= 0 ? String(row[C_MDL] || '').trim() : '',
    budget: C_BUD >= 0 ? String(row[C_BUD] || '').trim() : '',
    window: C_WIN >= 0 ? String(row[C_WIN] || '').trim() : '',
    firstFeedback: C_FB >= 0 ? String(row[C_FB] || '').trim() : '',
    nextPlan: C_PL >= 0 ? String(row[C_PL] || '').trim() : '',
    // 深链：?fup=跟进编号 → 打开页面自动弹出该条详情（需前端支持，config.options.deepLink 控制）
    publicUrl: deepLinkUrl(cfg, ctx.fupId)
  };
  return {
    skip: false,
    fupId: ctx.fupId,
    leadId: ctx.leadId,
    stage: stage,
    owner: ownerName,
    head: rc.head ? rc.head.name : null,
    to: rc.to,
    cc: rc.cc,
    noHead: rc.noHead,
    followDate: ctx.followDate,
    overdueHours: ctx.overdueHours,
    customer: ctx.customer,
    contact: ctx.contact,
    phone: ctx.phone,
    model: ctx.model,
    budget: ctx.budget,
    window: ctx.window,
    firstFeedback: ctx.firstFeedback,
    nextPlan: ctx.nextPlan,
    publicUrl: ctx.publicUrl,
    subject: R.buildSubject(stage, ctx.customer),
    text: R.buildText(ctx),
    html: R.buildHtml(ctx)
  };
}

/** 单条线索的直达链接（开启 deepLink 时带 ?fup=跟进编号，点开即弹该条详情） */
function deepLinkUrl(cfg, fupId) {
  const base = (cfg.site && cfg.site.publicUrl) || 'https://leads.chromai.com/';
  if (!(cfg.options && cfg.options.deepLink)) return base;
  const id = String(fupId || '').trim();
  if (!id) return base;
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'fup=' + encodeURIComponent(id);
}

/** 第③封的抄送说明（区分「无大区总」与「大区总即本人」） */
function ccDesc(n) {
  if (n.stage !== 3) return '';
  if (n.cc && n.cc.length) return ' 抄送 ' + n.cc.join(',');
  if (n.noHead) return ' 抄送 —（无大区总，仅记日志）';
  if (n.head) return ' 抄送 —（大区总即本人 ' + n.head + '，不重复抄送）';
  return ' 抄送 —';
}

// ---------------- 主流程 ----------------
async function main() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const now = new Date();
  LOG_FILE = path.join(LOGS_DIR, now.toISOString().slice(0, 10) + '.log');

  const cfg = loadConfig();
  const state = loadState();
  const nowMs = now.getTime();
  const inWindow = R.inSendWindow(nowMs, cfg.schedule);
  const isDry = ARGS.dry || !!cfg.options.dryRun;

  log('===== 运行开始 =====');
  log('模式: ' + (ARGS.init ? '--init 基线' : (isDry ? '--dry 演练' : '正常'))
    + ' | 发送窗口: ' + (inWindow ? '内（可发送）' : '外（入队待补发）'));
  log('SMTP: ' + cfg.smtp.host + ':' + cfg.smtp.port + ' user=' + cfg.smtp.user
    + ' pass=' + Mailer.mask(Mailer.resolveSmtpPass(cfg.smtp)));

  const data = await fetchAll(cfg);
  const fupHeaders = (data.followups && data.followups.headers) || [];
  let fupRows = (data.followups && data.followups.data) || [];
  const userIndex = R.buildUserIndex(data.users);
  const leadMap = buildLeadMap(data.leads);

  log('数据: 跟进记录 ' + fupRows.length + ' 行 / ' + fupHeaders.length + ' 列；线索 ' + ((data.leads.data || []).length) + ' 行');

  if (!fupHeaders.length || !fupRows.length) {
    log('无跟进数据，退出');
    saveState(state);
    return;
  }
  if (ARGS.limit > 0) { fupRows = fupRows.slice(0, ARGS.limit); log('（--limit 截断为 ' + fupRows.length + ' 行）'); }

  // ---- --summary：历史欠账按大区总汇总（显式执行，与正常扫描互斥）----
  if (ARGS.summary) {
    const sumMode = ARGS.summaryMode === 'head' ? 'head' : 'owner';
    const sums = R.buildSummary({
      headers: fupHeaders, rows: fupRows, now: nowMs, thresholds: cfg.thresholds,
      userIndex: userIndex, leadMap: leadMap,
      adminEmail: (cfg.admin && cfg.admin.email) || '',
      publicUrl: (cfg.site && cfg.site.publicUrl) || 'https://leads.chromai.com/',
      mode: sumMode
    });
    log('历史欠账汇总：' + sums.length + ' 封（超 48h 未跟进，'
      + (sumMode === 'owner' ? '按负责人分信、抄送大区总' : '按大区总聚合') + '）');
    if (isDry || !inWindow) {
      sums.forEach(function(s, i) {
        log(String(i + 1).padStart(3, ' ') + '. 收件 ' + s.to
          + (s.cc && s.cc.length ? ' | 抄送 ' + s.cc.join(',') : '')
          + ' | ' + (s.ownerName ? s.ownerName + '（负责人）'
            : (s.headName ? s.headName + ' 大区' : 'IVD / 未归属（admin 兜底）'))
          + ' | ' + s.count + ' 条 | ' + s.subject);
        s.byOwner.forEach(function(g) {
          log('       - ' + g.owner + '：' + g.items.length + ' 条（最长超时 '
            + g.items[0].overdueHours + ' 小时）');
        });
      });
      log('合计汇总 ' + sums.length + ' 封，覆盖 ' + sums.reduce(function(a, s) { return a + s.count; }, 0)
        + ' 条欠账' + (isDry ? '（dry 未发送）' : '（不在发送窗口，未发送）'));
    } else {
      const transport = await Mailer.createTransport(cfg.smtp);
      let ok = 0, bad = 0;
      for (const s of sums) {
        const r = await Mailer.sendMail(transport, {
          from: cfg.smtp.from, to: s.to, cc: s.cc || [],
          subject: s.subject, text: s.text, html: s.html
        });
        if (r.ok) { ok++; log('汇总已发送 → ' + s.to + (s.cc && s.cc.length ? '（抄送 ' + s.cc.join(',') + '）' : '') + ' | ' + s.subject); }
        else { bad++; log('汇总发送失败 → ' + s.to + ' : ' + r.error); }
      }
      try { transport.close(); } catch (e) { /* ignore */ }
      log('汇总发送完成：成功 ' + ok + ' / 失败 ' + bad);
    }
    saveState(state);
    log('===== 运行结束 =====');
    return;
  }

  const needBaseline = ARGS.init || Object.keys(state.records).length === 0;

  // ---- 首次基线：全量记为已发①，一封都不发 ----
  if (needBaseline) {
    const C_ID = R.colIndex(fupHeaders, '跟进编号');
    const C_LD = R.colIndex(fupHeaders, '线索编号');
    const C_DT = R.colIndex(fupHeaders, '跟进日期');
    const C_OW = R.colIndex(fupHeaders, '负责人');
    const at = new Date().toISOString();
    let n = 0;
    fupRows.forEach(function(row) {
      if (!Array.isArray(row)) return;
      const id = String(row[C_ID] || '').trim();
      if (!id) return;
      const prev = state.records[id];
      // ⚠️ 基线必须覆盖 ① ② ③ 三个档位：否则上线前的历史欠账会全部漏出，一次性群发上百封。
      //    语义 = 「提醒系统上线之前的欠账不补发」，只提醒上线之后新发生的事件。
      const baseStages = {};
      [1, 2, 3].forEach(function(st) { baseStages[String(st)] = { status: 'sent', at: at, baseline: true }; });
      state.records[id] = {
        leadId: C_LD >= 0 ? String(row[C_LD] || '').trim() : '',
        owner: C_OW >= 0 ? String(row[C_OW] || '').trim() : '',
        followDate: C_DT >= 0 ? String(row[C_DT] || '').trim() : '',
        firstSeenAt: prev && prev.firstSeenAt ? prev.firstSeenAt : at,
        lastSeenAt: at,
        stages: (prev && prev.stages && Object.keys(prev.stages).length) ? prev.stages : baseStages,
        done: false
      };
      if (!prev) n++;
    });
    state.createdAt = state.createdAt || at;
    state.baselineAt = at;
    // 上线时刻：第二道闸。即使 state.json 丢失重建，早于该日的行也不再补发历史欠账。
    if (!state.meta.goLiveAt) state.meta.goLiveAt = nowMs;
    saveState(state);
    log('基线建立完成：写入 ' + Object.keys(state.records).length + ' 条（新增 ' + n + ' 条），'
      + '①②③ 三档全部标记为 baseline，**发出 0 封**');
    log('上线时刻 goLiveAt = ' + new Date(state.meta.goLiveAt).toISOString()
      + '（早于该日的跟进记录一律跳过，记 before_go_live）');
    log('===== 运行结束 =====');
    return;
  }

  // ---- 更新 state 中的记录快照 ----
  const C_ID = R.colIndex(fupHeaders, '跟进编号');
  const C_LD = R.colIndex(fupHeaders, '线索编号');
  const C_DT = R.colIndex(fupHeaders, '跟进日期');
  const C_OW = R.colIndex(fupHeaders, '负责人');
  const atIso = new Date().toISOString();
  fupRows.forEach(function(row) {
    if (!Array.isArray(row)) return;
    const id = String(row[C_ID] || '').trim();
    if (!id) return;
    let rec = state.records[id];
    if (!rec) {
      rec = { leadId: '', owner: '', followDate: '', firstSeenAt: atIso, lastSeenAt: atIso, stages: {}, done: false };
      state.records[id] = rec;
    }
    rec.leadId = C_LD >= 0 ? String(row[C_LD] || '').trim() : rec.leadId;
    rec.owner = C_OW >= 0 ? String(row[C_OW] || '').trim() : rec.owner;
    rec.followDate = C_DT >= 0 ? String(row[C_DT] || '').trim() : rec.followDate;
    rec.lastSeenAt = atIso;
  });

  // ---- 判定 ----
  const goLiveAt = state.meta.goLiveAt || 0;
  const ev = R.evaluate({
    headers: fupHeaders, rows: fupRows, state: state, now: nowMs,
    thresholds: cfg.thresholds, baseline: false, goLiveAt: goLiveAt
  });
  // 新首次出现且已超时 → ②③ 本次抑制（多为补录历史数据，一次发 3 封属于轰炸）
  ev.suppress.forEach(function(s) {
    const rec = state.records[s.fupId];
    if (rec) rec.stages[String(s.stage)] = { status: 'suppressed', at: atIso, reason: s.reason };
  });
  if (ev.suppress.length) {
    log('新增且已超时：抑制 ②③ ' + ev.suppress.length + ' 个档位（只发①，原因：' + (ev.suppress[0] && ev.suppress[0].reason) + '）');
  }
  if (ev.beforeGoLive.length) {
    log('上线日（' + new Date(goLiveAt).toISOString().slice(0, 10) + '）之前的存量记录 ' + ev.beforeGoLive.length + ' 条：跳过，不补发（before_go_live）');
  }
  // 已填跟进记录 → 取消待发队列中的相关项
  const doneSet = new Set(ev.doneIds);
  let cancelled = 0;
  state.pending = state.pending.filter(function(p) {
    if (doneSet.has(p.fupId)) { cancelled++; return false; }
    return true;
  });
  if (cancelled) log('已跟进，取消待发队列 ' + cancelled + ' 项');

  let dues = R.filterSent(ev.dues, state);
  if (ARGS.onlyNew) {
    const before = dues.length;
    dues = dues.filter(function(d) { return Number(d.stage) === 1; });
    log('--only-new：本次只处理档位①（新增即时发信），暂缓 ' + (before - dues.length) + ' 个 ②③ 档位（留给每日定时扫描）');
  }
  log('判定结果：新增 ' + ev.newIds.length + ' 条 / 已跟进 ' + ev.doneIds.length
    + ' 条 / 上线前存量 ' + ev.beforeGoLive.length + ' 条 / 待发档位 ' + dues.length + ' 个'
    + (ev.suppress.length ? ' / 抑制 ' + ev.suppress.length + ' 个' : ''));

  // ---- 构造通知 ----
  const notifications = [];
  const skipped = [];
  for (const d of dues) {
    const row = fupRows[d.row];
    const n = buildNotification(d.stage, row, fupHeaders, leadMap, cfg, userIndex);
    if (n.skip) { skipped.push(n); continue; }
    notifications.push(n);
  }
  if (skipped.length) {
    skipped.forEach(function(s) { log('跳过：' + s.fupId + ' —— ' + s.reason); });
  }

  // ---- 按「负责人 + 档位」合并：同一人多条线索只发一封，不逐条轰炸 ----
  const groupMap = new Map();
  notifications.forEach(function(n) {
    const key = n.stage + '#' + n.to;
    let g = groupMap.get(key);
    if (!g) {
      g = { stage: n.stage, to: n.to, cc: n.cc || [], head: n.head, noHead: n.noHead, items: [] };
      groupMap.set(key, g);
    }
    g.items.push(n);
  });
  const mails = Array.from(groupMap.values()).map(function(g) {
    const first = g.items[0];
    return {
      stage: g.stage,
      to: g.to,
      cc: g.cc,
      head: g.head,
      noHead: g.noHead,
      fupIds: g.items.map(function(x) { return x.fupId; }),
      items: g.items,
      subject: R.buildSubjectMulti(g.stage, g.items.length, first.customer),
      text: R.buildTextMulti(g.stage, first.owner, g.items),
      html: R.buildHtmlMulti(g.stage, first.owner, g.items)
    };
  });
  if (notifications.length !== mails.length) {
    log('已合并：' + notifications.length + ' 条线索 → ' + mails.length + ' 封邮件（同一负责人同一档位合并）');
  }

  // ---- 待发队列补发（仅发送窗口内）----
  let flushed = 0;
  if (state.pending.length) {
    if (!inWindow) {
      log('待发队列 ' + state.pending.length + ' 项：不在发送窗口，继续等待（下一个工作日 09:00 后自动补发）');
    } else if (isDry) {
      log('待发队列 ' + state.pending.length + ' 项（dry 模式不补发）');
    } else {
      const transport = await Mailer.createTransport(cfg.smtp);
      const remain = [];
      for (const p of state.pending) {
        if (ARGS.onlyNew && Number(p.stage) !== 1) { remain.push(p); continue; }
        const r = await Mailer.sendMail(transport, {
          from: cfg.smtp.from, to: p.to, cc: p.cc, subject: p.subject, text: p.text, html: p.html
        });
        if (r.ok) {
          flushed++;
          const ids = Array.isArray(p.fupIds) && p.fupIds.length ? p.fupIds : [p.fupId];
          ids.forEach(function(id) {
            const rec = state.records[id];
            if (rec) rec.stages[String(p.stage)] = { status: 'sent', at: new Date().toISOString(), queued: true };
          });
          log('补发成功 ' + STAGE_NAME[p.stage] + ' → ' + p.to + ' | ' + ids.length + ' 条 | ' + p.subject);
        } else {
          remain.push(p);
          log('补发失败（保留队列）' + (p.fupIds || [p.fupId]).join(',') + ' → ' + p.to + ' : ' + r.error);
        }
      }
      try { transport.close(); } catch (e) { /* ignore */ }
      state.pending = remain;
      log('补发完成：成功 ' + flushed + ' / 剩余 ' + remain.length);
    }
  }

  // ---- 发送 / 入队 / 演练 ----
  let sent = 0, queued = 0, failed = 0;
  if (isDry) {
    log('---- 待发清单（dry，未发送）----');
    mails.forEach(function(m, i) {
      log(String(i + 1).padStart(3, ' ') + '. ' + STAGE_NAME[m.stage]
        + ' | ' + m.items.length + ' 条 | 收件 ' + m.to
        + ccDesc(m.items[0])
        + ' | ' + m.subject);
      m.items.forEach(function(x, j) {
        log('         ' + (j + 1) + ') ' + x.fupId + '  ' + (x.customer || '（未关联客户）')
          + '  超时 ' + x.overdueHours + 'h');
      });
    });
    log('合计待发 ' + mails.length + ' 封（共 ' + notifications.length + ' 条线索，dry 未发送）');
  } else if (!inWindow) {
    const seen = new Set(state.pending.map(function(p) { return p.stage + '#' + p.to; }));
    mails.forEach(function(m) {
      const key = m.stage + '#' + m.to;
      if (seen.has(key)) return;
      seen.add(key);
      state.pending.push({
        fupIds: m.fupIds, stage: m.stage, to: m.to, cc: m.cc,
        subject: m.subject, text: m.text, html: m.html, queuedAt: atIso
      });
      m.fupIds.forEach(function(id) {
        const rec = state.records[id];
        if (rec) rec.stages[String(m.stage)] = { status: 'pending', at: atIso };
      });
      queued++;
    });
    const nx = new Date(R.nextWorkdayStart(nowMs, cfg.schedule));
    log('不在发送窗口：入队 ' + queued + ' 封，预计 ' + nx.toISOString().slice(0, 16).replace('T', ' ') + '（上海时间）后补发');
  } else {
    const transport = await Mailer.createTransport(cfg.smtp);
    for (const m of mails) {
      const r = await Mailer.sendMail(transport, {
        from: cfg.smtp.from, to: m.to, cc: m.cc, subject: m.subject, text: m.text, html: m.html
      });
      const at = new Date().toISOString();
      m.items.forEach(function(x) { x.sentAt = at; x.dryRun = false; });
      if (r.ok) {
        sent++;
        m.fupIds.forEach(function(id) {
          const rec = state.records[id];
          if (rec) rec.stages[String(m.stage)] = { status: 'sent', at: at };
        });
        log('已发送 ' + STAGE_NAME[m.stage] + ' → ' + m.to
          + (m.cc.length ? '（抄送 ' + m.cc.join(',') + '）' : '')
          + (m.noHead ? '（无大区总，仅记日志）' : '')
          + ' | ' + m.items.length + ' 条 | ' + m.subject);
      } else {
        failed++;
        log('发送失败 ' + m.fupIds.join(',') + ' → ' + m.to + ' : ' + r.error);
      }
      // hub 通知按「线索」推送（每条一条），与邮件按人合并无关
      for (const x of m.items) {
        const h = await Hub.push(cfg.hub, x);
        if (!h.skipped && !h.ok) log('hub 推送失败 ' + x.fupId + ' : ' + (h.error || h.status));
      }
    }
    try { transport.close(); } catch (e) { /* ignore */ }
    log('发送完成：成功 ' + sent + ' 封 / 失败 ' + failed + ' 封（共 ' + notifications.length + ' 条线索）');
  }

  // dry 模式下也尝试 hub（仅在启用时才有副作用）
  if (isDry && Hub.isEnabled(cfg.hub)) {
    const hr = await Hub.pushAll(cfg.hub, notifications.map(function(n) { n.dryRun = true; return n; }));
    log('hub 推送(dry): sent=' + hr.sent + ' failed=' + hr.failed);
  }

  saveState(state);
  log('state 已保存：记录 ' + Object.keys(state.records).length + ' 条，待发队列 ' + state.pending.length + ' 项');
  log('===== 运行结束 =====');
}

main().catch(function(e) {
  console.error('运行失败: ' + ((e && e.stack) || e));
  process.exit(1);
});
