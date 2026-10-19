'use strict';
/* 端到端页面巡检（v2）：用 API 登录拿 Cookie 注入浏览器，遍历页面收集 JS 报错 / 失败请求 */
const http = require('http');
const { chromium } = require('playwright');
const PORT = Number(process.env.E2E_PORT || 4400);
const BASE = 'http://127.0.0.1:' + PORT;

function req(method, p, body, cookie) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (cookie) headers['Cookie'] = cookie;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (e) { }
        resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'], body: j, raw: d });
      });
    });
    r.on('error', e => resolve({ status: 0, body: null, raw: e.message }));
    if (data) r.write(data);
    r.end();
  });
}
async function login(name, identity, password, student_id) {
  const r = await req('POST', '/api/auth/login', { real_name: name, identity, password, student_id });
  if (r.status !== 200) return { err: r.status + ' ' + (r.body && r.body.error || r.raw) };
  const kv = (r.setCookie || []).map(s => s.split(';')[0]).join('; ');
  return { cookie: kv, user: r.body.user, redirect: r.body.redirect };
}

const PAGES = [
  '/login.html', '/register.html', '/forgot.html', '/setup.html',
  '/ops.html', '/manager.html', '/user.html', '/fence.html',
  '/dataflow.html', '/privacy.html', '/theme-demo.html',
  '/demo-maintenance.html', '/reactivate-demo.html', '/favicon-preview.html'
];

async function walkPages(ctx, label) {
  const problems = [];
  const page = await ctx.newPage();
  let cur = BASE;
  page.on('console', (m) => { if (m.type() === 'error') problems.push(['console', cur, m.text().slice(0, 160)]); });
  page.on('pageerror', (e) => problems.push(['pageerror', cur, String(e.message).slice(0, 160)]));
  page.on('requestfailed', (r) => problems.push(['reqfail', cur, r.url() + ' :: ' + (r.failure() && r.failure().errorText)]));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(['http' + r.status(), cur, r.url()]); });

  console.log('\n===== 角色：' + label + ' =====');
  for (const p of PAGES) {
    cur = BASE + p;
    const before = problems.length;
    try {
      await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1800);
    } catch (e) { problems.push(['nav', BASE + p, e.message.slice(0, 120)]); }
    const added = problems.slice(before).filter(a => !(a[0] === 'http401' && a[2].includes('/api/auth/me')));
    console.log((added.length ? '  ✗ ' : '  ✓ ') + p + (added.length ? '  (' + added.length + ')' : ''));
    added.slice(0, 6).forEach(a => console.log('       [' + a[0] + '] ' + a[2]));
  }
  await page.close();
  return problems;
}

(async () => {
  const browser = await chromium.launch();

  const ops = await login('运维者', '运维者', 'Test@12345');
  if (ops.err) { console.log('运维者登录失败：', ops.err); process.exit(1); }
  console.log('运维者登录成功 →', ops.redirect, ' 权限等级', ops.user.role_level);
  const ctxOps = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctxOps.addCookies([{ name: 'token', value: ops.cookie.split('token=')[1].split(';')[0], domain: '127.0.0.1', path: '/' }]);
  const p1 = await walkPages(ctxOps, '运维者(ops)');

  console.log('\n=== 汇总问题数：' + p1.length + ' ===');
  p1.forEach(a => console.log('  [' + a[0] + '] ' + a[1] + ' | ' + a[2]));
  await browser.close();
})();
