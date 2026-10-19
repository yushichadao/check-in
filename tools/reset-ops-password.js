'use strict';
/**
 * 运维者密码复位（服务器后台命令）
 *
 * 适用场景：运维者忘记密码，且服务器未配置邮件（无法用「忘记密码 → 邮箱验证码」自助重置）时，
 * 由运维 / 运维者在部署服务器的终端执行此命令，直接重置运维者账号密码。
 *
 * 用法：
 *   npm run reset-ops                                   # 自动生成 16 位随机密码并打印
 *   node tools/reset-ops-password.js --name 运维者        # 多个运维者时指定姓名
 *   node tools/reset-ops-password.js --pwd "新密码"        # 直接指定密码（需满足强度要求）
 *
 * 安全约定：
 *   - 仅作用于 role = 'ops' 的账号；
 *   - 重置后强制下次登录修改密码（must_change_pwd = 1）；
 *   - 同时清除该账号的全部在线会话（session_id = NULL），使新密码立即生效。
 */

const db = require('../server/db');
const A = require('../server/auth');

function genPwd() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const name = arg('--name');
let newPwd = arg('--pwd');

const devs = db.prepare("SELECT id, real_name FROM users WHERE role = 'ops' ORDER BY id").all();
if (!devs.length) {
  console.error('未找到任何运维者账号，无法重置。请先运行 npm run seed 初始化数据库。');
  process.exit(1);
}

let target;
if (name) {
  target = devs.find(d => d.real_name === name);
  if (!target) {
    console.error('未找到名为「' + name + '」的运维者账号。现有运维者：' + devs.map(d => d.real_name).join('、'));
    process.exit(1);
  }
} else if (devs.length > 1) {
  console.error('检测到多个运维者账号，请用 --name 指定要重置的姓名。现有运维者：' + devs.map(d => d.real_name).join('、'));
  process.exit(1);
} else {
  target = devs[0];
}

if (!newPwd) newPwd = genPwd();

const reason = A.validatePassword(newPwd);
if (reason) {
  console.error('密码不符合强度要求：' + reason);
  process.exit(1);
}

const hash = A.hashPassword(newPwd);
// 同时标记邮箱已验证：这是服务器终端的应急复位通道，不走邮箱验证码，
// 若不置为已验证，运维者会因「注册必须邮箱验证」的规则被彻底锁死在登录页之外。
db.prepare("UPDATE users SET password_hash = ?, must_change_pwd = 1, email_verified = 1, session_id = NULL WHERE id = ?").run(hash, target.id);

console.log('==================================================');
console.log('  已重置运维者账号密码（服务器后台命令）');
console.log('  账号：' + target.real_name + '（id=' + target.id + '）');
console.log('  新密码：' + newPwd);
console.log('  已强制下次登录修改密码，并已清除其全部在线会话。');
console.log('==================================================');
