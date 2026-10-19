'use strict';
const db = require('./db');
const mailer = require('./mailer');
const St = require('./settings');
const Sess = require('./sessions');
const { windowText } = require('./geo');
const { log } = require('./logger');
const { ALL_PERMS, NOTIFY_PREFS } = require('./config');
const { MAIL } = require('./mailtypes');

/* ===================== 通知失败统一隔离（safeNotify） =====================
 * 通知（邮件 / 站内消息）属非关键路径：任何异常都不得影响登录、改密、注册激活、
 * 审批等主流程。历史上的事故是 notifySecurity 被当作自由标识符调用抛 ReferenceError，
 * 因发生在同步阶段，调用处的 .catch() 兜不住 → 直接把「异地登录」打成 500。
 *
 * safeNotify(fn, label) 保证：
 *   - 同步抛错 → 捕获并降级为 { failed, reason }；
 *   - 返回 Promise → 永不 reject（拒绝同样降级为 { failed, reason }）；
 *   - 返回形态尽量保持不变（同步函数仍同步返回，异步函数仍返回 Promise）。
 */
function safeNotify(fn, label) {
  return function safeNotified(...args) {
    try {
      const r = fn.apply(this, args);
      if (r && typeof r.then === 'function') {
        return r.then(v => v, e => {
          try { log('warn', 'notify failed: ' + ((e && e.message) || e), { label }); } catch (x) { /* 忽略 */ }
          return { failed: true, reason: (e && e.message) || String(e) };
        });
      }
      return r;
    } catch (e) {
      try { log('warn', 'notify threw: ' + ((e && e.message) || e), { label }); } catch (x) { /* 忽略 */ }
      return { failed: true, reason: (e && e.message) || String(e) };
    }
  };
}

/** 签到窗口（本地时间文本，精确到分），用于提醒邮件里明确「什么时候能签到」 */
function windowRow(a) {
  try {
    return { label: '签到窗口', value: windowText(a) };
  } catch (e) { return null; }
}

