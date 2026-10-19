// account-info.js — 三端统一的「账号信息」卡片渲染与交互
// 依赖全局：api, el, qsa, toast, toastErr, escapeHtml, fmtDateTime, confirmDialog, deviceId, initToggles, window.PermGate, window.NotifyPrefs
// 设计：所有渲染/绑定都按元素是否存在做防御式处理（el(...) 为空则跳过），
//       因此本模块可被任意一端按需引入，缺失的卡片自动跳过，不会报错。
(function () {
  let me = null;
  let locConsent = null;     // null=未选择 / 0=不授权 / 1=授权

  /* ------------------------- 设备识别码：统一由 api.js 的 deviceKey() 提供（服务器签发） ------------------------- */

  /** 权限码 → 可读名：界面只展示可读名，不展示权限码原文 */
  function permName(code) {
    if (!code) return '未知权限';
    return (window.PermGate && PermGate.permLabel) ? PermGate.permLabel(code) : '未知权限';
  }

  /* ------------------------- 基本信息（只读 + 提交工单） ------------------------- */
  const WO_STATUS_TEXT = { pending: '待处理', approved: '已通过', rejected: '已驳回', timeout: '超时驳回' };

  async function loadMyProfileOrders() {
    const box = el('myWoBox');
    if (!box) return;
    try {
      const d = await api.get('api/workorders/mine');
      const rows = d.orders || [];
      box.innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:6px">我提交的工单</div>` + (rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>类型</th><th>内容</th><th>状态</th><th>处理人</th><th>时间</th></tr></thead><tbody>${rows.map(w => `
          <tr>
            <td><span class="tag">${w.kind === 'info' ? '信息 / 反馈' : escapeHtml(permName(w.perm_code))}</span></td>
            <td>${escapeHtml(w.reason || '-')}</td>
            <td>${WO_STATUS_TEXT[w.status] || w.status}</td>
            <td>${escapeHtml(w.handler_name || '-')}</td>
            <td>${fmtDateTime(w.created_at)}</td>
          </tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">暂无提交记录</div>');
    } catch (e) { /* 忽略 */ }
  }

  function renderBasicInfo() {
    const box = el('profileBox');
    if (!box) return;
    const emailText = String((me && me.email) || '').trim() || '未设置';
    const isOps = !!(me && me.role === 'ops');
    box.innerHTML = `
      <div class="grid cols-2">
        <div><small>姓名</small><div>${escapeHtml((me && me.real_name) || '')}</div></div>
        <div><small>学号</small><div class="mono">${escapeHtml((me && me.student_id) || '-')}</div></div>
        <div><small>身份</small><div>${escapeHtml((me && me.role_title) || '')}</div></div>
        <div style="grid-column:1 / -1"><small>邮箱</small><div class="mono">${escapeHtml(emailText)}</div></div>
        <div style="grid-column:1 / -1"><small>设备识别码</small><div class="mono">${escapeHtml(deviceKey())}</div></div>
      </div>
      ${isOps ? '' : `<div class="muted" style="margin-top:12px;font-size:12px;line-height:1.7" data-clean-hide>
        基本信息（姓名 / 学号 / 邮箱 / 身份）无法直接修改；如需变更，请提交工单由管理员 / 运维者协助处理。
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="woProfileBtn" type="button">提交工单（修改信息 / 反馈）</button>
      </div>
      <div id="myWoBox" style="margin-top:14px"></div>`}`;
    const btn = el('woProfileBtn');
    if (btn) btn.addEventListener('click', async () => {
      if (window.PermGate && typeof PermGate.openInfoOrderDialog === 'function') {
        await PermGate.openInfoOrderDialog({
          reason: '【本人账号 ' + ((me && me.real_name) || '') + '（' + ((me && me.student_id) || '无学号') + '）】需要修改的信息：'
        });
        loadMyProfileOrders();
      } else {
        toast('暂无法提交工单');
      }
    });
    loadMyProfileOrders();
  }

  /* ------------------------- 账号安全 ------------------------- */
  function prefillEmail() {
    const input = el('myEmail');
    if (!input || !me) return;
    input.value = (me.email || '') + '';
    const pf = el('myEmailPwdField');
    if (pf) pf.style.display = (me.email) ? '' : 'none';
  }

  function bindSecurity() {
    prefillEmail();

    // 修改密码 / 找回邮箱浮窗
    const openPwd = el('openPwdModalBtn');
    if (openPwd) openPwd.addEventListener('click', () => { const m = el('pwdModal'); if (m) m.classList.remove('hidden'); });
    const openEmail = el('openEmailModalBtn');
    if (openEmail) openEmail.addEventListener('click', () => { prefillEmail(); const m = el('emailModal'); if (m) m.classList.remove('hidden'); });
    const pwdClose = el('pwdModalClose');
    if (pwdClose) pwdClose.addEventListener('click', () => { const m = el('pwdModal'); if (m) m.classList.add('hidden'); });
    const emailClose = el('emailModalClose');
    if (emailClose) emailClose.addEventListener('click', () => { const m = el('emailModal'); if (m) m.classList.add('hidden'); });
    const pwdMask = el('pwdModal');
    if (pwdMask) pwdMask.addEventListener('click', e => { if (e.target === pwdMask) pwdMask.classList.add('hidden'); });
    const emailMask = el('emailModal');
    if (emailMask) emailMask.addEventListener('click', e => { if (e.target === emailMask) emailMask.classList.add('hidden'); });

    // 运维者账号不可注销（服务端限制）：直接隐藏注销入口，避免无效报错
    if (me && me.role === 'ops') {
      const cancelBtn = el('cancelBtn');
      if (cancelBtn) cancelBtn.classList.add('hidden');
    }

    // 修改密码
    const pf = el('pwdForm');
    if (pf) pf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const oldp = el('oldPwd').value;
      const np = el('newPwd').value;
      const np2 = el('newPwd2').value;
      if (!oldp) return toast('请输入原密码');
      if (!np || np.length < 6) return toast('新密码至少 6 位');
      if (!(/[A-Za-z]/.test(np) && /\d/.test(np))) return toast('新密码必须同时包含字母和数字');
      if (np !== np2) return toast('两次输入的新密码不一致');
      try {
        const r = await api.post('api/auth/change-password', { old_password: oldp, new_password: np, confirm: np2 });
        toast(r.message || '密码已修改');
        pf.reset();
        const modal = el('pwdModal'); if (modal) modal.classList.add('hidden');
        if (el('pwdAlert')) el('pwdAlert').innerHTML = '';
      } catch (err) { toastErr(err.message); }
    });

    // 找回邮箱（本人自助修改）
    const saveEmail = el('saveMyEmail');
    if (saveEmail) saveEmail.addEventListener('click', async () => {
      const input = el('myEmail');
      const msg = el('myEmailMsg');
      const v = String(input.value || '').trim();
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { if (msg) msg.textContent = '邮箱格式不正确'; return; }
      const payload = { email: v };
      if (me && me.email && me.email.trim().toLowerCase() !== v.toLowerCase()) {
        const pwd = el('myEmailPwd');
        if (!pwd || !pwd.value) { if (msg) msg.textContent = '修改已登记的邮箱需输入当前登录密码'; return; }
        payload.password = pwd.value;
      }
      try {
        const r = await api.post('api/auth/email', payload);
        if (me) me.email = v;
        if (el('myEmailPwd')) el('myEmailPwd').value = '';
        const pf2 = el('myEmailPwdField');
        if (pf2) pf2.style.display = v ? '' : 'none';
        if (msg) msg.textContent = (r.message || '邮箱已更新');
        toast(r.message || '邮箱已更新');
        setTimeout(() => { const modal = el('emailModal'); if (modal) modal.classList.add('hidden'); }, 600);
      } catch (e) { if (msg) msg.textContent = e.message; toastErr(e.message); }
    });

    // 注销账号：点击后直接弹「输入型确认」浮窗（登录密码 + 逐字输入固定文字，双重验证），不在页面下方展开面板
    const cancel = el('cancelBtn');
    if (cancel) cancel.addEventListener('click', async () => {
      const r = await typedConfirm({
        title: '注销账号',
        message: '注销只会隐藏你的账号，服务器仍保留你的历史签到等信息；注销后你将无法登录，如需恢复请联系上一级管理员。',
        confirmText: '确认注销我的账号',
        okText: '确认注销',
        danger: true
      });
      if (!r) return;
      try {
        const res = await api.post('api/auth/account/cancel', { password: r.password });
        toast(res.message || '已注销');
        // 清掉本机「自动登录 / 记住密码」记录并标记已登出，避免跳到登录页后被自动登录再次顶回（注销账号已 disabled，会自动触发重启用表单，造成反复横跳）
        try {
          localStorage.removeItem('ci_auto_login');
          localStorage.removeItem('ci_saved_creds');
          sessionStorage.setItem('ci_skip_auto_login', '1');
        } catch (e) { /* 忽略 */ }
        goto('login.html');
      } catch (e) { toastErr(e.message); }
    });

    // 忘记密码（仅当存在对应弹窗时绑定入口按钮）
    const fb = el('gotoForgotBtn');
    if (fb) fb.addEventListener('click', () => {
      if (me) {
        if (el('fgName')) el('fgName').value = (me.real_name || '');
        if (el('fgIdentity')) el('fgIdentity').value = (me.role_title || '普通学生');
        if (el('fgSid')) el('fgSid').value = (me.student_id || '');
        if (el('fgEmail')) el('fgEmail').value = (me.email || '');
      }
      const m = el('forgotModal');
      if (m) m.classList.remove('hidden');
    });
    bindForgotModal();
  }

  function bindForgotModal() {
    const m = el('forgotModal');
    if (!m) return;
    const close = el('fgClose');
    if (close) close.addEventListener('click', () => m.classList.add('hidden'));
    const send = el('fgSendCode');
    if (send) send.addEventListener('click', async () => {
      try {
        const r = await api.post('api/auth/email-code', {
          real_name: el('fgName').value.trim(),
          identity: el('fgIdentity').value,
          student_id: el('fgSid').value.trim(),
          email: el('fgEmail').value.trim()
        });
        toast(r.message || '验证码已发送');
      } catch (e) { toastErr(e.message); }
    });
    const reset = el('fgResetBtn');
    if (reset) reset.addEventListener('click', async () => {
      const pwd = el('fgPwd').value;
      const pwd2 = el('fgPwd2').value;
      if (!/^\d{6}$/.test(el('fgCode').value.trim())) return toast('请输入 6 位数字验证码');
      if (!pwd || pwd.length < 6) return toast('新密码至少 6 位');
      if (!(/[A-Za-z]/.test(pwd) && /\d/.test(pwd))) return toast('新密码必须同时包含字母和数字');
      if (pwd !== pwd2) return toast('两次输入的新密码不一致');
      try {
        const r = await api.post('api/auth/email-reset', {
          real_name: el('fgName').value.trim(),
          identity: el('fgIdentity').value,
          student_id: el('fgSid').value.trim(),
          email: el('fgEmail').value.trim(),
          code: el('fgCode').value.trim(),
          password: pwd, confirm: pwd2
        });
        toast(r.message || '密码已重置');
        m.classList.add('hidden');
        goto('login.html');
      } catch (e) { toastErr(e.message); }
    });
  }

  /* ------------------------- 定位上传授权 ------------------------- */
  async function setLocConsent(val) {
    try {
      const r = await api.post('api/auth/me/loc-consent', { consent: val });
      locConsent = r.consent;
      toast(val === 1 ? '已自愿授权上传定位' : '已取消定位授权，之后不再采集位置');
      renderLocConsent();
      // 通知页面（如用户端签到页）同步本地状态与提示
      if (typeof window.onLocConsentChange === 'function') window.onLocConsentChange(locConsent);
    } catch (e) { toastErr(e.message); }
  }

  function renderLocConsent() {
    const box = el('locConsentState');
    if (!box) return;
    const state = locConsent === 1
      ? '<span class="badge signed">已授权：签到时会采集并上传定位</span>'
      : (locConsent === 0
        ? '<span class="badge cancelled">未授权：不采集、不上传定位</span>'
        : '<span class="badge pending">尚未选择（首次涉及定位时会询问）</span>');
    const btn = locConsent === 1
      ? '<button class="btn sm danger" id="locConsentOff" type="button">取消授权</button>'
      : '<button class="btn sm primary" id="locConsentOn" type="button">授权上传定位</button>';
    box.innerHTML = state + btn;
    const on = el('locConsentOn');
    const off = el('locConsentOff');
    if (on) on.addEventListener('click', () => setLocConsent(1));
    if (off) off.addEventListener('click', () => setLocConsent(0));
  }

  /** 供外部（如签到流程）在自行 POST 后同步卡片状态 */
  function setLocConsentValue(v) {
    locConsent = (v === 1 || v === 0) ? v : null;
    renderLocConsent();
  }

  /* ------------------------- 通知偏好（自服务，与系统通知配置解耦） ------------------------- */
  function mountNotifyPrefs() {
    if (!window.NotifyPrefs) return;
    if (el('npBox') && el('npSave')) window.NotifyPrefs.mount('npBox', 'npSave');
    else if (el('myNotifyBox') && el('myNotifySave')) window.NotifyPrefs.mount('myNotifyBox', 'myNotifySave');
  }

  /* ------------------------- 界面偏好：清爽模式 ------------------------- */
  function renderCleanMode() {
    const box = el('cleanModeToggle');
    if (!box) return;
    const cur = !!(window.CleanMode && CleanMode.isOn());
    box.innerHTML = `
      <div class="cm-row">
        <div class="cm-meta">
          <div class="cm-name">清爽模式</div>
          <div class="cm-desc muted">隐藏非必要的说明文字与冗余按钮，界面更聚焦</div>
        </div>
        <label class="cm-switch" title="开启后隐藏非必要说明与冗余按钮">
          <input type="checkbox" id="cmChk" ${cur ? 'checked' : ''} aria-pressed="${cur}" aria-label="清爽模式">
          <span class="cm-track"><span class="cm-knob"></span></span>
        </label>
        <span class="cm-state muted">${cur ? '已开启' : '已关闭'}</span>
      </div>`;
    const chk = el('cmChk');
    if (chk) chk.addEventListener('change', async () => {
      const on = chk.checked;
      try {
        await CleanMode.set(on);
        chk.setAttribute('aria-pressed', String(on));
        const st = box.querySelector('.cm-state');
        if (st) st.textContent = on ? '已开启' : '已关闭';
      } catch (e) { /* toast 已由控制器处理 */ }
    });
  }

  /* ------------------------- 入口 ------------------------- */
  function init(opts) {
    me = opts.me;
    locConsent = (opts.locConsent === 1 || opts.locConsent === 0) ? opts.locConsent : null;
    renderBasicInfo();
    bindSecurity();
    renderLocConsent();
    mountNotifyPrefs();
    renderCleanMode();
  }

  window.AccountInfo = {
    init,
    renderBasicInfo,
    renderLocConsent,
    setLocConsentValue,
    bindSecurity,
    mountNotifyPrefs,
    renderCleanMode
  };
})();
