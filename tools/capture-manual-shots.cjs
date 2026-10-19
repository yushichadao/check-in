'use strict';
/* 无头浏览器抓取说明书 / 官网配图（中性演示态 · 完整整页）：
 *   1) 启动服务并写入一套完整的「演示数据」（活动 / 签到 / 请假 / 补签 / 通知 / 工单 / 数据流）；
 *   2) 以演示账号登录三端，逐项切换菜单，等待数据加载完成后 **整页截图**（fullPage）；
 *   3) 截图写入 manual-shots/，另拷贝一份常用图到 site/assets/ 供官网使用。
 * 需 playwright + chromium 与可运行的数据库环境。用法：npm run shots
 *
 * 关键修复（相对旧版）：
 *   - 旧版 fullPage:false 只截首屏，内容高的页面被裁掉 —— 现改为 fullPage:true，绝不漏内容；
 *   - 旧版仅等 600/700ms，页面还在「加载中…」就截图 —— 现等待 networkidle + 无 .loading/「加载中」；
 *   - 旧版不造业务数据，活动 / 签到 / 审核列表全空 —— 现预置完整演示数据，界面状态真实。
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('../server/db');

const PORT = 3999;
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'manual-shots');
const SITE_ASSETS = path.join(ROOT, 'site', 'assets');
const BASE = `http://127.0.0.1:${PORT}/check-in`;

const PWD = 'Demo@123456';
// 演示坐标（GCJ-02）：校园矩形，避开真实部署点
const CAMPUS = [[120.1500, 30.2700], [120.1620, 30.2700], [120.1620, 30.2790], [120.1500, 30.2790]];
const IN_FENCE = { lng: 120.1560, lat: 30.2745 };
const OUT_FENCE = { lng: 120.2100, lat: 30.3100 };

const demoFenceIds = [];
const demoActivityIds = [];

function waitPort(port, timeout = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() - start > timeout) reject(new Error('服务启动超时'));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

// 各控制台的菜单分区（data-section），登录后逐一点击截图
const SECTIONS = {
  mgr: ['dashboard', 'publish', 'activity', 'fences', 'roster', 'review', 'accounts', 'calendar', 'workorders', 'notify', 'security', 'stream', 'msg', 'accountinfo', 'devices', 'about'],
  user: ['checkin', 'activities', 'stats', 'records', 'appeal', 'dataflow', 'msg', 'accountinfo', 'devices', 'about'],
  ops: ['dashboard', 'publish', 'activities', 'fences', 'roster', 'ops', 'accounts', 'calendar', 'workorders', 'security', 'stream', 'msg', 'accountinfo', 'devices', 'maintenance', 'about']
};
// 官网常用配图：manual-shots 文件名 -> site/assets 文件名
const SITE_PICK = {
  'mgr-dashboard': 'manager', 'user-checkin': 'user', 'mgr-fences': 'fence',
  'mgr-review': 'review', 'mgr-calendar': 'calendar', 'ops-dashboard': 'ops',
  'ops-security': 'security', 'user-appeal': 'appeal', 'ops-maintenance': 'maintenance',
  'register': 'register', 'login': 'login', 'privacy': 'privacy', 'mgr-activity': 'activity',
  'user-stats': 'stats', 'mgr-roster': 'roster', 'mgr-stream': 'stream',
  'user-records': 'records', 'mgr-accounts': 'accounts', 'mgr-workorders': 'workorders',
  'user-msg': 'msg', 'mgr-publish': 'publish', 'mgr-fence-editor': 'fence-editor'
};

const H = 3600 * 1000;
const now = Date.now();

/** 写入一套完整的演示数据（幂等性不要求：脚本每次运行前不清库，先删旧演示数据） */
function seedDemo() {
  const insUser = db.prepare(`INSERT OR REPLACE INTO users
    (id, real_name, student_id, role_title, role, role_level, password_hash, must_change_pwd, must_setup, clean_mode, email_verified, created_at)
    VALUES (@id, @real_name, @student_id, @role_title, @role, @role_level, @hash, 0, 0, 1, 1, @created_at)`);
  const mk = (id, name, sid, title, role, level, email, pwd = true) => {
    const hash = pwd ? bcrypt.hashSync(PWD, 10) : null;   // pwd=false → 账号未就位（未激活），用于演示「自动代管」
    insUser.run({ id, real_name: name, student_id: sid, role_title: title, role, role_level: level, hash, created_at: now });
    if (email) db.prepare('UPDATE users SET email=? WHERE id=?').run(email, id);
  };
  mk('demo-ops', '演示运维者', null, '运维者', 'ops', 9, 'ops@example.edu.cn');
  mk('demo-mgr', '演示辅导员', null, '辅导员', 'manager', 3, 'counselor@example.edu.cn');
  mk('demo-assist', '演示小班', null, '小班主任', 'manager', 2, null, false);  // 小班主任尚未就位 → 由班委自动代管
  mk('demo-cadre', '演示班委', null, '班委', 'manager', 1, null);
  mk('demo-stu', '演示学生', '20210701', '普通学生', 'normal', 0, 'student@example.edu.cn');
  const stuNames = ['赵一', '钱二', '孙三', '李四', '周五', '吴六', '郑七', '王八', '冯九', '陈十'];
  stuNames.forEach((n, i) => mk('demo-stu-' + i, n, '2021070' + (i + 2), '普通学生', 'normal', 0, null));
  const allStu = ['demo-stu'].concat(stuNames.map((_, i) => 'demo-stu-' + i));

  // 活动范围
  const fid = db.prepare(`INSERT INTO fences (name, points_json, coord_system, offset_lng, offset_lat, batch_key, batch_name, created_by, created_at)
    VALUES (?, ?, 'GCJ-02', 0, 0, NULL, NULL, 'demo-mgr', ?)`)
    .run('教学楼范围内', JSON.stringify(CAMPUS), now).lastInsertRowid;
  demoFenceIds.push(fid);

  // 活动：进行中 / 已结束 / 未开始
  const insAct = db.prepare(`INSERT INTO activities
    (title, start_time, end_time, fence_id, policy, offset_minutes, recurring, group_key, parent_id, is_group, remark, location, dest_lng, dest_lat, creator_id, created_at)
    VALUES (@title, @start_time, @end_time, @fence_id, 'before_end', 60, 0, NULL, NULL, 0, @remark, @location, @dest_lng, @dest_lat, 'demo-mgr', @created_at)`);
  const addAct = (a) => { const id = insAct.run(Object.assign({ fence_id: fid, remark: null, dest_lng: IN_FENCE.lng, dest_lat: IN_FENCE.lat, created_at: now }, a)).lastInsertRowid; demoActivityIds.push(id); return id; };
  const actCur = addAct({ title: '晚间自习签到', start_time: now - 20 * 60 * 1000, end_time: now + 70 * 60 * 1000, location: '第三教学楼 301', remark: '请按时到班，迟到请在备注说明。' });
  const actPast = addAct({ title: '上周班会', start_time: now - 26 * H, end_time: now - 25 * H, location: '第三教学楼 305', remark: '班会考勤。' });
  const actPast2 = addAct({ title: '实验课签到', start_time: now - 50 * H, end_time: now - 49 * H, location: '实验楼 B205', remark: null });
  const actNext = addAct({ title: '明日早操', start_time: now + 20 * H, end_time: now + 21 * H, location: '东区体育场', remark: '早操集合。' });

  // 签到记录（进行中活动：多数已签，含范围内/外、在途、请假）
  const insCk = db.prepare(`INSERT OR REPLACE INTO checkins (activity_id, user_id, status, in_fence, ip, device_id, manual, handler_id, lat, lng, accuracy, created_at)
    VALUES (?, ?, ?, ?, '127.0.0.1', NULL, 0, NULL, ?, ?, 15, ?)`);
  allStu.forEach((u, i) => {
    if (i === 0) insCk.run(actCur, u, 'signed', 1, IN_FENCE.lat, IN_FENCE.lng, now - 10 * 60 * 1000);
    else if (i === 1) insCk.run(actCur, u, 'signed', 0, OUT_FENCE.lat, OUT_FENCE.lng, now - 9 * 60 * 1000);
    else if (i === 2) insCk.run(actCur, u, 'ontheway', 1, IN_FENCE.lat, IN_FENCE.lng, now - 8 * 60 * 1000);
    else if (i === 3) insCk.run(actCur, u, 'leave', null, null, null, now - 7 * 60 * 1000);
    else if (i < 8) insCk.run(actCur, u, 'signed', 1, IN_FENCE.lat, IN_FENCE.lng, now - (6 - i) * 60 * 1000);
    // i>=8 未签到（缺勤候选人）
  });
  // 已结束活动：多数缺勤，少量签到 —— 形成报告/记录/缺勤数据
  allStu.forEach((u, i) => {
    if (i % 3 === 0) insCk.run(actPast, u, 'signed', 1, IN_FENCE.lat, IN_FENCE.lng, now - 25 * H);
    if (i % 4 === 0) insCk.run(actPast2, u, 'signed', 1, IN_FENCE.lat, IN_FENCE.lng, now - 49 * H);
  });

  // 请假 / 补签 / 申诉
  const insLeave = db.prepare(`INSERT INTO leave_requests
    (activity_id, user_id, reason, by_admin, handler_id, status, is_appeal, location, reply, locked, appealed, created_at, handled_at)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 0, 0, ?, ?)`);
  insLeave.run(actCur, 'demo-stu-3', '身体不适，申请请假一次。', null, 'pending', 0, '第三教学楼 301', null, now - 6 * 60 * 1000, null);
  insLeave.run(actPast, 'demo-stu-4', '家中有事，事后请假。', 'demo-mgr', 'approved', 1, null, '已核实，准假。', now - 24 * H, now - 23 * H);
  insLeave.run(actPast, 'demo-stu-5', '临时请假。', 'demo-mgr', 'rejected', 0, null, '未提前说明，不予准假。', now - 24 * H, now - 23 * H);

  const insMk = db.prepare(`INSERT INTO makeup_requests (activity_id, user_id, reason, status, handler_id, reply, created_at, handled_at, location, locked, appealed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`);
  insMk.run(actPast, 'demo-stu-6', '当天网络异常未能签到，申请补签。', 'pending', null, null, now - 20 * H, null, null);
  insMk.run(actPast2, 'demo-stu-7', '迟到未赶上签到，申请补签。', 'approved', 'demo-mgr', '已核实到场，予以补签。', now - 40 * H, now - 39 * H, null);

  // 通知 / 工单 / 找回密码 / 数据流
  const insN = db.prepare(`INSERT INTO notifications (user_id, level, kind, title, body, ref_type, ref_id, created_at, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insN.run('demo-stu', 'info', 'NT_CHECKIN_START', '签到开始提醒', '「晚间自习签到」已开始，请及时签到。', 'activity', actCur, now - 20 * 60 * 1000, null);
  insN.run('demo-stu', 'info', 'NT_RECEIPT', '补签受理回执', '你的补签申请已提交，等待管理员审核。', 'makeup', null, now - 19 * 60 * 1000, null);
  insN.run('demo-stu', 'info', 'NT_SYS_MSG', '系统消息', '欢迎使用班级签到系统。', null, null, now - 2 * H, now - 1 * H);
  insN.run('demo-mgr', 'info', 'NT_SYS_MSG', '系统消息', '本周有 3 条待审核事项。', null, null, now - 3 * H, null);

  const insWo = db.prepare(`INSERT INTO work_orders (applicant_id, perm_code, kind, reason, approver_ids, status, handler_id, reply, granted_until, created_at, handled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insWo.run('demo-cadre', 'VIEW_DATAFLOW', 'perm', '需要查看本班操作记录以便核对考勤。', 'demo-mgr', 'pending', null, null, null, now - 5 * H, null);
  insWo.run('demo-assist', 'SYS_SETTINGS', 'info', '申请调整本班签到时间窗口默认值。', 'demo-mgr', 'pending', null, null, null, now - 4 * H, null);
  insWo.run('demo-stu-8', 'STU_SELF', 'info', '姓名登记有误，申请更正为「陈拾」。', 'demo-mgr', 'pending', null, null, null, now - 3 * H, null);

  const insPwd = db.prepare(`INSERT INTO pwd_resets (user_id, requester_name, handled_by, status, created_at) VALUES (?, ?, NULL, 'pending', ?)`);
  insPwd.run('demo-stu-9', '陈十', now - 2 * H);

  const insDf = db.prepare(`INSERT INTO data_flow (category, action, actor_id, actor_name, subject_id, target_id, target, detail, channel, encrypted, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`);
  const dfRows = [
    ['activity', 'ACT_CREATE', 'demo-mgr', '演示辅导员', null, actCur, '晚间自习签到', '创建活动「晚间自习签到」', 'inbox', now - 30 * 60 * 1000],
    ['notify', 'CHECKIN_START', 'demo-mgr', '演示辅导员', 'demo-stu', actCur, '演示学生', '发送签到开始提醒', 'both', now - 20 * 60 * 1000],
    ['appeal', 'LEAVE_APPLY', 'demo-stu-3', '孙三', 'demo-stu-3', actCur, '孙三', '提交请假申请', 'inbox', now - 6 * 60 * 1000],
    ['auth', 'LOGIN', 'demo-mgr', '演示辅导员', null, null, null, '管理员登录', 'none', now - 40 * 60 * 1000],
    ['workorder', 'WO_SUBMIT', 'demo-cadre', '演示班委', 'demo-cadre', null, '演示班委', '提交权限申请工单', 'both', now - 5 * H],
    ['mail', 'MAIL_SEND', null, '系统', 'demo-stu', null, 'student@example.edu.cn', '发送补签受理回执邮件', 'email', now - 19 * 60 * 1000]
  ];
  dfRows.forEach(r => insDf.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9]));

  // 设置：开启活动范围核验（呈现“已启用”的真实状态）
  db.prepare("INSERT INTO settings (key, value) VALUES ('location_verify_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();

  return { allStu, actCur, actPast, actNext };
}

function cleanDemo() {
  try {
    const ph = demoActivityIds.length ? demoActivityIds.map(() => '?').join(',') : 'NULL';
    db.prepare(`DELETE FROM checkins WHERE user_id LIKE 'demo-%' OR activity_id IN (${ph})`).run(...demoActivityIds);
    db.prepare(`DELETE FROM leave_requests WHERE user_id LIKE 'demo-%' OR activity_id IN (${ph})`).run(...demoActivityIds);
    db.prepare(`DELETE FROM makeup_requests WHERE user_id LIKE 'demo-%' OR activity_id IN (${ph})`).run(...demoActivityIds);
    db.prepare("DELETE FROM notifications WHERE user_id LIKE 'demo-%'").run();
    db.prepare("DELETE FROM work_orders WHERE applicant_id LIKE 'demo-%'").run();
    db.prepare("DELETE FROM pwd_resets WHERE user_id LIKE 'demo-%'").run();
    db.prepare("DELETE FROM data_flow WHERE actor_id LIKE 'demo-%' OR subject_id LIKE 'demo-%'").run();
    db.prepare("DELETE FROM sessions WHERE user_id LIKE 'demo-%'").run();
    db.prepare(`DELETE FROM activities WHERE id IN (${ph})`).run(...demoActivityIds);
    if (demoFenceIds.length) db.prepare(`DELETE FROM fences WHERE id IN (${demoFenceIds.map(() => '?').join(',')})`).run(...demoFenceIds);
    db.prepare("DELETE FROM permission_grants WHERE user_id LIKE 'demo-%'").run();
    db.prepare("DELETE FROM data_flow WHERE action LIKE 'auto_cover%'").run();   // 清掉自动代管诊断残留（actor_id 为 NULL，普通 demo-% 清理漏删）
    db.prepare("DELETE FROM users WHERE id LIKE 'demo-%'").run();
    db.prepare("UPDATE users SET password_hash=NULL, must_change_pwd=0, email_verified=0, session_id=NULL WHERE role='ops' AND id NOT LIKE 'demo-%'").run();
  } catch (e) { /* 忽略清理失败 */ }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // 中性演示态
  process.env.GROUP_NAME = '通信工程2607班';
  process.env.OPS_NAME = '运维者';
  process.env.PORT = String(PORT);
  process.env.SMTP_HOST = 'smtp.example.edu.cn';
  process.env.SMTP_PORT = '465';
  process.env.SMTP_SECURE = 'true';
  process.env.SMTP_USER = 'noreply@example.edu.cn';
  process.env.SMTP_PASS = 'demo-auth-code';
  process.env.MAIL_FROM = 'noreply@example.edu.cn';
  process.env.FEEDBACK_EMAIL = 'noreply@example.edu.cn';

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: process.env, cwd: ROOT, stdio: 'inherit'
  });

  let browser;
  try {
    await waitPort(PORT);
    // 先清掉上一次可能残留的演示数据，再写入全新演示数据
    cleanDemo();
    const ctx = seedDemo();
    // 运维者登录账号名沿用配置（OPS_NAME）；同时把演示运维者命名为「运维者」以匹配配置
    db.prepare("UPDATE users SET real_name=? WHERE id='demo-ops'").run(process.env.OPS_NAME);
    db.prepare("UPDATE users SET password_hash=?, must_change_pwd=0, must_setup=0, email_verified=1, session_id=NULL WHERE role='ops' AND id NOT LIKE 'demo-%'").run(bcrypt.hashSync(PWD, 10));

    // 自动代管演示：小班主任（演示小班）未就位（上一步未设密码）→ 由班委（演示班委）自动代管，
    // 数据流产生一条「自动代管授予」真实记录（而非反复刷屏的「未执行」）。失败不影响截图。
    try { require('../server/autocover').safeSync('account_change'); } catch (e) { /* 忽略 */ }

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1.5,
      geolocation: { latitude: IN_FENCE.lat, longitude: IN_FENCE.lng },
      permissions: ['geolocation']
    });
    const page = await context.newPage();

    async function loginAs(cred) {
      try {
        const r = await fetch(BASE + '/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cred)
        });
        const j = await r.json().catch(() => ({}));
        const sc = r.headers.get('set-cookie');
        if (j && j.ok && sc) {
          const first = sc.split(';')[0];
          const eq = first.indexOf('=');
          return { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() };
        }
        console.log('登录失败', cred.identity, JSON.stringify({ status: r.status, body: j }));
      } catch (e) { console.log('登录异常', cred.identity, e.message); }
      return null;
    }
    async function setCookie(ck) {
      if (ck) await context.addCookies([{ name: ck.name, value: ck.value, domain: '127.0.0.1', path: '/', secure: false }]);
    }
    async function goto(pathname) {
      await page.goto(BASE + pathname, { waitUntil: 'load' });
      await seeLoad();
    }
    // 等待页面数据加载完成：networkidle + 无 .loading 旋转器 + 正文不含「加载中」
    async function seeLoad() {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForFunction(() => {
        if (document.querySelector('.loading, .spin')) return false;
        const t = (document.body && document.body.innerText) || '';
        return !/加载中|正在加载/.test(t);
      }, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
    async function shot(name) {
      try { await page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 4000 }); } catch (e) { /* 忽略 */ }
      await seeLoad();
      // 触发懒加载图片 / 地图：滚到底再回顶
      await page.evaluate(async () => {
        const h = document.body.scrollHeight;
        for (let y = 0; y < h; y += 500) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); }
        window.scrollTo(0, 0);
      }).catch(() => {});
      await page.waitForTimeout(400);
      const file = path.join(SHOTS, name + '.png');
      await page.screenshot({ path: file, fullPage: true });
      console.log('截图：', name + '.png');
    }

    // 公共页（不登录）
    for (const [name, url] of [['login', '/login.html'], ['register', '/register.html'], ['privacy', '/privacy.html'], ['forgot', '/forgot.html']]) {
      try { await context.clearCookies(); await goto(url); await shot(name); }
      catch (e) { console.warn('截图失败', name, e.message); }
    }

    const AUTH = {
      mgr: { real_name: '演示辅导员', identity: '辅导员', password: PWD },
      user: { real_name: '演示学生', identity: '普通学生', student_id: '20210701', password: PWD },
      ops: { real_name: process.env.OPS_NAME, identity: '运维者', password: PWD }
    };
    const CONSOLE_PAGE = { mgr: '/manager.html', user: '/user.html', ops: '/ops.html' };

    for (const key of ['mgr', 'user', 'ops']) {
      try {
        await context.clearCookies();
        const ck = await loginAs(AUTH[key]);
        await setCookie(ck);
        await goto(CONSOLE_PAGE[key]);
        for (const sec of SECTIONS[key]) {
          try {
            await page.click(`.nav-item[data-section="${sec}"]`, { timeout: 5000 });
            await page.waitForTimeout(500);
            await shot(`${key}-${sec}`);
          } catch (e) { console.warn('菜单截图失败', key, sec, e.message); }
        }
        if (key === 'mgr' || key === 'ops') {
          try {
            await page.click(`.nav-item[data-section="fences"]`, { timeout: 5000 });
            await page.waitForTimeout(500);
            const btn = await page.$('#fenceNew');
            if (btn) { await btn.click({ timeout: 5000 }); await page.waitForTimeout(1000); await shot(`${key}-fence-editor`); }
          } catch (e) { console.warn('活动范围编辑器截图失败', key, e.message); }
        }
      } catch (e) { console.warn('控制台截图失败', key, e.message); }
    }

    // 拷贝官网常用配图
    try {
      fs.mkdirSync(SITE_ASSETS, { recursive: true });
      Object.keys(SITE_PICK).forEach((k) => {
        const src = path.join(SHOTS, k + '.png');
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SITE_ASSETS, SITE_PICK[k] + '.png'));
      });
      console.log('已同步官网配图到 site/assets/');
    } catch (e) { console.warn('同步官网配图失败', e.message); }
  } catch (e) {
    console.error('抓取过程出错：', e.message);
  } finally {
    cleanDemo();
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
  console.log('配图已保存到 manual-shots/ 并同步 site/assets/。');
})().catch((e) => { console.error(e); process.exit(1); });
