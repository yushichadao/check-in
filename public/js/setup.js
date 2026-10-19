(function () {
  const NP_CHAN = { both: '站内 + 邮件', inbox: '仅站内消息', off: '关闭' };
  const NP_DESC = {
    '活动与签到提醒': '活动与签到提醒最容易被邮件打扰，可改为「仅站内消息」或「关闭」。',
    '退回 / 回执': '裁决退回、核验 / 补签完成的回执提醒，按需选择是否要邮件。',
    '工单与系统消息': '工单与系统消息为必提醒，系统强制发送，不可更改。'
  };
  const homeOf = (me) => (me.role === 'ops' ? 'ops.html' : (me.role === 'manager' ? 'manager.html' : 'user.html'));
  // 管理端是否成功加载了真实班级级设置（仅有权限时）；finish 据此决定是否附带保存
  let classSettingsLoaded = false;

  async function init() {
    let me;
    try {
      const d = await api.get('api/auth/me');
      me = d.user;
    } catch (e) {
      goto('login.html');
      return;
    }
    if (!me || !me.must_setup) { goto(homeOf(me)); return; }

    const isStudent = me.role === 'normal';
    const isOps = me.role === 'ops';
    el('roleHint').innerHTML = isStudent
      ? '为保障你的使用体验，新账号首次进入前请选择「通知偏好」。不想被邮件打扰，可把活动与签到提醒改为<b>仅站内消息</b>或<b>关闭</b>；密码 / 异地登录等安全邮件必须保留（不可关闭）。'
      : (isOps
        ? '请选择通知方式，并确认两项运维开关。活动与签到类提醒仅学生会收到，故不在你的偏好里。'
        : '请选择通知方式。活动与签到类提醒仅学生会收到，不在你的偏好里；班级通用设置可在本页下方直接配置（需相应权限），其余可在进入系统后的「通知设置」「系统安全」中调整。');

    await renderPrefs();
    show('secLoc', isStudent);
    show('secClean', isStudent);
    // 清爽模式开关：同步「已开启 / 已关闭」文案与 aria 状态（提交时的取值仍走 cleanModeChk.checked）
    const cleanChk = el('cleanModeChk');
    if (cleanChk) {
      const syncClean = () => {
        const st = el('cleanModeState');
        if (st) st.textContent = cleanChk.checked ? '已开启' : '已关闭';
        cleanChk.setAttribute('aria-pressed', String(cleanChk.checked));
      };
      cleanChk.addEventListener('change', syncClean);
      syncClean();
    }
    show('secMgr', !isStudent && !isOps);
    show('secDev', isOps);
    if (!isStudent && !isOps) await loadClassSettings();

    // 定位授权：默认「暂不授权」（隐私优先，与页面默认选中态 locNo 一致）；
    // 用户可主动点「自愿授权」改为 1，之后仍可在「账号信息 → 定位上传授权」调整。
    let locChoice = 0;
    if (isStudent) {
      el('locYes').onclick = () => { locChoice = 1; mark('locYes', 'locNo'); };
      el('locNo').onclick = () => { locChoice = 0; mark('locNo', 'locYes'); };
    }
    if (isOps) {
      try {
        const s = await api.get('api/settings');
        el('devMask').checked = s.settings && s.settings.dataflow_mask === '1';
        el('devAutoCover').checked = s.auto_cover_enabled !== false && s.auto_cover_enabled !== '0';
      } catch (e) { /* 用后端现状兜底，忽略 */ }
    }
    el('finishBtn').onclick = () => finish(me, isStudent, isOps, locChoice);
    }

    // 管理端：加载真实班级级设置。
    //  · 持有 SYS_SETTINGS / FENCE_VERIFY 权限 → 直接在此页渲染可编辑控件（首次设置即可顺手配好）；
    //  · 无权限（班委 R1 / 小班主任 R2 等）→ 展示「当前状态 · 只读」概览，让区块有内容、不空着像坏掉；
    //  · 接口异常 → 整段静默跳过，绝不阻断首次设置。
    async function loadClassSettings() {
      const noticeEl = el('mgrNotice');
      const box = el('mgrSettings');
      if (!box) return;
      let d;
      try { d = await api.get('api/settings'); }
      catch (e) { return; }                 // 异常：保持纯提示文案
      const canSettings = !!(d.can && d.can.settings);
      const canLoc = !!(d.can && d.can.location_verify);

      // 无配置权限：只读概览，明确「看得到、改不了、去哪改」
      if (!canSettings && !canLoc) {
        if (noticeEl) noticeEl.classList.add('hidden');
        box.classList.remove('hidden');
        box.innerHTML = readOnlySummary(d);
        return;
      }

      // 有权限：渲染可编辑控件
      if (noticeEl) noticeEl.classList.add('hidden');
      box.classList.remove('hidden');
      let html = '';
      if (canSettings) {
        const prefs = d.notify_prefs || {};
        const rows = Object.keys(prefs).map(k => {
          const p = prefs[k];
          if (p.mandatory || !p.configurable) return '';
          return `<div class="pref-row">
            <input type="checkbox" data-cls="${escapeHtml(k)}" ${p.enabled ? 'checked' : ''} style="width:auto">
            <div><div class="pf-name">${escapeHtml(p.name)}</div>
            <div class="pf-meta">班级通知（对全班生效）</div></div>
          </div>`;
        }).join('');
        if (rows) html += `<div class="np-gtitle">班级通知开关（对全班生效）</div>${rows}`;
      }
      if (canLoc) {
        html += `<label class="row" style="gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
          <input type="checkbox" id="clsLoc" ${d.location_verify_enabled ? 'checked' : ''} style="width:auto">
          启用定位核验（让普通学生签到时上传定位，进行活动范围核验）
        </label>`;
      }
      box.innerHTML = html || '<div class="empty">暂无可配置的班级通用开关</div>';
      classSettingsLoaded = true;
    }

    // 无修改权限时的只读概览：展示班级当前生效状态 + 去哪改，避免区块空着显得异常
    function readOnlySummary(d) {
      const prefs = d.notify_prefs || {};
      const rows = Object.keys(prefs).map(k => {
        const p = prefs[k];
        if (p.mandatory) return '';
        const on = !!p.enabled;
        return `<div class="pref-row">
          <span style="min-width:42px;text-align:center;font-size:12px;font-weight:600;color:${on ? '#1a7f37' : '#8a94a6'}">${on ? '开启' : '关闭'}</span>
          <div><div class="pf-name">${escapeHtml(p.name)}</div>
          <div class="pf-meta">班级通知（对全班生效）</div></div>
        </div>`;
      }).join('');
      const locOn = !!d.location_verify_enabled;
      const locRow = `<div class="pref-row">
        <span style="min-width:42px;text-align:center;font-size:12px;font-weight:600;color:${locOn ? '#1a7f37' : '#8a94a6'}">${locOn ? '开启' : '关闭'}</span>
        <div><div class="pf-name">定位核验总开关</div>
        <div class="pf-meta">让普通学生签到时上传定位、进行活动范围核验（对全班生效）</div></div>
      </div>`;
      const body = rows
        ? `<div class="np-gtitle">班级通用设置 · 当前状态（只读）</div>${rows}${locRow}`
        : `<div class="np-gtitle">班级通用设置 · 当前状态（只读）</div>${locRow}`;
      const note = `<div class="muted" style="font-size:12px;line-height:1.7;margin-top:10px">你当前账号无修改权限，以上为班级当前生效状态。如需调整，可提交权限工单，或由在「通知设置 / 系统安全」中具有相应权限的同学修改。</div>`;
      return body + note;
    }

  async function renderPrefs() {
    const box = el('npBox');
    if (!box) return;
    let prefs;
    try {
      const d = await api.get('api/settings/me/notify');
      prefs = d.prefs || [];
    } catch (e) {
      box.innerHTML = '<div class="empty">加载失败，请刷新重试</div>';
      return;
    }
    const groups = {};
    prefs.forEach(p => { (groups[p.cat_name] = groups[p.cat_name] || []).push(p); });
    const html = Object.keys(groups).map(g => `
      <div class="np-group">
        <div class="np-gtitle">${escapeHtml(g)}${NP_DESC[g] ? `<small>${escapeHtml(NP_DESC[g])}</small>` : ''}</div>
        ${groups[g].map(p => `
          <div class="np-row">
            <div class="np-name">${escapeHtml(p.name)}${p.locked ? ' <span class="badge locked">必保留</span>' : ''}</div>
            <select class="np-sel" data-np="${escapeHtml(p.key)}" ${p.locked ? 'disabled title="系统必提醒，不可关闭"' : ''}>
              <option value="both"${p.channel === 'both' ? ' selected' : ''}>${NP_CHAN.both}</option>
              <option value="inbox"${p.channel === 'inbox' ? ' selected' : ''}>${NP_CHAN.inbox}</option>
              <option value="off"${p.channel === 'off' ? ' selected' : ''}>${NP_CHAN.off}</option>
            </select>
          </div>`).join('')}
      </div>`).join('');
    box.innerHTML = html || '<div class="empty">暂无可配置项</div>';
  }

  async function finish(me, isStudent, isOps, locChoice) {
    const btn = el('finishBtn');
    btn.disabled = true;
    const prefs = {};
    qsa('#npBox select[data-np]').forEach(s => { prefs[s.getAttribute('data-np')] = s.value; });
    // 清爽模式：默认开启（学生端首次设置页默认勾选），随首次设置一并落库
    const cleanEl = el('cleanModeChk');
    const clean_mode = cleanEl ? (cleanEl.checked ? 1 : 0) : 1;
    try {
      await api.put('api/settings/me/notify', { prefs });
      if (isStudent && locChoice !== null) {
        await api.post('api/auth/me/loc-consent', { consent: locChoice });
      }
      if (isOps) {
        await api.post('api/dataflow/mask', { mask: el('devMask').checked });
        await api.put('api/settings/auto-cover', { enabled: el('devAutoCover').checked });
      }
      // 班级级设置（管理端）：与个人偏好相互独立，失败不影响完成设置
      if (classSettingsLoaded) {
        try {
          const cls = {};
          qsa('#mgrSettings [data-cls]').forEach(i => { if (!i.disabled) cls[i.getAttribute('data-cls')] = i.checked; });
          if (Object.keys(cls).length) await api.put('api/settings/notify', { prefs: cls });
          const locEl = el('clsLoc');
          if (locEl) await api.put('api/settings/location-verify', { enabled: !!locEl.checked });
        } catch (e) { /* 班级级设置可选，忽略 */ }
      }
      const r = await api.post('api/auth/me/complete-setup', { prefs, clean_mode });
      toast(r.message || '首次设置已完成');
      gotoReplace(r.redirect || homeOf(me));
    } catch (e) {
      toastErr(e.message);
      btn.disabled = false;
    }
  }

  function show(id, yes) { const e = document.getElementById(id); if (e) e.classList.toggle('hidden', !yes); }
  function mark(onId, offId) {
    document.getElementById(onId).classList.add('primary');
    document.getElementById(offId).classList.remove('primary');
  }

  init();
})();
