# Chromai 线索跟进提醒（MQLs 三封邮件）

本机定时脚本：扫描 leads.chromai.com 的 MQLs（跟进记录），按「新增 / 48h / 72h」三档给销售发跟进提醒邮件，走腾讯企业邮 SMTP。

> 只做提醒，不写回业务数据（对服务端只有 `GET` 调用）。

## 目录

| 文件 | 说明 |
|---|---|
| `index.mjs` | 主流程 |
| `rules.mjs` | 判定规则（纯函数，无 IO） |
| `mailer.mjs` | nodemailer 封装（腾讯企业邮 465） |
| `hub.mjs` | hub 推送（Supabase PostgREST，`enabled:false` 默认关闭） |
| `check.mjs` | 判定逻辑离线单测（不联网、不发信） |
| `config.example.json` | 示例配置（不含真实密码） |
| `config.json` | 本机真实配置 —— **已 gitignore，绝不提交** |
| `state.json` | 运行时状态（已发记录 / 待发队列）—— **已 gitignore** |
| `logs/YYYY-MM-DD.log` | 每次运行追加 |

## 安装

在 `notify` 目录内装依赖（不要用全局）：

```bat
cd /d E:\Oreo\Workbuddy\2026-07-28-08-29-21\chromai-leads-cms\notify
C:\Users\yucui\.workbuddy\binaries\node\versions\22.22.2-2\npm.cmd install
```

## 配置

```bat
copy config.example.json config.json
```

然后编辑 `config.json`：`admin.email / admin.password`（管理员账号）、`smtp.user / smtp.from`。

**SMTP 密码不要写进文件**，用环境变量注入：

```bat
setx SMTP_PASS "你的企业邮密码或客户端专用密码"
```

`mailer.mjs` 的取值顺序：`process.env.SMTP_PASS` → `config.smtp.pass`。日志里一律打印 `***`。

## 用法

```bat
set NODE=C:\Users\yucui\.workbuddy\binaries\node\versions\22.22.2-2\node.exe

%NODE% index.mjs --init     :: 只建基线：把当前全量跟进编号记为「已发①」，发出 0 封
%NODE% index.mjs --dry      :: 打印待发清单（档位/收件人/主题），一封都不发
%NODE% index.mjs            :: 正常跑（在发送时段内才真发，否则入队）
%NODE% index.mjs --summary  :: 历史欠账按大区总汇总（每区一封，显式执行才跑）
%NODE% index.mjs --limit 20 :: 只处理前 20 行（联调用）
%NODE% index.mjs --fixture fixture.json   :: 用本地假数据跑，不连服务器
%NODE% check.mjs            :: 判定逻辑离线单测
```

**第一次上线务必先跑 `--init`**：否则存量数据会被当成「新增」瞬间发出上百封。

## 判定规则

时间基准：`跟进日期` 当天 **00:00（Asia/Shanghai）** + N 小时；「未跟进」= 「跟进记录」列解析出的子项数 **= 0**
（该列为 JSON `[{"d":"YYYY-MM-DD","t":"..."}]`，空值 `''`；旧纯文本按 1 条降级；解析失败按 1 条）。

| # | 触发条件 | 收件 | 抄送 |
|---|---|---|---|
| ① 新增 | state 里没见过的「跟进编号」 | 负责人 | — |
| ② 48h | 跟进日期 0 点 +48h ≤ now 且未跟进 | 负责人 | — |
| ③ 72h | 跟进日期 0 点 +72h ≤ now 且未跟进 | 负责人 | 大区总 |

- 一条线索最多这 3 封；一旦子项数 > 0，后续档位自动取消（已从队列里撤销）。
- 同一档位只发一次（state 记 `stage` 1/2/3 + `sentAt`）。
- 列定位全部按**表头名**查找，不硬编码索引（表头可被用户增删）。

### 三道防轰炸闸（历史欠账绝不群发）

1. **基线覆盖三档**：`--init`（或 state 为空时的首次运行）会把每条记录的
   `stages["1"]/["2"]/["3"]` **全部**标记为 `baseline`。语义 = 上线之前的欠账不补发。
2. **`meta.goLiveAt`**：state 里记录上线时刻；`跟进日期` 早于上线日的行**直接跳过 ①②③**
   （日志记 `before_go_live`）。即使 `state.json` 被误删重建，也不会把历史欠账重发一遍。
3. **新增且已超时只发 ①**：导入/补录的历史记录会同时命中 ①②③，此时**只发 ①**，
   并把 ②③ 标记为 `suppressed:true`（不再补发），日志注明原因。

