'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const { recordEvent } = require('../logger');
const zh = require('../zh');
const { evaluateFence, checkinWindow, FENCE_MAX_ACCURACY, effectiveStatus } = require('../geo');
const S = require('../settings');
const notify = require('../notify');
const mailer = require('../mailer');
const { ROLE_LEVEL } = require('../config');

const router = express.Router();
router.use(A.authRequired);

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

const upsertCheckin = db.prepare(`
  INSERT INTO checkins (activity_id, user_id, status, in_fence, ip, device_id, manual, handler_id, lat, lng, accuracy, created_at)
  VALUES (@activity_id, @user_id, @status, @in_fence, @ip, @device_id, @manual, @handler_id, @lat, @lng, @accuracy, @created_at)
  ON CONFLICT(activity_id, user_id) DO UPDATE SET
    status = excluded.status,
    in_fence = excluded.in_fence,
    ip = excluded.ip,
    device_id = excluded.device_id,
    manual = excluded.manual,
    handler_id = excluded.handler_id,
    lat = excluded.lat,
    lng = excluded.lng,
    accuracy = excluded.accuracy,
    created_at = excluded.created_at
`);

/* ======================= 普通用户：签到 / 在途中 / 请假 ======================= */
router.post('/checkin', A.requireRole('normal'), (req, res) => {
  const b = req.body || {};
  const activityId = Number(b.activity_id);
  const choice = b.choice; // signed | ontheway | leave
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  const deviceId = String(b.device_id || '').trim();
  const reason = String(b.reason || '').trim();
  const accuracy = Number(b.accuracy);   // 定位精度（米），用于精度兜底与防偏移

  if (!activityId) return bad(res, '缺少活动');
  if (!['signed', 'ontheway', 'leave'].includes(choice)) return bad(res, '请选择签到/在途中/请假');
  if (!deviceId) return bad(res, '缺少设备识别码');

  const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
  if (!activity) return bad(res, '活动不存在', 404);

  const user = req.user;

  // 已签到（终态）优先于时间窗口校验：已完成的签到不受窗口关闭影响。
  // 若用户在窗口关闭后再次尝试签到，应明确提示「已完成签到」，而非误报「不在可签到时间窗口内」。
  const prev = db.prepare('SELECT status FROM checkins WHERE activity_id = ? AND user_id = ?')
    .get(activityId, user.id);
  const prevStatus = prev ? prev.status : null;
  if (prevStatus === 'signed') {
    return bad(res, '你已完成签到，不能自行取消或修改；如需更正请联系管理员', 403);
  }

  const now = Date.now();
  const win = checkinWindow(activity);
  if (now < win.open || now > win.close) {
    return bad(res, '当前不在该活动的可签到时间窗口内', 403);
  }

  // 活动范围可选：活动未设置活动范围时仍会按「总开关 + 本人授权」采集并上传定位（仅记录坐标，不做范围判定）
  const fence = activity.fence_id
    ? db.prepare('SELECT * FROM fences WHERE id = ?').get(activity.fence_id)
    : null;
  const hasFence = !!(fence && fence.points_json);

  // 定位为「本人自愿授权」：只要「定位核验总开关开启 + 本人已授权」即采集 / 上传，
  // 与活动是否绑定活动范围无关（未绑范围时仅记录坐标、不做范围判定；绑定了则额外做范围判定，均仅供参考、不阻断签到）。
  // 未授权或总开关关闭时【不再阻断签到】，只是不采集位置。
  // 原实现误用了面向管理端的 A.locationVerifyAllowed(user)（要求 FENCE_VERIFY 高危机权限），
  // 导致普通学生恒不采集、in_fence 恒为 null（已由联调实证）；后又改为「必须绑范围」才采集，
  // 现进一步解耦：绑不绑范围都按总开关 + 授权采集上传。
  const needLoc = S.getBool('location_verify_enabled') && user.loc_consent === 1 && choice !== 'leave';
  // 真正「获取到」才算：坐标与精度都合法才参与范围判定；
  // 获取失败 / 精度不足一律按「未采集定位」处理，【绝不阻断签到】（与前端 user.js 承诺一致）。
  const acquired = needLoc && Number.isFinite(lat) && Number.isFinite(lng)
    && Number.isFinite(accuracy) && accuracy > 0;

  // 设备留痕：首次绑定；更换设备放行但记录留痕（同类不同端 / 新增另一类设备 / 更新设备均允许）
  if (!user.device_id) {
    db.prepare('UPDATE users SET device_id = ? WHERE id = ?').run(deviceId, user.id);
  } else if (user.device_id !== deviceId) {
    db.prepare('UPDATE users SET device_id = ? WHERE id = ?').run(deviceId, user.id);
    recordEvent('device_change', user.id, activityId, null);
  }

  /* ---------------- 状态流转校验 ----------------
   * · 已签到（signed）为终态：普通学生不可自行取消或改成其他状态（如需更正由管理员处理）；
   * · 在途中（ontheway）↔ 请假（leave）↔ 签到（signed）之间均可互改，
   *   请假无论是否审核通过都允许改为在途中 / 签到；
   * · 是否上传定位为本人自愿，【不作为任何状态变更的前提条件】（不强求）。
   */
  // 活动范围判定：仅在已采集位置时进行，结果【仅供参考与提示，不再阻断签到】；
  // 未采集位置 / 未设置活动范围 → inside 为 null（不适用）；
  // 坐标（lat/lng/accuracy）仅在 needLoc 时随本次签到记录一并落库（与隐私政策一致），仅用于「范围内/外」判定，不另行展示原文。
  const judged = evaluateFence({ fence: acquired ? fence : null, lat, lng, accuracy });
  const inside = acquired ? judged.inside : null;

  const status = choice;

  upsertCheckin.run({
    activity_id: activityId,
    user_id: user.id,
    status,
    in_fence: inside === null ? null : (inside ? 1 : 0),
    ip: req.ip || '',
    device_id: deviceId,
    manual: 0,
    handler_id: null,
    lat: needLoc ? lat : null,
    lng: needLoc ? lng : null,
    accuracy: needLoc ? accuracy : null,
    created_at: now
  });

  if (choice === 'leave') {
    // 请假（申诉）不再采集地点：location 一律不写入，仅保留历史列兼容旧数据。
    db.prepare('DELETE FROM leave_requests WHERE activity_id = ? AND user_id = ?').run(activityId, user.id);
    db.prepare(`
      INSERT INTO leave_requests (activity_id, user_id, reason, by_admin, status, created_at)
      VALUES (?, ?, ?, 0, 'pending', ?)
    `).run(activityId, user.id, reason, now);
  }

  // 数据流：本人已授权且本次实际上传了定位时，明确记录「含定位上传」。
  // 注意：「是否授权」属个人隐私，不写入数据流；此处只记录本次是否上传了定位。
  recordEvent('checkin', user.id, activityId, needLoc
    ? `${zh.statusText(status)}（含定位上传）`
    : zh.statusText(status));
  return ok(res, {
    status,
    in_fence: inside,
    has_fence: hasFence,
    distance: judged.distance,
    matched: judged.matched,
    message: status === 'signed'
      ? (hasFence
        ? (inside === null ? '签到成功（本次未上传定位，未做活动范围判定）'
          : (inside ? '签到成功（活动范围内）' : '签到成功（不在活动范围内，仅供参考，不影响签到）'))
        : (acquired ? '签到成功（该活动未设置活动范围，定位已记录）' : '签到成功（该活动未设置活动范围）'))
      : (status === 'ontheway' ? '已标记为在途中' : '请假申请已提交，等待审核')
  });
});

