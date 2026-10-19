'use strict';
const Database = require('better-sqlite3');
const { DB_PATH, roleLevelFromTitle } = require('./config');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  real_name       TEXT NOT NULL,
  student_id      TEXT UNIQUE,
  role_title      TEXT NOT NULL,
  role            TEXT NOT NULL CHECK(role IN ('ops','manager','normal')),
  password_hash   TEXT,
  must_change_pwd INTEGER NOT NULL DEFAULT 0,
  session_id      TEXT,
  device_id       TEXT,
  email           TEXT,
  disabled        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',   -- active | cancelled（已注销为软删、数据归档、不参与统计）
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fences (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  points_json  TEXT NOT NULL,
  coord_system TEXT NOT NULL DEFAULT 'GCJ-02',
  offset_lng   REAL NOT NULL DEFAULT 0,
  offset_lat   REAL NOT NULL DEFAULT 0,
  batch_key    TEXT,
  batch_name   TEXT,
  created_by   TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  start_time     INTEGER NOT NULL,
  end_time       INTEGER NOT NULL,
  fence_id       INTEGER,               -- 可为空：活动可以不使用活动范围
  policy         TEXT NOT NULL CHECK(policy IN ('before_start','before_end')),
  offset_minutes INTEGER NOT NULL DEFAULT 0,
  recurring      INTEGER NOT NULL DEFAULT 0,
  group_key      TEXT,
  parent_id      INTEGER,
  is_group       INTEGER NOT NULL DEFAULT 0,
  remark         TEXT,
  location       TEXT,                     -- 活动地点（文本，由管理端在活动管理里填写，与活动范围无关）
  creator_id     TEXT,
  created_at     INTEGER NOT NULL
);

-- 签到记录：仅保存活动范围判定结论，绝不保存经纬度
CREATE TABLE IF NOT EXISTS checkins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK(status IN ('signed','ontheway','leave','absent','cancelled')),
  in_fence    INTEGER,
  ip          TEXT,
  device_id   TEXT,
  manual      INTEGER NOT NULL DEFAULT 0,
  handler_id  TEXT,
  lat         REAL,
  lng         REAL,
  accuracy    REAL,
  created_at  INTEGER NOT NULL,
  UNIQUE(activity_id, user_id)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  reason      TEXT,
  by_admin    INTEGER NOT NULL DEFAULT 0,
  handler_id  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  is_appeal   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pwd_resets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        TEXT NOT NULL,
  requester_name TEXT,
  handled_by     TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),
  created_at     INTEGER NOT NULL
);

-- 数据流：只存非敏感元数据，不含定位
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  actor_id   TEXT,
  target_id  INTEGER,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

-- 登录会话/设备：支持一个账号在「一台手机 + 一台电脑」同时在线，并记录设备历史
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,           -- 会话ID（同时写入 JWT 的 sid）
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL,              -- 登录时的角色层级
  device_type TEXT NOT NULL,              -- mobile | desktop
  device_name TEXT,                       -- 设备/浏览器友好名
  device_key  TEXT,                       -- 设备指纹（浏览器本地标识）
  ip          TEXT,
  online      INTEGER NOT NULL DEFAULT 1, -- 1=在线，0=已下线/被替换
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  ended_at    INTEGER,
  end_reason  TEXT
);

-- 邮箱验证码（找回密码）：只存哈希、有效期与尝试次数，不含明文验证码
CREATE TABLE IF NOT EXISTS email_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  email      TEXT NOT NULL,
  -- email_hash：归一化（去空白 + 小写）邮箱的 SHA-256，用于「本次填写的邮箱是否与发码时一致」的比对；
  -- 该列历史上由迁移补充（见 migrateEmailCodePrivacy），此处直接写进建表语句，
  -- 保证「新建库」与「迁移过的旧库」结构一致（避免 register-code 因缺列直接 500）。
  email_hash TEXT,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 补签申请：活动结束后缺勤，普通学生发起申诉、由管理员审核
CREATE TABLE IF NOT EXISTS makeup_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  handler_id  TEXT,
  reply       TEXT,
  created_at  INTEGER NOT NULL,
  handled_at  INTEGER,
  UNIQUE(activity_id, user_id)
);

-- 系统设置（键值对）：是否允许普通学生补签、是否发提醒等
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 通知/提醒发送记录：用于去重，避免同一次提醒重复发邮件
CREATE TABLE IF NOT EXISTS notify_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  activity_id INTEGER,
  user_id     TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(kind, activity_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id);
