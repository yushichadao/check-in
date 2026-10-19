'use strict';
/**
 * 生成「所有类型邮件」的测试文件（不真正发信）。
 *
 *   node server/mailpreview.js [输出目录]
 *   npm run mail:preview
 *
 * 默认输出到 <DATA_DIR>/mail-preview/，同时生成 index.html 索引页，
 * 直接用浏览器打开即可查看每封邮件的实际排版。
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const mailer = require('./mailer');
const notify = require('./notify');
const { MAIL } = require('./mailtypes');

// 用于预览的示例活动（与真实邮件字段一致）
// location = 活动地点（管理端填写的文本）；fence_name = 活动范围名称，二者不同
const SAMPLE = {
  id: 0,
  title: '周一早自习',
  start_time: new Date('2026-09-21T08:00:00').getTime(),
  end_time: new Date('2026-09-21T09:40:00').getTime(),
  location: '教学楼 A-101 教室',
  fence_id: 1,
  fence_name: '教学楼A（活动范围）',
  remark: '请提前 10 分钟到教室'
};

// 示例账号
const STUDENT = { real_name: '李四', role_title: '普通学生', student_id: '20260101' };
const TEACHER = { real_name: '王老师', role_title: '辅导员' };

/**
 * 邮件样例清单：按「邮件类型总表」（server/mailtypes.js）的分组与顺序排列，
 * 每个 case 都标注所属类型码（code），同一类型有多种结果时各出一封（如通过 / 未通过）。
 * 新增邮件类型时：先在 server/mailtypes.js 登记，再在这里补一个样例。
 */
