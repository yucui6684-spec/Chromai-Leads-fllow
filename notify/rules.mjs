/**
 * rules.mjs —— 判定规则（纯函数，无 IO，可被 check.mjs 直接单测）
 *
 * 三档提醒：
 *   ① 新增   state 里没见过的「跟进编号」
 *   ② 48h    跟进日期当天 00:00 + 48h ≤ now 且「跟进记录」子项数 = 0
 *   ③ 72h    跟进日期当天 00:00 + 72h ≤ now 且「跟进记录」子项数 = 0（抄送大区总）
 *
 * 时间基准：Asia/Shanghai（固定 UTC+8，无夏令时），「跟进日期」当天 00:00 为起点。
 * 一条线索最多这 3 封；一旦子项数 > 0，后续档位自动取消。
 */

/** 上海时区偏移（毫秒） */
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 表头名 → 列索引；找不到返回 -1（禁止硬编码索引，表头可被用户增删） */
export function colIndex(headers, name) {
  if (!Array.isArray(headers)) return -1;
  return headers.indexOf(name);
}

/**
 * 带备选名的列定位（迁移期兼容：新名优先，旧名兜底）
 * @param {string[]} headers 表头
 * @param {string[]} names 候选列名（按优先级）
 * @returns {number} 索引，全部命中不到返回 -1
 */
