// Vercel Serverless: /api/followups
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');

function loadData(name) {
  const fp = path.join(DATA_DIR, name + '.json');
  if (fs.existsSync(fp)) {
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch(e) {}
  }
  return null;
}
function saveData(name, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(data, null, 2));
}

export default function handler(req, res) {
  if (req.method === 'GET') {
    const data = loadData('followups');
    return res.status(200).json(data || { data: [], headers: [] });
  }
  if (req.method === 'POST') {
    saveData('followups', req.body);
    return res.status(200).json({ success: true, message: 'followups 已保存', timestamp: new Date().toISOString() });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
