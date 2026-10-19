'use strict';
/**
 * 出厂重置（仅保留运维者账号，删除其余全部账号与业务数据）。
 *
 * 行为：
 *  - 删除 users 表中所有非运维者账号，仅保留 role=ops 的账号；

 *  - 清空全部业务数据（活动/签到/活动范围/请假/补签/工单/授权/通知/数据流/审计等）；
 *  - 重置系统设置回出厂默认（仅保留迁移标记 rbac_clean_v1、user_id_text_v1，
 *    避免下次启动 db.js 的 cleanTestData 误删账号）；
 *  - 清理测试附件（data/uploads、data/mail-preview）；
 *  - 发件邮箱（SMTP/.env）配置不在数据库内，始终保留，本脚本不触碰。
 *
 * 运行：node server/factory-reset.js
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { DATA_DIR } = require('./config');

// 迁移标记：必须保留，否则下次启动会重跑清理/迁移，可能误删账号
const KEEP_SETTINGS = new Set(['rbac_clean_v1', 'user_id_text_v1']);

/* ----------------------------- 备份当前数据库（防误操作） ----------------------------- */
function backup() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `factory-reset-backup-${ts}`);
  let copied = 0;
  for (const f of ['app.db', 'app.db-wal', 'app.db-shm']) {
    const src = path.join(DATA_DIR, f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, `${base}-${f}`); copied++; }
  }
  return copied ? base : null;
}

/* ----------------------------- 清理目录内全部内容（测试附件等） ----------------------------- */
function clearDir(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    try { fs.rmSync(full, { recursive: true, force: true }); n++; } catch (e) { /* 忽略 */ }
  }
  return n;
}

/* ----------------------------- 主流程 ----------------------------- */
function main() {
  const before = {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    activities: db.prepare('SELECT COUNT(*) c FROM activities').get().c,
    checkins: db.prepare('SELECT COUNT(*) c FROM checkins').get().c,
    fences: db.prepare('SELECT COUNT(*) c FROM fences').get().c,
    dataflow: db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='data_flow'").get().c
      ? db.prepare('SELECT COUNT(*) c FROM data_flow').get().c : 0
  };

  const bak = backup();
  console.log(`[备份] ${bak ? '已备份至 ' + bak + '-app.db*' : '无现有数据库，跳过备份'}`);

  const tx = db.transaction(() => {
    // 1) 账号重置为出厂未激活态：保留身份（姓名/学号/身份/等级），清空认证与激活相关字段
    // 删除所有非运维者账号，仅保留 ops 角色
    db.prepare("DELETE FROM users WHERE role <> 'ops'").run();

    // 2) 清空全部业务表（保留 users 与 settings）
    const keep = new Set(['users', 'settings']);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all().map(r => r.name).filter(n => !keep.has(n));
    db.pragma('foreign_keys = OFF');
    tables.forEach(t => {
      try { db.prepare(`DELETE FROM "${t}"`).run(); } catch (e) { /* 忽略个别表的删除失败 */ }
    });
    db.pragma('foreign_keys = ON');
    try { db.prepare('DELETE FROM sqlite_sequence').run(); } catch (e) { /* 无自增表时忽略 */ }

    // 3) 重置系统设置回出厂默认：仅保留迁移标记（rbac_clean_v1 / user_id_text_v1）
    const rows = db.prepare('SELECT key FROM settings').all();
    rows.forEach(r => {
      if (!KEEP_SETTINGS.has(r.key)) db.prepare('DELETE FROM settings WHERE key = ?').run(r.key);
    });
  });
  tx();

  // 4) 清理测试附件、邮件预览与落盘邮件（含验证码原文，属测试数据）
  const clearedUploads = clearDir(path.join(DATA_DIR, 'uploads'));
  const clearedPreview = clearDir(path.join(DATA_DIR, 'mail-preview'));
  const clearedOutbox = clearDir(path.join(DATA_DIR, 'mail-outbox'));

  const after = {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    activities: db.prepare('SELECT COUNT(*) c FROM activities').get().c,
    checkins: db.prepare('SELECT COUNT(*) c FROM checkins').get().c,
    fences: db.prepare('SELECT COUNT(*) c FROM fences').get().c,
    dataflow: db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='data_flow'").get().c
      ? db.prepare('SELECT COUNT(*) c FROM data_flow').get().c : 0
  };

  console.log('==================================================');
  console.log('  出厂重置完成（保留账号与发件邮箱）');
  console.log('--------------------------------------------------');
  console.log(`  重置前：账号 ${before.users} | 活动 ${before.activities} | 签到 ${before.checkins} | 活动范围 ${before.fences} | 数据流 ${before.dataflow}`);
  console.log(`  重置后：账号 ${after.users} | 活动 ${after.activities} | 签到 ${after.checkins} | 活动范围 ${after.fences} | 数据流 ${after.dataflow}`);
  console.log(`  清理测试附件：${clearedUploads} 个 | 清理邮件预览：${clearedPreview} 个 | 清理落盘邮件：${clearedOutbox} 个`);
  console.log('--------------------------------------------------');
  console.log('  非运维者账号已全部删除，仅保留运维者账号。');
  console.log('');
  console.log('  发件邮箱（SMTP/.env）配置未改动，已保留。');
  console.log('  系统设置已恢复出厂默认（仅保留迁移标记）。');
  console.log('==================================================');

  // 落盘（把 WAL 合并回主库），避免下次读取不一致
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* 忽略 */ }
  try { db.close(); } catch (e) { /* 忽略 */ }
}

if (require.main === module) main();

module.exports = { main };