CREATE INDEX IF NOT EXISTS idx_email_codes_user ON email_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_checkins_activity ON checkins(activity_id);
CREATE INDEX IF NOT EXISTS idx_activities_start ON activities(start_time);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_makeup_status ON makeup_requests(status);
`);

// 平滑升级：为已有数据库补充 session_id 列（单端登录）
(function migrate() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('session_id')) {
    db.exec('ALTER TABLE users ADD COLUMN session_id TEXT');
  }
  const fenceCols = db.prepare('PRAGMA table_info(fences)').all().map(c => c.name);
  if (!fenceCols.includes('batch_key')) {
    db.exec('ALTER TABLE fences ADD COLUMN batch_key TEXT');
  }
  if (!fenceCols.includes('batch_name')) {
    db.exec('ALTER TABLE fences ADD COLUMN batch_name TEXT');
  }
  const actCols = db.prepare('PRAGMA table_info(activities)').all().map(c => c.name);
  if (!actCols.includes('parent_id')) {
    db.exec('ALTER TABLE activities ADD COLUMN parent_id INTEGER');
  }
  if (!actCols.includes('is_group')) {
    db.exec('ALTER TABLE activities ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0');
  }
  if (!actCols.includes('remark')) {
    db.exec('ALTER TABLE activities ADD COLUMN remark TEXT');
  }
  if (!actCols.includes('location')) {
    db.exec('ALTER TABLE activities ADD COLUMN location TEXT');
  }
  // 目的地标记坐标（管理端在地图上打点；GCJ-02，与高德底图一致）
  if (!actCols.includes('dest_lng')) db.exec('ALTER TABLE activities ADD COLUMN dest_lng REAL');
  if (!actCols.includes('dest_lat')) db.exec('ALTER TABLE activities ADD COLUMN dest_lat REAL');
  // 发布配图（存于 data/uploads，仅走鉴权路由读取）
  if (!actCols.includes('image_file')) db.exec('ALTER TABLE activities ADD COLUMN image_file TEXT');
  // 多张配图：相对路径数组（JSON）；image_file 仍保留为第一张，兼容旧数据 / 旧客户端
  if (!actCols.includes('images_json')) db.exec('ALTER TABLE activities ADD COLUMN images_json TEXT');
  if (!cols.includes('disabled')) {
    db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('email')) {
    db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  }
  const ck = db.prepare('PRAGMA table_info(checkins)').all().map(c => c.name);
  if (!ck.includes('lat')) db.exec('ALTER TABLE checkins ADD COLUMN lat REAL');
  if (!ck.includes('lng')) db.exec('ALTER TABLE checkins ADD COLUMN lng REAL');
  if (!ck.includes('accuracy')) db.exec('ALTER TABLE checkins ADD COLUMN accuracy REAL');
  // 审核留言（随邮件发给普通学生）
  const lrCols = db.prepare('PRAGMA table_info(leave_requests)').all().map(c => c.name);
  if (!lrCols.includes('reply')) db.exec('ALTER TABLE leave_requests ADD COLUMN reply TEXT');
})();

/* ===================== RBAC 相关表 ===================== */
/**
 * 若库中已存在同名但结构不一致的历史表（早期试验版本），先丢弃重建，
 * 避免 CREATE TABLE IF NOT EXISTS 静默跳过导致后续索引 / 查询报「no such column」。
 */
(function dropStaleRbacTables() {
  const expect = {
    permission_grants: ['user_id', 'perm_code'],
    work_orders: ['applicant_id', 'perm_code'],
    account_scopes: ['admin_id', 'user_id']
  };
  Object.keys(expect).forEach(t => {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    if (!cols.length) return;                                  // 不存在，稍后新建
    const okSchema = expect[t].every(c => cols.includes(c));
    if (!okSchema) db.exec(`DROP TABLE ${t}`);
  });
})();

db.exec(`
-- 额外权限授予：角色基线之外的权限（AUTH_GRANT 下放 / 工单审批通过）
CREATE TABLE IF NOT EXISTS permission_grants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  perm_code   TEXT NOT NULL,
  granted_by  TEXT,
  source      TEXT NOT NULL DEFAULT 'grant',   -- grant | workorder
  expires_at  INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);

-- 权限工单：下→上申请高危权限
CREATE TABLE IF NOT EXISTS work_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id  TEXT NOT NULL,
  perm_code     TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'perm',   -- perm（权限申请）| info（信息修改 / 反馈）
  reason        TEXT,
  approver_ids  TEXT,                          -- 逗号分隔的审批人账号 ID
  status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','timeout')),
  handler_id    TEXT,
  reply         TEXT,
  granted_until INTEGER,
  created_at    INTEGER NOT NULL,
  handled_at    INTEGER
);

