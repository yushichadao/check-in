'use strict';
/**
 * 辅导员未激活（无密码）自动委托
 * ------------------------------------------------------------------
 * 辅导员（R3）账号未设置密码（未激活）时，将其管理类权限自动下放给其管理范围内
 * 层级最高、且为「管理岗」的合适下级（小班主任 R2 优先于班委 R1；普通学生不参与委托，
 * 避免把管理权下放给下属）。辅导员本人设置密码（激活）后自动收回。
 *
 * 委托以 permission_grants 记录承载，source='auto_delegate'，便于与手动授予区分与整体收回。
 */
const db = require('./db');
const A = require('./auth');
const { PERMS, ROLE_LEVEL } = require('./config');
const { recordEvent } = require('./logger');

/** 即便委托也不能下放的权限（系统级 / 高危 / 原始坐标 / 运维者隔离等） */
const EXCLUDE_PERMS = new Set([
  'SYS_MAINTENANCE', 'SYS_SETTINGS', 'AUTH_PRIVACY', 'AUTH_APPROVE_WO',
  'ACT_DELETE', 'VIEW_COORD',
  // 与「运维者隔离 / 系统级」同敏感度的账号与授权类高危权限：缺辅导员时也不应经自动委托下放给班委 / 小班主任，
  // 否则将获得「清除他人密码」「再向下授权」「终审覆盖」「查看审计」等越级能力。
  'AUTH_ACCOUNT', 'AUTH_GRANT', 'ADJ_FINAL', 'VIEW_AUDIT',
  'OPS_ACCOUNT', 'OPS_AUDIT_STREAM', 'OPS_MAINTENANCE', 'OPS_DEPLOY',
  'OPS_VERSION', 'OPS_DEVICES', 'OPS_EXPORT'
]);

/**
 * 选择受托人：在 counselor 管理范围内，取「在岗」管理岗中层级最高者（小班主任 > 班委）。
 * 仅考虑 role_level ∈ [cadre, assistant)，普通学生不参与委托。同层取 id 最小者，保证确定性。
 *
 * 「在岗」口径与 autocover 完全一致：未禁用、未注销、本人已设密码。
 * 预置但尚未激活的小班主任 / 辅导员无法登录，把权限委托给他们等于无人代管，
 * 只会在数据流里留下无意义的「自动委托」记录，故必须排除（可能辅导员与小班主任都未激活）。
 */
