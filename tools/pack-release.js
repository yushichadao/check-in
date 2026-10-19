'use strict';
/* 生成发布包与拆分包，全部输出到 site/download/（官网「下载」区直接引用）：
 *  - 班级签到系统.zip           完整部署包（排除 node_modules / data* / *.zip / .env / download 等）
 *  - 班级签到系统-服务端.zip     server/ + run_server.js + package*.json + tools/ + .env.example + start.bat + .npmrc/.nvmrc + README/LICENSE
 *  - 班级签到系统-三端页面.zip   public/（用户端 / 管理端 / 运维端页面与静态资源）
 *  - README.md                  部署文档单独下载
 *  - manual-*.pdf               三册说明书单独下载
 * 运行：node tools/pack-release.js */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'site', 'download');

const EXCLUDES = [
  'node_modules', 'data*', '*.zip', '.codebuddy', 'screens', 'docs',
  'tools/jointdebug', 'server/seed-prod.js', '.env', '.git', 'check-deps.log',
  '*.log*', '.deps-fix.lock', 'download'
];

function tar(out, entries) {
  const args = ['-a', '-cf', out];
  for (const e of EXCLUDES) args.push('--exclude=' + e);
  args.push('-C', ROOT, ...entries);
  execSync('tar ' + args.map((a) => `"${a}"`).join(' '), { stdio: 'inherit' });
  const sz = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`已生成：${out} (${sz} MB)`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
// 清掉旧包，避免改名后残留
for (const f of fs.readdirSync(OUT_DIR)) {
  if (/^班级签到系统.*\.zip$/.test(f)) fs.rmSync(path.join(OUT_DIR, f));
}

tar(path.join(OUT_DIR, '班级签到系统.zip'), ['.']);
tar(path.join(OUT_DIR, '班级签到系统-服务端.zip'),
  ['server', 'run_server.js', 'package.json', 'package-lock.json', 'tools',
   '.env.example', '.npmrc', '.nvmrc', 'start.bat', 'README.md', 'LICENSE']);
tar(path.join(OUT_DIR, '班级签到系统-三端页面.zip'), ['public']);

// 单独下载的文档
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(OUT_DIR, 'README.md'));
for (const f of fs.readdirSync(ROOT)) {
  if (/^manual-.+\.pdf$/.test(f)) {
    fs.copyFileSync(path.join(ROOT, f), path.join(OUT_DIR, f));
  }
}
console.log('全部下载文件已输出到 site/download/');
