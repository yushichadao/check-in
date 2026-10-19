'use strict';
const db = require('./db');
const S = require('./settings');
const notify = require('./notify');
const { checkinWindow } = require('./geo');
const { log } = require('./logger');
const workorder = require('./routes/workorder');
const maintenance = require('./maintenance');
const delegate = require('./delegate');

/**
 * 轻量周期任务（每分钟扫描一次，邮件为「尽力而为」，未配置 SMTP 时写入测试文件）。
 *
 * 提醒按「签到窗口开放时刻」与「活动开始时刻」两套时间轴触发：
 *  1) 活动开始前 60 / 30 / 10 / 5 分钟 → 给尚未提交的普通学生发提醒（NT_REMINDER_*，可配置）；
 *  2) 签到窗口刚开放          → 发「签到开始」提醒（NT_CHECKIN_START）；
 *  3) 活动开始                → 发「活动开始」提醒（NT_ACT_START）；
 *  4) 签到窗口结束后          → 给缺勤（且未请假）的普通学生发提醒，邀请补签（NT_NOT_CHECKED）。
 * 另外：工单超时自动驳回 + 过期邮箱验证码清理。
 * 同一活动同一普通学生同一类型的提醒只发一次（notify_log 去重）；mandatory 提醒恒发。
 */

const TICK_MS = 60 * 1000;
const POST_END_MS = 10 * 60 * 1000;
const COUNTDOWNS = [60, 30, 10, 5];
const CODE_TTL_MS = 10 * 60 * 1000;      // 与 routes/auth.js 中的验证码有效期保持一致

/** 需要关注的活动：尚未结束（含刚结束 10 分钟内，用于缺勤提醒） */
function candidates(now) {
  return db.prepare(`
    SELECT * FROM activities
    WHERE is_group = 0 AND end_time > ?
  `).all(now - POST_END_MS);
}

function pendingUsers(activityId, excludeSigned) {
  const cond = excludeSigned
    ? "AND (c.id IS NULL OR c.status NOT IN ('signed','leave'))"
    : 'AND c.id IS NULL';
  return db.prepare(`
    SELECT u.* FROM users u
    LEFT JOIN checkins c ON c.user_id = u.id AND c.activity_id = ?
    WHERE u.role = 'normal' AND u.disabled = 0
      AND u.email IS NOT NULL AND u.email <> ''
      ${cond}
  `).all(activityId);
}

/** 活动开始前倒计时提醒（60 / 30 / 10 / 5 分钟） */
async function countdownTick(now) {
  for (const a of candidates(now)) {
    if (a.start_time <= now) continue;                 // 已开始，交给「活动开始」提醒
    if (a.start_time > now + 61 * 60 * 1000) continue; // 61 分钟外不处理
    const deltaMin = (a.start_time - now) / 60000;
    for (const m of COUNTDOWNS) {
      // 命中窗口：剩余时间落在 (m-1, m] 分钟内
      if (deltaMin <= m && deltaMin > m - 1) {
        for (const u of pendingUsers(a.id, false)) {
          await notify.notifyCountdown(u, a, m);
        }
        break;
      }
    }
  }
}

/** 签到窗口开放 / 活动开始 / 结束后缺勤 */
async function windowTick(now) {
  const wantStart = S.notifyEnabled('NT_CHECKIN_START');
  const wantAbsent = S.notifyEnabled('NT_NOT_CHECKED');
  for (const a of candidates(now)) {
    const w = checkinWindow(a);
    if (wantStart && w.open <= now && w.open > now - TICK_MS) {
      for (const u of pendingUsers(a.id, false)) await notify.notifyStart(u, a);
    }
    // 活动开始时刻
    if (a.start_time <= now && a.start_time > now - TICK_MS) {
      for (const u of pendingUsers(a.id, false)) await notify.notifyActStart(u, a);
    }
  }

  // 结束后缺勤提醒（邀请补签申诉）
  if (wantAbsent) {
    const ended = db.prepare(`
      SELECT * FROM activities
      WHERE is_group = 0 AND end_time <= ? AND end_time > ?
    `).all(now, now - POST_END_MS);
    for (const a of ended) {
      for (const u of pendingUsers(a.id, true)) await notify.notifyAbsent(u, a);
    }
  }
}