function pickDelegate(counselorId) {
  const ids = A.scopeIds(counselorId);
  if (!ids.length) return null;
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM users WHERE id IN (${ph}) AND role_level >= ? AND role_level < ?
       AND disabled = 0 AND status <> 'cancelled' AND password_hash IS NOT NULL
     ORDER BY role_level DESC, id ASC LIMIT 1`
  ).all(...ids, ROLE_LEVEL.cadre, ROLE_LEVEL.counselor);
  return rows.length ? rows[0] : null;
}

/** 计算应下放的权限集合：counselor 基线持有的常规管理权限，且非隔离 / 非危险排除项 */
function delegatePermsFor(counselor) {
  const out = [];
  Object.keys(PERMS).forEach(code => {
    const p = PERMS[code];
    if (!p || p.type === 'denied' || p.type === 'isolated') return;
    // 仅下放 counselor 基线范围内的管理权限（min 在 [0,3]）
    if (p.min === null || p.min > ROLE_LEVEL.counselor) return;
    if (EXCLUDE_PERMS.has(code)) return;
    if (A.hasPerm(counselor, code)) out.push(code);
  });
  return out;
}

/**
 * 受托人是否已通过「非 auto_delegate 来源」持有该权限（基线 / 手工下放 / 工单 / 自动代管）。
 * 必须排除 auto_delegate 自身的记录：A.hasPerm 与来源无关，若把上一轮委托写入的授权
 * 误判为「已持有」，差异比对会把它收回 → 下一轮又重新授予，形成震荡。
 */
function heldByOtherSource(user, code) {
  const p = PERMS[code];
  if (!p) return true;
  if (p.type === 'denied') return true;                                     // 恒拒绝：不需要也不允许委托
  if (typeof p.min === 'number' && A.userLevel(user) >= p.min) return true; // 角色基线天然持有
  const row = db.prepare(
    `SELECT 1 FROM permission_grants
     WHERE user_id = ? AND perm_code = ? AND revoked = 0 AND source <> 'auto_delegate'
       AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`
  ).get(user.id, code, Date.now());
  return !!row;
}

/** 该辅导员当前有效的自动委托记录 */
function currentDelegations(counselorId) {
  return db.prepare(
    `SELECT id, user_id, perm_code FROM permission_grants
     WHERE granted_by = ? AND source = 'auto_delegate' AND revoked = 0`
  ).all(counselorId);
}

/**
 * 自动委托（差异落库，幂等）。
 *
 * 切勿「先全撤、再全授」：本函数会被自动代管巡检（每 5 分钟）、启动、账号变更等反复调用，
 * 全撤再全授会让每一轮都写一对「收回自动委托 N 项」「自动委托管理权限」留痕，
 * 从而把数据流刷屏。故此处只对「真实差异」落库与留痕，无变化时完全静默。
 */
function autoDelegate(counselorId) {
  const counselor = db.prepare('SELECT * FROM users WHERE id = ?').get(counselorId);
  if (!counselor) return null;
  if (A.userLevel(counselor) !== ROLE_LEVEL.counselor) return null; // 仅辅导员
  if (counselor.password_hash) return null;                          // 已激活则不委托
  if (counselor.disabled || counselor.status === 'cancelled') return null;

  const delegate = pickDelegate(counselorId);
  if (!delegate) return null;

  // 目标集合：辅导员基线管理权限中，受托人尚未通过其它来源持有的部分
  const desiredCodes = delegatePermsFor(counselor).filter(code => !heldByOtherSource(delegate, code));
  const existing = currentDelegations(counselorId);

  const wanted = new Set(desiredCodes.map(code => `${delegate.id}|${code}`));
  const have = new Set(existing.map(r => `${r.user_id}|${r.perm_code}`));

  const toInsert = desiredCodes.filter(code => !have.has(`${delegate.id}|${code}`));
  const toRevoke = existing.filter(r => !wanted.has(`${r.user_id}|${r.perm_code}`));
  if (!toInsert.length && !toRevoke.length) return { delegate: delegate.id, count: 0 }; // 无变化：不落库、不留痕

  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO permission_grants (user_id, perm_code, granted_by, source, expires_at, revoked, created_at)
     VALUES (?, ?, ?, 'auto_delegate', NULL, 0, ?)`
  );
  const upd = db.prepare('UPDATE permission_grants SET revoked = 1, revoked_at = ? WHERE id = ? AND revoked = 0');
  db.transaction(() => {
    toRevoke.forEach(r => upd.run(now, r.id));
    toInsert.forEach(code => ins.run(delegate.id, code, counselor.id, now));
  })();

  if (toInsert.length) {
    recordEvent('auto_delegate', counselor.id, delegate.id,
      `辅导员「${counselor.real_name}」未激活，自动将 ${toInsert.length} 项管理权限委托给「${delegate.real_name}」（${delegate.role_title}）`);
  }
  if (toRevoke.length) {
    recordEvent('auto_delegate_revoke', counselor.id, null, `收回自动委托 ${toRevoke.length} 项权限`);
  }
  return { delegate: delegate.id, count: toInsert.length };
}

/** 收回某辅导员的所有自动委托（激活 / 注销时调用） */
function revokeAutoDelegate(counselorId) {
  const info = db.prepare(
    "UPDATE permission_grants SET revoked = 1, revoked_at = ? WHERE granted_by = ? AND source = 'auto_delegate' AND revoked = 0"
  ).run(Date.now(), counselorId);
  if (info.changes > 0) {
    recordEvent('auto_delegate_revoke', counselorId, null, `收回自动委托 ${info.changes} 项权限`);
  }
  return info.changes;
}

/** 全量巡检：未激活辅导员确保有委托；已激活辅导员清理残留委托。返回发生变更的辅导员数 */
function syncAutoDelegates() {
  let changed = 0;
  const unactivated = db.prepare(
    "SELECT id FROM users WHERE role_level = ? AND password_hash IS NULL AND disabled = 0 AND status <> 'cancelled'"
  ).all(ROLE_LEVEL.counselor);
  unactivated.forEach(c => { const r = autoDelegate(c.id); if (r && r.count > 0) changed += 1; });

  const all = db.prepare('SELECT id, password_hash FROM users WHERE role_level = ?').all(ROLE_LEVEL.counselor);
  all.forEach(c => {
    if (c.password_hash) { const n = revokeAutoDelegate(c.id); if (n > 0) changed += 1; }
  });
  return changed;
}

module.exports = { autoDelegate, revokeAutoDelegate, syncAutoDelegates, pickDelegate, delegatePermsFor };
