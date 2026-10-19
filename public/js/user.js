(function () {
  let me = null;
  let currentActivity = null;
  let displayedActivityId = null;   // 当前首页卡片展示的活动 id
  let displayedMineKey = null;      // 该活动下「我的状态」签名，状态变化或切换活动时重渲染（避免无谓闪烁）
  let selectedChoice = null;
  let disabledChoiceHint = '';   // 选项被置灰时的真实理由提示（避免已签到却误报「时间窗口」）
  let myRecords = [];   // 我的签到记录，用于在活动卡里显示「我的状态」
  let myMakeups = [];   // 我的补签申请
  let myLeaves = [];    // 我的请假申诉
  let myPerm = null;    // 权限态 / 系统公开设置
  let sysPublic = { location_verify_enabled: false, maintenance_enabled: false, announcement_text: '' };
  let locConsent = null;  // 定位上传授权：null=未选择 / 0=不授权 / 1=授权（本人自愿，属个人隐私）

  /* ---------------- 设备识别码：统一由 api.js 的 deviceKey() 提供（服务器签发，见 api.js） ---------------- */

  /* ---------------- 实时获取定位（仅用于校验，不落本地存储） ---------------- */
  function getLocation() {
    return new Promise((resolve, reject) => {
      const blocked = geoUnavailableReason();
      if (blocked) return reject(new Error(blocked));
      navigator.geolocation.getCurrentPosition(
        pos => resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }),
        err => {
          const map = { 1: '定位权限被拒绝，请在浏览器中允许定位', 2: '暂时无法获取位置', 3: '获取定位超时' };
          reject(new Error(map[err.code] || '获取定位失败'));
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
      );
    });
  }

  /* ---------------- 初始化 ---------------- */
  async function init() {
    try {
      const data = await api.get('api/auth/me');
      me = data.user;
      if (me.role !== 'normal') { goto(data.redirect); return; }
      myPerm = data.perm || { level: 0, perms: {} };
      locConsent = (data.loc_consent === 1 || data.loc_consent === 0) ? data.loc_consent : null;
    } catch (e) {
      goto('login.html');
      return;
    }
    if (window.PermGate) { PermGate.init(myPerm); PermGate.apply(document); }

    await loadSysPublic();

    el('whoBar').innerHTML = `${escapeHtml(me.real_name)}<small>${escapeHtml(me.student_id || '无学号')} · ${escapeHtml(me.role_title)}</small>`;
    if (el('switchAccountBtn') && !hasSwitchableAccounts()) el('switchAccountBtn').classList.add('hidden');

    if (me.must_change_pwd) {
      el('pwdAlert').innerHTML = '<div class="alert warn">当前为初始密码，请尽快在「账号信息」中修改密码。</div>';
    }

    bindAppeal();
    bindForgot();

    // 清爽模式：在账号信息渲染前初始化，确保开关初始态正确
    // 注意：data 在上方 try 块内声明（块级作用域），此处改用 me.clean_mode（publicUser 已暴露）
    if (window.CleanMode) CleanMode.init({ clean_mode: me.clean_mode });

    // 账号信息分区（基本信息 / 账号安全 / 定位上传授权 / 通知偏好 / 界面偏好）统一由 account-info.js 渲染
    if (window.AccountInfo) AccountInfo.init({ me, locConsent });
    await Promise.all([loadRecords(), loadMakeups(), loadLeaves()]);
    loadActivity();
    // 首页实时：每 15 秒重新拉取当前应展示的活动并按本人记录决策（同活动不重渲染，避免闪烁）；
    // 同时在每次轮询前刷新「我的签到记录」，使签到后及时从「刚结束预留」切到下一活动
    setInterval(async () => {
      try { const d = await api.get('api/checkin/my'); myRecords = d.records || []; } catch (e) {}
      loadActivity();
    }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadActivity(); });
    loadMyStream();
    loadAppealRows();
    // 活动列表筛选下拉
    if (el('userActFilter')) el('userActFilter').addEventListener('change', () => {
      userActFilter = el('userActFilter').value;
      userActPage = 1;
      renderUserActList();
    });
    if (el('userActPageSize')) el('userActPageSize').addEventListener('change', () => {
      const v = el('userActPageSize').value;
      userActPageSize = v === 'all' ? 99999 : (Number(v) || 10);
      userActPage = 1;
      renderUserActList();
    });
    // 活动列表分页控件
    if (el('userActPrev')) el('userActPrev').addEventListener('click', () => { if (userActPage > 1) { userActPage--; renderUserActList(); } });
    if (el('userActNext')) el('userActNext').addEventListener('click', () => { userActPage++; renderUserActList(); });
    if (el('userActPageInput')) el('userActPageInput').addEventListener('change', () => {
      let v = parseInt(el('userActPageInput').value, 10) || 1;
      const max = parseInt(el('userActPageInput').max, 10) || 1;
      if (v < 1) v = 1; if (v > max) v = max;
      el('userActPageInput').value = v;
      userActPage = v;
      renderUserActList();
    });
    // 签到记录翻页控件
    if (el('recPageSize')) el('recPageSize').addEventListener('change', () => {
      recPageSize = Number(el('recPageSize').value) || 10;
      recPage = 1;
      renderRecordRows();
    });
    if (el('recPrev')) el('recPrev').addEventListener('click', () => { if (recPage > 1) { recPage--; renderRecordRows(); } });
    if (el('recNext')) el('recNext').addEventListener('click', () => { recPage++; renderRecordRows(); });
    if (el('recPageInput')) el('recPageInput').addEventListener('change', () => {
      let v = parseInt(el('recPageInput').value, 10) || 1;
      const max = parseInt(el('recPageInput').max, 10) || 1;
      if (v < 1) v = 1; if (v > max) v = max;
      el('recPageInput').value = v;
      recPage = v;
      renderRecordRows();
    });
    initSections('checkin');
  }

  /* ---------------- 系统公开设置（定位核验开关 / 维护模式 / 公告） ---------------- */
  async function loadSysPublic() {
    try {
      const d = await api.get('api/settings/public');
      sysPublic = {
        location_verify_enabled: !!d.location_verify_enabled,
        maintenance_enabled: !!d.maintenance_enabled,
        announcement_text: d.announcement_text || ''
      };
    } catch (e) { /* 忽略 */ }
    // 定位核验总开关（上级未开启）→ 隐藏全部「定位类」UI（见 app.css .loc-disabled [data-loc]）
    document.body.classList.toggle('loc-disabled', !sysPublic.location_verify_enabled);
    applyMaintenanceState();
    renderLocHint();
    maybeShowAnnouncement();
  }

  /** 维护模式：维护中禁用提交入口（服务端同样拦截，不再显示提示条） */
  function applyMaintenanceState() {
    if (sysPublic.maintenance_enabled && el('submitChoice')) el('submitChoice').disabled = true;
  }

  /** 隐私告知弹窗：文案变更后需重新确认 */
  function maybeShowAnnouncement() {
    const text = sysPublic.announcement_text;
    if (!text) return;
    let ack = null;
    try { ack = localStorage.getItem('checkin_announcement_ack'); } catch (e) { ack = null; }
    const stamp = String(text.length) + '-' + String(text.slice(0, 40));
    if (ack === stamp) return;
    const modal = el('announcementModal');
    if (!modal) return;
    el('announcementText').textContent = text;
    modal.classList.remove('hidden');
  }

  el('announcementLater').addEventListener('click', () => el('announcementModal').classList.add('hidden'));
  el('announcementOk').addEventListener('click', () => {
    const text = sysPublic.announcement_text || '';
    const stamp = String(text.length) + '-' + String(text.slice(0, 40));
    try { localStorage.setItem('checkin_announcement_ack', stamp); } catch (e) { /* 忽略 */ }
    el('announcementModal').classList.add('hidden');
    toast('已确认公告');
  });

  /**
   * 签到页定位提示：只按「本人是否自愿授权」说明本次提交会不会采集位置。
   * 原「定位模式（二选一）」已移除（该选择不随提交上报、两种模式实际行为一致）。
   * 定位核验总开关关闭时，本提示连同其它定位类 UI 由 .loc-disabled + [data-loc] 隐藏。
   */
  function renderLocHint() {
    const hint = el('locModeHint');
    const on = sysPublic.location_verify_enabled;
    if (hint) {
      // 文案与实际行为一一对应，避免「会上传 / 不会采集」同时出现互相矛盾：
      //  未授权 → 明确「不会采集」；未选择 → 说明提交时会询问；已授权 → 说明会上传当前位置。
      let base;
      if (locConsent === 0) {
        base = '你未授权上传定位，提交时不会采集你的位置（不影响签到）。想开启可在「账号信息 → 定位上传授权」中授权。';
      } else if (locConsent === null) {
        base = '首次提交时会询问你是否自愿授权上传定位；不授权也能正常签到。';
      } else {
        base = '提交时会上传你当前的位置；活动范围仅作参考，不会因不在范围内而阻止你签到。';
      }
      hint.textContent = base;
    }
    // 「签到」格副标题按开关状态换文案（而非隐藏），与「在途中 / 请假」两格保持视觉平衡：
    // 开 → 活动范围仅供参考；关 → 不采集位置，正常提交即可
    const signSub = el('signSub');
    if (signSub) signSub.textContent = on ? '活动范围仅供参考' : '正常提交即可记录';
    // 定位类元素的显隐统一由 <body>.loc-disabled + [data-loc]（app.css）控制，此处仅维护提示文案
  }

  // 供 account-info.js 在「账号信息」页切换定位授权后，同步签到页的提示与本地状态
  window.onLocConsentChange = function (v) {
    locConsent = (v === 1 || v === 0) ? v : null;
    renderLocHint();
  };

  /* ---------------- 定位上传授权（本人自愿，属个人隐私，不进数据流） ---------------- */
  /** 首次涉及定位时弹窗询问是否自愿授权，返回 true=授权 / false=不授权 */
  function askLocConsent() {
    return new Promise(resolve => {
      const mask = el('locConsentModal');
      if (!mask) return resolve(false);
      const yes = el('locConsentYes');
      const no = el('locConsentNo');
      mask.classList.remove('hidden');
      const done = (v) => {
        mask.classList.add('hidden');
        if (yes) yes.onclick = null;
        if (no) no.onclick = null;
        resolve(v);
      };
      if (yes) yes.onclick = () => done(true);
      if (no) no.onclick = () => done(false);
    });
  }

  /* ---------------- 申诉（补签 / 事后请假） ---------------- */
  let appealActivities = [];

  function bindAppeal() {
    el('apSubmit').addEventListener('click', submitAppeal);
    el('reloadAppeal').addEventListener('click', loadAppealRows);
    el('reloadAppealForm').addEventListener('click', fillAppealActivities);
    const type = el('apType');
    if (type) type.addEventListener('change', fillAppealActivities);
    bindAppealFiles();
  }

  /** 申诉页下拉本来就只列「已结束」的活动，标题里手写的状态后缀（如「（子·历史）」「（已结束）」「·历史」）是冗余信息，清洗掉 */
  function cleanAppealTitle(t) {
    return String(t || '')
      .replace(/[（(][^（）()]*?(历史|已结束|已完结)[^（）()]*?[）)]/g, '') // （子·历史）（历史）（已结束）
      .replace(/\s*[·:：]\s*(历史|已结束|已完结)/g, '')                       // ·历史 ·已结束
      .trim();
  }

  async function fillAppealActivities() {
    const sel = el('apActivity');
    if (!sel) return;
    const type = el('apType').value;
    const now = Date.now();
    if (!appealActivities.length) {
      try {
        const d = await api.get('api/activities');
        appealActivities = (d.activities || []).filter(a => !a.is_group);
      } catch (e) { appealActivities = []; }
    }
    const opts = appealActivities
      .filter(a => appealEligibility(a, type, now).ok)
      .sort((x, y) => (y.start_time || 0) - (x.start_time || 0));
    sel.innerHTML = opts.length
      ? opts.map(a => `<option value="${a.id}">${escapeHtml(cleanAppealTitle(a.title))} · ${fmtDate(a.start_time)}</option>`).join('')
      : '<option value="">暂无符合条件的活动</option>';
  }

  /** 首页缺勤引导：跳到「申诉」页并预选刚结束的活动 + 补签类型。
   *  无论是否开启清爽模式都展示该引导（与清爽模式无关，故不加 data-clean-hide）。 */
  async function goAppealFor(activity, type) {
    type = type || 'makeup';
    if (window.gotoSection) window.gotoSection('appeal'); // 触发 onSectionChange → 自动填充申诉活动下拉
    const t = el('apType');
    if (t) t.value = type;
    try { await fillAppealActivities(); } catch (e) { /* 忽略 */ }
    const sel = el('apActivity');
    if (sel) {
      const exists = Array.from(sel.options).some(o => String(o.value) === String(activity.id));
      if (exists) {
        sel.value = activity.id;
      } else {
        // 兜底：若下拉未列出（极端情况下），仍追加一项确保可选中
        const opt = document.createElement('option');
        opt.value = activity.id;
        opt.textContent = (activity.title || '活动') + ' · ' + fmtDate(activity.start_time);
        sel.appendChild(opt);
        sel.value = activity.id;
      }
    }
    const reason = el('apReason');
    if (reason) reason.focus();
  }

  function phaseOf(a, now) {
    now = now || Date.now();
    const w = a.window || { open: a.start_time, close: a.end_time };
    if (now < w.open) return 'upcoming';
    if (now > w.close) return 'ended';
    return 'ongoing';
  }

  /** 预判某活动对当前申诉类型是否可申诉（下拉只列出可申诉的活动）
   *  - 补签 / 事后请假 都只针对「已结束」的活动（正常请假在签到页完成）；
   *  - 已签到 / 已请假（含结束前请假，无论未反馈还是已批准）的活动不再作为申诉目标；
   *  - 已驳回的请假 / 补签视作未覆盖，仍可继续申诉（看情况）。 */
  function appealEligibility(a, type, now) {
    now = now || Date.now();
    if (phaseOf(a, now) !== 'ended') return { ok: false, reason: '活动尚未结束' };
    const rec = myRecords.find(r => r.activity_id === a.id);
    const signed = rec && (rec.status === 'signed' || rec.status === 'leave');
    const mkOk = myMakeups.find(m => m.activity_id === a.id && (m.status === 'pending' || m.status === 'approved'));
    const lvOk = myLeaves.find(m => m.activity_id === a.id && (m.status === 'pending' || m.status === 'approved'));
    if (type === 'makeup') {
      if (signed) return { ok: false, reason: '你已有有效记录' };
      if (mkOk) return { ok: false, reason: '已有补签申请' };
      if (lvOk) return { ok: false, reason: '已提交请假，无需补签' };
      return { ok: true };
    }
    // 事后请假
    if (rec && rec.status === 'signed') return { ok: false, reason: '你已签到' };
    if (lvOk) return { ok: false, reason: '已有请假申请' };
    if (mkOk) return { ok: false, reason: '已有补签申请' };
    return { ok: true };
  }

  /* ---------------- 申诉图片：前端压缩后上传 ---------------- */
  async function uploadAppealImages(files) {
    const ids = [];
    for (const f of files.slice(0, 3)) {
      const dataUrl = await compressImage(f, 1280, 0.8);
      const r = await api.post('api/appeal/upload', { data: dataUrl, mime: 'image/jpeg', name: f.name });
      if (r.id) ids.push(r.id);
    }
    return ids;
  }

  /** 用 canvas 把图片压到指定长边，避免手机原图过大 */
  function compressImage(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('图片格式不支持'));
        img.onload = () => {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function submitAppeal() {
    const aid = Number(el('apActivity').value);
    const type = el('apType').value;
    const reason = String(el('apReason').value || '').trim();
    if (!aid) return toast('请选择活动');
    if (!reason) return toast('请填写申诉理由');

    try {
      let attachmentIds = [];
      const input = el('apFiles');
      if (input && input.files && input.files.length) {
        toast('正在上传佐证图片…');
        attachmentIds = await uploadAppealImages(Array.prototype.slice.call(input.files));
      }
      const body = { activity_id: aid, reason, attachment_ids: attachmentIds };
      const r = type === 'makeup'
        ? await api.post('api/appeal/makeup', body)
        : await api.post('api/appeal/leave', body);
      toast(r.message || '申诉已提交');

      el('apReason').value = '';
      if (input) input.value = '';
      el('apPreviews').innerHTML = '';
      await loadMakeups();
      await loadLeaves();
      await loadAppealRows();
      loadActivity();
    } catch (e) { toastErr(e.message); }
  }

  /** 选择图片后本地预览 */
  function bindAppealFiles() {
    const input = el('apFiles');
    if (!input) return;
    const btn = el('apFilesBtn');
    const hint = el('apFilesHint');
    // 原生 file 控件样式难看且各浏览器不一致：隐藏它，用自定义按钮触发
    if (btn) btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const box = el('apPreviews');
      const all = Array.prototype.slice.call(input.files || []);
      const files = all.slice(0, 3);
      if (all.length > 3) toast('最多 3 张，超出部分已忽略');
      box.innerHTML = '';
      files.forEach(f => {
        const url = URL.createObjectURL(f);
        const img = document.createElement('img');
        img.src = url;
        img.setAttribute('data-full', url);        // 供事件委托识别，点击可放大
        img.alt = f.name || '佐证图片';
        img.title = '点击放大查看';
        box.appendChild(img);
      });
      if (hint) {
        hint.textContent = files.length
          ? `已选择 ${files.length} 张（最多 3 张）`
          : '未选择图片（可选，最多 3 张）';
      }
    });
  }

  /* ---------------- 申诉详情（查看图片 / 继续沟通 / 提出申诉） ---------------- */
  async function openAppealDetail(type, id) {
    let d;
    try { d = await api.get('api/appeal/' + type + '/' + id); }
    catch (e) { return toastErr(e.message); }
    const r = d.request;
    const typeText = type === 'leave' ? '请假' : '补签';
    const statusText = {
      pending: '<span class="badge pending">待初审</span>',
      approved: '<span class="badge signed">已通过</span>',
      rejected: '<span class="badge cancelled">已驳回</span>'
    };

    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.setAttribute('data-modal-kind', 'cancel');
    mask.innerHTML = `<div class="modal">
      <h3>${typeText}申诉详情</h3>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <span class="tag">${escapeHtml(d.activity ? d.activity.title : '-')}</span>
        ${statusText[r.status] || ''}
        ${r.final_status ? '<span class="badge manual">已结案</span>' : ''}
        ${r.appealed ? '<span class="badge warn">普通学生已申诉，待终审</span>' : ''}
      </div>
      <div class="field"><label>我的理由</label><div class="muted">${escapeHtml(r.reason || '-')}</div></div>
      ${r.reply ? `<div class="field"><label>初审留言</label><div class="muted">${escapeHtml(r.reply)}</div></div>` : ''}
      ${r.appeal_reason ? `<div class="field"><label>我的申诉理由</label><div class="muted">${escapeHtml(r.appeal_reason)}</div></div>` : ''}
      ${r.final_reply ? `<div class="field"><label>终审留言</label><div class="muted">${escapeHtml(r.final_reply)}</div></div>` : ''}

      <div class="field"><label>佐证图片</label>
        <div class="att-grid" data-atts>${(attachmentsHtml(d.attachments))}</div>
      </div>
      <div class="field"><label>沟通记录</label>
        <div class="msg-list" data-msgs>${messagesHtml(d.messages)}</div>
      </div>
      <div class="field"><label>继续沟通</label><textarea data-msg rows="2" placeholder="补充说明，管理员会收到提醒"></textarea></div>
      <div class="row end" style="margin-top:10px">
        ${d.can.appeal ? '<button class="btn warn" data-appeal type="button">对结果提出申诉</button>' : ''}
        <button class="btn" data-send type="button">发送</button>
        <button class="btn primary" data-close type="button">关闭</button>
      </div>
    </div>`;
    document.body.appendChild(mask);

    const close = () => mask.remove();
    mask.querySelector('[data-close]').addEventListener('click', close);
    mask.addEventListener('click', e => { if (e.target === mask) close(); });

    mask.querySelector('[data-send]').addEventListener('click', async () => {
      const body = String(mask.querySelector('[data-msg]').value || '').trim();
      if (!body) return toast('请填写内容');
      try {
        const res = await api.post('api/appeal/' + type + '/' + id + '/message', { body });
        mask.querySelector('[data-msgs]').innerHTML = messagesHtml(res.messages || []);
        mask.querySelector('[data-msg]').value = '';
        toast('已发送');
      } catch (e) { toastErr(e.message); }
    });

    const apBtn = mask.querySelector('[data-appeal]');
    if (apBtn) {
      apBtn.addEventListener('click', async () => {
        const reason = await promptText('对结果提出申诉',
          '说明你对初审结果的异议，提交后由小班主任 / 辅导员终审，终审为最终结果。',
          '例如：当天确有到课，附证明材料', true);
        if (!reason) return;
        try {
          const res = await api.post('api/appeal/' + type + '/' + id + '/appeal', { reason });
          toast(res.message || '已提起申诉');
          close();
          await loadAppealRows();
        } catch (e) { toastErr(e.message); }
      });
    }
  }

  function attachmentsHtml(list) {
    if (!list || !list.length) return '<div class="muted" style="font-size:12px">无</div>';
    return list.map(a => {
      const src = url('api/appeal/attachment/' + a.id);
      return `<img src="${src}" data-full="${src}" alt="佐证图片" title="点击放大查看">`;
    }).join('');
  }

  /* ---------------- 图片预览：缩略图点击放大（查看器由 about.js 三端统一注入，此处仅保留 data-full 委托的渲染） ---------------- */
  function messagesHtml(list) {
    if (!list || !list.length) return '<div class="muted" style="font-size:12px">暂无沟通记录</div>';
    return list.map(m => `
      <div class="msg-item">
        <div class="who">${escapeHtml(m.real_name)}（${escapeHtml(m.role_title || '')}）· ${fmtDateTime(m.created_at)}</div>
        <div>${escapeHtml(m.body || '')}</div>
      </div>`).join('');
  }

  async function loadLeaves() {
    try {
      const d = await api.get('api/checkin/leave/my');
      myLeaves = d.requests || [];
    } catch (e) { myLeaves = []; }
  }

  const AP_STATUS = { pending: '待审核', approved: '已通过', rejected: '未通过' };

  async function loadAppealRows() {
    const box = el('appealRows');
    if (!box) return;
    // 统一走申诉接口：一次拿到请假 + 补签，含附件数量与复议状态
    try {
      const d = await api.get('api/appeal/my');
      const rows = d.requests || [];
      box.innerHTML = rows.length ? rows.map(r => {
        const stage = r.status === 'pending'
          ? '<span class="badge pending">待初审</span>'
          : (r.final_status
            ? '<span class="badge signed">已终审</span>'
            : (r.appealed ? '<span class="badge warn">申诉中·待终审</span>' : '<span class="badge">初审已裁决</span>'));
        return `<tr>
          <td><span class="badge ${r._type === 'leave' ? 'leave' : 'manual'}">${r._type === 'leave' ? '请假' : '补签'}</span></td>
          <td>${escapeHtml(r.title || '-')}${r.end_time ? `<div class="muted" style="font-size:12px">${fmtDateTime(r.end_time)} 结束</div>` : ''}</td>
          <td>${escapeHtml(r.reason || '-')}${r.attachments ? `<div class="muted" style="font-size:12px">${r.attachments} 张佐证</div>` : ''}</td>
          <td>${stage}</td>
          <td>${escapeHtml(r.final_reply || r.reply || '-')}</td>
          <td>${fmtDateTime(r.created_at)}</td>
          <td><button class="btn sm" data-detail="${r._type}:${r.id}">详情</button></td>
        </tr>`;
      }).join('') : '<tr><td colspan="8"><div class="empty">暂无申诉记录</div></td></tr>';

      qsa('#appealRows [data-detail]').forEach(b => b.addEventListener('click', () => {
        const v = String(b.getAttribute('data-detail') || '').split(':');
        openAppealDetail(v[0], Number(v[1]));
      }));
    } catch (e) {
      box.innerHTML = `<tr><td colspan="8"><div class="empty">${escapeHtml(e.message)}</div></td></tr>`;
    }
  }

  /* ---------------- 忘记密码（邮箱验证码自助重置） ---------------- */
  function bindForgot() {
    el('gotoForgotBtn').addEventListener('click', () => {
      if (me) {
        el('fgName').value = me.real_name || '';
        el('fgIdentity').value = me.role_title || '普通学生';
        el('fgSid').value = me.student_id || '';
        el('fgEmail').value = me.email || '';
      }
      el('forgotModal').classList.remove('hidden');
    });
    el('fgClose').addEventListener('click', () => el('forgotModal').classList.add('hidden'));
    el('fgSendCode').addEventListener('click', async () => {
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
    el('fgResetBtn').addEventListener('click', async () => {
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
        el('forgotModal').classList.add('hidden');
        goto('login.html');
      } catch (e) { toastErr(e.message); }
    });
  }

  /* ---------------- 当前活动 ---------------- */
  /** 活动配图（支持多张）：按服务端返回的张数逐张渲染，点击可放大 */
  function activityImagesHtml(a) {
    const n = Number(a.image_count) || (a.image_file ? 1 : 0);
    if (!n) return '';
    const items = [];
    for (let i = 0; i < n; i += 1) {
      const src = url('api/activities/' + a.id + '/image/' + i);
      items.push(`<img class="act-thumb" src="${src}" data-full="${src}" alt="活动配图 ${i + 1}" loading="lazy" onerror="this.style.display='none'" title="点击放大查看">`);
    }
    return `<div class="act-thumbs">${items.join('')}</div>`;
  }

  async function loadActivity() {
    const box = el('activityBox');
    try {
      const data = await api.get('api/current');
      // 用户端按本人签到记录决定展示哪个候选：
      //  - open 存在 → 直接展示（最高优先）；
      //  - 否则若有「刚结束的活动」：
      //      · 相邻活动间隔（上一活动结束 end_time → 下一活动开始签到 window.open）< 10 分钟：
      //        上一活动真正结束后直接切下一活动（无论缺勤 / 预留），避免「提前签到却卡在上一活动」的冲突；
      //        注意按【活动结束 end_time】而非【签到结束 window.close】判断，否则 before_start 模式下活动进行中就没占位了。
      //      · 不缺勤者：间隔 ≥ 10 分钟时，活动真正结束（end_time）后才立即切到下一活动，结束前仍展示本活动卡片；
      //      · 缺勤者：间隔 ≥ 10 分钟时，从签到窗口关闭起可见、并预留到活动结束后 10 分钟；
      //  - 再否则展示「下一活动」预告；无候选则空。
      // 区分两种「结束」：
      //  - justEnded 的判定与缺勤判定 → 以【签到结束 = window.close】为口径（错过签到窗口）；
      //  - 而「切下一活动 / 10 分钟预留」的时机 → 以【活动结束 = end_time】为准（活动真正结束后才切 / 再多给 10 分钟）。
      //    故 before_start 模式下，学生可能活动开始前就错过签到窗口，但首页卡片会一直展示到活动结束后（缺勤再多 10 分钟）才切走。
      const RESERVE_MS = 10 * 60000;
      let cand = null;
      if (data.open) {
        cand = data.open;
      } else if (data.justEnded) {
        const a = data.justEnded.activity;
        // 相邻活动间隔（上一活动结束 end_time → 下一活动开始签到 window.open）小于 10 分钟：
        // 直接切到下一活动，无论缺勤 / 预留，避免「提前签到却卡在上一活动」的冲突。
        // 但必须等【上一活动真正结束（end_time）之后】才切——不能按签到窗口关闭（window.close）切，
        // 否则 before_start 模式下活动还在进行（window.close=start_time）就被切走，上一活动没占位。
        if (data.next && (data.next.activity.window.open - a.end_time) < RESERVE_MS && Date.now() >= a.end_time) {
          cand = data.next;
        } else {
          const rec = myRecords.find(r => r.activity_id === a.id);
          const present = !!(rec && (rec.display_status === 'signed' || rec.display_status === 'leave'));
          if (present) {
            // 不缺勤者：活动真正结束（end_time）后才立即切到下一活动；结束前继续展示本活动卡片
            cand = (Date.now() > a.end_time && data.next) ? data.next : data.justEnded;
          } else {
            // 缺勤者：从「签到窗口关闭」起即可见该活动，并一直展示到「活动结束后 10 分钟」
            const afterWindowClosed = Date.now() > a.window.close;        // 错过签到窗口（justEnded 本就满足，保留以明确口径）
            const withinReserve = (Date.now() - a.end_time) <= RESERVE_MS; // 预留计时起点 = 活动结束 end_time
            cand = (afterWindowClosed && withinReserve) ? data.justEnded : (data.next || data.justEnded);
          }
        }
      } else {
        cand = data.next;
      }
      if (!cand) {
        if (displayedActivityId !== null) {
          box.innerHTML = '<div class="empty">暂无活动</div>';
          el('submitChoice').disabled = true;
          setChoicesEnabled(false);
          displayedActivityId = null;
          displayedMineKey = null;
        }
        return;
      }
      const recNow = myRecords.find(r => r.activity_id === cand.activity.id);
      const mineKey = recNow ? (recNow.display_status || recNow.status) : 'none';
      if (cand.activity.id === displayedActivityId && mineKey === displayedMineKey) return; // 同一活动且状态未变，不重渲染，避免闪烁
      displayedActivityId = cand.activity.id;
      displayedMineKey = mineKey;
      currentActivity = cand.activity;
      const a = currentActivity;
      // 单一状态口径（以 phase 为主），去掉原先 phase/state 双标签的冗余
      const phaseText = { upcoming: '预告中', ongoing: '进行中', ended: '已结束' }[cand.phase] || '';
      const phaseCls = cand.phase === 'ongoing' ? 'signed' : (cand.phase === 'ended' ? 'cancelled' : '');
      // 仅展示已设置的说明字段，避免「未设置 / 未启用」噪音
      const infoLines = [
        a.window_text ? `签到窗口：${escapeHtml(a.window_text)}` : '',
        a.policy_text ? `规则：${escapeHtml(a.policy_text)}` : '',
        safePlace(a.location) ? `地点：${escapeHtml(safePlace(a.location))}` : '',
        `活动范围：${a.fence_id ? escapeHtml(a.fence_name || '（范围已删除）') : '未设置'}`
      ].filter(Boolean);
      // 当前活动 + 我的状态合并到一张卡
      const mine = myRecords.find(r => r.activity_id === a.id);
      const mineHtml = mine
        ? `<div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap"><span class="muted">我的状态</span>${checkinBadge(mine.display_status || mine.status)}${
            mine.in_fence === null || mine.in_fence === undefined ? '<span class="badge pending">未采集定位</span>'
              : (mine.in_fence === 1 ? '<span class="badge signed">范围内</span>' : '<span class="badge cancelled">范围外</span>')
          }<span class="muted" style="font-size:12px">${fmtDateTime(mine.created_at)}</span></div>`
        // 活动已结束且本人无签到记录 → 折算为「缺勤」；未结束则中性展示「待签到」
        : '<div class="muted" style="margin-top:8px">我的状态：' + checkinBadge(cand.phase === 'ended' ? 'absent' : 'pending') + '</div>';
      // 活动已结束且没有有效记录 → 可申请补签（申诉）
      let makeupHtml = '';
      if (cand.phase === 'ended' && !(mine && (mine.status === 'signed' || mine.status === 'leave'))) {
        const req = myMakeups.find(m => m.activity_id === a.id);
        if (req) {
          const t = { pending: '待审核', approved: '已通过', rejected: '未通过' }[req.status] || req.status;
          makeupHtml = `<div class="alert ${req.status === 'rejected' ? 'warn' : 'info'}" style="margin-top:10px">补签申请：<b>${t}</b>${
            req.reply ? `（审核留言：${escapeHtml(req.reply)}）` : ''}</div>`;
        } else if (data.allow_makeup) {
          makeupHtml = `<div class="row" style="margin-top:10px;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn" id="goAppealBtn" type="button">申诉（补签 / 事后请假）</button>
            <span class="muted" style="font-size:12px">缺勤或未签到可前往申诉页提交</span>
          </div>`;
        }
      }
      box.innerHTML = `
        <h3 style="margin-bottom:6px">${escapeHtml(a.title)}</h3>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
          <span class="badge ${phaseCls}">${phaseText}</span>
          <span class="tag muted">${fmtSpan(a.start_time, a.end_time)}</span>
        </div>
        ${infoLines.length ? `<div class="muted" style="margin-top:8px;line-height:1.9">${infoLines.join('<br>')}</div>` : ''}
        ${activityImagesHtml(a)}
        ${a.remark ? `<div class="muted" style="margin-top:8px">备注：${escapeHtml(a.remark)}</div>` : ''}
        ${mineHtml}
        ${makeupHtml}
        <div class="row" style="gap:8px;margin-top:10px"><button class="btn sm" onclick="openActivityDetail(${a.id})">活动详情</button></div>
      `;
      const canSign = cand.state === 'open';
      // 已签到为终态：普通学生不可自行取消 / 修改
      const alreadySigned = !!(mine && mine.status === 'signed');
      el('submitChoice').disabled = !canSign || alreadySigned;
      setChoicesEnabled(canSign && !alreadySigned);
      if (alreadySigned) {
        disabledChoiceHint = '你已完成签到，不能自行取消或修改；如需更正请联系管理员';
        box.insertAdjacentHTML('beforeend',
          '<div class="alert info" style="margin-top:10px">你已完成签到，签到后不能自行取消或修改；如需更正请联系管理员。</div>');
      } else if (!canSign) {
        disabledChoiceHint = cand.phase === 'ended'
          ? '该活动已结束，无法再提交'
          : (cand.phase === 'upcoming' ? '活动尚未开始，签到窗口开放后可提交' : '当前不在可签到时间窗口内');
        box.insertAdjacentHTML('beforeend', `<div class="alert warn" style="margin-top:10px">${disabledChoiceHint}</div>`);
      } else {
        disabledChoiceHint = '';
      }
      const gaBtn = el('goAppealBtn');
      if (gaBtn) gaBtn.addEventListener('click', () => goAppealFor(a, 'makeup'));
    } catch (e) {
      box.innerHTML = '<div class="empty">加载失败，请稍后重试</div>';
      toastErr(e.message);
    }
  }

  /** 未开始（预告）/ 已结束时把三态选择置灰、不可点 */
  function setChoicesEnabled(enabled) {
    qsa('.choice').forEach(c => c.classList.toggle('disabled', !enabled));
  }

  /** 我的补签申请 */
  async function loadMakeups() {
    try {
      const d = await api.get('api/checkin/makeup/my');
      myMakeups = d.requests || [];
    } catch (e) { myMakeups = []; }
  }

  /* ---------------- 三态选择 ---------------- */
  qsa('.choice').forEach(c => {
    c.addEventListener('click', () => {
      if (c.classList.contains('disabled')) return toast(disabledChoiceHint || '当前操作不可用');
      qsa('.choice').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      selectedChoice = c.getAttribute('data-choice');
      el('reasonField').classList.toggle('hidden', selectedChoice !== 'leave');
      el('submitChoice').disabled = false;
    });
  });

  el('submitChoice').addEventListener('click', async () => {
    if (!selectedChoice) return toast('请先选择：签到 / 在途中 / 请假');
    if (!currentActivity) return toast('暂无可签到的活动');

    // 已签到为终态：不可自行取消 / 修改
    const mineNow = myRecords.find(r => r.activity_id === currentActivity.id);
    if (mineNow && mineNow.status === 'signed') {
      return toast('你已完成签到，不能自行取消或修改；如需更正请联系管理员');
    }

    const btn = el('submitChoice');
    btn.disabled = true;

    // 是否上传定位由本人「自愿授权」决定（授权状态属个人隐私，不进数据流）：
    //  · 总开关开启 + 本人已授权 → 采集并上传定位（无论活动是否绑定活动范围）；
    //    未绑活动范围时仅记录坐标、不做范围判定，绑定了则额外做范围判定（均仅供参考，不阻断签到）
    //  · 未授权 / 总开关关闭 → 不采集位置，但仍可正常签到（活动范围不再阻断签到）
    const locRelevant = sysPublic.location_verify_enabled;
    if (locRelevant && locConsent === null) {
      const granted = await askLocConsent();
      locConsent = granted ? 1 : 0;
      try { await api.post('api/auth/me/loc-consent', { consent: locConsent }); } catch (e) { /* 忽略 */ }
      if (window.AccountInfo) AccountInfo.setLocConsentValue(locConsent);
      renderLocHint();
    }

    // 说明：是否上传定位由本人自愿决定，【不作为状态变更的前提条件】——
    // 请假不需要授权定位；签到/在途中之间互改也不因未授权而被阻断。
    const needLoc = locRelevant && locConsent === 1 && selectedChoice !== 'leave';
    let loc = { lat: null, lng: null, accuracy: null };
    if (needLoc) {
      el('locTag').textContent = '获取定位中…';
      try {
        loc = await getLocation();
        lastLoc = loc;
        const acc = Math.round(loc.accuracy || 0);
        el('locTag').textContent = `±${acc}m` + (currentActivity.fence_id ? ' · 范围仅供参考' : '');
        if (acc > 200) toast(`定位精度较低（±${acc} 米），建议到开阔处重试`);
      } catch (e) {
        // 定位失败 / 用户拒绝授权：绝不阻断签到，按「未采集定位」提交（范围判定仅供参考）
        el('locTag').textContent = '定位失败（不影响签到）';
        toast(e.message + '；将按未采集定位提交');
        loc = { lat: null, lng: null, accuracy: null };
      }
    } else {
      // 不上传定位：理由只可能是「总开关关闭」或「本人未授权」
      el('locTag').textContent = !locRelevant ? '定位已关闭' : '未授权定位';
    }

    try {
      const res = await api.post('api/checkin', {
        activity_id: currentActivity.id,
        choice: selectedChoice,
        lat: loc.lat,
        lng: loc.lng,
        accuracy: loc.accuracy,
        device_id: deviceKey(),
        reason: el('reason').value.trim()
      });
      if (typeof res.distance === 'number') {
        // distance = -1 表示「无活动范围」或「未采集定位」，避免向前端展示 -1
        el('locTag').textContent = res.distance >= 0
          ? `距范围 ${res.distance}m`
          : (loc.lat == null ? '未采集定位' : '无活动范围');
      }
      toast(res.message || '提交成功');
      await loadRecords();
      await loadActivity();
      loadMyStream();
    } catch (err) {
      toastErr(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  el('refreshBtn').addEventListener('click', loadActivity);

  /* ---------------- 记录与日历 ---------------- */
  /* ---------------- 活动列表（用户端，与管理端/运维端树形结构一致） ---------------- */
  let userActs = [];
  let userActFilter = 'upcoming';
  const userActExpanded = new Set();
  let userActPage = 1;
  let userActPageSize = 10;
  async function loadUserActivities() {
    try {
      const d = await api.get('api/activities');
      userActs = d.activities || [];
      renderUserActList();
    } catch (e) {
      el('userActList').innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
    }
  }
  function userActEnd(a) {
    if (a.is_group) {
      const kids = userActs.filter(k => k.parent_id === a.id);
      if (!kids.length) return 0;
      return Math.max(...kids.map(k => k.end_time || 0));
    }
    return a.end_time || 0;
  }
  function userPhaseBadge(a) {
    const now = Date.now();
    const end = userActEnd(a);
    if (now > end && end > 0) return '<span class="badge cancelled" title="活动阶段">已结束</span>';
    if (now >= (a.start_time || 0) && now <= end) return '<span class="badge signed" title="活动阶段">进行中</span>';
    return '<span class="badge pending" title="活动阶段">待开展</span>';
  }
  function fmtUserRange(s, e) {
    if (!s) return '-';
    const p = n => String(n).padStart(2, '0');
    const f = t => { const d = new Date(t); return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
    return f(s) + ' ~ ' + (e ? f(e) : '?');
  }
  function renderUserActList() {
    const now = Date.now();
    // 构建顶层节点（排除子活动）
    let tops = userActs.filter(a => !a.parent_id);
    // 筛选：临时活动直接判断；长期活动父级只要任一子活动满足条件即保留
    if (userActFilter !== 'all') {
      tops = tops.filter(a => {
        if (a.is_group) {
          const kids = userActs.filter(k => k.parent_id === a.id);
          if (!kids.length) return false;
          return kids.some(k => userActFilter === 'history' ? (k.end_time || 0) < now : (k.end_time || 0) >= now);
        }
        return userActFilter === 'history' ? ((a.end_time || 0) < now) : ((a.end_time || 0) >= now);
      });
    }
    tops.sort((x, y) => (x.start_time || 0) - (y.start_time || 0));
    // 构建树形行序列
    const rows = [];
    tops.forEach(a => {
      const kids = a.is_group ? userActs.filter(k => k.parent_id === a.id).sort((x, y) => (x.start_time || 0) - (y.start_time || 0)) : [];
      // 筛选子活动
      let shownKids = kids;
      if (userActFilter !== 'all') {
        shownKids = kids.filter(k => userActFilter === 'history' ? (k.end_time || 0) < now : (k.end_time || 0) >= now);
      }
      const expanded = userActExpanded.has(a.id);
      rows.push({ act: a, kind: a.is_group ? 'main' : 'once', children: kids.length, shownCount: shownKids.length });
      if (a.is_group && expanded) {
        shownKids.forEach(k => rows.push({ act: k, kind: 'child', children: 0, shownCount: 0 }));
      }
    });
    // 统计口径：子活动 + 临时活动（排除长期活动父级）
    const countable = userActs.filter(a => !a.is_group);
    const _now2 = Date.now();
    const _up = countable.filter(a => (a.end_time || 0) >= _now2).length;
    const _hi = countable.length - _up;
    const countHtml = '';
    // 分页
    const totalRows = rows.length;
    const pages = Math.max(1, Math.ceil(totalRows / userActPageSize));
    if (userActPage > pages) userActPage = pages;
    const pageStart = (userActPage - 1) * userActPageSize;
    const pageRows = rows.slice(pageStart, pageStart + userActPageSize);
    // 续表：本页首行若是子活动，标注「续」
    if (pageRows.length && pageRows[0].kind === 'child') pageRows[0].cont = true;
    // 分页控件显隐与信息
    const pager = el('userActPager');
    if (pager) pager.style.display = '';
    const pInfo = el('userActPageInfo');
    if (pInfo) {
      pInfo.textContent = '待开展 ' + _up + ' / 已结束 ' + _hi + ' / 全部 ' + countable.length;
    }
    const pInput = el('userActPageInput');
    const pTotal = el('userActTotalPages');
    if (pInput) { pInput.value = userActPage; pInput.max = pages; }
    if (pTotal) pTotal.textContent = pages;
    if (el('userActPrev')) el('userActPrev').disabled = userActPage <= 1;
    if (el('userActNext')) el('userActNext').disabled = userActPage >= pages;

    if (!pageRows.length) {
      el('userActList').innerHTML = countHtml + '<div class="empty">暂无活动</div>';
      return;
    }
    el('userActList').innerHTML = countHtml + '<div class="table-wrap"><table><thead><tr><th class="act-caret-col" aria-hidden="true"></th><th>活动</th><th>活动时间段</th><th>签到时间段</th><th>状态</th><th>规则</th><th>活动范围</th><th>类型</th><th>创建信息</th><th>操作</th></tr></thead><tbody>' +
      pageRows.map(r => {
        const a = r.act;
        const isMain = r.kind === 'main';
        const isChild = r.kind === 'child';
        const indent = isChild ? 'padding-left:26px;' : '';
        const expanded = userActExpanded.has(a.id);
        const caret = isMain
          ? (r.children
            ? '<button type="button" class="tree-toggle' + (expanded ? ' open' : '') + '" data-ufold="' + a.id + '" aria-expanded="' + expanded + '" title="' + (expanded ? '收起活动' : '展开活动') + '">' + (expanded ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:2px"><polyline points="6 9 12 15 18 9"/></svg> 收起' : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:2px"><polyline points="9 6 15 12 9 18"/></svg> 展开') + '</button> '
            : '<span class="tree-caret leaf">•</span> ')
          : (isChild ? '<span class="tree-caret leaf">└</span>' : '<span class="tree-caret leaf">•</span>');
        const name = '<div class="act-title-line"><span class="act-name">' + escapeHtml(a.title) + '</span></div>' +
          (safePlace(a.location) ? '<div class="muted" style="font-size:12px;margin-top:3px">📍 ' + escapeHtml(safePlace(a.location)) + '</div>' : '') +
          (a.remark ? '<div class="muted" style="font-size:12px;margin-top:2px">' + escapeHtml(a.remark) + '</div>' : '');
        const type = isMain
          ? '<span class="badge manual" title="长期活动">长期</span>' + (r.children ? '<span class="tag">' + r.children + ' 子活动</span>' : '')
          : (isChild ? '<span class="badge" title="长期活动下的活动">子活动</span>' + (r.cont ? '<span class="tag" title="接上一页的同一长期活动">续</span>' : '') : '<span class="badge">临时</span>');
        const phase = userPhaseBadge(a);
        const time = isMain
          ? (r.children ? fmtUserRange(a.start_time, userActEnd(a)) : '未排期')
          : fmtUserRange(a.start_time, a.end_time);
        return '<tr class="' + (isMain ? 'tree-main' : (isChild ? 'tree-child' : '')) + '">' +
          '<td>' + caret + '</td>' +
          '<td style="' + indent + '">' + name + '</td>' +
          '<td>' + time + '</td>' +
          '<td>' + escapeHtml(a.window_text || '') + '</td>' +
          '<td>' + phase + '</td>' +
          '<td>' + escapeHtml(a.policy_text || '') + '</td>' +
          '<td>' + (a.fence_id ? escapeHtml(a.fence_name || '-') : '未设置') + '</td>' +
          '<td>' + type + '</td>' +
          '<td>' + objMetaHtml(a.created_at, a.creator_name, a.creator_role) + '</td>' +
          '<td><button class="btn sm" onclick="openActivityDetail(' + a.id + ')">详情</button></td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';
    // 绑定展开/收起
    qsa('#userActList [data-ufold]').forEach(b => b.addEventListener('click', () => {
      const id = Number(b.getAttribute('data-ufold'));
      if (userActExpanded.has(id)) userActExpanded.delete(id); else userActExpanded.add(id);
      renderUserActList();
    }));
  }
  // Tab 切换（移至 init() 内确保 DOM 就绪）

  /* ---------------- 签到记录翻页 ---------------- */
  let recPage = 1;
  let recPageSize = 10;
  function renderRecordRows() {
    const total = myRecords.length;
    const pages = Math.max(1, Math.ceil(total / recPageSize));
    if (recPage > pages) recPage = pages;
    const start = (recPage - 1) * recPageSize;
    const rows = myRecords.slice(start, start + recPageSize);
    const info = el('recPageInfo');
    if (info) info.textContent = '共 ' + total + ' 项 · 第 ' + recPage + '/' + pages + ' 页';
    const pInput = el('recPageInput');
    const pTotal = el('recTotalPages');
    if (pInput) { pInput.value = recPage; pInput.max = pages; }
    if (pTotal) pTotal.textContent = pages;
    if (el('recPrev')) el('recPrev').disabled = recPage <= 1;
    if (el('recNext')) el('recNext').disabled = recPage >= pages;
    el('recordRows').innerHTML = rows.length ? rows.map(r =>
      '<tr>' +
      '<td>' + escapeHtml(r.title) + '</td>' +
      '<td>' + fmtDateTime(r.start_time) + '</td>' +
      '<td>' + checkinBadge(r.display_status || r.status) + '</td>' +
      '<td>' + (r.in_fence === null || r.in_fence === undefined ? '<span class="badge pending">未采集定位</span>' : (r.in_fence ? '<span class="badge signed">范围内</span>' : '<span class="badge cancelled">范围外</span>')) + '</td>' +
      '<td>' + (r.manual ? '<span class="badge manual">管理员操作</span>' : '-') + '</td>' +
      '<td>' + fmtDateTime(r.created_at) + '</td>' +
      '</tr>'
    ).join('') : '<tr><td colspan="10"><div class="empty">暂无记录</div></td></tr>';
  }
  // 翻页控件绑定（移至 init() 内确保 DOM 就绪）

  async function loadRecords() {
    try {
      const data = await api.get('api/checkin/my');
      const rows = data.records || [];
      myRecords = rows;
      renderRecordRows();
    } catch (e) {
      el('recordRows').innerHTML = `<tr><td colspan="6"><div class="empty">${escapeHtml(e.message)}</div></td></tr>`;
    }

    const month = el('calMonth').value || currentMonth();
    try {
      const cal = await api.get('api/calendar/my?month=' + month);
      renderCalendar(el('myCalendar'), cal.month, cal.days, el('myCalendarDetail'));
      const s = cal.summary || {};
      el('mySummary').innerHTML = `
        <span class="tag">出勤率 ${cal.attendance_rate}%</span>`;
    } catch (e) { /* 忽略 */ }
  }

  el('calMonth').value = currentMonth();
  el('calMonth').addEventListener('change', loadRecords);


  /* ---------------- 我的数据流（普通用户仅本人） ---------------- */
  let myStreamEvents = [];
  /** 事件 id → 事件对象：分页后渲染行的索引不再对应全量数组下标，改用 id 做详情定位 */
  let myStreamMap = new Map();
  let myStreamPage = 1;
  let myStreamPageSize = 15;
  async function loadMyStream() {
    try {
      const d = await api.get('api/stream?limit=500');
      const rows = d.events || [];
      myStreamEvents = rows;
      myStreamMap = new Map(rows.map(r => [r.id, r]));
      myStreamPage = 1;
      renderMyStream();
    } catch (e) { /* 忽略 */ }
  }

  /* 分页渲染：与管理端数据流一致（每页大小 / 上 / 下页 / 页码信息） */
  function renderMyStream() {
    const total = myStreamEvents.length;
    const all = !(myStreamPageSize > 0);
    const per = all ? Math.max(1, total) : myStreamPageSize;
    const pages = Math.max(1, Math.ceil(total / per));
    if (myStreamPage > pages) myStreamPage = pages;
    const s = (myStreamPage - 1) * per;
    const rows = myStreamEvents.slice(s, s + per);

    const box = el('myStreamRows');
    box.innerHTML = rows.length ? rows.map(e => `
        <tr>
          <td>${fmtDateTime(e.created_at)}</td>
          <td><span class="tag ev-${eventCat(e.type)}">${escapeHtml(safeTypeText(e.type_text, e.type))}</span></td>
          <td>${escapeHtml(e.text || eventContent(e))}</td>
          <td><button class="btn sm" data-stream-detail="${e.id}">详情</button></td>
        </tr>
        <tr class="df-inline-detail" id="usd-${e.id}" style="display:none"><td colspan="4"><div class="empty">加载中…</div></td></tr>`).join('')
      : '<tr><td colspan="4"><div class="empty">暂无数据</div></td></tr>';

    const info = el('myStreamPageInfo');
    const msi = el('myStreamPageInput'); const mtp = el('myStreamTotalPages');
    if (msi) { msi.value = myStreamPage; msi.max = pages; }
    if (mtp) mtp.textContent = pages;
  }

  const msPageSize = el('myStreamPageSize');
  if (msPageSize) msPageSize.addEventListener('change', () => {
    const v = Number(msPageSize.value);
    myStreamPageSize = v === 0 ? (myStreamEvents.length || 1) : v;
    myStreamPage = 1; renderMyStream();
  });
  el('myStreamPrev').addEventListener('click', () => { if (myStreamPage > 1) { myStreamPage--; renderMyStream(); } });
  el('myStreamNext').addEventListener('click', () => { myStreamPage++; renderMyStream(); });
  if (el('myStreamPageInput')) el('myStreamPageInput').addEventListener('change', () => {
    let v = parseInt(el('myStreamPageInput').value, 10) || 1;
    const max = parseInt(el('myStreamPageInput').max, 10) || 1;
    if (v < 1) v = 1; if (v > max) v = max;
    el('myStreamPageInput').value = v; myStreamPage = v; renderMyStream();
  });

  /* 行内展开「操作记录详情」：与管理端 / 运维端一致（同一套 .df-inline-detail 行 + 公共详情表格），
     不再额外弹窗。学生无「查看数据流」权限，详情直接用列表里已有的事件数据渲染，不请求 api/dataflow/:id。 */
  const ustreamRows = el('myStreamRows');
  if (ustreamRows && !ustreamRows.dataset.detailBound) {
    ustreamRows.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-stream-detail]');
      if (!b) return;
      const e = myStreamMap.get(Number(b.getAttribute('data-stream-detail')));
      const tr = e ? document.getElementById('usd-' + e.id) : null;
      if (!tr) return;
      if (tr.style.display === 'none') {
        if (!tr.dataset.loaded) {
          tr.querySelector('td').innerHTML = streamDetailHtml(e);
          tr.dataset.loaded = '1';
        }
        tr.style.display = '';
        b.textContent = '收起';
      } else { tr.style.display = 'none'; b.textContent = '详情'; }
    });
    ustreamRows.dataset.detailBound = '1';
  }
  el('reloadMyStream').addEventListener('click', loadMyStream);

  /* 账号信息分区（基本信息 / 账号安全 / 定位上传授权 / 通知偏好）
     统一由 account-info.js 渲染，以下不再重复实现。 */

  el('logoutBtn').addEventListener('click', async () => {
    const yes = await confirmDialog(
      '退出登录',
      '确认退出登录吗？本机记住的账号与密码会保留，方便下次一键登录。',
      '退出登录'
    );
    if (!yes) return;
    await logout();
  });

  /* ---------------- 活动范围 / 实时定位查看 ---------------- */
  let userFenceEditor = null;
  let uLayerSat = false;        // 当前底图是否为卫星（持久状态）
  let userLayerToggle = null;   // 底图切换组件（bindLayerToggle）
  let lastLoc = null;
  let uWatchId = null;       // navigator.geolocation.watchPosition 的监听句柄
  let uTracking = false;     // 是否正在连续定位
  let uFollow = true;        // 镜头是否跟随我的位置（关掉后可自由拖动查看）
  let uBaseState = '';       // 状态行基础文案（范围 / 目的地），定位状态在其后追加，避免残留拼接

  async function openFenceModal() {
    const modal = el('fenceModal');
    modal.classList.remove('hidden');
    if (!userFenceEditor) userFenceEditor = new FenceEditor({ mapId: 'userFenceMap' });
    userFenceEditor.invalidate();
    // 沿用上次选择的底图（卫星 / 电子），并同步按钮状态
    if (userLayerToggle) userLayerToggle.set(uLayerSat);
    const a = currentActivity;
    const fences = (a && a.fence && a.fence.polygons && a.fence.polygons.length) ? [a.fence] : [];
    userFenceEditor.renderFences(fences);
    userFenceEditor.clearLocation();      // 清掉上一次留下的定位点，避免误认为本次定位

    // 目的地（终点）标记
    const hasDest = !!(a && a.dest_lng != null && a.dest_lat != null);
    userFenceEditor.clearDestination();
    if (hasDest) userFenceEditor.showDestination({ lat: a.dest_lat, lng: a.dest_lng }, '目的地（终点）');

    if (fences.length) {
      const c = fences[0].polygons[0][0];
      userFenceEditor.map.setView([c[1], c[0]], 17);
    } else if (hasDest) {
      userFenceEditor.map.setView([a.dest_lat, a.dest_lng], 17);
    } else if (lastLoc) {
      // 既无活动范围也无目的地：镜头落到上次已知位置，避免停在默认坐标
      const p = displayLatLng(lastLoc);
      userFenceEditor.map.setView([p.lat, p.lng], 17);
    }

    // 空状态提示：首页没有活动（或活动未设置活动范围）时，地图上不画任何范围，用文字说明理由
    const tip = el('uFenceTip');
    let tipText = '';
    if (!a) tipText = '首页当前没有活动，地图上暂无活动范围可显示。你仍可查看自己的实时位置（纯本地展示，不上传）。';
    else if (!fences.length) tipText = `当前活动「${a.title}」未设置活动范围，地图上暂无范围可显示${hasDest ? '，仅标出目的地' : ''}。`;
    if (tip) {
      tip.textContent = tipText;
      tip.classList.toggle('hidden', !tipText);
    }

    const parts = [];
    if (!a) parts.push('暂无活动，未显示活动范围');
    else if (fences.length) parts.push('已显示活动范围');
    else parts.push('该活动未设置活动范围');
    if (hasDest) parts.push('已标出目的地（📍）');
    uBaseState = parts.join('；');
    el('uLocState').textContent = uBaseState;
    // 打开地图即自动开始「连续实时定位」：纯本地展示，不上传、不需要授权、也不受定位核验总开关限制
    startTrack();
  }

  /** 开始连续实时定位：用 watchPosition 持续把「我的位置」刷新到地图（仅本地显示，不上传） */
  function startTrack() {
    if (uTracking) return;
    const blocked = geoUnavailableReason();
    if (blocked) {
      el('uLocState').textContent = (uBaseState ? uBaseState + '；' : '') + blocked;
      toastErr(blocked);
      return;
    }
    uTracking = true;
    const b = el('uTrackBtn');
    if (b) { b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="vertical-align:-2px;margin-right:4px"><rect x="5" y="5" width="14" height="14" rx="2"/></svg> 停止连续定位'; b.classList.add('tracking'); }
    el('uLocState').textContent = (uBaseState ? uBaseState + '；' : '') + '正在持续获取你的位置…';
    uWatchId = navigator.geolocation.watchPosition(
      pos => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        lastLoc = loc;
        const acc = Math.round(loc.accuracy || 0);
        const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        el('uLocState').textContent = `实时定位中（精度 ±${acc} 米，更新于 ${t}）`;
        if (userFenceEditor) userFenceEditor.showLocation(displayLatLng(loc), '我的位置', uFollow, acc);
      },
      err => {
        const map = { 1: '定位权限被拒绝，请在浏览器中允许定位', 2: '暂时无法获取位置', 3: '获取定位超时' };
        el('uLocState').textContent = map[err.code] || '定位失败';
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  }

  /** 停止连续定位，释放浏览器定位监听（避免耗电 / 不必要后台定位） */
  function stopTrack() {
    if (uWatchId != null) { try { navigator.geolocation.clearWatch(uWatchId); } catch (e) { /* 忽略 */ } uWatchId = null; }
    uTracking = false;
    const b = el('uTrackBtn');
    if (b) { b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> 开始连续定位'; b.classList.remove('tracking'); }
    el('uLocState').textContent = uBaseState || '';
  }

  /** 浏览器定位（WGS-84）→ 高德底图（GCJ-02），仅用于地图显示 */
  function displayLatLng(loc) {
    const [lng, lat] = wgs84ToGcj02(loc.lng, loc.lat);
    return { lat, lng };
  }

  el('viewFenceBtn').addEventListener('click', openFenceModal);
  // fenceModal 的关闭由 theme.js 统一处理（右上角 X / 点击遮罩），此处仅补充关闭时停止追踪
  const fenceMask = el('fenceModal');
  if (fenceMask) {
    new MutationObserver(() => {
      if (fenceMask.classList.contains('hidden')) stopTrack();
    }).observe(fenceMask, { attributes: true, attributeFilter: ['class'] });
  }
  userLayerToggle = bindLayerToggle(el('uLayerBtn'), {
    get: () => uLayerSat,
    set: (sat) => { uLayerSat = sat; if (userFenceEditor) userFenceEditor.setLayer(sat ? 'satellite' : 'street'); }
  });
  el('uTrackBtn').addEventListener('click', () => { if (uTracking) stopTrack(); else startTrack(); });
  // 镜头跟随 toggle 按钮组
  (function () {
    var wrap = el('uFollowBtn');
    if (!wrap) return;
    function syncUI() {
      wrap.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-v') === (uFollow ? 'on' : 'off'));
      });
    }
    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-v]');
      if (!btn) return;
      var val = btn.getAttribute('data-v');
      uFollow = val === 'on';
      syncUI();
      if (uFollow && lastLoc && userFenceEditor) userFenceEditor.showLocation(displayLatLng(lastLoc), '我的位置', true, lastLoc.accuracy);
    });
    syncUI();
  })();
  // 说明：地图上显示自己的位置属纯本地展示——不上传、不需要授权、也不受定位核验总开关限制；
  // 打开地图即自动开始连续定位，关闭地图即停止（释放 watchPosition 监听，避免耗电）；
  // 查看他人签到定位仍需管理端相应权限与总开关。

  /* ---------------- 设备与分区联动 ---------------- */
  window.onSectionChange = function (name) {
    if (name === 'devices') loadDevices();
    if (name === 'appeal') { fillAppealActivities(); loadAppealRows(); }
    if (name === 'checkin') { renderLocHint(); }
    if (name === 'activities') loadUserActivities();
    if (name === 'stats') loadRecords();
    if (name === 'records') loadRecords();
    if (name === 'dataflow') loadMyStream();
    if (name === 'accountinfo') { if (window.AccountInfo) AccountInfo.renderLocConsent(); }
  };
  async function loadDevices() {
    try {
      const d = await api.get('api/sessions');
      renderDevices(d.sessions || []);
    } catch (e) { toastErr(e.message); }
  }
  function renderDevices(list) {
    // 前端过滤：超过 7 天且离线的设备记录不在列表中显示（服务端数据保留）
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    list = list.filter(s => s.online || (now - Number(s.last_seen)) < SEVEN_DAYS);
    el('deviceRows').innerHTML = list.length ? list.map(s => `
      <tr>
        <td>${escapeHtml(s.device_name || '未知设备')}${s.current ? ' <span class="badge signed">当前</span>' : ''}</td>
        <td>${s.device_type === 'mobile' ? '手机 / 平板' : '电脑'}</td>
        <td>${s.online ? '<span class="badge signed">在线</span>' : '<span class="badge cancelled">离线</span>'}</td>
        <td>${fmtDateTime(s.last_seen)}</td>
        <td>${(s.online && !s.current) ? `<button class="btn sm danger" data-kick="${escapeHtml(s.id)}">下线这台</button>` : '-'}</td>
      </tr>`).join('') : '<tr><td colspan="5"><div class="empty">暂无设备记录</div></td></tr>';
    // 按 session_id 精确结束某台设备，多设备（一手机 + 一电脑）之间互不串号
    qsa('#deviceRows [data-kick]').forEach(b => b.addEventListener('click', async () => {
      if (!await confirmBox('确认将这台设备下线？只有该设备需要重新登录，其它设备不受影响')) return;
      try {
        const r = await api.post('api/sessions/' + b.getAttribute('data-kick') + '/end', { reason: '用户手动下线' });
        toast(r.message || '已下线');
        loadDevices();
      } catch (e) { toastErr(e.message); }
    }));
  }
  el('reloadDevices').addEventListener('click', loadDevices);

  el('switchAccountBtn').addEventListener('click', async () => {
    const yes = await confirmDialog('切换账号', '切换账号会退出当前登录并回到登录页，可一键选择本机的其他账号。是否继续？', '切换账号');
    if (!yes) return;
    await switchAccount();
  });

  initToggles();
  init();
})();
