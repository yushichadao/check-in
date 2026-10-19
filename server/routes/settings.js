'use strict';
const express = require('express');
const db = require('../db');
const cfg = require('../config');
const A = require('../auth');
const St = require('../settings');
const { NOTIFY_PREFS, notifyPrefVisible } = require('../config');
const { recordEvent } = require('../logger');
const mailer = require('../mailer');
const notify = require('../notify');
const S = require('../sessions');
const maintenance = require('../maintenance');
const zh = require('../zh');
const datalog = require('../datalog');

const router = express.Router();

/* ---------------- 普通学生端 / 未登录页可见的公开状态（维护态、隐私与公告文案等） ----------------
 * 必须**注册在下方鉴权中间件之前**：Express 按注册顺序执行，先命中并响应就不会再走鉴权。
 * （此前用「中间件里判断 req.path === '/public' 则放行」的写法，在 Express 5 下并未命中，
 *   导致注册 / 登录等未登录页读取该接口被判 401。）
 */
router.get('/public', (req, res) => {
  const ops = db.prepare("SELECT real_name, email FROM users WHERE role = 'ops' AND disabled = 0 LIMIT 1").get();
  const feedbackEmail = cfg.FEEDBACK_EMAIL || (ops && ops.email) || '';
  const about = {
    group_name: cfg.GROUP_NAME,
    // 系统全称（班级名 + 商品名，或 SYSTEM_NAME 指定的值）；关于页「系统名称」字段用它
    system_name: cfg.SYSTEM_NAME,
    version: cfg.APP_VERSION,
    ops: ops ? ops.real_name : cfg.OPS_INIT.real_name,
    email_available: mailer.isConfigured() && !!feedbackEmail,
    feedback_email_mask: feedbackEmail ? datalog.maskText(feedbackEmail) : ''
  };
  return ok(res, {
    product_name: cfg.PRODUCT_NAME,
    system_name: cfg.SYSTEM_NAME,
    group_name: cfg.GROUP_NAME,
    group_name_configured: cfg.isGroupNameConfigured(),
    location_verify_enabled: St.locationVerifyEnabled(),
    maintenance_enabled: St.maintenanceEnabled(),
    maintenance: St.maintenanceInfo(),
    privacy_text: St.privacyText(),
    announcement_text: St.announcementText(),
    auto_cover_enabled: St.autoCoverEnabled(),
    about
  });
});

// 其余接口仍须登录鉴权。/public 已在上面先行响应，不会再走到这里。
router.use((req, res, next) => {
  if (req.path === '/public') return next();
  return A.authRequired(req, res, next);
});

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

/** 当前用户对系统设置的可见/可配状态 */
function snapshot(req) {
  const lv = A.userLevel(req.user);
  const canSettings = A.hasPerm(req.user, 'SYS_SETTINGS');
  const prefs = St.notifyPrefs();
  const out = {};
  Object.keys(prefs).forEach(k => {
    const p = prefs[k];
    out[k] = Object.assign({}, p, {
      // 可配置 = 持有 SYS_SETTINGS 且自身层级 >= 该提醒的 min_level；必提醒恒不可改
      configurable: canSettings && !p.mandatory && lv >= p.min_level
    });
  });
  return {
    settings: St.all(),
    notify_prefs: out,
    location_verify_enabled: St.locationVerifyEnabled(),
    maintenance_enabled: St.maintenanceEnabled(),
    maintenance: St.maintenanceInfo(),
    privacy_text: St.privacyText(),
    announcement_text: St.announcementText(),
    announcement_updated_at: St.announcementUpdatedAt(),
    mail_configured: mailer.isConfigured(),
    // 自动代管：开关 + 当前缺口与代管规模（供运维端状态卡展示）
    auto_cover_enabled: St.autoCoverEnabled(),
    auto_cover: safeAutoCoverState(),
    my_level: lv,
    my_identity: req.user.role_title,
    // 班级级设置「最后修改者」+ 当前查看者是否需要确认沿用（后到岗的上级用）
    sys_editor: St.sysEditor(req.user),
    can: {
      settings: canSettings,
      reset_sys: canSettings,
      location_verify: A.hasPerm(req.user, 'FENCE_VERIFY'),
      maintenance: A.hasPerm(req.user, 'SYS_MAINTENANCE'),
      privacy: A.hasPerm(req.user, 'AUTH_PRIVACY'),
      auto_cover: req.user.role === 'ops'
    }
  };
}

/** 读取自动代管概览；任何异常都不得影响设置页加载 */
function safeAutoCoverState() {
  try { return require('../autocover').describe(); } catch (e) { return null; }
}

/* ---------------- 读取全部设置 ---------------- */
router.get('/', (req, res) => ok(res, snapshot(req)));

/* ---------------- 基础开关（补签 / 旧提醒开关） ---------------- */
router.post('/basic', A.requirePerm('SYS_SETTINGS'), (req, res) => {
  const b = req.body || {};
  St.BOOL_KEYS.forEach(k => { if (b[k] !== undefined) St.set(k, b[k] ? '1' : '0'); });
  St.markSysEditor(req.user);
  recordEvent('settings_update', req.user.id, null, '基本设置');
  return ok(res, { message: '设置已保存', data: snapshot(req) });
});

