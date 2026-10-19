'use strict';
/**
 * 邮件类型总表（唯一事实来源）
 * ------------------------------------------------------------------
 * 此前「邮件有哪些类型、各自叫什么」散落在 4 处重复维护
 *   server/mailer.js（MAIL_TYPES）、server/zh.js（MAIL_TEXT）、
 *   server/eventtext.js（TYPE_TEXT）、public/js/api.js（EVENT_TEXT）
 * 容易漏登记（如已在用的 MAIL_ANNOUNCEMENT 一直没名字），也容易前后不一致。
 *
 * 现在统一在本文件登记一次：
 *   · mailer     按类型码渲染 / 发送、写数据流留痕
 *   · zh / eventtext / 前端  直接取这里的中文名，不再各自抄一份
 *   · notify / routes         用 MAIL.XXX 常量引用，避免字符串写错
 *
 * 字段说明：
 *   code      邮件类型码（同时作为数据流 action 与落盘文件名前缀）
 *   name      中文名（数据流展示 / 前端展示）
 *   group     所属分组 key（见 GROUPS）
 *   template  code=验证码模板，notice=通知模板
 *   audience  收件人说明
 *   when      触发时机
 *   mailOnly  true=只发邮件、不写站内消息，也不受在线分层影响（必达邮件）
 */

/** 邮件分组（顺序即展示顺序） */
const GROUPS = [
  { key: 'security', name: '密码与安全' },
  { key: 'activity', name: '活动与签到提醒' },
  { key: 'review', name: '请假 / 补签审核' },
  { key: 'appeal', name: '申诉与沟通' },
  { key: 'workorder', name: '工单与权限' },
  { key: 'system', name: '系统与维护' },
  { key: 'ops', name: '运维与反馈' },
  { key: 'receipt', name: '操作回执' }
];

/** 全部邮件类型（顺序即展示顺序） */
const TYPES = [
  /* ---------------- 密码与安全 ---------------- */
  {
    code: 'MAIL_REGISTER', name: '账号激活验证码', group: 'security', template: 'code',
    audience: '本人填写的邮箱', when: '注册激活账号、首次设置密码时请求的邮箱验证码', mailOnly: true
  },
  {
    code: 'MAIL_PW_RESET', name: '密码重置验证码', group: 'security', template: 'code',
    audience: '本人登记的邮箱', when: '忘记密码时请求验证码', mailOnly: true
  },
  {
    code: 'MAIL_PW_CHANGED', name: '密码变更安全提醒', group: 'security', template: 'notice',
    audience: '本人', when: '密码被修改，或通过邮箱验证码重置成功后'
  },
  {
    code: 'MAIL_LOGIN_REMOTE', name: '异地登录提醒', group: 'security', template: 'notice',
    audience: '本人', when: '账号从新设备 / 新地区登录时'
  },

  /* ---------------- 活动与签到提醒 ---------------- */
  {
    code: 'MAIL_ACT_CREATE', name: '新活动发布', group: 'activity', template: 'notice',
    audience: '活动面向的普通学生', when: '管理端发布活动后'
  },
  {
    code: 'MAIL_REMINDER', name: '签到倒计时提醒', group: 'activity', template: 'notice',
    audience: '活动面向的普通学生', when: '活动开始前 60 / 30 / 10 / 5 分钟'
  },
  {
    code: 'MAIL_CHECKIN_START', name: '签到开放提醒', group: 'activity', template: 'notice',
    audience: '活动面向的普通学生', when: '签到窗口刚开放时'
  },
  {
    code: 'MAIL_ACT_START', name: '活动开始提醒', group: 'activity', template: 'notice',
    audience: '活动面向的普通学生', when: '活动开始时刻'
  },
  {
    code: 'MAIL_NOT_CHECKED', name: '缺勤提醒', group: 'activity', template: 'notice',
    audience: '缺勤的普通学生', when: '活动结束后仍未检测到签到记录'
  },

  /* ---------------- 请假 / 补签审核 ---------------- */
  {
    code: 'MAIL_LEAVE_RESULT', name: '请假审核结果', group: 'review', template: 'notice',
    audience: '申请人', when: '请假申请通过 / 驳回后'
  },
  {
    code: 'MAIL_MAKEUP_RESULT', name: '补签审核结果', group: 'review', template: 'notice',
    audience: '申请人', when: '补签申请通过 / 驳回后'
  },

  /* ---------------- 申诉与沟通 ---------------- */
  {
    code: 'MAIL_APPEAL_SUBMITTED', name: '申诉待审核', group: 'appeal', template: 'notice',
    audience: '有初审 / 终审权限的上级', when: '学生提交请假 / 补签申诉或提起复议时'
  },
  {
    code: 'MAIL_APPEAL_REPLY', name: '申诉沟通回复', group: 'appeal', template: 'notice',
    audience: '申诉沟通的另一方', when: '申诉内学生与管理员互相回复时'
  },

  /* ---------------- 工单与权限 ---------------- */
  {
    code: 'MAIL_WO_SUBMITTED', name: '新工单待审批', group: 'workorder', template: 'notice',
    audience: '工单指派的处理人', when: '下级提交权限工单 / 信息修改·反馈工单 / 账号重启用工单时'
  },
  {
    code: 'MAIL_WO_APPROVED', name: '工单已批准', group: 'workorder', template: 'notice',
    audience: '申请人', when: '工单被批准后'
  },
  {
    code: 'MAIL_WO_REJECTED', name: '工单已驳回', group: 'workorder', template: 'notice',
    audience: '申请人', when: '工单被驳回后'
  },
  {
    code: 'MAIL_WO_TIMEOUT', name: '工单超时驳回', group: 'workorder', template: 'notice',
    audience: '申请人', when: '工单超时未审批被自动驳回'
  },
  {
    code: 'MAIL_WO_REMINDER', name: '工单待办催办', group: 'workorder', template: 'notice',
    audience: '审批人', when: '待审批工单挂起超过阈值（默认 30 分钟）'
  },
  {
    code: 'MAIL_GRANT_NOTICE', name: '权限授予通知', group: 'workorder', template: 'notice',
    audience: '被授权人', when: '上级直接下放权限时'
  },

  /* ---------------- 系统与维护 ---------------- */
  {
    code: 'MAIL_MAINTENANCE_PRE', name: '维护预告', group: 'system', template: 'notice',
    audience: '全体账号', when: '系统进入维护模式前'
  },
  {
    code: 'MAIL_MAINTENANCE_POST', name: '维护结束', group: 'system', template: 'notice',
    audience: '全体账号', when: '维护结束、功能恢复后'
  },
  {
    code: 'MAIL_SESSION_KILLED', name: '会话被强制结束', group: 'system', template: 'notice',
    audience: '被下线的账号', when: '维护或管理员强制结束某台设备会话'
  },
  {
    code: 'MAIL_PRIVACY_UPDATE', name: '隐私告知变更', group: 'system', template: 'notice',
    audience: '全体账号', when: '隐私告知文案更新后'
  },
  {
    code: 'MAIL_ANNOUNCEMENT', name: '系统公告', group: 'system', template: 'notice',
    audience: '全体账号', when: '运维者 / 管理员发布新公告'
  },
  {
    code: 'MAIL_ACCOUNT_NOTICE', name: '账号 / 角色变更', group: 'system', template: 'notice',
    audience: '被变更的账号', when: '身份、资料、启用状态等账号信息被修改'
  },
  {
    code: 'MAIL_AUTO_COVER_GRANT', name: '自动代管已开通', group: 'system', template: 'notice',
    audience: '代为行使上级权力的班委（或小班主任）',
    when: '系统中不存在可用的小班主任 / 辅导员时，自动授予其基线权力'
  },
  {
    code: 'MAIL_AUTO_COVER_REVOKE', name: '自动代管已收回', group: 'system', template: 'notice',
    audience: '曾被自动代管的班委（或小班主任）',
    when: '上级账号到岗（本人设密激活 / 预置 / 恢复）或管理员关闭自动代管时'
  },

  /* ---------------- 运维与反馈 ---------------- */
  {
    code: 'MAIL_OPS_ALERT', name: '运维告警', group: 'ops', template: 'notice',
    audience: '运维者', when: '系统检测到异常（如短时间大量登录失败）', mailOnly: true
  },
  {
    code: 'MAIL_FEEDBACK', name: '网站问题反馈', group: 'ops', template: 'notice',
    audience: '运维者登记的反馈邮箱', when: '用户通过「反馈网站问题」提交内容'
  },

  /* ---------------- 操作回执 ---------------- */
  {
    code: 'MAIL_RECEIPT', name: '操作回执', group: 'receipt', template: 'notice',
    audience: '被操作的账号 / 工单申请人',
    when: '管理员补签 / 退签 / 代请假、工单提交回执、「信息修改 / 反馈」处理结果、重启用工单提交回执等'
  }
];

