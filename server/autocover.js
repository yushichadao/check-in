'use strict';
/**
 * 自动代管（缺上级自动补位）
 * ------------------------------------------------------------------
 * 背景：班级里小班主任（R2）/辅导员（R3）常常尚未就位，事务全压在班委（R1）身上。
 * 机制：当某一管理层级**整体不存在「可用」账号**时，由下一级在岗管理岗临时代行该层级的基线权力；
 *       上级一旦到岗（本人设密激活 / 预置 / 恢复 / 清除密码后重新激活等），代管立即失效并通知。
 *
 * 设计要点：
 *   1) 唯一编排入口：所有触发方（账号变更、设密激活、开关切换、启动、巡检）都只调用 syncAutoCover，
 *      由它做「全量重算 + 差异落库」，因此天然幂等、可自愈，且重复触发不会产生重复授权 / 重复通知。
 *   2) 授权即落库：以 permission_grants(source='auto_cover') 承载，auth.hasPerm 本就是实时查库，
 *      故收回后**无需重新登录、无需踢会话**立即生效。
 *   3) 与既有 delegate.js 协同：delegate 处理「辅导员存在但未激活 → 委托给范围内最高下级」；
 *      本模块处理「层级整体不可用」。计算缺口时先扣除已被其它来源（含 auto_delegate）覆盖的权限，
 *      避免同一权限在同一人身上出现两条来源、或被重复授给两个人。
 *   4) 永不涉及：isolated（隐私文案 / 维护开关 / 7 项 OPS_*）、denied（查看原始坐标）、
 *      inherent（学生固有）、以及非基线的 VIEW_STUDENT_LOCATION（min=9）。
 *   5) 代管所得权限不可再向下授权（见 heldOnlyByAutoCover，供 permissions 路由校验）。
 *
 * 「可用」的唯一口径（全模块统一）：未禁用、未注销、本人已设密码（即已激活到岗）。
 */
const db = require('./db');
const A = require('./auth');
const St = require('./settings');
const { PERMS, ROLE_LEVEL } = require('./config');
const { recordEvent } = require('./logger');

/** permission_grants.source 取值：与手工下放(grant)/工单(workorder)/未激活委托(auto_delegate)区分 */
const SOURCE = 'auto_cover';

/** 即便在缺口层级也不代管的权限（非基线能力，须由辅导员及以上显式授予） */
const NEVER_COVER = new Set(['VIEW_STUDENT_LOCATION']);

/** 代管层级：r2 = 小班主任层，r3 = 辅导员层 */
const LEVEL_OF = { r2: ROLE_LEVEL.assistant, r3: ROLE_LEVEL.counselor };
const LEVEL_KEYS = ['r2', 'r3'];
/** 权限码 → 它属于哪一层（min<=2 为 r2，其余为 r3）；仅用于通知文案归类 */
function levelOfPerm(code) {
  const p = PERMS[code];
  return (p && typeof p.min === 'number' && p.min <= ROLE_LEVEL.assistant) ? 'r2' : 'r3';
}

function levelName(level) {
  return level === 'r2' ? '小班主任' : '辅导员';
}

/* ===================== 权限集推导（纯函数，供测试与设置页复用） ===================== */

/**
 * 某层级的「基线权限集」：类型为 regular / high_risk，且基线阈值 min 不超过该层级。
 * 排除 isolated / denied / inherent（三者在 PERMS 与 STUDENT_PERMS / OPS_PERMS 中已由 type 区分）
 * 与非基线的 VIEW_STUDENT_LOCATION。
 * @param {'r2'|'r3'} level
 * @returns {string[]}
 */
function permSetFor(level) {
  const lv = LEVEL_OF[level];
  if (!lv) return [];
  return Object.keys(PERMS).filter(code => {
    const p = PERMS[code];
    if (!p) return false;
    if (p.type !== 'regular' && p.type !== 'high_risk') return false;   // 排除 isolated/denied/inherent
    if (typeof p.min !== 'number' || p.min > lv) return false;
    if (NEVER_COVER.has(code)) return false;
    return true;
  });
}

/* ===================== 在岗判定与补位者选择 ===================== */

