/**
 * 科诺美(Chromai) 线索跟进管理系统 - CMS后台服务
 * Express + JSON文件存储
 * 启动: node server.js  端口: 3000
 */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- 数据存储工具 ----
function loadData(name) {
  const fp = path.join(DATA_DIR, name + '.json');
  if (fs.existsSync(fp)) {
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
    catch(e) { console.error('读取'+name+'失败:', e.message); }
  }
  return null;
}
function saveData(name, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(data, null, 2));
}

// ---- 通用 CRUD 工厂 ----
function createCrudRoutes(resourceName) {
  const base = '/api/' + resourceName;

  // 获取全部
  app.get(base, (req, res) => {
    const data = loadData(resourceName);
    res.json(data || { data: [], headers: [] });
  });

  // 保存全部（全量覆盖）
  app.post(base, (req, res) => {
    saveData(resourceName, req.body);
    res.json({ success: true, message: resourceName + ' 已保存', timestamp: new Date().toISOString() });
  });

  // 追加一条
  app.post(base + '/add', (req, res) => {
    const store = loadData(resourceName) || { data: [], headers: [] };
    store.data = store.data || [];
    store.data.push(req.body);
    saveData(resourceName, store);
    res.json({ success: true, message: '已追加', count: store.data.length });
  });

  // 删除指定索引
  app.delete(base + '/:index', (req, res) => {
    const store = loadData(resourceName) || { data: [], headers: [] };
    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < (store.data || []).length) {
      store.data.splice(idx, 1);
      saveData(resourceName, store);
      res.json({ success: true, message: '已删除', count: store.data.length });
    } else {
      res.status(404).json({ success: false, message: '索引不存在' });
    }
  });

  // 更新指定索引
  app.put(base + '/:index', (req, res) => {
    const store = loadData(resourceName) || { data: [], headers: [] };
    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < (store.data || []).length) {
      store.data[idx] = req.body;
      saveData(resourceName, store);
      res.json({ success: true, message: '已更新' });
    } else {
      res.status(404).json({ success: false, message: '索引不存在' });
    }
  });
}

// 注册各资源的CRUD路由
createCrudRoutes('leads');
createCrudRoutes('followups');
createCrudRoutes('flowchart');
createCrudRoutes('mql');

// ---- 数据导出 ----
app.get('/api/export/all', (req, res) => {
  const all = {
    leads: loadData('leads'),
    followups: loadData('followups'),
    flowchart: loadData('flowchart'),
    mql: loadData('mql'),
    exportedAt: new Date().toISOString()
  };
  res.setHeader('Content-Disposition', 'attachment; filename="chromai-leads-export.json"');
  res.json(all);
});

// ---- 数据导入 ----
app.post('/api/import/all', (req, res) => {
  const data = req.body;
  let count = 0;
  if (data.leads) { saveData('leads', data.leads); count++; }
  if (data.followups) { saveData('followups', data.followups); count++; }
  if (data.flowchart) { saveData('flowchart', data.flowchart); count++; }
  if (data.mql) { saveData('mql', data.mql); count++; }
  res.json({ success: true, message: '已导入 ' + count + ' 个数据集', timestamp: new Date().toISOString() });
});

// ---- 系统状态 ----
app.get('/api/status', (req, res) => {
  const leads = loadData('leads');
  const followups = loadData('followups');
  res.json({
    status: 'running',
    version: '1.0.0',
    leadsCount: leads ? (leads.data || []).length : 0,
    followupsCount: followups ? (followups.data || []).length : 0,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ---- 所有其他路由回退到首页 ----
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('=================================');
  console.log('  科诺美 线索跟进管理系统 CMS');
  console.log('  http://localhost:' + PORT);
  console.log('  API: /api/status');
  console.log('  管理: /admin.html');
  console.log('=================================');
});