/** code -> 类型定义 */
const BY_CODE = {};
/** 常量式引用：MAIL.WO_APPROVED === 'MAIL_WO_APPROVED' */
const MAIL = {};
TYPES.forEach(t => {
  BY_CODE[t.code] = t;
  MAIL[t.code.replace(/^MAIL_/, '')] = t.code;
});

/** 未登记类型时的兜底中文名 */
const FALLBACK_NAME = '系统邮件';

function mailType(code) {
  return BY_CODE[String(code || '')] || null;
}

/** 取中文名：未登记的类型返回兜底名（绝不回退英文 key） */
function mailTypeName(code) {
  const t = mailType(code);
  return t ? t.name : FALLBACK_NAME;
}

/** 是否是已登记的邮件类型码 */
function isMailType(code) {
  return !!mailType(code);
}

/** code -> 中文名 映射（兼容旧调用方） */
function mailTypeNames() {
  const out = {};
  TYPES.forEach(t => { out[t.code] = t.name; });
  return out;
}

/** 按分组归好的清单（供邮件预览索引页 / 前端展示） */
function mailTypesByGroup() {
  return GROUPS.map(g => ({
    key: g.key,
    name: g.name,
    types: TYPES.filter(t => t.group === g.key)
  })).filter(g => g.types.length);
}

/** 必须用邮件送达的类型码集合（验证码 / 运维告警） */
function mailOnlyTypes() {
  return TYPES.filter(t => t.mailOnly).map(t => t.code);
}

function isMailOnly(code) {
  const t = mailType(code);
  return !!(t && t.mailOnly);
}

module.exports = {
  GROUPS,
  TYPES,
  MAIL,
  MAIL_TYPES: BY_CODE,
  MAIL_TYPE_NAMES: mailTypeNames(),
  FALLBACK_NAME,
  mailType,
  mailTypeName,
  isMailType,
  mailTypeNames,
  mailTypesByGroup,
  mailOnlyTypes,
  isMailOnly
};
