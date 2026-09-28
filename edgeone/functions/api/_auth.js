// 科诺美线索系统 - 共享认证模块（HMAC-SHA256 三段式 token，Web Crypto 零依赖）
//
// 密钥管理：
//   首选 EdgeOne Pages 环境变量 AUTH_SECRET（控制台配置，函数内 env.AUTH_SECRET 读取）。
//   ⚠️ 生产环境必须配置 AUTH_SECRET！下方 FALLBACK_SECRET 仅为快速联调兜底，
//   代码一旦公开，所有 token 都可被伪造。轮换密钥 = 全部 token 失效强制重登（可接受）。

// ⚠️ 生产必配环境变量 AUTH_SECRET —— 本兜底串仅用于未配置时的联调
const FALLBACK_SECRET = 'chromai-rbac-fallback-3f8a1c9e7b2d4f60a5c8e1b3d6f9a2c5-PROD-MUST-SET-AUTH_SECRET';

// 统一 CORS（Authorization 允许携带；X-New-Token 暴露给前端读取滑动续期）
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'X-New-Token'
};

export const TOKEN_TTL_SEC = 7 * 86400;          // token 有效期 7 天
export const RENEW_THRESHOLD_SEC = 3.5 * 86400;  // 剩余有效期 < 3.5 天时滑动续期
export const DEFAULT_PASSWORD = 'chromai2019';   // 本期统一初始密码（P2 再做首次登录强制改密）

// 16 账号默认清单（与 PRD 第 3 节一致；高雷按 sales 处理；pwdHash 由 buildDefaultUsers 计算）
// 2026-09-17 扩充：刘健凯（海外大区总）、张塞云/房戈（IVD 业务销售，不归属任何大区）
export const DEFAULT_USERS = [
  { email: 'yucui@chromai.com',         name: '于翠',   role: 'admin',  region: null },
  { email: 'wangqiong@chromai.com',     name: '汪琼',   role: 'admin',  region: null },
  { email: 'zhangxin@chromai.com',      name: '张欣',   role: 'admin',  region: null },
  { email: 'tangxianyi@chromai.com',    name: '汤显义', role: 'region', region: '汤显义',
    subordinates: ['高丹枫', '高雷', '王泽', '王远帅', '黄江锐', '胡雨来', '汤显义'] },
  { email: 'guanneng@chromai.com',      name: '管能',   role: 'region', region: '管能',
    subordinates: ['管能', '刘力瑞'] },
  { email: 'muzhongren@chromai.com',    name: '穆忠仁', role: 'region', region: '穆忠仁',
    subordinates: ['穆忠仁'] },
  { email: 'wangyuanshuai@chromai.com', name: '王远帅', role: 'sales',  region: '汤显义' },
  { email: 'gaodanfeng@chromai.com',    name: '高丹枫', role: 'sales',  region: '汤显义' },
  { email: 'huangjiangrui@chromai.com', name: '黄江锐', role: 'sales',  region: '汤显义' },
  { email: 'wangze@chromai.com',        name: '王泽',   role: 'sales',  region: '汤显义' },
  { email: 'huyulai@chromai.com',       name: '胡雨来', role: 'sales',  region: '汤显义' },
  { email: 'gaolei@chromai.com',        name: '高雷',   role: 'sales',  region: '汤显义' },
  { email: 'liulirui@chromai.com',      name: '刘力瑞', role: 'sales',  region: '管能' },
  { email: 'liujiankai@chromai.com',    name: '刘健凯', role: 'region', region: '刘健凯',
    subordinates: ['刘健凯'] },                                   // 海外大区总
  { email: 'zhangsaiyun@chromai.com',   name: '张塞云', role: 'sales',  region: null },  // IVD 业务（无大区）
  { email: 'fangge@chromai.com',        name: '房戈',   role: 'sales',  region: null }   // IVD 业务（无大区）
];

function getSecret(env) {
  return (env && env.AUTH_SECRET) || FALLBACK_SECRET;
}

// ---- base64url（UTF-8 安全，payload 含中文姓名）----
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

// SHA-256（hex），用于密码哈希：sha256hex(email.toLowerCase() + ':' + password)
export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

let _hmacKeyCache = null;
let _hmacKeySecret = null;
async function hmacKey(secret) {
  if (_hmacKeyCache && _hmacKeySecret === secret) return _hmacKeyCache;
  _hmacKeyCache = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  _hmacKeySecret = secret;
  return _hmacKeyCache;
}

async function hmacSha256Hex(data, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bytesToHex(new Uint8Array(sig));
}