/** 时间格式化（邮件里使用） */
function fmtTime(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 单次签到在文案里的叫法：长期活动下的叫「子活动」，临时活动单次叫「本次签到」 */
function sessionTerm(a) {
  return (a && a.parent_id) ? '该子活动' : '本次签到';
}

function getActivity(activityId) {
  return db.prepare(`
    SELECT a.*, f.name AS fence_name
    FROM activities a LEFT JOIN fences f ON f.id = a.fence_id
    WHERE a.id = ?
  `).get(activityId);
}

/**
 * 邮件里统一带上活动信息。
 * 注意：『地点』是活动自身的文本字段（管理端在活动管理里填写）；
 *       『活动范围』是签到记录用的多边形，两者互不相干，活动范围名不是地点。
 */
function activityRows(a) {
  if (!a) return [];
  return [
    { label: '活动', value: a.title },
    { label: '时间', value: `${fmtTime(a.start_time)} ~ ${fmtTime(a.end_time)}` },
    a.location ? { label: '地点', value: a.location } : null,
    { label: '活动范围', value: a.fence_id ? (a.fence_name || '（已删除）') : '未设置' },
    a.remark ? { label: '备注', value: a.remark } : null
  ].filter(Boolean);
}

const feedbackFooter = '如有疑问请联系你的辅导员或班委。';

/* ===================== 提醒类（NT_*）内容 ===================== */

const buildPreStart = (a) => ({
  title: '签到提醒：签到即将开始',
  intro: '以下活动的签到窗口将在 5 分钟内开放，请提前准备，开放后尽快完成签到。',
  rows: activityRows(a).concat([windowRow(a)].filter(Boolean)),
  footer: '活动范围仅供参考，不在范围内也可正常签到；是否上传定位由你自愿授权，不授权也能正常签到。'
});

const buildStart = (a) => ({
  title: '签到提醒：签到已开始',
  intro: '以下活动的签到窗口已开放，请尽快完成签到。',
  rows: activityRows(a).concat([windowRow(a)].filter(Boolean)),
  footer: '活动范围仅供参考，不在范围内也可正常签到；是否上传定位由你自愿授权，不授权也能正常签到。'
});

const buildAbsent = (a) => ({
  title: '签到提醒：未检测到你的签到记录',
  intro: '以下活动已结束，但未检测到你的签到记录。如确有到课，可在系统中提交补签申请并等待管理员审核。',
  rows: activityRows(a),
  footer: '如已请假或已签到请忽略本邮件。'
});

const buildActCreate = (a) => ({
  title: '新活动已发布',
  intro: '管理端刚发布了一个活动，请留意签到时间。',
  rows: activityRows(a).concat([windowRow(a)].filter(Boolean)),
  footer: '如该活动不面向你，请忽略本邮件。'
});

const buildActStart = (a) => ({
  title: '活动开始提醒',
  intro: '以下活动已开始，签到窗口如已开放请尽快完成签到。',
  rows: activityRows(a).concat([windowRow(a)].filter(Boolean)),
  footer: '活动范围仅供参考，不在范围内也可正常签到；是否上传定位由你自愿授权，不授权也能正常签到。'
});

const buildReminder = (a, minutes) => ({
  title: `签到提醒：距活动开始还有 ${minutes} 分钟`,
  intro: `以下活动将在约 ${minutes} 分钟后开始，请提前准备。`,
  rows: activityRows(a).concat([windowRow(a)].filter(Boolean)),
  footer: '签到窗口开放后即可提交；是否上传定位由你自愿授权，不授权也能正常签到。'
});

const buildLeaveResult = (a, approved, reply) => ({
  title: approved ? '请假申请已通过' : '请假申请未通过',
  intro: approved
    ? '你提交的请假申请已由管理员审核通过。'
    : `你提交的请假申请未通过审核，${sessionTerm(a)}将按缺勤记录。`,
  rows: activityRows(a).concat(reply ? [{ label: '审核留言', value: reply }] : []),
  footer: feedbackFooter
});

const buildMakeupResult = (a, approved, reply) => ({
  title: approved ? '补签申请已通过' : '补签申请未通过',
  intro: approved
    ? `你提交的补签申请已通过审核，${sessionTerm(a)}已记为已签到。`
    : `你提交的补签申请未通过审核，${sessionTerm(a)}仍按缺勤记录。`,
  rows: activityRows(a).concat(reply ? [{ label: '审核留言', value: reply }] : []),
  footer: feedbackFooter
});

/* ===================== 工单 / 授权 / 系统类邮件内容 ===================== */

function permName(code) {
  const p = ALL_PERMS[code];
  return p ? p.name : code;
}

function whoLine(u) {
  if (!u) return '未知账号';
  return `${u.real_name}（${u.role_title || '-'}${u.student_id ? ' · ' + u.student_id : ''}）`;
}

/** 工单类型 → 中文（perm 权限申请 / info 信息修改·反馈） */
const WO_KIND_TEXT = { perm: '权限申请', info: '信息修改 / 反馈' };

const buildWoSubmitted = (v) => {
  const isInfo = v.kind === 'info';
  return {
    title: isInfo ? '新工单待处理：信息修改 / 反馈' : '新权限工单待审批',
    intro: isInfo
      ? '有下级账号提交了「信息修改 / 反馈」工单，请在系统内「工单审批」中处理。'
      : '有下级账号提交了权限申请，请在系统内「工单审批」中处理。',
    rows: [
      { label: '申请人', value: whoLine(v.applicant) },
      { label: '工单类型', value: WO_KIND_TEXT[v.kind] || WO_KIND_TEXT.perm },
      isInfo ? null : { label: '申请权限', value: `${permName(v.perm_code)}（${v.perm_code}）` },
      { label: isInfo ? '内容' : '申请理由', value: v.reason || '（未填写）' }
    ].filter(Boolean),
    footer: '该工单超时未处理将自动驳回并通知申请人。'
  };
};

const buildWoApproved = (v) => ({
  title: '权限工单已批准',
  intro: '你提交的权限申请已通过审批，相应权限已开通。',
  rows: [
    { label: '权限', value: `${permName(v.perm_code)}（${v.perm_code}）` },
    { label: '授予人', value: whoLine(v.handler) },
    { label: '有效期至', value: v.until ? fmtTime(v.until) : '长期有效' },
    v.reply ? { label: '审批留言', value: v.reply } : null
  ].filter(Boolean),
  footer: '请仅在职责范围内使用该权限，所有操作均会记入审计日志。'
});

const buildWoRejected = (v) => ({
  title: '权限工单已驳回',
  intro: '你提交的权限申请未通过审批。',
  rows: [
    { label: '权限', value: `${permName(v.perm_code)}（${v.perm_code}）` },
    { label: '处理人', value: whoLine(v.handler) },
    { label: '驳回理由', value: v.reply || '（未填写）' }
  ],
  footer: '如有异议可补充理由后重新提交工单。'
});

const buildWoTimeout = (v) => {
  const isInfo = v.kind === 'info';
  return {
    title: isInfo ? '工单超时已自动关闭' : '权限工单超时已自动驳回',
    intro: isInfo
      ? `你的「信息修改 / 反馈」工单在 ${v.hours} 小时内未获处理，已按超时自动关闭。`
      : `你的权限申请在 ${v.hours} 小时内未获审批，已按超时自动驳回。`,
    rows: [
      { label: '工单类型', value: WO_KIND_TEXT[v.kind] || WO_KIND_TEXT.perm },
      isInfo ? null : { label: '权限', value: `${permName(v.perm_code)}（${v.perm_code}）` },
      { label: '提交时间', value: fmtTime(v.created_at) }
    ].filter(Boolean),
    footer: isInfo ? '如仍需处理，请重新提交工单并说明紧急程度。' : '如仍需该权限，请重新提交工单并注明紧急程度。'
  };
};

const buildGrantNotice = (v) => ({
  title: '你被授予了新权限',
  intro: '上级账号向你下放了以下权限。',
  rows: [
    { label: '权限', value: `${permName(v.perm_code)}（${v.perm_code}）` },
    { label: '授予人', value: whoLine(v.granter) },
    { label: '有效期至', value: v.until ? fmtTime(v.until) : '长期有效' }
  ],
  footer: '请仅在职责范围内使用；该权限可被授予人随时收回。'
});

const buildMaintenance = (v) => (v.phase === 'pre' ? {
  title: '系统维护预告',
  intro: '系统即将进入维护模式，期间部分功能可能不可用，请提前保存正在进行的操作。',
  rows: [
    { label: '预计开始', value: v.start_at || '稍后' },
    { label: '预计恢复', value: v.restore_at || '维护完成后' }
  ],
  footer: '维护结束后会再次通知你。'
} : {
  title: '系统维护已结束',
  intro: '系统维护已完成，功能已恢复。',
  rows: [{ label: '恢复时间', value: v.restore_at || fmtTime(Date.now()) }],
  footer: '如遇到异常请联系管理员。'
});

const buildSessionKilled = (v) => ({
  title: '你的会话已被强制结束',
  intro: '因系统维护或管理员操作，你的一台设备会话已被结束，需要重新登录。',
  rows: [
    { label: '理由', value: v.reason || '系统维护' },
    { label: '设备', value: v.device || '（未知设备）' }
  ],
  footer: '你正在填写的内容已保存为草稿，重新登录后可继续。'
});

const buildPrivacyUpdate = (v) => ({
  title: '隐私告知已更新',
  intro: '系统的隐私告知文案发生变更，请重新阅读并确认。',
  rows: [{ label: '变更摘要', value: v.summary || '（见系统内隐私告知）' }],
  footer: '登录后在「隐私告知」弹窗中确认即可继续使用。'
});

const buildAnnouncement = (v) => ({
  title: '新公告',
  intro: '系统发布了新公告，请登录后查看。',
  rows: [{ label: '摘要', value: v.summary || '（见系统内公告栏）' }],
  footer: '登录后会在首页弹窗中展示，确认后不再弹出。'
});

const buildAccountNotice = (v) => ({
  title: '你的账号信息已变更',
  intro: '管理员 / 运维者对你的账号做了变更，请知悉。',
  rows: (v.items || []).map(x => ({ label: x.label, value: x.value })),
  footer: '如非你所知的操作，请立即联系管理员。'
});

const buildDevAlert = (v) => ({
  title: '运维告警',
  intro: '系统检测到异常，请及时排查。',
  rows: [{ label: '详情', value: v.detail || '（无）' }],
  footer: '本邮件仅发送给运维者账号。'
});

/* ===================== 安全类邮件内容（密码 / 登录） ===================== */

const buildPwChanged = (v) => ({
  title: '密码安全提醒：你的登录密码已变更',
  intro: '你的账号登录密码刚刚发生了变更。如是你本人操作，请忽略本邮件；否则请立即修改密码并联系管理员。',
  rows: [
    { label: '变更方式', value: v.method || '密码变更' },
    { label: '时间', value: fmtTime(Date.now()) },
    v.ip ? { label: '来源 IP', value: v.ip } : null,
    v.device ? { label: '设备', value: v.device } : null
  ].filter(Boolean),
  footer: '为保障账号安全，请勿将验证码或密码告知他人；如非本人操作，请尽快在「账号安全」中修改密码。'
});

const buildLoginRemote = (v) => ({
  title: '安全提醒：检测到异地登录',
  intro: '你的账号刚刚从一个新位置 / 设备登录。如是你本人操作，请忽略本邮件；否则请立即修改密码并联系管理员。',
  rows: [
    { label: '设备', value: v.device || '（未知设备）' },
    { label: '时间', value: fmtTime(Date.now()) },
    v.ip ? { label: '来源 IP', value: v.ip } : null
  ].filter(Boolean),
  footer: '如非本人操作，请立即在「账号安全」中修改密码，并联系管理员冻结账号。'
});

/* ===================== 自动代管（缺上级自动补位） ===================== */

/** 权限码 → 中文名（代管通知里逐项列出，便于本人核对） */
function permList(perms) {
  const arr = Array.isArray(perms) ? perms : [];
  if (!arr.length) return '（无）';
  return arr.map(c => `${permName(c)}（${c}）`).join('、');
}

const buildAutoCoverGrant = (v) => ({
  title: '自动代管已开通：你暂时行使上级管理权力',
  intro: `系统检测到班级里暂无在岗的${(v.levels || []).map(l => (l === 'r2' ? '小班主任' : '辅导员')).join('、') || '上级'}，` +
    '已自动为你开通其基线管理权限，以免事务停滞。上级账号到岗后会自动收回并再次通知你。',
  rows: [
    { label: '生效范围', value: (v.levels || []).map(l => (l === 'r2' ? '小班主任层（R2）' : '辅导员层（R3）')).join('、') || '上级层' },
    { label: '开通项数', value: `${(v.perms || []).length} 项` },
    { label: '权限明细', value: permList(v.perms) },
    { label: '时间', value: fmtTime(Date.now()) }
  ],
  footer: '注意：代管权限仅供你在岗使用，不可再向下授权；上级账号到岗后本批权限会立即失效。'
});

const buildAutoCoverRevoke = (v) => ({
  title: '自动代管已收回',
  intro: '上级账号已到岗（或管理员关闭了自动代管），你此前的代管权限已自动收回，不再可用。',
  rows: [
    { label: '收回项数', value: `${(v.perms || []).length} 项` },
    { label: '权限明细', value: permList(v.perms) },
    { label: '理由', value: v.reason_text || '上级账号已到岗' },
    { label: '时间', value: fmtTime(Date.now()) }
  ],
  footer: '如仍需相应权限，可由上级通过「向下授权」重新授予。'
});

/* ===================== 工单待办催办 ===================== */

const buildWoReminder = (v) => ({
  title: '工单待办催办',
  intro: '你有一条待处理的权限工单尚未审批，请尽快在系统内「工单审批」中处理。',
  rows: [
    { label: '申请人', value: v.applicant ? whoLine(v.applicant) : '（未知）' },
    { label: '申请内容', value: v.kind === 'info' ? '信息修改 / 反馈' : `${permName(v.perm_code)}（${v.perm_code}）` },
    { label: '已等待', value: `${Math.round(v.ageMin || 0)} 分钟` },
    v.reason ? { label: '申请理由', value: v.reason } : null
  ].filter(Boolean),
  footer: '工单超时未处理将自动驳回并通知申请人。'
});

/* ===================== 申诉 / 回执类邮件内容 ===================== */

/**
 * 申诉待审核（初审或终审）→ 通知有裁决权的上级。
 * @param {{title,body,intro,label,applicant,activity,reason,firstResult,footer,id}} v
 */
const buildAppealSubmitted = (v) => ({
  title: v.title || '新的申诉待审核',
  intro: v.intro || '有普通学生提交了申诉，请在管理端「申诉审核」中处理。',
  rows: [
    { label: '申请人', value: whoLine(v.applicant) },
    v.activity ? { label: '活动', value: v.activity.title } : null,
    { label: '类型', value: v.label || '申诉' },
    v.firstResult ? { label: '初审结果', value: v.firstResult } : null,
    v.reason ? { label: '申诉理由', value: v.reason } : null
  ].filter(Boolean),
  footer: v.footer || '初审裁决后本级不可更改；普通学生提出申诉后才进入终审。'
});

/** 申诉内沟通回复 → 通知对方 */
const buildAppealReply = (v) => ({
  title: v.title || '你的申诉有新回复',
  intro: v.intro || '申诉沟通中有新回复，请到系统内查看详情。',
  rows: [
    { label: '类型', value: v.label || '申诉' },
    { label: '回复人', value: whoLine(v.replier) },
    { label: '内容', value: v.body || '' }
  ],
  footer: v.footer || '可在系统内继续回复沟通。'
});

/** 网站问题反馈 → 转发给运维者登记的反馈邮箱 */
const buildFeedback = (fb) => {
  const typeText = { bug: '功能异常', suggest: '功能建议', other: '其他' }[fb.type] || '反馈';
  return {
    title: `网站问题反馈 · ${typeText}`,
    intro: fb.content || '',
    rows: [
      { label: '反馈人', value: `${fb.reporter_name || '-'}（${fb.reporter_role || '-'}）` },
      { label: '标题', value: fb.subject || '' },
      { label: '类型', value: typeText },
      { label: '联系方式', value: fb.contact || '（未留）' }
    ],
    footer: '本邮件由系统自动转发自「反馈网站问题」入口。'
  };
};

/** 通用操作回执（管理员补签 / 退签 / 代请假、工单提交回执等） */
const buildReceipt = (v) => ({
  title: v.title || '操作回执',
  intro: v.intro || '',
  rows: (v.rows || []).filter(Boolean),
  footer: v.footer || '如有疑问请联系你的辅导员或班委。'
});

/* ===================== 发送 ===================== */

function alreadySent(kind, activityId, userId) {
  return !!db.prepare('SELECT 1 FROM notify_log WHERE kind = ? AND activity_id = ? AND user_id = ?')
    .get(kind, activityId, userId);
}

function markSent(kind, activityId, userId) {
  try {
    db.prepare('INSERT OR IGNORE INTO notify_log (kind, activity_id, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, activityId, userId, Date.now());
  } catch (e) { /* 忽略 */ }
}

/** 直接发送（审核结果 / 工单 / 系统类，允许多次）。actor 用于数据流留痕 */
async function sendDirect(user, opts, mailKind, actor) {
  if (!user || !user.email) return { skipped: true, reason: '未登记邮箱' };
  const o = Object.assign({}, opts, { actor: actor || (opts && opts.actor) || null, subject_id: user.id });
  try {
    return await mailer.sendNotice(user.email, o, mailKind);
  } catch (e) {
    log('warn', 'mail send failed: ' + e.message, { to: user.email, kind: mailKind || '' });
    return { failed: true, reason: e.message };
  }
}

/** 去重发送（提醒类：同一次提醒只发一封） */
async function sendOnce(kind, activity, user, opts, mailKind) {
  if (!user || !user.email) return { skipped: true, reason: '未登记邮箱' };
  if (alreadySent(kind, activity.id, user.id)) return { skipped: true, reason: '已发送过' };
  markSent(kind, activity.id, user.id);
  return sendDirect(user, opts, mailKind);
}

/* ===================== 站内消息（分层提醒：在线活动 → 仅站内，离线/不活动 → 站内+邮件） ===================== */

/** 「活动」判定窗口：最近一次心跳在该时长内，视为该设备正在被使用（前端每 20s 轮询 + 心跳续期） */
const ACTIVE_MS = 2 * 60 * 1000;

/**
 * 内置「必邮」消息类型：只能走邮件，不受任何偏好开关影响，也不写站内消息。
 * 这是硬编码的系统行为（验证码 / 运维告警），不对外提供配置项。
 * 名单来自邮件类型总表（server/mailtypes.js 中 mailOnly=true 的类型）。
 */
const BUILTIN_MAIL_ONLY = new Set(require('./mailtypes').mailOnlyTypes());
function isBuiltinMailOnly(kind) { return BUILTIN_MAIL_ONLY.has(String(kind || '')); }

/**
 * 解析某账号对某类通知的「自选渠道」：
 *  - 必提醒（mandatory）：恒为 'both'（站内 + 邮件，不可被个人关闭）；
 *  - 否则读个人偏好表，未设置回退 'both'（默认站内 + 邮件）。
 * 返回 'both' | 'inbox' | 'off'。安全类（mailOnly）由调用方单独处理，不在此锁定。
 */
function resolveChannel(user, kind) {
  if (!user) return 'both';
  const def = NOTIFY_PREFS[String(kind || '')];
  if (def && def.mandatory) return 'both';
  const uc = St.userNotifyChannel(user.id, String(kind || ''));
  return uc || 'both';
}

/** 该账号当前是否有在线会话（不含「是否活跃」） */
function isUserOnline(userId) {
  const rows = db.prepare('SELECT last_seen, online, ended_at FROM sessions WHERE user_id = ?').all(userId);
  const now = Date.now();
  return rows.some(r => Sess.isOnline(r, now));
}

/** 该账号是否「任意设备在线且活动」——决定是否只发站内、不发邮件 */
function isUserActive(userId) {
  const rows = db.prepare('SELECT last_seen, online, ended_at FROM sessions WHERE user_id = ?').all(userId);
  const now = Date.now();
  return rows.some(r => Sess.isOnline(r, now) && (now - Number(r.last_seen || 0)) < ACTIVE_MS);
}

/** 写入站内消息（在线时前端轮询即弹出 toast） */
function pushInbox(user, v) {
  if (!user) return { skipped: true, reason: '无目标用户' };
  try {
    const info = db.prepare(`
      INSERT INTO notifications (user_id, level, kind, title, body, ref_type, ref_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, v.level || 'info', v.kind || '', String(v.title || '系统消息').slice(0, 120),
      String(v.body || '').slice(0, 1000), v.ref_type || null, v.ref_id || null, Date.now());
    return { inbox: Number(info.lastInsertRowid) };
  } catch (e) {
    return { failed: true, reason: e.message };
  }
}

/**
 * 统一送达：按「是否有设备在线且活动」自动选择渠道。
 *  - 任意设备在线且活动：只发站内消息端（前端轮询弹 toast）；
 *  - 全部设备离线，或在线但不活动：站内消息端 + 邮件 都发；
 *  - payload.mailOnly=true（必须用邮件发送的信息）：只发邮件，不写站内。
 * 所有投递结果都会写入数据流留痕。
 */
async function deliver(user, kind, payload) {
  if (!user) return { skipped: true, reason: '无目标用户' };
  const p = payload || {};
  const prefOn = kind ? St.notifyEnabled(kind) : true;
  const active = isUserActive(user.id);
  const actor = p.actor || null;
  // 个人渠道偏好：'both'=站内+邮件 / 'inbox'=仅站内 / 'off'=完全不接收
  const userChannel = resolveChannel(user, kind);

  let inbox = { skipped: true, reason: '未写站内' };
  let mail = { skipped: true, reason: '未发送邮件' };
  let channel = 'none';

  // 内置必邮类型（验证码 / 运维告警）自动按「只发邮件」处理
  const mailOnly = p.mailOnly === true || isBuiltinMailOnly(p.mail && p.mail.kind);
  // 强制邮件：系统级群发需要「人人都有邮件」时，即使在线活跃也发邮件（站内 + 邮件）
  const forceMail = p.forceMail === true;

  // 个人已关闭该通知（安全类 mailOnly 不受影响，恒发）
  if (userChannel === 'off' && !mailOnly) {
    return { skipped: true, reason: '你已关闭该通知', channel: 'none' };
  }

  if (mailOnly) {
    if (p.mail) {
      mail = await sendDirect(user, p.mail.opts, p.mail.kind || kind, actor);
      if (!mail.skipped) channel = 'email';
    }
  } else {
    inbox = pushInbox(user, {
      level: p.level || 'info', kind, title: p.title, body: p.body,
      ref_type: p.ref_type, ref_id: p.ref_id
    });
    channel = 'inbox';
    // 仅当个人选了「站内+邮件」且（强制邮件 或 全部离线/不活跃）时才补发邮件
    if (prefOn && p.mail && userChannel === 'both' && (forceMail || !active)) {
      mail = await sendDirect(user, p.mail.opts, p.mail.kind || kind, actor);
      if (!mail.skipped) channel = 'both';
    }
  }

  // 数据流留痕
  try {
    require('./datalog').record({
      category: 'notify', action: kind || 'notify', actor, subject_id: user.id,
      target: whoLine(user), detail: p.title || '', channel
    });
  } catch (e) { /* 忽略 */ }

  return { active, online: isUserOnline(user.id), inbox, mail, channel };
}

/** 站内回执（如：工单提交成功）——只写站内消息端并留痕，不触发邮件 */
function notifyInbox(user, v) {
  const inbox = pushInbox(user, {
    level: (v && v.level) || 'notice', kind: v && v.kind,
    title: v && v.title, body: v && v.body,
    ref_type: v && v.ref_type, ref_id: v && v.ref_id
  });
  try {
    require('./datalog').record({
      category: 'notify', action: (v && v.kind) || 'receipt', actor: (v && v.actor) || null,
      subject_id: user ? user.id : null,
      target: whoLine(user), detail: (v && v.title) || '', channel: 'inbox'
    });
  } catch (e) { /* 忽略 */ }
  return inbox;
}

/** 按 NT_* 开关发送提醒（mandatory 恒发；可选类受管理员配置控制）。
 *  走统一 deliver：在线且活动时只写站内消息；离线/不活动时按个人渠道偏好决定是否发邮件
 *  （个人可把此类提醒设为「仅站内」或「关闭」，避免邮件骚扰）。 */
async function notifyPref(kind, activity, user, opts, mailKind) {
  if (!St.notifyEnabled(kind)) return { skipped: true, reason: '该提醒已关闭' };
  if (alreadySent(kind, activity.id, user.id)) return { skipped: true, reason: '已发送过' };
  markSent(kind, activity.id, user.id);
  return deliver(user, kind, {
    level: 'notice',
    title: opts && opts.title,
    body: (opts && opts.intro) || '',
    ref_type: 'activity', ref_id: activity ? activity.id : null,
    mail: { kind: mailKind || kind, opts }
  });
}

/** 直接类通知（工单 / 授权 / 账号 / 维护）也走开关；未知类型默认发送 */
async function notifyNow(kind, user, opts, mailKind) {
  if (kind && !St.notifyEnabled(kind)) return { skipped: true, reason: '该提醒已关闭' };
  return sendDirect(user, opts, mailKind || kind);
}

/** 批量发送（维护预告 / 隐私告知变更等）：同样按在线状态分层，在线走站内 */
async function notifyMany(kind, users, build, mailKind, level) {
  if (kind && !St.notifyEnabled(kind)) return { skipped: true, reason: '该提醒已关闭' };
  const out = [];
  for (const u of users || []) {
    const opts = build(u);
    out.push(await deliver(u, kind, {
      level: level || 'urgent',
      title: opts && opts.title ? opts.title : '系统消息',
      body: (opts && opts.intro) ? opts.intro : '',
      mail: { kind: mailKind || kind, opts }
    }));
  }
  return { sent: out.length };
}

/* ===================== 系统级群发（收件人由系统自动确定，管理员只控类型总开关） ===================== */

/**
 * 自动受众：系统级群发不提供人工挑人，由系统按场景解析收件人。
 *  - all      全部未注销账号
 *  - online   当前在线账号（去重）
 *  - students 全部普通学生
 *  - managers 全部管理号
 *  - byIds    指定账号集合
 */
const audiences = {
  all: () => db.prepare('SELECT * FROM users WHERE disabled = 0').all(),
  online: () => db.prepare(`
    SELECT DISTINCT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.online = 1 AND u.disabled = 0
  `).all(),
  students: () => db.prepare("SELECT * FROM users WHERE role = 'normal' AND disabled = 0").all(),
  managers: () => db.prepare("SELECT * FROM users WHERE role = 'manager' AND disabled = 0").all(),
  byIds: (ids) => {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return [];
    return db.prepare(`SELECT * FROM users WHERE id IN (${list.map(() => '?').join(',')}) AND disabled = 0`).all(...list);
  }
};

function resolveAudience(aud) {
  if (Array.isArray(aud)) return aud;                        // 已解析好的用户数组
  if (typeof aud === 'function') return aud() || [];         // 自定义解析（如某次活动的应到普通学生）
  if (typeof aud === 'string' && audiences[aud]) return audiences[aud]();
  return audiences.all();                                    // 默认全员
}

/**
 * 系统级群发邮件 / 站内消息。
 *  - 收件人：由系统自动解析（audience），不提供人工选人；
 *  - 内容类型总开关：管理员层通过 NT_* 偏好控制（mandatory 恒开，不可关）；
 *  - 逐人投递仍遵循统一规则：任意设备在线且活动 → 仅站内；全部离线/不活动 → 站内 + 邮件；
 *    mailOnly=true 时强制只发邮件（用于「必须邮件送达」的系统通知）。
 * @param {string} kind 内容类型（NT_*）
 * @param {{audience?:string|Function|Array, title?:string, body?:string,
 *          build?:Function, mailKind?:string, level?:string, mailOnly?:boolean}} opts
 * @returns {Promise<{total:number, inbox:number, mail:number}>}
 */
async function broadcastSystem(kind, opts) {
  const o = opts || {};
  if (kind && !St.notifyEnabled(kind)) {
    return { skipped: true, reason: '该内容类型已被管理员关闭', total: 0, inbox: 0, mail: 0 };
  }
  const users = resolveAudience(o.audience);
  let inbox = 0;
  let mail = 0;
  for (const u of users) {
    const content = o.build ? (o.build(u) || {}) : { title: o.title, intro: o.body };
    const r = await deliver(u, kind, {
      level: o.level || 'urgent',
      mailOnly: !!o.mailOnly,
      forceMail: !!o.forceMail,
      title: content.title || '系统消息',
      body: content.intro || content.body || '',
      mail: { kind: o.mailKind || kind, opts: content }
    });
    if (r.inbox && r.inbox.inbox) inbox += 1;
    if (r.mail && !r.mail.skipped) mail += 1;
  }
  return { total: users.length, inbox, mail };
}

module.exports = {
  getActivity,
  sessionTerm,
  activityRows,
  fmtTime,
  sendDirect,
  sendOnce,
  deliver,
  pushInbox,
  notifyInbox,
  isUserOnline,
  isUserActive,
  isBuiltinMailOnly,
  BUILTIN_MAIL_ONLY,
  notifyPref,
  notifyNow,
  notifyMany,
  broadcastSystem,
  audiences,
  resolveAudience,
  permName,
  whoLine,
  /** 统一失败隔离包装器：供调用方包裹临时拼装的通知调用 */
  safeNotify,

  // 内容拼装（同时供邮件测试文件生成使用）
  buildPreStart,
  buildStart,
  buildAbsent,
  buildActCreate,
  buildActStart,
  buildReminder,
  buildLeaveResult,
  buildMakeupResult,
  buildWoSubmitted,
  buildWoApproved,
  buildWoRejected,
  buildWoTimeout,
  buildGrantNotice,
  buildMaintenance,
  buildSessionKilled,
  buildPrivacyUpdate,
  buildAnnouncement,
  buildAccountNotice,
  buildDevAlert,
  buildPwChanged,
  buildLoginRemote,
  buildWoReminder,
  buildAppealSubmitted,
  buildAppealReply,
  buildFeedback,
  buildReceipt,

  /** 活动创建提醒 */
  notifyActCreate(user, activity) {
    return notifyPref('NT_ACT_CREATE', activity, user, buildActCreate(activity), MAIL.ACT_CREATE);
  },
  /** 签到窗口开放提醒 */
  notifyStart(user, activity) {
    return notifyPref('NT_CHECKIN_START', activity, user, buildStart(activity), MAIL.CHECKIN_START);
  },
  /** 活动开始前 N 分钟倒计时提醒（60 / 30 / 10 / 5） */
  notifyCountdown(user, activity, minutes) {
    return notifyPref('NT_REMINDER_' + minutes, activity, user, buildReminder(activity, minutes), MAIL.REMINDER);
  },
  /** 活动开始提醒 */
  notifyActStart(user, activity) {
    return notifyPref('NT_ACT_START', activity, user, buildActStart(activity), MAIL.ACT_START);
  },
  /** 活动结束后缺勤提醒（邀请补签申诉） */
  notifyAbsent(user, activity) {
    return notifyPref('NT_NOT_CHECKED', activity, user, buildAbsent(activity), MAIL.NOT_CHECKED);
  },
  /** 请假审核结果（含审核留言）：必达消息，在线走站内 toast、离线走邮件 */
  notifyLeaveResult(user, activity, approved, reply, actor) {
    return deliver(user, 'NT_RECEIPT', {
      level: 'urgent',
      actor: actor || null,
      title: approved ? '请假申请已通过' : '请假申请未通过',
      body: [activity ? activity.title : '', reply ? `留言：${reply}` : ''].filter(Boolean).join(' / '),
      ref_type: 'activity', ref_id: activity ? activity.id : null,
      mail: { kind: MAIL.LEAVE_RESULT, opts: buildLeaveResult(activity, approved, reply) }
    });
  },
  /** 补签申请审核结果（含审核留言） */
  notifyMakeupResult(user, activity, approved, reply, actor) {
    return deliver(user, 'NT_RECEIPT', {
      level: 'urgent',
      actor: actor || null,
      title: approved ? '补签申请已通过' : '补签申请未通过',
      body: [activity ? activity.title : '', reply ? `留言：${reply}` : ''].filter(Boolean).join(' / '),
      ref_type: 'activity', ref_id: activity ? activity.id : null,
      mail: { kind: MAIL.MAKEUP_RESULT, opts: buildMakeupResult(activity, approved, reply) }
    });
  },

  /* ---------------- 工单 / 授权 / 系统类 ---------------- */
  /**
   * 新工单 → 通知每一位「被指派的处理人」（在线走站内、离线同时发邮件）。
   * @param {'perm'|'info'} [kind] 工单类型，默认 perm（权限申请）
   */
  notifyWoSubmitted(approver, applicant, permCode, reason, kind) {
    const k = kind === 'info' ? 'info' : 'perm';
    const who = applicant ? applicant.real_name : '下级账号';
    return deliver(approver, 'NT_WO_REPLY', {
      level: 'urgent',
      actor: applicant,
      title: k === 'info' ? '新的信息修改 / 反馈工单' : '新权限工单待审批',
      body: k === 'info' ? `${who} 提交了信息修改 / 反馈申请` : `${who} 申请「${permName(permCode)}」`,
      ref_type: 'workorder', ref_id: null,
      mail: { kind: MAIL.WO_SUBMITTED, opts: buildWoSubmitted({ applicant, perm_code: permCode, reason, kind: k }) }
    });
  },
  notifyWoApproved(applicant, vars) {
    return deliver(applicant, 'NT_WO_REPLY', {
      level: 'urgent',
      actor: vars.handler,
      title: '权限工单已批准',
      body: `「${permName(vars.perm_code)}」已开通`,
      ref_type: 'workorder', ref_id: null,
      mail: { kind: MAIL.WO_APPROVED, opts: buildWoApproved(vars) }
    });
  },
  notifyWoRejected(applicant, vars) {
    return deliver(applicant, 'NT_WO_REPLY', {
      level: 'urgent',
      actor: vars.handler,
      title: '权限工单已驳回',
      body: `「${permName(vars.perm_code)}」未通过`,
      ref_type: 'workorder', ref_id: null,
      mail: { kind: MAIL.WO_REJECTED, opts: buildWoRejected(vars) }
    });
  },
  notifyWoTimeout(applicant, vars) {
    // 重启用工单超时：单独文案（无「权限」语义），且以「系统」口吻通知申请人
    if (vars && vars.perm_code === 'REACTIVATE') {
      return deliver(applicant, 'NT_SYS_MSG', {
        level: 'urgent',
        title: '系统：重启用工单超时已自动关闭',
        body: '你的「重启用」申请因超时未审批已自动关闭，如需继续请重新提交申请。',
        ref_type: 'workorder', ref_id: null,
        forceMail: true,
        mail: { kind: MAIL.WO_TIMEOUT, opts: buildWoTimeout(vars) }
      });
    }
    const isInfo = !!(vars && vars.kind === 'info');
    return deliver(applicant, 'NT_WO_REPLY', {
      level: 'urgent',
      title: isInfo ? '工单超时已自动关闭' : '权限工单超时已自动驳回',
      body: isInfo ? '「信息修改 / 反馈」工单超时未处理' : `「${permName(vars.perm_code)}」`,
      ref_type: 'workorder', ref_id: null,
      mail: { kind: MAIL.WO_TIMEOUT, opts: buildWoTimeout(vars) }
    });
  },
  notifyGrantNotice(user, vars) {
    return deliver(user, 'NT_WO_REPLY', {
      level: 'urgent',
      actor: vars.granter,
      title: '你被授予了新权限',
      body: `「${permName(vars.perm_code)}」`,
      ref_type: 'permission', ref_id: null,
      mail: { kind: MAIL.GRANT_NOTICE, opts: buildGrantNotice(vars) }
    });
  },
  notifyMaintenancePre(users, vars) {
    return notifyMany('NT_SYS_MSG', users, () => buildMaintenance(Object.assign({ phase: 'pre' }, vars)), MAIL.MAINTENANCE_PRE);
  },
  notifyMaintenancePost(users, vars) {
    return notifyMany('NT_SYS_MSG', users, () => buildMaintenance(Object.assign({ phase: 'post' }, vars)), MAIL.MAINTENANCE_POST);
  },
  notifySessionKilled(user, vars) {
    return deliver(user, 'NT_SYS_MSG', {
      level: 'urgent',
      title: '你的会话已被强制结束',
      body: vars.reason || '系统维护',
      mail: { kind: MAIL.SESSION_KILLED, opts: buildSessionKilled(vars) }
    });
  },
  notifyPrivacyUpdate(users, vars) {
    return notifyMany('NT_SYS_MSG', users, () => buildPrivacyUpdate(vars), MAIL.PRIVACY_UPDATE);
  },
  notifyAnnouncement(users, vars) {
    return notifyMany('NT_SYS_MSG', users, () => buildAnnouncement(vars), MAIL.ANNOUNCEMENT);
  },
  notifyAccountNotice(user, vars) {
    return deliver(user, 'NT_SYS_MSG', {
      level: 'urgent',
      title: '你的账号信息已变更',
      body: (vars.items || []).map(x => `${x.label}：${x.value}`).join('；'),
      mail: { kind: MAIL.ACCOUNT_NOTICE, opts: buildAccountNotice(vars) }
    });
  },
  /** 运维告警：仅发给运维者 */
  async notifyDevAlert(detail) {
    const devs = db.prepare("SELECT * FROM users WHERE role = 'ops' AND disabled = 0").all();
    for (const d of devs) {
      await sendDirect(d, buildDevAlert({ detail }), MAIL.OPS_ALERT);
    }
    return { sent: devs.length };
  },

  /**
   * 安全类通知：站内消息 + 邮件双发（安全事件必须触达，邮件尽力而为）。
   * 未配置 SMTP 时邮件写入测试文件，不抛错。
   */
  async notifySecurity(user, v, mailKind) {
    if (!user) return { skipped: true, reason: '无目标用户' };
    pushInbox(user, {
      level: (v && v.level) || 'urgent', kind: mailKind, title: v.title, body: v.intro || '',
      ref_type: v.ref_type || null, ref_id: v.ref_id || null
    });
    let mail = { skipped: true, reason: '未发邮件' };
    if (user.email) {
      try { mail = await sendDirect(user, v, mailKind); } catch (e) { /* 尽力而为 */ }
    }
    try {
      require('./datalog').record({
        category: 'notify', action: mailKind, actor: (v && v.actor) || null,
        subject_id: user.id, target: whoLine(user),
        detail: v.title || '', channel: mail.skipped ? 'inbox' : 'both'
      });
    } catch (e) { /* 忽略 */ }
    return { inbox: true, mail };
  },

  /** 申诉待审核：通知有初审 / 终审权限的上级（在线走站内、离线走邮件） */
  notifyAppealSubmitted(user, v) {
    const o = v || {};
    return deliver(user, 'NT_WO_REPLY', {
      level: 'urgent',
      actor: o.applicant || null,
      title: o.title || '新的申诉待审核',
      body: o.body || '',
      ref_type: 'appeal', ref_id: o.id || null,
      mail: { kind: MAIL.APPEAL_SUBMITTED, opts: buildAppealSubmitted(o) }
    });
  },
  /** 申诉沟通回复：通知沟通的另一方 */
  notifyAppealReply(user, v) {
    const o = v || {};
    return deliver(user, 'NT_WO_REPLY', {
      level: 'urgent',
      actor: o.replier || null,
      title: o.title || '你的申诉有新回复',
      body: String(o.body || '').slice(0, 100),
      ref_type: 'appeal', ref_id: o.id || null,
      mail: { kind: MAIL.APPEAL_REPLY, opts: buildAppealReply(o) }
    });
  },
  /**
   * 操作回执：管理员补签 / 退签 / 代请假、工单提交回执等对被操作人的通知。
   * @param {{title,body,intro,rows,actor,ref_type,ref_id,forceMail,notifyKind}} v
   */
  notifyReceipt(user, v) {
    const o = v || {};
    return deliver(user, o.notifyKind || 'NT_RECEIPT', {
      level: 'urgent',
      actor: o.actor || null,
      title: o.title || '操作回执',
      body: o.body || '',
      ref_type: o.ref_type || null, ref_id: o.ref_id || null,
      forceMail: !!o.forceMail,
      mail: { kind: MAIL.RECEIPT, opts: buildReceipt(o) }
    });
  },

  /**
   * 网站问题反馈：把用户提交的内容转发到运维者登记的反馈邮箱。
   * @param {string} to 运维者邮箱
   * @param {{id,type,subject,content,contact,reporter_name,reporter_role}} fb
   * @param {object} [actor] 反馈人（用于数据流留痕的 actor）
   */
  notifyFeedback(to, fb, actor) {
    if (!to) return { skipped: true, reason: '未登记反馈邮箱' };
    const opts = Object.assign(buildFeedback(fb || {}), { actor: actor || null, subject_id: fb && fb.id });
    return mailer.sendNotice(to, opts, MAIL.FEEDBACK).catch((e) => {
      log('warn', 'mail send failed: ' + e.message, { to, kind: MAIL.FEEDBACK });
      return { failed: true, reason: e.message };
    });
  },

  /** 密码变更安全提醒（修改密码 / 邮箱验证码重置 / 更新找回邮箱） */
  notifyPwChanged(user, v) {
    // 注意：notifySecurity 是本对象字面量的方法，不能用自由标识符直接调用（会 ReferenceError），
    // 必须通过 module.exports 引用；否则登录 / 改密 / 找回邮箱会直接 500（原缺陷）。
    return module.exports.notifySecurity(user, buildPwChanged(v || {}), MAIL.PW_CHANGED);
  },
  /** 异地登录安全提醒 */
  notifyLoginRemote(user, v) {
    return module.exports.notifySecurity(user, buildLoginRemote(v || {}), MAIL.LOGIN_REMOTE);
  },

  /**
   * 自动代管开通：通知被授予代管权限的账号。
   * 走 NT_SYS_MSG（必提醒，不可被个人关闭），投递分层为「在线仅站内、离线/闲置 站内+邮件」。
   * 调用方（autocover）已用 try/catch 包裹，通知失败绝不影响授权结果与主流程。
   */
  notifyAutoCoverGrant(user, v) {
    const o = v || {};
    return deliver(user, 'NT_SYS_MSG', {
      level: 'notice',
      title: '自动代管已开通',
      body: `因暂无在岗的${(o.levels || []).map(l => (l === 'r2' ? '小班主任' : '辅导员')).join('、') || '上级'}，已自动为你开通 ${(o.perms || []).length} 项上级权限`,
      ref_type: 'auto_cover',
      mail: { kind: MAIL.AUTO_COVER_GRANT, opts: buildAutoCoverGrant(o) }
    });
  },

  /** 自动代管收回：通知被收回代管权限的账号 */
  notifyAutoCoverRevoke(user, v) {
    const o = v || {};
    const reasonText = o.reason === 'switch_off' ? '管理员关闭了自动代管' : '上级账号已到岗';
    return deliver(user, 'NT_SYS_MSG', {
      level: 'notice',
      title: '自动代管已收回',
      body: `已收回 ${(o.perms || []).length} 项代管权限（${reasonText}）`,
      ref_type: 'auto_cover',
      mail: { kind: MAIL.AUTO_COVER_REVOKE, opts: buildAutoCoverRevoke(Object.assign({}, o, { reason_text: reasonText })) }
    });
  },

  /**
   * 上级到岗提醒：班级级设置若由代管期间的班委（或前任）留下，提示到岗的上级确认沿用或恢复默认。
   * 仅站内消息（NT_SYS_MSG，必提醒）；邮件不强求，避免打扰。
   */
  notifyAutoCoverArrived(user, v) {
    const o = v || {};
    const e = o.editor || {};
    const when = e.at ? fmtTime(Number(e.at)) : '此前';
    const who = e.name ? `${e.name}${e.role_title ? '（' + e.role_title + '）' : ''} 于 ${when} 设置` : '代管期间';
    return deliver(user, 'NT_SYS_MSG', {
      level: 'notice',
      title: '你已到岗，请确认班级设置',
      body: `欢迎到岗。当前班级级设置（通知开关、定位核验等）由 ${who}。请到「通知设置 / 系统安全」确认是否沿用；若需推倒重来，可在该页点击「恢复出厂默认」。`,
      ref_type: 'auto_cover'
    });
  },

  /**
   * 工单待办催办：扫描挂起较久（默认 >30 分钟）的待审批工单，给其审批人发邮件。
   * 按「工单 + 审批人」去重（notify_log），每条待办工单每个审批人仅催办一次。
   * @param {number} [now]
   * @param {number} [ageMinThreshold] 超过该等待分钟数才催办
   */
  async remindPendingWorkOrders(now, ageMinThreshold) {
    const t = now || Date.now();
    const threshold = ageMinThreshold != null ? ageMinThreshold : 30;
    const pending = db.prepare("SELECT * FROM work_orders WHERE status = 'pending'").all();
    let reminded = 0;
    for (const w of pending) {
      const ageMin = (t - w.created_at) / 60000;
      if (ageMin < threshold) continue;
      const ids = String(w.approver_ids || '').split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(Boolean);
      const approvers = ids.length
        ? db.prepare(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')}) AND disabled = 0`).all(...ids)
        : [];
      const applicant = db.prepare('SELECT * FROM users WHERE id = ?').get(w.applicant_id);
      for (const ap of approvers) {
        if (alreadySent(MAIL.WO_REMINDER, w.id, ap.id)) continue;
        // 与其余通知一致的送达规则：在线且活动 → 仅站内；离线 / 不活动 → 站内 + 邮件
        await deliver(ap, 'NT_WO_REPLY', {
          level: 'urgent',
          title: '工单待办催办',
          body: `${applicant ? applicant.real_name : '下级账号'} 的工单已等待 ${Math.round(ageMin)} 分钟`,
          ref_type: 'workorder', ref_id: w.id,
          mail: {
            kind: MAIL.WO_REMINDER,
            opts: buildWoReminder({ applicant, perm_code: w.perm_code, kind: w.kind, ageMin, reason: w.reason })
          }
        }).catch(() => {});
        markSent(MAIL.WO_REMINDER, w.id, ap.id);
        reminded += 1;
      }
    }
    return { reminded };
  },

  /** 按账号 ID 取用户（工单 / 授权用） */
  getUser(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
};

/**
 * 出口统一隔离：把对外暴露的「投递类」函数逐个包上 safeNotify。
 * 调用方即使不写 try/catch / .catch()，通知异常也不会再冒泡到业务主流程
 * （登录、改密、注册激活、审批等）。build* / fmtTime / whoLine 等纯数据函数保持原样。
 */
const SAFE_NOTIFY_EXPORTS = [
  'sendDirect', 'sendOnce', 'deliver', 'pushInbox', 'notifyInbox',
  'notifyPref', 'notifyNow', 'notifyMany', 'broadcastSystem',
  'notifyActCreate', 'notifyStart', 'notifyCountdown', 'notifyActStart',
  'notifyAbsent', 'notifyLeaveResult', 'notifyMakeupResult',
  'notifyWoSubmitted', 'notifyWoApproved', 'notifyWoRejected', 'notifyWoTimeout',
  'notifyGrantNotice', 'notifyMaintenancePre', 'notifyMaintenancePost', 'notifySessionKilled',
  'notifyPrivacyUpdate', 'notifyAnnouncement', 'notifyAccountNotice', 'notifyDevAlert',
  'notifySecurity', 'notifyAppealSubmitted', 'notifyAppealReply', 'notifyReceipt',
  'notifyFeedback', 'notifyPwChanged', 'notifyLoginRemote',
  'notifyAutoCoverGrant', 'notifyAutoCoverRevoke', 'notifyAutoCoverArrived', 'remindPendingWorkOrders'
];
SAFE_NOTIFY_EXPORTS.forEach(name => {
  if (typeof module.exports[name] === 'function') {
    module.exports[name] = safeNotify(module.exports[name], 'notify.' + name);
  }
});
