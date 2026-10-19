'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const { recordEvent } = require('../logger');
const maintenance = require('../maintenance');
const { checkinWindow, windowText, policyText, effectiveStatus } = require('../geo');
const uploads = require('../uploads');
const mask = require('../mask');
const S = require('../settings');

const router = express.Router();
router.use(A.authRequired);

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

const POLICIES = ['before_start', 'before_end'];

/** 单个活动最多配图张数（与前端一致；超出的部分直接忽略） */
const MAX_ACT_IMAGES = 3;

/**
 * 取出活动的配图相对路径数组。
 * 新数据读 images_json；历史数据只有 image_file（单张）时降级为 1 张。
 */
function imageList(row) {
  if (row && row.images_json) {
    try {
      const arr = JSON.parse(row.images_json);
      if (Array.isArray(arr)) return arr.filter(f => typeof f === 'string' && f);
    } catch (e) { /* 脏数据忽略，降级到 image_file */ }
  }
  return row && row.image_file ? [row.image_file] : [];
}

/** 客户端提交的配图 dataURL 逐张校验落盘，返回相对路径数组 */
function saveActivityImages(body) {
  const raw = [];
  if (Array.isArray(body && body.images)) raw.push.apply(raw, body.images);
  else if (body && typeof body.image === 'string') raw.push(body.image);
  const files = [];
  raw.slice(0, MAX_ACT_IMAGES).forEach((one) => {
    if (typeof one !== 'string' || !/^data:image\//i.test(one)) return;
    const m = one.match(/^data:(image\/[a-z+]+);base64,/i);
    files.push(uploads.saveImage(one, m ? m[1] : 'image/jpeg').file);
  });
  return files;
}

/** 解析活动的活动范围：0 / '' / 未传 都表示「不使用活动范围」 */
function parseFenceId(v, fallback) {
  if (v === undefined) return fallback === undefined ? null : fallback;
  if (v === null || v === '') return null;
  const n = Number(v);
  return (Number.isFinite(n) && n > 0) ? n : null;
}

const ACT_STATE_KEYS = ['signed', 'ontheway', 'leave', 'absent', 'cancelled', 'pending'];

/**
 * 单个子活动的六态统计（与班级签到视图 / 今日活动卡片同一口径）。
 * 长期活动本身不是一场签到，不能直接统计，需对其活动逐场统计后再汇总。
 */
function countsOf(act, members) {
  const cmap = new Map(
    db.prepare('SELECT * FROM checkins WHERE activity_id = ?').all(act.id).map(c => [c.user_id, c])
  );
  const lmap = new Map(
    db.prepare('SELECT user_id, status, is_appeal FROM leave_requests WHERE activity_id = ?').all(act.id)
      .map(l => [l.user_id, l])
  );
  const counts = { signed: 0, ontheway: 0, leave: 0, absent: 0, cancelled: 0, pending: 0, total: members.length };
  members.forEach(m => {
    const c = cmap.get(m.id);
    const lr = lmap.get(m.id);
    const status = effectiveStatus(c ? c.status : null, act.end_time, lr ? lr.status : null, lr ? !!lr.is_appeal : false);
    if (counts[status] !== undefined) counts[status] += 1;
  });
  return counts;
}

function decorate(row) {
  const files = imageList(row);
  return Object.assign({}, row, {
    window: checkinWindow(row),
    window_text: windowText(row),
    policy_text: policyText(row.policy, row.offset_minutes),
    image_files: files,
    image_count: files.length,
    has_image: files.length > 0
  });
}

/** 取活动创建者的用户行（用于层级比较） */
function creatorOf(act) {
  if (!act || !act.creator_id) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(act.creator_id);
}

/** 某活动（含其下活动，若是长期活动）是否已产生签到 / 请假记录。
 *  用于判定「本人创建的活动」能否由普通管理员直接删除：有考勤数据的删除会清除考勤，
 *  仍属高危，需 ACT_DELETE 权限。 */
function hasActivityRecords(act) {
  if (!act) return false;
  const ids = act.is_group
    ? [act.id, ...db.prepare('SELECT id FROM activities WHERE parent_id = ?').all(act.id).map(r => r.id)]
    : [act.id];
  if (!ids.length) return false;
  const ph = ids.map(() => '?').join(',');
  if (db.prepare(`SELECT 1 FROM checkins WHERE activity_id IN (${ph}) LIMIT 1`).get(...ids)) return true;
  if (db.prepare(`SELECT 1 FROM leave_requests WHERE activity_id IN (${ph}) LIMIT 1`).get(...ids)) return true;
  return false;
}

/** 当前用户能否删除某活动：
 *  - 运维者兜底可删任意活动；
 *  - 自己创建的活动：普通管理员（含小班主任 / 班委等低层级）即可删除，无需高危 ACT_DELETE 权限，
 *    目的是「防止误添加」——误发且无人签到的活动可随时自行撤回；
 *  - 自己创建但已产生签到 / 请假记录的活动：删除会清除考勤数据，仍属高危，需持有 ACT_DELETE；
 *  - 删「他人」活动：需持有 ACT_DELETE（高危，基线仅辅导员 R3+，且被「缺席代管」自动委托排除），
 *    且层级「严格高于」创建者（同级不可互删）；历史无创建者记录 / 创建者已注销的活动，由辅导员及以上兜底。
 *  注：ACT_DELETE 在 server/delegate.js 的 EXCLUDE_PERMS 中，代理账号拿不到删他人活动的权力。
 */
function canDeleteActivity(user, act) {
  if (!user || !act) return false;
  if (user.role === 'ops') return true;
  // 本人创建的活动：普通管理员即可删除（防止误添加）；但已有考勤数据时仍需高危权限
  if (act.creator_id && act.creator_id === user.id) {
    if (hasActivityRecords(act)) return A.hasPerm(user, 'ACT_DELETE');
    return true;
  }
  // 删他人活动：必须持有 ACT_DELETE 且层级严格高于创建者（同级不能删同级；仅上级可删）
  if (!A.hasPerm(user, 'ACT_DELETE')) return false;
  if (!act.creator_id) return A.userLevel(user) >= 3;     // 无创建者记录，辅导员及以上兜底
  const creator = creatorOf(act);
  if (!creator) return A.userLevel(user) >= 3;            // 创建者已注销等，辅导员及以上兜底
  return A.userLevel(user) > A.userLevel(creator);
}

/** 删除被拒的可读理由（前端用于置灰按钮 tooltip） */
function deleteDenyReason(user, act) {
  // 本人创建但已有考勤记录：删除会清除考勤，需高危权限，提示联系上级
  if (act.creator_id && act.creator_id === user.id && hasActivityRecords(act) && !A.hasPerm(user, 'ACT_DELETE')) {
    return '该活动已有签到 / 请假记录，删除会清除考勤数据；如需删除请联系辅导员及以上管理员处理';
  }
  if (user.role !== 'ops' && !A.hasPerm(user, 'ACT_DELETE')) {
    return '无「删除活动」权限；如需使用请提交权限工单，由上级审批后开通';
  }
  const creator = creatorOf(act);
  if (creator && act.creator_id !== user.id && A.userLevel(user) <= A.userLevel(creator)) {
    const same = A.userLevel(user) === A.userLevel(creator);
    return `「${creator.real_name || '该用户'}」${same ? '与您同级' : '层级高于您'}，您不能删除其创建的活动；仅其本人或上级管理员 / 运维者可删除`;
  }
  return '仅活动创建者或上级管理员 / 运维者可删除该活动';
}

/** 本地时间构造：dateStr 'YYYY-MM-DD'，clock 'HH:mm' */
function buildTime(dateStr, clock) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = String(clock || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0).getTime();
}

