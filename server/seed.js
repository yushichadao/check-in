'use strict';
const db = require('./db');
const { DEFAULT_FENCE, OPS_INIT, ROLE_LEVEL } = require('./config');

/**
 * 只内置「真实必要」的初始数据，避免测试数据造成混乱：
 *  - 默认活动范围（真实教学区坐标）
 *  - 初始运维者账号（不预置密码，需注册页邮箱验证后激活）
 * 管理员与普通学生一律由运维端 / 管理端按需创建，不再预置任何其它账号与示例活动。
 */

/**
 * 默认活动范围：**只在全新空库首次初始化时写入**（且仅当 DEFAULT_FENCE 配置了坐标）。
 *
 * 旧逻辑「只要 fences 表为空就补建」，会带来两个副作用：
 *   1. 出厂重置 / `npm run factory-reset` 清空数据后，服务一启动又把默认范围塞回来，
 *      出厂态根本保持不住；
 *   2. 管理员主动删除全部活动范围后，重启又被系统悄悄补回。
 * 故改为仅在「本次刚创建初始运维者账号」时写入，其余情况一律不干预。
 * DEFAULT_FENCE 已通用化为空，默认不预置任何活动范围，交由运维者自行创建。
 */
function ensureFence(freshDb) {
  if (!freshDb) return;
  if (!DEFAULT_FENCE || !DEFAULT_FENCE.length) return;
  const c = db.prepare('SELECT COUNT(*) AS c FROM fences').get().c;
  if (c) return;
  const dev = db.prepare("SELECT id FROM users WHERE role = 'ops' ORDER BY id LIMIT 1").get();
  db.prepare(`
    INSERT INTO fences (name, points_json, coord_system, offset_lng, offset_lat, created_by, created_at)
    VALUES (?, ?, 'GCJ-02', 0, 0, ?, ?)
  `).run('默认活动范围', JSON.stringify(DEFAULT_FENCE), dev ? dev.id : null, Date.now());
}

/**
 * 确保初始运维者账号存在（**幂等**）。
 * 返回值语义严格区分「新建」与「仅迁移」，避免重复执行时打印「已创建」造成误导：
 *   { created: true }  本次真正插入了账号；
 *   { migrated: true } 账号已存在，仅做了等级补齐 / 姓名同步（不预置密码）；
 *   null               已存在且无需任何变更。
 */
function ensureOps() {
  const existing = db.prepare("SELECT * FROM users WHERE role = 'ops' ORDER BY id").get();
  if (existing) {
    let migrated = false;
    // 补齐 RBAC 等级（历史库迁移）
    if (existing.role_level === null || existing.role_level === undefined) {
      db.prepare('UPDATE users SET role_level = ? WHERE id = ?').run(ROLE_LEVEL.ops, existing.id);
      migrated = true;
    }
    // 迁移：把默认的初始运维者账号同步为环境变量/配置中指定的账号
    const target = db.prepare("SELECT id FROM users WHERE role = 'ops' AND real_name = ?").get(OPS_INIT.real_name);
    if (!target && existing.real_name !== OPS_INIT.real_name) {
      // 仅同步姓名，绝不预置密码（运维者同样需走注册页完成邮箱验证）
      db.prepare('UPDATE users SET real_name = ?, session_id = NULL WHERE id = ?')
        .run(OPS_INIT.real_name, existing.id);
      migrated = true;
    }
    return migrated ? { migrated: true } : null;
  }
  // 不预置密码：password_hash 留空 = 未激活，须在注册页完成邮箱验证并自行设置密码
  db.prepare(`
    INSERT INTO users (id, real_name, student_id, role_title, role, role_level, password_hash, must_change_pwd, created_at)
    VALUES ('000000', ?, NULL, ?, 'ops', ?, NULL, 0, ?)
  `).run(OPS_INIT.real_name, OPS_INIT.identity, ROLE_LEVEL.ops, Date.now());
  return { created: true };
}

function ensure() {
  // 幂等顺序：先确保运维者存在，再建默认活动范围 —— 否则活动范围的 created_by
  // 在「全新库」上会因为运维者尚未创建而落成 NULL。
  const dev = ensureOps();
  ensureFence(!!(dev && dev.created));   // 仅全新库写入默认活动范围
  if (dev && dev.created) {
    console.log('==================================================');
    console.log('  已创建初始运维者账号（未设置密码）');
    console.log(`  姓名：${OPS_INIT.real_name}`);
    console.log(`  身份：${OPS_INIT.identity}（学号留空）`);
    console.log('  请打开注册页，按「姓名 + 身份」填写并获取邮箱验证码，');
    console.log('  完成邮箱验证并设置密码后即可登录。');
    console.log('==================================================');
  }
  return { created: !!(dev && dev.created), migrated: !!(dev && dev.migrated) };
}

function reset() {
  const tx = db.transaction(() => {
    // 动态清空所有业务表（保留 settings 系统配置），避免漏删后续新增的表
    const keep = new Set(['settings']);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all().map(r => r.name).filter(n => !keep.has(n));
    db.pragma('foreign_keys = OFF');
    tables.forEach(t => {
      try { db.prepare(`DELETE FROM "${t}"`).run(); } catch (e) { /* 忽略个别表的删除失败 */ }
    });
    db.pragma('foreign_keys = ON');
    try { db.prepare('DELETE FROM sqlite_sequence').run(); } catch (e) { /* 无自增表时忽略 */ }
  });
  tx();
  ensure();
  console.log('数据库已重置并重新写入初始数据');
}

if (require.main === module) {
  if (process.argv.includes('--reset')) reset();
  else ensure();
}

module.exports = { ensure, reset };
