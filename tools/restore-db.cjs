#!/usr/bin/env node
/**
 * 从备份恢复数据库（配合 tools/factory-reset.cjs 使用）
 * 用法：node tools/restore-db.cjs <备份文件路径> [目标app.db路径]
 */
const fs = require('fs');
const path = require('path');
const src = process.argv[2];
const dst = process.argv[3] || path.join(__dirname, '..', 'data', 'app.db');
if (!src || !fs.existsSync(src)) { console.error('请提供有效的备份文件路径作为第1个参数'); process.exit(1); }
fs.copyFileSync(src, dst);
console.log(`已恢复：${src} -> ${dst}`);
console.log('恢复后请重启服务使连接重新加载。');