// 定长比较（防时序攻击）
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const la = a.length, lb = b.length;
  let diff = la === lb ? 0 : 1;
  const n = Math.max(la, lb, 1);
  for (let i = 0; i < n; i++) {
    diff |= ((a.charCodeAt(i % la) || 0) ^ (b.charCodeAt(i % lb) || 0));
  }
  return diff === 0 && la === lb;
}

// 签发 token：base64url(header).base64url(payload).base64url(HMAC-SHA256)
export async function signToken(user, env) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.email,
    name: user.name,
    role: user.role,
    region: user.region || null,
    iat: iat,
    exp: iat + TOKEN_TTL_SEC
  };
  const h = b64urlEncode(JSON.stringify(header));
  const p = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacSha256Hex(h + '.' + p, getSecret(env));
  return h + '.' + p + '.' + sig;
}

// 验签：合法且未过期返回 payload，否则返回 null
export async function verifyToken(token, env) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expect = await hmacSha256Hex(parts[0] + '.' + parts[1], getSecret(env));
  if (!timingSafeEqualStr(expect, parts[2])) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(parts[1])); } catch (e) { return null; }
  if (!payload || !payload.sub || !payload.role) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) return null;
  return payload;
}

// 鉴权入口：每个业务函数第一行调用。
// 成功返回 { user: {email,name,role,region}, newToken: string|null }（剩余 <3.5 天自动续签）；
// 失败返回 null（调用方返回 401）。
// 注：设计文档签名为 requireAuth(request, store)，实际鉴权只需 request+env
// （角色/大区取自 token payload，下辖名单由 _config.js 单一事实源提供），故简化为 (request, env)。
export async function requireAuth(request, env) {
  const authz = request.headers.get('Authorization') || request.headers.get('authorization') || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const payload = await verifyToken(m[1], env);
  if (!payload) return null;
  const now = Math.floor(Date.now() / 1000);
  let newToken = null;
  if (payload.exp - now < RENEW_THRESHOLD_SEC) {
    newToken = await signToken(
      { email: payload.sub, name: payload.name, role: payload.role, region: payload.region }, env
    );
  }
  return {
    user: { email: payload.sub, name: payload.name, role: payload.role, region: payload.region || null },
    newToken: newToken
  };
}

// ---- 用户加载（Blob key = users，缺失时用默认清单自愈初始化，幂等）----
export async function buildDefaultUsers() {
  const users = [];
  for (const u of DEFAULT_USERS) {
    users.push({
      email: u.email,
      name: u.name,
      role: u.role,
      region: u.region || null,
      subordinates: u.subordinates || [],
      pwdHash: await sha256(u.email.toLowerCase() + ':' + DEFAULT_PASSWORD)
    });
  }
  return users;
}

// 幂等合并：默认清单里新增的账号自动补入已存在的 users（按 email 去重）；
// 已存在的账号保持原样（保留改密后的 pwdHash 与角色调整），绝不做覆盖。
export async function mergeDefaultUsers(users) {
  const defaults = await buildDefaultUsers();
  const seen = new Set((users || []).map(u => String(u.email || '').toLowerCase()));
  let added = 0;
  defaults.forEach(d => {
    if (!seen.has(d.email.toLowerCase())) { users.push(d); seen.add(d.email.toLowerCase()); added++; }
  });
  return added;
}

export async function loadUsers(store) {
  let stored = null;
  try {
    const data = await store.get('users', { type: 'json', consistency: 'strong' });
    if (data && Array.isArray(data.users) && data.users.length > 0) stored = data.users;
  } catch (e) { /* 读失败走自愈 */ }

  if (!stored) {
    // 自愈初始化：users 不存在/为空才整体写入，避免覆盖管理员后续调整
    const users = await buildDefaultUsers();
    try { await store.set('users', JSON.stringify({ users: users })); } catch (e) { /* 写失败不阻塞登录 */ }
    return users;
  }

  // 已存在：仅补全缺失账号（配置新增人员时无需人工改库）
  try {
    const added = await mergeDefaultUsers(stored);
    if (added > 0) await store.set('users', JSON.stringify({ users: stored }));
  } catch (e) { /* 补账号失败不阻塞登录 */ }
  return stored;
}

// ---- 请求辅助 ----
export function getIp(request) {
  return request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || '';
}

export function authHeaders(auth) {
  return auth && auth.newToken ? { 'X-New-Token': auth.newToken } : {};
}

export function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS, extraHeaders || {})
  });
}

export function optionsResp() {
  return new Response(null, { headers: CORS });
}

export function unauthorized(extraHeaders) {
  return json({ ok: false, error: 'unauthorized' }, 401, extraHeaders);
}
