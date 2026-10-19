'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const { ALL_PERMS, WO_TIMEOUT_HOURS } = require('../config');
const { recordEvent } = require('../logger');
const zh = require('../zh');
const notify = require('../notify');
const S = require('../sessions');

const router = express.Router();
router.use(A.authRequired);

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

/**
 * 可申请的权限：**高危**、且当前**未持有**的权限。
 *
 * 语义（与 README「权限获取双轨制」一致）：
 *   - 层级达到权限码 `min` 的权限由「角色基线」天然持有（hasPerm=true），无需申请；
 *   - 「超出自身基线」的高危权限（即尚未持有的 high_risk）才需要走工单，由上级审批后开通。
 *
 * 注意：**不要**再用 `lvl >= min` 作为申请门槛——那会与 hasPerm 的基线判定完全互斥
 * （lv>=min ⇒ hasPerm 必为 true ⇒ !hasPerm 恒 false），导致可申请集合永远为空、工单通道形同虚设。
 */
function applicablePerms(user) {
  return Object.keys(ALL_PERMS).filter(code => {
    const p = ALL_PERMS[code];
    if (!p || p.type !== 'high_risk') return false;
    return !A.hasPerm(user, code);
  });
}

/**
 * 能否真正处理工单：运维者通配，或持有「工单审批」权限。
 * 只按层级 / 范围筛出的上级若没有该权限，工单会「发出去却没人看得到」，
 * 只能拖到超时自动驳回 —— 因此候选与提交校验都必须带上这一条。
 */
function canApprove(u) {
  if (!u) return false;
  if (u.role === 'ops') return true;
  return A.hasPerm(u, 'AUTH_APPROVE_WO');
}

/** 处理人须「在岗」：未禁用、未注销、且本人已设密码（已激活）。预置但未注册激活的账号不算在岗 */
function isOnDuty(u) {
  return !!u && !u.disabled && u.status !== 'cancelled' && !!u.password_hash;
}

/** 可作为审批人的上级：在岗 + 层级更高 +（运维者通配 / 申请人被纳入其 scope）+ 有工单审批权限 */
function candidateApprovers(user) {
  const lv = A.userLevel(user);
  return db.prepare(`
    SELECT id, real_name, role_title, role_level, role, password_hash, status, disabled
    FROM users
    WHERE disabled = 0 AND status <> 'cancelled' AND password_hash IS NOT NULL AND role_level > ?
    ORDER BY role_level DESC, real_name
  `).all(lv).filter(u => {
    if (!isOnDuty(u)) return false;
    if (!canApprove(u)) return false;
    if (u.role === 'ops') return true;
    return A.inScope(u.id, user.id);
  });
}

/** 工单的处理人 ID 列表（approver_ids 为逗号分隔文本） */
function approverIdsOf(w) {
  return String(w.approver_ids || '').split(',').map(s => String(s).trim()).filter(Boolean);
}

/* ---------------- 可申请权限 + 可选审批人 ---------------- */
router.get('/options', (req, res) => ok(res, {
  perms: applicablePerms(req.user).map(code => ({
    code,
    name: ALL_PERMS[code].name,
    min: ALL_PERMS[code].min,
    // 是否「超出自身基线」（未达 min）：前端可据此提示「需上级审批开通」
    beyond_baseline: A.userLevel(req.user) < ALL_PERMS[code].min
  })),
  // 候选处理人已带「工单审批」权限过滤：列表为空即表示当前没有能真正处理你工单的上级
  approvers: candidateApprovers(req.user).map(u => ({
    id: u.id, real_name: u.real_name, role_title: u.role_title, role_level: u.role_level, can_approve: true
  })),
  timeout_hours: WO_TIMEOUT_HOURS
}));

/* ---------------- 我提交的工单 ---------------- */
router.get('/mine', (req, res) => {
  const rows = db.prepare(`
    SELECT w.*, h.real_name AS handler_name
    FROM work_orders w LEFT JOIN users h ON h.id = w.handler_id
    WHERE w.applicant_id = ? ORDER BY w.created_at DESC LIMIT 200
  `).all(req.user.id);
  return ok(res, { orders: rows });
});

