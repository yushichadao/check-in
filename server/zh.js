'use strict';
/* 数据流「全中文化」词典
 * ------------------------------------------------------------------
 * 数据流（data_flow）里动作 / 分类 / 状态 / 权限码等均为内部英文标识，
 * 展示与导出时必须转成中文。集中在此，供 datalog、导出 CSV、留痕写入方共用。
 */
const cfg = require('./config');

/** 动作（action）→ 中文可读名 */
const ACTION_TEXT = {
  /* 签到 / 申诉 */
  sign: '签到', checkin: '签到', supplement: '补签到', unsign: '取消签到',
  leave: '提交请假申请', leave_request: '提交请假申请', leave_by_admin: '管理代请假',
  leave_approve: '准假', leave_reject: '驳回请假',
  makeup_request: '提交补签申请', makeup_approve: '通过补签', makeup_reject: '驳回补签',
  appeal_retry: '重新提交申诉',
  /* 活动 / 活动范围 */
  activity_create: '发布活动', activity_update: '修改活动', activity_delete: '删除活动',
  activity_bulk_delete: '批量删除活动', activity_destination: '设置活动目的地',
  fence_create: '新建活动范围', fence_update: '修改活动范围', fence_delete: '删除活动范围',
  fence_bulk_update: '批量修改活动范围', fence_bulk_delete: '批量删除活动范围',
  /* 账号 */
  user_create: '新增账号', user_update: '修改账号信息', user_role_change: '变更账号身份',
  user_delete: '清除账号数据', user_bulk_delete: '批量清除账号数据',
  user_restore: '恢复账号', clear_password: '清除密码', account_cancel: '注销账号',
  reactivate_request: '申请重启用账号', scope_update: '修改管理范围',
  /* 登录 / 会话 / 密码 */
  login: '登录', login_fail: '登录失败', login_remote: '异地登录', logout: '登出',
  session_replace: '同端登录替换下线', session_kick: '下线设备',
  set_password: '设置密码', change_password: '修改密码', pwd_reset_request: '申请找回密码',
  email_code: '发送邮箱验证码', email_reset: '邮箱验证码重置密码', email_update: '更新找回邮箱',
  device_mismatch: '设备不匹配', device_change: '更换设备',
  /* 权限 / 工单 */
  work_order_submit: '提交权限工单', work_order_approve: '批准权限工单',
  work_order_reject: '驳回权限工单', work_order_timeout: '权限工单超时',
  perm_grant: '授予权限', perm_grant_batch: '批量授予权限', perm_revoke: '收回权限',
  /* 系统 */
  settings_update: '修改系统设置', notify_pref_update: '修改提醒偏好',
  location_verify_switch: '切换定位核验', manager_location_view_switch: '切换查看学生定位开关',
  maintenance_enter: '进入维护模式', maintenance_exit: '结束维护模式',
  maintenance_switch: '维护模式开关', maintenance_block: '维护期间非法操作（已拦截并留痕）', privacy_update: '更新隐私告知', announcement_update: '发布公告',
  dataflow_mask: '切换数据流隐私打码',
  system_reset: '清空并恢复默认设置', withdraw: '撤回操作',
  /* 自动代管（缺上级自动补位） */
  auto_cover_grant: '自动代管开通', auto_cover_revoke: '自动代管收回',
  auto_cover_switch: '切换自动代管开关', auto_cover_skipped: '自动代管未执行（无可用补位账号）',
  /* 辅导员未激活自动委托（与自动代管并存，语义不同：source='auto_delegate'） */
  auto_delegate: '自动委托管理权限', auto_delegate_revoke: '收回自动委托',
  /* 申诉自动结案 / 门户注册 / 反馈 */
  appeal_auto_final: '申诉自动结案（终审免审）',
  register_code: '发送注册验证码',
  feedback_submit: '向运维者提交反馈', feedback_handle: '处理运维者反馈',
  maintenance_schedule_expired: '清理过期维护排期',
  /* 历史遗留动作：当前版本已按隐私要求不再写入审计（见 routes/settings.js 的 /me/notify、
     routes/auth.js 的 /me/complete-setup），但旧库中仍存有这类记录，保留词条以免展示为
     「其他操作」+ 英文裸码（如 setup_done / notify_pref_self）。 */
  notify_pref_self: '修改本人提醒偏好', setup_done: '完成首次设置'
};

/** 分类（category）→ 中文 */
const CATEGORY_TEXT = {
  mail: '邮件', workorder: '工单', appeal: '申诉', notify: '通知', account: '账号',
  activity: '活动', fence: '活动范围', checkin: '签到', auth: '登录与会话', perm: '权限', system: '系统',
  feedback: '反馈'
};