/* ------------------------- 时间段冲突检测 ------------------------- */
/**
 * 产品规则：任意时刻不允许存在多个「真实活动」（is_group = 0，即单场 / 子活动）。
 * 重叠判定（半开区间，端点相接不算冲突）：end_time > start && start_time < end。
 * 说明：长期活动容器本身 is_group = 1，不是一场具体签到，不计入冲突。
 * @param {number} start 新活动开始时间戳
 * @param {number} end   新活动结束时间戳
 * @param {number} [excludeId] 需排除的活动 id（编辑场景用，创建时省略）
 * @returns {Array} 与 [start,end] 重叠的 is_group=0 活动行
 */
function overlappingActivities(start, end, excludeId) {
  const rows = db.prepare(`
    SELECT id, title, start_time, end_time
    FROM activities
    WHERE is_group = 0 AND end_time > ? AND start_time < ?
  `).all(start, end);
  return excludeId != null ? rows.filter(r => r.id !== excludeId) : rows;
}

/** 时间戳格式化为 YYYY-MM-DD HH:mm（本地时区，与 buildTime 口径一致） */
function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 生成时间段冲突的提示文案（指向第一个冲突活动） */
function overlapError(rows) {
  const one = rows[0];
  return `该时间段与已有活动冲突，无法创建新活动：已存在「${one.title}」(${fmtTime(one.start_time)} ~ ${fmtTime(one.end_time)})`;
}