/* ---------------- 待我审批的工单 ----------------
 * 可见对象（由窄到宽）：
 *  1) 工单指派的**处理人**（approver_ids 含自己）—— 无论是否持有审批权限，都能看到并可处理；
 *  2) 运维者（通配）—— 可见全部工单，含已处理，便于监督；
 *  3) 持有「工单审批」权限、且申请人在其管理范围内 —— 可见待审批 + 自己处理过的。
 * 三者都不是则返回 403 + need_order，前端据此引导提交权限工单。
 */
router.get('/inbox', (req, res) => {
  const all = db.prepare(`
    SELECT w.*, u.real_name, u.role_title, u.role_level, u.student_id
    FROM work_orders w JOIN users u ON u.id = w.applicant_id
    ORDER BY w.status, w.created_at DESC LIMIT 300
  `).all();

  const me = String(req.user.id);
  const isAssigned = (w) => approverIdsOf(w).includes(me);

  if (!all.some(isAssigned) && !A.hasPerm(req.user, 'AUTH_APPROVE_WO') && req.user.role !== 'ops') {
    return res.status(403).json({ error: '无「工单审批」权限，且当前没有指派给你的工单', perm: 'AUTH_APPROVE_WO', need_order: true });
  }

  const visible = all.filter(w => {
    if (isAssigned(w)) return true;                    // 指派给我的：始终可见（含已处理）
    if (A.isWildcard(req.user)) return true;           // 运维者：可见全部
    if (!A.hasPerm(req.user, 'AUTH_APPROVE_WO')) return false;
    if (!A.inScope(req.user.id, w.applicant_id)) return false;
    return w.status === 'pending' || String(w.handler_id) === me;
  });
  return ok(res, { orders: visible });
});