-- 账号管理范围：每个管理号独立绑定可管理账号清单（运维者为通配全局）
CREATE TABLE IF NOT EXISTS account_scopes (
  admin_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (admin_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_grants_user ON permission_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_scope_admin ON account_scopes(admin_id);

-- 网站问题反馈工单（用户提交的「反馈网站问题」入口，运维者受理）
CREATE TABLE IF NOT EXISTS feedbacks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id   TEXT,
  reporter_name TEXT,
  reporter_role TEXT,
  type          TEXT NOT NULL DEFAULT 'bug',     -- bug（功能异常）| suggest（功能建议）| other（其他）
  subject       TEXT NOT NULL,
  content       TEXT NOT NULL,
  contact       TEXT,
  channel_ticket INTEGER NOT NULL DEFAULT 1,       -- 是否记录为系统内工单
  channel_email  INTEGER NOT NULL DEFAULT 0,       -- 是否同时发送邮件给运维者
  status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','handled','closed')),
  reply         TEXT,
  handled_by    TEXT,
  handled_at    INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks(created_at);
CREATE INDEX IF NOT EXISTS idx_feedbacks_reporter ON feedbacks(reporter_id);
`);

/* ---------------- 平滑升级：补充 RBAC 相关列 ---------------- */
(function migrateRbac() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('role_level')) {
    db.exec('ALTER TABLE users ADD COLUMN role_level INTEGER');
  }
  // 身份/等级回填：运维者=9，历史 manager 按身份映射（班长/学委→班委 1，辅导员→3），其余=0
  const lvl = db.prepare('SELECT id, role, role_title, role_level FROM users').all();
  const upd = db.prepare('UPDATE users SET role_level = ? WHERE id = ?');
  db.transaction(() => {
    lvl.forEach(u => {
      if (u.role_level !== null && u.role_level !== undefined) return;
      const lv = roleLevelFromTitle(u.role, u.role_title);
      upd.run(lv, u.id);
    });
  })();

  const fenceCols = db.prepare('PRAGMA table_info(fences)').all().map(c => c.name);
  if (!fenceCols.includes('created_by')) {
    db.exec('ALTER TABLE fences ADD COLUMN created_by TEXT');
  }
  // 申诉（请假 / 补签）地点文本：与「定位模式」解耦，始终可独立填写
  const lrCols = db.prepare('PRAGMA table_info(leave_requests)').all().map(c => c.name);
  if (!lrCols.includes('location')) db.exec('ALTER TABLE leave_requests ADD COLUMN location TEXT');
  // is_appeal：标记「事后请假」申诉（区别于窗口关闭前的正常请假）；
  // 申诉提交时不再预置「请假占位」，仅 pending 留痕，批准才落请假记录 —— 未回应/驳回一律按缺勤。
  if (!lrCols.includes('is_appeal')) db.exec('ALTER TABLE leave_requests ADD COLUMN is_appeal INTEGER NOT NULL DEFAULT 0');
  const mkCols = db.prepare('PRAGMA table_info(makeup_requests)').all().map(c => c.name);
  if (!mkCols.includes('location')) db.exec('ALTER TABLE makeup_requests ADD COLUMN location TEXT');
})();

/* ---------------- 工单：新增 kind（perm / info）字段，兼容旧库 ---------------- */
(function migrateWorkOrderKind() {
  const cols = db.prepare('PRAGMA table_info(work_orders)').all().map(c => c.name);
  if (!cols.includes('kind')) {
    db.exec(`ALTER TABLE work_orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'perm'`);
  }
})();

/* ---------------- 一次性清理：删除所有非运维者测试数据 ---------------- */
(function cleanTestData() {
  const flag = db.prepare("SELECT value FROM settings WHERE key = 'rbac_clean_v1'").get();
  if (flag) return;
  const tx = db.transaction(() => {
    const ids = db.prepare("SELECT id FROM users WHERE role <> 'ops'").all().map(r => r.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const where = (col) => `WHERE ${col} IN (${ph})`;
      db.prepare(`DELETE FROM checkins ${where('user_id')}`).run(...ids);
      db.prepare(`DELETE FROM leave_requests ${where('user_id')}`).run(...ids);
      db.prepare(`DELETE FROM makeup_requests ${where('user_id')}`).run(...ids);
      db.prepare(`DELETE FROM pwd_resets ${where('user_id')}`).run(...ids);
      db.prepare(`DELETE FROM email_codes ${where('user_id')}`).run(...ids);
      db.prepare(`DELETE FROM notify_log ${where('user_id')}`).run(...ids);
      db.prepare(`DELETE FROM sessions ${where('user_id')}`).run(...ids);
      db.prepare(`DELETE FROM permission_grants ${where('user_id')}`).run(...ids);
      db.prepare(`DELETE FROM work_orders ${where('applicant_id')}`).run(...ids);
      db.prepare(`DELETE FROM account_scopes ${where('user_id')}`).run(...ids);
      db.prepare(`DELETE FROM account_scopes ${where('admin_id')}`).run(...ids);
      db.prepare(`DELETE FROM data_flow WHERE actor_id IN (${ph}) OR subject_id IN (${ph})`).run(...ids, ...ids);
      db.prepare(`DELETE FROM events ${where('actor_id')}`).run(...ids);
      db.prepare(`DELETE FROM users ${where('id')}`).run(...ids);
    }
    // 业务数据（活动 / 活动范围 / 签到）一并清空，避免与改造后的权限模型冲突
    db.exec(`
      DELETE FROM checkins; DELETE FROM leave_requests; DELETE FROM makeup_requests;
      DELETE FROM notify_log; DELETE FROM activities; DELETE FROM fences;
      DELETE FROM sqlite_sequence WHERE name IN ('activities','fences','checkins','leave_requests','makeup_requests');
    `);
  });
  tx();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('rbac_clean_v1', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(Date.now()));
})();

/* ---------------- 定位核验总开关默认值 ---------------- */
(function initLocationVerify() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'location_verify_enabled'").get();
  if (!row) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('location_verify_enabled', '0')").run();
  }
})();

// 「活动前某一时刻签到」策略已彻底下线：把存量 custom 活动归一为 before_end（幂等，可重复执行）
(function migrateDropCustomPolicy() {
  db.exec("UPDATE activities SET policy = 'before_end' WHERE policy = 'custom'");
})();

// 「活动范围可选」：把历史库里 activities.fence_id 的 NOT NULL 约束去掉（SQLite 需重建表）
(function migrateOptionalFence() {
  const col = db.prepare('PRAGMA table_info(activities)').all().find(c => c.name === 'fence_id');
  if (!col || col.notnull !== 1) return;   // 新建库已是可空，无需处理

  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE activities_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        title          TEXT NOT NULL,
        start_time     INTEGER NOT NULL,
        end_time       INTEGER NOT NULL,
        fence_id       INTEGER,
        policy         TEXT NOT NULL CHECK(policy IN ('before_start','before_end')),
        offset_minutes INTEGER NOT NULL DEFAULT 0,
        recurring      INTEGER NOT NULL DEFAULT 0,
        group_key      TEXT,
        parent_id      INTEGER,
        is_group       INTEGER NOT NULL DEFAULT 0,
        remark         TEXT,
        location       TEXT,
        creator_id     TEXT,
        created_at     INTEGER NOT NULL
      );
      INSERT INTO activities_new (id, title, start_time, end_time, fence_id, policy, offset_minutes,
                                  recurring, group_key, parent_id, is_group, remark, location, creator_id, created_at)
        SELECT id, title, start_time, end_time, fence_id, policy, offset_minutes,
               recurring, group_key, parent_id, is_group, remark, location, creator_id, created_at
        FROM activities;
      DROP TABLE activities;
      ALTER TABLE activities_new RENAME TO activities;
      CREATE INDEX IF NOT EXISTS idx_activities_start ON activities(start_time);
      COMMIT;
    `);
  } catch (e) {
    try { db.exec('ROLLBACK;'); } catch (e2) { /* 忽略 */ }
    throw e;
  } finally {
    db.pragma('foreign_keys = ON');
  }
})();