/* ---------------------- 我的签到记录 ---------------------- */
router.get('/checkin/my', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, a.title, a.start_time, a.end_time, a.policy, a.offset_minutes,
           lr.status AS leave_status, lr.is_appeal AS leave_appeal
    FROM checkins c
    JOIN activities a ON a.id = c.activity_id
    LEFT JOIN leave_requests lr ON lr.activity_id = c.activity_id AND lr.user_id = c.user_id
    WHERE c.user_id = ? ORDER BY a.start_time DESC
  `).all(req.user.id).map(r => Object.assign({}, r, {
    // 活动结束后：一直在途中、或请假未通过 → 缺勤
    display_status: effectiveStatus(r.status, r.end_time, r.leave_status, !!r.leave_appeal)
  }));
    return ok(res, { records: rows });
});

/* ---------------- 补签申请：活动结束后缺勤，普通学生发起申诉 ---------------- */
router.post('/checkin/makeup', A.requireRole('normal'), (req, res) => {
  if (!S.getBool('allow_makeup')) return bad(res, '当前未开放补签申请，请联系管理员', 403);

  const b = req.body || {};
  const activityId = Number(b.activity_id);
  const reason = String(b.reason || '').trim();
  // 补签（申诉）不再采集地点：location 一律不写入
  if (!activityId) return bad(res, '缺少活动');
  if (!reason) return bad(res, '请填写补签理由');

  const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
  if (!activity) return bad(res, '活动不存在', 404);

  const now = Date.now();
  if (now <= checkinWindow(activity).close) return bad(res, '签到窗口尚未关闭，请在窗口关闭后提交');

  const mine = db.prepare('SELECT * FROM checkins WHERE activity_id = ? AND user_id = ?')
    .get(activityId, req.user.id);
  if (mine && (mine.status === 'signed' || mine.status === 'leave')) {
    return bad(res, '你已有有效记录，无需补签');
  }
  const pending = db.prepare("SELECT 1 FROM makeup_requests WHERE activity_id = ? AND user_id = ? AND status = 'pending'")
    .get(activityId, req.user.id);
  if (pending) return bad(res, '补签申请已提交，请等待管理员审核');

  db.prepare(`
    INSERT INTO makeup_requests (activity_id, user_id, reason, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
    ON CONFLICT(activity_id, user_id) DO UPDATE SET
      reason = excluded.reason, status = 'pending', reply = NULL,
      handler_id = NULL, handled_at = NULL, created_at = excluded.created_at
  `).run(activityId, req.user.id, reason, now);

  recordEvent('makeup_request', req.user.id, activityId, null);
  return ok(res, { message: '补签申请已提交，等待管理员审核' });
});

/* 我的补签申请 */
router.get('/checkin/makeup/my', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, a.title, a.start_time, a.end_time
    FROM makeup_requests m JOIN activities a ON a.id = m.activity_id
    WHERE m.user_id = ? ORDER BY m.created_at DESC LIMIT 100
  `).all(req.user.id);
  return ok(res, { requests: rows });
});