/* ---------------- 恢复班级级设置为出厂默认 ----------------
 * 场景：代管期间的班委留下的设置，上级到岗后希望推倒重来。
 * 仅运维者专属键（自动代管 / 定位查看 / 数据流打码）、维护与隐私文案不受影响。 */
router.post('/reset-sys', A.requirePerm('SYS_SETTINGS'), (req, res) => {
  St.resetSysSettings(req.user);
  recordEvent('settings_update', req.user.id, null, '恢复班级级系统设置为出厂默认');
  return ok(res, { message: '班级级系统设置已恢复出厂默认（运维者专属设置未改动）', data: snapshot(req) });
});

/* ---------------- 通知偏好（分层级，必提醒不可取消） ---------------- */
router.put('/notify', A.requirePerm('SYS_SETTINGS'), (req, res) => {
  const lv = A.userLevel(req.user);
  const prefs = (req.body || {}).prefs || {};
  let changed = 0;
  const denied = [];
  Object.keys(prefs).forEach(k => {
    const def = NOTIFY_PREFS[k];
    if (!def) return;
    if (def.mandatory) { denied.push(`${def.name}（必提醒，不可取消）`); return; }
    if (lv < def.min_level) { denied.push(`${def.name}（需更高层级配置）`); return; }
    if (St.setNotifyPref(k, !!prefs[k])) changed += 1;
  });
  if (changed) St.markSysEditor(req.user);
  recordEvent('notify_pref_update', req.user.id, null, `${changed} 项`);
  const msg = denied.length
    ? `已保存 ${changed} 项；${denied.length} 项未变更：${denied.join('、')}`
    : `已保存 ${changed} 项通知偏好`;
  return ok(res, { message: msg, data: snapshot(req) });
});

/* ---------------- 个人通知渠道偏好（自服务：任意登录用户改自己的） ---------------- */
router.get('/me/notify', (req, res) => {
  return ok(res, { prefs: St.userNotifyPrefs(req.user.id, req.user) });
});

router.put('/me/notify', (req, res) => {
  const prefs = (req.body || {}).prefs || {};
  let changed = 0;
  const denied = [];
  Object.keys(prefs).forEach(k => {
    const def = NOTIFY_PREFS[k];
    if (!def) { denied.push(`${k}（未知类型）`); return; }
    if (def.mandatory) { denied.push(`${def.name}（必提醒，不可关闭）`); return; }
    if (!notifyPrefVisible(k, req.user)) { denied.push(`${def.name}（仅学生可收到）`); return; }
    if (St.setUserNotifyPref(req.user.id, k, prefs[k], req.user)) changed += 1;
    else denied.push(`${def.name}（渠道无效）`);
  });
  // 注：修改「自己的」通知偏好属于个人隐私行为，不写入数据流审计（避免留痕侵犯用户隐私）
  const msg = denied.length
    ? `已保存 ${changed} 项；${denied.length} 项未变更：${denied.join('、')}`
    : `已保存 ${changed} 项个人通知偏好`;
  return ok(res, { message: msg, prefs: St.userNotifyPrefs(req.user.id) });
});

/* ---------------- 定位核验总开关（需「启动活动范围核验」权限） ----------------
 * 基线仅辅导员（R3）及以上（含运维者）持有；缺辅导员时由自动代管下放至小班主任 / 班委，
 * 故此处只判 hasPerm(FENCE_VERIFY)（min=3 已保证基线门槛，授予 / 代管者同样放行）。 */
router.put('/location-verify', (req, res) => {
  if (!A.hasPerm(req.user, 'FENCE_VERIFY')) {
    return res.status(403).json({
      error: '定位核验总开关需持有「启动活动范围核验」权限（辅导员及以上，或由自动代管下放）', perm: 'FENCE_VERIFY', need_order: true
    });
  }
  const on = !!(req.body || {}).enabled;
  St.setLocationVerify(on);
  St.markSysEditor(req.user);
  recordEvent('location_verify_switch', req.user.id, null, zh.onOff(on));
  return ok(res, { message: on ? '已开启定位核验' : '已关闭定位核验（位置上传与活动范围核验均禁用）', data: snapshot(req) });
});

/* ---------------- 自动代管总开关（仅运维者；切换后立即重算） ----------------
 * 独立接口的理由：该键刻意不进 BOOL_KEYS，避免被 POST /basic（仅需 SYS_SETTINGS）改写造成越权旁路。 */
router.put('/auto-cover', A.requireRole('ops'), (req, res) => {
  const on = !!(req.body || {}).enabled;
  St.setAutoCover(on);
  St.markSysEditor(req.user);
  recordEvent('auto_cover_switch', req.user.id, null, zh.onOff(on));
  // 切换后立即重算：关闭 → 全部收回；开启 → 依当前缺口重新授予
  let result = null;
  try { result = require('../autocover').syncAutoCover({ reason: on ? 'switch_on' : 'switch_off' }); } catch (e) { /* 交由巡检兜底 */ }
  return ok(res, {
    message: on ? '已开启自动代管（缺上级时班委自动代行其基线权力）' : '已关闭自动代管（已收回全部代管权限）',
    enabled: on, result, data: snapshot(req)
  });
});

