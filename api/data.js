// Vercel Serverless: /api/export + /api/import
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
    return res.status(200).json({
      leads: loadData('leads'),
      followups: loadData('followups'),
      flowchart: loadData('flowchart'),
      mql: loadData('mql'),
      exportedAt: new Date().toISOString()
    });
  }
  if (req.method === 'POST') {
    const data = req.body;
    let count = 0;
    if (data.leads) { saveData('leads', data.leads); count++; }
    if (data.followups) { saveData('followups', data.followups); count++; }
    if (data.flowchart) { saveData('flowchart', data.flowchart); count++; }
    if (data.mql) { saveData('mql', data.mql); count++; }
    return res.status(200).json({ success: true, message: '已导入 ' + count + ' 个数据集' });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
