'use strict';
/**
 * 数据流撤回
 * ------------------------------------------------------------------
 * 撤回 = 逆转业务效果（若可逆） + 保留原记录并标记「已被谁/身份撤回」 + 新增一条撤回记录。
 * 可逆动作在此注册 reverser；不可逆动作仅标记留痕、不逆转。
 *
 * reverser 签名：(record) => { reversed: boolean, note: string }
 *   - record 为 data_flow 原始行（含 payload 前置快照 JSON 字符串）
 */
const db = require('./db');

const reversers = new Map();

function register(action, fn) { reversers.set(String(action), fn); }
function isReversible(action) { return reversers.has(String(action || '')); }

/** 安全解析 payload */
function parsePayload(rec) {
  try { return rec && rec.payload ? JSON.parse(rec.payload) : null; } catch (e) { return null; }
}

/* ------------------------------ 活动范围 ------------------------------ */

// 新建活动范围 → 删除该活动范围
register('fence_create', (rec) => {
  const p = parsePayload(rec) || {};
  const id = Number(p.id || rec.target_id);
  if (!id) return { reversed: false, note: '缺少活动范围 id，仅标记' };
  const used = db.prepare('SELECT COUNT(*) AS c FROM activities WHERE fence_id = ?').get(id).c;
  if (used > 0) return { reversed: false, note: `该活动范围已被 ${used} 个活动使用，未删除（仅标记）` };
  db.prepare('DELETE FROM fences WHERE id = ?').run(id);
  return { reversed: true, note: `已删除新建活动范围 #${id}` };
});

// 删除活动范围 → 按快照恢复
register('fence_delete', (rec) => {
  const p = parsePayload(rec) || {};
  const f = p.fence;
  if (!f) return { reversed: false, note: '无活动范围快照，仅标记' };
  const exists = db.prepare('SELECT id FROM fences WHERE id = ?').get(f.id);
  if (exists) return { reversed: false, note: '活动范围已存在，无需恢复' };
  db.prepare(`
    INSERT INTO fences (id, name, points_json, coord_system, offset_lng, offset_lat,
                        batch_key, batch_name, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(f.id, f.name, f.points_json, f.coord_system || 'GCJ-02', f.offset_lng || 0, f.offset_lat || 0,
    f.batch_key || null, f.batch_name || null, f.created_by || null,
    f.created_at || Date.now());
  return { reversed: true, note: `已恢复活动范围「${f.name}」` };
});

// 修改活动范围 → 还原修改前状态
register('fence_update', (rec) => {
  const p = parsePayload(rec) || {};
  const before = p.before;
  const id = Number(p.id || rec.target_id);
  if (!before || !id) return { reversed: false, note: '无前置快照，仅标记' };
  const exists = db.prepare('SELECT id FROM fences WHERE id = ?').get(id);
  if (!exists) return { reversed: false, note: '活动范围已不存在，无法还原' };
  db.prepare(`
    UPDATE fences SET name = ?, points_json = ?, batch_key = ?, batch_name = ?
    WHERE id = ?
  `).run(before.name, before.points_json, before.batch_key || null, before.batch_name || null, id);
  return { reversed: true, note: `已还原活动范围 #${id} 的修改` };
});

/* --------------------------- 账号（新增 / 注销） --------------------------- */

// 批量删除活动范围 → 按快照逐个恢复
register('fence_bulk_delete', (rec) => {
  const p = parsePayload(rec) || {};
  const list = p.fences || [];
  let n = 0;
  list.forEach(f => {
    if (!f || !f.id) return;
    if (db.prepare('SELECT id FROM fences WHERE id = ?').get(f.id)) return;
    db.prepare(`
      INSERT INTO fences (id, name, points_json, coord_system, offset_lng, offset_lat,
                          batch_key, batch_name, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(f.id, f.name, f.points_json, f.coord_system || 'GCJ-02', f.offset_lng || 0, f.offset_lat || 0,
      f.batch_key || null, f.batch_name || null, f.created_by || null,
      f.created_at || Date.now());
    n += 1;
  });
  return { reversed: n > 0, note: n > 0 ? `已恢复 ${n} 个活动范围` : '无需恢复（活动范围已存在）' };
});

// 新增账号 → 注销（软删）该账号
register('user_create', (rec) => {
  const p = parsePayload(rec) || {};
  const id = p.id || rec.target_id;
  if (!id) return { reversed: false, note: '缺少账号 id，仅标记' };
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return { reversed: false, note: '账号已不存在' };
  if (u.role === 'ops') return { reversed: false, note: '运维者账号不可被注销' };
  db.prepare("UPDATE users SET disabled = 1, status = 'cancelled' WHERE id = ?").run(id);
  // 撤回可能使某层级重新「无人在岗」→ 重算自动代管（失败不影响撤回本身）
  try { require('./autocover').safeSync('account_change'); } catch (e) { /* 忽略 */ }
  return { reversed: true, note: `已注销新增账号「${u.real_name}」` };
});

// 注销账号 → 恢复（撤回注销；保持原密码不变）
register('account_cancel', (rec) => {
  const id = rec.target_id || rec.subject_id;
  if (!id) return { reversed: false, note: '缺少账号 id，仅标记' };
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return { reversed: false, note: '账号已不存在' };
  if (u.role === 'ops') return { reversed: false, note: '运维者账号不可被操作' };
  db.prepare("UPDATE users SET disabled = 0, status = 'active', must_setup = 0 WHERE id = ?").run(id);
  // 恢复的账号若为上级且已设密码，则其已「到岗」→ 收回相应代管权限
  try { require('./autocover').safeSync('account_change'); } catch (e) { /* 忽略 */ }
  return { reversed: true, note: `已恢复账号「${u.real_name}」（原密码保持有效）` };
});

/* --------------------------- 补签 / 退签 / 代请假（撤回=标记留痕，不逆转业务效果） --------------------------- */

// 补签（管理员/班委代记为已签到）→ 仅标记撤回，不撤销签到状态
register('supplement', () => ({ reversed: false, note: '补签不可逆转，已在数据流中标记撤回留痕' }));

// 退签（撤销原签到）→ 仅标记撤回，不恢复签到状态
register('unsign', () => ({ reversed: false, note: '退签不可逆转，已在数据流中标记撤回留痕' }));

// 代请假（管理员/班委代记为请假）→ 仅标记撤回，不撤销请假状态
register('leave_by_admin', () => ({ reversed: false, note: '代请假不可逆转，已在数据流中标记撤回留痕' }));

/* ------------------------------ 执行 ------------------------------ */

/**
 * 执行撤回逆转（不写库标记，由调用方统一事务处理）。
 * @returns {{reversed:boolean, note:string}}
 */
function reverse(record) {
  const action = record && record.action;
  const fn = reversers.get(String(action));
  if (!fn) return { reversed: false, note: '该类型操作不可自动逆转，已标记撤回留痕' };
  try {
    const r = fn(record) || {};
    return { reversed: !!r.reversed, note: r.note || '' };
  } catch (e) {
    return { reversed: false, note: '逆转失败：' + (e.message || '未知错误') };
  }
}

module.exports = { register, isReversible, reverse, reversers };
