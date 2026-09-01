// 种子数据推送到 EdgeOne Blob 存储
const fs = require('fs');
const https = require('https');
const path = require('path');

const BASE_URL = 'https://chromai-leads-itiybzod.edgeone.cool';
const EO_TOKEN = '330c92548796a6ea2422ce4f69ce51f0';
const EO_TIME = '1787013009';
const DATA_DIR = 'F:/Oreo/2026-07-28-08-29-21/chromai-leads-cms/data';

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
  console.log('=== EdgeOne Blob 存储种子脚本 ===\n');

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

main().catch(console.error);