const CASES = [
  /* —— 密码与安全 —— */
  { code: MAIL.PW_RESET, key: '01-密码重置验证码', build: () => mailer.renderCodeEmail('428317', 10) },
  { code: MAIL.PW_CHANGED, key: '02-密码变更安全提醒', build: () => mailer.renderNoticeEmail(notify.buildPwChanged({ method: '修改登录密码', ip: '203.0.113.8', device: 'Windows · Chrome' })) },
  { code: MAIL.LOGIN_REMOTE, key: '03-异地登录提醒', build: () => mailer.renderNoticeEmail(notify.buildLoginRemote({ device: 'iPhone · Safari', ip: '198.51.100.23' })) },

  /* —— 活动与签到提醒 —— */
  { code: MAIL.ACT_CREATE, key: '04-新活动发布', build: () => mailer.renderNoticeEmail(notify.buildActCreate(SAMPLE)) },
  { code: MAIL.REMINDER, key: '05-签到倒计时60分钟', build: () => mailer.renderNoticeEmail(notify.buildReminder(SAMPLE, 60)) },
  { code: MAIL.REMINDER, key: '06-签到倒计时5分钟', build: () => mailer.renderNoticeEmail(notify.buildPreStart(SAMPLE)) },
  { code: MAIL.CHECKIN_START, key: '07-签到开放提醒', build: () => mailer.renderNoticeEmail(notify.buildStart(SAMPLE)) },
  { code: MAIL.ACT_START, key: '08-活动开始提醒', build: () => mailer.renderNoticeEmail(notify.buildActStart(SAMPLE)) },
  { code: MAIL.NOT_CHECKED, key: '09-缺勤提醒', build: () => mailer.renderNoticeEmail(notify.buildAbsent(SAMPLE)) },

  /* —— 请假 / 补签审核 —— */
  { code: MAIL.LEAVE_RESULT, key: '10-请假审核通过', build: () => mailer.renderNoticeEmail(notify.buildLeaveResult(SAMPLE, true, '已知悉，按时补交材料')) },
  { code: MAIL.LEAVE_RESULT, key: '11-请假审核未通过', build: () => mailer.renderNoticeEmail(notify.buildLeaveResult(SAMPLE, false, '请联系辅导员说明情况')) },
  { code: MAIL.MAKEUP_RESULT, key: '12-补签审核通过', build: () => mailer.renderNoticeEmail(notify.buildMakeupResult(SAMPLE, true, '已核实属实')) },
  { code: MAIL.MAKEUP_RESULT, key: '13-补签审核未通过', build: () => mailer.renderNoticeEmail(notify.buildMakeupResult(SAMPLE, false, '理由不充分')) },

  /* —— 申诉与沟通 —— */
  { code: MAIL.APPEAL_SUBMITTED, key: '14-申诉待审核', build: () => mailer.renderNoticeEmail(notify.buildAppealSubmitted({ title: '新的请假申诉待审核', applicant: STUDENT, activity: SAMPLE, label: '请假' })) },
  { code: MAIL.APPEAL_REPLY, key: '15-申诉沟通回复', build: () => mailer.renderNoticeEmail(notify.buildAppealReply({ title: '你的请假申诉有新回复', label: '请假', replier: TEACHER, body: '已收到你的材料，请于本周内补交证明。' })) },

  /* —— 工单与权限 —— */
  { code: MAIL.WO_SUBMITTED, key: '16-新工单待审批-权限申请', build: () => mailer.renderNoticeEmail(notify.buildWoSubmitted({ applicant: STUDENT, perm_code: 'VIEW_STUDENT_LOCATION', reason: '需要查看本班同学签到定位', kind: 'perm' })) },
  { code: MAIL.WO_SUBMITTED, key: '16b-新工单待处理-信息修改反馈', build: () => mailer.renderNoticeEmail(notify.buildWoSubmitted({ applicant: STUDENT, kind: 'info', reason: '请把我的学号由 20260101 更正为 20260102' })) },
  { code: MAIL.WO_APPROVED, key: '17-工单已批准', build: () => mailer.renderNoticeEmail(notify.buildWoApproved({ perm_code: 'VIEW_STUDENT_LOCATION', handler: TEACHER })) },
  { code: MAIL.WO_REJECTED, key: '18-工单已驳回', build: () => mailer.renderNoticeEmail(notify.buildWoRejected({ perm_code: 'VIEW_STUDENT_LOCATION', handler: TEACHER, reply: '当前阶段无需开通' })) },
  { code: MAIL.WO_TIMEOUT, key: '19-工单超时驳回', build: () => mailer.renderNoticeEmail(notify.buildWoTimeout({ perm_code: 'VIEW_STUDENT_LOCATION', created_at: Date.now() - 49 * 3600 * 1000, hours: 48 })) },
  { code: MAIL.WO_REMINDER, key: '20-工单待办催办', build: () => mailer.renderNoticeEmail(notify.buildWoReminder({ applicant: STUDENT, perm_code: 'VIEW_STUDENT_LOCATION', kind: 'perm', ageMin: 95, reason: '需要查看本班同学签到定位' })) },
  { code: MAIL.GRANT_NOTICE, key: '21-权限授予通知', build: () => mailer.renderNoticeEmail(notify.buildGrantNotice({ perm_code: 'VIEW_STUDENT_LOCATION', granter: TEACHER })) },

  /* —— 系统与维护 —— */
  { code: MAIL.MAINTENANCE_PRE, key: '22-维护预告', build: () => mailer.renderNoticeEmail(notify.buildMaintenance({ phase: 'pre', start_at: '2026-09-22 02:00', restore_at: '2026-09-22 04:00' })) },
  { code: MAIL.MAINTENANCE_POST, key: '23-维护结束', build: () => mailer.renderNoticeEmail(notify.buildMaintenance({ phase: 'post', restore_at: '2026-09-22 04:05' })) },
  { code: MAIL.SESSION_KILLED, key: '24-会话被强制结束', build: () => mailer.renderNoticeEmail(notify.buildSessionKilled({ reason: '系统维护', device: 'Windows · Chrome' })) },
  { code: MAIL.PRIVACY_UPDATE, key: '25-隐私告知变更', build: () => mailer.renderNoticeEmail(notify.buildPrivacyUpdate({ summary: '补充了定位数据留存期限说明' })) },
  { code: MAIL.ANNOUNCEMENT, key: '26-系统公告', build: () => mailer.renderNoticeEmail(notify.buildAnnouncement({ summary: '国庆假期签到安排调整，详见公告栏' })) },
  { code: MAIL.ACCOUNT_NOTICE, key: '27-账号变更通知', build: () => mailer.renderNoticeEmail(notify.buildAccountNotice({ items: [
    { label: '变更内容', value: '身份调整为「小班主任」' },
    { label: '操作者', value: '王老师（辅导员）' }
  ] })) },

  /* —— 运维与反馈 —— */
  { code: MAIL.OPS_ALERT, key: '28-运维告警', build: () => mailer.renderNoticeEmail(notify.buildDevAlert({ detail: '检测到异常登录尝试（5 分钟内 10 次失败）' })) },
  { code: MAIL.FEEDBACK, key: '29-网站问题反馈', build: () => mailer.renderNoticeEmail(notify.buildFeedback({
    reporter_name: '张三', reporter_role: '普通学生', type: 'bug',
    subject: '签到页面打不开', contact: '', content: '首页签到按钮点击后无响应，白屏。'
  })) },

  /* —— 操作回执 —— */
  { code: MAIL.RECEIPT, key: '30-操作回执-管理员补签', build: () => mailer.renderNoticeEmail(notify.buildReceipt({
    title: '管理员为你补签',
    intro: `管理员为你补记了一场签到，${notify.sessionTerm(SAMPLE)}记为已签到。`,
    rows: [{ label: '活动', value: SAMPLE.title }, { label: '操作人', value: '王老师（辅导员）' }]
  })) }
];

