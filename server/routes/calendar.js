'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const { effectiveStatus } = require('../geo');

const router = express.Router();
router.use(A.authRequired);

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

function monthRange(month) {
  let y, m;
  if (month && /^\d{4}-\d{2}$/.test(String(month))) {
    [y, m] = String(month).split('-').map(Number);
  } else {
    const d = new Date();
    y = d.getFullYear();
    m = d.getMonth() + 1;
  }
  const from = new Date(y, m - 1, 1, 0, 0, 0, 0).getTime();
  const to = new Date(y, m, 1, 0, 0, 0, 0).getTime() - 1;
  return { from, to, month: `${y}-${String(m).padStart(2, '0')}` };
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function activitiesInMonth(from, to) {
  // 长期活动只是分组，不参与签到统计
  return db.prepare('SELECT * FROM activities WHERE is_group = 0 AND start_time BETWEEN ? AND ? ORDER BY start_time')
    .all(from, to);
}

/* ---------------------- 班级集体日历 ---------------------- */
router.get('/class', A.requireRole('manager', 'ops'), (req, res) => {
  const { from, to, month } = monthRange(req.query.month);
  const activities = activitiesInMonth(from, to);
  const ids = activities.map(a => a.id);
  // 统计口径：未激活、注销后恢复未激活的学生均纳入统计；仅「已注销（软删）」「已删除（硬删，行不存在）」不计入。
  const members = db.prepare("SELECT id, real_name, student_id FROM users WHERE role = 'normal' AND status <> 'cancelled'").all();
  const parents = new Map(
    db.prepare('SELECT id, title FROM activities WHERE is_group = 1').all().map(p => [p.id, p.title])
  );

  let checks = [];
  if (ids.length) {
    checks = db.prepare(
      `SELECT * FROM checkins WHERE activity_id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids);
  }

  const byActivity = new Map();
  checks.forEach(c => {
    if (!byActivity.has(c.activity_id)) byActivity.set(c.activity_id, new Map());
    byActivity.get(c.activity_id).set(c.user_id, c);
  });
  // 请假审核状态（按 活动:用户）：请假未通过且活动已结束 → 缺勤
  const lmap = new Map(
    db.prepare('SELECT activity_id, user_id, status, is_appeal FROM leave_requests').all()
      .map(l => [l.activity_id + ':' + l.user_id, l])
  );

  const days = {};
  activities.forEach(a => {
    const key = dayKey(a.start_time);
    if (!days[key]) days[key] = [];
    const map = byActivity.get(a.id) || new Map();
    const counts = { signed: 0, ontheway: 0, leave: 0, absent: 0, cancelled: 0, pending: 0, total: members.length };
    members.forEach(m => {
      const c = map.get(m.id);
      // 与 effectiveStatus 口径统一：无签到记录（含退签）者在活动结束前算「待签到」，结束后才计「缺勤」
      const lr = lmap.get(a.id + ':' + m.id);
      const s = effectiveStatus(c ? c.status : null, a.end_time, lr ? lr.status : null, lr ? !!lr.is_appeal : false);
      if (counts[s] !== undefined) counts[s] += 1;
    });
    days[key].push({
      id: a.id,
      title: a.title,
      start_time: a.start_time,
      end_time: a.end_time,
      parent_title: a.parent_id ? (parents.get(a.parent_id) || '') : '',
      is_recurring_child: a.parent_id ? 1 : 0,
      counts
    });
  });

  return ok(res, { month, days, members, activity_count: activities.length });
});

/* ---------------------- 个人签到日历 ---------------------- */
function personCalendar(res, userId, monthStr) {
  const { from, to, month } = monthRange(monthStr);
  const activities = activitiesInMonth(from, to);
  const user = db.prepare('SELECT id, real_name, student_id, role_title FROM users WHERE id = ?').get(userId);
  if (!user) return bad(res, '用户不存在', 404);

  const checks = db.prepare('SELECT * FROM checkins WHERE user_id = ?').all(userId);
  const map = new Map(checks.map(c => [c.activity_id, c]));
  // 请假审核状态：用于「请假未通过 → 缺勤」的判定
  const lmap = new Map(
    db.prepare('SELECT activity_id, status FROM leave_requests WHERE user_id = ?').all(userId)
      .map(l => [l.activity_id, l.status])
  );

  const days = {};
  // pending = 未提交（活动尚未结束、且本人未做任何选择）
  const summary = { total: 0, signed: 0, ontheway: 0, leave: 0, absent: 0, pending: 0, cancelled: 0, manual: 0 };

  activities.forEach(a => {
    const key = dayKey(a.start_time);
    if (!days[key]) days[key] = [];
    const c = map.get(a.id);
    // 活动结束仍在途中 → 缺勤；待签到且活动已结束 → 缺勤
    const status = c
      ? effectiveStatus(c.status, a.end_time, lmap.get(a.id))
      : (a.end_time < Date.now() ? 'absent' : 'pending');
    if (summary[status] !== undefined) summary[status] += 1;
    summary.total += 1;
    if (c && c.manual) summary.manual += 1;
    days[key].push({
      id: a.id,
      title: a.title,
      start_time: a.start_time,
      end_time: a.end_time,
      status,
      in_fence: c ? c.in_fence : null,
      manual: c ? !!c.manual : false,
      created_at: c ? c.created_at : null
    });
  });

  const rate = summary.total ? Math.round((summary.signed / summary.total) * 100) : 0;
  return ok(res, { month, user, days, summary, attendance_rate: rate });
}

router.get('/my', (req, res) => personCalendar(res, req.user.id, req.query.month));

router.get('/person/:userId', A.requireRole('manager', 'ops'), (req, res) => {
  return personCalendar(res, req.params.userId, req.query.month);
});

/* ---------------------- 个人分析报告 ---------------------- */
router.get('/report/:userId', A.requireRole('manager', 'ops'), (req, res) => {
  const userId = req.params.userId;
  const user = db.prepare('SELECT id, real_name, student_id, role_title FROM users WHERE id = ?').get(userId);
  if (!user) return bad(res, '用户不存在', 404);

  const now = Date.now();
  // 遍历全部签到子活动，按活动结束时间归一状态
  const activities = db.prepare('SELECT id, end_time FROM activities WHERE is_group = 0').all();
  const checks = db.prepare('SELECT * FROM checkins WHERE user_id = ?').all(userId);
  const map = new Map(checks.map(c => [c.activity_id, c]));
  // 请假审核状态：用于「请假未通过 → 缺勤」的判定
  const lmap = new Map(
    db.prepare('SELECT activity_id, status FROM leave_requests WHERE user_id = ?').all(userId)
      .map(l => [l.activity_id, l.status])
  );

  const stat = { signed: 0, ontheway: 0, leave: 0, absent: 0, cancelled: 0, manual: 0, in_fence: 0, out_fence: 0, pending: 0 };
  activities.forEach(a => {
    const c = map.get(a.id);
    // 退签 / 无记录：活动未结束按待签到、结束後按缺勤；途中结束後转缺勤；请假未通过结束後转缺勤
    const s = c
      ? effectiveStatus(c.status, a.end_time, lmap.get(a.id))
      : (a.end_time < now ? 'absent' : 'pending');
    if (s === 'pending') { stat.pending += 1; return; }
    if (stat[s] !== undefined) stat[s] += 1; else stat.absent += 1;
    if (c) {
      if (c.manual) stat.manual += 1;
      // 仅当本记录实际采集了定位（lat/lng 非空）才计入「范围内 / 范围外」：
      // 未开启定位上传 / 未授权 / 管理员代操作（无定位）的情形 in_fence 恒为 null，
      // 不能算作「活动范围外」，否则会凭空把所有记录判成范围外。
      if (c.lat != null && c.lng != null) {
        if (c.in_fence) stat.in_fence += 1; else stat.out_fence += 1;
      }
    }
  });

  // 分母：已结束的子活动（未来/进行中的不计入，避免误判）
  const base = stat.signed + stat.ontheway + stat.leave + stat.absent;
  const attendance_rate = base ? Math.round((stat.signed / base) * 100) : 0;
  const effective_rate = base ? Math.round(((stat.signed + stat.ontheway + stat.leave) / base) * 100) : 0;

  return ok(res, {
    user,
    total_activities: activities.length,
    signed: stat.signed,
    ontheway: stat.ontheway,
    leave: stat.leave,
    absent: stat.absent,
    cancelled: stat.cancelled,
    pending: stat.pending,
    manual: stat.manual,
    in_fence: stat.in_fence,
    out_fence: stat.out_fence,
    attendance_rate,
    effective_rate
  });
});

module.exports = router;
