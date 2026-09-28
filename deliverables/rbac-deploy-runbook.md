# 科诺美线索系统 RBAC 升级 — 部署 / 回滚手册

## 0. 变更摘要

- 新增边缘函数：`_auth.js`、`_config.js`、`_acl.js`、`_log.js`、`auth/login.js`、`users.js`、`logs.js`
- 改造边缘函数：`leads.js`、`followups.js`、`status.js`、`flowchart.js`、`mql.js`（鉴权 + 行级过滤 + 服务端合并写回 + 审计日志）
- 前端 `index.html`：登录页（邮箱+密码）替换旧单口令门禁；apiFetch 会话层；角色化 UI；admin「日志」Tab
- **数据安全**：只新增 Blob key（`users`、`logs/*`、`meta.scopeModified`），不改写 leads/followups 既有数据

## 1. 部署步骤

### 1.1 配置密钥（必做）

EdgeOne Pages 控制台 → 项目 `chromai-leads` → 环境变量 → 新增：

```
AUTH_SECRET = <64 位随机十六进制串>   # 可用 openssl rand -hex 32 生成
```

> 未配置时函数使用代码内兜底密钥（联调用，安全性降级，token 可被伪造）。轮换密钥 = 全部 token 失效强制重登。

### 1.2 部署

```bash
cd edgeone
edgeone makers deploy . -n chromai-leads -e production
```

### 1.3 初始化 users 种子（幂等）

```bash
cd edgeone
EO_TOKEN=<项目访问令牌> node seed-blob.js users
# 或 npm run seed:users
```

- 原理：Blob 只能由边缘函数写入；首次登录请求触发服务端 `loadUsers()` 自愈初始化（users 缺失才写默认 13 账号，**绝不覆盖**管理员后续调整）。
- 通过标准：13/13 账号 ✅，各自角色与 PRD 一致。
- 可重复执行，无副作用。

### 1.4 冒烟测试（5 分钟）

1. 打开站点 → 出现「公司邮箱 + 密码」登录页（不再是单口令框）。
2. `yucui@chromai.com / chromai2019` 登录 → 顶栏「于翠 · 管理员」，数据全量，可见「日志」Tab。
3. 日志 Tab → 能看到刚才的 login_success 记录。
4. 退出 → `wangyuanshuai@chromai.com / chromai2019` 登录 → 顶栏「王远帅 · 销售」，留资清单只剩本人线索，无「日志」Tab，销售筛选器隐藏。
5. 销售编辑一条本人线索的普通字段保存 → 重新用 admin 登录确认：该行已更新、**其他大区行数不变（2282 总量不受损）**。
6. 销售尝试把负责人改成别大区人 → 保存后该字段被服务端锁回本人。
7. 完整用例见 `deliverables/rbac-acceptance-checklist.md`。

## 2. 回滚

数据层零侵入（leads/followups 从未被改写），回滚 = 重部旧版代码：

```bash
git checkout <升级前 commit> -- edgeone/index.html edgeone/functions/api edgeone/seed-blob.js edgeone/package.json
cd edgeone && edgeone makers deploy . -n chromai-leads -e production
```

- Blob 中遗留的 `users`、`logs/*`、`meta.scopeModified` 对旧版代码无任何影响，可保留（再次升级时直接复用）。
- 无服务端会话状态，回滚后用户用旧口令 chromai2019 即可进入，无迁移成本。

## 3. 运维要点

| 项 | 说明 |
|---|---|
| 账号调整 | 本期为只读配置：修改 `_auth.js` DEFAULT_USERS 与 `_config.js` REGION_MEMBERS（两处必须一致）后重新部署；或直接在 Blob `users` key 上改（需同步 `_config.js`） |
| 统一密码 | 本期全部 `chromai2019`；首次登录强制改密列 P2 |
| 日志保留 | 12 个月，每日首次写入惰性清理旧分片（依赖 Blob list 能力，不可用时跳过） |
| 日志查询 | 单次日期范围 ≤31 天（UTC+8 日界） |
| IP 记录 | 取 `x-forwarded-for` / `x-real-ip`；边缘函数取不到时为空串（联调验证） |
| 并发 | 行级 last-write-wins（13 人低并发，与升级前一致） |

## 4. 已知边界（设计「待明确事项」的默认实现）

1. 未分配线索（负责人/负责大区为空）仅 admin 可见可编辑。
2. flowchart/mql 配置写权限仅 admin；其余角色只读（前端非 admin 不发配置 POST）。
3. 销售允许改派给同大区同事（改派后线索移出自己视图）。
4. 前端已有删除入口（行尾 ✕ / 批量删除），delete 校验与日志已生效：sales 只能删本人行、region 只能删本大区行。
5. 登录失败锁定（5 次锁 15 分钟）未实现，列 P2。