/* ---------------- 权限码重命名：VIEW_LOC → VIEW_STUDENT_LOCATION（兼容旧库已存授权 / 工单） ---------------- */
(function migrateViewLocRename() {
  db.prepare("UPDATE permission_grants SET perm_code = 'VIEW_STUDENT_LOCATION' WHERE perm_code = 'VIEW_LOC'").run();
  db.prepare("UPDATE work_orders SET perm_code = 'VIEW_STUDENT_LOCATION' WHERE perm_code = 'VIEW_LOC'").run();
})();

/* ---------------- 申诉系统：裁决锁定 / 复议 / 附件 / 沟通消息 ---------------- */
(function migrateAppeal() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS appeal_attachments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      req_type    TEXT,
      request_id  INTEGER,
      uploader_id TEXT NOT NULL,
      file        TEXT NOT NULL,
      mime        TEXT,
      size        INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attach_req ON appeal_attachments(req_type, request_id);
    CREATE INDEX IF NOT EXISTS idx_attach_up ON appeal_attachments(uploader_id);

    CREATE TABLE IF NOT EXISTS appeal_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      req_type   TEXT NOT NULL,
      request_id INTEGER NOT NULL,
      sender_id  TEXT NOT NULL,
      sender_kind TEXT,
      body       TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_amsg ON appeal_messages(req_type, request_id);

    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      level      TEXT NOT NULL DEFAULT 'info',
      kind       TEXT,
      title      TEXT NOT NULL,
      body       TEXT,
      ref_type   TEXT,
      ref_id     INTEGER,
      created_at INTEGER NOT NULL,
      read_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

    /* 个人通知渠道偏好：每个账号对每类通知自选自用渠道。
     * channel: 'both'=站内+邮件（默认）；'inbox'=仅站内消息；'off'=完全不接收。
     * 必提醒（mandatory）与邮件验证码 / 安全类恒为 'both'，不受本表影响。 */
    CREATE TABLE IF NOT EXISTS user_notify_pref (
      user_id  TEXT NOT NULL,
      kind     TEXT NOT NULL,
      channel  TEXT NOT NULL DEFAULT 'both',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_unp_user ON user_notify_pref(user_id);
  `);

  // 两审制字段：locked=初审已裁决（本级不可改）；appealed=普通学生对裁决提出复议（才进入终审）
  const addCol = (table, col, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  ['leave_requests', 'makeup_requests'].forEach(t => {
    addCol(t, 'locked', 'locked INTEGER NOT NULL DEFAULT 0');
    addCol(t, 'appealed', 'appealed INTEGER NOT NULL DEFAULT 0');
    addCol(t, 'appeal_reason', 'appeal_reason TEXT');
    addCol(t, 'appealed_at', 'appealed_at INTEGER');
    addCol(t, 'final_status', 'final_status TEXT');
    addCol(t, 'final_handler_id', 'final_handler_id TEXT');
    addCol(t, 'final_reply', 'final_reply TEXT');
    addCol(t, 'final_at', 'final_at INTEGER');
    // 终审免审：当无更高层级终审人时，初审即终局并自动结案（或最高级自审自终），标注以避免双盲汇签
    addCol(t, 'final_waived', 'final_waived INTEGER NOT NULL DEFAULT 0');
  });
  addCol('leave_requests', 'handled_at', 'handled_at INTEGER');
  // 首次设置：新注册（预置）账号需完成「通知偏好」等首次设置才能进入；注销恢复的不强制
  addCol('users', 'must_setup', 'must_setup INTEGER NOT NULL DEFAULT 0');
  // 清爽模式：默认开启（1），降低用户端 UI 信息密度；旧库经 ALTER 自动填 1，老用户静默生效
  addCol('users', 'clean_mode', 'clean_mode INTEGER NOT NULL DEFAULT 1');
})();

/* ---------------- 数据流（审计留痕）：邮件 / 工单等系统操作，无论谁操作都留痕 ---------------- */
(function migrateDataFlow() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS data_flow (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      category   TEXT NOT NULL,          -- mail | workorder | appeal | account | activity | fence | auth | notify | system
      action     TEXT NOT NULL,          -- 动作码
      actor_id   TEXT,                   -- 操作者（NULL = 系统）
      actor_name TEXT,                   -- 操作者快照（便于加密后仍能区分）
      subject_id TEXT,                   -- 该记录「关于谁」（本人数据；用于按权限导出）
      target_id  INTEGER,                -- 被操作对象 id（用户 / 活动 / 工单等，语义与原 events.target_id 一致）
      target     TEXT,                   -- 目标（收件人 / 被操作账号等）
      detail     TEXT,                   -- 内容摘要 / 邮件主题
      channel    TEXT,                   -- inbox | email | both | none
      encrypted  INTEGER NOT NULL DEFAULT 0,
      payload    TEXT,
      withdrawn_by TEXT,
      withdrawn_at INTEGER,
      withdrawn_role TEXT,
      reversed   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dataflow_created ON data_flow(created_at);
    CREATE INDEX IF NOT EXISTS idx_dataflow_category ON data_flow(category);
    CREATE INDEX IF NOT EXISTS idx_dataflow_subject ON data_flow(subject_id);
    CREATE INDEX IF NOT EXISTS idx_dataflow_target ON data_flow(target_id);
  `);
  // 平滑升级：老库补列（仅当表为旧结构时）
  const dfCols = db.prepare('PRAGMA table_info(data_flow)').all().map(c => c.name);
  if (!dfCols.includes('payload')) db.exec('ALTER TABLE data_flow ADD COLUMN payload TEXT');
  if (!dfCols.includes('withdrawn_by')) db.exec('ALTER TABLE data_flow ADD COLUMN withdrawn_by TEXT');
  if (!dfCols.includes('withdrawn_at')) db.exec('ALTER TABLE data_flow ADD COLUMN withdrawn_at INTEGER');
  if (!dfCols.includes('withdrawn_role')) db.exec('ALTER TABLE data_flow ADD COLUMN withdrawn_role TEXT');
  if (!dfCols.includes('reversed')) db.exec('ALTER TABLE data_flow ADD COLUMN reversed INTEGER NOT NULL DEFAULT 0');
  if (!dfCols.includes('subject_id')) db.exec('ALTER TABLE data_flow ADD COLUMN subject_id TEXT');
})();

