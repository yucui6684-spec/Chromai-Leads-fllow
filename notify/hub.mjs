/**
 * hub.mjs —— 推送提醒事件到 hub（Supabase PostgREST）
 *
 * ⚠️ 字段待 Alex Zhang 提供真实 schema 后校准：
 *    下方 hub_messages 的表名与字段名均为占位（按常见审计表结构拟定），
 *    拿到真实 schema 后只需改 buildPayload() 一处 + TABLE 常量。
 *
 * 开关：config.hub.enabled（默认 false，未开启时本模块所有调用直接 no-op）
 */

const TABLE = '/rest/v1/hub_messages';

/**
 * 构造待推送的一条记录
 * ⚠️ 字段名为占位：id / created_at / source / event_type / stage / followup_id /
 *    lead_id / owner / region_head / recipients / subject / body / meta
 *    真实 schema 提供后在此校准。
 * @param {object} n 通知对象（index.mjs 内部流转结构）
 * @returns {object}
 */
export function buildPayload(n) {
  return {
    source: 'chromai-leads-notify',
    event_type: 'followup_reminder',
    stage: n.stage,
    followup_id: n.fupId || null,
    lead_id: n.leadId || null,
    owner: n.owner || null,
    region_head: n.head || null,
    recipients: [].concat(n.to ? [n.to] : []).concat(n.cc || []),
    subject: n.subject || '',
    body: n.text || '',
    sent_at: n.sentAt || new Date().toISOString(),
    meta: {
      customer: n.customer || null,
      follow_date: n.followDate || null,
      overdue_hours: n.overdueHours || 0,
      dry_run: !!n.dryRun
    }
  };
}

/**
 * 是否启用
 * @param {object} hubCfg
 * @returns {boolean}
 */
export function isEnabled(hubCfg) {
  const c = hubCfg || {};
  return !!(c.enabled && c.url && c.serviceKey);
}

/**
 * 推送单条（未启用时返回 {ok:true, skipped:true}）
 * @param {object} hubCfg {enabled, url, serviceKey}
 * @param {object} n 通知对象
 * @returns {Promise<{ok:boolean, skipped?:boolean, status?:number, error?:string}>}
 */
export async function push(hubCfg, n) {
  if (!isEnabled(hubCfg)) return { ok: true, skipped: true };
  const url = String(hubCfg.url).replace(/\/+$/, '') + TABLE;
  const body = JSON.stringify(buildPayload(n));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': hubCfg.serviceKey,
        'Authorization': 'Bearer ' + hubCfg.serviceKey,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: body
    });
    if (!res.ok) {
      const txt = await res.text().catch(function() { return ''; });
      return { ok: false, status: res.status, error: txt.slice(0, 300) };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 批量推送（串行，失败不影响后续）
 * @param {object} hubCfg
 * @param {object[]} list
 * @returns {Promise<{sent:number, failed:number, skipped:boolean}>}
 */
export async function pushAll(hubCfg, list) {
  const out = { sent: 0, failed: 0, skipped: !isEnabled(hubCfg) };
  for (const n of list || []) {
    const r = await push(hubCfg, n);
    if (r.skipped) break;
    if (r.ok) out.sent++; else out.failed++;
  }
  return out;
}
