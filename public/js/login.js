(function () {
  const msgBox = el('msg');

  // 回填「记住密码」保存的账号信息
  const remembered = loadRemembered();
  if (remembered) {
    el('real_name').value = remembered.real_name || '';
    el('student_id').value = remembered.student_id || '';
    if (remembered.identity) el('identity').value = remembered.identity;
    if (remembered.password) el('password').value = remembered.password;
    el('remember').checked = true;
  }
  // 回显「自动登录」开关（与注册页写入的 ci_auto_login 共用）
  try {
    if (localStorage.getItem('ci_auto_login') === '1') el('autoLogin').checked = true;
  } catch (e) { /* 忽略 */ }

  // 管理员 / 运维者忽略学号：对应学号输入框置灰不可点击（文字保留），仅普通学生可填
  function syncSidField() { el('student_id').disabled = el('identity').value !== '普通学生'; }
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
  function clearMsg() { msgBox.innerHTML = ''; }

  // 已注销账号：展示「重启用」工单申请表单
  function showReactivateForm(d) {
    if (chipsBox) chipsBox.classList.add('hidden');
    const form = el('loginForm');
    if (form) form.classList.add('hidden');
    const box = document.createElement('div');
    box.id = 'reactBox';
    box.innerHTML = `
      <div class="alert warn">该账号已注销。可提交「重启用」工单，由上一级管理员审批后重新启用（密码将被清空，需本人重新设置）。</div>
      <div class="field"><label>姓名</label><input id="rName" value="${escapeHtml(d.real_name || '')}"></div>
      <div class="field"><label>身份</label><input id="rIdentity" value="${escapeHtml(d.identity || '')}" disabled></div>
      <div class="field"><label>学号</label><input id="rSid" value="${escapeHtml(d.student_id || '')}"></div>
      <div class="field"><label>申请理由</label><textarea id="rReason" placeholder="请说明为何需要重新启用该账号" rows="3"></textarea></div>
      <button class="btn primary block" id="rSubmit">提交重启用工单</button>
      <button class="btn block" id="rBack" style="margin-top:8px">返回登录</button>
    `;
    clearMsg();
    msgBox.appendChild(box);
    el('rBack').addEventListener('click', () => location.reload());
    el('rSubmit').addEventListener('click', async () => {
      const reason = el('rReason').value.trim();
      if (!reason) return toastErr('请填写申请理由');
      el('rSubmit').disabled = true;
      try {
        const r = await api.post('api/auth/reactivate-request', {
          real_name: el('rName').value.trim(),
          student_id: el('rSid').value.trim(),
          identity: d.identity,
          reason
        });
        msgBox.innerHTML = `<div class="alert ok">${escapeHtml(r.message || '重启用工单已提交')}</div>`;
      } catch (e) { toastErr(e.message); el('rSubmit').disabled = false; }
    });
  }

  // 快速切换：仅同一姓名下的多个层级账号（如既是管理员又是普通学生），其余账号正常登录
  const accounts = sameNameAccounts();
  const chipsBox = el('accountChips');
  function renderChips() {
    if (!chipsBox) return;
    if (!accounts.length) { chipsBox.classList.add('hidden'); chipsBox.innerHTML = ''; return; }
    chipsBox.classList.remove('hidden');
    chipsBox.innerHTML = '<div class="muted" style="margin-bottom:6px">同名多层级账号（点击快速切换）</div>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' +
      accounts.map((a, i) =>
        `<button type="button" class="btn sm" data-acc="${i}">${escapeHtml(a.real_name)} · ${escapeHtml(a.identity)}${a.password ? '' : '（需密码）'}</button>`
      ).join('') + '</div>';
    qsa('#accountChips [data-acc]').forEach(b => b.addEventListener('click', () => {
      const a = accounts[Number(b.getAttribute('data-acc'))];
      el('real_name').value = a.real_name || '';
      el('identity').value = a.identity || '普通学生';
      syncSidField();
      el('student_id').value = a.student_id || '';
      if (a.password) {           // 已记住密码：一键切换
        el('password').value = a.password;
        el('remember').checked = true;
        clearMsg();
        el('loginForm').requestSubmit();
      } else {                    // 未记住密码：填好账号，聚焦密码框
        el('password').value = '';
        el('password').focus();
      }
    }));
  }
  renderChips();

  // 自动剪枝：本机记住的账号若已在服务端被删除（如「一键清空并恢复默认」后），
  // 登录页不再显示。向服务端校验后剔除失效记录，任何设备都会自愈（不依赖清库时手动清本地）。
  (function pruneStaleAccounts() {
    const accounts = loadAccounts();
    if (!accounts.length) return;
    api.post('api/auth/check-accounts', { accounts }).then(r => {
      const exist = new Set((r.existing || []).map(a => a.real_name + '@@' + a.identity));
      const keep = accounts.filter(a => exist.has(a.real_name + '@@' + a.identity));
      if (keep.length !== accounts.length) {
        try { localStorage.setItem('checkin_accounts', JSON.stringify(keep)); } catch (e) { /* 忽略 */ }
        renderChips();
      }
    }).catch(() => { /* 网络异常不影响本地显示 */ });
  })();

  el('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    clearMsg();
    const btn = el('submitBtn');
    btn.disabled = true;

    const payload = Object.assign({
      real_name: el('real_name').value.trim(),
      student_id: el('student_id').value.trim(),
      identity: el('identity').value,
      password: el('password').value
    }, deviceInfo());

    if (!payload.real_name) { showMsg('请输入姓名'); btn.disabled = false; return; }
    if (!payload.password) { showMsg('请输入密码'); btn.disabled = false; return; }
    if (payload.identity === '普通学生' && !payload.student_id) {
      showMsg('普通学生请填写学号'); btn.disabled = false; return;
    }

    try {
      const data = await api.post('api/auth/login', payload);
      const remember = el('remember').checked;
      const autoLogin = el('autoLogin') && el('autoLogin').checked;
      // 记住密码：回填登录字段（不自动提交）；自动登录：打开登录页即直接登录
      if (remember || autoLogin) saveRemembered(payload); else clearRemembered();
      if (autoLogin) {
        try {
          localStorage.setItem('ci_saved_creds', JSON.stringify({
            real_name: payload.real_name, student_id: payload.student_id,
            identity: payload.identity, password: payload.password
          }));
          localStorage.setItem('ci_auto_login', '1');
        } catch (e) { /* 忽略 */ }
      } else {
        try { localStorage.removeItem('ci_auto_login'); localStorage.removeItem('ci_saved_creds'); } catch (e) { /* 忽略 */ }
      }
      // 记住本机账号，供下次快速切换（记住密码时连密码一起存，实现一键切换）
      saveAccount({
        real_name: payload.real_name,
        identity: payload.identity,
        student_id: payload.student_id,
        password: remember ? payload.password : ''
      });
      // 新注册账号：必须先完成首次设置（通知偏好等）才能进入系统；注销恢复的不强制
      if (data.user && data.user.must_setup) goto('setup.html');
      else goto(data.redirect);
    } catch (err) {
      if (err.status === 409 && err.data && err.data.need_set_password) {
        // 维护中：注册 / 设置密码页本身被锁定，不能再跳过去（否则落到锁定页一脸懵），
        // 直接拒绝并提示稍后再试；非维护期才引导前往设置密码（账号激活）。
        // 跳转前重新拉取最新维护态，避免页面刚加载时状态尚未就绪而误判、仍跳到被锁的注册页。
        let underMaint = window.maintOn && window.maintOn();
        try {
          if (window.MaintenanceGuard && !underMaint) {
            await window.MaintenanceGuard.check();
            underMaint = window.maintOn && window.maintOn();
          }
        } catch (e) { /* 忽略，按现有状态处理 */ }
        if (underMaint) {
          showMsg('系统维护中，暂无法设置密码，请稍后再试');
          btn.disabled = false;
        } else {
          const q = new URLSearchParams({
            n: err.data.real_name || '',
            s: err.data.student_id || '',
            i: err.data.identity || ''
          });
          showMsg((err.data.error || '该账号尚未设置密码') + '，正在前往设置密码…', 'warn');
          setTimeout(() => { goto('register.html?' + q.toString()); }, 900);
        }
      } else if (err.data && err.data.cancelled) {
        showReactivateForm(err.data);
      } else {
        showMsg(err.message);
        btn.disabled = false;
      }
    }
  });

  // 自动登录：本机曾勾选「自动登录」且保存了凭据，进入登录页即尝试登录。
  // 但若本次是「登出 / 会话失效」跳转过来的（api.js 的 markLoggedOut 标记），跳过一次 ——
  // 否则刚退出登录就会被自动登录顶回登录态，表现为「退不出去」。
  try {
    let skipAuto = false;
    try {
      skipAuto = sessionStorage.getItem('ci_skip_auto_login') === '1';
      if (skipAuto) sessionStorage.removeItem('ci_skip_auto_login');
    } catch (e) { /* 忽略 */ }
    if (!skipAuto && localStorage.getItem('ci_auto_login') === '1') {
      const creds = JSON.parse(localStorage.getItem('ci_saved_creds') || 'null');
      if (creds && creds.real_name && creds.password) {
        el('real_name').value = creds.real_name;
        el('student_id').value = creds.student_id || '';
        if (creds.identity) el('identity').value = creds.identity;
        syncSidField();
        el('password').value = creds.password;
        setTimeout(() => { try { el('loginForm').requestSubmit(); } catch (e) { try { el('loginForm').submit(); } catch (_) {} } }, 60);
      }
    }
  } catch (e) { /* 忽略 */ }

  /* ---------------- 维护模式：登录页顶部横幅 + 拦截「注册 / 找回密码」入口 ----------------
   * 维护中注册、邮箱验证码、提醒邮件等功能暂停。未登录用户的登录页不显示全屏遮罩
   * （需放行运维者登录以关闭维护），故在此用「顶部横幅」告知，并从源头拦截这两个入口，
   * 避免跳到不可用页面（register.html / forgot.html 自身也会在维护中禁用按钮，此处使体验一致）。
   * 仅靠遮罩无法覆盖这两条链接（遮罩对未登录态刻意不显示），因此用订阅 + 点击拦截兜底。 */
  (function guardLoginLinks() {
    const regLink = document.querySelector('.foot-row a[href="register.html"]');
    const forgotLink = document.querySelector('.foot-row a[href="forgot.html"]');
    const banner = el('maintTopBanner');
    const links = [regLink, forgotLink].filter(Boolean);

    /* 维护中点击「注册 / 找回密码」：仅弹框提示，不进入对应页面（register.html / forgot.html
       自身在维护中会被锁，跳过去也是一脸懵）。这里无条件绑定监听、每次点击实时判断维护态，
       不依赖「先检测到维护才预绑定」——否则维护态在链接加载后才就绪、或预绑定时序未触发时，
       点击仍会跳进被锁的页面。 */
    function onClick(e) {
      const g = window.MaintenanceGuard && window.MaintenanceGuard.state();
      if (g && g.enabled) {
        e.preventDefault();
        e.stopPropagation();
        toastErr('系统维护中，注册 / 找回密码功能暂不可用，请稍后再试');
      }
    }
    links.forEach(a => a.addEventListener('click', onClick));

    /* 维护时间格式化：YYYY-MM-DD HH:mm（与维护遮罩保持一致） */
    function fmt(ts) {
      const n = Number(ts);
      if (!n) return '';
      const d = new Date(n);
      const p = x => String(x).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function apply(i) {
      const on = !!(i && i.enabled);
      // 顶部横幅（仅登录页）：维护中展示，说明部分功能暂不可用 + 维护说明 + 起止时间
      if (banner) {
        if (on) {
          const notice = (i && i.notice) ? escapeHtml(i.notice) : '';
          const start = fmt(i && i.start_at);
          const end = fmt(i && i.end_at);
          const ico = '<svg class="m-banner-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>'
            + '<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
          const timeText = (start || end)
            ? '<span class="m-banner-meta">' + (start ? escapeHtml(start) : '待定')
              + (end ? ' – ' + escapeHtml(end) : '') + '</span>'
            : '';
          const foot = timeText + (notice ? '维护说明：' + escapeHtml(notice) : '');
          banner.innerHTML = '<span class="m-banner-title">' + ico + '<b>系统维护中</b></span>'
            + '<span class="m-banner-msg">仅运维者可操作，其他用户暂无法使用；注册 / 找回密码功能亦暂停。</span>'
            + (foot ? '<span class="m-banner-foot">' + foot + '</span>' : '');
          banner.classList.remove('hidden');
        } else {
          banner.classList.add('hidden');
          banner.innerHTML = '';
        }
      }
      links.forEach(a => {
        a.classList.toggle('maint-disabled', on);
        if (on) a.setAttribute('aria-disabled', 'true'); else a.removeAttribute('aria-disabled');
      });
    }
    if (window.MaintenanceGuard) window.MaintenanceGuard.subscribe(apply);
  })();

})();
