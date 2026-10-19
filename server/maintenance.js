'use strict';
/* 维护模式控制器
 * ------------------------------------------------------------------
 *  - enter()：开启维护。挂起所有「非运维者」在线会话（不销毁，维护结束后可自动恢复上线）；
 *  - exit() ：结束维护。恢复挂起会话——原在线账号自动重新上线。仅运维者可触发；
 *  - tick() ：调度器每分钟调用；到达排期开始时间即自动进入维护；
 *  - 维护窗口前后 1 小时禁止排活动（blockedRange）。
 * 说明：服务端会在维护中拦截「非运维者」的接口请求（见 index.js），
 *      因此即便用 F12 删除遮罩也无法继续操作。
 */
const St = require('./settings');
const db = require('./db');
const S = require('./sessions');
const notify = require('./notify');
const { recordEvent } = require('./logger');
const zh = require('./zh');
const { MAIL } = require('./mailtypes');

/** 排期前后各 1 小时禁止安排活动 */
const PLANNED_MARGIN_MS = 60 * 60 * 1000;

/** 维护邮件里的时间：与通知邮件统一为「YYYY-MM-DD HH:mm」 */
function fmt(ts) {
  const n = Number(ts);
  return n ? notify.fmtTime(n) : '待定';
}

/** 当前「在线且未被挂起」的账号 */
function onlineUsers() {
  return db.prepare(`
    SELECT DISTINCT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.online = 1 AND s.suspended = 0 AND u.disabled = 0
  `).all();
}

/** 活动禁排区间（维护窗口前后各 1 小时）；未排期返回 null */
function blockedRange() {
  const info = St.maintenanceInfo();
  if (!info.start_at) return null;
  const end = info.end_at || info.start_at;
  return { from: info.start_at - PLANNED_MARGIN_MS, to: end + PLANNED_MARGIN_MS, start_at: info.start_at, end_at: end };
}

/** 判断某活动时间段是否落入禁排区间 */
function conflictsWithMaintenance(start, end) {
  const r = blockedRange();
  if (!r || !start || !end) return null;
  if (end <= r.from || start >= r.to) return null;
  return r;
}

/** 开启维护 */
async function enter(actor, reason) {
  if (St.maintenanceEnabled()) return { already: true };
  // 先置位维护态：即便后续挂起 / 通知异常，也保证「维护已生效」，不会卡在进不去维护的状态
  St.setMaintenance(true);
  // 维护说明（遮罩展示的唯一文案）：立即开启且填写了说明则覆盖；排期自动开启（reason='scheduled'）沿用已排期说明
  if (reason && reason !== 'scheduled') St.setMaintenanceNotice(String(reason).trim());
  let affected = [];
  let suspended = 0;
  try {
    affected = onlineUsers().filter(u => u.role !== 'ops');
    suspended = S.suspendNonOps();
  } catch (e) { /* 挂起失败也保持维护态 */ }
  try { recordEvent('maintenance_enter', actor ? actor.id : null, null, reason || '手动开启'); } catch (e) { /* 忽略 */ }

  const info = St.maintenanceInfo();
  let notified = 0;
  for (const u of affected) {
    try {
      await notify.deliver(u, 'NT_SYS_MSG', {
        level: 'urgent', forceMail: true,
        title: '系统维护：你已被暂时下线',
        body: '系统进入维护，你的账号已暂时下线；维护结束后会自动恢复，无需重新登录。',
        ref_type: 'maintenance', ref_id: null,
        mail: { kind: MAIL.MAINTENANCE_PRE, opts: notify.buildMaintenance({ phase: 'pre', start_at: fmt(info.start_at || Date.now()), restore_at: fmt(info.end_at) }) }
      });
      notified += 1;
    } catch (e) { /* 忽略 */ }
  }
  return { ok: true, suspended, notified, affected: affected.length };
}

/** 排期「已触发过」标记：同一条排期只自动进入维护一次 */
function scheduleFired() { return Number(St.get('maintenance_schedule_fired')) || 0; }
function markScheduleFired(startAt) { St.set('maintenance_schedule_fired', startAt ? String(Number(startAt)) : ''); }

/** 结束维护（仅运维者） */
async function exit(actor, reason) {
  if (!St.maintenanceEnabled()) return { already: true };
  St.setMaintenance(false);
  St.setMaintenanceNotice('');   // 清空维护说明，避免下次遮罩误显示旧说明
  // 若是在排期窗口内结束的，把该排期标记为「已触发」：
  // 否则调度器下一分钟仍判定「当前在窗口内」而立刻重新进入维护 —— 表现为「没人操作却自己进维护、且退不出去」。
  // 排期窗口尚未开始（now < start_at）时不动标记，那条排期到点仍应正常触发。
  try {
    const si = St.maintenanceInfo();
    if (si.start_at && Date.now() >= si.start_at) markScheduleFired(si.start_at);
  } catch (e) { /* 忽略 */ }
  const resumed = S.resumeSuspended();
  recordEvent('maintenance_exit', actor ? actor.id : null, null, reason || '手动结束');

  const users = onlineUsers();
  let notified = 0;
  for (const u of users) {
    try {
      await notify.deliver(u, 'NT_SYS_MSG', {
        level: 'urgent',
        title: '系统维护已结束',
        body: '系统已恢复，你已重新上线，可继续使用。',
        ref_type: 'maintenance', ref_id: null,
        mail: { kind: MAIL.MAINTENANCE_POST, opts: notify.buildMaintenance({ phase: 'post', restore_at: fmt(Date.now()) }) }
      });
      notified += 1;
    } catch (e) { /* 忽略 */ }
  }
  return { ok: true, resumed, notified };
}

/** 调度器每分钟调用：到达排期开始时间自动进入维护（结束只能人工，用运维端） */
async function tick() {
  if (St.maintenanceEnabled()) return null;
  const info = St.maintenanceInfo();
  const startAt = info.start_at || 0;
  const endAt = info.end_at || 0;
  if (!startAt) return null;
  const now = Date.now();
  // 这条排期已经触发过（自动触发或人工结束维护时标记）→ 不再重复进入，
  // 否则「结束维护」后下一分钟就会被同一条排期重新拉进维护。
  if (scheduleFired() === startAt) return null;
  // 排期已整体过期（结束时间早于现在）：清理排期，避免一直卡在「已排期」并反复判定
  if (endAt && now > endAt) {
    try {
      St.setMaintenanceWindow({ start_at: null, end_at: null, notice: info.notice });
      markScheduleFired(0);
      recordEvent('maintenance_schedule_expired', null, null, '清理过期维护排期');
    } catch (e) { /* 忽略 */ }
    return null;
  }
  // 落在窗口内才进入：开始时间已到，且未设置结束时间或尚未到结束时间；同一条排期只触发一次
  if (now >= startAt && (!endAt || now <= endAt)) {
    markScheduleFired(startAt);
    return enter(null, 'scheduled');
  }
  return null;
}

module.exports = { enter, exit, tick, onlineUsers, blockedRange, conflictsWithMaintenance, fmt, PLANNED_MARGIN_MS };