/* ------------------------- 活动范围列表 ------------------------- */
router.get('/fences', (req, res) => {
  const fences = db.prepare('SELECT * FROM fences ORDER BY id').all().map(f => {
    let polys = [];
    try { polys = JSON.parse(f.points_json); } catch (e) { polys = []; }
    if (Array.isArray(polys) && polys.length && Array.isArray(polys[0]) && !Array.isArray(polys[0][0])) polys = [polys];
    return Object.assign({}, f, { polygons: polys.filter(p => Array.isArray(p)) });
  });
  return ok(res, { fences });
});

/* ------------------------- 活动详情（基本信息 + 六态统计 + 签到名单） ------------------------- */
router.get('/activities/:id', (req, res) => {
  const id = Number(req.params.id);
  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
  if (!act) return bad(res, '活动不存在', 404);

  // 注意：fences 表的名称列是 name（不是 title），写错会导致详情接口 500
  const f = act.fence_id ? db.prepare('SELECT name FROM fences WHERE id = ?').get(act.fence_id) : null;
  const d = decorate(act);          // 已带 image_files / image_count / has_image
  d.fence_name = f ? f.name : null;

  // 六态统计（与班级签到视图 / 今日活动卡片同一口径）：未激活、注销后恢复未激活的学生均纳入统计；仅已注销、已删除不计入
  const members = db.prepare("SELECT id, real_name, student_id, email FROM users WHERE role = 'normal' AND status <> 'cancelled'").all();
  const checks = db.prepare('SELECT * FROM checkins WHERE activity_id = ?').all(id);
  const cmap = new Map(checks.map(c => [c.user_id, c]));
  const lmap = new Map(
    db.prepare('SELECT user_id, status, is_appeal FROM leave_requests WHERE activity_id = ?').all(id)
      .map(l => [l.user_id, l])
  );
  const counts = { signed: 0, ontheway: 0, leave: 0, absent: 0, cancelled: 0, pending: 0, total: members.length };
  // 名单可见性：本人看自己；管理员（含运维者）可按权限看全部
  const canViewRoster = req.user.role === 'ops' || A.hasPerm(req.user, 'VIEW_CHECKIN');
  const roster = [];
  members.forEach(m => {
    let status, time = null, inFence = null, manual = 0;
    const c = cmap.get(m.id);
    const lr = lmap.get(m.id);
    status = effectiveStatus(c ? c.status : null, act.end_time, lr ? lr.status : null, lr ? !!lr.is_appeal : false);
    if (c) {
      time = c.created_at; inFence = c.in_fence; manual = c.manual ? 1 : 0;
    }
    if (counts[status] !== undefined) counts[status] += 1;
    if (canViewRoster || m.id === req.user.id) {
      // 他人邮箱一律打码，仅本人可见自己的完整邮箱
      const isSelf = m.id === req.user.id;
      roster.push({
        id: m.id,
        real_name: m.real_name,
        student_id: m.student_id,
        email: isSelf ? (m.email || '') : mask.maskEmail(m.email),
        status, time, in_fence: inFence, manual
      });
    }
  });

  // 长期活动单独处理：它只是分组容器，签到记录在活动上，
  // 因此详情给出「活动列表 + 各子活动人次合计」，而不是把自己当成一场来统计。
  if (act.is_group) {
    const kids = db.prepare('SELECT * FROM activities WHERE parent_id = ? ORDER BY start_time').all(id);
    const childRows = kids.map(k => {
      const kd = decorate(k);
      return {
        id: k.id, title: k.title,
        start_time: k.start_time, end_time: k.end_time,
        window_text: kd.window_text,
        counts: countsOf(k, members)
      };
    });
    const agg = { signed: 0, ontheway: 0, leave: 0, absent: 0, cancelled: 0, pending: 0, total: 0 };
    childRows.forEach(c => {
      ACT_STATE_KEYS.forEach(k => { agg[k] += c.counts[k]; });
      agg.total += c.counts.total;
    });
    d.child_count = childRows.length;
    d.children = childRows;
    d.summary = agg;
    d.summary_scope = 'children';       // 前端据此把「人」改称「人次」
    d.roster = [];
    d.roster_view = 'none';
  } else {
    d.child_count = 0;
    d.children = [];
    d.summary = counts;
    d.summary_scope = 'activity';
    d.roster = roster;
    d.roster_view = canViewRoster ? 'all' : 'self';
  }
  return ok(res, { activity: d });
});

