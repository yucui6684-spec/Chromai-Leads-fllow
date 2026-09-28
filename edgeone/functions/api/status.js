// 科诺美线索系统 API - status（状态检查 + 按角色的 lastModified 轮询 + 计数自愈）
// 无 token：仅返回 status/blobReady 健康信息（保持 200，不用 401）；
// 带有效 token：返回按角色分片的 lastModified ——
//   admin → max(lastModified, scopeModified.admin, cfg)（admin 键任何写都触达，即全局）
//   region → max(cfg, R:本人大区)
//   sales → max(cfg, S:本人)
// 计数自愈：leadsCount/fupsCount 一律以真实数据行数为准（读实际 blob 后回填），
//   meta 计数与实际不一致时自动修正 meta —— 杜绝 meta.fupsCount=245 vs 实际 184 的漂移。
import { getStore } from "@edgeone/pages-blob";
import { optionsResp, json, authHeaders, requireAuth } from './_auth.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return optionsResp();

  const result = {
    status: 'running',
    platform: 'edgeone',
    storage: 'blob',
    timestamp: new Date().toISOString()
  };
  let xh = {};
  try {
    const store = getStore('chromai-leads');
    const auth = await requireAuth(request, env); // 无/无效 token 时仅返回健康信息
    if (auth) xh = authHeaders(auth);

    // meta：lastModified / scopeModified 分片的唯一事实源
    const meta = await store.get('meta', { type: 'json', consistency: 'strong' });
    result.blobReady = true;

    // ---- 计数自愈：真实计数以数据行数为准，meta 不一致时回写修正 ----
    let leadsCount = 0, fupsCount = 0;
    try {
      const [leads, fups] = await Promise.all([
        store.get('leads', { type: 'json', consistency: 'strong' }),
        store.get('followups', { type: 'json', consistency: 'strong' })
      ]);
      leadsCount = (leads && Array.isArray(leads.data)) ? leads.data.length : 0;
      fupsCount = (fups && Array.isArray(fups.data)) ? fups.data.length : 0;
      if (meta && (meta.leadsCount !== leadsCount || meta.fupsCount !== fupsCount)) {
        const fixed = Object.assign({}, meta, { leadsCount: leadsCount, fupsCount: fupsCount });
        try { await store.set('meta', JSON.stringify(fixed)); } catch (e2) { /* 修正失败不影响返回真实计数 */ }
      }
    } catch (e) { /* 实际计数读取失败：回退 meta 计数，绝不因自愈失败而 5xx */
      leadsCount = (meta && typeof meta.leadsCount === 'number') ? meta.leadsCount : 0;
      fupsCount = (meta && typeof meta.fupsCount === 'number') ? meta.fupsCount : 0;
    }
    result.leadsCount = leadsCount;
    result.fupsCount = fupsCount;

    if (meta) {
      if (auth) {
        const sm = meta.scopeModified || null;
        const u = auth.user;
        if (!sm) {
          result.lastModified = meta.lastModified || 0;
        } else if (u.role === 'admin') {
          result.lastModified = Math.max(meta.lastModified || 0, sm.admin || 0, sm.cfg || 0);
        } else if (u.role === 'region') {
          result.lastModified = Math.max(sm.cfg || 0, sm['R:' + (u.region || u.name)] || 0);
        } else {
          result.lastModified = Math.max(sm.cfg || 0, sm['S:' + u.name] || 0);
        }
      }
    } else {
      if (auth) result.lastModified = 0;
    }
  } catch (e) {
    result.blobReady = false;
    result.error = e.message;
  }
  return json(result, 200, xh);
}