/* ---------------- 账号状态：新增 status（active | cancelled） ---------------- */
(function migrateUsers() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('status')) db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
})();

/* ---------------- 定位上传授权：本人自愿（NULL=未选择 / 0=不授权 / 1=授权），属个人隐私 ---------------- */
(function migrateLocConsent() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('loc_consent')) db.exec('ALTER TABLE users ADD COLUMN loc_consent INTEGER');
})();

/* ---------------- 维护模式：会话挂起标记（维护中非运维者会话临时挂起，结束后自动恢复） ---------------- */
(function migrateSessions() {
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
  if (!cols.includes('suspended')) {
    db.exec('ALTER TABLE sessions ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0');
  }
})();

/* ===================== 账号 ID：6 位「数字 + 大小写字母」唯一标识 ===================== */
const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 生成一个不重复的 6 位账号 ID（运维者固定为 000000，由调用方保证不进入 taken） */
function generateAccountId(taken) {
  const set = taken instanceof Set ? taken : new Set(taken || []);
  for (let i = 0; i < 2000; i++) {
    let s = '';
    for (let j = 0; j < 6; j++) s += ID_CHARS[(Math.random() * ID_CHARS.length) | 0];
    if (s === '000000') continue;          // 保留给运维者
    if (!set.has(s)) { set.add(s); return s; }
  }
  throw new Error('账号 ID 生成失败：可用空间不足');
}

