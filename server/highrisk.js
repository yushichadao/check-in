'use strict';
/**
 * 高危操作「动态固定文字」规范
 * ------------------------------------------------------------------
 *  - 文案按场景动态生成（不由用户自定义）；
 *  - 长度 10–15 字（含标点，结尾统一用句号）；
 *  - 前端逐字输入、禁止粘贴；后端按同一规则校验完全一致。
 *
 * 生成式：`确认{场景词}。`
 *   例：撤回 → 「确认撤回本操作。」（需逐字输入，禁止粘贴）
 */
const A = require('./auth');

/** 场景标识 → 场景词 */
const SCENE_WORD = {
  withdraw: '撤回本操作',
  bulk_delete_user: '批量清除账号',
  delete_user: '清除账号数据',
  delete_dataflow: '删除该条记录',
  restore_user: '恢复该账号',
  reset_defaults: '清空并恢复默认',
  bulk_delete_dataflow: '批量删除记录'
};

/** 生成某场景的固定确认文字（不含「请输入：」前缀，避免被误计入用户输入） */
function textFor(scene) {
  const word = SCENE_WORD[scene] || '执行本操作';
  return `确认${word}。`;
}

/** 校验提交的确认文字是否与场景一致 */
function matches(scene, text) {
  return String(text == null ? '' : text).trim() === textFor(scene);
}

/**
 * 校验高危操作：本人密码 + 场景动态固定文字。
 * @returns {string|null} 错误信息；null 表示通过
 */
function verify(req, scene) {
  const u = req.user;
  if (!u) return '未登录';
  if (!u.password_hash) return '当前账号尚未设置密码，无法执行高危操作';
  const body = req.body || {};
  if (!A.verifyPassword(String(body.password || ''), u.password_hash)) return '操作者密码不正确';
  if (!matches(scene, body.confirm_text)) return `确认文字不一致，请输入「${textFor(scene)}」`;
  return null;
}

module.exports = { textFor, matches, verify, SCENE_WORD };
