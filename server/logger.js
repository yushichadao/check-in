'use strict';
const datalog = require('./datalog');

/** 事件类型 → 数据流分类（用于数据流页过滤） */
function categoryOf(type) {
  const t = String(type || '');
  if (/^work_order/.test(t)) return 'workorder';
  if (/^(leave|makeup)/.test(t)) return 'appeal';
  if (/^(user|account|pwd)/.test(t)) return 'account';
  if (/^activity/.test(t)) return 'activity';
  if (/^fence/.test(t)) return 'fence';
  if (/^(login|logout|session)/.test(t)) return 'auth';
  if (/^(checkin|supplement)/.test(t)) return 'checkin';
  return 'system';
}

/** 记录业务事件（不含定位、不含密码等敏感信息）；统一写入数据流 data_flow（events 表已废弃） */
function recordEvent(type, actorId, targetId, detail, payload) {
  const d = detail == null ? null : String(detail).slice(0, 300);
  // 单一审计源：data_flow。target_id 保留被操作对象（用户/活动/工单 id），与原 events.target_id 语义一致。
  datalog.record({
    category: categoryOf(type),
    action: String(type || ''),
    actor_id: actorId || null,
    subject_id: actorId || targetId || null,
    target_id: targetId != null ? Number(targetId) : null,
    target: targetId == null ? '' : String(targetId),
    detail: d == null ? '' : d,
    channel: 'none',
    payload: payload != null ? payload : null
  });
}

/** 控制台日志：只输出非敏感元数据 */
function log(level, msg, meta) {
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta || {})
  };
  console.log(JSON.stringify(line));
}

module.exports = { recordEvent, log, categoryOf };
