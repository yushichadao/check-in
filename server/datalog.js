'use strict';
const db = require('./db');

const insertStmt = db.prepare(`
  INSERT INTO data_flow (category, action, actor_id, subject_id, target_id, target, detail, channel, payload, created_at)
  VALUES (@category, @action, @actor_id, @subject_id, @target_id, @target, @detail, @channel, @payload, @created_at)
`);

function record(entry) {
  try {
    insertStmt.run({
      category:   entry.category   || 'system',
      action:     entry.action     || '',
      actor_id:   entry.actor_id   || null,
      subject_id: entry.subject_id || null,
      target_id:  entry.target_id  != null ? Number(entry.target_id) : null,
      target:     entry.target     != null ? String(entry.target) : '',
      detail:     entry.detail     != null ? String(entry.detail) : '',
      channel:    entry.channel    || 'none',
      payload:    entry.payload    != null ? (typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload)) : null,
      created_at: Date.now()
    });
  } catch (e) {
    console.error('[datalog] record failed:', e.message);
  }
}

module.exports = { record };
