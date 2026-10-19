/* 找回密码页（分栏：方式一 请求清除密码 / 方式二 邮箱验证码自助重置） */
(function () {
  // 维护锁页：维护期间找回密码功能全局暂停，本页强制显示遮罩、禁止进入（见 api.js MaintenanceGuard）
  window.__maintLockPage = true;
  // 立即拉取维护态（不等 800ms 定时检查），尽快盖住页面，避免维护中仍能短暂看到表单
  if (window.MaintenanceGuard) window.MaintenanceGuard.check();
  const msgBox = el('msg');

  // 管理员 / 运维者忽略学号：对应学号输入框置灰不可填，仅普通学生可填
  function syncForgotSid() { el('f_sid').disabled = el('f_identity').value !== '普通学生'; }
  function syncEmailSid() { el('e_sid').disabled = el('e_identity').value !== '普通学生'; }
  el('f_identity').addEventListener('change', syncForgotSid);
  el('e_identity').addEventListener('change', syncEmailSid);
  syncForgotSid();
  syncEmailSid();

  function showMsg(text, kind) {
    // 错误/警告改用 toast，确保在任何滚动位置都可见；成功仍留在页内提示
    if (kind === 'ok') {
      msgBox.innerHTML = `<div class="alert ok">${escapeHtml(text)}</div>`;
      return;
    }
    msgBox.innerHTML = '';
    toastErr(text);
  }

  /* 方式切换按钮：方式一 / 方式二 面板互斥显示 */
  function selectMethod(n) {
    const one = n === 1;
    el('panelMethod1').classList.toggle('hidden', !one);
    el('panelMethod2').classList.toggle('hidden', one);
    el('tabMethod1').classList.toggle('primary', one);
    el('tabMethod2').classList.toggle('primary', !one);
    msgBox.innerHTML = '';
  }
  el('tabMethod1').addEventListener('click', () => selectMethod(1));
  el('tabMethod2').addEventListener('click', () => selectMethod(2));

  /* 方式一：提交「请求管理员 / 运维者清除密码」申请 */
  el('forgotSubmit').addEventListener('click', async function () {
    if (window.maintOn()) { toastErr('系统维护中，找回密码功能暂不可用，请稍后再试'); return; }
    if (!el('f_name').value.trim()) return showMsg('请输入姓名');
    try {
      await api.post('api/auth/pwd-reset-request', {
        real_name: el('f_name').value.trim(),
        student_id: el('f_sid').value.trim(),
        identity: el('f_identity').value
      });
      showMsg('申请已提交，请联系管理员 / 运维者清除密码后重新设置', 'ok');
    } catch (err) {
      showMsg(err.message);
    }
  });

  /* 方式二：发送邮箱验证码 */
  el('eSendCode').addEventListener('click', async function () {
    if (window.maintOn()) { toastErr('系统维护中，找回密码功能暂不可用，请稍后再试'); return; }
    const btn = el('eSendCode');
    const payload = {
      real_name: el('e_name').value.trim(),
      identity: el('e_identity').value,
      student_id: el('e_sid').value.trim(),
      email: el('e_email').value.trim()
    };
    if (!payload.real_name) return showMsg('请输入姓名');
    if (!payload.email) return showMsg('请输入注册邮箱');
    btn.disabled = true;
    try {
      const r = await api.post('api/auth/email-code', payload);
      showMsg(r.message || '验证码已发送，请查收邮箱', 'ok');
    } catch (err) {
      showMsg(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  /* 方式二：校验验证码并重置密码 */
  el('eResetBtn').addEventListener('click', async function () {
    if (window.maintOn()) { toastErr('系统维护中，找回密码功能暂不可用，请稍后再试'); return; }
    const btn = el('eResetBtn');
    const payload = {
      real_name: el('e_name').value.trim(),
      identity: el('e_identity').value,
      student_id: el('e_sid').value.trim(),
      email: el('e_email').value.trim(),
      code: el('e_code').value.trim(),
      password: el('e_pwd').value,
      confirm: el('e_pwd2').value
    };
    if (!payload.real_name) return showMsg('请输入姓名');
    if (!payload.email) return showMsg('请输入注册邮箱');
    if (!/^\d{6}$/.test(payload.code)) return showMsg('请输入 6 位数字验证码');
    if (!payload.password) return showMsg('请输入新密码');
    if (payload.password.length < 6) return showMsg('新密码至少 6 位');
    if (!(/[A-Za-z]/.test(payload.password) && /\d/.test(payload.password))) return showMsg('新密码必须同时包含字母和数字');
    if (payload.password !== payload.confirm) return showMsg('两次输入的密码不一致');
    btn.disabled = true;
    try {
      const r = await api.post('api/auth/email-reset', payload);
      showMsg(r.message || '密码已重置，正在前往登录…', 'ok');
      setTimeout(() => { goto('login.html'); }, 1000);
    } catch (err) {
      showMsg(err.message);
      btn.disabled = false;
    }
  });

  /* ---------------- 维护模式：找回密码禁止 ----------------
   * 服务端已在维护期拦截 pwd-reset-request / email-code / email-reset（返回 503），
   * 此处再做前端兜底：维护中仅用样式置灰相关按钮，但保留可点击（不原生禁用），
   * 由上面的点击拦截给出提示——原生 disabled 不会触发 click，无法提示。 */
  function applyMaintenanceState(i) {
    const on = !!(i && i.enabled);
    ['forgotSubmit', 'eSendCode', 'eResetBtn'].forEach(id => {
      const b = el(id);
      if (!b) return;
      b.classList.toggle('maint-disabled', on);
      b.disabled = false;   // 不原生禁用，保证点击能触发拦截提示
    });
  }
  if (window.MaintenanceGuard) window.MaintenanceGuard.subscribe(applyMaintenanceState);
})();
