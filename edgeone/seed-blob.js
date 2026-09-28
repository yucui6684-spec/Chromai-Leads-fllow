// 种子数据推送到 EdgeOne Blob 存储
const fs = require('fs');
const https = require('https');
const path = require('path');

const BASE_URL = 'https://chromai-leads-itiybzod.edgeone.cool';
const EO_TOKEN = process.env.EO_TOKEN || '';
const EO_TIME = '1787013009';
const DATA_DIR = path.resolve(__dirname, '../data');

function fetchWithCookies(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOpts = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = https.request(reqOpts, (res) => {
      // 收集 cookies
      const cookies = [];
      if (res.headers['set-cookie']) {
        for (const c of res.headers['set-cookie']) {
          const match = c.match(/^([^=]+)=([^;]+)/);
          if (match) cookies.push(match[1] + '=' + match[2]);
        }
      }

      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => {
        resolve({ status: res.statusCode, body, cookies, headers: res.headers });
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function main() {
  // 高危防误触：主种子会全量覆盖 leads/followups。RBAC 上线后仅允许显式授权时执行；
  // 日常只能运行 `node seed-blob.js users`（幂等初始化账号）。
  if (process.env.ALLOW_SEED_OVERWRITE !== 'YES') {
    console.error('拒绝执行：主种子会全量覆盖 leads/followups。若确需初始化空环境，请设置 ALLOW_SEED_OVERWRITE=YES 后重试。');
    process.exit(2);
  }
  console.log('=== EdgeOne Blob 存储种子脚本（已显式授权覆盖）===\n');

  // Step 1: 获取认证 cookies
  console.log('1. 获取认证 cookies...');
  const authRes = await fetchWithCookies(
    `${BASE_URL}/api/status?eo_token=${EO_TOKEN}&eo_time=${EO_TIME}`
  );
  const cookieStr = authRes.cookies.join('; ');
  console.log(`   状态: ${authRes.status}, cookies: ${authRes.cookies.length} 个`);

  if (authRes.status === 302) {
    // 跟随重定向获取实际数据
    console.log('   跟随重定向...');
    const redirRes = await fetchWithCookies(`${BASE_URL}/api/status`, {
      headers: { 'Cookie': cookieStr }
    });
    console.log(`   重定向状态: ${redirRes.status}`);
    if (redirRes.body) console.log(`   响应: ${redirRes.body.substring(0, 200)}`);
  }

  // Step 2: 推送 leads 数据
  console.log('\n2. 推送 leads 数据...');
  const leadsData = fs.readFileSync(path.join(DATA_DIR, 'leads.json'), 'utf-8');
  console.log(`   数据大小: ${(leadsData.length / 1024).toFixed(1)} KB`);
  const leadsRes = await fetchWithCookies(`${BASE_URL}/api/leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieStr
    },
    body: leadsData
  });
  console.log(`   状态: ${leadsRes.status}, 响应: ${leadsRes.body.substring(0, 200)}`);

  // Step 3: 推送 followups 数据
  console.log('\n3. 推送 followups 数据...');
  const fupsData = fs.readFileSync(path.join(DATA_DIR, 'followups.json'), 'utf-8');
  console.log(`   数据大小: ${(fupsData.length / 1024).toFixed(1)} KB`);
  const fupsRes = await fetchWithCookies(`${BASE_URL}/api/followups`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieStr
    },
    body: fupsData
  });
  console.log(`   状态: ${fupsRes.status}, 响应: ${fupsRes.body.substring(0, 200)}`);

  // Step 4: 验证数据
  console.log('\n4. 验证数据...');
  await new Promise(r => setTimeout(r, 2000)); // 等待 2 秒让数据写入
  const verifyRes = await fetchWithCookies(`${BASE_URL}/api/status`, {
    headers: { 'Cookie': cookieStr }
  });
  console.log(`   状态: ${verifyRes.status}`);
  if (verifyRes.body) {
    try {
      const status = JSON.parse(verifyRes.body);
      console.log(`   leadsCount: ${status.leadsCount}, followupsCount: ${status.followupsCount}, blobReady: ${status.blobReady}`);
    } catch(e) {
      console.log(`   响应: ${verifyRes.body.substring(0, 300)}`);
    }
  }

  console.log('\n=== 完成 ===');
}

// ============================================================
// users 种子（幂等）：node seed-blob.js users
// 说明：EdgeOne Blob 只能由边缘函数写入，因此 users 的实际写入由服务端
// _auth.js loadUsers() 自愈初始化完成（users key 缺失时才写默认 13 账号，
// 绝不覆盖管理员后续调整）。本脚本职责：触发自愈 + 逐账号验证登录。
// ============================================================
const SEED_USERS = [
  ['yucui@chromai.com', '于翠', 'admin'],
  ['wangqiong@chromai.com', '汪琼', 'admin'],
  ['zhangxin@chromai.com', '张欣', 'admin'],
  ['tangxianyi@chromai.com', '汤显义', 'region'],
  ['guanneng@chromai.com', '管能', 'region'],
  ['muzhongren@chromai.com', '穆忠仁', 'region'],
  ['wangyuanshuai@chromai.com', '王远帅', 'sales'],
  ['gaodanfeng@chromai.com', '高丹枫', 'sales'],
  ['huangjiangrui@chromai.com', '黄江锐', 'sales'],
  ['wangze@chromai.com', '王泽', 'sales'],
  ['huyulai@chromai.com', '胡雨来', 'sales'],
  ['gaolei@chromai.com', '高雷', 'sales'],
  ['liulirui@chromai.com', '刘力瑞', 'sales']
];
const SEED_PASSWORD = 'chromai2019';

async function seedUsers() {
  console.log('=== EdgeOne Blob users 种子脚本（幂等）===\n');

  // Step 1: 获取认证 cookies（与 main 同一门禁流程）
  console.log('1. 获取认证 cookies...');
  const authRes = await fetchWithCookies(
    `${BASE_URL}/api/status?eo_token=${EO_TOKEN}&eo_time=${EO_TIME}`
  );
  const cookieStr = authRes.cookies.join('; ');
  console.log(`   状态: ${authRes.status}, cookies: ${authRes.cookies.length} 个`);

  // Step 2: 逐账号调用登录（首次调用触发服务端自愈写入 users，已存在则不覆盖）
  console.log('\n2. 触发自愈初始化并逐账号验证登录...');
  let okCount = 0, failCount = 0;
  for (const [email, name, role] of SEED_USERS) {
    const res = await fetchWithCookies(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookieStr },
      body: JSON.stringify({ email, password: SEED_PASSWORD })
    });
    let ok = false, roleGot = '';
    try {
      const data = JSON.parse(res.body);
      ok = res.status === 200 && data.ok === true;
      roleGot = data.user ? data.user.role : '';
    } catch (e) { /* 非 JSON 响应 */ }
    if (ok && roleGot === role) { okCount++; console.log(`   ✅ ${name} (${email}) [${role}]`); }
    else { failCount++; console.log(`   ❌ ${name} (${email}) 期望 ${role} 实际 ${roleGot || '登录失败'} (HTTP ${res.status})`); }
  }

  console.log(`\n=== 完成：${okCount} 通过 / ${failCount} 失败 ===`);
  if (failCount > 0) {
    console.log('提示：若用户已存在且角色/密码被管理员调整过，验证可能失败——本脚本不会覆盖既有 users。');
  }
}

if (process.argv[2] === 'users') {
  seedUsers().catch(console.error);
} else {
  main().catch(console.error);
}
