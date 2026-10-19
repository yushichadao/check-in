'use strict';
/**
 * 启动期依赖自检 + 自动修复：better-sqlite3（原生模块）。
 *
 * 背景（本项目已多次踩坑）：
 *   原生模块与 Node 的 ABI 强绑定，一旦 node_modules 被外部操作覆盖成别的版本，
 *   require 时可能直接**段错误（SIGSEGV）崩溃**，try/catch 抓不到，
 *   表现为 PM2 errored、nginx 502，日志里几乎没有可用信息。
 *
 * 因此本模块的判断准则是「能不能安全加载」，而不是死盯版本号：
 *   ① 先在不加载模块的前提下读取已安装版本与二进制产物；
 *   ② 再在**子进程**里 require 一次做冒烟（子进程崩了主进程也能给出可读错误）；
 *   ③ 若「缺失 / 加载失败 / 版本漂移」，先尝试自动修复
 *      （npm install better-sqlite3@<锁定版本> → npm rebuild better-sqlite3），
 *      修复后重新验证；已能正常加载就放行启动，不再把可用环境拦死。
 *
 * 只在「确实加载不了」时才终止启动——那才是真正会段错误崩溃的情况。
 *
 * 环境变量：
 *   SKIP_DEP_CHECK=1  完全跳过自检
 *   SKIP_DEP_SMOKE=1  跳过子进程冒烟（不推荐：失去段错误的提前发现能力）
 *   DEP_AUTO_FIX=0    关闭自动修复，只报告
 *   DEP_AUTO_FIX=align 版本与 package.json 不一致时也自动对齐（默认只告警，不改动可用环境）
 *   DEP_AUTO_FIX=ci   同上，且兜底执行 npm ci（重装全部依赖，慢）
 *   DEP_FIX_TTL_MS    修复尝试的最小间隔（默认 10 分钟，避免 PM2 重启风暴里反复执行 npm）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MOD = 'better-sqlite3';
const FIX_LOCK = path.join(ROOT, '.deps-fix.lock');
const FIX_TTL_MS = Number(process.env.DEP_FIX_TTL_MS) || 10 * 60 * 1000;
const REPAIR_TIMEOUT_MS = Number(process.env.DEP_FIX_TIMEOUT_MS) || 5 * 60 * 1000;

function lines(l) { l.filter(Boolean).forEach(x => console.error('  ' + x)); }

function fatal(l) {
  console.error('==================================================');
  lines(l);
  console.error('==================================================');
  process.exit(1);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/** 已安装的二进制产物（存在且非空才算可用） */
function hasBinding() {
  const base = path.join(ROOT, 'node_modules', MOD, 'build', 'Release', 'better_sqlite3.node');
  try { return fs.statSync(base).size > 0; } catch (e) { return false; }
}

/** 当前环境探测：安装了什么版本、二进制在不在、能不能加载 */
function probe() {
  const pkg = readJson(path.join(ROOT, 'node_modules', MOD, 'package.json'));
  const st = { version: pkg ? pkg.version : null, binding: hasBinding(), loadOk: false, tail: '' };
  if (process.env.SKIP_DEP_SMOKE === '1') {
    st.loadOk = !!st.binding;
    st.tail = '';
    return st;
  }
  const r = spawnSync(process.execPath, ['-e', `require('${MOD}')`], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000
  });
  st.loadOk = !r.error && r.status === 0 && !r.signal;
  st.tail = String(r.stderr || '').split(/\r?\n/).filter(Boolean).slice(0, 5).join('\n    ');
  if (r.error) st.tail = 'error=' + r.error.message + (st.tail ? '\n    ' + st.tail : '');
  else if (r.status !== 0 || r.signal) st.tail = `status=${r.status} signal=${r.signal || '-'}` + (st.tail ? '\n    ' + st.tail : '');
  return st;
}

/**
 * 修复锁：同一时间内只让一个进程执行 npm 修复。
 * 避免 PM2 崩溃重启循环里并发跑多个 npm install（会互相踩 node_modules）。
 */