/* ------------------------- 活动列表（父子分组） ------------------------- */
router.get('/activities', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, f.name AS fence_name
    FROM activities a LEFT JOIN fences f ON f.id = a.fence_id
    ORDER BY COALESCE(a.parent_id, a.id), a.is_group DESC, a.start_time
  `).all();
  // 预取创建者（id -> {real_name, level}），避免每行各查一次库
  const creatorIds = [...new Set(rows.map(r => r.creator_id).filter(Boolean))];
  const creatorMap = {};
  if (creatorIds.length) {
    const ph = creatorIds.map(() => '?').join(',');
    db.prepare(`SELECT id, real_name, role_level, role, role_title FROM users WHERE id IN (${ph})`)
      .all(...creatorIds).forEach(u => { creatorMap[u.id] = u; });
  }
  const out = rows.map(r => {
    const d = decorate(r);
    d.can_delete = canDeleteActivity(req.user, r);
    d.is_owner = !!(r.creator_id && r.creator_id === req.user.id);
    const c = r.creator_id ? creatorMap[r.creator_id] : null;
    d.creator_name = c ? c.real_name : (r.creator_id ? '已注销账号' : '未知');
    d.creator_level = c ? A.userLevel(c) : null;
    d.creator_role = c ? (c.role_title || c.role || '') : '';
    if (!d.can_delete) d.delete_reason = deleteDenyReason(req.user, r);
    return d;
  });
  return ok(res, { activities: out });
});

/* --------------------- 当前/即将开始的活动（不含长期活动） --------------------- */
router.get('/current', (req, res) => {
  const now = Date.now();
  const all = db.prepare(`
    SELECT a.*, f.name AS fence_name
    FROM activities a LEFT JOIN fences f ON f.id = a.fence_id
    WHERE a.is_group = 0
    ORDER BY a.start_time
  `).all().map(decorate);

  const pick = (a, now) => {
    if (!a) return { activity: null, state: 'none' };
    let fence = null;
    if (a.fence_id) {
      const f = db.prepare('SELECT * FROM fences WHERE id = ?').get(a.fence_id);
      if (f) {
        let polys = [];
        try { polys = JSON.parse(f.points_json); } catch (e) { polys = []; }
        if (Array.isArray(polys) && polys.length && Array.isArray(polys[0]) && !Array.isArray(polys[0][0])) polys = [polys];
        fence = { id: f.id, name: f.name, polygons: polys.filter(p => Array.isArray(p)), coord_system: f.coord_system };
      }
    }
    let state = 'closed';
    if (a.window && now >= a.window.open && now <= a.window.close) state = 'open';
    else if (a.window && now < a.window.open) state = 'upcoming';
    // 活动阶段（以「签到窗口」为口径）：窗口未开 / 窗口开启中 / 窗口已关闭（可判定缺勤）
    const phase = now < a.window.open ? 'upcoming' : (now > a.window.close ? 'ended' : 'ongoing');
    return { activity: Object.assign({}, a, { fence }), state, phase };
  };

  // 首页「当前活动」候选集：
  //  - open：当前签到窗口开启中的活动（最高优先，直接展示）；
  //  - justEnded：最近一个「签到窗口已关闭」的活动（缺勤学生需预留展示）；
  //  - next：最早一个「未开始」的活动（预告）。
  // 注：缺勤/补签的「是否预留 10 分钟」由用户端按本人签到记录判定，故服务端仅返回候选，不在服务端做学生差异化。
  const open = all.find(a => now >= a.window.open && now <= a.window.close) || null;
  let justEnded = null, next = null;
  for (const a of all) {
    if (now > a.window.close && (!justEnded || a.window.close > justEnded.window.close)) justEnded = a;
    if (now < a.window.open && (!next || a.window.open < next.window.open)) next = a;
  }
  return ok(res, {
    now,
    allow_makeup: S.getBool('allow_makeup'),
    open: open ? pick(open, now) : null,
    justEnded: justEnded ? pick(justEnded, now) : null,
    next: next ? pick(next, now) : null
  });
});

/* ------------------------- 发布活动 ------------------------- */
/**
 * mode:
 *  - once      临时活动（独立单场，无子活动）
 *  - recurring 长期活动（新建并自动生成子活动）
 *  - sub       为已有长期活动添加子活动
 */
// 管理端 / 运维端均可发布活动（运维者为最高权限、理应持有全部模块）；班委 R1 起天然持有 ACT_CREATE
router.post('/activities', A.requireRole('manager', 'ops'), A.requirePerm('ACT_CREATE'), (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const mode = b.mode || 'once';
  const policy = POLICIES.includes(b.policy) ? b.policy : 'before_end';
  const offsetMinutes = Math.max(0, Math.floor(Number(b.offset_minutes)) || 0);
  if (policy === 'before_start' && offsetMinutes <= 0) return bad(res, '「签到截止至活动开始」规则需设置大于 0 的提前开放分钟数');
  // 活动范围可选：未选择时该活动不做活动范围校验（仅校验时间窗口）
  const fenceId = parseFenceId(b.fence_id, null);
  const remark = String(b.remark || '').trim().slice(0, 300) || null;
  // 地点：由管理端在活动管理里用文本框填写，与活动范围（fence_id）是两回事
  // 即使活动绑定了活动范围，地点文本也独立保存与显示（与定位模式解耦）
  const location = String(b.location || '').trim().slice(0, 120) || null;
  // 目的地标记坐标（管理端在地图上打点；GCJ-02）
  const hasDest = Number.isFinite(Number(b.dest_lng)) && Number.isFinite(Number(b.dest_lat))
    && b.dest_lng !== null && b.dest_lat !== null && b.dest_lng !== '' && b.dest_lat !== '';
  const destLng = hasDest ? Number(b.dest_lng) : null;
  const destLat = hasDest ? Number(b.dest_lat) : null;
  const setDestById = (id, lng, lat) => {
    if (id == null || lng == null || lat == null) return;
    db.prepare('UPDATE activities SET dest_lng = ?, dest_lat = ? WHERE id = ?').run(Number(lng), Number(lat), id);
  };
  // 发布配图：客户端压缩后提交 dataURL 数组（images），服务器逐张校验并落盘；
  // 兼容旧客户端的单张字段 image；image_file 始终写第一张，供旧逻辑读取。
  let imageFiles = [];
  try {
    imageFiles = saveActivityImages(b);
  } catch (e) {
    return bad(res, '配图保存失败：' + (e.message || '格式不支持'));
  }
  const setImagesById = (id, files) => {
    if (!files || !files.length) return;
    db.prepare('UPDATE activities SET image_file = ?, images_json = ? WHERE id = ?')
      .run(files[0], JSON.stringify(files), id);
  };
  const setImagesByGroup = (groupKey, files) => {
    if (!files || !files.length || !groupKey) return;
    db.prepare('UPDATE activities SET image_file = ?, images_json = ? WHERE group_key = ?')
      .run(files[0], JSON.stringify(files), groupKey);
  };

  // 活动范围绑定属管理员基线能力（运维者/管理员均可），无需「启动活动范围核验」权限；
  // 绑定后是否实际启用「让用户端上传定位」核验，由该高危权限(FENCE_VERIFY) + 定位核验总开关决定（开不开启是另一回事）。
  if ((mode === 'recurring' || mode === 'sub') && !A.hasPerm(req.user, 'ACT_RECURRING')) {
    return res.status(403).json({ error: '无「循环 / 活动」权限', perm: 'ACT_RECURRING', need_order: true });
  }

  const insert = db.prepare(`
    INSERT INTO activities (title, start_time, end_time, fence_id, policy, offset_minutes,
                            recurring, group_key, parent_id, is_group, remark, location, creator_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  /* ---------- 为已有长期活动添加活动 ---------- */
  if (mode === 'sub') {
    const parentId = Number(b.parent_id);
    const parent = db.prepare('SELECT * FROM activities WHERE id = ? AND is_group = 1').get(parentId);
    if (!parent) return bad(res, '请选择要添加活动的长期活动', 404);

    const start = Date.parse(b.start_time);
    const end = Date.parse(b.end_time);
    if (!start || !end) return bad(res, '请填写活动的时间段');
    if (end <= start) return bad(res, '结束时间必须晚于开始时间');
    if (start < Date.now() || end < Date.now()) return bad(res, '不能设置已过去的活动：活动时间段（开始 / 结束）需晚于当前时间');
    const mc = maintenance.conflictsWithMaintenance(start, end);
    if (mc) return bad(res, `该时间段与维护窗口冲突（维护前后 1 小时禁排活动）：${maintenance.fmt(mc.start_at)} ~ ${maintenance.fmt(mc.end_at)}`, 403);
    // 任意时刻禁止存在多个活动：与已有真实活动重叠则不予通过
    const conflicts = overlappingActivities(start, end);
    if (conflicts.length) return bad(res, overlapError(conflicts), 409);

    const info = insert.run(
      parent.title, start, end,
      parseFenceId(b.fence_id, parent.fence_id),
      POLICIES.includes(b.policy) ? b.policy : parent.policy,
      Number.isFinite(Number(b.offset_minutes)) ? offsetMinutes : parent.offset_minutes,
      1, parent.group_key || ('RG' + parent.id), parentId, 0, remark || parent.remark,
      location || parent.location, req.user.id, Date.now()
    );
    // 目的地：优先用本次传入，否则继承长期活动
    setDestById(info.lastInsertRowid,
      hasDest ? destLng : parent.dest_lng,
      hasDest ? destLat : parent.dest_lat);
    // 配图：优先本次，否则继承长期活动
    if (imageFiles.length) setImagesById(info.lastInsertRowid, imageFiles);
    else setImagesById(info.lastInsertRowid, imageList(parent));
    recordEvent('activity_create', req.user.id, Number(info.lastInsertRowid), `活动:${parent.title}`);
    return ok(res, { message: '活动已添加', id: info.lastInsertRowid, parent_id: parentId });
  }

  if (!title) return bad(res, '请输入活动名称');

  /* ---------- 长期活动：长期活动 + 批量活动 ---------- */
  if (mode === 'recurring') {
    const start_date = b.start_date;
    const end_date = b.end_date;
    const start_clock = b.start_clock;
    const end_clock = b.end_clock;
    const days = Array.isArray(b.days) ? b.days.map(Number) : [];

    if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date || '')) return bad(res, '请选择长期活动的开始日期');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end_date || '')) return bad(res, '请选择长期活动的结束日期');
    if (!start_clock || !end_clock) return bad(res, '请填写长期活动的时间段');
    if (!days.length) return bad(res, '请选择重复的星期');

    const group = 'RG' + Date.now();
    const from = new Date(start_date + 'T00:00:00').getTime();
    const to = new Date(end_date + 'T00:00:00').getTime();
    const mc = maintenance.conflictsWithMaintenance(from, to);
    if (mc) return bad(res, `长期活动区间与维护窗口冲突（维护前后 1 小时禁排活动）：${maintenance.fmt(mc.start_at)} ~ ${maintenance.fmt(mc.end_at)}`, 403);

    // 1) 先算出所有子活动时间段 + 校验是否跨过当前时间（不涉及落库，便于统一冲突检测）
    const subs = [];
    for (let t = from; t <= to; t += 24 * 60 * 60 * 1000) {
      const d = new Date(t);
      if (!days.includes(d.getDay())) continue;
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const s = buildTime(dateStr, start_clock);
      const e = buildTime(dateStr, end_clock);
      if (e <= s) continue;
      if (s < Date.now() || e < Date.now()) {
        return bad(res, '不能设置已过去的活动：所选日期范围内存在早于当前时间的活动，请调整开始日期或重复的星期');
      }
      subs.push({ s, e });
    }
    if (!subs.length) {
      return bad(res, '所选日期范围内没有匹配的时间段');
    }

    // 2) 冲突检测：任一子活动与已有「真实活动」重叠 → 不予通过；
    //    同时自身子活动之间也不得互相重叠（不同日期理论上不会，仍兜底校验）。
    for (const sub of subs) {
      const conflicts = overlappingActivities(sub.s, sub.e);
      if (conflicts.length) return bad(res, overlapError(conflicts), 409);
    }
    for (let i = 0; i < subs.length; i++) {
      for (let j = i + 1; j < subs.length; j++) {
        const a = subs[i], b = subs[j];
        if (a.e > b.s && a.s < b.e) {
          return bad(res, `该长期活动包含多个互相重叠的时间段（${fmtTime(a.s)} ~ ${fmtTime(a.e)} 与 ${fmtTime(b.s)} ~ ${fmtTime(b.e)}），无法创建`, 409);
        }
      }
    }

    // 3) 落库：先建长期活动容器，再批量写入各子活动
    const firstStart = subs[0].s;
    const lastEnd = subs[subs.length - 1].e;
    const count = subs.length;
    let mainId = 0;
    const tx = db.transaction(() => {
      mainId = Number(insert.run(
        title, firstStart, lastEnd, fenceId, policy, offsetMinutes, 1, group, null, 1, remark, location, req.user.id, Date.now()
      ).lastInsertRowid);
      subs.forEach(sub => {
        insert.run(title, sub.s, sub.e, fenceId, policy, offsetMinutes, 1, group, mainId, 0, remark, location, req.user.id, Date.now());
      });
    });
    tx();

    // 目的地：长期活动与其所有活动统一写入
    if (hasDest) {
      db.prepare('UPDATE activities SET dest_lng = ?, dest_lat = ? WHERE group_key = ?').run(destLng, destLat, group);
    }
    setImagesByGroup(group, imageFiles);
    recordEvent('activity_create', req.user.id, mainId, `长期活动:${title}×${count}`);
    return ok(res, { message: `已创建长期活动并生成 ${count} 个活动`, id: mainId, count });
  }

  /* ---------- 临时活动：独立单场 ---------- */
  const start = Date.parse(b.start_time);
  const end = Date.parse(b.end_time);
  if (!start || !end) return bad(res, '请填写完整的活动时间段');
  if (end <= start) return bad(res, '结束时间必须晚于开始时间');
  if (start < Date.now()) return bad(res, '不能设置已过去的活动：开始时间需晚于当前时间');
  const mc = maintenance.conflictsWithMaintenance(start, end);
  if (mc) return bad(res, `该时间段与维护窗口冲突（维护前后 1 小时禁排活动）：${maintenance.fmt(mc.start_at)} ~ ${maintenance.fmt(mc.end_at)}`, 403);
  // 任意时刻禁止存在多个活动：与已有真实活动重叠则不予通过
  const conflicts = overlappingActivities(start, end);
  if (conflicts.length) return bad(res, overlapError(conflicts), 409);

  const info = insert.run(title, start, end, fenceId, policy, offsetMinutes, 0, null, null, 0, remark, location, req.user.id, Date.now());
  setDestById(info.lastInsertRowid, destLng, destLat);
  setImagesById(info.lastInsertRowid, imageFiles);
  recordEvent('activity_create', req.user.id, Number(info.lastInsertRowid), title);
  return ok(res, { message: '临时活动已发布', id: info.lastInsertRowid });
});

