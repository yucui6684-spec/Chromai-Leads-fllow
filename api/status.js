// Vercel Serverless: /api/status
const fs = require('fs');
const path = require('path');

export default function handler(req, res) {
  const DATA_DIR = path.join(process.cwd(), 'data');
  function loadData(name) {
    const fp = path.join(DATA_DIR, name + '.json');
    if (fs.existsSync(fp)) {
      try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch(e) {}
    }
    return null;
  }
  const leads = loadData('leads');
  const followups = loadData('followups');
  res.status(200).json({
    status: 'running',
    version: '1.0.0',
    leadsCount: leads ? (leads.data || []).length : 0,
    followupsCount: followups ? (followups.data || []).length : 0,
    timestamp: new Date().toISOString()
  });
}