export function colIndexAny(headers, names) {
  for (const n of names || []) {
    const i = colIndex(headers, n);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * 解析「跟进记录」列 → 子项数量。
 * 新格式：JSON 数组字符串 [{"d":"YYYY-MM-DD","t":"..."}]；空值 '' → 0 条。
 * 旧纯文本（迁移前遗留）→ 降级为 1 条；解析失败但非空 → 1 条。
 * @param {*} cell 单元格原值
 * @returns {number} 子项数（0 / n）
 */
export function parseFollowupCount(cell) {
  if (cell === null || cell === undefined) return 0;
  const s = String(cell).trim();
  if (!s) return 0;
  if (s.charAt(0) === '[') {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.length;
    } catch (e) { /* 非法 JSON → 按纯文本降级为 1 条 */ }
  }
  return 1;
}

/**
 * 「跟进日期」当天 00:00（上海时间）对应的 UTC 时间戳。
 * 例：2026-09-20 → 上海 2026-09-20 00:00 = UTC 2026-09-19 16:00
 * @param {string} dateStr 'YYYY-MM-DD'（也容忍 'YYYY/MM/DD'、带时间的 ISO 串）
 * @returns {number} 毫秒时间戳；解析失败返回 NaN
 */
export function shanghaiMidnight(dateStr) {
  const s = String(dateStr || '').trim();
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return NaN;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
  return Date.UTC(y, mo - 1, d) - SHANGHAI_OFFSET_MS;
}

/**
 * 某档位是否已到期
 * @param {string} followDate 跟进日期
 * @param {number} hours 阈值小时数（48 / 72）
 * @param {number} now 当前时间戳（ms）
 * @returns {boolean} 到期（且日期可解析）
 */
export function isOverdue(followDate, hours, now) {
  const base = shanghaiMidnight(followDate);
  if (!isFinite(base)) return false;
  return now >= base + hours * 60 * 60 * 1000;
}

/**
 * 超时时长（小时，向下取整）
 * @returns {number} 小时数；日期不可解析返回 0
 */
export function overdueHours(followDate, now) {
  const base = shanghaiMidnight(followDate);
  if (!isFinite(base)) return 0;
  return Math.max(0, Math.floor((now - base) / (60 * 60 * 1000)));
}

/**
 * 某时间戳所在「上海日期」的当天 00:00（用于 goLiveAt 按天比较，避免当天新建的记录被误判为历史欠账）
 * @param {number} ts 毫秒时间戳
 * @returns {number} 当天 00:00（上海）的毫秒时间戳；非法返回 NaN
 */
export function shanghaiDayStart(ts) {
  const t = new Date(Number(ts) + SHANGHAI_OFFSET_MS);
  if (isNaN(t.getTime())) return NaN;
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - SHANGHAI_OFFSET_MS;
}

/**
 * 该行是否属于「提醒系统上线之前」的历史欠账
 * @param {string} followDate 跟进日期
 * @param {number} goLiveAt 上线时间戳（state.meta.goLiveAt），0/null 表示不启用该闸
 * @returns {boolean} true = 上线前，跳过 ①②③
 */
export function beforeGoLive(followDate, goLiveAt) {
  if (!goLiveAt || !isFinite(goLiveAt)) return false;
  const day = shanghaiDayStart(goLiveAt);
  const base = shanghaiMidnight(followDate);
  if (!isFinite(day) || !isFinite(base)) return false;
  return base < day;
}

/**
 * 是否处于可发送时段：工作日（周一~周五按 config 配置）且 09:00 ≤ 小时 < 18:00，且非节假日。
 * @param {number} now 时间戳
 * @param {{workdays:number[],windowStartHour:number,windowEndHour:number,holidays:string[]}} schedule
 * @returns {boolean}
 */
export function inSendWindow(now, schedule) {
  const cfg = schedule || {};
  const offset = new Date(now + SHANGHAI_OFFSET_MS);       // 上海本地时间的 UTC 视图
  const day = offset.getUTCDay();                          // 0=周日 … 6=周六
  const hour = offset.getUTCHours();
  const ymd = offset.toISOString().slice(0, 10);

  const workdays = Array.isArray(cfg.workdays) && cfg.workdays.length ? cfg.workdays : [1, 2, 3, 4, 5];
  const holidays = Array.isArray(cfg.holidays) ? cfg.holidays : [];
  if (holidays.indexOf(ymd) >= 0) return false;            // 法定节假日扩展位（config.schedule.holidays）
  if (workdays.indexOf(day) < 0) return false;
  const start = typeof cfg.windowStartHour === 'number' ? cfg.windowStartHour : 9;
  const end = typeof cfg.windowEndHour === 'number' ? cfg.windowEndHour : 18;
  return hour >= start && hour < end;
}

/** 下一个工作日 09:00（上海）的 UTC 时间戳，用于 pending 补发提示 */
export function nextWorkdayStart(now, schedule) {
  const cfg = schedule || {};
  const workdays = Array.isArray(cfg.workdays) && cfg.workdays.length ? cfg.workdays : [1, 2, 3, 4, 5];
  const start = typeof cfg.windowStartHour === 'number' ? cfg.windowStartHour : 9;
  const holidays = Array.isArray(cfg.holidays) ? cfg.holidays : [];
  let t = new Date(now + SHANGHAI_OFFSET_MS);
  for (let i = 0; i < 14; i++) {
    const day = t.getUTCDay();
    const ymd = t.toISOString().slice(0, 10);
    const isWork = workdays.indexOf(day) >= 0 && holidays.indexOf(ymd) < 0;
    const hour = t.getUTCHours();
    // 同一天但还没到 09:00 → 就是今天 09:00；否则顺延到后续工作日
    if (isWork && (i > 0 || hour < start)) {
      return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), start) - SHANGHAI_OFFSET_MS;
    }
    t = new Date(t.getTime() + 24 * 60 * 60 * 1000);
    t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  }
  return now + 24 * 60 * 60 * 1000;
}