/* 我的请假申诉（可与补签一起构成「我的申诉」列表） */
router.get('/checkin/leave/my', (req, res) => {
  const rows = db.prepare(`
    SELECT lr.*, a.title, a.start_time, a.end_time
    FROM leave_requests lr JOIN activities a ON a.id = lr.activity_id
    WHERE lr.user_id = ? ORDER BY lr.created_at DESC LIMIT 100
  `).all(req.user.id);
  return ok(res, { requests: rows });
});

/* ======================= 管理端 ======================= */
const admin = express.Router();
admin.use(A.requireRole('manager', 'ops'));

/** 按 Scope 收窄的「班级成员」ID 列表（运维者通配全局） */
function scopedMemberIds(op) {
  // 统计口径：未激活、注销后恢复未激活的学生均纳入统计；仅「已注销（软删）」「已删除（硬删，行不存在）」不计入。
  // 注：disabled=1 仅在注销时与 status='cancelled' 同时置位，故只需以 status<>'cancelled' 作为排除条件即可覆盖。
  if (A.isWildcard(op)) {
    return db.prepare("SELECT id FROM users WHERE role = 'normal' AND status <> 'cancelled'").all().map(r => r.id);
  }
  const ids = A.scopeIds(op.id);
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT id FROM users
    WHERE id IN (${ph}) AND role = 'normal' AND status <> 'cancelled'
  `).all(...ids).map(r => r.id);
}

/* 班级签到视图（仅 Scope 内成员） */
admin.get('/checkins', A.requirePerm('VIEW_CHECKIN'), (req, res) => {
  const activityId = Number(req.query.activity_id);
  if (!activityId) return bad(res, '请选择活动');

  const ids = scopedMemberIds(req.user);
  if (!ids.length) {
    const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
    return ok(res, { roster: [], activity, hint: '你的管理范围内暂无成员账号' });
  }
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT u.id AS user_id, u.real_name, u.student_id,
           c.status, c.in_fence, c.manual, c.created_at, c.ip, c.device_id,
           (c.lat IS NOT NULL) AS has_location,
           lr.status AS leave_status, lr.is_appeal AS leave_appeal
    FROM users u
    LEFT JOIN checkins c ON c.user_id = u.id AND c.activity_id = ?
    LEFT JOIN leave_requests lr ON lr.user_id = u.id AND lr.activity_id = ?
    WHERE u.id IN (${ph})
    ORDER BY u.student_id
  `).all(activityId, activityId, ...ids);

  const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
  // display_status：活动结束仍为「在途中」/「退签」/「无记录」的按缺勤展示；
  // 请假申请：已批准/正常请假待审核 计为「请假」，已驳回 视作缺勤；
  // 事后请假（申诉）待审核/未回应 同样按缺勤，唯有批准才计请假。leave_status / leave_appeal 一并带出（不另开标签）。
  const canViewLoc = A.hasPerm(req.user, 'VIEW_STUDENT_LOCATION');
  const roster = rows.map(r => {
    const item = Object.assign({}, r, {
      display_status: effectiveStatus(r.status || null, activity.end_time, r.leave_status, !!r.leave_appeal)
    });
    // 无「查看学生定位」权限时脱敏：保留判定结论(in_fence/has_location)，清除坐标原文
    if (!canViewLoc) {
      item.lat = null;
      item.lng = null;
      item.accuracy = null;
    }
    return item;
  });
  return ok(res, { roster, activity });
});

/* 地图专用：返回已上报定位的普通学生的位置（仅管理/开发端调用，用于在地图上打点，不展示坐标数字）
   分权：
   - 运维者：持有 VIEW_STUDENT_LOCATION 即可查看（不依赖「活动范围核验」总开关）；
   - 管理端：须运维者开启「管理端定位查看」开关，且本人持有 VIEW_STUDENT_LOCATION（由辅导员及以上授予）。
   采集侧已保证 loc_consent=0 的学生不写入坐标，故结果中天然不会出现其定位。 */
