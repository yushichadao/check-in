'use strict';

/**
 * 把数据流事件翻译成「人话」，让管理端/开发端能一眼看懂发生了什么。
 * 只使用姓名与身份，不含学号、设备码、IP、邮箱、定位等隐私信息。
 */
const { MAIL_TYPE_NAMES } = require('./mailtypes');
const zh = require('./zh');

// 签到状态 → 中文（本表仅供「签到事件」描述使用，与审核/申诉的 pending=待处理 没有关系）。
// 注意：ontheway(在途中) 与 pending(待签到) 都是「活动开始前 / 进行中」才存在的临时态；
// 活动一结束，server/geo.js 的 effectiveStatus 会把它俩（及退签/无记录）统一折算为「缺勤」，
// 因此结束后数据流/展示里不会再出现「在途中」「待签到」这两个标签。
const STATUS_TEXT = {
  signed: '已签到', ontheway: '在途中', leave: '请假',
  absent: '缺勤', cancelled: '已退签', pending: '待签到'
};

const TYPE_TEXT = {
  // 认证 / 会话
  login: '登录', logout: '登出', login_fail: '登录失败',
  login_remote: '异地登录', session_replace: '登录替换下线', session_kick: '下线设备',
  device_mismatch: '设备不匹配', device_change: '更换设备',
  // 密码 / 邮箱 / 账号
  set_password: '设置密码', change_password: '修改密码', pwd_reset_request: '申请找回密码',
  email_code: '发送邮箱验证码', email_reset: '邮箱重置密码', email_update: '更新邮箱',
  account_cancel: '注销账号', reactivate_request: '申请重新激活',
  // 用户管理
  user_create: '新增用户', user_update: '修改用户资料', user_role_change: '修改用户身份',
  user_delete: '删除用户', user_bulk_delete: '批量删除用户', user_restore: '恢复用户', clear_password: '清除密码',
  // 签到 / 请假 / 补签 / 申诉
  checkin: '签到', supplement: '补签到', unsign: '取消签到',
  leave: '申请请假', leave_request: '提交请假申请', leave_by_admin: '管理代请假',
  leave_approve: '准假', leave_reject: '驳回请假',
  makeup_request: '申请补签', makeup_approve: '通过补签', makeup_reject: '驳回补签',
  appeal_retry: '重新提交申诉',
  // 活动 / 活动范围
  activity_create: '发布活动', activity_update: '修改活动', activity_delete: '删除活动', activity_bulk_delete: '批量删除活动',
  activity_destination: '设置活动目的地',
  fence_create: '新建活动范围', fence_update: '修改活动范围', fence_bulk_update: '批量修改活动范围',
  fence_delete: '删除活动范围', fence_bulk_delete: '批量删除活动范围',
  // 工单
  work_order_submit: '提交工单', work_order_approve: '通过工单', work_order_reject: '驳回工单', work_order_timeout: '工单超时',
  // 权限 / 范围
  perm_grant: '授予权限', perm_grant_batch: '批量授予权限', perm_revoke: '收回权限',
  scope_update: '更新权限范围',
  // 系统 / 设置 / 维护 / 备份
  settings_update: '修改系统设置', notify_pref_update: '更新通知偏好',
  location_verify_switch: '切换定位校准', manager_location_view_switch: '切换查看学生定位开关', maintenance_block: '维护期间非法操作（已拦截并留痕）', privacy_update: '更新隐私告知',
  auto_cover_grant: '自动代管开通', auto_cover_revoke: '自动代管收回',
  auto_cover_switch: '切换自动代管开关', auto_cover_skipped: '自动代管未执行（无可用补位账号）',
  auto_delegate: '自动委托管理权限', auto_delegate_revoke: '收回自动委托',
  appeal_auto_final: '申诉自动结案',
  // 历史遗留动作（当前版本已不写入审计，仅用于翻译旧库记录，见 zh.js 同名说明）
  notify_pref_self: '修改本人提醒偏好', setup_done: '完成首次设置',
  register_code: '发送注册验证码',
  feedback_submit: '提交网站问题反馈', feedback_handle: '处理网站问题反馈',
  maintenance_schedule_expired: '清理过期维护排期',
  // 注：notify_pref_self（用户改自己的提醒偏好，隐私）/ user_reuse（账号预置幂等复用，孤儿操作）不计入审计，故无词条
  announcement_update: '发布公告',
  maintenance_switch: '维护模式开关', maintenance_enter: '进入维护模式', maintenance_exit: '结束维护模式',
  system_reset: '系统重置', withdraw: '撤回记录',
  dataflow_mask: '切换数据流隐私打码',
  // 通知类
  NT_SYS_MSG: '系统通知', NT_OPS_ALERT: '运维告警',
  preview: '邮件预览',
  // 通知 / 邮件类（站内信与邮件动作）：补全后 describe() 在 detail 为空时回退到中文动作名，
  // 避免数据流正文 / 标签直接显示英文 key（如 NT_WO_REPLY / NT_RECEIPT）
  NT_ACT_CREATE: '活动发布提醒', NT_CHECKIN_START: '签到开放提醒', NT_ACT_START: '活动开始提醒',
  NT_NOT_CHECKED: '缺勤提醒', NT_REMINDER_5: '活动开始前提醒',
  NT_RECEIPT: '审核结果回执', NT_WO_REPLY: '工单回复', NT_WO_SUBMITTED: '工单提交回执',
  receipt: '站内回执', notify: '站内通知',
  // 邮件类型名：统一取自邮件类型总表 server/mailtypes.js（唯一登记处）
  ...MAIL_TYPE_NAMES
};

