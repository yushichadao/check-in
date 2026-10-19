(function () {
  let me = null;

  async function init() {
    let data;
    try {
      data = await api.get('api/auth/me');
      me = data.user;
      if (me.role !== 'ops') { goto(data.redirect); return; }
    } catch (e) {
      goto('login.html');
      return;
    }
    if (window.PermGate) PermGate.init(data.perm || {});
    el('whoBar').innerHTML = `${escapeHtml(me.real_name)}<small>运维端 · 最高权限</small>`;
    if (el('switchAccountBtn') && !hasSwitchableAccounts()) el('switchAccountBtn').classList.add('hidden');
    if (me.must_change_pwd) {
      el('devAlert').innerHTML = '<div class="alert warn">当前为初始密码，请尽快在「账号信息」中修改密码。</div>';
    }
    // 账号信息分区（基本信息 / 账号安全 / 通知偏好）统一由 account-info.js 渲染（开发端本人不签到，无定位授权）
    if (window.AccountInfo) AccountInfo.init({ me });
    // 并行加载：公开设置 + 统计数据
    const [pub] = await Promise.all([
      api.get('api/settings/public').catch(() => ({})),
      loadStats()
    ]);
    document.body.classList.toggle('loc-disabled', !pub.location_verify_enabled);
    initSections('dashboard');
    loadDfSettings();
    loadMlv();
    loadLv();
    loadAutoCover();
    loadAnnouncement();
  }

  /* ---------------- 概览 ---------------- */
  async function loadStats() {
    try {
      const s = await api.get('api/stream/stats');
      const c = s.counts;
      el('dStats').innerHTML = `
        <div class="stat accent"><div class="num">${c.users}</div><div class="label">账号总数</div><div class="sub">管理端 + 用户端</div></div>
        <div class="stat ok"><div class="num">${c.normal_users}</div><div class="label">用户端账号</div><div class="sub">在册普通学生</div></div>
        <div class="stat"><div class="num">${c.managers}</div><div class="label">管理端账号</div><div class="sub">班委及以上 · 在册在岗</div></div>
        <div class="stat"><div class="num">${c.ops_users || 0}</div><div class="label">运维端账号</div><div class="sub">运维者 · 独立角色</div></div>
        <div class="stat warn"><div class="num">${c.unactivated_users || 0}</div><div class="label">未激活账号</div><div class="sub">已建档 · 未设置密码</div></div>
        <div class="stat"><div class="num">${c.cancelled_users || 0}</div><div class="label">已注销账号</div><div class="sub">已注销归档 · 不计入总数</div></div>
        <div class="stat ok"><div class="num">${c.signed}</div><div class="label">签到人次</div></div>
        <div class="stat warn"><div class="num">${c.manual}</div><div class="label">管理员操作</div></div>
      `;
      const todos = [];
      if (c.pending_resets) todos.push(`待处理密码清除申请：${c.pending_resets} 条`);
      if (c.pending_leaves) todos.push(`待审核请假：${c.pending_leaves} 条`);
      el('dState').innerHTML = todos.length
        ? todos.map(t => `<div class="alert warn">${escapeHtml(t)}</div>`).join('')
        : '<div class="empty">暂无待办事项</div>';
    } catch (e) { /* 忽略 */ }
    loadToday();
  }

  /** 今日活动（具体子活动与签到情况） */
  async function loadToday() {
    const today = fmtDate(Date.now());
    try {
      const d = await api.get('api/calendar/class?month=' + currentMonth());
      const items = (d.days && d.days[today]) || [];
      el('dToday').innerHTML = items.length
        ? items.map(it => {
            // 活动结束后：「在途中」「待签到」已折算为「缺勤」，不再展示这两个标签
            const ended = it.end_time && Date.now() > it.end_time;
            const tw = ended ? '' : `<span class="badge ontheway">途中 ${it.counts.ontheway}</span>`;
            const pd = ended ? '' : `<span class="badge pending">待签到 ${it.counts.pending || 0}</span>`;
            return `
          <div class="item">
            <b>${escapeHtml(it.title || it.parent_title || '未命名活动')}</b>
            ${it.is_recurring_child ? '<span class="tag long">长期</span>' : ''}
            <span class="tag">${fmtSpan(it.start_time, it.end_time)}</span>
            <div class="row roster-summary" style="flex-basis:100%;margin-top:6px">
              <span class="tag">共 ${it.counts.total} 人</span>
              <span class="badge signed">签到 ${it.counts.signed}</span>
              ${tw}
              <span class="badge leave">请假 ${it.counts.leave}</span>
              <span class="badge absent">缺勤 ${it.counts.absent}</span>
              ${pd}
            </div>
          </div>`;
          }).join('')
        : '<div class="empty">今日暂无活动</div>';
    } catch (e) { /* 忽略 */ }
  }
  el('reloadToday').addEventListener('click', loadToday);

  /* ---------------- 账号列表（管理端 / 用户端 合并，带类型筛选） ---------------- */
  let mgrList = [];
  let userList = [];
  let accAll = [];

  function accStateBadge(u) {
    return u.account_state === 'cancelled'
      ? '<span class="badge sys">已注销</span>'
      : (u.account_state === 'unactivated'
          ? '<span class="badge cancelled">未激活</span>'
          : '<span class="badge signed">正常</span>');
  }
  function accLoginBadge(u) {
    const loginMap = { online: '在线', offline: '离线', loggedout: '未登录' };
    const loginCls = { online: 'signed', offline: 'ontheway', loggedout: 'def' }[u.online_state] || 'def';
    return `<span class="badge ${loginCls}">${loginMap[u.online_state] || '未登录'}</span>`;
  }
  function accOps(u) {
    // 仅「已注销」账号才可清除数据
    return `<button class="btn sm" data-uedit="${u.id}">编辑</button>` + (u.account_state === 'cancelled'
      ? `<button class="btn sm" data-restore="${u.id}">恢复</button>
         <button class="btn sm danger" data-del="${u.id}">清除数据</button>`
      : `<button class="btn sm warn" data-clear="${u.id}" ${u.has_password ? '' : 'disabled title="该账号尚未设置密码"'}>清除密码</button>
         <button class="btn sm" data-cancel="${u.id}">注销</button>`);
  }

  // 渲染合并账号表（支持按「类型」筛选 + 按「账号ID / 学号 / 姓名」搜索）
  function paintAccList() {
    const type = el('accListType').value;
    const q = (el('accListSearch').value || '').trim().toLowerCase();
    let rows = accAll;
    if (type === 'manager') rows = rows.filter(u => u.role !== 'normal');
    else if (type === 'normal') rows = rows.filter(u => u.role === 'normal');
    if (q) rows = rows.filter(u => String(u.id) === q
      || (u.student_id || '').toLowerCase().includes(q)
      || (u.real_name || '').toLowerCase().includes(q));
    const emptyMsg = (q || type !== 'all') ? '无匹配账号' : '暂无账号';
    el('accListRows').innerHTML = rows.length ? rows.map(u => {
        const typeLabel = u.role === 'normal' ? '用户端' : '管理端';
        return `<tr>
          <td class="mono">${u.id}</td>
          <td>${typeLabel}</td>
          <td>${escapeHtml(u.student_id || '-')}</td>
          <td>${escapeHtml(u.real_name)}</td>
          <td>${escapeHtml(u.role_title)}</td>
          <td>${accStateBadge(u)}</td>
          <td>${accLoginBadge(u)}</td>
          <td class="row ops-actions" style="gap:6px">${accOps(u)}</td>
        </tr>`;
      }).join('') : `<tr><td colspan="8"><div class="empty">${emptyMsg}</div></td></tr>`;
    bindRowActions('#accListRows');
  }

  async function loadAccounts() {
    try {
      const d = await api.get('api/admin/users');
      accAll = d.users || [];
      mgrList = accAll.filter(u => u.role !== 'normal');
      userList = accAll.filter(u => u.role === 'normal');
      paintAccList();
    } catch (e) { toastErr(e.message); }
  }
  // 兼容既有调用点（添加 / 编辑 / 行操作 / 切到账号页）——统一走一次合并加载
  function loadManagers() { return loadAccounts(); }
  function loadUsers() { return loadAccounts(); }

  el('reloadAccList').addEventListener('click', loadAccounts);
  el('accListSearch').addEventListener('input', paintAccList);
  el('accListType').addEventListener('change', paintAccList);

  /* ---------------- 统一添加账号（管理端 / 用户端 二合一） ---------------- */
  function syncAccForm() {
    const isManager = el('accType').value === 'manager';
    el('accSidField').classList.toggle('hidden', isManager);
    el('accIdentityField').classList.toggle('hidden', !isManager);
    el('accTypeField').classList.toggle('hidden', el('accType').options.length <= 1);
    const sel = el('accIdentity');
    sel.innerHTML = isManager
      ? '<option value="辅导员">辅导员</option><option value="小班主任">小班主任</option><option value="班委">班委</option>'
      : '<option value="普通学生">普通学生</option>';
    el('accHint').textContent = isManager
      ? '管理端账号无需学号，添加后需本人到注册页设置密码方可登录。'
      : '添加的账号暂无密码，需本人到注册页用相同姓名 / 学号设置密码后可用。';
  }
  el('accType').addEventListener('change', syncAccForm);

  el('addAccountBtn').addEventListener('click', async () => {
    const isManager = el('accType').value === 'manager';
    const payload = { real_name: el('accName').value.trim(), identity: el('accIdentity').value };
    if (!payload.real_name) return toast('请输入姓名');
    if (!isManager) {
      payload.student_id = el('accSid').value.trim();
    }
    try {
      const r = await api.post('api/admin/users', payload);
      toast(r.message || '已添加');
      el('accName').value = ''; el('accSid').value = '';
      loadManagers(); loadUsers();
    } catch (e) {
      // 幂等：账号已存在（409）时展示摘要，并可一键复用现有账号，避免批量预置被打断
      const ex = e && e.data && e.data.existing;
      if (!isManager && e && e.status === 409 && ex) {
        const stateText = { active: '已激活', unactivated: '待激活', cancelled: '已注销' }[ex.account_state] || ex.account_state;
        const desc = `${ex.real_name}（${ex.role_title}${ex.student_id ? ' · ' + ex.student_id : ''}）· ${stateText}`;
        if (e.data.can_reuse) {
          const yes = await confirmDialog('账号已存在', `${e.data.error}\n\n现有账号：${desc}\n\n是否直接复用该账号？`, '复用');
          if (yes) {
            try {
              const r2 = await api.post('api/admin/users', Object.assign({ reuse: true }, payload));
              toast(r2.message || '已复用');
              el('accName').value = ''; el('accSid').value = '';
              loadManagers(); loadUsers();
            } catch (e2) { toastErr(e2.message); }
          }
          return;
        }
        return toastErr(e.message);
      }
      toastErr(e.message);
    }
  });
  syncAccForm();

  /** 邮箱脱敏展示：本地部分首尾各留 1 位 + 完整域名（与服务端 mask.maskEmail 同规则） */
  function maskEmail(s) {
    const t = String(s || '').trim();
    if (!t) return '未设置';
    const at = t.lastIndexOf('@');
    if (at <= 0) return t;
    const local = t.slice(0, at);
    const domain = t.slice(at);
    if (local.length <= 1) return local + '***' + domain;
    return local[0] + '***' + local[local.length - 1] + domain;
  }

  async function openUserEdit(u) {
    const fields = [{ name: 'real_name', label: '姓名', value: u.real_name }];
    if (u.role === 'normal') fields.push({ name: 'student_id', label: '学号', value: u.student_id || '' });
    fields.push(
      { name: 'identity', label: '身份', value: u.role_title, disabled: true },
      { name: 'email', label: '找回邮箱', value: maskEmail(u.email), readonly: true }
    );
    const v = await formDialog('编辑账号 #' + u.id, '账号ID（#' + u.id + '）是唯一不变的锚点，改名 / 改学号都不会改变它。身份为只读，不可在此调整。', fields, '保存');
    if (!v) return;
    try {
      delete v.email;
      const r = await api.put('api/admin/users/' + u.id, v);
      toast(r.message || '已保存');
      loadManagers(); loadUsers();
    } catch (e) { toastErr(e.message); }
  }

  function bindRowActions(selector) {
    qsa(selector + ' [data-uedit]').forEach(b => b.addEventListener('click', () => {
      const id = b.getAttribute('data-uedit');
      const u = mgrList.concat(userList).find(x => String(x.id) === id);
      if (u) openUserEdit(u);
    }));
    qsa(selector + ' [data-clear]').forEach(b => b.addEventListener('click', async () => {
      if (!await confirmBox('确认清除该账号密码？原密码将失效，需本人重设')) return;
      try {
        const r = await api.post('api/admin/users/' + b.getAttribute('data-clear') + '/clear-password');
        toast(r.message || '已清除');
        loadManagers(); loadUsers(); loadResets();
      } catch (e) { toastErr(e.message); }
    }));
    qsa(selector + ' [data-cancel]').forEach(b => b.addEventListener('click', async () => {
      if (!await confirmBox('确认注销该账号？账号将被隐藏，重新登录需管理员恢复')) return;
      try {
        const r = await api.post('api/admin/users/' + b.getAttribute('data-cancel') + '/cancel', {});
        toast(r.message || '已注销');
        loadManagers(); loadUsers();
      } catch (e) { toastErr(e.message); }
    }));
    qsa(selector + ' [data-del]').forEach(b => b.addEventListener('click', async () => {
      const ok2 = await highRiskConfirm({
        title: '⚠ 清除账号数据',
        danger: '此操作将永久清除该账号的全部数据（签到、请假、会话等）且不可恢复，仅高一级管理员可执行。',
        text: '确认清除账号数据。', label: '确认清除'
      });
      if (!ok2) return;
      try {
        const r = await api.del('api/admin/users/' + b.getAttribute('data-del'), ok2);
        toast(r.message || '已清除');
        loadManagers(); loadUsers();
      } catch (e) { toastErr(e.message); }
    }));
    qsa(selector + ' [data-restore]').forEach(b => b.addEventListener('click', async () => {
      // 恢复属高危操作（会清空对方密码），与服务端一致地走「密码 + 场景固定确认文字」二次确认
      const ok2 = await highRiskConfirm({
        title: '⚠ 恢复账号',
        danger: '此操作将清空该账号密码并结束其全部会话，账号转为「未激活」，需本人重新设置密码后登录。仅高一级管理员可执行。',
        text: '确认恢复该账号。', label: '确认恢复'
      });
      if (!ok2) return;
      try {
        const r = await api.post('api/admin/users/' + b.getAttribute('data-restore') + '/restore', ok2);
        toast(r.message || '已恢复');
        loadManagers(); loadUsers();
      } catch (e) { toastErr(e.message); }
    }));
  }

  /* 高危操作二次确认：本人密码 + 场景固定确认文字（禁止粘贴）。
   * cfg 需与服务端 server/highrisk.js 的场景文案完全一致（清除=确认清除账号数据。／恢复=确认恢复该账号。）
   */
  // 严重消极操作二次确认统一走 api.js 的 highRiskConfirm（二次输入形确认：密码 + 场景固定确认文字）。

  /* ---------------- 活动管理（分页 + 详情） ---------------- */
  let dvActs = [];
  let dvActPage = 1;
  let dvActPageSize = 10;
  /** 长期活动子项默认收起，点击展开（长期活动活动多，避免长列表平铺） */
  const dvActExpanded = new Set();
  const dvActSelected = new Set();
  let dvActFilter = 'upcoming';

  async function loadActivities() {
    try {
      const d = await api.get('api/activities');
      dvActs = d.activities || [];
      publishActs = dvActs;
      renderActivities();
      fillPublishActivities();
    } catch (e) { toastErr(e.message); }
  }

  function renderActivities() {
    // 长期活动默认收起活动，点击展开 / 收起
    const now = Date.now();
    let tops = dvActs.filter(a => !a.parent_id);
    if (dvActFilter !== 'all') {
      tops = tops.filter(a => {
        if (a.is_group) {
          const kids = dvActs.filter(k => k.parent_id === a.id);
          if (!kids.length) return false;
          return kids.some(k => dvActFilter === 'history' ? (k.end_time || 0) < now : (k.end_time || 0) >= now);
        }
        return dvActFilter === 'history' ? ((a.end_time || 0) < now) : ((a.end_time || 0) >= now);
      });
    }
    tops.sort((x, y) => (x.start_time || 0) - (y.start_time || 0));
    // 活动只有展开时才占名额；未展开的长期活动按 1 项计
    const groups = tops.map(a => {
      const kids = a.is_group
        ? dvActs.filter(k => k.parent_id === a.id).sort((x, y) => (x.start_time || 0) - (y.start_time || 0))
        : [];
      const shown = a.is_group && dvActExpanded.has(a.id)
        ? (dvActFilter !== 'all' ? kids.filter(k => dvActFilter === 'history' ? (k.end_time || 0) < now : (k.end_time || 0) >= now) : kids)
        : [];
      return { a, kind: a.is_group ? 'main' : 'once', children: kids.length, shown };
    });
    // 展开后的完整行序列：长期活动 / 临时活动各占一行，已展开的活动同样各占一行
    const flat = [];
    groups.forEach(g => {
      flat.push({ a: g.a, kind: g.kind, children: g.children, pid: null });
      g.shown.forEach(k => flat.push({ a: k, kind: 'child', children: 0, pid: g.a.id }));
    });
    // 每页严格按行数计算，活动与临时活动 / 长期活动一样各占一项
    const total = flat.length;
    const pages = Math.max(1, Math.ceil(total / dvActPageSize));
    if (dvActPage > pages) dvActPage = pages;
    const start = (dvActPage - 1) * dvActPageSize;
    const rows = flat.slice(start, start + dvActPageSize);
    // 本页首行若是活动，说明它的长期活动在上一页，标注「续」
    if (rows.length && rows[0].pid) rows[0].cont = true;

    // 分页信息 / 跳页下拉 / 上下页可用状态
    const info = el('actPageInfo');
    const _countable = dvActs.filter(a => !a.is_group);
    const _now = Date.now();
    const _upcoming = _countable.filter(a => (a.end_time||0) >= _now).length;
    const _history = _countable.length - _upcoming;
    if (info) info.textContent = `待开展 ${_upcoming} / 已结束 ${_history} / 全部 ${_countable.length}`;
    const pageInput = el('actPageInput');
    const totalPagesEl = el('actTotalPages');
    if (pageInput) { pageInput.value = dvActPage; pageInput.max = pages; }
    if (totalPagesEl) totalPagesEl.textContent = pages;
    if (el('actPrev')) el('actPrev').disabled = dvActPage <= 1;
    if (el('actNext')) el('actNext').disabled = dvActPage >= pages;

    el('actRows').innerHTML = rows.length ? rows.map(r => {
      const a = r.a;
      const isMain = r.kind === 'main';
      const isChild = r.kind === 'child';
      const expanded = dvActExpanded.has(a.id);
      const caret = isMain
        ? (r.children
          ? `<button type="button" class="tree-toggle${expanded ? ' open' : ''}" data-fold="${a.id}" aria-expanded="${expanded}" title="${expanded ? '收起活动' : '展开活动'}">${expanded ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:2px"><polyline points="6 9 12 15 18 9"/></svg> 收起' : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:2px"><polyline points="9 6 15 12 9 18"/></svg> 展开'}</button> `
          : '<span class="tree-caret leaf">•</span> ')
        : (isChild ? '<span class="tree-caret leaf">└</span>' : '<span class="tree-caret leaf">•</span>');
      // 活动阶段状态
      const now = Date.now();
      const actEnd = a.end_time || 0;
      const phase = now < (a.start_time || 0)
        ? '<span class="badge pending" title="活动阶段">待开展</span>'
        : (now > actEnd && actEnd > 0
          ? '<span class="badge cancelled" title="活动阶段">已结束</span>'
          : '<span class="badge signed" title="活动阶段">进行中</span>');
      // 标签口径：长期活动 / 子活动（长期下的活动）/ 临时（独立单场）
      const kind = isMain
        ? `<span class="badge manual" title="长期活动">长期</span>${r.children ? `<span class="tag">${r.children} 子活动</span>` : ''}`
        : (isChild ? `<span class="badge" title="长期活动下的活动">子活动</span>${r.cont ? '<span class="tag" title="接上一页的同一长期活动">续</span>' : ''}` : '<span class="badge">临时</span>');
      // 折叠钮放独立窄列，「活动」表头与标题列严格对齐；地点 / 备注跟标题对齐
      // 类型徽章不再挤在标题行里，改由独立「类型」列承载（与管理端表头一致）
      const nameHtml = `
        <div class="act-title-line"><span class="act-name">${escapeHtml(a.title)}</span></div>
        ${safePlace(a.location) ? `<div class="muted" style="font-size:12px;margin-top:3px">📍 ${escapeHtml(safePlace(a.location))}</div>` : ''}
        ${a.remark ? `<div class="muted" style="font-size:12px;margin-top:2px">${escapeHtml(a.remark)}</div>` : ''}`;
      return `
        <tr class="${isMain ? 'tree-main' : (isChild ? 'tree-child' : '')}">
          <td><input type="checkbox" class="dv-act-cb" data-id="${a.id}" ${a.can_delete ? '' : 'disabled'}></td>
          <td class="act-caret-col">${caret}</td>
          <td${isChild ? ' style="padding-left:22px"' : ''}>${nameHtml}</td>
          <td>${fmtDateTime(a.start_time)} ~ ${fmtTime(a.end_time)}</td>
          <td>${escapeHtml(a.window_text || '')}</td>
          <td>${phase}</td>
          <td class="col-optional">${escapeHtml(a.policy_text || '')}</td>
          <td>${a.fence_id ? escapeHtml(a.fence_name || '-') : '未设置'}</td>
          <td>${kind}</td>
          <td>${objMetaHtml(a.created_at, a.creator_name, a.creator_role)}</td>
          <td class="row" style="gap:6px">
            <button class="btn sm" data-adetail="${a.id}">活动详情</button>
            <button class="btn sm danger" data-del="${a.id}">删除</button>
          </td>
        </tr>`;
    }).join('') : '<tr><td colspan="11"><div class="empty">暂无活动</div></td></tr>';

    // 批量选择事件绑定
    qsa('#actRows .dv-act-cb').forEach(cb => cb.addEventListener('change', () => {
      const id = cb.getAttribute('data-id');
      if (cb.checked) dvActSelected.add(id); else dvActSelected.delete(id);
      syncDvActBatchUI();
    }));
    syncDvActBatchUI();
    qsa('#actRows [data-fold]').forEach(b => b.addEventListener('click', () => {
      const id = Number(b.getAttribute('data-fold'));
      if (dvActExpanded.has(id)) dvActExpanded.delete(id); else dvActExpanded.add(id);
      renderActivities();
    }));

    qsa('#actRows [data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!await confirmBox('确认删除该活动？相关签到记录也会一并删除；删除后可由上级管理员 / 运维者协助恢复（保留操作记录）。')) return;
      try { await api.del('api/activities/' + b.getAttribute('data-del')); toast('已删除'); loadActivities(); }
      catch (e) { toastErr(e.message); }
    }));
    qsa('#actRows [data-adetail]').forEach(b => b.addEventListener('click', () => {
      openActivityDetail(Number(b.getAttribute('data-adetail')));
    }));
  }

  // 活动详情统一走 api.js 的 openActivityDetail（运维端 / 管理端 / 学生端同一套浮窗），
  // 此处不再保留运维端专属的旧详情实现，避免三端字段与样式不一致。

  el('reloadAct').addEventListener('click', loadActivities);
  // 活动列表 Tab 筛选
  if (el('dvActFilter')) el('dvActFilter').addEventListener('change', () => {
    dvActFilter = el('dvActFilter').value;
    dvActPage = 1;
    renderActivities();
  });
  if (el('actPageSize')) {
    el('actPageSize').addEventListener('change', () => {
      const psVal = el('actPageSize').value;
      dvActPageSize = psVal === 'all' ? 99999 : (Number(psVal) || 10);
      dvActPage = 1;
      renderActivities();
    });
  }
  if (el('actPrev')) el('actPrev').addEventListener('click', () => {
    if (dvActPage > 1) { dvActPage -= 1; renderActivities(); }
  });
  if (el('actNext')) el('actNext').addEventListener('click', () => { dvActPage += 1; renderActivities(); });
  if (el('actPageInput')) {
    el('actPageInput').addEventListener('change', () => {
      let v = parseInt(el('actPageInput').value, 10) || 1;
      const max = parseInt(el('actPageInput').max, 10) || 1;
      if (v < 1) v = 1; if (v > max) v = max;
      el('actPageInput').value = v;
      dvActPage = v;
      renderActivities();
    });
  }

  /* ---------------- 活动范围（批次 / 分页 / 批量；编辑器在独立页面） ---------------- */
  /** 仅拉取活动范围并填充发布表单的「活动范围」下拉（与活动范围面板解耦，
   *  这样进入「活动管理」分区时也能立即拿到下拉数据，无需先访问「活动范围」页。 */
  async function refreshFenceOptions() {
    try {
      const d = await api.get('api/fences');
      fenceList = d.fences || [];
      if (el('aFence')) el('aFence').innerHTML = '<option value="0">未设置</option>' + fenceList
        .map(f => `<option value="${f.id}">${escapeHtml(f.name)}${f.polygons && f.polygons.length > 1 ? `（${f.polygons.length}范围）` : ''}</option>`).join('');
    } catch (e) { /* 忽略 */ }
  }
  function loadFences() {
    const p = window.initFencePanel && window.initFencePanel();
    // 同步填充发布表单的活动范围下拉
    refreshFenceOptions();
    return p;
  }

  /* ---------------- 账号管理范围：已改为「按层级自动授权」，无需手工配置 ---------------- */

  /* ---------------- 密码清除申请 ---------------- */
  async function loadResets() {
    try {
      const d = await api.get('api/admin/pwd-resets');
      const rows = d.resets || [];
      el('resetRows').innerHTML = rows.length ? rows.map(r => `
        <tr>
          <td>${escapeHtml(r.real_name)}</td>
          <td>${escapeHtml(r.student_id || '-')}</td>
          <td>${escapeHtml(r.role_title)}</td>
          <td>${fmtDateTime(r.created_at)}</td>
          <td>${r.status === 'pending' ? '<span class="badge pending">待处理</span>' : '<span class="badge signed">已处理</span>'}</td>
          <td>${r.status === 'pending' ? `<button class="btn sm warn" data-clr="${r.user_id}">清除密码</button>` : '-'}</td>
        </tr>`).join('') : '<tr><td colspan="6"><div class="empty">暂无申请</div></td></tr>';
      qsa('#resetRows [data-clr]').forEach(b => b.addEventListener('click', async () => {
        if (!await confirmBox('确认清除该账号密码？')) return;
        try {
          const r = await api.post('api/admin/users/' + b.getAttribute('data-clr') + '/clear-password');
          toast(r.message || '已清除');
          loadResets();
        } catch (e) { toastErr(e.message); }
      }));
    } catch (e) { /* 忽略 */ }
  }
  el('reloadResets').addEventListener('click', loadResets);

  /* ---------------- 数据流 ---------------- */
  let devStreamAll = [];
  let devStreamPage = 1;
  let devStreamPageSize = 15;
  const devStreamSel = new Set();

  /** 高危场景固定确认文字：统一由服务端 highrisk 下发，前端不再硬编码副本 */
  let HR_TEXTS = {};
  async function loadHighriskTexts() {
    try {
      const d = await api.get('api/dataflow/highrisk-texts');
      HR_TEXTS = d.texts || {};
    } catch (e) { HR_TEXTS = {}; }
  }
  loadHighriskTexts();
  function sceneText(scene) { return HR_TEXTS[scene] || ''; }

  /** 双重验证（登录密码 + 场景固定文字，禁止粘贴）统一复用 api.js 的 highRiskConfirm。 */

  /* 行内「操作记录详情」表格：统一使用 api.js 的公共 streamDetailHtml，
     与用户端 / 管理端 / 数据流页完全一致（时间精确到 .000，含目标/内容/渠道/打码/撤回）。 */

  async function loadStream() {
    try {
      const d = await api.get('api/stream?limit=500');
      devStreamAll = d.events || [];
      devStreamPage = 1;
      renderDevStream();
    } catch (e) { toastErr(e.message); }
  }

  function syncStreamSelectAll(rows) {
    const sa = el('dsSelectAll');
    if (!sa || !rows) return;
    const total = rows.length;
    const sel = rows.filter(e => devStreamSel.has(e.id)).length;
    sa.checked = total > 0 && sel === total;
    sa.indeterminate = sel > 0 && sel < total;
  }

  function renderDevStream() {
    const pages = Math.max(1, Math.ceil(devStreamAll.length / devStreamPageSize));
    if (devStreamPage > pages) devStreamPage = pages;
    const s = (devStreamPage - 1) * devStreamPageSize;
    const rows = devStreamAll.slice(s, s + devStreamPageSize);
    el('streamRows').innerHTML = rows.length ? rows.map(e => {
      const id = eventIdentity(e);
      const name = escapeHtml(e.actor_name || '系统');
      const checked = devStreamSel.has(e.id) ? 'checked' : '';
      return `<tr>
        <td><input type="checkbox" class="ds-cb" data-id="${e.id}" ${checked}></td>
        <td>${fmtDateTimeMs(e.created_at)}</td>
        <td><span class="tag ev-${eventCat(e.type)}">${escapeHtml(safeTypeText(e.type_text, e.type))}</span></td>
        <td>${name} <span class="badge ${id.cls}">${id.text}</span></td>
        <td>${escapeHtml(e.text || eventContent(e))}</td>
        <td class="row" style="gap:6px">
          <button class="btn sm" data-detail-stream="${e.id}">详情</button>
          <button class="btn sm danger" data-del-stream="${e.id}">删除</button>
        </td>
      </tr>
      <tr class="df-inline-detail" id="dsd-${e.id}" style="display:none"><td colspan="6"><div class="empty">加载中…</div></td></tr>`;
    }).join('')
      : '<tr><td colspan="6"><div class="empty">暂无数据</div></td></tr>';

    qsa('#streamRows [data-del-stream]').forEach(b => b.addEventListener('click', async () => {
      const id = b.getAttribute('data-del-stream');
      const v = await highRiskConfirm({
        title: '⚠ 删除数据流记录',
        danger: '删除操作不可恢复。请输入你的登录密码，并逐字输入下方确认文字（禁止粘贴）。',
        text: sceneText('delete_dataflow'),
        label: '确认删除'
      });
      if (!v) return;
      try {
        const r = await api.del('api/stream/' + id, v);
        toast(r.message || '已删除');
        loadStream();
      } catch (err) { toastErr(err.message); }
    }));
    // 行内展开「操作记录详情」（不再跳转到单独页面）：拉取完整详情，时间精确到 .000
    qsa('#streamRows [data-detail-stream]').forEach(b => b.addEventListener('click', async () => {
      const id = b.getAttribute('data-detail-stream');
      const tr = document.getElementById('dsd-' + id);
      if (!tr) return;
      if (tr.style.display === 'none') {
        tr.style.display = '';
        b.textContent = '收起';
        if (!tr.dataset.loaded) {
          try {
            const d = await api.get('api/dataflow/' + id);
            tr.querySelector('td').innerHTML = streamDetailHtml(d.item || {});
            tr.dataset.loaded = '1';
          } catch (err) { tr.querySelector('td').innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`; }
        }
      } else { tr.style.display = 'none'; b.textContent = '详情'; }
    }));
    qsa('#streamRows .ds-cb').forEach(cb => cb.addEventListener('change', () => {
      const id = Number(cb.getAttribute('data-id'));
      if (cb.checked) devStreamSel.add(id); else devStreamSel.delete(id);
      syncStreamSelectAll(rows);
    }));
    const sa = el('dsSelectAll');
    if (sa) {
      sa.onchange = () => {
        rows.forEach(e => { if (sa.checked) devStreamSel.add(e.id); else devStreamSel.delete(e.id); });
        qsa('#streamRows .ds-cb').forEach(cb => { cb.checked = sa.checked; });
        syncStreamSelectAll(rows);
      };
    }
    syncStreamSelectAll(rows);
    const spi = el('streamPageInput'); const stp = el('streamTotalPages');
    if (spi) { spi.value = devStreamPage; spi.max = pages; }
    if (stp) stp.textContent = pages;
  }

  el('streamPageSize').addEventListener('change', () => { const v = Number(el('streamPageSize').value); devStreamPageSize = v === 0 ? (devStreamAll.length || 1) : v; devStreamPage = 1; renderDevStream(); });
  el('streamPrev').addEventListener('click', () => { if (devStreamPage > 1) { devStreamPage--; renderDevStream(); } });
  el('streamNext').addEventListener('click', () => { devStreamPage++; renderDevStream(); });
  if (el('streamPageInput')) el('streamPageInput').addEventListener('change', () => {
    let v = parseInt(el('streamPageInput').value, 10) || 1;
    const max = parseInt(el('streamPageInput').max, 10) || 1;
    if (v < 1) v = 1; if (v > max) v = max;
    el('streamPageInput').value = v; devStreamPage = v; renderDevStream();
  });
  el('reloadStream').addEventListener('click', loadStream);
  el('dsClearSel').addEventListener('click', async () => {
    const ids = Array.from(devStreamSel);
    if (!ids.length) return toast('请先勾选要删除的记录');
    const v = await highRiskConfirm({
      title: '⚠ 批量删除数据流记录',
      danger: '批量删除不可恢复。请输入你的登录密码，并逐字输入下方确认文字（禁止粘贴）。',
      text: sceneText('bulk_delete_dataflow'),
      label: '确认批量删除'
    });
    if (!v) return;
    try {
      const r = await api.del('api/stream', Object.assign({ ids }, v));
      toast(r.message || '已删除');
      devStreamSel.clear();
      loadStream();
    } catch (err) { toastErr(err.message); }
  });

  /* ---------------- 数据流隐私打码设置（显式保存，与全站设置页一致） ---------------- */
  async function loadDfSettings() {
    try {
      const m = await api.get('api/dataflow/meta');
      const disp = el('dfDisplayMask');
      if (disp) disp.checked = !!m.mask;
      updateDfState();
    } catch (e) { /* 忽略：无权限或非运维者时静默 */ }
  }
  function updateDfState() {
    const disp = el('dfDisplayMask'), s = el('dfState');
    if (!s) return;
    s.textContent = `当前：显示${disp && disp.checked ? '打码' : '明文'}`;
  }
  if (el('dfSave')) el('dfSave').addEventListener('click', async () => {
    const disp = el('dfDisplayMask');
    try {
      await api.post('api/dataflow/mask', { mask: !!(disp && disp.checked) });
      updateDfState();
      toast('已保存数据流隐私打码设置');
    } catch (e) { toastErr(e.message); }
  });

  /* ---------------- 维护排期（运维者） ---------------- */
  function tsToLocalInput(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function localInputToTs(v) { return v ? new Date(v).getTime() : null; }

  // 预置默认排期：开始=当前时间，结束=当前时间 +1 小时（无已存排期时填充，便于直接微调保存）
  function defaultMaintStart() { return tsToLocalInput(Date.now()); }
  function defaultMaintEnd() { return tsToLocalInput(Date.now() + 60 * 60 * 1000); }

  async function loadMaint() {
    try {
      const d = await api.get('api/settings');
      const m = d.maintenance || { enabled: false, start_at: null, end_at: null, notice: '' };
      if (el('maintStart')) el('maintStart').value = tsToLocalInput(m.start_at) || defaultMaintStart();
      if (el('maintEnd')) el('maintEnd').value = tsToLocalInput(m.end_at) || defaultMaintEnd();
      if (el('maintNotice')) el('maintNotice').value = m.notice || '';
      if (el('maintState')) {
        el('maintState').innerHTML = m.enabled
          ? `<span class="badge absent">维护中</span> 开始 ${fmtDateTime(m.start_at)} · 预计结束 ${m.end_at ? fmtDateTime(m.end_at) : '待定'}`
          : (m.start_at ? `<span class="badge signed">已排期</span> 将于 ${fmtDateTime(m.start_at)} 自动进入维护` : '当前未排期、未处于维护中');
      }
      // 维护中：「立即进入维护」灰度禁用，避免重复入场；「结束维护」仅在维护中可用
      if (el('maintNow')) el('maintNow').disabled = !!m.enabled;
      if (el('maintEndBtn')) el('maintEndBtn').disabled = !m.enabled;
      syncMaintSave();
    } catch (e) { toastErr(e.message); }
  }

  // 排期必须有起止时间：缺「前/后」任一则禁止保存（按钮置灰 + 点击兜底）
  function syncMaintSave() {
    const s = el('maintStart'), e = el('maintEnd'), b = el('maintSave');
    if (!s || !e || !b) return;
    b.disabled = !(s.value.trim() && e.value.trim());
  }

  // 管理端定位查看全局开关（系统安全）：独立于维护分区加载
  async function loadMlv() {
    try {
      const d = await api.get('api/settings');
      const mlv = !!(d.settings && String(d.settings.manager_location_view) === '1');
      if (el('mlvSwitch')) el('mlvSwitch').checked = mlv;
      if (el('mlvState')) el('mlvState').textContent = mlv ? '当前：管理端可查看学生定位' : '当前：管理端不可查看学生定位';
    } catch (e) { toastErr(e.message); }
  }

  /* ---------------- 自动代管（缺上级自动补位，仅运维者） ---------------- */
  function renderAutoCover(d) {
    const info = d && d.auto_cover;
    const on = d ? !!d.auto_cover_enabled : false;
    if (el('acSwitch')) el('acSwitch').checked = on;
    if (el('acState')) el('acState').textContent = on ? '当前：已启用' : '当前：已关闭（不会自动补位）';
    if (!el('acInfo')) return;
    if (!on) { el('acInfo').textContent = '已关闭：不会自动授予代管权限（既有代管权限已收回）。'; return; }
    if (!info) { el('acInfo').textContent = ''; return; }
    const gaps = (info.gap_names || []);
    const ts = info.updated_at ? new Date(info.updated_at).toLocaleString() : '—';
    el('acInfo').innerHTML = gaps.length
      ? `当前缺口：<b>${escapeHtml(gaps.join('、'))}</b>；正在代管的账号 <b>${info.agents || 0}</b> 个、权限 <b>${info.perms || 0}</b> 项；最近变更：${escapeHtml(ts)}`
      : `当前无缺口（小班主任 / 辅导员均在岗）；历史代管权限已全部收回。最近变更：${escapeHtml(ts)}`;
  }
  async function loadAutoCover() {
    try {
      const d = await api.get('api/settings');
      renderAutoCover(d);
    } catch (e) { toastErr(e.message); }
  }
  if (el('acSave')) el('acSave').addEventListener('click', async () => {
    try {
      const r = await api.put('api/settings/auto-cover', { enabled: !!el('acSwitch').checked });
      toast(r.message || '已保存');
      renderAutoCover(r.data || null);
      loadAutoCover();
    } catch (e) { toastErr(e.message); }
  });

  if (el('mlvSave')) el('mlvSave').addEventListener('click', async () => {
    try {
      const r = await api.put('api/settings/manager-location-view', { enabled: !!el('mlvSwitch').checked });
      toast(r.message || '已保存');
      if (el('mlvState')) el('mlvState').textContent = r.enabled ? '当前：管理端可查看学生定位' : '当前：管理端不可查看学生定位';
    } catch (e) { toastErr(e.message); }
  });

  // 定位核验总开关（需「启动活动范围核验」权限）：与系统安全页其他开关同为复选框+保存
  async function loadLv() {
    try {
      const d = await api.get('api/settings');
      const enabled = !!d.location_verify_enabled;
      const need = !(d.can && d.can.location_verify);
      if (el('lvSwitch')) el('lvSwitch').checked = enabled;
      if (el('lvState')) el('lvState').textContent = `当前：${enabled ? '已启用定位核验' : '已关闭定位核验'}` + (need ? '（需「启动活动范围核验」权限）' : '');
    } catch (e) { toastErr(e.message); }
  }
  if (el('lvSave')) el('lvSave').addEventListener('click', async () => {
    try {
      const enabled = !!el('lvSwitch').checked;
      const r = await api.put('api/settings/location-verify', { enabled });
      toast(r.message || '已保存');
      loadLv();
    } catch (e) { toastErr(e.message); }
  });
  // 签到设置：是否允许普通学生申请补签。与管理端同一接口（后端允许 manager / ops 两种角色）
  async function loadSettings() {
    try {
      const d = await api.get('api/admin/settings');
      const s = d.settings || {};
      if (el('setAllowMakeup')) el('setAllowMakeup').checked = String(s.allow_makeup) === '1';
      if (el('mailState')) el('mailState').innerHTML = (d.mail_configured
        ? '邮件服务已配置，审核结果与提醒会发送到普通学生登记的邮箱。'
        : '<b>邮件服务未配置</b>：请在服务端填写 SMTP_* 环境变量后重启，提醒与结果邮件才会真正发出。')
        + '<br><span class="muted">发件邮箱（MAIL_FROM）只填地址即可。系统不提供「发件显示名」配置项；'
        + '如需让收件端显示别的名称，请到发件邮箱服务商修改其账户名称 / 昵称（是否生效取决于服务商）。'
        + '邮件主题与正文中的系统名则是「系统全称」（班级名 + 商品名）。</span>';
    } catch (e) { toastErr(e.message); }
  }
  if (el('saveSettings')) el('saveSettings').addEventListener('click', async () => {
    try {
      const r = await api.post('api/admin/settings', { allow_makeup: el('setAllowMakeup').checked });
      toast(r.message || '设置已保存');
      loadSettings();
    } catch (e) { toastErr(e.message); }
  });
  // 系统安全：刷新按钮（整体重载本区所有设置）
  async function loadSecurityAll() { loadDfSettings(); loadMlv(); loadLv(); loadAutoCover(); loadSettings(); }
  if (el('reloadSecurity')) el('reloadSecurity').addEventListener('click', loadSecurityAll);

  if (el('maintStart')) el('maintStart').addEventListener('input', syncMaintSave);
  if (el('maintEnd')) el('maintEnd').addEventListener('input', syncMaintSave);
  if (el('maintReload')) el('maintReload').addEventListener('click', loadMaint);
  if (el('maintSave')) el('maintSave').addEventListener('click', async () => {
    const start = localInputToTs(el('maintStart').value);
    const end = localInputToTs(el('maintEnd').value);
    if (!start || !end) return toastErr('请先设置维护的排期开始时间与预计结束时间，再保存排期');
    if (end <= start) return toastErr('预计结束时间必须晚于排期开始时间');
    try {
      const r = await api.put('api/settings/maintenance', { start_at: start, end_at: end, notice: el('maintNotice').value.trim() });
      toast(r.message || '已保存'); loadMaint();
    } catch (e) { toastErr(e.message); }
  });
  if (el('maintClear')) el('maintClear').addEventListener('click', async () => {
    if (!await confirmBox('清除维护排期？（不会结束正在进行的维护）')) return;
    try { await api.put('api/settings/maintenance', { start_at: null, end_at: null, notice: '' }); toast('已清除排期'); loadMaint(); }
    catch (e) { toastErr(e.message); }
  });
  if (el('maintNow')) el('maintNow').addEventListener('click', async () => {
    if (el('maintNow').disabled) return;   // 维护中：已灰度，避免重复入场
    if (!await confirmDialog('立即进入维护', '将立即进入维护：除运维端外的在线账号会被强制下线，全站显示维护遮罩。是否继续？', '立即进入')) return;
    try {
      const r = await api.put('api/settings/maintenance', { enabled: true, immediate: true, notice: el('maintNotice') ? el('maintNotice').value.trim() : '' });
      toast(r.message || '已进入维护'); loadMaint();
    }
    catch (e) { toastErr(e.message); }
  });
  if (el('maintEndBtn')) el('maintEndBtn').addEventListener('click', async () => {
    if (!await confirmDialog('结束维护', '将结束维护：被下线的账号会自动恢复上线。是否继续？', '结束维护')) return;
    try { const r = await api.put('api/settings/maintenance', { enabled: false }); toast(r.message || '维护已结束'); loadMaint(); }
    catch (e) { toastErr(e.message); }
  });

  /* ---------------- 公告栏（仅运维者） ---------------- */
  let announcementText = '';
  async function loadAnnouncement() {
    try {
      const d = await api.get('api/settings');
      announcementText = d.announcement_text || '';
      if (el('announcementBox')) el('announcementBox').textContent = announcementText || '（尚未发布任何公告）';
      if (el('announcementMeta')) {
        el('announcementMeta').textContent = d.announcement_updated_at
          ? '最近发布：' + fmtDateTime(Number(d.announcement_updated_at))
          : '尚未发布过公告';
      }
    } catch (e) { /* 忽略：非运维者时静默 */ }
  }
  if (el('announcementReload')) el('announcementReload').addEventListener('click', loadAnnouncement);
  if (el('editAnnouncementBtn')) el('editAnnouncementBtn').addEventListener('click', async () => {
    const v = await formDialog('发布公告', '发布后会邮件通知全体用户，并在用户登录后弹窗展示（一次性确认后即不再弹出）。', [
      {
        name: 'text', label: '公告内容', multiline: true, rows: 8, value: announcementText,
        placeholder: '支持换行；发布后覆盖上一份公告'
      },
      { name: 'summary', label: '摘要（邮件中会展示）', placeholder: '如：国庆假期签到安排调整' }
    ], '发布并通知');
    if (!v) return;
    if (!v.text) { toastErr('公告内容不能为空'); return; }
    try {
      const r = await api.put('api/settings/announcement', { text: v.text, summary: v.summary });
      toast(r.message || '已发布'); loadAnnouncement();
    } catch (e) { toastErr(e.message); }
  });

  /* ---------------- 工单审批（高危权限申请） ---------------- */
  const WO_STATUS = { pending: '待审批', approved: '已批准', rejected: '已驳回', timeout: '超时驳回' };
  /** 权限码 → 可读名：界面只展示可读名，不展示权限码原文 */
  function permName(code) {
    if (!code) return '未知权限';
    return (window.PermGate && PermGate.permLabel) ? PermGate.permLabel(code) : '未知权限';
  }
  async function loadInbox() {
    try {
      const d = await api.get('api/workorders/inbox');
      const rows = d.orders || [];
      el('inboxRows').innerHTML = rows.length ? rows.map(w => `
        <tr>
          <td>${escapeHtml(w.real_name)}</td>
          <td>${escapeHtml(w.role_title)}</td>
          <td><span class="tag">${escapeHtml(w.kind === 'info' ? '信息 / 反馈' : permName(w.perm_code))}</span></td>
          <td>${escapeHtml(w.reason || '')}</td>
          <td>${fmtDateTime(w.created_at)}</td>
          <td>${w.status === 'pending'
            ? `<button class="btn sm ok" data-ap="${w.id}" data-kind="${w.kind || 'perm'}">批准</button> <button class="btn sm danger" data-rj="${w.id}" data-kind="${w.kind || 'perm'}">驳回</button>`
            : `<span class="tag">${WO_STATUS[w.status] || w.status}</span>`}</td>
        </tr>`).join('') : '<tr><td colspan="6"><div class="empty">暂无工单</div></td></tr>';
      qsa('#inboxRows [data-ap]').forEach(b => b.addEventListener('click', () => reviewOrder(b.getAttribute('data-ap'), true, b.getAttribute('data-kind'))));
      qsa('#inboxRows [data-rj]').forEach(b => b.addEventListener('click', () => reviewOrder(b.getAttribute('data-rj'), false, b.getAttribute('data-kind'))));
    } catch (e) {
      el('inboxRows').innerHTML = `<tr><td colspan="6"><div class="empty">${escapeHtml(e.message)}</div></td></tr>`;
    }
  }
  el('reloadInbox').addEventListener('click', loadInbox);

  async function reviewOrder(id, approve, kind) {
    const isInfo = kind === 'info';
    const reply = await promptText(
      approve ? (isInfo ? '通过信息修改 / 反馈' : '批准权限工单') : (isInfo ? '驳回信息修改 / 反馈' : '驳回权限工单'),
      approve ? '可填写审批留言（可选，会随邮件发给申请人）。' : '可填写驳回理由（可选，会随邮件发给申请人）。',
      approve ? '例如：已核实，仅限本次活动使用' : '例如：理由不充分', true, true
    );
    if (reply === null) return;
    let days = 0;
    // 「信息修改 / 反馈」不涉及权限授予，无需设置有效期
    if (approve && !isInfo) {
      const v = await formDialog('设置有效期（可选）', '留空表示长期有效；填写天数后到期自动收回。', [
        { name: 'days', label: '有效天数', placeholder: '例如 7' }
      ], '确定');
      if (v === null) return;
      days = Number(v.days) || 0;
    }
    try {
      const r = await api.post('api/workorders/' + id + '/review', { approve, reply, days });
      toast(r.message || '已处理');
      loadInbox();
    } catch (e) { toastErr(e.message); }
  }

  /* ==================== 三端补齐：发布活动 / 班级签到 / 补签退签 / 日历报告 ==================== */
  let publishActs = [];
  let fenceList = [];
  let destMap = null, destMarker = null, destLatLng = null, destFenceLayer = null;
  const MAX_ACT_IMAGES = 3;                 // 发布配图最多张数（与服务端一致）
  let actImages = [];                       // [{ data }] data 为压缩后的 dataURL
  const DEST_TILE = {
    url: 'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
    attribution: '© 高德地图', subdomains: '1234'
  };

  function updateDestState() {
    if (!el('aDestState')) return;
    // 界面内不展示原始坐标，只给出状态描述
    el('aDestState').textContent = destLatLng
      ? '已设置目的地（可拖动定位标微调，或点地图重新选择）'
      : '未设置目的地';
  }
  function setDestMarker(latlng, recenter) {
    if (!destMap) return;
    destLatLng = { lat: latlng.lat, lng: latlng.lng };
    if (destMarker) destMarker.setLatLng(latlng);
    else {
      const icon = L.divIcon({ className: 'dest-marker', html: '<div class="dest-pin">📍</div>', iconSize: [28, 28], iconAnchor: [14, 28] });
      destMarker = L.marker(latlng, { icon, draggable: true }).addTo(destMap);
      destMarker.on('dragend', () => { const p = destMarker.getLatLng(); destLatLng = { lat: p.lat, lng: p.lng }; updateDestState(); });
    }
    if (recenter) destMap.setView(latlng, Math.max(destMap.getZoom(), 16));
    updateDestState();
  }
  function clearDestMarker() { destLatLng = null; if (destMarker && destMap) { destMap.removeLayer(destMarker); destMarker = null; } updateDestState(); }
  function renderFenceOnDest(fence) {
    if (!destMap) return;
    if (!destFenceLayer) destFenceLayer = L.layerGroup().addTo(destMap);
    destFenceLayer.clearLayers();
    if (!fence || !fence.polygons || !fence.polygons.length) return;
    fence.polygons.forEach(ring => {
      if (!Array.isArray(ring) || ring.length < 3) return;
      L.polygon(ring.map(p => [Number(p[1]), Number(p[0])]), { color: '#0a7d3c', weight: 2, fillColor: '#0a7d3c', fillOpacity: 0.12 }).addTo(destFenceLayer).bindTooltip(escapeHtml(fence.name || '活动范围'));
    });
  }
  function onFencePick() {
    const id = Number(el('aFence').value);
    const fence = id ? fenceList.find(f => f.id === id) : null;
    renderFenceOnDest(fence);
    if (fence && fence.polygons && fence.polygons.length) {
      const pts = [];
      fence.polygons.forEach(poly => (poly || []).forEach(p => pts.push([Number(p[1]), Number(p[0])])));
      if (pts.length) { try { destMap.fitBounds(pts, { padding: [40, 40], maxZoom: 18 }); } catch (e) { /* 忽略 */ } }
    }
  }
  function ensureDestMap() {
    if (typeof L === 'undefined') return;
    if (!destMap) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem('mgr_dest') || 'null'); } catch (e) { /* 忽略 */ }
      const c = saved || { lat: 39.9087, lng: 116.3975 };
      destMap = L.map('aDestMap', { center: [c.lat, c.lng], zoom: saved ? 16 : 13 });
      L.tileLayer(DEST_TILE.url, { attribution: DEST_TILE.attribution, subdomains: DEST_TILE.subdomains, maxZoom: 18 }).addTo(destMap);
      destMap.on('click', (e) => setDestMarker(e.latlng, false));
      if (saved) setDestMarker(saved, false);
    }
    setTimeout(() => { try { destMap.invalidateSize(); } catch (e) { /* 忽略 */ } }, 60);
    onFencePick();
  }
  function renderActImages() {
    const state = el('aImageState');
    const clearBtn = el('aImageClear');
    const box = el('aImagePreviews');
    if (state) {
      state.textContent = actImages.length
        ? `已选择 ${actImages.length} 张（最多 ${MAX_ACT_IMAGES} 张）`
        : `未选择配图（可选，最多 ${MAX_ACT_IMAGES} 张）`;
    }
    // 只有真的选了图才显示「清空全部配图」，没有图时彻底不出现（class + 属性双保险）
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', actImages.length === 0);
      clearBtn.hidden = actImages.length === 0;
    }
    if (!box) return;
    box.innerHTML = '';
    actImages.forEach((it, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'att-pick';
      const img = document.createElement('img');
      img.src = it.data;
      img.alt = `配图 ${i + 1}`;
      img.title = '点击放大查看';
      img.setAttribute('data-full', it.data);     // 文档级委托：点击放大
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'att-del';
      del.textContent = '×';
      del.title = '删除这张配图';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const yes = await confirmBox(`确定删除第 ${i + 1} 张配图吗？删除后需要重新选择。`, true);
        if (!yes) return;
        actImages.splice(i, 1);
        renderActImages();
      });
      wrap.appendChild(img);
      wrap.appendChild(del);
      box.appendChild(wrap);
    });
  }

  /** canvas 压缩到长边 1280：避免手机原图过大导致发布请求超限 */
  function compressActImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('图片格式不支持'));
        img.onload = () => {
          const maxSide = 1280;
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.8));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function clearActImage() {
    actImages = [];
    if (el('aImage')) el('aImage').value = '';
    renderActImages();
  }
  function syncModeUI() {
    const mode = el('aMode').value;
    el('onceBox').classList.toggle('hidden', mode !== 'once');
    el('recBox').classList.toggle('hidden', mode !== 'recurring');
    el('subBox').classList.toggle('hidden', mode !== 'sub');
    el('titleField').classList.toggle('hidden', mode === 'sub');
    if (el('locField')) el('locField').classList.toggle('hidden', mode === 'sub');
  }

  if (el('aMode')) el('aMode').addEventListener('change', syncModeUI);
  // 规则切换时动态调整提前开放分钟数的最小值：before_start 不允许 0
  if (el('aPolicy')) {
    const syncOffsetMin = () => {
      const offEl = el('aOffset');
      if (!offEl) return;
      if (el('aPolicy').value === 'before_start') {
        offEl.min = '1';
        if (Number(offEl.value) <= 0) offEl.value = '60';
      } else {
        offEl.min = '0';
      }
    };
    el('aPolicy').addEventListener('change', syncOffsetMin);
    syncOffsetMin();
  }
  if (el('aImage')) el('aImage').addEventListener('change', async () => {
    const files = Array.prototype.slice.call(el('aImage').files || []);
    el('aImage').value = '';              // 清空原生控件，允许删除后重选同一张
    if (!files.length) return;
    const room = MAX_ACT_IMAGES - actImages.length;
    if (room <= 0) return toastErr(`最多 ${MAX_ACT_IMAGES} 张配图`);
    if (files.length > room) toast(`最多 ${MAX_ACT_IMAGES} 张，超出部分已忽略`);
    for (const f of files.slice(0, room)) {
      if (!/^image\//.test(f.type)) { toastErr('请选择图片文件'); continue; }
      if (f.size > 6 * 1024 * 1024) { toastErr('图片不能超过 6MB'); continue; }
      try {
        actImages.push({ data: await compressActImage(f) });
      } catch (e) { toastErr((e && e.message) || '图片读取失败'); }
    }
    renderActImages();
  });
  if (el('aImageClear')) el('aImageClear').addEventListener('click', async () => {
    if (!actImages.length) return;
    const yes = await confirmBox(`确定清空全部 ${actImages.length} 张配图吗？清空后需要重新选择。`, true);
    if (!yes) return;
    clearActImage();
  });
  renderActImages();
  if (el('aDestClear')) el('aDestClear').addEventListener('click', () => clearDestMarker());
  if (el('aFence')) el('aFence').addEventListener('change', onFencePick);
  if (el('aDestUseMyLoc')) el('aDestUseMyLoc').addEventListener('click', () => {
    const blocked = geoUnavailableReason();
    if (blocked) return toastErr(blocked);
    el('aDestState').textContent = '定位中…';
    navigator.geolocation.getCurrentPosition(
      pos => { const [lng, lat] = wgs84ToGcj02(pos.coords.longitude, pos.coords.latitude); setDestMarker({ lat, lng }, true); },
      err => { el('aDestState').textContent = '定位失败：' + ((err && err.message) || '请检查定位权限'); },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  });
  if (el('publishBtn')) el('publishBtn').addEventListener('click', async () => {
    const mode = el('aMode').value;
    const payload = {
      title: el('aTitle').value.trim(),
      mode: mode,
      fence_id: Number(el('aFence').value),
      policy: el('aPolicy').value,
      offset_minutes: Math.max(0, Math.floor(Number(el('aOffset').value)) || 0),
      remark: el('aRemark') ? el('aRemark').value.trim() : '',
      location: el('aLocation') ? el('aLocation').value.trim() : '',
      dest_lng: destLatLng ? destLatLng.lng : null,
      dest_lat: destLatLng ? destLatLng.lat : null,
      images: actImages.map(x => x.data)
    };
    if (mode === 'sub') {
      payload.parent_id = Number(el('aParent').value);
      payload.start_time = el('sStart').value;
      payload.end_time = el('sEnd').value;
      if (!payload.parent_id) return toast('请选择所属长期活动');
      if (!payload.start_time || !payload.end_time) return toast('请填写活动时间段');
      if (new Date(payload.start_time).getTime() < Date.now() || new Date(payload.end_time).getTime() < Date.now()) return toast('不能设置已过去的活动：活动时间段（开始 / 结束）需晚于当前时间');
    } else if (mode === 'recurring') {
      payload.start_date = el('rStart').value;
      payload.end_date = el('rEnd').value;
      payload.start_clock = el('rClock1').value;
      payload.end_clock = el('rClock2').value;
      payload.days = qsa('#rDays input:checked').map(i => Number(i.value));
      if (!payload.title) return toast('请输入活动名称');
      if (!payload.start_date || !payload.end_date) return toast('请选择长期活动的起止日期');
      if (!payload.days.length) return toast('请选择重复的星期');
      let minStart = 0;
      const fromT = new Date(payload.start_date + 'T00:00:00').getTime();
      const toT = new Date(payload.end_date + 'T00:00:00').getTime();
      for (let t = fromT; t <= toT; t += 86400000) {
        const d = new Date(t);
        if (!payload.days.includes(d.getDay())) continue;
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const s = new Date(`${ds}T${payload.start_clock}`).getTime();
        if (!minStart || s < minStart) minStart = s;
      }
      if (minStart && minStart < Date.now()) return toast('不能设置已过去的活动：所选日期范围内存在早于当前时间的活动，请调整开始日期或重复的星期');
    } else {
      payload.start_time = el('aStart').value;
      payload.end_time = el('aEnd').value;
      if (!payload.title) return toast('请输入活动名称');
      if (!payload.start_time || !payload.end_time) return toast('请填写活动时间段');
      if (new Date(payload.start_time).getTime() < Date.now() || new Date(payload.end_time).getTime() < Date.now()) return toast('不能设置已过去的活动：活动时间段（开始 / 结束）需晚于当前时间');
    }
    try {
      const res = await api.post('api/activities', payload);
      toast(res.message || '已发布');
      if (el('aRemark')) el('aRemark').value = '';
      if (el('aLocation')) el('aLocation').value = '';
      if (destLatLng) { try { localStorage.setItem('mgr_dest', JSON.stringify(destLatLng)); } catch (e) { /* 忽略 */ } }
      clearDestMarker(); clearActImage();
      if (el('aMode')) { el('aMode').value = 'once'; syncModeUI(); }
      loadActivities();
    } catch (e) { toastErr(e.message); }
  });

  // 填充发布表单依赖的下拉（可签到子活动 / 长期活动 / 班级签到当天活动）
  function fillPublishActivities() {
    if (!publishActs.length) return;
    const occ = publishActs.filter(a => !a.is_group);
    if (el('opsActivity')) el('opsActivity').innerHTML = occ.length
      ? occ.map(a => `<option value="${a.id}">${escapeHtml(a.title)} · ${fmtDateTime(a.start_time)}</option>`).join('')
      : '<option value="">暂无活动</option>';
    const mains = publishActs.filter(a => a.is_group);
    if (el('aParent')) el('aParent').innerHTML = mains.length
      ? mains.map(a => `<option value="${a.id}">${escapeHtml(a.title)}（${publishActs.filter(x => x.parent_id === a.id).length} 子活动）</option>`).join('')
      : '<option value="">暂无长期活动</option>';
    if (el('rosterActivity')) fillRosterActivities();
  }

  /* ---------------- 班级签到视图 ---------------- */
  const LEGEND = [
    { k: 'signed', t: '已签到' }, { k: 'ontheway', t: '在途中' }, { k: 'leave', t: '请假' },
    { k: 'absent', t: '缺勤' }, { k: 'none', t: '待签到' }
  ];
  function fillRosterActivities() {
    const day = el('rosterDate').value;
    const list = publishActs.filter(a => !a.is_group && fmtDate(a.start_time) === day);
    if (el('rosterActivity')) el('rosterActivity').innerHTML = list.length
      ? list.map(a => `<option value="${a.id}">${escapeHtml(a.title)} · ${fmtTime(a.start_time)}~${fmtTime(a.end_time)}</option>`).join('')
      : '<option value="">当天无活动</option>';
  }
  if (el('rosterDate')) {
    el('rosterDate').value = fmtDate(Date.now());
    // 选日期 → 重填活动下拉并直接加载；选活动 → 直接加载（不再需要「查看」按钮）
    el('rosterDate').addEventListener('change', () => { fillRosterActivities(); loadRoster(); });
  }
  if (el('rosterActivity')) el('rosterActivity').addEventListener('change', loadRoster);

  async function loadRoster() {
    const id = el('rosterActivity').value;
    if (!id) { if (el('rosterLegend')) el('rosterLegend').innerHTML = ''; if (el('rosterGrid')) el('rosterGrid').innerHTML = '<div class="empty">当天没有活动</div>'; return; }
    try {
      const d = await api.get('api/admin/checkins?activity_id=' + id);
      // 活动结束后：「在途中」「待签到」已折算为「缺勤」，图例与汇总都不再展示这两个标签
      const ended = d.activity && d.activity.end_time && Date.now() > d.activity.end_time;
      if (el('rosterLegend')) el('rosterLegend').innerHTML = (ended ? LEGEND.filter(l => l.k !== 'ontheway' && l.k !== 'none') : LEGEND)
        .map(l => `<span class="legend"><i class="sw ${l.k}"></i>${l.t}</span>`).join('');
      const rows = d.roster || [];
      if (!rows.length) { if (el('rosterGrid')) el('rosterGrid').innerHTML = '<div class="empty">暂无班级成员，请先在「用户管理」中添加</div>'; return; }
      // display_status 取值：signed / ontheway / leave / absent / pending（待签到）
      const stat = { signed: 0, ontheway: 0, leave: 0, absent: 0, none: 0 };
      rows.forEach(r => {
        const k = r.display_status || 'pending';
        if (k === 'pending') stat.none += 1;
        else if (stat[k] !== undefined) stat[k] += 1;
      });
      const tw = ended ? '' : `<span class="badge ontheway">途中 ${stat.ontheway}</span>`;
      const pd = ended ? '' : `<span class="badge pending">待签到 ${stat.none}</span>`;
      if (el('rosterGrid')) el('rosterGrid').innerHTML =
        `<div class="row roster-summary" style="margin-bottom:10px">
           <span class="tag">共 ${rows.length} 人</span>
           <span class="badge signed">签到 ${stat.signed}</span>
           ${tw}
           <span class="badge leave">请假 ${stat.leave}</span>
           <span class="badge absent">缺勤 ${stat.absent}</span>
           ${pd}
         </div>` +
        rows.map(r => {
          const raw = r.display_status || 'pending';
          const st = raw === 'pending' ? 'none' : raw;   // 样式类沿用 none（虚线待签到卡）
          const locOff = document.body.classList.contains('loc-disabled');
          const showLoc = !locOff && r.has_location;
          const locCls = showLoc ? (r.in_fence === 1 ? 'in' : (r.in_fence === 0 ? 'out' : 'na')) : 'none';
          const locTip = showLoc
            ? (r.in_fence === 1 ? '已上传定位·活动范围内' : (r.in_fence === 0 ? '已上传定位·活动范围外' : '已上传定位·未配置活动范围'))
            : '';
          const nmLen = [...(r.real_name || '')].length;
          const nmCls = nmLen > 12 ? ' xlong' : (nmLen > 7 ? ' long' : '');
          return `<div class="person ${st}" data-uid="${r.user_id}" data-has-loc="${showLoc ? 1 : 0}" title="${escapeHtml(r.real_name)}（${escapeHtml(r.student_id || '-')}）· ${checkinStatusText(raw)}${showLoc ? ' · 点击查看该生定位' : ''}">
            ${showLoc ? `<span class="loc-badge ${locCls}" title="${locTip}">📍</span>` : ''}
            <span class="nm${nmCls}">${escapeHtml(r.real_name)}</span><small>${escapeHtml(r.student_id || '')}</small></div>`;
        }).join('');
      Array.from(el('rosterGrid').querySelectorAll('.person .nm')).forEach(nmEl => {
        nmEl.style.fontSize = '';
        let fs = parseFloat(getComputedStyle(nmEl).fontSize) || 15;
        const avail = nmEl.clientWidth;
        while (avail && nmEl.scrollWidth > avail + 1 && fs > 9) { fs -= 0.5; nmEl.style.fontSize = fs + 'px'; }
      });
    } catch (e) { toastErr(e.message); }
  }

  /* ---------------- 班级签到视图卡片点击：查看学生定位 ---------------- */
  let stuLocMap = null;
  /** 无定位 / 核验关闭时：仅展示签到信息的浮窗（复用 stuLocModal） */
  async function showStudentInfo(uid, activityId) {
    try {
      const d = await api.get(`api/admin/locations?activity_id=${activityId}&user_id=${uid}`);
      const loc = d.locations && d.locations[0];
      const mask = el('stuLocModal');
      const mapBox = el('stuLocMap');
      const info = el('stuLocInfo');
      const title = el('stuLocTitle');
      if (!mask || !info) return;
      const name = loc ? loc.real_name : '';
      const sid = loc ? (loc.student_id || '-') : '';
      title.textContent = name ? `${name}（${sid}）的签到信息` : '签到信息';
      const statusMap = { signed: '已签到', ontheway: '在途中', leave: '请假', cancelled: '退签', absent: '缺勤', pending: '待签到' };
      const st = loc ? (statusMap[loc.status] || loc.status || '未知') : '无记录';
      const signedAt = (loc && loc.created_at) ? new Date(loc.created_at).toLocaleString('zh-CN') : '—';
      const locDisabled = document.body.classList.contains('loc-disabled');
      const locNote = '暂无更多信息';
      info.innerHTML = `<b>${st}</b> · 签到时间：${signedAt}<br><span class="muted">${locNote}</span>`;
      // 隐藏地图区域
      if (mapBox) mapBox.style.display = 'none';
      mask.classList.remove('hidden');
      const closeModal = () => { mask.classList.add('hidden'); if (mapBox) mapBox.style.display = ''; };
      mask.onclick = e => { if (e.target === mask) closeModal(); };
    } catch (e) {
      toastErr(e.message || '获取签到信息失败');
    }
  }
  async function showStudentLocation(uid, activityId) {
    try {
      const d = await api.get(`api/admin/locations?activity_id=${activityId}&user_id=${uid}`);
      const loc = d.locations && d.locations[0];
      if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
        toast('该学生未上传有效定位'); return;
      }
      const mask = el('stuLocModal');
      const mapBox = el('stuLocMap');
      const info = el('stuLocInfo');
      const title = el('stuLocTitle');
      if (!mask || !mapBox) return;
      title.textContent = `${loc.real_name}（${loc.student_id || '-'}）的定位`;
      const fenceText = loc.in_fence === 1 ? '活动范围内' : (loc.in_fence === 0 ? '活动范围外' : '未配置活动范围');
      const statusMap = { signed: '已签到', ontheway: '在途中', leave: '请假', cancelled: '退签', absent: '缺勤' };
      const stText = statusMap[loc.status] || loc.status || '未知';
      const signedAt = loc.created_at ? new Date(loc.created_at).toLocaleString('zh-CN') : '未知';
      info.innerHTML = `<b>${stText}</b> · 签到时间：${signedAt}<br>精度 ±${Math.round(loc.accuracy || 0)} 米 · ${fenceText}<br>该位置信息为学生点击签到按钮时由设备获取的一次性定位，非实时追踪；仅供考勤核验参考。`;
      if (mapBox) mapBox.style.display = '';
      mask.classList.remove('hidden');
      if (stuLocMap) { stuLocMap.remove(); stuLocMap = null; }
      // 底图统一走高德（境内服务，无需密钥），不再请求境外地图服务的瓦片；
      // 学生上传的是浏览器原始坐标（WGS-84），与高德 GCJ-02 底图有偏移，
      // 显示前统一做一次坐标转换（与用户端「查看活动范围」的做法一致）。
      const [dlng, dlat] = wgs84ToGcj02(loc.lng, loc.lat);
      stuLocMap = L.map(mapBox, { center: [dlat, dlng], zoom: 16 });
      L.tileLayer(DEST_TILE.url, { attribution: DEST_TILE.attribution, subdomains: DEST_TILE.subdomains, maxZoom: 18 }).addTo(stuLocMap);
      L.marker([dlat, dlng]).addTo(stuLocMap);
      const closeModal = () => { mask.classList.add('hidden'); if (stuLocMap) { stuLocMap.remove(); stuLocMap = null; } };
      mask.onclick = e => { if (e.target === mask) closeModal(); };
    } catch (e) {
      toastErr(e.message || '获取定位失败');
    }
  }
  if (el('rosterGrid')) el('rosterGrid').addEventListener('click', e => {
    const card = e.target.closest('.person');
    if (!card) return;
    const uid = card.getAttribute('data-uid');
    const actSel = el('rosterActivity');
    const aid = actSel ? Number(actSel.value) : 0;
    if (!aid) { toast('请先选择活动'); return; }
    const locDisabled = document.body.classList.contains('loc-disabled');
    const hasLoc = card.getAttribute('data-has-loc') === '1';
    // 核验开关开启且有定位 → 显示地图+签到信息；否则仅显示签到信息
    if (!locDisabled && hasLoc) {
      showStudentLocation(uid, aid);
    } else {
      showStudentInfo(uid, aid);
    }
  });

  /* ---------------- 补签 / 退签 / 代请假 ---------------- */
  // 选择活动即加载（不再需要「查看」按钮）
  if (el('opsActivity')) el('opsActivity').addEventListener('change', loadOps);
  async function loadOps() {
    const id = el('opsActivity').value;
    if (!id) {
      // 未选活动：不要弹 toast（会在切页 / 截图时残留），只在列表区显示空态
      if (el('opsRows')) el('opsRows').innerHTML = '<tr><td colspan="6"><div class="empty">请先在上方选择活动</div></td></tr>';
      return;
    }
    try {
      // 运维者为最高权限，无需 manager 端的层级门禁（level<3 限制）
      const d = await api.get('api/admin/checkins?activity_id=' + id);
      const rows = d.roster || [];
      const ended = !d.activity || Date.now() > d.activity.end_time;
      if (el('opsRows')) el('opsRows').innerHTML = rows.length ? rows.map(r => {
        const signed = r.status === 'signed';
        const onLeave = r.status === 'leave' || r.leave_status === 'approved' || r.leave_status === 'pending';
        // 运维端（本页仅运维者可进）：允许活动进行中代签，故只拦截「已签到」；但已请假者同样不可再代请
        const supDisabled = signed;
        const supTitle = signed ? '该学生已签到，无需补签' : '补签（运维者可在活动进行中代签）';
        const leaveDisabled = signed || onLeave;
        const leaveTitle = signed ? '该学生已签到，无需请假'
          : (onLeave ? '该学生已请假（含待审/已准），无需重复代请假' : '代请假');
        return `
        <tr>
          <td>${escapeHtml(r.student_id || '-')}</td>
          <td>${escapeHtml(r.real_name)}</td>
          <td>${r.display_status ? badge(r.display_status) : checkinBadge('pending')}</td>
          <td>${document.body.classList.contains('loc-disabled') ? '—'
            : (r.in_fence === null || r.in_fence === undefined
              ? (r.status ? '未采集定位' : '—')
              : (r.in_fence ? '<span class="badge signed">活动范围内</span>' : '<span class="badge cancelled">活动范围外</span>'))}</td>
          <td>${r.created_at ? fmtDateTime(r.created_at) : '-'}</td>
          <td class="row ops-actions">
            <button class="btn sm ok" data-sup="${r.user_id}" ${supDisabled ? 'disabled' : ''} title="${supTitle}">补签</button>
            <button class="btn sm danger" data-uns="${r.user_id}" ${signed ? '' : 'disabled'} title="${signed ? '退签（已签到）' : '该学生尚未签到，无法退签'}">退签</button>
            <button class="btn sm warn" data-leave="${r.user_id}" ${leaveDisabled ? 'disabled' : ''} title="${leaveTitle}">代请假</button>
          </td>
        </tr>`;
      }).join('') : '<tr><td colspan="6"><div class="empty">暂无班级成员</div></td></tr>';

      const aid = Number(id);
      qsa('#opsRows [data-sup]').forEach(b => b.addEventListener('click', async () => {
        const ok = await confirmDialog('确认补签', '该操作会直接把该普通学生记为「已签到」，并发送回执提醒。', '确认补签');
        if (!ok) return;
        adminAct('supplement', b.getAttribute('data-sup'), aid, 'supplement');
      }));
      qsa('#opsRows [data-uns]').forEach(b => b.addEventListener('click', async () => {
        const ok = await confirmDialog('确认退签', '退签会撤销该学生的签到记录，并发送回执提醒。', '确认退签', true);
        if (!ok) return;
        adminAct('supplement', b.getAttribute('data-uns'), aid, 'cancel');
      }));
      qsa('#opsRows [data-leave]').forEach(b => b.addEventListener('click', async () => {
        const reason = await promptText('代请假', '该操作会直接把该普通学生记为「请假」，并发送回执提醒。', '例如：已电话确认因病缺席', true);
        if (reason === null) return;
        try { await api.post('api/admin/leave-for-user', { user_id: b.getAttribute('data-leave'), activity_id: aid, reason }); toast('已代请假'); loadOps(); }
        catch (e) { toastErr(e.message); }
      }));
    } catch (e) { toastErr(e.message); }
  }
  async function adminAct(path, userId, activityId, action) {
    try {
      // 用户 id 为非纯数字字符串（如 yHsfG2），不能 Number() 强转（NaN→null 会被后端判为未选择）
      await api.post('api/admin/' + path, { user_id: userId, activity_id: activityId, action });
      toast(action === 'cancel' ? '已退签' : '已补签');
      loadOps();
      if (Number(el('rosterActivity').value) === activityId) loadRoster();
    } catch (e) { toastErr(e.message); }
  }

  /* ---------------- 日历与报告 ---------------- */
  // 班级集体聚合：管理员与运维者均可查看 / 操作（后端 /class 已对两角色放行）。
  // 个人模式需选具体学生；班级集体模式按全员普通学生聚合，无需选人。
  if (el('cMode')) el('cMode').addEventListener('change', () => {
    if (el('cUser')) el('cUser').classList.toggle('hidden', el('cMode').value !== 'person');
    loadCalendar();
  });
  if (el('cUser')) el('cUser').classList.add('hidden');
  if (el('cMonth')) { el('cMonth').value = currentMonth(); el('cMonth').addEventListener('change', loadCalendar);  }
  if (el('cUser')) el('cUser').addEventListener('change', loadCalendar);
  if (el('rUser')) el('rUser').addEventListener('change', loadReport);
  async function loadCalendar() {
    const month = el('cMonth').value || currentMonth();
    const box = el('calBox');
    try {
      if (el('cMode') && el('cMode').value === 'person') {
        const uid = el('cUser') && el('cUser').value;
        if (!uid) {
          box.innerHTML = '<div class="empty">请先在上方选择要查看的普通学生</div>';
          resetCalendarDetail(el('calDetailBox'));
          return;
        }
        const d = await api.get(`api/calendar/person/${uid}?month=${month}`);
        renderCalendar(box, d.month, d.days, el('calDetailBox'));
        box.insertAdjacentHTML('afterbegin', `<div class="row" style="margin-bottom:10px">
             <span class="tag">个人日历</span><b>${escapeHtml(d.user.real_name)}（${escapeHtml(d.user.student_id || '无学号')}）</b>
             <span class="tag">出勤率 ${d.attendance_rate}%</span></div>`);
      } else {
        const d = await api.get('api/calendar/class?month=' + month);
        renderCalendar(box, d.month, d.days, el('calDetailBox'));
        const agg = { signed: 0, ontheway: 0, leave: 0, absent: 0, pending: 0 };
        Object.values(d.days).forEach(arr => (arr || []).forEach(it => ['signed', 'ontheway', 'leave', 'absent', 'pending'].forEach(k => { agg[k] += (it.counts && it.counts[k]) || 0; })));
        const members = (d.members || []).length;
        const actN = d.activity_count || 0;
        box.insertAdjacentHTML('afterbegin', `<div class="row" style="margin-bottom:10px">
             <span class="tag">班级集体日历</span><span class="tag">成员 ${members} 人</span>
             <span class="tag">当月活动 ${actN} 场</span>
             ${members === 0 && actN === 0 ? '<span class="tag muted">（暂无普通学生 / 该月无活动）</span>' : ''}</div>`);
      }
    } catch (e) { toastErr(e.message); }
  }
  function showReportHint() {
    if (el('reportBox')) el('reportBox').innerHTML = '<div class="empty">请选择学生，报告将自动生成</div>';
  }
  async function loadReport() {
    const uid = el('rUser') && el('rUser').value;
    if (!uid) return showReportHint();
    try {
      const r = await api.get('api/calendar/report/' + uid);
      el('reportBox').innerHTML = `
        <div class="grid cols-4">
          <div class="stat accent"><div class="num">${r.attendance_rate}%</div><div class="label">签到率</div></div>
          <div class="stat ok"><div class="num">${r.signed}</div><div class="label">已签到</div></div>
          <div class="stat warn"><div class="num">${r.leave}</div><div class="label">请假</div></div>
          <div class="stat danger"><div class="num">${r.absent}</div><div class="label">缺勤</div></div>
        </div>
        <div class="row" style="margin-top:12px">
          <span class="tag">活动总数 ${r.total_activities}</span><span class="tag">已结束 ${r.signed + r.ontheway + r.leave + r.absent}</span>
          <span class="tag">待开始 ${r.pending}</span><span class="tag">在途中 ${r.ontheway}</span>
          <span class="tag">已退签 ${r.cancelled}</span><span class="tag">管理员补签 ${r.manual}</span>
          <span class="tag">活动范围内签到 ${r.in_fence}</span><span class="tag">活动范围外记录 ${r.out_fence}</span>
          <span class="tag">有效出勤率 ${r.effective_rate}%（已结束子活动）</span>
        </div>`;
    } catch (e) { toastErr(e.message); }
  }
  /** 优雅的空下拉占位：禁用 + 置灰 + 默认选中，既提示「无数据」又不会被误选提交 */
  function emptyOpt(label) {
    return `<option value="" disabled selected style="color:var(--muted)">${escapeHtml(label || '（暂无可选数据）')}</option>`;
  }
  async function loadUserOptions() {
    try {
      // 只列普通学生：日历/报告是针对学生出勤的，运维者与管理员账号不应出现在选人下拉里
      const d = await api.get('api/admin/users?role=normal');
      const members = d.users || [];
      // 占位项 disabled + hidden：默认提示「请选择学生」，且不会作为可选项出现在列表里
      const opts = members.length
        ? '<option value="" disabled hidden selected>请选择学生…</option>' + members.map(u => `<option value="${u.id}">${escapeHtml(u.real_name)}（${escapeHtml(u.student_id || '-')}）</option>`).join('')
        : emptyOpt('（暂无普通学生，无法生成报告）');
      if (el('cUser')) el('cUser').innerHTML = opts;
      if (el('rUser')) {
        const sel = el('rUser');
        const keep = sel.value;
        // 报告下拉默认不预选任何人（显示“请选择学生…”占位），选中后自动生成
        sel.innerHTML = '<option value="" disabled hidden selected>请选择学生…</option>'
          + (members.length
              ? members.map(u => `<option value="${u.id}">${escapeHtml(u.real_name)}（${escapeHtml(u.student_id || '-')}）</option>`).join('')
              : '');
        sel.value = '';
        if (keep && members.some(u => String(u.id) === String(keep))) sel.value = keep;
        if (sel.value) loadReport(); else showReportHint();
      }
    } catch (e) { toastErr(e.message); }
  }

  window.onSectionChange = function (name) {
    if (name === 'workorders') { loadInbox(); loadResets(); }
    if (name === 'accounts') { loadManagers(); loadUsers(); }
    if (name === 'publish') { ensureDestMap(); loadActivities(); refreshFenceOptions(); }
    if (name === 'activities') { loadActivities(); }
    if (name === 'roster') { loadActivities().then(loadRoster); }
    if (name === 'ops') { loadActivities().then(loadOps); }
    if (name === 'calendar') { loadUserOptions().then(loadCalendar); }
    if (name === 'fences') loadFences();
    if (name === 'stream') loadStream();
    if (name === 'devices') loadDevices();
    if (name === 'maintenance') loadMaint();
    if (name === 'security') { loadDfSettings(); loadMlv(); loadLv(); loadAutoCover(); loadAnnouncement(); loadSettings(); }
    // 账号信息分区由 account-info.js 负责渲染
    if (name === 'accountinfo') { /* no-op */ }
    if (name === 'dashboard') loadStats();
    if (name === 'msg' && window.NotifyCenter) window.NotifyCenter.open();
  };

  /* 从「活动范围」独立页（fence.html）新建/删除范围后，经 history.back 返回本页时，
   * 浏览器使用 bfcache 内存缓存、不重跑 init，导致活动范围列表不刷新，需手动刷新。
   * 这里在页面经 bfcache 恢复、或重新可见且正处于「活动范围」分区时自动刷新列表与发布表单下拉。 */
  function reloadFencesIfActive() {
    const sec = document.querySelector('.section.active');
    if (!sec || sec.id !== 'sec-fences') return;
    if (window.initFencePanel) window.initFencePanel();   // 刷新 fenceBox 列表
    loadFences();                                          // 刷新发布表单的 aFence 下拉
  }
  window.addEventListener('pageshow', (e) => { if (e.persisted) reloadFencesIfActive(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reloadFencesIfActive(); });

  /* ---------------- 我的登录设备 ---------------- */
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
    // 按 session_id 精确结束某台设备（一手机 + 一电脑，互不串号）
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


  el('logoutBtn').addEventListener('click', async () => {
    const yes = await confirmDialog(
      '退出登录',
      '确认退出登录吗？本机记住的账号与密码会保留，方便下次一键登录。',
      '退出登录'
    );
    if (!yes) return;
    await logout();
  });

  // 账号信息分区内的「展开 / 收起」面板由 initToggles 统一处理（修改密码等逻辑已收归 account-info.js）
  initToggles();


  // --- Batch select logic ---
  function syncDvActBatchUI() {
    const cbs = qsa('.dv-act-cb:not(:disabled)');
    const checked = qsa('.dv-act-cb:checked');
    const allBtn = el('dvActBatchDel');
    const info = el('dvActSelectedInfo');
    const selAll1 = el('dvActSelectAll');
    const selAll2 = el('dvActSelectAll2');
    if (allBtn) allBtn.disabled = checked.length === 0;
    if (info) info.textContent = checked.length > 0 ? '已选 ' + checked.length + ' 项' : '';
    const allChecked = cbs.length > 0 && checked.length === cbs.length;
    if (selAll1) selAll1.checked = allChecked;
    if (selAll2) selAll2.checked = allChecked;
  }

  // 全选按钮事件（延迟绑定，确保 DOM 存在）
  function bindBatchSelectAll() {
    [el('dvActSelectAll'), el('dvActSelectAll2')].forEach(sel => {
      if (!sel || sel._batchBound) return;
      sel._batchBound = true;
      sel.addEventListener('change', () => {
        const checked = sel.checked;
        qsa('.dv-act-cb:not(:disabled)').forEach(cb => {
          cb.checked = checked;
          const id = cb.dataset.id;
          if (checked) dvActSelected.add(id); else dvActSelected.delete(id);
        });
        syncDvActBatchUI();
      });
    });
  }

  // 批量删除按钮事件
  function bindBatchDel() {
    const btn = el('dvActBatchDel');
    if (!btn || btn._batchBound) return;
    btn._batchBound = true;
    btn.addEventListener('click', async () => {
      const ids = [...dvActSelected];
      if (ids.length === 0) return;
      if (!confirm('确定要批量删除选中的 ' + ids.length + ' 个活动吗？\n注意：包含子活动的记录也会一并删除。')) return;
      try {
        const res = await fetch(P('api/activities/bulk-delete'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids })
        });
        const data = await res.json();
        if (data.ok !== false) {
          dvActSelected.clear();
          toastOk(data.message || '批量删除成功');
          loadActivities();
        } else {
          toastErr(data.error || data.message || '批量删除失败');
        }
      } catch (e) {
        toastErr('请求失败: ' + e.message);
      }
    });
  }

  // 在每次渲染活动后重新绑定批量操作
  const _origRenderActivities = renderActivities;
  renderActivities = function() {
    _origRenderActivities();
    bindBatchSelectAll();
    bindBatchDel();
  };

  init();
})();