admin.get('/locations', (req, res) => {
  const activityId = Number(req.query.activity_id);
  if (!activityId) return bad(res, '请选择活动');

  if (req.user.role === 'ops') {
    if (!A.hasPerm(req.user, 'VIEW_STUDENT_LOCATION')) {
      return res.status(403).json({ error: '无「查看学生定位」权限', perm: 'VIEW_STUDENT_LOCATION', need_order: true });
    }
  } else {
    if (!S.getBool('manager_location_view')) {
      return res.status(403).json({
        error: '管理端定位查看当前未开放：需由运维者在运维端开启「管理端定位查看」',
        perm: 'VIEW_STUDENT_LOCATION', switch_off: true
      });
    }
    if (!A.hasPerm(req.user, 'VIEW_STUDENT_LOCATION')) {
      return res.status(403).json({
        error: '无「查看学生定位」权限；如需使用请向辅导员及以上申请授权',
        perm: 'VIEW_STUDENT_LOCATION', need_order: true
      });
    }
  }

  // 可选 user_id：点击单个学生卡片时只回传该生的定位（活动范围核验场景下用于单独查看）
  const uid = req.query.user_id ? Number(req.query.user_id) : null;
  // 作用域收敛：非全局（通配）管理员仅可见其管理范围内的定位，与 /checkins 名单口径一致
  const scoped = A.isWildcard(req.user) ? null : A.scopeIds(req.user.id);
  let sql = `
    SELECT u.id AS user_id, u.real_name, u.student_id,
           c.status, c.in_fence, c.lat, c.lng, c.accuracy
    FROM checkins c JOIN users u ON u.id = c.user_id
    WHERE c.activity_id = ? AND c.lat IS NOT NULL AND c.lng IS NOT NULL`;
  const params = [activityId];
  if (scoped && scoped.length) {
    sql += ` AND c.user_id IN (${scoped.map(() => '?').join(',')})`;
    scoped.forEach(id => params.push(id));
  }
  if (uid) {
    if (scoped && !scoped.includes(uid)) return bad(res, '该学生不在你的查看范围内', 403);
    sql += ' AND c.user_id = ?'; params.push(uid);
  }
  sql += ' ORDER BY u.student_id';

  const rows = db.prepare(sql).all(...params).map(r => ({
    user_id: r.user_id,
    real_name: r.real_name,
    student_id: r.student_id,
    status: r.status,
    in_fence: r.in_fence,
    lat: r.lat,
    lng: r.lng,
    accuracy: r.accuracy
  }));
  return ok(res, { locations: rows });
});

/* 补签（代签） / 退签：管理员/班委直接改签到状态，不属申诉流程，但必须留痕并回执给普通学生 */
// 权限门槛为「班委及以上」（cadre）：与代请假一致，班委/小班主任/辅导员均可操作，运维者通配。
admin.post('/supplement', A.requireMinLevel(ROLE_LEVEL.cadre), (req, res) => {
  const { user_id, activity_id, action } = req.body || {};
  const uid = user_id;
  const aid = Number(activity_id);
  if (!uid || !aid) return bad(res, '请选择用户与活动');

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(aid);
  if (!target || !act) return bad(res, '用户或活动不存在', 404);
  if (!A.canManage(req.user, target)) {
    return bad(res, '该账号不在你的管理范围内，或你的层级不足', 403);
  }

  const cancelling = action === 'cancel';
  const status = cancelling ? 'cancelled' : 'signed';
  const now = Date.now();

  // 前置校验：退签前提是已签到；补签前提是缺勤（避免误操作）
  const existed = db.prepare('SELECT status FROM checkins WHERE activity_id = ? AND user_id = ?').get(aid, uid);
  if (cancelling && (!existed || existed.status !== 'signed')) {
    return bad(res, '该学生尚未签到，无法退签', 400);
  }
  if (!cancelling && existed && existed.status === 'signed') {
    return bad(res, '该学生已签到，无需补签', 400);
  }
  // 补签仅限「活动已结束且学生缺勤」：结束前应由学生本人正常签到，避免管理员提前代签；
  // 运维者（通配超管）作为例外，可在活动进行中代签
  if (!cancelling && !A.isWildcard(req.user) && Date.now() <= act.end_time) {
    return bad(res, '活动尚未结束，补签仅可在活动结束后操作', 400);
  }

  // 管理员代操作不获取对方定位；退签时清除所有定位信息
  upsertCheckin.run({
    activity_id: aid,
    user_id: uid,
    status,
    in_fence: null, // 管理员代操作不采集定位，统一标记为未采集
    ip: req.ip || '',
    device_id: target.device_id || '',
    manual: 1,
    handler_id: req.user.id,
    lat: null,
    lng: null,
    accuracy: null,
    created_at: now
  });

  recordEvent(cancelling ? 'unsign' : 'supplement', req.user.id, uid, `活动#${aid}`);

  // 回执：在线走站内 toast，离线走邮件
  notify.notifyReceipt(target, {
    title: cancelling ? '你的签到已被退签' : '管理员为你补签',
    body: `${act.title}${cancelling ? '（如有异议可提交补签申诉）' : '（记为已签到）'}`,
    intro: cancelling
      ? '管理员撤销了你的一场签到记录。如有异议，可在活动结束后提交补签申诉。'
      : `管理员为你补记了一场签到，${notify.sessionTerm(act)}记为已签到。`,
    rows: [
      { label: '活动', value: act.title },
      { label: '操作人', value: notify.whoLine(req.user) }
    ],
    actor: req.user, ref_type: 'activity', ref_id: aid
  }).catch(() => {});
  return ok(res, { message: cancelling ? '已退签' : '已补签' });
});