/* ------------------------- 删除活动（长期活动连带活动） ------------------------- */
function deleteActivityCascade(id) {
  const ids = db.prepare('SELECT id FROM activities WHERE parent_id = ?').all(id).map(r => r.id);
  ids.push(id);
  ids.forEach(aid => {
    db.prepare('DELETE FROM checkins WHERE activity_id = ?').run(aid);
    db.prepare('DELETE FROM leave_requests WHERE activity_id = ?').run(aid);
    db.prepare('DELETE FROM activities WHERE id = ?').run(aid);
  });
  return ids.length;
}

router.delete('/activities/:id', A.requireRole('manager', 'ops'), (req, res) => {
  const id = Number(req.params.id);
  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
  if (!act) return bad(res, '活动不存在', 404);
  // 分权：删除活动需持有 ACT_DELETE（运维者兜底）；删他人活动须层级严格高于创建者（同级不可互删）
  if (!canDeleteActivity(req.user, act)) {
    return bad(res, deleteDenyReason(req.user, act), 403);
  }

  db.transaction(() => deleteActivityCascade(id))();

  recordEvent('activity_delete', req.user.id, id, act.title + (act.is_group ? '（含活动）' : ''));
  return ok(res, { message: act.is_group ? '长期活动及其活动已删除' : '活动已删除' });
});