/* ---------------- 提交工单（kind: perm 权限申请 / info 信息修改·反馈） ---------------- */
router.post('/', (req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'info' ? 'info' : 'perm';
  const code = String(b.perm_code || '');
  const reason = String(b.reason || '').trim().slice(0, 300);
  const approvers = Array.isArray(b.approver_ids) ? b.approver_ids.filter(Boolean) : [];

  if (!reason) return bad(res, kind === 'perm' ? '请填写申请理由' : '请填写需要修改的信息或反馈内容');
  if (!approvers.length) return bad(res, '请至少选择一位处理人');

  if (kind === 'perm') {
    if (!ALL_PERMS[code]) return bad(res, '请选择要申请的权限');
    if (ALL_PERMS[code].type !== 'high_risk') return bad(res, '该权限属于角色基线，无需申请');
    // 不再以「层级低于 min」拒绝：基线未覆盖的高危权限本就应能申请，由审批人把关是否开通
    if (A.hasPerm(req.user, code)) return bad(res, '你已持有该权限');
  }

  const okApprovers = approvers.filter(id => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return u && isOnDuty(u) && A.canManage(u, req.user) && canApprove(u);
  });
  if (!okApprovers.length) {
    return bad(res, '所选处理人不是你的上级、你不在其管理范围内、尚未激活（未设密码），或不具备「工单审批」权限（将无法查看与处理该工单）', 403);
  }

  // 同类工单同一申请人只允许一条待处理（避免重复提交）
  const dup = kind === 'perm'
    ? db.prepare("SELECT id FROM work_orders WHERE applicant_id = ? AND perm_code = ? AND status = 'pending'").get(req.user.id, code)
    : db.prepare("SELECT id FROM work_orders WHERE applicant_id = ? AND kind = 'info' AND status = 'pending'").get(req.user.id);
  if (dup) return bad(res, kind === 'perm' ? '该权限已有待审批的工单，请等待审批结果' : '你已有一条待处理的「信息修改 / 反馈」工单，请等待处理');

  const info = db.prepare(`
    INSERT INTO work_orders (applicant_id, perm_code, kind, reason, approver_ids, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(req.user.id, kind === 'perm' ? code : '', kind, reason, okApprovers.join(','), Date.now());

  recordEvent('work_order_submit', req.user.id, Number(info.lastInsertRowid), kind === 'perm' ? zh.permText(code) : '信息修改 / 反馈');

  // 送达每一位处理人：站内必达，离线 / 不活动时同时发邮件（perm 与 info 两类一致）
  const approverUsers = okApprovers
    .map(id => db.prepare('SELECT * FROM users WHERE id = ?').get(id))
    .filter(Boolean);
  approverUsers.forEach(ap => {
    notify.notifyWoSubmitted(ap, req.user, code, reason, kind).catch(() => {});
  });

  // 申请人回执：工单提交成功（站内必达；本人离线时同时发邮件回执）
  notify.notifyReceipt(req.user, {
    title: '工单提交成功',
    body: kind === 'perm'
      ? `权限「${ALL_PERMS[code].name}（${code}）」申请已提交，等待审批`
      : '你的「信息修改 / 反馈」工单已提交，等待处理',
    intro: kind === 'perm'
      ? '你的权限申请已提交，已通知你勾选的审批人；审批通过后权限自动开通，超时未审批将自动驳回。'
      : '你的「信息修改 / 反馈」工单已提交，已通知你勾选的处理人；超时未处理将自动关闭。',
    rows: [
      { label: '工单类型', value: kind === 'perm' ? '权限申请' : '信息修改 / 反馈' },
      kind === 'perm'
        ? { label: '申请权限', value: `${ALL_PERMS[code].name}（${code}）` }
        : { label: '内容', value: reason },
      { label: '处理人', value: approverUsers.map(u => `${u.real_name}（${u.role_title || '-'}）`).join('、') || '（未指定）' },
      { label: '提交时间', value: notify.fmtTime(Date.now()) }
    ],
    footer: `工单超过 ${WO_TIMEOUT_HOURS} 小时未处理将自动关闭并通知你。`,
    actor: req.user, ref_type: 'workorder', ref_id: Number(info.lastInsertRowid),
    notifyKind: 'NT_WO_REPLY'
  }).catch(() => {});

  return ok(res, { message: kind === 'perm' ? '工单已提交，等待审批' : '工单已提交，等待处理', id: info.lastInsertRowid });
});

/* ---------------- 审批（同意 / 驳回） ---------------- */
router.post('/:id/review', (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const approve = b.approve === true;
  const reply = String(b.reply || '').trim().slice(0, 300);

  const w = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id);
  if (!w) return bad(res, '工单不存在', 404);
  if (w.status !== 'pending') return bad(res, '该工单已处理');

  const approvers = approverIdsOf(w).map(Number).filter(Boolean);
  const isApprover = approvers.includes(Number(req.user.id));
  if (!isApprover && !A.hasPerm(req.user, 'AUTH_APPROVE_WO') && req.user.role !== 'ops') {
    return res.status(403).json({ error: '你不是该工单的审批人', perm: 'AUTH_APPROVE_WO', need_order: true });
  }
  if (!isApprover && !A.inScope(req.user.id, w.applicant_id) && !A.isWildcard(req.user)) {
    return bad(res, '该工单不在你的审批范围内', 403);
  }

  const applicant = db.prepare('SELECT * FROM users WHERE id = ?').get(w.applicant_id);
  const days = Number(b.days) || 0;
  const until = approve && days > 0 ? Date.now() + days * 24 * 3600 * 1000 : null;

  // 管理端权限只面向管理岗账号：普通学生端（用户端）无对应控件，即便审批通过也禁止把权限下放给普通学生。
  // REACTIVATE（重启用工单）是账号恢复、非权限授予，不受影响。
  if (approve && w.kind !== 'info' && w.perm_code !== 'REACTIVATE' && applicant && A.isStudentUser(applicant)) {
    return bad(res, '管理端权限不可下放到普通学生：普通学生端（用户端）无对应控件，审批通过也无法使用', 403);
  }

  // 高危权限审批授权须满足授予层级下限（与手动 grant 对齐），防止低层级审批人越级下放
  if (approve && w.kind !== 'info' && w.perm_code !== 'REACTIVATE') {
    const pd = ALL_PERMS[w.perm_code];
    if (pd && typeof pd.grant_min_level === 'number' && A.userLevel(req.user) < pd.grant_min_level) {
      return bad(res, `该权限需 ${pd.grant_min_level} 级及以上审批人方可授予`, 403);
    }
  }

  db.transaction(() => {
    db.prepare("UPDATE work_orders SET status = ?, handler_id = ?, reply = ?, handled_at = ?, granted_until = ? WHERE id = ?")
      .run(approve ? 'approved' : 'rejected', req.user.id, reply || null, Date.now(), until, id);
    if (approve && w.kind !== 'info') {
      if (w.perm_code === 'REACTIVATE') {
        // 重启用工单审批通过：清空密码 → 回到未激活，本人需重新设置密码
        db.prepare("UPDATE users SET disabled = 0, status = 'active', password_hash = NULL, must_change_pwd = 1, must_setup = 0 WHERE id = ?")
          .run(w.applicant_id);
        S.endUserSessions(w.applicant_id, '重启用工单审批通过');
      } else {
        db.prepare(`
          INSERT INTO permission_grants (user_id, perm_code, granted_by, source, expires_at, revoked, created_at)
          VALUES (?, ?, ?, 'workorder', ?, 0, ?)
        `).run(w.applicant_id, w.perm_code, req.user.id, until, Date.now());
      }
    }
  })();

  recordEvent(approve ? 'work_order_approve' : 'work_order_reject', req.user.id, w.applicant_id, w.kind === 'info' ? '信息修改 / 反馈' : zh.permText(w.perm_code));
  // 工单审批可能改变账号「可用性」（重启用）或使其额外持有权限（权限工单）→ 重算自动代管，
  // 避免与代管授权重复或遗漏（失败不影响审批结果）。
  try { require('../autocover').safeSync('account_change'); } catch (e) { /* 忽略 */ }

  if (applicant) {
    if (w.kind === 'info') {
      // 「信息修改 / 反馈」结果同样走统一回执：站内必达，离线时同时发邮件
      notify.notifyReceipt(applicant, {
        title: approve ? '信息修改 / 反馈已通过' : '信息修改 / 反馈已驳回',
        body: reply || (approve ? '你的申请已通过，处理人会尽快处理。' : '你的申请已被驳回。'),
        intro: approve
          ? '你提交的「信息修改 / 反馈」工单已通过，处理人会尽快为你处理。'
          : '你提交的「信息修改 / 反馈」工单未通过。',
        rows: [
          { label: '工单类型', value: '信息修改 / 反馈' },
          { label: '处理人', value: `${req.user.real_name}（${req.user.role_title || '-'}）` },
          reply ? { label: '处理留言', value: reply } : null,
          { label: '处理时间', value: notify.fmtTime(Date.now()) }
        ].filter(Boolean),
        actor: req.user, ref_type: 'workorder', ref_id: id,
        notifyKind: 'NT_WO_REPLY'
      }).catch(() => {});
    } else {
      const vars = { perm_code: w.perm_code, handler: req.user, reply, until, created_at: w.created_at, hours: WO_TIMEOUT_HOURS };
      if (approve) notify.notifyWoApproved(applicant, vars).catch(() => {});
      else notify.notifyWoRejected(applicant, vars).catch(() => {});
    }
  }
  return ok(res, { message: approve ? '已批准' : '已驳回' });
});

/* ---------------- 超时扫描（scheduler 调用） ---------------- */
function timeoutScan() {
  const deadline = Date.now() - WO_TIMEOUT_HOURS * 3600 * 1000;
  const rows = db.prepare("SELECT * FROM work_orders WHERE status = 'pending' AND created_at < ?").all(deadline);
  const out = [];
  rows.forEach(w => {
    db.prepare("UPDATE work_orders SET status = 'timeout', handled_at = ? WHERE id = ?").run(Date.now(), w.id);
    const applicant = db.prepare('SELECT * FROM users WHERE id = ?').get(w.applicant_id);
    if (applicant) {
      notify.notifyWoTimeout(applicant, {
        perm_code: w.perm_code, kind: w.kind, created_at: w.created_at, hours: WO_TIMEOUT_HOURS
      }).catch(() => {});
    }
    // 同步告知各位处理人：工单已超时自动关闭，避免待办列表一直挂着
    approverIdsOf(w).map(Number).filter(Boolean).forEach(id => {
      const ap = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!ap) return;
      // notifyInbox 是同步函数（返回写入结果对象，非 Promise），不能 .catch()；
      // 其内部已 try/catch，且异常隔离由 notify.js 出口统一保证。
      notify.notifyInbox(ap, {
        level: 'notice', kind: 'NT_WO_REPLY',
        title: '工单已超时自动关闭',
        body: `${applicant ? applicant.real_name : '下级账号'} 的工单超过 ${WO_TIMEOUT_HOURS} 小时未处理，已自动关闭`,
        ref_type: 'workorder', ref_id: w.id
      });
    });
    recordEvent('work_order_timeout', null, w.applicant_id, zh.permText(w.perm_code));
    out.push(w.id);
  });
  return out;
}

module.exports = router;
module.exports.timeoutScan = timeoutScan;
