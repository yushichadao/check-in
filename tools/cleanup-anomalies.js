'use strict';
/**
 * 扫描并清理「开始时间 >= 结束时间」的异常活动（0 分钟 / 负时长活动）。
 *
 * 为什么会有这种数据：
 *   正常创建活动（临时 / 子活动 / 长期活动）在服务端都有 `end <= start` 校验会被直接拒绝，
 *   因此这类数据只可能来自历史脏数据、手动 INSERT 或外部工具，并非系统正常产物。
 *   它会导致「今日活动」等统计出现 0 分钟、缺勤/待签到口径错乱等问题。
 *
 * 用法（默认 dry-run，不改动数据，仅列出）：
 *   node tools/cleanup-anomalies.js
 * 确认无误后真正删除（连同其签到 / 请假记录级联清理）：
 *   node tools/cleanup-anomalies.js --apply
 */
const db = require('../server/db');

const dryRun = !process.argv.includes('--apply');

const bad = db.prepare(
  'SELECT id, title, start_time, end_time, is_group, parent_id FROM activities WHERE start_time >= end_time ORDER BY id'
).all();

if (!bad.length) {
  console.log('未发现「开始时间 >= 结束时间」的异常活动，无需清理。');
  process.exit(0);
}

const fmt = (ts) => (ts ? new Date(ts).toISOString() : '-');
console.log('发现 ' + bad.length + ' 条异常活动（start_time >= end_time）：');
bad.forEach(a => {
  console.log(`  #${a.id} "${a.title}" start=${fmt(a.start_time)} end=${fmt(a.end_time)} is_group=${a.is_group} parent_id=${a.parent_id}`);
});

if (dryRun) {
  console.log('\n以上为预览（dry-run），未做任何改动。确认要删除这些活动及其签到 / 请假记录，请加 --apply 参数执行。');
  process.exit(0);
}

// 收集要删除的活动 id：异常活动本身 + （若是长期活动分组）其下全部子活动
const toDelete = new Set();
bad.forEach(a => {
  toDelete.add(a.id);
  if (a.is_group === 1) {
    db.prepare('SELECT id FROM activities WHERE parent_id = ?').all(a.id).forEach(k => toDelete.add(k.id));
  }
});

const delCheckins = db.prepare('DELETE FROM checkins WHERE activity_id = ?');
const delLeaves = db.prepare('DELETE FROM leave_requests WHERE activity_id = ?');
const delAct = db.prepare('DELETE FROM activities WHERE id = ?');

const tx = db.transaction((ids) => {
  ids.forEach(id => {
    delCheckins.run(id);
    delLeaves.run(id);
    delAct.run(id);
  });
});
tx([...toDelete]);

console.log('\n已删除 ' + toDelete.size + ' 条活动（含级联清理的签到 / 请假记录）。');