// ---- 收件人映射 ----
// 内置账号表：必须与 edgeone/functions/api/_auth.js 的 DEFAULT_USERS 保持一致
// （/api/users 拉取成功时以线上为准，失败才回落到本表）
export const BUILTIN_USERS = [
  { name: '于翠',     email: 'yucui@chromai.com',         role: 'admin',  region: null },
  { name: '汪琼',     email: 'wangqiong@chromai.com',     role: 'admin',  region: null },
  { name: '张欣',     email: 'zhangxin@chromai.com',      role: 'admin',  region: null },
  { name: '汤显义',   email: 'tangxianyi@chromai.com',    role: 'region', region: '汤显义' },
  { name: '管能',     email: 'guanneng@chromai.com',      role: 'region', region: '管能' },
  { name: '穆忠仁',   email: 'muzhongren@chromai.com',    role: 'region', region: '穆忠仁' },
  { name: '王远帅',   email: 'wangyuanshuai@chromai.com', role: 'sales',  region: '汤显义' },
  { name: '高丹枫',   email: 'gaodanfeng@chromai.com',    role: 'sales',  region: '汤显义' },
  { name: '黄江锐',   email: 'huangjiangrui@chromai.com', role: 'sales',  region: '汤显义' },
  { name: '王泽',     email: 'wangze@chromai.com',        role: 'sales',  region: '汤显义' },
  { name: '胡雨来',   email: 'huyulai@chromai.com',       role: 'sales',  region: '汤显义' },
  { name: '高雷',     email: 'gaolei@chromai.com',        role: 'sales',  region: '汤显义' },
  { name: '刘力瑞',   email: 'liulirui@chromai.com',      role: 'sales',  region: '管能' },
  { name: '刘健凯',   email: 'liujiankai@chromai.com',    role: 'region', region: '刘健凯' },
  { name: '张塞云',   email: 'zhangsaiyun@chromai.com',   role: 'sales',  region: null },
  { name: '房戈',     email: 'fangge@chromai.com',        role: 'sales',  region: null }
];

/**
 * 大区总：sales 用其 region 字段（该字段存的就是大区总姓名）；
 * region 角色本人视为自己的大区总；region 为空（IVD 张塞云/房戈）→ 无大区总。
 * @param {object} user 用户记录 {name, role, region}
 * @returns {string|null} 大区总姓名
 */
export function headOf(user) {
  if (!user) return null;
  if (user.role === 'region') return user.name;
  return user.region || null;
}

/**
 * 构建 name → user 索引
 * @param {object[]} users
 * @returns {Map<string, object>}
 */
export function buildUserIndex(users) {
  const map = new Map();
  (users || []).forEach(function(u) {
    if (u && u.name) map.set(String(u.name).trim(), u);
  });
  return map;
}

/**
 * 解析收件人：负责人邮箱 + 第③封的大区总抄送
 * @param {string} ownerName 负责人姓名
 * @param {Map<string,object>} userIndex
 * @param {number} stage 1/2/3
 * @returns {{to:string,cc:string[],owner:string|null,head:string|null,noHead:boolean,reason:string}}
 */
export function resolveRecipients(ownerName, userIndex, stage) {
  const name = String(ownerName || '').trim();
  const out = { to: '', cc: [], owner: null, head: null, noHead: false, reason: '' };
  if (!name) { out.reason = '负责人为空'; return out; }
  const owner = userIndex.get(name);
  if (!owner || !owner.email) { out.reason = '负责人未匹配到邮箱: ' + name; return out; }
  out.owner = owner;
  out.to = owner.email;
  if (stage === 3) {
    const headName = headOf(owner);
    if (!headName) {
      out.noHead = true;
      out.reason = '无大区总，第③封不抄送';
    } else {
      const head = userIndex.get(headName);
      if (head && head.email && head.email !== owner.email) {
        out.head = head;
        out.cc = [head.email];
      } else if (head && head.email && head.email === owner.email) {
        out.head = head;                                   // 大区总本人即负责人，不重复抄送
      } else {
        out.noHead = true;
        out.reason = '大区总未匹配到邮箱: ' + headName;
      }
    }
  }
  return out;
}

/** 三档主题 */
export function buildSubject(stage, customerName) {
  const c = String(customerName || '').trim() || '（未关联客户）';
  if (stage === 1) return '【新线索待跟进】' + c;
  if (stage === 2) return '【跟进提醒】' + c + ' 已 48 小时未跟进';
  if (stage === 3) return '【超时升级】' + c + ' 已 72 小时未跟进';
  return '【跟进提醒】' + c;
}