/* 管理员/班委代请假：直接生效（无需审核），同样留痕并回执；幂等：已有请假记录则拒绝重复代请。
 * 权限门槛为「班委及以上」（cadre），低于补签/退签（辅导员及以上）：
 * 代请假仅置「请假」占位、不篡改签到实况，风险低于代签，故放开给班委/小班主任使用。 */
admin.post('/leave-for-user', A.requireMinLevel(ROLE_LEVEL.cadre), (req, res) => {
  const { user_id, activity_id, reason } = req.body || {};
  const uid = user_id;
  const aid = Number(activity_id);
  if (!uid || !aid) return bad(res, '请选择用户与活动');

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(aid);
  if (!target || !act) return bad(res, '用户或活动不存在', 404);
  if (!A.canManage(req.user, target)) {
    return bad(res, '该账号不在你的管理范围内，或你的层级不足', 403);
  }
  // 幂等：该生该活动已处于请假状态（本人申请待审/已准，或已被代请记为请假）则拒绝重复代请；
  // 被驳回的请假不算「已请假」，仍可代请。
  const existedLeave = db.prepare('SELECT status FROM leave_requests WHERE activity_id = ? AND user_id = ?')
    .get(aid, uid);
  if (existedLeave && existedLeave.status !== 'rejected') {
    return bad(res, '该学生该活动已有请假记录（含待审/已准），无需重复代请假', 400);
  }
  const existed = db.prepare('SELECT status FROM checkins WHERE activity_id = ? AND user_id = ?').get(aid, uid);
  if (existed && existed.status === 'leave') {
    return bad(res, '该学生该活动已记为请假，无需重复代请假', 400);
  }

  const now = Date.now();
  upsertCheckin.run({
    activity_id: aid,
    user_id: uid,
    status: 'leave',
    in_fence: null, // 代请假不采集定位
    ip: req.ip || '',
    device_id: target.device_id || '',
    manual: 1,
    handler_id: req.user.id,
    lat: null,
    lng: null,
    accuracy: null,
    created_at: now
  });
  db.prepare('DELETE FROM leave_requests WHERE activity_id = ? AND user_id = ?').run(aid, uid);
  db.prepare(`
    INSERT INTO leave_requests (activity_id, user_id, reason, by_admin, handler_id, status, created_at)
    VALUES (?, ?, ?, 1, ?, 'approved', ?)
  `).run(aid, uid, String(reason || '管理员代请假'), req.user.id, now);

  recordEvent('leave_by_admin', req.user.id, uid, `活动#${aid}`);

  notify.notifyReceipt(target, {
    title: '管理员已代你请假',
    body: `${act.title}${reason ? '：' + reason : ''}`,
    intro: `管理员为你登记了一场请假，${notify.sessionTerm(act)}记为请假，无需再审核。`,
    rows: [
      { label: '活动', value: act.title },
      { label: '理由', value: String(reason || '管理员代请假') },
      { label: '操作人', value: notify.whoLine(req.user) }
    ],
    actor: req.user, ref_type: 'activity', ref_id: aid
  }).catch(() => {});
  return ok(res, { message: '已代请假' });
});

/* 请假申请列表（仅 Scope 内成员）。stage 标注当前处于哪一审：
   initial=待初审；final=普通学生已申诉待终审；done=已结案（本级不可再改） */