/* ------------------------- 批量删除活动 ------------------------- */
router.post('/activities/bulk-delete', A.requireRole('manager', 'ops'), (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids)
    ? req.body.ids.map(Number).filter(Boolean)
    : [];
  if (!ids.length) return bad(res, '请选择要删除的活动');

  let removed = 0;
  let denied = 0;
  const deniedReasons = [];
  db.transaction(() => {
    ids.forEach(id => {
      const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
      if (!act) return;
      if (!canDeleteActivity(req.user, act)) {
        denied += 1; deniedReasons.push(act.title + '（' + deleteDenyReason(req.user, act) + '）'); return;
      }
      removed += deleteActivityCascade(id);
    });
  })();

  recordEvent('activity_bulk_delete', req.user.id, null, `批量删除 ${removed} 条活动记录`);
  const msg = denied
    ? `已删除 ${removed} 条活动（含活动）；${denied} 条已跳过：${deniedReasons.join('、')}`
    : `已删除 ${removed} 条活动（含活动）`;
  return ok(res, { message: msg, removed, denied });
});

/* ------------------- 编辑活动：已禁止（活动一经发布不可修改） ------------------- */
// 产品要求：活动发布后不允许编辑，避免事后改动已生效的签到规则；
// 如需调整请删除后重新发布。目的地标记走 /activities/:id/destination（不受影响）。
router.put('/activities/:id', A.requireRole('manager', 'ops'), (req, res) => {
  return res.status(403).json({ error: '活动不可编辑：已发布的签到活动不允许修改，如需调整请删除后重新发布' });
});