function acquireFixLock() {
  try {
    const st = fs.statSync(FIX_LOCK);
    if (Date.now() - st.mtimeMs < FIX_TTL_MS) return false;
  } catch (e) { /* 不存在即可获取 */ }
  try {
    fs.writeFileSync(FIX_LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n', { flag: 'wx' });
    return true;
  } catch (e) {
    try { fs.utimesSync(FIX_LOCK, new Date(), new Date()); } catch (e2) { /* 忽略 */ }
    return false;
  }
}
function releaseFixLock() {
  try { fs.unlinkSync(FIX_LOCK); } catch (e) { /* 忽略 */ }
}

function runNpm(args) {
  console.warn(`[deps] 自动修复：npm ${args.join(' ')}（最多等待 ${Math.round(REPAIR_TIMEOUT_MS / 1000)}s）`);
  // Windows 下 spawn('npm.cmd') 会报 EINVAL，且 ES 参数 + shell 会触发 Node 的 DEP0190 警告，
  // 故这里拼成单条命令串执行（参数均为本文件内的固定常量，不含外部输入）。
  const command = `npm ${args.join(' ')}`;
  const r = spawnSync(command, {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    timeout: REPAIR_TIMEOUT_MS, shell: true
  });
  if (r.error) console.warn('[deps] 修复命令未能执行：' + r.error.message);
  else if (r.status !== 0 || r.signal) {
    const tail = String(r.stderr || '').split(/\r?\n/).filter(Boolean).slice(-5).join('\n    ');
    console.warn('[deps] 修复命令返回异常 status=' + r.status + (tail ? '\n    ' + tail : ''));
  }
  return !r.error && r.status === 0 && !r.signal;
}

/** 按「先对齐版本、再重编译二进制」的顺序自动修复，每步之后立即复验 */
function autoFix(want) {
  if (process.env.DEP_AUTO_FIX === '0') return null;
  if (!acquireFixLock()) {
    console.warn('[deps] 已有进程正在修复依赖（或刚尝试过），本次跳过自动修复');
    return null;
  }
  try {
    const steps = [];
    // 版本漂移是本项目历史上最主要的理由：先用锁定版本覆盖回去
    steps.push(['install', `${MOD}@${want}`, '--no-audit', '--no-fund', '--prefer-offline', '--save-exact']);
    // 二进制缺失 / ABI 不符（换过 Node 大版本）：本地重编译
    steps.push(['rebuild', MOD]);
    if (process.env.DEP_AUTO_FIX === 'ci') steps.push(['ci', '--no-audit', '--no-fund']);

    let last = probe();
    for (const args of steps) {
      runNpm(args);
      last = probe();
      if (last.loadOk && last.version === want) {
        console.log(`[deps] 依赖已自动修复：better-sqlite3 ${last.version}（Node ${process.version}）`);
        return last;
      }
    }
    return last;
  } finally {
    releaseFixLock();
  }
}

function run() {
  if (process.env.SKIP_DEP_CHECK === '1') {
    console.log('[deps] SKIP_DEP_CHECK=1，跳过依赖校验');
    return;
  }

  const pkg = readJson(path.join(ROOT, 'package.json')) || {};
  const want = (pkg.dependencies || {})[MOD];
  if (!want) return;   // 未声明则不校验

  let st = probe();

  // 1) 未安装 / 二进制缺失 / 加载失败：会真的段错误崩溃，默认自动修复。
  //    仅「版本漂移但能正常加载」属于隐患而非故障，默认只告警；
  //    需要强制对齐时设 DEP_AUTO_FIX=align（或 ci）。
  const drifted = !!st.version && st.version !== want;
  const align = process.env.DEP_AUTO_FIX === 'align' || process.env.DEP_AUTO_FIX === 'ci';
  if (!st.version || !st.loadOk || (drifted && align)) {
    const fixed = autoFix(want);
    if (fixed) st = fixed;
  }

  if (!st.version) {
    fatal([
      `未安装 ${MOD}（原生模块缺失，服务无法启动），且自动修复未成功`,
      `  package.json 声明：${want}`,
      '  手工修复（严格按 package-lock.json 安装）：',
      '    rm -rf node_modules && npm ci',
      '  离线环境可先在有网的机器安装后拷贝 node_modules，或设置 npm 离线镜像。',
      '  临时跳过自检（仅调试用）：SKIP_DEP_CHECK=1'
    ]);
  }

  // 2) 版本漂移：能否加载才是关键。加载正常则只告警（保证可用环境不被拦死）
  if (st.version !== want) {
    console.warn('==================================================');
    lines([
      `[deps] 警告：${MOD} 实际版本 ${st.version} 与 package.json 声明的 ${want} 不一致`,
      '        已确认当前版本可在 Node ' + process.version + ' 下正常加载，故继续启动；',
      '        但建议尽快对齐到锁定版本，避免后续 ABI / 行为差异：DEP_AUTO_FIX=align npm start，',
      '        或手工执行：rm -rf node_modules && npm ci',
      '        反复被覆盖时请排查：宝塔「Node 项目」安装依赖按钮、IDE / SFTP 同步 node_modules、部署脚本里的 npm install。',
      '        不想看到任何自动修复（只报告）：DEP_AUTO_FIX=0'
    ]);
    console.warn('==================================================');
  }

  // 3) 加载不了 = 真正会在 require 时段错误崩溃，必须拦住
  if (!st.loadOk) {
    fatal([
      `${MOD} 已安装（${st.version}）但无法加载，继续启动会在 require 时段错误崩溃（SIGSEGV / 502）`,
      `  当前 Node：${process.version}（ABI ${process.versions.modules}）　package.json 声明：${want}`,
      `  二进制产物：${st.binding ? '存在但不匹配' : '缺失'}`,
      st.tail ? '    ' + st.tail : '',
      '  自动修复未能解决，请手工执行：',
      '    npm rebuild ' + MOD,
      '    rm -rf node_modules && npm ci',
      '  临时跳过自检（仅调试用，风险自负）：SKIP_DEP_CHECK=1'
    ]);
  }

  console.log(`[deps] ${MOD} ${st.version} 就绪（Node ${process.version}，加载冒烟通过）`);
}

module.exports = { run };