admin.get('/leave-requests', A.requirePerm('VIEW_CHECKIN'), (req, res) => {
  const ids = scopedMemberIds(req.user);
  if (!ids.length) return ok(res, { requests: [], hint: '你的管理范围内暂无成员账号' });
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT lr.*, u.real_name, u.student_id, a.title, a.start_time
    FROM leave_requests lr
    JOIN users u ON u.id = lr.user_id
    JOIN activities a ON a.id = lr.activity_id
    WHERE lr.user_id IN (${ph})
    ORDER BY lr.status, lr.created_at DESC LIMIT 300
  `).all(...ids).map(r => Object.assign({}, r, { _type: 'leave', stage: stageOf(r) }));
  return ok(res, { requests: rows });
});

/** 当前所处审级：pending→初审；已裁决且普通学生申诉且未终审→终审；其余→已结案 */
function stageOf(r) {
  if (r.status === 'pending') return 'initial';
  if (r.appealed === 1 && !r.final_status) return 'final';
  return 'done';
}

/**
 * 两审制裁决：
 *  - 初审（ADJ_INITIAL）只能对 pending 做一次，裁决后 locked=1，本级不可再改；
 *  - 终审（ADJ_FINAL）只在普通学生提出申诉（appealed=1）时进行，结果为最终；
 *  - 终审执行人不得与初审执行人为同一人（两审分离，见各 review 接口校验）；
 *  - 已裁决且普通学生未申诉 → 拒绝变更。
 */
function judgeStage(r) {
  if (r.status === 'pending') return 'initial';
  if (r.appealed === 1 && !r.final_status) return 'final';
  return null;
}

function requireJudgePerm(res, user, stage) {
  const perm = stage === 'initial' ? 'ADJ_INITIAL' : 'ADJ_FINAL';
  if (!A.hasPerm(user, perm)) {
    return res.status(403).json({
      error: stage === 'initial'
        ? '无「初步裁决」权限；如需使用请提交权限工单'
        : '终审需「终审 / 覆盖」权限；如需使用请提交权限工单',
      perm, need_order: true
    });
  }
  return null;
}

/**
 * 是否存在比 handler 层级更高、且持有 ADJ_FINAL、可管理 owner 的终审人。
 * 运维者虽层级高但被排除（见下方 role <> 'ops'），故「最高业务层级」即辅导员 R3。
 *
 * 「在岗」口径与 autocover / delegate 一致：未禁用、未注销、本人已设密码。
 * 预置但未激活的上级虽然基线持有 ADJ_FINAL，却永远无法登录处理终审；
 * 若把他算作终审人，申诉会一直停在初审无人终审，故必须排除。
 * 排除后若确实无更高终审人，则由 autoFinalize 在初审即自动终局（免审）。
 */
function hasHigherFinalReviewer(owner, handler) {
  const higher = db.prepare(
    `SELECT * FROM users
     WHERE disabled = 0 AND status <> 'cancelled' AND password_hash IS NOT NULL
       AND role <> 'ops' AND role_level > ?`
  ).all(A.userLevel(handler));
  return higher.some(u => A.hasPerm(u, 'ADJ_FINAL') && A.canManage(u, owner));
}

/** 无更高终审人时，初审结果直接提升为终局并标注「终审免审」（最高级自审自终 / 无更高终审即结案） */
function autoFinalize(owner, table, rowId, handler, approve, reply, now) {
  db.prepare(`
    UPDATE ${table}
    SET final_status = ?, final_handler_id = ?, final_reply = ?, final_at = ?, final_waived = 1, status = ?
    WHERE id = ?
  `).run(approve ? 'approved' : 'rejected', handler.id, reply || null, now, approve ? 'approved' : 'rejected', rowId);
  recordEvent('appeal_auto_final', handler.id, owner.id,
    `申诉#${rowId}：无更高层级终审人，初审结果自动结案（终审免审）`);
}

/* 请假审核：初审 / 终审（可附审核留言，结果按在线状态走站内或邮件） */
admin.post('/leave-requests/:id/review', (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const approve = body.approve === true;
  const reply = String(body.reply || '').trim();

  const lr = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
  if (!lr) return bad(res, '申请不存在', 404);
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(lr.user_id);
  if (!owner || !A.canManage(req.user, owner)) {
    return bad(res, '该账号不在你的管理范围内，或你的层级不足', 403);
  }
  const stage = judgeStage(lr);
  if (!stage) {
    return bad(res, '该申请已裁决且普通学生未提出申诉，本级不可再变更', 403);
  }
  const denied = requireJudgePerm(res, req.user, stage);
  if (denied) return denied;
  // 两审分离：终审不得由初审执行人本人操作，防止一人包办两审
  if (stage === 'final' && lr.handler_id && lr.handler_id === req.user.id) {
    return bad(res, '你已执行过初审，终审须由其他管理員复核', 403);
  }

  const now = Date.now();
  if (stage === 'initial') {
    db.prepare(`
      UPDATE leave_requests SET status = ?, handler_id = ?, reply = ?, handled_at = ?, locked = 1 WHERE id = ?
    `).run(approve ? 'approved' : 'rejected', req.user.id, reply || null, now, id);
    // 无更高层级终审人 → 初审即终局，自动结案并标注「终审免审」（最高级自审自终同此逻辑）
    if (!hasHigherFinalReviewer(owner, req.user)) {
      autoFinalize(owner, 'leave_requests', id, req.user, approve, reply, now);
    }
  } else {
    db.prepare(`
      UPDATE leave_requests SET final_status = ?, final_handler_id = ?, final_reply = ?, final_at = ?, status = ? WHERE id = ?
    `).run(approve ? 'approved' : 'rejected', req.user.id, reply || null, now,
      approve ? 'approved' : 'rejected', id);
  }

  if (approve) {
    // 通过：记为请假。用 upsert 兼容「事后请假」申诉（提交时未预置签到记录，可能无 checkins 行）。
    upsertCheckin.run({
      activity_id: lr.activity_id, user_id: lr.user_id, status: 'leave',
      in_fence: null, // 申诉请假审批不采集定位 ip: req.ip || '', device_id: lr.device_id || '',
      manual: 0, handler_id: req.user.id, lat: null, lng: null, accuracy: null, created_at: now
    });
  } else {
    // 驳回：撤销「请假」占位，回到待签到正常状态。
    // 活动进行中仍可按正常流程去签到；若活动已结束且仍缺勤，
    // 日历 / 统计会自然判为缺勤，避免「驳回即缺勤」的粗暴处理。
    // 若学生已自行签到（status='signed'），则保留该签到记录，不误删。
    db.prepare("DELETE FROM checkins WHERE activity_id = ? AND user_id = ? AND status = 'leave'")
      .run(lr.activity_id, lr.user_id);
  }

  recordEvent(approve ? 'leave_approve' : 'leave_reject', req.user.id, lr.user_id,
    `${stage === 'final' ? '终审' : '初审'}·活动#${lr.activity_id}`);

  notify.notifyLeaveResult(owner, notify.getActivity(lr.activity_id), approve, reply).catch(() => {});
  return ok(res, {
    message: (stage === 'final' ? '终审完成：' : '初审完成：') + (approve ? '已批准' : '已驳回'),
    stage
  });
});

/* 补签申请列表（仅 Scope 内成员），stage 标注当前审级 */
admin.get('/makeup-requests', A.requirePerm('VIEW_CHECKIN'), (req, res) => {
  const ids = scopedMemberIds(req.user);
  if (!ids.length) return ok(res, { requests: [], hint: '你的管理范围内暂无成员账号' });
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT m.*, u.real_name, u.student_id, a.title, a.start_time, a.end_time
    FROM makeup_requests m
    JOIN users u ON u.id = m.user_id
    JOIN activities a ON a.id = m.activity_id
    WHERE m.user_id IN (${ph})
    ORDER BY m.status, m.created_at DESC LIMIT 300
  `).all(...ids).map(r => Object.assign({}, r, { _type: 'makeup', stage: stageOf(r) }));
  return ok(res, { requests: rows });
});

/* 补签审核：初审 / 终审。通过则记为「已签到（管理员操作）」 */
admin.post('/makeup-requests/:id/review', (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const approve = body.approve === true;
  const reply = String(body.reply || '').trim();

  const mr = db.prepare('SELECT * FROM makeup_requests WHERE id = ?').get(id);
  if (!mr) return bad(res, '申请不存在', 404);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(mr.user_id);
  if (!target) return bad(res, '用户不存在', 404);
  if (!A.canManage(req.user, target)) {
    return bad(res, '该账号不在你的管理范围内，或你的层级不足', 403);
  }
  const stage = judgeStage(mr);
  if (!stage) {
    return bad(res, '该申请已裁决且普通学生未提出申诉，本级不可再变更', 403);
  }
  const denied = requireJudgePerm(res, req.user, stage);
  if (denied) return denied;
  // 两审分离：终审不得由初审执行人本人操作，防止一人包办两审
  if (stage === 'final' && mr.handler_id && mr.handler_id === req.user.id) {
    return bad(res, '你已执行过初审，终审须由其他管理員复核', 403);
  }

  const now = Date.now();
  db.transaction(() => {
    if (stage === 'initial') {
      db.prepare(`
        UPDATE makeup_requests SET status = ?, handler_id = ?, reply = ?, handled_at = ?, locked = 1 WHERE id = ?
      `).run(approve ? 'approved' : 'rejected', req.user.id, reply || null, now, id);
      // 无更高层级终审人 → 初审即终局，自动结案并标注「终审免审」
      if (!hasHigherFinalReviewer(target, req.user)) {
        autoFinalize(target, 'makeup_requests', id, req.user, approve, reply, now);
      }
    } else {
      db.prepare(`
        UPDATE makeup_requests SET final_status = ?, final_handler_id = ?, final_reply = ?, final_at = ?, status = ? WHERE id = ?
      `).run(approve ? 'approved' : 'rejected', req.user.id, reply || null, now,
        approve ? 'approved' : 'rejected', id);
    }

    if (approve) {
      upsertCheckin.run({
        activity_id: mr.activity_id,
        user_id: mr.user_id,
        status: 'signed',
        in_fence: null, // 申诉补签审批不采集定位
        ip: req.ip || '',
        device_id: target.device_id || '',
        manual: 1,
        handler_id: req.user.id,
        lat: null,
        lng: null,
        accuracy: null,
        created_at: now
      });
    } else {
      db.prepare(`
        UPDATE checkins SET status = 'absent' WHERE activity_id = ? AND user_id = ? AND status IS NOT 'signed'
      `).run(mr.activity_id, mr.user_id);
    }
  })();

  recordEvent(approve ? 'makeup_approve' : 'makeup_reject', req.user.id, mr.user_id,
    `${stage === 'final' ? '终审' : '初审'}·活动#${mr.activity_id}`);

  const makeupAct = notify.getActivity(mr.activity_id);
  notify.notifyMakeupResult(target, makeupAct, approve, reply).catch(() => {});
  return ok(res, {
    message: (stage === 'final' ? '终审完成：' : '初审完成：') +
      (approve ? `已通过补签，${notify.sessionTerm(makeupAct)}记为已签到` : '已驳回补签'),
    stage
  });
});

/* ---------------- 清理已结案：避免审核列表越堆越多 ----------------
 * 结案口径与 stageOf 一致：已裁决（status<>'pending'）且（学生未申诉，或已终审）。
 * 只删「申诉记录」本身；已判定 / 已撤销的签到记录（checkins）不受影响，考勤结果不变。 */
function clearDoneAppeals(req, res, table) {
  const ids = scopedMemberIds(req.user);
  const label = table === 'leave_requests' ? '请假' : '补签';
  if (!ids.length) return ok(res, { removed: 0, message: '你的管理范围内暂无成员账号' });
  const ph = ids.map(() => '?').join(',');
  const info = db.prepare(`
    DELETE FROM ${table}
    WHERE user_id IN (${ph})
      AND status <> 'pending'
      AND (appealed = 0 OR final_status IS NOT NULL)
  `).run(...ids);
  const removed = info.changes || 0;
  if (removed) recordEvent('appeal_clear', req.user.id, req.user.id, `清理已结案${label}申诉 ${removed} 条`);
  return ok(res, {
    removed,
    message: removed ? `已清理 ${removed} 条已结案${label}申诉` : '没有可清理的已结案申诉'
  });
}
admin.post('/leave-requests/clear-done', A.requirePerm('VIEW_CHECKIN'), (req, res) => clearDoneAppeals(req, res, 'leave_requests'));
admin.post('/makeup-requests/clear-done', A.requirePerm('VIEW_CHECKIN'), (req, res) => clearDoneAppeals(req, res, 'makeup_requests'));

/* 单条删除申诉记录（任意状态）：用于清理积压 / 无效申诉。
 * 仅限本人管理范围内的成员；只删申诉记录本身，不影响签到结果。 */
function deleteAppeal(req, res, table) {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) return bad(res, '记录不存在', 404);
  if (!scopedMemberIds(req.user).includes(row.user_id)) return bad(res, '无权处理该记录', 403);
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  const label = table === 'leave_requests' ? '请假' : '补签';
  recordEvent('appeal_delete', req.user.id, row.activity_id, `删除${label}申诉记录 #${id}`);
  return ok(res, { message: '已删除该申诉记录' });
}
admin.post('/leave-requests/:id/delete', A.requirePerm('VIEW_CHECKIN'), (req, res) => deleteAppeal(req, res, 'leave_requests'));
admin.post('/makeup-requests/:id/delete', A.requirePerm('VIEW_CHECKIN'), (req, res) => deleteAppeal(req, res, 'makeup_requests'));

