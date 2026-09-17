// 科诺美线索系统 API - flowchart（流程图数据，Blob 存储）
import { getStore } from "@edgeone/pages-blob";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

async function updateMeta(store) {
  try {
    const meta = await store.get('meta', { type: 'json', consistency: 'strong' }) || {};
    meta.lastModified = Date.now();
    await store.set('meta', JSON.stringify(meta));
  } catch(e) { /* meta 更新失败不影响主流程 */ }
}

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const store = getStore('chromai-leads');

  if (request.method === 'GET') {
    try {
      const data = await store.get('flowchart', { type: 'json', consistency: 'strong' });
      if (data) {
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
        });
      }
      return new Response(JSON.stringify({ data: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
      });
    } catch (e) {
      return new Response(JSON.stringify({ data: null, error: e.message }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
      });
    }
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      await store.set('flowchart', JSON.stringify(body));
      await updateMeta(store);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });
}