function typeText(type) {
  const s = String(type == null ? '' : type);
  if (TYPE_TEXT[s]) return TYPE_TEXT[s];
  // 未登记的动作：回退到 zh.actionText（覆盖全、未收录也返回中文「其他操作」），
  // 绝不回退英文原始码，否则管理端数据流会出现 NT_RECEIPT / fence_create 等英文「类型」。
  return zh.actionText(s);
}

/** 设备串去掉补充说明：兼容「Windows · Chrome（异地登录）」与旧格式「… 登录，已下线 N 个旧登录」 */
function cleanDevice(s) {
  let t = String(s || '').split('（')[0];
  t = t.replace(/\s*登录.*$/, '').trim();
  return t || '未知设备';
}

/** 从 detail 里的「活动#12」解析出活动标题 */
function activityLabel(detail, actMap) {
  const m = /活动#(\d+)/.exec(String(detail || ''));
  if (!m) return '';
  const title = actMap && actMap.get(Number(m[1]));
  return title ? `活动「${title}」` : `活动 #${m[1]}`;
}

const q = (name) => (name ? `「${name}」` : '某账号');

/**
 * @param {string} type 事件类型
 * @param {string} detail 事件 detail
 * @param {{name:string,role_title:string}|null} target 被操作对象
 * @param {Map<number,string>} actMap 活动 id -> 标题
 */