上线前的存量欠账不逐条发，改用 `--summary` 按大区总汇总。

### 历史欠账汇总（`--summary`）

显式传 `--summary` 才执行（与正常扫描互斥）：

- 口径：未填写「跟进记录」且跟进日期已超 48 小时的存量记录
- 收件：各大区总（汤显义 / 管能 / 穆忠仁 / 刘健凯）；无大区总的（IVD 张塞云、房戈）与查不到归属的
  并成一封发给 admin
- 标题：`【历史欠账汇总】{大区}有 N 条超 48 小时未跟进`
- 正文：按负责人分组，列出 跟进编号 / 客户名称 / 跟进日期 / 超时时长 / 线索编号，按超时时长倒序
- `--dry --summary` 只打印清单，不发信

## 收件人映射

优先 `GET /api/users`（admin token）拿 `{name,email,role,region}`；拿不到时回落到 `rules.mjs` 的内置表
（与 `edgeone/functions/api/_auth.js` 的 `DEFAULT_USERS` 保持一致）。

大区总 = 该负责人的 `region` 字段（`region` 角色本人即自己的大区总）：

| 负责人 | 大区总 |
|---|---|
| 王远帅 / 高丹枫 / 黄江锐 / 王泽 / 胡雨来 / 高雷 | 汤显义 tangxianyi@ |
| 刘力瑞 / 管能 | 管能 guanneng@ |
| 穆忠仁 | 穆忠仁 muzhongren@（本人，不重复抄送） |
| 刘健凯 | 刘健凯 liujiankai@（本人，不重复抄送） |
| 张塞云 / 房戈 | 无大区总 —— 第③封不抄送，只记日志 |

负责人为空或查不到邮箱 → 跳过并记日志，不中断。

## 发送时段

- 只在**工作日 09:00–18:00**（上海时间）真发；周六周日不发。
- 窗口外的通知写入 `state.json` 的 `pending` 队列，下一个工作日 09:00 后自动补发（补发前会再校验一次是否已被跟进）。
- 法定节假日：在 `config.schedule.holidays` 里加 `["2026-10-01", ...]` 即可（扩展位已预留）。

## 日志

`logs/YYYY-MM-DD.log`，每次运行追加。凭据一律 `***`，不落盘明文。

## Windows 计划任务

每小时跑一次（脚本内部自己判断发送窗口，窗口外只入队）：

```bat
schtasks /Create /TN "ChromaiLeadsNotify" /TR "\"C:\Users\yucui\.workbuddy\binaries\node\versions\22.22.2-2\node.exe\" \"E:\Oreo\Workbuddy\2026-07-28-08-29-21\chromai-leads-cms\notify\index.mjs\"" /SC HOURLY /MO 1 /ST 09:00 /F
```

查看 / 删除：

```bat
schtasks /Query /TN "ChromaiLeadsNotify" /V /FO LIST
schtasks /Delete /TN "ChromaiLeadsNotify" /F
```

> 计划任务里要带 `SMTP_PASS`：要么用 `setx` 写到用户环境变量（重启后生效，任务以同一用户运行时可读），
> 要么在任务属性的「起始位置」填 notify 目录并改用包装 .bat（内部 `set SMTP_PASS=...`）。

## 发信账号与自检（2026-09-29 已跑通）

- 发信：`contact@chromai.com`，SMTP `smtp.exmail.qq.com:465`（SSL）
- 密码：腾讯企业邮**客户端专用密码**，存在 `config.json`（已 gitignore），也可用环境变量 `SMTP_PASS` 覆盖
- ⚠️ 登录密码**不能**用于 SMTP，必须用「设置 → 账户 → 安全设置 / 客户端专用密码」生成的那串（否则 535）
- ⚠️ 发送时 `from` 必须与认证账号一致，否则 501 `mail from address must be same as authorization user`

验证通道（只发给 `config.selftest.to`，默认管理员本人，不会打扰销售）：

```bat
node selftest.mjs
```

它会取线上 3 条真实未跟进记录生成一封正式排版的邮件（主题带【测试】），用来确认排版与送达。

## hub 推送

`config.hub.enabled = true` 后才会 POST 到 `{hub.url}/rest/v1/hub_messages`
（header `apikey` + `Authorization: Bearer <serviceKey>`）。

⚠️ **字段名待 Alex Zhang 提供真实 schema 后校准**：`hub.mjs` 的 `TABLE` 常量与 `buildPayload()` 里的
`event_type / stage / followup_id / recipients / meta` 均为占位，拿到真实 schema 只改这两处即可。