/* ------------------------- 活动配图（鉴权读取，不静态暴露） ------------------------- */
/**
 * 读取第 idx 张配图（idx 从 0 开始）。
 * /image 与 /image/0 等价（第一张），保留旧路径以兼容历史客户端。
 */
function sendActivityImage(req, res, idx) {
  const act = db.prepare('SELECT image_file, images_json FROM activities WHERE id = ?').get(Number(req.params.id));
  if (!act) return res.status(404).json({ error: '活动不存在' });
  const files = imageList(act);
  const file = files[idx];
  if (!file) return res.status(404).json({ error: '该活动无此配图' });
  const buf = uploads.readFile(file);
  if (!buf) return res.status(404).json({ error: '配图文件不存在' });
  const ext = String(file).split('.').pop().toLowerCase();
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.send(buf);
}
router.get('/activities/:id/image', (req, res) => sendActivityImage(req, res, 0));
router.get('/activities/:id/image/:idx', (req, res) => {
  const i = Number(req.params.idx);
  if (!Number.isInteger(i) || i < 0) return res.status(404).json({ error: '配图序号无效' });
  return sendActivityImage(req, res, i);
});

/* ------------------------- 设置 / 清除活动目的地标记 ------------------------- */
router.put('/activities/:id/destination', A.requireRole('manager', 'ops'), (req, res) => {
  const id = Number(req.params.id);
  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
  if (!act) return bad(res, '活动不存在', 404);
  if (req.user.role !== 'ops' && act.creator_id && act.creator_id !== req.user.id && !A.hasPerm(req.user, 'ACT_MANAGE')) {
    return bad(res, '仅活动创建者或有「改活动」权限者可设置目的地', 403);
  }
  const b = req.body || {};
  const clear = b.clear === true || b.dest_lng === null || b.dest_lat === null;
  const applyGroup = b.apply_group === true;
  if (clear) {
    if (applyGroup && act.group_key) {
      db.prepare('UPDATE activities SET dest_lng = NULL, dest_lat = NULL WHERE group_key = ?').run(act.group_key);
    } else {
      db.prepare('UPDATE activities SET dest_lng = NULL, dest_lat = NULL WHERE id = ?').run(id);
    }
    recordEvent('activity_destination', req.user.id, id, '清除目的地');
    return ok(res, { message: '已清除目的地标记' });
  }
  const lng = Number(b.dest_lng);
  const lat = Number(b.dest_lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return bad(res, '目的地坐标无效');
  if (applyGroup && act.group_key) {
    db.prepare('UPDATE activities SET dest_lng = ?, dest_lat = ? WHERE group_key = ?').run(lng, lat, act.group_key);
  } else {
    db.prepare('UPDATE activities SET dest_lng = ?, dest_lat = ? WHERE id = ?').run(lng, lat, id);
  }
  recordEvent('activity_destination', req.user.id, id, '设置目的地');
  return ok(res, { message: '目的地标记已保存', dest_lng: lng, dest_lat: lat });
});

module.exports = router;