/** 该层级是否存在「可用」账号（未禁用、未注销、已设密码） */
function hasAvailable(level) {
  const lv = LEVEL_OF[level];
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM users
    WHERE role_level = ? AND disabled = 0 AND status <> 'cancelled' AND password_hash IS NOT NULL
  `).get(lv);
  return (row && row.n) > 0;
}

/** 全部可用班委（代管的默认补位者） */
function availableCadres() {
  return db.prepare(`
    SELECT * FROM users
    WHERE role_level = ? AND disabled = 0 AND status <> 'cancelled' AND password_hash IS NOT NULL
    ORDER BY id
  `).all(ROLE_LEVEL.cadre);
}

/** 全部可用小班主任 */
function availableAssistants() {
  return db.prepare(`
    SELECT * FROM users
    WHERE role_level = ? AND disabled = 0 AND status <> 'cancelled' AND password_hash IS NOT NULL
    ORDER BY id
  `).all(ROLE_LEVEL.assistant);
}

/* ===================== 状态查询 ===================== */

/** 当前缺口层级（两层独立判定） */
function currentGaps() {
  const gaps = [];
  if (!hasAvailable('r2')) gaps.push('r2');
  if (!hasAvailable('r3')) gaps.push('r3');
  return gaps;
}

/** 某账号当前的代管状态（供前端展示与「不可再下放」校验） */
function stateOf(userId) {
  const rows = db.prepare(`
    SELECT perm_code, created_at FROM permission_grants
    WHERE user_id = ? AND source = ? AND revoked = 0
    ORDER BY created_at
  `).all(userId, SOURCE);
  if (!rows.length) return { covered: false };
  const levels = [...new Set(rows.map(r => levelOfPerm(r.perm_code)))].sort();
  return {
    covered: true,
    level: levels[levels.length - 1],                                  // 最高覆盖层级
    levels,
    perms: rows.map(r => r.perm_code),
    since: rows[0].created_at
  };
}

/**
 * 该权限是否由「基线或非代管来源」持有（即不需要代管补充）。
 *
 * 必须排除 source='auto_cover' 自身的记录：
 *   A.hasPerm 是 source 无关的，若直接用它做「只补差额」过滤，会把上一轮代管刚写入的授权
 *   误判为「已持有」→ 差额为空 → 差异比对随即把它们全部收回 → 下一轮又重新授予，
 *   形成「授予 / 收回」反复震荡（实测日志中 27 granted 与 27 revoked 交替）。
 */
function heldByOtherSource(user, code) {
  const p = PERMS[code];
  if (!p) return true;
  if (p.type === 'denied') return true;                                        // 恒拒绝：不需要也不允许代管
  if (typeof p.min === 'number' && A.userLevel(user) >= p.min) return true;    // 角色基线天然持有
  const row = db.prepare(`
    SELECT 1 FROM permission_grants
    WHERE user_id = ? AND perm_code = ? AND revoked = 0 AND source <> ?
      AND (expires_at IS NULL OR expires_at > ?) LIMIT 1
  `).get(user.id, code, SOURCE, Date.now());
  return !!row;                                                               // 手工下放 / 工单 / 未激活委托
}

/** 该账号是否「仅因自动代管而持有」某权限（基线不持有、且无其它来源的有效授予） */
function heldOnlyByAutoCover(user, code) {
  if (!user || !code) return false;
  const p = PERMS[code];
  if (!p) return false;
  if (p.type === 'denied') return true;
  if (typeof p.min === 'number' && A.userLevel(user) >= p.min) return false;   // 基线持有 → 可正常下放
  const other = db.prepare(`
    SELECT 1 FROM permission_grants
    WHERE user_id = ? AND perm_code = ? AND revoked = 0 AND source NOT IN (?, ?)
      AND (expires_at IS NULL OR expires_at > ?) LIMIT 1
  `).get(user.id, code, SOURCE, 'auto_delegate', Date.now());
  if (other) return false;                                                     // 手工下放 / 工单 / 未激活委托
  const mine = db.prepare(`
    SELECT 1 FROM permission_grants
    WHERE user_id = ? AND perm_code = ? AND revoked = 0 AND source IN (?, ?) LIMIT 1
  `).get(user.id, code, SOURCE, 'auto_delegate');
  return !!mine;
}

/** 概览（给运维端状态卡 / 系统设置页） */
function describe() {
  const gaps = currentGaps();
  const rows = db.prepare(`
    SELECT user_id, perm_code FROM permission_grants WHERE source = ? AND revoked = 0
  `).all(SOURCE);
  const agents = new Set(rows.map(r => r.user_id));
  return {
    enabled: St.autoCoverEnabled(),
    gaps,
    gap_names: gaps.map(levelName),
    agents: agents.size,
    perms: rows.length,
    updated_at: Number(St.get('auto_cover_updated_at')) || null
  };
}

/* ===================== 收回 ===================== */

/**
 * 收回全部代管授权（保留审计记录，仅置 revoked=1）。
 * @param {string} reason 收回理由：switch_off | activation | account_change | interval | manual
 * @returns {number} 收回条数
 */
function revokeAutoCover(reason) {
  const rows = db.prepare(`
    SELECT user_id, perm_code FROM permission_grants WHERE source = ? AND revoked = 0
  `).all(SOURCE);
  if (!rows.length) return 0;
  const info = db.prepare(`
    UPDATE permission_grants SET revoked = 1, revoked_at = ? WHERE source = ? AND revoked = 0
  `).run(Date.now(), SOURCE);

  const byUser = new Map();
  rows.forEach(r => {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r.perm_code);
  });
  byUser.forEach((perms, uid) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    recordEvent('auto_cover_revoke', null, uid,
      `${reasonText(reason)}：收回 ${perms.length} 项代管权限`);
    safeNotifyRevoke(u, { perms, reason });
  });
  St.set('auto_cover_updated_at', String(Date.now()));
  return info.changes;
}

function reasonText(reason) {
  const map = {
    switch_off: '自动代管已关闭',
    activation: '上级账号已到岗',
    account_change: '账号变更后重新计算',
    startup: '服务启动同步',
    interval: '定时巡检',
    switch_on: '自动代管已开启',
    manual: '手动重算'
  };
  return map[reason] || '自动代管调整';
}

/* ===================== 通知（失败绝不影响主流程） ===================== */

function safeNotifyGrant(user, v) {
  try {
    if (!user) return;
    require('./notify').notifyAutoCoverGrant(user, v).catch(() => {});
  } catch (e) { /* 通知失败不影响授权结果 */ }
}
function safeNotifyRevoke(user, v) {
  try {
    if (!user) return;
    require('./notify').notifyAutoCoverRevoke(user, v).catch(() => {});
  } catch (e) { /* 通知失败不影响授权结果 */ }
}

/* ===================== 核心：全量重算 + 差异落库 ===================== */

let syncing = false;   // 进程内重入保护（开关切换与定时巡检可能同时到达）
let lastSkippedKey = ''; // 上一次「无可用补位」的缺口指纹：缺口未变化时不重复写入数据流，避免被定时巡检反复刷屏

/**
 * 全量重算并落库（幂等）。
 * @param {{reason?:string}} [opts] reason: startup | activation | account_change | switch_on | switch_off | interval | manual
 * @returns {{enabled:boolean, gaps:string[], skipped:string[], granted:number, revoked:number, grants:Array}}
 */
function syncAutoCover(opts) {
  const reason = (opts && opts.reason) || 'manual';
  if (syncing) return { enabled: St.autoCoverEnabled(), gaps: currentGaps(), skipped: [], granted: 0, revoked: 0, grants: [], busy: true };
  syncing = true;
  try {
    // 0) 开关关闭 → 全部收回
    if (!St.autoCoverEnabled()) {
      const revoked = revokeAutoCover('switch_off');
      return { enabled: false, gaps: currentGaps(), skipped: [], granted: 0, revoked, grants: [] };
    }

    // 1) 先同步既有的「未激活辅导员委托」，使其结果参与去重（只读调用，保持其原有语义）
    try { require('./delegate').syncAutoDelegates(); } catch (e) { /* 忽略 */ }

    // 2) 缺口与补位者
    const gaps = currentGaps();
    const skipped = [];
    const desired = new Map();          // userId -> {user, perms:Set, level}
    const addDesired = (user, code, level) => {
      if (!user) return;
      if (!desired.has(user.id)) desired.set(user.id, { user, perms: new Set(), levels: new Set() });
      const slot = desired.get(user.id);
      slot.perms.add(code);
      slot.levels.add(level);
    };

    if (gaps.includes('r2')) {
      const cadres = availableCadres();
      if (!cadres.length) skipped.push('r2');
      cadres.forEach(u => permSetFor('r2').forEach(code => addDesired(u, code, 'r2')));
    }
    if (gaps.includes('r3')) {
      // 优先由在岗的小班主任顶上（他就是「预备辅导员」），无人则由班委补位
      const assistants = availableAssistants();
      const agents = assistants.length ? assistants : availableCadres();
      if (!agents.length) skipped.push('r3');
      agents.forEach(u => permSetFor('r3').forEach(code => addDesired(u, code, 'r3')));
    }

    // 3) 去掉「已由基线或非代管来源持有」的项，只补差额
    //    注意：这里绝不能用 A.hasPerm（它会把上一轮代管写入的授权也算作已持有，导致反复授予/收回）
    desired.forEach(slot => {
      [...slot.perms].forEach(code => { if (heldByOtherSource(slot.user, code)) slot.perms.delete(code); });
    });

    // 4) 与现有 auto_cover 授权比对
    const existingRows = db.prepare(`
      SELECT id, user_id, perm_code FROM permission_grants WHERE source = ? AND revoked = 0
    `).all(SOURCE);
    const existing = new Map();          // `${userId}|${code}` -> id
    existingRows.forEach(r => existing.set(`${r.user_id}|${r.perm_code}`, r.id));

    const toInsert = [];
    const toKeep = new Set();
    desired.forEach((slot, uid) => {
      slot.perms.forEach(code => {
        const key = `${uid}|${code}`;
        if (existing.has(key)) toKeep.add(key);
        else toInsert.push({ uid, code });
      });
    });
    const toRevokeIds = [];
    existingRows.forEach(r => {
      const key = `${r.user_id}|${r.perm_code}`;
      if (!toKeep.has(key)) toRevokeIds.push({ id: r.id, uid: r.user_id, code: r.perm_code });
    });

    // 5) 差异落库（事务）
    if (toInsert.length || toRevokeIds.length) {
      const now = Date.now();
      const ins = db.prepare(`
        INSERT INTO permission_grants (user_id, perm_code, granted_by, source, expires_at, revoked, created_at)
        VALUES (?, ?, NULL, ?, NULL, 0, ?)
      `);
      db.transaction(() => {
        toInsert.forEach(x => ins.run(x.uid, x.code, SOURCE, now));
        if (toRevokeIds.length) {
          const upd = db.prepare('UPDATE permission_grants SET revoked = 1, revoked_at = ? WHERE id = ? AND revoked = 0');
          toRevokeIds.forEach(x => upd.run(now, x.id));
        }
      })();
      St.set('auto_cover_updated_at', String(now));
    }

    // 6) 留痕与通知（按人聚合，只对真正变化的项通知）
    const grantsOut = [];
    const grantedByUser = new Map();
    toInsert.forEach(x => {
      if (!grantedByUser.has(x.uid)) grantedByUser.set(x.uid, []);
      grantedByUser.get(x.uid).push(x.code);
    });
    grantedByUser.forEach((perms, uid) => {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      const levels = [...new Set(perms.map(levelOfPerm))];
      const level = levels.includes('r3') ? 'r3' : 'r2';
      recordEvent('auto_cover_grant', null, uid,
        `${reasonText(reason)}：因缺少${levels.map(levelName).join('、')}，向「${u ? u.real_name : uid}」自动授予 ${perms.length} 项上级权限`);
      safeNotifyGrant(u, { perms, levels, reason });
      grantsOut.push({ user_id: uid, real_name: u ? u.real_name : uid, role_title: u ? u.role_title : '', perms, level });
    });

    const revokedByUser = new Map();
    toRevokeIds.forEach(x => {
      if (!revokedByUser.has(x.uid)) revokedByUser.set(x.uid, []);
      revokedByUser.get(x.uid).push(x.code);
    });
    revokedByUser.forEach((perms, uid) => {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      recordEvent('auto_cover_revoke', null, uid,
        `${reasonText(reason)}：收回 ${perms.length} 项代管权限`);
      safeNotifyRevoke(u, { perms, reason });
    });

    if (skipped.length) {
      // 仅在「缺口集合」发生变化时才留痕，避免无补位账号时每次定时巡检都写入一条「自动代管未执行」，刷屏数据流。
      const key = skipped.slice().sort().join(',');
      if (key !== lastSkippedKey) {
        recordEvent('auto_cover_skipped', null, null,
          `检测到层级缺口（${skipped.map(levelName).join('、')}）但没有可用的补位账号，暂未代管`);
        lastSkippedKey = key;
      }
    } else {
      // 缺口已消除（有人到岗 / 开关关闭）：重置指纹，下次若再次陷入无补位状态会重新留痕一次
      lastSkippedKey = '';
    }

    if (toInsert.length || toRevokeIds.length) {
      require('./logger').log('info', 'auto cover sync', {
        reason, granted: toInsert.length, revoked: toRevokeIds.length, gaps
      });
    }

    return {
      enabled: true,
      gaps,
      skipped,
      granted: toInsert.length,
      revoked: toRevokeIds.length,
      grants: grantsOut
    };
  } finally {
    syncing = false;
  }
}

/**
 * 供各业务触发点调用的「安全同步」：任何异常都不得影响调用方的业务结果
 * （历史上通知/委托类逻辑异常曾把登录打成 500，此处统一兜住）。
 * @param {string} reason
 */
function safeSync(reason) {
  try {
    return syncAutoCover({ reason: reason || 'manual' });
  } catch (e) {
    try { require('./logger').log('warn', 'auto cover sync failed: ' + (e && e.message), { reason }); } catch (x) { /* 忽略 */ }
    return null;
  }
}

module.exports = {
  SOURCE,
  permSetFor,
  levelOfPerm,
  levelName,
  hasAvailable,
  currentGaps,
  stateOf,
  heldByOtherSource,
  heldOnlyByAutoCover,
  describe,
  revokeAutoCover,
  syncAutoCover,
  safeSync
};
