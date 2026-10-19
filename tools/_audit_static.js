/* 静态一致性审计：前端资源引用 + 前后端 API 路径比对（只做检查，不改动任何文件） */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const SRV = path.join(ROOT, 'server');

function walk(dir, out, skip) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip && skip.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, skip);
    else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/* ---------- 1. HTML → 本地资源引用存在性 ---------- */
const htmlFiles = walk(PUB, []).filter(p => p.endsWith('.html'));
const missAsset = [];
for (const f of htmlFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const refs = [];
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) refs.push(m[1]);
  for (const r of refs) {
    if (/^(https?:|mailto:|data:|#|javascript:)/i.test(r)) continue;
    if (r.startsWith('/')) continue;               // 绝对路径：交给运行时
    const clean = r.split('?')[0].split('#')[0];
    if (!clean) continue;
    const target = path.join(path.dirname(f), clean);
    if (!fs.existsSync(target)) missAsset.push([rel(f), r]);
  }
}

/* ---------- 2. server 路由表 ---------- */
const routeFiles = walk(SRV, []).filter(p => p.endsWith('.js'));
// 挂载前缀：从 index.js 解析 app.use(P('/api/xxx'), require('./routes/yyy'))
const idx = fs.readFileSync(path.join(SRV, 'index.js'), 'utf8');
const mounts = [];   // {prefix, file}
const mre = /app\.use\(\s*P\('([^']*)'\)\s*,\s*require\('\.\/(routes\/[^']+)'\)/g;
let mm;
while ((mm = mre.exec(idx))) mounts.push({ prefix: mm[1], file: mm[2] });
const routes = [];   // {method, path, file}
for (const mt of mounts) {
  let fp = path.join(SRV, mt.file);
  if (!fs.existsSync(fp)) fp = fp + '.js';
  if (!fs.existsSync(fp)) { routes.push({ method: '?', path: 'MISSING-FILE:' + mt.file, file: mt.file }); continue; }
  const src = fs.readFileSync(fp, 'utf8');
  const rre = /router\.(get|post|put|delete|patch|use)\(\s*'([^']+)'/g;
  let r;
  while ((r = rre.exec(src))) {
    const method = r[1].toUpperCase();
    let p = mt.prefix + r[2];
    if (p !== '/' && p.endsWith('/')) p = p.slice(0, -1);
    routes.push({ method, path: p, file: mt.file });
  }
}
// router.js 内 router.use('/xxx', require(...)) 子挂载（本项目暂无，保留提示）
const routeSet = routes.filter(r => r.method !== 'USE');

/* ---------- 3. 前端 API 调用路径 ---------- */
const jsFiles = walk(PUB, []).filter(p => p.endsWith('.js') && !rel(p).includes('/vendor/'));
const calls = [];   // {file, path}
const cre = /(?:api\.(?:get|post|put|del)|request)\(\s*[`'"]([^`'"]+)[`'"]/g;
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  let c;
  while ((c = cre.exec(src))) {
    const p = c[1];
    if (!p.startsWith('/api')) continue;
    calls.push({ file: rel(f), path: p });
  }
}
function norm(p) { return p.replace(/\$\{[^}]*\}/g, ':x'); }
function matchRoute(p) {
  const n = norm(p);
  return routeSet.some(r => {
    const seg = r.path.split('/').filter(Boolean);
    const pseg = n.split('/').filter(Boolean);
    if (seg.length !== pseg.length) return false;
    return seg.every((s, i) => s.startsWith(':') || s === pseg[i] || pseg[i] === ':x');
  });
}
const unmatched = calls.filter(c => !matchRoute(c.path));

/* ---------- 输出 ---------- */
console.log('=== 1. HTML 引用的本地资源缺失 ===');
if (!missAsset.length) console.log('  （无）');
else missAsset.forEach(([f, r]) => console.log('  ✗', f, '->', r));

console.log('\n=== 2. server 路由总数：' + routeSet.length + '（挂载点 ' + mounts.length + '）===');
routes.filter(r => r.path.startsWith('MISSING-FILE')).forEach(r => console.log('  ✗ 挂载文件不存在:', r.file));

console.log('\n=== 3. 前端调用但后端无匹配路由 ===');
if (!unmatched.length) console.log('  （无）');
else [...new Set(unmatched.map(c => c.file + ' -> ' + c.path))].sort().forEach(x => console.log('  ✗', x));

console.log('\n=== 4. 后端路由（供人工核对）===');
routeSet.sort((a, b) => a.path.localeCompare(b.path)).forEach(r => console.log('  ' + r.method.padEnd(7) + r.path));
