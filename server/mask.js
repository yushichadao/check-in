'use strict';

/** 姓名脱敏：保留首位与末位、中间打码（张伟→张*；李晓明→李*明；阿不都热合曼→阿******曼）；系统不打码 */
function maskName(name) {
  if (!name) return '-';
  const s = String(name);
  if (s === '系统') return s;
  if (s.length <= 1) return s + '*';
  if (s.length === 2) return s[0] + '*';
  return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
}

/** 学号脱敏：仅保留可区分的末位若干位（U202600001 -> ****0001） */
function maskStudent(studentId) {
  if (!studentId) return '-';
  const s = String(studentId);
  return '****' + s.slice(-4);
}

/** IP 脱敏：203.0.113.25 -> 203.0.113.* */
function maskIp(ip) {
  if (!ip) return '-';
  const s = String(ip);
  const parts = s.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  return s.slice(0, 6) + '***';
}

function maskUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: maskName(u.real_name),
    student_id: u.student_id ? maskStudent(u.student_id) : null,
    role_title: u.role_title,
    role: u.role
  };
}

/**
 * 邮箱脱敏：本地部分「首尾各留 1 位」+ *** + 完整域名（域名保留，便于区分邮箱服务商）。
 *   'abcdef@qq.com' -> 'a***f@qq.com'
 *   'a@qq.com'      -> 'a***@qq.com'（本地部分仅 1 位时退化，避免末位与首位重复暴露）
 * 全站统一规则：只有本人能看到自己的完整邮箱；任何端查看他人邮箱一律调用本函数。
 */
function maskEmail(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return '';
  // 逐段匹配邮箱再打码：既能处理「纯邮箱」，也能处理自由文本里夹杂的邮箱
  const re = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  let hit = false;
  const out = t.replace(re, (m0, local, domain) => {
    hit = true;
    if (local.length <= 1) return local + '***@' + domain;
    return local[0] + '***' + local[local.length - 1] + '@' + domain;
  });
  // 不是邮箱的文本原样返回（是否进一步脱敏由调用方决定）
  return hit ? out : t;
}

module.exports = { maskName, maskStudent, maskIp, maskUser, maskEmail };