/** 工单超时自动驳回 */
async function workOrderTick() {
  try {
    const ids = workorder.timeoutScan();
    if (ids && ids.length) log('info', 'work orders timeout', { ids });
  } catch (e) {
    log('warn', 'work order timeout scan failed: ' + e.message);
  }
}

/** 清理过期的邮箱验证码（防止暴力与表膨胀） */
function cleanExpiredCodes() {
  try {
    const info = db.prepare('DELETE FROM email_codes WHERE expires_at < ? OR used = 1')
      .run(Date.now() - CODE_TTL_MS);
    return info.changes;
  } catch (e) { return 0; }
}

/** 清理已过期的权限授予（标记撤回，便于审计） */
function expireGrants() {
  try {
    return db.prepare('UPDATE permission_grants SET revoked = 1, revoked_at = ? WHERE revoked = 0 AND expires_at IS NOT NULL AND expires_at < ?')
      .run(Date.now(), Date.now()).changes;
  } catch (e) { return 0; }
}

/** 每日巡检：未激活辅导员确保自动委托存在；已激活者清理残留委托 */
const DAY_MS = 24 * 60 * 60 * 1000;
let lastDelegateSync = 0;
function syncDelegatesIfDue(now) {
  if (now - lastDelegateSync < DAY_MS) return;
  lastDelegateSync = now;
  try {
    const n = delegate.syncAutoDelegates();
    if (n > 0) log('info', 'auto delegate sync', { counselors_changed: n });
  } catch (e) { log('warn', 'auto delegate sync failed: ' + e.message); }
}

/**
 * 自动代管巡检兜底：默认每 5 分钟重算一次（可用 AUTO_COVER_INTERVAL_MIN 调整）。
 * 事件触发的即时重算已覆盖绝大多数场景，此处用于兜住「漏触发 / 进程重启期间的变更」。
 * 仅在确有变化时写日志与留痕（见 autocover.syncAutoCover 内部）。
 */
const AUTO_COVER_INTERVAL_MS = Math.max(1, Number(process.env.AUTO_COVER_INTERVAL_MIN) || 5) * 60 * 1000;
let lastCoverSync = 0;
function syncAutoCoverIfDue(now) {
  if (now - lastCoverSync < AUTO_COVER_INTERVAL_MS) return;
  lastCoverSync = now;
  try {
    const r = require('./autocover').syncAutoCover({ reason: 'interval' });
    if (r && (r.granted || r.revoked)) log('info', 'auto cover interval sync', { granted: r.granted, revoked: r.revoked, gaps: r.gaps });
  } catch (e) { log('warn', 'auto cover sync failed: ' + e.message); }
}

async function tick() {
  const now = Date.now();
  // 维护排期：到达开始时间自动进入维护（结束只能人工，用运维端）
  try {
    const m = await maintenance.tick();
    if (m && m.ok) log('info', 'maintenance auto-enter', m);
  } catch (e) { log('warn', 'maintenance tick failed: ' + e.message); }
  // 维护中：暂停一切自动提醒 / 群发邮件（注册验证码、签到倒计时 / 开始、缺勤、工单催办等）。
  // 维护期非运维者账号已被挂起、无法处理业务，此时外发邮件既无人接收也无意义；
  // 维护预告 / 结束通知由维护控制器单独下发，不在此处发送。
  if (S.maintenanceEnabled()) return;
  await countdownTick(now);
  await windowTick(now);
  await workOrderTick();
  // 工单待办催办：给挂起较久（>30 分钟）的待审批工单审批人发提醒邮件
  try { await notify.remindPendingWorkOrders(); } catch (e) { log('warn', 'work order reminder failed: ' + e.message); }
  const cleaned = cleanExpiredCodes();
  const expired = expireGrants();
  if (cleaned || expired) log('info', 'scheduler cleanup', { codes: cleaned, grants: expired });
  // 每日巡检：辅导员未激活自动委托 / 已激活收回（最多每天一次）
  syncDelegatesIfDue(now);
  // 自动代管巡检兜底（默认每 5 分钟，可配）
  syncAutoCoverIfDue(now);
}

function start() {
  setInterval(() => {
    tick().catch(e => log('warn', 'scheduler tick failed: ' + e.message));
  }, TICK_MS);
  log('info', 'reminder scheduler started', { tick_ms: TICK_MS });
}

module.exports = { start, tick, cleanExpiredCodes, expireGrants };
