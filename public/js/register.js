(function () {
  // 维护锁页：维护期间注册功能全局暂停，本页强制显示遮罩、禁止进入（见 api.js MaintenanceGuard）
  window.__maintLockPage = true;
  // 立即拉取维护态（不等 800ms 定时检查），尽快盖住页面，避免维护中仍能短暂看到表单
  if (window.MaintenanceGuard) window.MaintenanceGuard.check();
  const msgBox = el('msg');

  // 支持从登录页跳转带上预填信息
  const params = new URLSearchParams(location.search);
  if (params.get('n')) el('real_name').value = params.get('n');
  if (params.get('s')) el('student_id').value = params.get('s');
  if (params.get('i')) el('identity').value = params.get('i');

  /* ---------------- 表单草稿暂存（阅读隐私政策返回 / 刷新不丢数据） ---------------- */
  const DRAFT_KEY = 'reg_draft';
  function saveDraft() {
    try {
      const d = {
        real_name: el('real_name').value, student_id: el('student_id').value,
        identity: el('identity').value, email: el('email').value,
        password: el('password').value, confirm: el('confirm').value
      };
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch (e) { /* 忽略 */ }
  }
  function restoreDraft() {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.real_name != null) el('real_name').value = d.real_name;
      if (d.student_id != null) el('student_id').value = d.student_id;
      if (d.identity != null) el('identity').value = d.identity;
      if (d.email != null) el('email').value = d.email;
      if (d.password != null) el('password').value = d.password;
      if (d.confirm != null) el('confirm').value = d.confirm;
      syncSidField();
    } catch (e) { /* 忽略 */ }
  }
  ['real_name', 'student_id', 'identity', 'email', 'password', 'confirm'].forEach(id =>
    el(id).addEventListener('input', saveDraft));
  el('identity').addEventListener('change', saveDraft);
  restoreDraft();

  // 密码强度校验：至少 6 位、同时含字母与数字、禁止纯数字（与后端 validatePassword 规则一致）
  function pwdValidate(pw) {
    if (!pw) return '请设置密码';
    if (pw.length < 6) return '密码至少 6 位';
    if (!(/[A-Za-z]/.test(pw) && /\d/.test(pw))) return '密码必须同时包含字母和数字';
    if (/^\d+$/.test(pw)) return '密码不能纯数字';
    return null;
  }
  function updatePwdStrength() {
    const pw = el('password').value;
    const tip = el('pwdTip');
    const bar = el('pwdStrength');
    if (!pw) { if (tip) tip.textContent = ''; if (bar) bar.className = 'pwd-strength'; return; }
    const err = pwdValidate(pw);
    const ok = !err;
    const strong = pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw);
    if (bar) bar.className = 'pwd-strength s' + (ok ? (strong ? 4 : 3) : (pw.length >= 3 ? 1 : 0));
    if (tip) { tip.textContent = err || (strong ? '密码强度：强' : '密码强度：合格'); tip.style.color = ok ? 'var(--ok)' : 'var(--danger)'; }
  }
  el('password').addEventListener('input', () => { updatePwdStrength(); saveDraft(); });

  // 管理员 / 运维者忽略学号：学号输入框置灰不可点击（文字保留），仅普通学生可填
  function syncSidField() {
    el('student_id').disabled = el('identity').value !== '普通学生';
  }
  el('identity').addEventListener('change', syncSidField);
  syncSidField();

  function showMsg(text, kind) {
    // 错误/警告改用 toast，确保在任何滚动位置都可见；成功仍留在页内提示
    if (kind === 'ok') {
      msgBox.innerHTML = `<div class="alert ok">${escapeHtml(text)}</div>`;
      return;
    }
    msgBox.innerHTML = '';
    toastErr(text);
  }

  /* ---------------- 隐私政策阅读门槛 ----------------
   * 必须先另开页面完整阅读《隐私政策》（该页加载后会写入本机已读标记），
   * 之后才解锁勾选框；勾选同意后方可提交注册。 */
  const READ_KEY = 'checkin_privacy_read';
  const agree = el('agreePrivacy');
  const submitBtn = el('submitBtn');
  const privacyHint = el('privacyHint');
  let unlocked = false;
  let expectedHash = null;   // null=尚未取到政策内容；''=取失败（降级）

  function syncSubmit() {
    submitBtn.disabled = !(unlocked && agree.checked);
  }

  function tryUnlock() {
    if (unlocked || expectedHash === null) return;
    let read = null;
    try { read = localStorage.getItem(READ_KEY); } catch (e) { /* 忽略 */ }
    if (!read) return;
    // 取到政策内容时：已读指纹必须与当前版本一致（内容变更需重新阅读）；取失败时降级为「有标记即可」
    if (expectedHash && read !== expectedHash) return;
    unlocked = true;
    agree.disabled = false;
    if (privacyHint) privacyHint.textContent = '已阅读《隐私政策》。请勾选上方同意后即可注册';
    syncSubmit();
  }

  /* ---------- 手机端：隐私政策弹窗（滚动到底才算读完） ---------- */
  const pmModal = el('privacyModal');
  const pmBox = el('pmBox');
  const pmDone = el('pmDone');
  let privacyText = '';

  // 拉取政策内容（用于弹窗展示 + 指纹校验「是否已按当前版本读完」）
  api.get('api/auth/privacy')
    .then(d => {
      privacyText = d.text || '';
      expectedHash = privacyHash(privacyText);
      if (pmBox) pmBox.textContent = privacyText;
      tryUnlock();
    })
    .catch(() => { expectedHash = ''; tryUnlock(); });

  function markRead() {
    try { localStorage.setItem(READ_KEY, expectedHash || '1'); } catch (e) { /* 忽略 */ }
  }
  function pmReachedBottom() {
    if (!pmBox) return false;
    return pmBox.scrollHeight - pmBox.scrollTop - pmBox.clientHeight <= 8;
  }
  function openPrivacyModal() {
    if (!pmModal) return;
    pmModal.classList.remove('hidden');
    if (pmBox) {
      if (!pmBox.textContent.trim()) pmBox.textContent = privacyText || '（暂无隐私政策内容）';
      pmBox.scrollTop = 0;
    }
    const noScroll = pmBox && pmBox.scrollHeight <= pmBox.clientHeight + 8;
    const done = !!noScroll || pmReachedBottom();
    if (pmDone) pmDone.disabled = !done;
    if (done) markRead();
    if (pmBox) {
      pmBox.onscroll = () => {
        if (pmDone && pmDone.disabled && pmReachedBottom()) {
          pmDone.disabled = false;
          const h = el('pmHint'); if (h) h.textContent = '已阅读至底部，可点击「我已阅读完」';
          markRead();
        }
      };
    }
  }
  function closePrivacyModal() { if (pmModal) pmModal.classList.add('hidden'); }

  if (pmDone) pmDone.addEventListener('click', () => { markRead(); closePrivacyModal(); tryUnlock(); });
  if (pmModal) pmModal.addEventListener('click', e => { if (e.target === pmModal) closePrivacyModal(); });

  if (el('privacyLink')) {
    el('privacyLink').addEventListener('click', (e) => {
      e.preventDefault();
      saveDraft();               // 跳去读隐私政策前，先把已填内容存好
      openPrivacyModal();        // 本页浮窗阅读，读完即可勾选，不再另开独立窗口
    });
  }
  window.addEventListener('focus', tryUnlock);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tryUnlock(); });
  const poll = setInterval(() => { tryUnlock(); if (unlocked) clearInterval(poll); }, 800);
  agree.addEventListener('change', syncSubmit);

  /* ---------------- 邮箱验证码（注册必须验证，未验证禁止登录） ---------------- */
  const sendCodeBtn = el('sendCodeBtn');
  const codeInput = el('code');
  let codeTimer = null;

  function setCodeCountdown(sec) {
    if (!sendCodeBtn) return;
    if (sec > 0) {
      sendCodeBtn.disabled = true;
      sendCodeBtn.textContent = `${sec} 秒后重发`;
      codeTimer = setTimeout(() => setCodeCountdown(sec - 1), 1000);
    } else {
      if (codeTimer) clearTimeout(codeTimer);
      codeTimer = null;
      sendCodeBtn.disabled = false;
      sendCodeBtn.textContent = '获取验证码';
    }
  }

  if (sendCodeBtn) {
    sendCodeBtn.addEventListener('click', async () => {
      // 维护中：置灰按钮仍可点击，点击即提示（原生 disabled 不会触发 click）
      if (window.maintOn()) { toastErr('系统维护中，注册 / 设置密码功能暂不可用，请稍后再试'); return; }
      const p = {
        real_name: el('real_name').value.trim(),
        student_id: el('student_id').value.trim(),
        identity: el('identity').value,
        email: el('email').value.trim()
      };
      if (!p.real_name) return showMsg('请先填写姓名');
      if (!p.email) return showMsg('请先填写邮箱');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return showMsg('邮箱格式不正确');

      const oldText = sendCodeBtn.textContent;
      sendCodeBtn.disabled = true;
      sendCodeBtn.textContent = '发送中…';
      try {
        const r = await api.post('api/auth/register-code', p);
        toast(r.message || '验证码已发送，请查收邮件');
        setCodeCountdown(60);
      } catch (err) {
        sendCodeBtn.disabled = false;
        sendCodeBtn.textContent = oldText;
        showMsg(err.message);
      }
    });
  }

  el('regForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    // 维护中：拦截提交，避免落到被锁的注册页 / 触发被拦截的接口
    if (window.maintOn()) { toastErr('系统维护中，注册 / 设置密码功能暂不可用，请稍后再试'); return; }
    msgBox.innerHTML = '';

    if (!agree.checked) return showMsg('请先阅读并勾选同意《隐私政策》后再注册');

    const payload = {
      real_name: el('real_name').value.trim(),
      student_id: el('student_id').value.trim(),
      identity: el('identity').value,
      email: el('email').value.trim(),
      code: codeInput ? codeInput.value.trim() : '',
      password: el('password').value,
      confirm: el('confirm').value
    };

    if (!payload.real_name) return showMsg('请输入姓名');
    if (payload.identity === '普通学生') {
      if (!payload.student_id) return showMsg('普通学生请填写学号');
    }
    if (!payload.email) return showMsg('请填写邮箱（必填）');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return showMsg('邮箱格式不正确');
    if (!payload.code) return showMsg('请输入邮箱验证码（先点击邮箱栏的「获取验证码」并查收邮件）');
    const pwdErr = pwdValidate(payload.password);
    if (pwdErr) return showMsg(pwdErr);
    if (payload.password !== payload.confirm) return showMsg('两次输入的密码不一致');

    submitBtn.disabled = true;
    const savePwd = el('savePwd') && el('savePwd').checked;
    const autoLogin = el('autoLogin') && el('autoLogin').checked;
    try {
      await api.post('api/auth/set-password', payload);
      try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) {}
      // 保存密码 / 自动登录：把凭据存到本机浏览器
      if (savePwd || autoLogin) {
        const creds = { real_name: payload.real_name, student_id: payload.student_id, identity: payload.identity, password: payload.password };
        try { localStorage.setItem('ci_saved_creds', JSON.stringify(creds)); } catch (e) {}
        if (autoLogin) { try { localStorage.setItem('ci_auto_login', '1'); } catch (e) {} }
      }
      // 注册成功后直接登录进入，无需再跳到登录页
      try {
        const r = await api.post('api/auth/login', {
          real_name: payload.real_name, student_id: payload.student_id,
          identity: payload.identity, password: payload.password
        });
        if (r.user && r.user.must_setup) {
          // 注册后必须完成首次设置（通知偏好），服务端已对所有业务接口做了 need_setup 拦截
          showMsg('注册成功，请先完成首次设置…', 'ok');
          setTimeout(() => { goto('setup.html'); }, 600);
          return;
        }
        showMsg('注册成功，正在进入…', 'ok');
        setTimeout(() => { goto(r.redirect || 'user.html'); }, 600);
        return;
      } catch (e) { /* 登录异常则退回登录页 */ }
      showMsg('密码设置成功，正在前往登录…', 'ok');
      setTimeout(() => { goto('login.html'); }, 900);
    } catch (err) {
      showMsg(err.message);
      syncSubmit();   // 失败后按「已读 + 已勾选」恢复按钮状态
    }
  });

  /* ---------------- 维护模式：注册禁止 ----------------
   * 服务端已在维护期拦截 register-code / set-password（返回 503），此处再做前端兜底：
   * 维护中仅用样式把「获取验证码」「提交注册」按钮置灰，但保留可点击（不原生禁用），
   * 由上面的点击 / 提交拦截给出提示——原生 disabled 不会触发 click，无法提示。 */
  function applyMaintenanceState(i) {
    const on = !!(i && i.enabled);
    if (!on) {
      if (sendCodeBtn) {
        sendCodeBtn.classList.remove('maint-disabled');
        sendCodeBtn.disabled = false;
        sendCodeBtn.textContent = '获取验证码';
      }
      submitBtn.classList.remove('maint-disabled');
      submitBtn.disabled = false;
      syncSubmit();   // 按「已读隐私 + 已勾选」恢复提交按钮态
      return;
    }
    if (sendCodeBtn) {
      sendCodeBtn.classList.add('maint-disabled');
      sendCodeBtn.disabled = false;          // 不原生禁用，保证点击能触发拦截提示
      sendCodeBtn.textContent = '维护中暂不可用';
    }
    submitBtn.classList.add('maint-disabled');
    submitBtn.disabled = false;              // 同上：置灰但可点击
  }
  if (window.MaintenanceGuard) window.MaintenanceGuard.subscribe(applyMaintenanceState);
})();
