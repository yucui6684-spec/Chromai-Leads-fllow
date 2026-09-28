// 科诺美线索系统 - 共享审计日志模块
// 存储：Blob key logs/YYYY-MM-DD（UTC+8 日界），value 为 JSON 数组。
// 追加 = 读当日数组 + push + 写回；查询 = 按日期范围逐日拼 key 直接 get（不依赖 list 能力）。
// 保留策略：惰性清理 12 个月前分片（每天首次写入触发一次 list+delete，list 受限时静默跳过）。

const SHARD_PREFIX = 'logs/';
const RETENTION_DAYS = 366;
const MAX_QUERY_DAYS = 31;

// UTC+8 当日分片 key
export function shardKey(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return SHARD_PREFIX + y + '-' + m + '-' + dd;
}

function dayStr(ts) {
  return shardKey(ts).slice(SHARD_PREFIX.length);
}

// 批量追加（同一分片只读写一次，避免批量编辑时写放大）
export async function appendLogs(store, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  try {
    const byDay = new Map();
    entries.forEach(entry => {
      const e = Object.assign({
        ts: Date.now(), email: '', name: '', role: '', event: '',
        objectType: 'session', objectId: '', diff: [], detail: '',
        result: 'success', ip: ''
      }, entry || {});
      const key = shardKey(e.ts);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    });
    for (const pair of byDay) {
      const key = pair[0], list = pair[1];
      const arr = (await store.get(key, { type: 'json' })) || [];
      list.forEach(e => arr.push(e));
      await store.set(key, JSON.stringify(arr));
    }
    await purgeOldShards(store);
  } catch (err) { /* 日志失败不影响主流程 */ }
}

export async function appendLog(store, entry) {
  return appendLogs(store, [entry]);
}

// 惰性清理：每自然日（UTC+8）首次写入触发一次
let _purgedDay = '';
export async function purgeOldShards(store) {
  const today = dayStr(Date.now());
  if (_purgedDay === today) return;
  _purgedDay = today;
  try {
    if (typeof store.list !== 'function') return;
    const cutoff = shardKey(Date.now() - RETENTION_DAYS * 86400000);
    const res = await store.list({ prefix: SHARD_PREFIX });
    const rawKeys = (res && (res.keys || res.blobs)) || [];
    const keys = rawKeys.map(k => (typeof k === 'string' ? k : (k.key || k.name || ''))).filter(Boolean);
    for (const k of keys) {
      if (k < cutoff) { try { await store.delete(k); } catch (e) {} }
    }
  } catch (e) { /* Blob list 能力受限时跳过清理，不影响主流程 */ }
}

// 管理员查询：from/to（YYYY-MM-DD，UTC+8 日界）、email、event、page、pageSize
// 日期范围最多 31 天，超出截断并返回 truncated 标记
export async function queryLogs(store, filter) {
  const f = filter || {};
  const validDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const from = validDay(f.from) ? f.from : dayStr(Date.now() - 6 * 86400000);
  const to = validDay(f.to) ? f.to : dayStr(Date.now());

  const days = [];
  let cur = new Date(from + 'T00:00:00Z').getTime();
  const end = new Date(to + 'T00:00:00Z').getTime();
  let truncated = false;
  while (cur <= end) {
    if (days.length >= MAX_QUERY_DAYS) { truncated = true; break; }
    days.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86400000;
  }

  const shards = await Promise.all(
    days.map(d => store.get(SHARD_PREFIX + d, { type: 'json' }).catch(() => null))
  );
  let items = [];
  shards.forEach(arr => { if (Array.isArray(arr)) items = items.concat(arr); });
  if (f.email) items = items.filter(e => (e.email || '').indexOf(f.email) >= 0);
  if (f.event) items = items.filter(e => e.event === f.event);
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0)); // 按 ts 倒序

  const total = items.length;
  const pageSize = Math.min(Math.max(parseInt(f.pageSize, 10) || 50, 1), 200);
  const page = Math.max(parseInt(f.page, 10) || 1, 1);
  const start = (page - 1) * pageSize;
  return { total: total, page: page, pageSize: pageSize, truncated: truncated,
           items: items.slice(start, start + pageSize) };
}