/**
 * 纯文本正文
 * @param {object} ctx {stage, fupId, leadId, owner, followDate, overdueHours, customer, contact, phone,
 *                      model, budget, window, firstFeedback, nextPlan, publicUrl}
 * @returns {string}
 */
export function buildText(ctx) {
  const c = ctx || {};
  const lines = [];
  const tag = c.stage === 1 ? '新线索待跟进' : (c.stage === 2 ? '48 小时未跟进' : '72 小时未跟进（已升级抄送大区总）');
  lines.push('科诺美线索跟进提醒：' + tag);
  lines.push('');
  lines.push('负责人：' + (c.owner || '—'));
  lines.push('跟进编号：' + (c.fupId || '—'));
  lines.push('线索编号：' + (c.leadId || '—'));
  lines.push('跟进日期：' + (c.followDate || '—') + (c.stage === 1 ? '' : '（已超时 ' + (c.overdueHours || 0) + ' 小时）'));
  lines.push('');
  lines.push('客户名称：' + (c.customer || '—'));
  lines.push('联系人：' + (c.contact || '—'));
  lines.push('联系电话：' + (c.phone || '—'));
  lines.push('');
  lines.push('产品型号意向：' + (c.model || '—'));
  lines.push('预算范围(万元)：' + (c.budget || '—'));
  lines.push('采购时间窗：' + (c.window || '—'));
  lines.push('首次反馈：' + (c.firstFeedback || '—'));
  lines.push('下一步计划：' + (c.nextPlan || '—'));
  lines.push('');
  lines.push('直达链接：' + (c.publicUrl || 'https://leads.chromai.com/'));
  lines.push('');
  lines.push('（本邮件由线索跟进管理系统自动发送，请登录系统填写「跟进记录」以停止提醒）');
  return lines.join('\r\n');
}