/* ---------------- 管理端定位查看全局开关（仅运维者） ---------------- */
router.put('/manager-location-view', A.requireRole('ops'), (req, res) => {
  const on = !!(req.body || {}).enabled;
  St.set('manager_location_view', on ? '1' : '0');
  St.markSysEditor(req.user);
  recordEvent('manager_location_view_switch', req.user.id, null, zh.onOff(on));
  return ok(res, { message: on ? '已允许管理端查看学生定位' : '已关闭管理端定位查看', enabled: on, data: snapshot(req) });
});

/* ---------------- 维护模式（排期 / 立即开启 / 运维者结束） ---------------- */
router.put('/maintenance', A.requirePerm('SYS_MAINTENANCE'), async (req, res) => {
  const b = req.body || {};
  const isOps = A.isWildcard(req.user);

  // 1) 保存维护窗口（起止时间与说明）
  if (b.start_at !== undefined || b.end_at !== undefined || b.notice !== undefined) {
    const start = b.start_at === '' || b.start_at === null ? null : (b.start_at !== undefined ? Number(b.start_at) : undefined);
    const end = b.end_at === '' || b.end_at === null ? null : (b.end_at !== undefined ? Number(b.end_at) : undefined);
    // 排期必须有起止时间：仅当起止时间明确给定（非 undefined/null）时才视为保存排期；
    // 仅传 notice（如「立即开启维护」附带说明）而 start/end 未提供时，不算排期，避免误判起止时间无效
    const settingSchedule = (start !== null && start !== undefined) || (end !== null && end !== undefined);
    if (settingSchedule) {
      if (start === null || end === null) return bad(res, '保存维护排期必须设置开始时间与预计结束时间');
      if (!Number.isFinite(start) || !Number.isFinite(end)) return bad(res, '维护排期的起止时间无效');
      if (end <= start) return bad(res, '预计结束时间必须晚于开始时间');
    }
    St.setMaintenanceWindow({ start_at: start, end_at: end, notice: b.notice });
  }

  // 2) 开启维护（可人工立即开启；也可等到排期时间由调度器自动开启）
  if (b.enabled === true) {
    const note = (b.notice && String(b.notice).trim()) ? String(b.notice).trim().slice(0, 300) : (b.immediate ? '立即开启维护' : '手动开启维护');
    const r = await maintenance.enter(req.user, note);
    recordEvent('maintenance_switch', req.user.id, null, zh.onOff(true));
    return ok(res, { message: '已进入维护模式（非运维者在线账号已强制下线）', data: snapshot(req), result: r });
  }

  // 3) 结束维护：只能由运维端执行
  if (b.enabled === false) {
    if (!isOps) {
      return res.status(403).json({ error: '结束维护只能由运维端操作', perm: 'OPS_MAINTENANCE', need_ops: true });
    }
    const r = await maintenance.exit(req.user, '手动结束');
    recordEvent('maintenance_switch', req.user.id, null, zh.onOff(false));
    return ok(res, { message: '维护已结束，原在线账号已自动恢复上线', data: snapshot(req), result: r });
  }

  // 4) 仅更新排期
  return ok(res, { message: '维护安排已保存（到点将自动进入维护）', data: snapshot(req) });
});

/* ---------------- 隐私告知文案（AUTH_PRIVACY，仅运维者） ---------------- */
router.put('/privacy', A.requirePerm('AUTH_PRIVACY'), (req, res) => {
  const text = String((req.body || {}).text || '').slice(0, 4000);
  const summary = String((req.body || {}).summary || '').slice(0, 200);
  St.setPrivacyText(text);
  recordEvent('privacy_update', req.user.id, null, summary || '文案更新');
  const users = db.prepare('SELECT * FROM users WHERE disabled = 0').all();
  notify.notifyPrivacyUpdate(users, { summary: summary || '隐私告知文案已更新' }).catch(() => {});
  return ok(res, { message: '隐私告知已更新并通知全体用户', data: snapshot(req) });
});

/* ---------------- 公告栏（仅运维者） ---------------- */
router.put('/announcement', A.requirePerm('AUTH_PRIVACY'), (req, res) => {
  const text = String((req.body || {}).text || '').slice(0, 4000).trim();
  const summary = String((req.body || {}).summary || '').slice(0, 200).trim();
  if (!text) return bad(res, '公告内容不能为空');
  St.setAnnouncementText(text);
  St.set('announcement_updated_at', String(Date.now()));
  recordEvent('announcement_update', req.user.id, null, summary || '发布公告');
  const users = db.prepare('SELECT * FROM users WHERE disabled = 0').all();
  notify.notifyAnnouncement(users, { summary: summary || '新公告已发布' }).catch(() => {});
  return ok(res, { message: '公告已发布并通知全体用户', data: snapshot(req) });
});

module.exports = router;
