'use strict';
/**
 * 依赖自检 + 自动修复（独立命令）：npm run verify:deps
 *
 * 与 server/index.js 启动时执行的是同一套逻辑（server/deps-check.js）：
 *   ① 读取 better-sqlite3 实际安装版本与二进制产物；
 *   ② 在子进程里冒烟加载一次（真正的崩溃风险只有这一步能发现）；
 *   ③ 未安装 / 版本漂移 / 加载失败时自动修复（npm install <锁定版本> → npm rebuild）后复验。
 * 只在「加载不了」时以非 0 退出；仅版本漂移会告警放行（避免把可用环境拦死）。
 *
 * 可跳过：SKIP_DEP_CHECK=1（全部跳过）、SKIP_DEP_SMOKE=1（只跳过子进程冒烟）、
 *         DEP_AUTO_FIX=0（只报告不修复）。
 */
require('../server/deps-check').run();