function describe(type, detail, target, actMap) {
  const d = String(detail || '');
  const tn = target && target.name ? target.name : '';
  // 通知 / 邮件类动作（NT_* / MAIL_* 等）：detail 通常已是中文正文（标题 / 回执内容），直接展示；
  // 为空时回退到中文动作名（typeText），绝不显示英文 key
  if (type.startsWith('NT_') || type.startsWith('MAIL_') || type === 'preview' || type === 'receipt' || type === 'notify') {
    return d || typeText(type);
  }
  switch (type) {
    case 'login': return '登录了系统';
    case 'login_remote': return `从异地登录（${cleanDevice(d)}）`;
    case 'logout': return '退出了登录';
    case 'login_fail': return '登录失败（姓名/密码不正确）';
    case 'set_password': return '设置（激活）了账号密码';
    case 'change_password': return '修改了自己的登录密码';
    case 'email_update': return '更新了找回密码所用的邮箱';
    case 'email_code': return '获取了邮箱验证码';
    case 'email_reset': return '通过邮箱验证码重置了密码';
    case 'account_cancel': return '注销了账号（隐藏处理）';
    case 'pwd_reset_request': return `${tn ? q(tn) : '该用户'}提交了找回密码申请`;
    case 'session_replace': return `新设备登录，替换了同账号以前的登录（${cleanDevice(d)}）`;
    case 'session_kick': return `把设备「${cleanDevice(d)}」下线`;
    case 'device_mismatch': return '检测到设备不一致，拒绝了本次签到';
    case 'device_change': return '更换了签到设备（已记录留痕）';

    case 'user_create': {
      if (tn) return `新建账号${q(tn)}${target && target.role_title ? `（${target.role_title}）` : ''}`;
      const ident = String(d).split('/')[0];   // 账号已被删除时，用 detail 里的身份兜底
      return `新建账号${ident ? `（${ident}）` : ''}`;
    }
    case 'user_delete': return `永久删除账号${tn ? q(tn) : ''}`;
    case 'user_bulk_delete': return d || '批量删除账号';
    case 'user_restore': return `恢复账号${tn ? q(tn) : ''}`;
    case 'clear_password': return `清除了${tn ? q(tn) : '某账号'}的登录密码（原密码立即失效，需本人重新设置）`;

    case 'checkin': return `提交签到状态：${STATUS_TEXT[d] || d || '已更新'}`;
    case 'supplement': return `为${tn ? q(tn) : '某普通学生'}补签（${activityLabel(d, actMap)}）`;
    case 'unsign': return `为${tn ? q(tn) : '某普通学生'}退签（${activityLabel(d, actMap)}）`;
    case 'leave_by_admin': return `为${tn ? q(tn) : '某普通学生'}代请假（${activityLabel(d, actMap)}）`;
    case 'leave_approve': return `批准了${tn ? q(tn) : '某普通学生'}的请假（${activityLabel(d, actMap)}）`;
    case 'leave_reject': return `驳回了${tn ? q(tn) : '某普通学生'}的请假（${activityLabel(d, actMap)}）`;

    case 'makeup_request': return `提交了补签申请（${activityLabel(d, actMap)}）`;
    case 'makeup_approve': return `通过了${tn ? q(tn) : '某普通学生'}的补签（${activityLabel(d, actMap)}）`;
    case 'makeup_reject': return `驳回了${tn ? q(tn) : '某普通学生'}的补签（${activityLabel(d, actMap)}）`;
    case 'settings_update': return '更新了系统设置';

    case 'activity_create': return `发布活动「${d}」`;
    case 'activity_delete': return `删除活动「${d}」`;
    case 'activity_bulk_delete': return d || '批量删除活动';
    case 'fence_create': return `创建活动范围「${d}」`;
    case 'fence_update': return `修改活动范围「${d}」`;
    case 'fence_delete': return `删除活动范围「${d}」`;

    // —— 以下为补全的中文描述 ——
    case 'user_update': return `修改了用户资料${d ? `（${d}）` : ''}`;
    case 'user_role_change': return `修改了用户身份：${d}`;
    case 'reactivate_request': return `提交了重新激活申请${d ? `（${d}）` : ''}`;
    case 'leave_request': return `提交了请假申请（${activityLabel(d, actMap)}）`;
    case 'appeal_retry': return `重新提交了申诉${d ? `（${d}）` : ''}`;
    case 'activity_update': return `修改了活动「${d}」`;
    case 'activity_destination': return `${d}`;
    case 'work_order_submit': return `提交了工单（${d}）`;
    case 'work_order_approve': return `通过了工单（${d}）`;
    case 'work_order_reject': return `驳回了工单（${d}）`;
    case 'work_order_timeout': return `工单超时自动驳回（${d}）`;
    case 'perm_grant': return `授予了权限（${d}）`;
    case 'perm_grant_batch': return `批量授予权限（${d}）`;
    case 'perm_revoke': return `收回了权限（${d}）`;
    case 'scope_update': return `更新了权限范围（${d}）`;
    case 'notify_pref_update': return `更新了通知偏好（${d}）`;
    case 'location_verify_switch': return `切换了定位校准开关（${d}）`;
    case 'auto_cover_grant': return `自动代管开通：${d}`;
    case 'auto_cover_revoke': return `自动代管收回：${d}`;
    case 'auto_cover_switch': return `切换了自动代管开关：${d}`;
    case 'auto_cover_skipped': return `自动代管未执行：${d}`;
    case 'auto_delegate': return d || '辅导员未激活，自动委托其管理权限给下级';
    case 'auto_delegate_revoke': return d || '收回自动委托的管理权限';
    case 'appeal_auto_final': return d || '申诉无更高层级终审人，初审结果自动结案';
    case 'register_code': return `获取了注册邮箱验证码${d ? `（${d}）` : ''}`;
    case 'feedback_submit': return `提交网站问题反馈：${d}`;
    case 'feedback_handle': return `处理网站问题反馈：${d}`;
    case 'maintenance_schedule_expired': return d || '清理过期的维护排期';
    // 历史遗留动作：detail 为空（setup_done）或只有数量（notify_pref_self 的「N 项」），
    // 都需要模板补全成完整句子，否则展示为英文裸码 / 孤零零的「10 项」。
    case 'setup_done': return '完成首次设置（新账号首次设置向导）';
    case 'notify_pref_self': return `修改了本人的通知偏好${d ? `（${d}）` : ''}`;
    case 'privacy_update': return `更新了隐私告知${d ? `（${d}）` : ''}`;
    case 'announcement_update': return `发布了公告${d ? `（${d}）` : ''}`;
    case 'maintenance_switch': return `切换了维护模式开关：${d}`;
    case 'maintenance_enter': return `进入维护模式${d ? `（${d}）` : ''}`;
    case 'maintenance_exit': return `结束维护模式${d ? `（${d}）` : ''}`;
    case 'dataflow_mask': return d || '切换了数据流隐私打码';
    case 'system_reset': return '执行了系统重置';
    case 'withdraw': return `撤回了记录${d ? `：${d}` : ''}`;
    case 'NT_SYS_MSG': return d || '系统通知';
    case 'NT_OPS_ALERT': return d || '运维告警';
    case 'preview': return d ? `邮件预览 / 发送（${d}）` : '邮件预览';

    default: return d || typeText(type);
  }
}

module.exports = { describe, typeText, STATUS_TEXT };
