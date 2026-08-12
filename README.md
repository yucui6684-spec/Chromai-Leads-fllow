# 科诺美 (Chromai) 线索跟进管理系统

> 液相色谱 (HPLC) 行业市场线索全流程管理平台

## 功能概览

| 模块 | 说明 |
|------|------|
| **数据看板** | 线索总量/已跟进/待跟进/流失/MQL/SQL 实时统计 + 阶段分布 + 销售跟进分析 |
| **线索池总表** | 1955 条线索，17 列可编辑，支持下拉/文本/阶段标签 |
| **跟进记录** | 184 条销售跟进记录，线索编号可点击跳转 |
| **流程示意图** | 4 时期 8 阶段 + 流失回收，全字段可编辑 |
| **MQL 评分标准** | 100 分制 3 维度（行为 40 + 企业属性 30 + 采购信号 40），≥60 分升级 |
| **增减列管理** | 线索池/跟进记录支持动态添加/删除自定义列 |
| **CMS 后台** | Express REST API + JSON 文件存储，支持浏览器↔服务器双向同步 |

## 技术栈

- **前端**: 纯 HTML/CSS/JavaScript，单文件部署，localStorage 持久化
- **后端**: Node.js + Express，JSON 文件存储
- **部署**: CloudStudio (静态预览) / Vercel (全栈 Serverless) / 本地运行

## 快速开始

### 本地运行（含 CMS 后台）

```bash
# 安装依赖
npm install

# 启动服务器
npm start

# 访问
# http://localhost:3000        → 主系统
# http://localhost:3000/admin  → CMS 管理后台
# http://localhost:3000/manual → 使用手册
```

### 仅前端（无需后端）

直接用浏览器打开 `public/index.html` 即可，所有数据存储在浏览器 localStorage 中。

## 部署指南

### Vercel 部署（推荐，支持全栈）

1. 将本仓库推送到 GitHub
2. 在 [vercel.com](https://vercel.com) 导入该仓库
3. 自动识别 `vercel.json` 配置
4. 部署完成，获得线上地址

```bash
# 或使用 Vercel CLI
npm i -g vercel
vercel
```

### CloudStudio 部署

使用 CloudStudio 静态部署，上传 `public/` 目录即可。

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 系统状态 |
| GET | `/api/leads` | 获取全部线索 |
| POST | `/api/leads` | 保存全部线索（全量覆盖） |
| POST | `/api/leads/add` | 追加一条线索 |
| PUT | `/api/leads/:index` | 更新指定线索 |
| DELETE | `/api/leads/:index` | 删除指定线索 |
| GET | `/api/followups` | 获取全部跟进记录 |
| POST | `/api/followups` | 保存全部跟进记录 |
| GET | `/api/flowchart` | 获取流程图数据 |
| POST | `/api/flowchart` | 保存流程图数据 |
| GET | `/api/mql` | 获取 MQL 评分数据 |
| POST | `/api/mql` | 保存 MQL 评分数据 |
| GET | `/api/export/all` | 导出全部数据 (JSON) |
| POST | `/api/import/all` | 导入全部数据 |

## 项目结构

```
chromai-leads-cms/
├── public/                 # 前端静态文件
│   ├── index.html          # 主系统（白色主题 + 列管理）
│   ├── admin.html          # CMS 管理后台
│   └── manual.html         # 使用手册
├── api/                    # Vercel Serverless Functions
│   ├── status.js           # /api/status
│   ├── leads.js            # /api/leads
│   ├── followups.js        # /api/followups
│   └── data.js             # /api/export/all & /api/import/all
├── data/                   # JSON 数据存储（运行时生成）
├── server.js               # Express CMS 后台
├── package.json
├── vercel.json             # Vercel 部署配置
└── .gitignore
```

## 组织架构

| 大区 | 大区总 | 下辖省份 |
|------|--------|----------|
| 汤显义大区 | 汤显义 | 北京/天津/河北/山西/内蒙古/河南/山东/陕西/新疆/湖北/甘肃/宁夏/青海 |
| 管能大区 | 管能 | 上海/江苏/浙江/安徽/福建/江西/重庆/四川/云南/贵州/西藏 |
| 穆忠仁大区 | 穆忠仁 | 辽宁/吉林/黑龙江/广东/广西/海南/湖南 |

## License

MIT (c) 科诺美市场中心