/* 系统设置：补签开关 / 邮件提醒开关 / 通知偏好 / 定位核验开关状态 */
admin.get('/settings', (req, res) => ok(res, {
  settings: S.all(),
  mail_configured: mailer.isConfigured(),
  notify_prefs: S.notifyPrefs(),
  location_verify_enabled: S.locationVerifyEnabled(),
  maintenance_enabled: S.maintenanceEnabled(),
  my_level: A.userLevel(req.user),
  can: {
    location_verify: A.hasPerm(req.user, 'FENCE_VERIFY'),
    settings: A.hasPerm(req.user, 'SYS_SETTINGS'),
    maintenance: A.hasPerm(req.user, 'SYS_MAINTENANCE'),
    privacy: A.hasPerm(req.user, 'AUTH_PRIVACY')
  }
}));

admin.post('/settings', (req, res) => {
  if (!A.hasPerm(req.user, 'SYS_SETTINGS')) {
    return res.status(403).json({ error: '无「系统设置」权限；如需使用请提交权限工单', perm: 'SYS_SETTINGS', need_order: true });
  }
  const b = req.body || {};
  S.BOOL_KEYS.forEach(k => { if (b[k] !== undefined) S.set(k, b[k] ? '1' : '0'); });
  // 「管理端定位查看」为运维者全局开关：仅运维者可切换，普通管理员即使持有 SYS_SETTINGS 也不能改动
  if (b.manager_location_view !== undefined) {
    if (!A.isWildcard(req.user)) {
      return res.status(403).json({ error: '仅运维者可切换「管理端定位查看」开关' });
    }
    S.set('manager_location_view', b.manager_location_view ? '1' : '0');
  }
  recordEvent('settings_update', req.user.id, null, JSON.stringify(S.all()));
  return ok(res, { message: '设置已保存', settings: S.all() });
});

router.use('/admin', admin);

module.exports = router;