/** 基于当前数据库生成一个全新的、保证唯一的账号 ID（恒定返回非空字符串，失败即抛错） */
db.newUserId = function newUserId() {
  // 只统计有效 id：历史脏数据里的 NULL 不应占用 ID 空间，也不应让生成结果为空
  const taken = new Set(db.prepare('SELECT id FROM users').all().map(r => r.id).filter(Boolean));
  const id = generateAccountId(taken);
  if (!id) throw new Error('账号 ID 生成失败：未能取得有效标识');
  return id;
};
db.generateAccountId = generateAccountId;

/** 引用「用户 id」的表及其列（不含通用 target_id），迁移与修复共用 */
const USER_ID_REF_TABLES = [
  ['checkins', ['user_id', 'handler_id']],
  ['leave_requests', ['user_id', 'handler_id']],
  ['pwd_resets', ['user_id', 'handled_by']],
  ['events', ['actor_id']],
  ['sessions', ['user_id']],
  ['email_codes', ['user_id']],
  ['makeup_requests', ['user_id', 'handler_id']],
  ['notify_log', ['user_id']],
  ['permission_grants', ['user_id', 'granted_by']],
  ['work_orders', ['applicant_id', 'handler_id']],
  ['account_scopes', ['admin_id', 'user_id']],
  ['data_flow', ['actor_id', 'subject_id', 'withdrawn_by']],
  ['appeal_attachments', ['uploader_id']],
  ['appeal_messages', ['sender_id']],
  ['notifications', ['user_id']],
  ['activities', ['creator_id']],
  ['fences', ['created_by']]
];

/**
 * 一次性迁移：将 users.id 由整数自增主键改为 6 位字符串主键，
 * 并同步把所有引用用户 ID 的表列改为 TEXT，重映射历史数据。
 * 仅运行一次（由 settings 标志位 guarding）。
 * 注意：events.target_id / data_flow.target_id 为「通用对象 id」（可能是活动/活动范围等），不属于用户 id，不做重映射。
 */
