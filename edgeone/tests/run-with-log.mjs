// 输出捕获包装器（当前会话 shell 的 stdout 捕获损坏时使用；正常环境可直接 node tests/test-rbac.js）
// 用法：node tests/run-with-log.mjs tests/test-rbac.js [输出文件名]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const target = process.argv[2];
const outName = process.argv[3] || (path.basename(target, path.extname(target)) + '-result.txt');
const LINES = [];
console.log = (...a) => { LINES.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
console.error = (...a) => { LINES.push('[stderr] ' + a.join(' ')); };
process.on('exit', (code) => {
  try { fs.writeFileSync(path.resolve(outName), 'EXIT=' + code + '\n' + LINES.join('\n') + '\n', 'utf8'); } catch (e) {}
});
await import(pathToFileURL(path.resolve(target)).href);
