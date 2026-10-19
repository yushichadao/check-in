'use strict';
/* 一键初始化：清空全部业务数据与账号，仅重建单个运维者账号（id 000000，无密码，须注册页激活），
 * 恢复出厂系统设置（保留 settings 表），清理 uploads/mail-outbox/mail-preview，保留 .env。
 * 人性化前置确认：影响预览 → 键入「初始化」→ 运维者账号密码校验（防盗删；空白态无密码则跳过），且执行前自动备份。 */
const db = require('../server/db');
const cfg = require('../server/config');
const { ROLE_LEVEL } = cfg;
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) {
  return new Promise((res) => rl.question(q, (a) => res(a)));
}

function dataCounts() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const keep = new Set(['settings']);
  const out = {};
  tables.filter((t) => !keep.has(t)).forEach((t) => {
    try { out[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch (e) { out[t] = '?'; }
  });
  return out;
}

function clearAllBusiness() {
  const keep = new Set(['settings']);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).filter((n) => !keep.has(n));
  const tx = db.transaction(() => {
    db.pragma('foreign_keys = OFF');
    tables.forEach((t) => { try { db.prepare(`DELETE FROM "${t}"`).run(); } catch (e) { /* 忽略个别表 */ } });
    db.pragma('foreign_keys = ON');
    try { db.prepare('DELETE FROM sqlite_sequence').run(); } catch (e) { /* 无自增表时忽略 */ }
  });
  tx();
}

function recreateOps() {
  db.prepare(`INSERT INTO users (id, real_name, student_id, role_title, role, role_level, password_hash, must_change_pwd, created_at)
    VALUES ('000000', ?, NULL, ?, 'ops', ?, NULL, 0, ?)`)
    .run(cfg.OPS_INIT.real_name, cfg.OPS_INIT.identity, ROLE_LEVEL.ops, Date.now());
}

function backupDB() {
  const p = cfg.DB_PATH;
  if (!fs.existsSync(p)) return null;
  const dir = path.join(path.dirname(p), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `init-backup-${ts}-app.db`);
  fs.copyFileSync(p, dest);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(p + ext)) fs.copyFileSync(p + ext, dest + ext);
  }
  return dest;
}

function clearDirs() {
  for (const d of ['uploads', 'mail-outbox', 'mail-preview']) {
    const p = path.join(cfg.DATA_DIR, d);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
}

async function run() {
  console.log('\n========== 一键初始化（空白部署态）==========');
  console.log('⚠ 执行前请先停止服务（终止 node server/index.js），否则数据库可能被占用。');
  const c = dataCounts();
  console.log('\n即将清除的现有数据预览：');
  Object.keys(c).forEach((k) => console.log(`  ${k}: ${c[k]}`));

  const ans = (await ask('\n此操作将清空全部数据并重建运维者账号，且不可恢复（已自动备份可还原）。如需继续，请键入「初始化」：')).trim();
  if (ans !== '初始化') { console.log('已取消。'); rl.close(); return; }

  const ops = db.prepare("SELECT * FROM users WHERE role='ops' ORDER BY id").get();
  if (ops && ops.password_hash) {
    const pw = await ask('请输入运维者账号（id 000000）的登录密码以确认身份：');
    const ok = await bcrypt.compare(pw, ops.password_hash);
    if (!ok) { console.log('密码错误，已中止，未改动任何数据。'); rl.close(); return; }
  } else {
    console.log('（运维者账号尚未设置密码，跳过身份密码校验。）');
  }

  const bak = backupDB();
  console.log('已备份数据库至：' + bak);
  clearAllBusiness();
  recreateOps();
  clearDirs();
  console.log('\n✅ 初始化完成：已重建运维者账号（id 000000，未设密码）。');
  console.log('请重启服务（npm start），然后在注册页用「姓名 + 身份=运维者」完成邮箱验证并设置密码。');
  rl.close();
}

if (require.main === module) run();
module.exports = { run };