/** 简单 HTML 正文（与纯文本同字段） */
export function buildHtml(ctx) {
  const c = ctx || {};
  const esc = function(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  const row = function(k, v) {
    return '<tr><td style="padding:4px 10px;color:#64748b;font-size:12px;white-space:nowrap">' + esc(k)
      + '</td><td style="padding:4px 10px;color:#0f172a;font-size:13px">' + esc(v || '—') + '</td></tr>';
  };
  const title = c.stage === 1 ? '新线索待跟进' : (c.stage === 2 ? '已 48 小时未跟进' : '已 72 小时未跟进（已升级抄送大区总）');
  return '<div style="font-family:-apple-system,Segoe UI,Microsoft YaHei,sans-serif;max-width:640px">'
    + '<h3 style="margin:0 0 12px;font-size:15px;color:#0f172a">科诺美线索跟进提醒：' + esc(title) + '</h3>'
    + '<table style="border-collapse:collapse">' 
    + row('负责人', c.owner) + row('跟进编号', c.fupId) + row('线索编号', c.leadId)
    + row('跟进日期', (c.followDate || '—') + (c.stage === 1 ? '' : '（已超时 ' + (c.overdueHours || 0) + ' 小时）'))
    + row('客户名称', c.customer) + row('联系人', c.contact) + row('联系电话', c.phone)
    + row('产品型号意向', c.model) + row('预算范围(万元)', c.budget) + row('采购时间窗', c.window)
    + row('首次反馈', c.firstFeedback) + row('下一步计划', c.nextPlan)
    + '</table>'
    + '<p style="margin:14px 0 4px"><a href="' + esc(c.publicUrl || 'https://leads.chromai.com/') + '">打开线索跟进系统</a></p>'
    + '<p style="margin:0;color:#94a3b8;font-size:11px">本邮件由线索跟进管理系统自动发送，请登录系统填写「跟进记录」以停止提醒。</p>'
    + '</div>';
}

/**
 * 核心判定：扫描跟进记录行，产出「应发」清单（不负责是否已发过，由 index.mjs 结合 state 去重）
 * @param {object} args
 * @param {string[]} args.headers 跟进表头
 * @param {Array[]} args.rows 跟进数据行
 * @param {object} args.state 运行时状态（{records:{...}}）
 * @param {number} args.now 当前时间戳
 * @param {object} args.thresholds {stage2Hours, stage3Hours}
 * @param {boolean} args.baseline 是否走首次基线（基线模式不产生任何通知）
 * @param {number} [args.goLiveAt] 上线时间戳；跟进日期早于上线日的行整体跳过（历史欠账不补发）
 * @returns {{newIds:string[], dues:Array<object>, doneIds:string[], beforeGoLive:string[],
 *            suppress:Array<{fupId:string,stage:number,reason:string}>, skipped:Array<object>}}
 */
export function evaluate(args) {
  const headers = args.headers || [];
  const rows = args.rows || [];
  const state = args.state || { records: {} };
  const now = args.now;
  const th = args.thresholds || { stage2Hours: 48, stage3Hours: 72 };

  const C_ID = colIndex(headers, '跟进编号');
  const C_LD = colIndex(headers, '线索编号');
  const C_DT = colIndex(headers, '跟进日期');
  const C_RC = colIndexAny(headers, ['跟进记录', '跟进内容09.14']);
  const C_OW = colIndex(headers, '负责人');

  const out = { newIds: [], dues: [], doneIds: [], beforeGoLive: [], suppress: [], skipped: [] };
  if (C_ID < 0) {
    out.skipped.push({ reason: '表头缺少「跟进编号」列，无法判定' });
    return out;
  }
  const goLiveAt = (typeof args.goLiveAt === 'number' && isFinite(args.goLiveAt)) ? args.goLiveAt : 0;

  rows.forEach(function(row, idx) {
    if (!Array.isArray(row)) return;
    const fupId = String(row[C_ID] || '').trim();
    if (!fupId) { out.skipped.push({ row: idx, reason: '跟进编号为空' }); return; }

    const count = C_RC >= 0 ? parseFollowupCount(row[C_RC]) : 0;
    const owner = C_OW >= 0 ? String(row[C_OW] || '').trim() : '';
    const followDate = C_DT >= 0 ? String(row[C_DT] || '').trim() : '';
    const leadId = C_LD >= 0 ? String(row[C_LD] || '').trim() : '';

    // 已有跟进记录 → 不再触发任何档位
    if (count > 0) { out.doneIds.push(fupId); return; }

    // 第二道闸：上线日之前的存量欠账不补发（只提醒上线之后新发生的事件）
    if (beforeGoLive(followDate, goLiveAt)) { out.beforeGoLive.push(fupId); return; }

    // 基线模式：只落库，不产生任何通知
    if (args.baseline) return;

    const rec = state.records && state.records[fupId];
    const isNew = !rec;

    if (isNew) out.newIds.push(fupId);

    const over2 = isOverdue(followDate, th.stage2Hours, now);
    const over3 = isOverdue(followDate, th.stage3Hours, now);

    // ① 新增
    if (isNew) {
      out.dues.push({ fupId: fupId, stage: 1, row: idx, owner: owner, followDate: followDate, leadId: leadId, overdueHours: 0 });
    }

    // 新首次出现且已超时 → 只发①，②③ 标记 suppressed（多为补录的历史数据，一次发 3 封属于轰炸）
    if (isNew && (over2 || over3)) {
      if (over2) out.suppress.push({ fupId: fupId, stage: 2, reason: '新增记录且已超时，本次只发①' });
      if (over3) out.suppress.push({ fupId: fupId, stage: 3, reason: '新增记录且已超时，本次只发①' });
      return;
    }

    // ② 48h / ③ 72h —— 只要到期即产出（是否真发由 index.mjs 结合 state 去重）
    if (over2) {
      out.dues.push({
        fupId: fupId, stage: 2, row: idx, owner: owner, followDate: followDate, leadId: leadId,
        overdueHours: overdueHours(followDate, now)
      });
    }
    if (over3) {
      out.dues.push({
        fupId: fupId, stage: 3, row: idx, owner: owner, followDate: followDate, leadId: leadId,
        overdueHours: overdueHours(followDate, now)
      });
    }
  });

  return out;
}

/**
 * 历史欠账汇总（--summary）：按大区总聚合「超 48 小时未跟进」的存量记录
 * 只统计、不逐条提醒；无大区总（IVD 张塞云/房戈）与查不到归属的一并归入 admin 兜底信。
 * @param {object} args {headers, rows, now, thresholds, userIndex, leadMap, adminEmail, publicUrl}
 * @returns {Array<object>} 每封汇总信 {key, headName, to, subject, text, html, count, byOwner}
 */
export function buildSummary(args) {
  const headers = args.headers || [];
  const rows = args.rows || [];
  const now = args.now;
  const th = args.thresholds || { stage2Hours: 48, stage3Hours: 72 };
  const userIndex = args.userIndex || new Map();
  const leadMap = args.leadMap || new Map();
  const adminEmail = args.adminEmail || '';
  const publicUrl = args.publicUrl || 'https://leads.chromai.com/';

  const C_ID = colIndex(headers, '跟进编号');
  const C_LD = colIndex(headers, '线索编号');
  const C_DT = colIndex(headers, '跟进日期');
  const C_RC = colIndexAny(headers, ['跟进记录', '跟进内容09.14']);
  const C_OW = colIndex(headers, '负责人');
  if (C_ID < 0) return [];

  // key → {headName, email, items[]}
  const buckets = new Map();
  const bucketOf = function(headName, email) {
    const key = headName || '__admin__';
    if (!buckets.has(key)) {
      buckets.set(key, { key: key, headName: headName || '', email: email || adminEmail, items: [] });
    }
    return buckets.get(key);
  };

  rows.forEach(function(row) {
    if (!Array.isArray(row)) return;
    const count = C_RC >= 0 ? parseFollowupCount(row[C_RC]) : 0;
    if (count > 0) return;                                    // 已跟进，不算欠账
    const followDate = C_DT >= 0 ? String(row[C_DT] || '').trim() : '';
    if (!isOverdue(followDate, th.stage2Hours, now)) return;  // 只看超 48h 的
    const ownerName = C_OW >= 0 ? String(row[C_OW] || '').trim() : '';
    const owner = ownerName ? userIndex.get(ownerName) : null;
    const headName = headOf(owner) || '';
    const headEmail = (headName && userIndex.get(headName) && userIndex.get(headName).email) || '';
    const leadId = C_LD >= 0 ? String(row[C_LD] || '').trim() : '';
    const lead = leadMap.get(leadId) || { customer: '', contact: '', phone: '' };
    bucketOf(headName, headEmail).items.push({
      owner: ownerName || '（无负责人）',
      fupId: String(row[C_ID] || '').trim(),
      leadId: leadId,
      customer: lead.customer || '（未关联客户）',
      followDate: followDate || '—',
      overdueHours: overdueHours(followDate, now)
    });
  });

  const esc = function(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  const out = [];
  buckets.forEach(function(b) {
    if (!b.items.length) return;
    if (!b.email) return;                                     // 无收件人则跳过（记日志在调用方）
    // 按超时时长倒序；同组内按负责人、再按超时倒序
    const byOwnerMap = new Map();
    b.items.sort(function(x, y) { return y.overdueHours - x.overdueHours; });
    b.items.forEach(function(it) {
      if (!byOwnerMap.has(it.owner)) byOwnerMap.set(it.owner, []);
      byOwnerMap.get(it.owner).push(it);
    });
    const byOwner = [];
    byOwnerMap.forEach(function(list, owner) { byOwner.push({ owner: owner, items: list }); });

    const who = b.headName ? (b.headName + ' 大区') : 'IVD / 未归属大区';
    const subject = '【历史欠账汇总】' + who + '有 ' + b.items.length + ' 条超 48 小时未跟进';

    const lines = [];
    lines.push('科诺美线索跟进 —— 历史欠账汇总（' + who + '）');
    lines.push('共 ' + b.items.length + ' 条：未填写「跟进记录」且跟进日期已超过 48 小时。');
    lines.push('统计时间：' + new Date(now).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
    lines.push('');
    byOwner.forEach(function(g) {
      lines.push('■ ' + g.owner + '（' + g.items.length + ' 条）');
      g.items.forEach(function(it, i) {
        lines.push('   ' + (i + 1) + '. ' + it.fupId + ' | ' + it.customer
          + ' | 跟进日期 ' + it.followDate + ' | 超时 ' + it.overdueHours + ' 小时 | ' + it.leadId);
      });
      lines.push('');
    });
    lines.push('直达链接：' + publicUrl);
    lines.push('');
    lines.push('说明：本汇总为提醒系统上线前的存量欠账清点，不做逐条提醒；请安排销售补齐「跟进记录」。');

    let html = '<div style="font-family:-apple-system,Segoe UI,Microsoft YaHei,sans-serif;max-width:760px">'
      + '<h3 style="margin:0 0 10px;font-size:15px">' + esc(subject) + '</h3>'
      + '<p style="margin:0 0 12px;color:#475569;font-size:12px">统计时间：'
      + esc(new Date(now).toISOString().slice(0, 16).replace('T', ' ')) + ' UTC</p>';
    byOwner.forEach(function(g) {
      html += '<p style="margin:12px 0 4px;font-size:13px;font-weight:700">' + esc(g.owner)
        + '（' + g.items.length + ' 条）</p><table style="border-collapse:collapse;font-size:12px">'
        + '<tr style="color:#64748b"><td style="padding:3px 10px">跟进编号</td><td style="padding:3px 10px">客户名称</td>'
        + '<td style="padding:3px 10px">跟进日期</td><td style="padding:3px 10px">超时</td><td style="padding:3px 10px">线索编号</td></tr>';
      g.items.forEach(function(it) {
        html += '<tr><td style="padding:3px 10px">' + esc(it.fupId) + '</td><td style="padding:3px 10px">'
          + esc(it.customer) + '</td><td style="padding:3px 10px">' + esc(it.followDate)
          + '</td><td style="padding:3px 10px">' + it.overdueHours + ' 小时</td><td style="padding:3px 10px">'
          + esc(it.leadId) + '</td></tr>';
      });
      html += '</table>';
    });
    html += '<p style="margin:14px 0 4px"><a href="' + esc(publicUrl) + '">打开线索跟进系统</a></p>'
      + '<p style="margin:0;color:#94a3b8;font-size:11px">本汇总为提醒系统上线前的存量欠账清点，不做逐条提醒。</p></div>';

    out.push({
      key: b.key, headName: b.headName, to: b.email, subject: subject,
      text: lines.join('\r\n'), html: html, count: b.items.length, byOwner: byOwner
    });
  });

  // 大区信在前，admin 兜底信在后
  out.sort(function(a, b) {
    if (a.key === '__admin__') return 1;
    if (b.key === '__admin__') return -1;
    return b.count - a.count;
  });
  return out;
}

/**
 * 过滤掉 state 里已发过（或已排队）的档位
 * @param {Array} dues evaluate() 产出的档位数组
 * @param {object} state
 * @returns {Array} 仍需处理的档位
 */
export function filterSent(dues, state) {
  const recs = (state && state.records) || {};
  return (dues || []).filter(function(d) {
    const rec = recs[d.fupId];
    if (!rec || !rec.stages) return true;
    const s = rec.stages[String(d.stage)];
    return !(s && (s.status === 'sent' || s.status === 'pending' || s.status === 'suppressed'));
  });
}
