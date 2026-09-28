// 科诺美线索系统 - 服务端数据快照备份模块（2026-09-23 事故整改）
//
// 背景：2026-09-23 一次异常自动同步把线上数据整体覆盖（leads 2290→1955），
// 而 Blob 存储无版本/回滚能力，事后只能靠本地快照取证抢救。本模块在每次写入前
// 自动保留旧版本，使线上具备「至少可回滚到上一版本 / 当日初始状态」的能力。
//
// 存储布局（Blob namespace: chromai-leads）：
//   backup/leads/prev          上一版本（单槽，每次写入前覆盖 → 最近一次写前的完整状态）
//   backup/leads/YYYY-MM-DD    当日首次写入前的快照（UTC+8 日界，保留当日初始状态）
//   backup/followups/...       同上
//
// 原则：备份失败绝不阻断主写入流程（所有异常静默吞掉），且不改变任何鉴权/合并语义。

const PREFIX = 'backup/';
const RETENTION_DAYS = 14;
const TYPES = ['leads', 'followups'];

// UTC+8 当日字符串
function dayStr(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' + String(d.getUTCDate()).padStart(2, '0');
}

export function backupKey(type, day) {
  return PREFIX + type + '/' + (day || dayStr(Date.now()));
}

// 写入前快照：必须在 store.set(主数据) 之前调用，oldPayload 为即将被覆盖的旧全量
export async function snapshotBeforeWrite(store, type, oldPayload, user) {
  try {
    if (!oldPayload || !Array.isArray(oldPayload.data) || oldPayload.data.length === 0) return false;
    const payload = JSON.stringify({
      ts: Date.now(),
      by: (user && user.email) || '',
      name: (user && user.name) || '',
      count: oldPayload.data.length,
      headers: oldPayload.headers || [],
      data: oldPayload.data
    });
    // 1) 上一版本（单槽覆盖）
    await store.set(PREFIX + type + '/prev', payload);
    // 2) 当日快照（仅当日首次写入）
    const dayKey = backupKey(type);
    const exist = await store.get(dayKey).catch(() => null);
    if (!exist) await store.set(dayKey, payload);
    return true;
  } catch (e) {
    // 备份失败不影响主流程
    return false;
  }
}

// 惰性清理过期日快照：每个自然日（UTC+8）首次触发一次
let _purgedDay = '';
export async function purgeOldBackups(store) {
  const today = dayStr(Date.now());
  if (_purgedDay === today) return;
  _purgedDay = today;
  try {
    if (typeof store.list !== 'function') return;
    const cutoffDay = dayStr(Date.now() - RETENTION_DAYS * 86400000);
    for (const t of TYPES) {
      const res = await store.list({ prefix: PREFIX + t + '/' });
      const rawKeys = (res && (res.keys || res.blobs)) || [];
      const keys = rawKeys.map(k => (typeof k === 'string' ? k : (k.key || k.name || ''))).filter(Boolean);
      for (const k of keys) {
        const day = k.slice((PREFIX + t + '/').length);
        // prev 单槽不过期；仅清理 YYYY-MM-DD 且早于保留窗口的日快照
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        if (day < cutoffDay) { try { await store.delete(k); } catch (e) {} }
      }
    }
  } catch (e) { /* Blob list 能力受限时跳过清理 */ }
}

// 列出可用备份（供运维/后续管理端使用）
export async function listBackups(store, type) {
  const out = [];
  const seen = new Set();
  const push = (key, v) => {
    if (!v || !Array.isArray(v.data)) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      key: key,
      slot: key.slice((PREFIX + type + '/').length),
      ts: v.ts || 0,
      count: v.count || v.data.length,
      by: v.by || ''
    });
  };

  try {
    if (typeof store.list === 'function') {
      const res = await store.list({ prefix: PREFIX + type + '/' });
      const rawKeys = (res && (res.keys || res.blobs)) || [];
      const keys = rawKeys.map(k => (typeof k === 'string' ? k : (k.key || k.name || ''))).filter(Boolean);
      if (keys.length) {
        for (const k of keys) {
          const v = await store.get(k, { type: 'json' }).catch(() => null);
          push(k, v);
        }
        out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        return out;
      }
    }
  } catch (e) { /* 落到探测模式 */ }

  // 探测模式（Blob 未开放 list 能力时）：prev 单槽 + 最近 RETENTION_DAYS 天的日快照
  const probe = [PREFIX + type + '/prev'];
  for (let i = 0; i < RETENTION_DAYS; i++) {
    probe.push(PREFIX + type + '/' + dayStr(Date.now() - i * 86400000));
  }
  for (const k of probe) {
    const v = await store.get(k, { type: 'json' }).catch(() => null);
    push(k, v);
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}