/** 生成全部类型的邮件测试文件，返回 { dir, files } */
function generateAll(dir) {
  const out = dir || path.join(cfg.DATA_DIR, 'mail-preview');
  fs.mkdirSync(out, { recursive: true });

  const files = [];
  CASES.forEach(c => {
    const mail = c.build();
    const base = path.join(out, c.key);
    fs.writeFileSync(base + '.html', mail.html, 'utf8');
    fs.writeFileSync(base + '.txt', `Subject: ${mail.subject}\n\n${mail.text}`, 'utf8');
    files.push({ name: c.key, code: c.code, html: base + '.html', subject: mail.subject });
  });

  // 索引页按「邮件类型总表」的分组展示：分组 → 类型（中文名 + 类型码）→ 该类型的样例
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const sections = mailer.mailTypesByGroup().map(g => {
    const items = [];
    g.types.forEach(t => {
      const cases = files.filter(f => f.code === t.code);
      if (!cases.length) return;
      items.push(`<li style="margin:6px 0">
        <b>${esc(t.name)}</b> <code style="color:#8a94a6">${esc(t.code)}</code>
        <span style="color:#8a94a6">· ${esc(t.audience)}</span>
        <ul>${cases.map(f => `<li><a href="${encodeURIComponent(f.name)}.html" target="_blank">${esc(f.name)}</a> — ${esc(f.subject)}</li>`).join('')}</ul>
      </li>`);
    });
    if (!items.length) return '';
    return `<h2 style="font-size:16px;color:#1e3a5f;margin:24px 0 8px">${esc(g.name)}（${items.length} 类）</h2>
<ul>${items.join('')}</ul>`;
  }).join('');

  const index = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>邮件测试文件</title>
<style>body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#eef1f7;margin:0;padding:32px}
h1{font-size:20px;color:#1e3a5f}li{margin:8px 0}a{color:#1666b8}</style></head><body>
<h1>邮件测试文件（${files.length} 封 / ${new Set(files.map(f => f.code)).size} 类）</h1>
<p style="color:#5f6b7d">SMTP 未配置时，系统发出的每一封邮件都会另存到 <code>data/mail-outbox/</code>；这里是为每种邮件生成的样例，按 <code>server/mailtypes.js</code> 的类型分组排列。</p>
${sections}
</body></html>`;
  fs.writeFileSync(path.join(out, 'index.html'), index, 'utf8');

  return { dir: out, files: files.map(f => f.html) };
}

/** 默认测试收件邮箱（可用环境变量 MAIL_TEST_TO 覆盖） */
const DEFAULT_TEST_TO = process.env.MAIL_TEST_TO || 'admin@example.com';

/**
 * 把所有类型（各种情况）的邮件真实发送到指定邮箱。
 * @param {string} to 收件邮箱
 * @param {{delayMs?:number, onResult?:Function}} opts
 * @returns {Promise<Array<{name:string,subject:string,ok:boolean,messageId?:string,outbox?:string,error?:string}>>}
 */
async function sendAll(to, opts) {
  const target = String(to || DEFAULT_TEST_TO).trim();
  const delayMs = (opts && opts.delayMs !== undefined) ? opts.delayMs : 1200;
  const results = [];
  for (const c of CASES) {
    const mail = c.build();
    let row = { name: c.key, code: c.code, subject: mail.subject, ok: false };
    try {
      const r = await mailer.sendRendered(target, mail, null, c.code);
      row.ok = true;
      row.messageId = r && r.messageId;
      row.outbox = r && r.outbox;
    } catch (e) {
      row.error = e.message;
    }
    results.push(row);
    if (opts && typeof opts.onResult === 'function') opts.onResult(row);
    if (delayMs) await new Promise(res => setTimeout(res, delayMs));
  }
  return results;
}

module.exports = { generateAll, sendAll, CASES, DEFAULT_TEST_TO };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    // 用法：
    //   node server/mailpreview.js                     生成测试文件
    //   node server/mailpreview.js --send <邮箱>        生成并把所有类型邮件发到该邮箱
    const si = args.indexOf('--send');
    const eq = args.find(a => a.startsWith('--send='));
    const wantSend = si >= 0 || !!eq;
    let sendTo = '';
    if (eq) sendTo = eq.split('=')[1] || '';
    else if (si >= 0) {
      const next = args[si + 1];
      if (next && !next.startsWith('--')) sendTo = next;
    }
    const dirArg = args.find(a => !a.startsWith('--') && a !== sendTo);

    const r = generateAll(dirArg);
    console.log('邮件测试文件已生成：' + r.dir);
    r.files.forEach(f => console.log('  ' + f));
    console.log('索引页：' + path.join(r.dir, 'index.html'));

    if (wantSend) {
      const target = sendTo || DEFAULT_TEST_TO;
      console.log(`\n开始把所有类型邮件发送到：${target}\n`);
      const results = await sendAll(target, {
        onResult: (row) => {
          if (row.ok && row.outbox) console.log(`  [落盘] ${row.name}  →  ${row.outbox}`);
          else if (row.ok) console.log(`  [已发送] ${row.name}  messageId=${row.messageId || '-'}`);
          else console.log(`  [失败] ${row.name}  ${row.error}`);
        }
      });
      const okCount = results.filter(x => x.ok).length;
      console.log(`\n完成：成功 ${okCount} / ${results.length}`);
      if (okCount < results.length) process.exitCode = 1;
    }
  })();
}