(function migrateUserIdToText() {
  const ui = db.prepare("PRAGMA table_info(users)").all().find(c => c.name === 'id');
  if (ui && ui.type === 'TEXT') {
    db.prepare("INSERT INTO settings(key,value) VALUES('user_id_text_v1','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    return;
  }
  const flag = db.prepare("SELECT value FROM settings WHERE key='user_id_text_v1'").get();
  if (flag) return;

  db.pragma('foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    const users = db.prepare('SELECT * FROM users').all();
    const taken = new Set();
    const map = new Map(); // 旧整数 id (number) -> 新字符串 id
    for (const u of users) {
      const nid = u.role === 'ops' ? '000000' : generateAccountId(taken);
      map.set(u.id, nid);
    }

    // 重建 users 表为 TEXT 主键：动态读取当前列清单（仅把 id 改为 TEXT），
    // 避免硬编码列清单漂移导致 loc_consent / clean_mode / email_verified 等列被静默丢弃。
    db.exec('DROP TABLE IF EXISTS users_old');
    db.exec('ALTER TABLE users RENAME TO users_old');
    const uInfo = db.prepare("PRAGMA table_info(users_old)").all();
    const uCols = uInfo.map(c => c.name);
    const uDefs = uInfo.map(c => c.name === 'id' ? 'id TEXT PRIMARY KEY' : `${c.name} ${c.type || 'TEXT'}`);
    db.exec(`CREATE TABLE users (${uDefs.join(', ')})`);
    const otherCols = uCols.filter(c => c !== 'id');
    const insU = db.prepare(`INSERT INTO users (id, ${otherCols.join(', ')}) VALUES (?, ${otherCols.map(() => '?').join(', ')})`);
    for (const u of users) insU.run(map.get(u.id), ...otherCols.map(c => u[c]));
    db.exec('DROP TABLE users_old');

    // 引用用户 id 的表及其用户列（不含通用 target_id）
    const refs = USER_ID_REF_TABLES;

    for (const [t, cols] of refs) {
      const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
      if (!exists) continue;
      const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE name=?`).get(t).sql;
      let newDdl = ddl;
      for (const c of cols) {
        newDdl = newDdl.replace(new RegExp(`\\b${c}\\s+INTEGER\\b`), `${c} TEXT`);
      }
      db.exec(`DROP TABLE IF EXISTS "${t}__m"`);
      db.exec(`ALTER TABLE "${t}" RENAME TO "${t}__m"`);
      db.exec(newDdl);
      const info = db.prepare(`PRAGMA table_info("${t}__m")`).all();
      const colNames = info.map(c => `"${c.name}"`).join(', ');
      db.exec(`INSERT INTO "${t}" (${colNames}) SELECT ${colNames} FROM "${t}__m"`);
      for (const c of cols) {
        const upd = db.prepare(`UPDATE "${t}" SET "${c}" = ? WHERE "${c}" = ?`);
        for (const [oldId, newId] of map) {
          if (oldId == null) continue;
          upd.run(newId, oldId);
        }
      }
      db.exec(`DROP TABLE "${t}__m"`);
    }

    // work_orders.approver_ids 是「逗号分隔的用户 ID」文本，需同步重映射
    {
      const rows = db.prepare("SELECT id, approver_ids FROM work_orders WHERE approver_ids IS NOT NULL AND approver_ids <> ''").all();
      const upd = db.prepare('UPDATE work_orders SET approver_ids = ? WHERE id = ?');
      for (const r of rows) {
        const remapped = String(r.approver_ids).split(',').map(s => s.trim()).filter(Boolean).map(s => {
          const n = Number(s);
          return (n && map.has(n)) ? map.get(n) : s;
        });
        upd.run(remapped.join(','), r.id);
      }
    }

    db.exec('COMMIT');
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO settings(key,value) VALUES('user_id_text_v1','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    db.pragma('foreign_keys = ON');
    throw e;
  }
})();

/**
 * 账号 ID 完整性修复：id 为 NULL / 空串 的行补发唯一 ID。
 * 背景：users.id 是 TEXT 主键，但 SQLite 允许写入 NULL，历史脏数据会出现 id 为空的账号；
 * 这类账号登录时建会话会因 sessions.user_id 的 NOT NULL 约束失败（表现为「注册后跳回登录页」、
 * 运维端显示「#null」）。此处在每次启动时自检并补发，保证 id 恒定非空。
 *
 * 说明：原 id 为 NULL 时无法可靠反查它在其它表中的引用（NULL 不参与等值匹配），
 * 且这类空 id 本就不可能有有效外键引用，故只修复 users.id 本身并留痕。
 */
(function repairMissingUserIds() {
  try {
    // 用 rowid 定位：id 为 NULL 时无法用 id 自身做条件更新
    const bad = db.prepare("SELECT rowid AS _rid, role FROM users WHERE id IS NULL OR TRIM(CAST(id AS TEXT)) = ''").all();
    if (!bad.length) return;
    const taken = new Set(db.prepare('SELECT id FROM users').all().map(r => String(r.id || '')).filter(Boolean));
    for (const u of bad) {
      // 运维者固定 000000；若已被占用则退化为生成一个新 ID，避免唯一约束冲突
      const nid = (u.role === 'ops' && !taken.has('000000')) ? '000000' : generateAccountId(taken);
      taken.add(nid);
      db.prepare('UPDATE users SET id = ? WHERE rowid = ?').run(nid, u._rid);
    }
    console.log(`[db] 账号 ID 自检：已为 ${bad.length} 个缺失标识的账号补发 ID`);
  } catch (e) {
    // 修复失败不阻断启动，但必须留痕
    console.warn('[db] 账号 ID 自检失败：' + (e && e.message));
  }
})();

/* ---------------- 注册邮箱验证标记：0=未验证（禁止登录） 1=已通过验证码校验 ---------------- */
(function migrateEmailVerified() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('email_verified')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  }
})();

/* ---------------- 邮箱验证码：邮箱字段隐私化（打码落库 + 归一化哈希比对） ----------------
 * 原实现把收件邮箱**明文**写入 email_codes.email（与 users.email 明文并存，形成额外泄露面）。
 * 现改为：
 *   - email 列仅存打码值（如 a***f@qq.com），不再落明文；
 *   - 新增 email_hash 列存「归一化（去空白 + 小写）邮箱」的 SHA-256，
 *     供「本次填写的邮箱是否与验证码下发时一致」的校验（routes/auth.js 用哈希比对）；
 *   - 历史行一次性回填：明文邮箱 → 打码值 + 哈希（以 email_hash 为空为判断，天然幂等）。
 */
(function migrateEmailCodePrivacy() {
  const cols = db.prepare('PRAGMA table_info(email_codes)').all().map(c => c.name);
  if (!cols.includes('email_hash')) db.exec('ALTER TABLE email_codes ADD COLUMN email_hash TEXT');

  const crypto = require('crypto');
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
  const hashOf = (s) => crypto.createHash('sha256').update(norm(s)).digest('hex');
  const maskEmail = (s) => {
    const t = norm(s);
    const at = t.lastIndexOf('@');
    if (at <= 0) return t;
    const local = t.slice(0, at);
    const domain = t.slice(at);
    if (local.length <= 1) return local + '***' + domain;
    return local[0] + '***' + local[local.length - 1] + domain;
  };
  const rows = db.prepare(
    "SELECT id, email FROM email_codes WHERE (email_hash IS NULL OR email_hash = '') AND email IS NOT NULL AND email <> ''"
  ).all();
  if (!rows.length) return;
  const upd = db.prepare('UPDATE email_codes SET email = ?, email_hash = ? WHERE id = ?');
  db.transaction(() => { rows.forEach(r => upd.run(maskEmail(r.email), hashOf(r.email), r.id)); })();
  console.log(`[db] 邮箱验证码隐私化：已回填 ${rows.length} 条记录（打码邮箱 + 哈希）`);
})();

/**
 * 收尾自检（幂等）：确保 email_codes.email_hash 一定存在。
 * 背景：register-code / email-reset 的 INSERT 依赖该列；实测出现过「同库其它迁移列都在、
 * 唯独该列缺失」的情况，导致注册取验证码直接 500。此处做一次兜底补齐，
 * 使「缺列即 500」不再可能出现在任何历史库上。
 */
(function ensureEmailCodeColumns() {
  try {
    const cols = db.prepare('PRAGMA table_info(email_codes)').all().map(c => c.name);
    if (!cols.includes('email_hash')) {
      db.exec('ALTER TABLE email_codes ADD COLUMN email_hash TEXT');
      console.log('[db] 已补齐 email_codes.email_hash 列');
    }
  } catch (e) {
    console.log('[db] email_codes.email_hash 自检失败：' + (e && e.message));
  }
})();

module.exports = db;