/**
 * 业务状态 → 中文。本表是通用映射，覆盖两类不同语义，切勿混淆：
 *  · 签到态：signed 已签到 / ontheway 在途中 / absent 缺勤 / leave 请假 / late 迟到 / cancelled 已退签；
 *            unsigned 待签到 仅作展示兜底（活动未结束、尚无签到记录时由 effectiveStatus 返回）。
 *  · 审核/申诉态：pending 待处理 / rejected 已驳回 / approved 已通过（与签到「待签到」无关）。
 *  · 系统/操作态：normal 正常 / auto 自动 / manual 手动。
 * 关键：签到域的「在途中」「待签到」只在活动开始前/进行中存在；活动一结束，
 *      effectiveStatus 会把它俩（以及退签/无记录）统一折算为「缺勤」，故结束后不会再以这两个标签展示。
 */
const STATUS_TEXT = {
  signed: '已签到', ontheway: '在途中', absent: '缺勤', leave: '请假', late: '迟到',
  cancelled: '已退签', pending: '待处理', rejected: '已驳回', approved: '已通过',
  unsigned: '待签到', normal: '正常', auto: '自动', manual: '手动'
};

/** 站内通知（NT_*）动作 → 中文可读名（精确码优先，未收录回退通用中文） */
const NT_TEXT = {
  NT_ACT_CREATE: '活动发布提醒', NT_CHECKIN_START: '签到开放提醒', NT_ACT_START: '活动开始提醒',
  NT_NOT_CHECKED: '缺勤提醒', NT_REMINDER_5: '活动开始前提醒',
  NT_RECEIPT: '审核结果回执', NT_WO_REPLY: '工单回复', NT_WO_SUBMITTED: '工单提交回执',
  NT_SYS_MSG: '系统通知', NT_OPS_ALERT: '运维告警',
  receipt: '站内回执', notify: '站内通知'
};

/**
 * 邮件（MAIL_*）动作 → 中文可读名。
 * 类型名统一取自邮件类型总表 server/mailtypes.js（唯一登记处），此处不再单独维护；
 * code / preview / notice 为落盘与预览用的非类型标识，单独保留。
 */
const MAIL_TEXT = Object.assign({}, require('./mailtypes').MAIL_TYPE_NAMES, {
  code: '密码重置验证码', preview: '邮件预览', notice: '系统通知邮件'
});

/** 动作码 → 中文；未收录时给通用中文，绝不回退英文 key */
function actionText(t) {
  const s = String(t == null ? '' : t);
  if (ACTION_TEXT[s]) return ACTION_TEXT[s];
  if (MAIL_TEXT[s]) return MAIL_TEXT[s];
  if (NT_TEXT[s]) return NT_TEXT[s];
  if (s.startsWith('NT_REMINDER_')) return '活动开始前提醒';
  if (s.startsWith('NT_')) return '站内通知';
  if (s.startsWith('MAIL_')) return '系统邮件';
  return '其他操作';
}

function categoryText(c) { return CATEGORY_TEXT[String(c == null ? '' : c)] || '其他'; }

function statusText(s) {
  const k = String(s == null ? '' : s);
  return STATUS_TEXT[k] || k;
}

/** 权限码 → 中文名（回退顺序：业务权限 → 提醒偏好 → 原码） */
function permText(code) {
  const c = String(code == null ? '' : code);
  const p = cfg.ALL_PERMS[c];
  if (p && p.name) return p.name;
  const n = cfg.NOTIFY_PREFS && cfg.NOTIFY_PREFS[c];
  if (n && n.name) return n.name;
  return c;
}

/** 多枚权限码 → 「甲、乙」；空则「—」 */
function permListText(codes) {
  const arr = (Array.isArray(codes) ? codes : String(codes || '').split(/[,，、]/))
    .map(s => String(s || '').trim()).filter(Boolean);
  return arr.length ? arr.map(permText).join('、') : '—';
}

function onOff(v) { return v ? '开启' : '关闭'; }

/** 中文关键词 → 可能命中的动作码（供中文检索动作名） */
function codesMatching(text) {
  const q = String(text == null ? '' : text);
  if (!q) return [];
  return Object.keys(ACTION_TEXT).filter(k => ACTION_TEXT[k].includes(q));
}

module.exports = {
  actionText, categoryText, statusText, permText, permListText, onOff, codesMatching,
  ACTION_TEXT, CATEGORY_TEXT, STATUS_TEXT
};
