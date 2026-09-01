// 科诺美线索系统 API - status（状态检查 + 版本检测，轻量级）
import { getStore } from "@edgeone/pages-blob";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const result = {
    status: 'running',
    platform: 'edgeone',
    storage: 'blob',
    timestamp: new Date().toISOString()
  };
  try {
    const store = getStore('chromai-leads');
    // 读取 meta 获取版本信息（轻量级，不读全部数据）
    const meta = await store.get('meta', { type: 'json', consistency: 'strong' });
    if (meta) {
      result.lastModified = meta.lastModified || 0;
      result.leadsCount = meta.leadsCount || 0;
      result.fupsCount = meta.fupsCount || 0;
      result.blobReady = true;
    } else {
      // meta 不存在，回退到直接读 leads
      const leads = await store.get('leads', { type: 'json', consistency: 'strong' });
      result.blobReady = true;
      result.leadsCount = leads && leads.data ? leads.data.length : 0;
      result.lastModified = 0;
    }
  } catch (e) {
    result.blobReady = false;
    result.error = e.message;
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });
}
