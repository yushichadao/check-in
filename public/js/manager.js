(function () {
  let me = null;
  let myPerm = null;        // /api/auth/me 返回的权限态
  let activities = [];
  let members = [];
  let actPage = 1;
  let actPageSize = 10;
  let actSortOrder = 'smart';
  let actFilter = 'upcoming';
  let actSearch = '';
  const actSelected = new Set();

  let streamAll = [];
  let streamPage = 1;
  let streamPageSize = 15;

  function sortedActivities() {
    return activities.slice().sort((a, b) => {
      const d = (a.start_time || 0) - (b.start_time || 0);
      return actSortOrder === 'desc' ? -d : d;
    });
  }
  /** 树形渲染的统计结果（由 filteredTreeRows 写入，分页只对顶层节点计数） */
  const renderState = { total: 0, pages: 1 };

  function pageItems() {
    const rows = filteredTreeRows();
    return { items: rows.map(r => r.act), total: renderState.total, pages: renderState.pages };
  }

  async function init() {
    let data;
    try {
      data = await api.get('api/auth/me');
      me = data.user;
      if (me.role !== 'manager') { goto(data.redirect); return; }
      myPerm = data.perm || { level: 0, perms: {} };
    } catch (e) {
      goto('login.html');
      return;
    }
    // 权限门禁：高危未授权控件灰度 + 点击弹工单
    if (window.PermGate) {
      PermGate.init(myPerm);
      PermGate.apply(document);
    }
    el('whoBar').innerHTML =
      `${escapeHtml(me.real_name)}<small>${escapeHtml(me.role_title)} · 管理端</small>`;
    if (el('switchAccountBtn') && !hasSwitchableAccounts()) el('switchAccountBtn').classList.add('hidden');
    // 账号信息分区（基本信息 / 账号安全 / 通知偏好）统一由 account-info.js 渲染（管理端本人不签到，无定位授权）
    if (window.AccountInfo) AccountInfo.init({ me });

    if (me.must_change_pwd) {
      el('pwdAlert').innerHTML = '<div class="alert warn">当前为初始密码，请尽快在「账号信息」中修改密码。</div>';
    }

    el('cMonth').value = currentMonth();
    const [pub] = await Promise.all([
      api.get('api/settings/public').catch(() => ({})),
      loadFences(), loadActivities(), loadUsers(), loadStats()
    ]);
    document.body.classList.toggle('loc-disabled', !pub.location_verify_enabled);
    initSections('dashboard');
  }

  /* ---------------- 概览 ---------------- */
  async function loadStats() {
    try {
      const s = await api.get('api/stream/stats');
      const c = s.counts;
      // 数据概览：仅统计「长期活动」，子活动不计入，避免重复膨胀
      el('mStats').innerHTML = `
        <div class="stat accent"><div class="num">${c.normal_users}</div><div class="label">用户端账号</div><div class="sub">班级人数 · 在册普通学生</div></div>
        <div class="stat warn"><div class="num">${c.unactivated_users || 0}</div><div class="label">未激活账号</div><div class="sub">已建档 · 未设置密码</div></div>
        <div class="stat"><div class="num">${c.cancelled_users || 0}</div><div class="label">已注销账号</div><div class="sub">已注销归档 · 不计入在册</div></div>
        <div class="stat"><div class="num">${c.parent_activities}</div><div class="label">长期活动</div><div class="sub">含长期活动分组</div></div>
        <div class="stat"><div class="num">${c.activities}</div><div class="label">活动总数</div><div class="sub">含长期子活动</div></div>
      `;
      // 待办提醒：签到人次 / 待审请假 明确标注为「全站」，避免与单场活动混淆
      const todos = [{ text: `全站累计签到：${c.signed} 人次（所有活动合计）`, type: 'info' }];
      if (c.pending_leaves) todos.push({ text: `待审核请假申请：${c.pending_leaves} 条（普通学生提交、待审批）`, type: 'warn' });
      if (c.pending_resets) todos.push({ text: `待处理找回密码申请：${c.pending_resets} 条`, type: 'warn' });
      el('mTodo').innerHTML = todos.length
        ? todos.map(t => `<div class="alert ${t.type}">${escapeHtml(t.text)}</div>`).join('')
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
      el('mToday').innerHTML = items.length
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

  /* ---------------- 活动范围 / 活动 ---------------- */
  async function loadFences() {
    try {
      const d = await api.get('api/fences');
      fenceList = d.fences || [];
      el('aFence').innerHTML = '<option value="0">未设置</option>' + fenceList
        .map(f => `<option value="${f.id}">${escapeHtml(f.name)}${f.polygons && f.polygons.length > 1 ? `（${f.polygons.length}范围）` : ''}</option>`).join('');
    } catch (e) { /* 忽略 */ }
  }

  async function loadActivities() {
    try {
      const d = await api.get('api/activities');
      activities = d.activities || [];
      renderActivities();

      // 可签到的子活动（排除长期活动分组）
      const occ = activities.filter(a => !a.is_group);
      el('opsActivity').innerHTML = occ.length
        ? occ.map(a => `<option value="${a.id}">${escapeHtml(a.title)} · ${fmtDateTime(a.start_time)}</option>`).join('')
        : '<option value="">暂无活动</option>';

      // 可添加活动的长期活动（子项数从本地活动列表统计）
      const mains = activities.filter(a => a.is_group);
      el('aParent').innerHTML = mains.length
        ? mains.map(a => {
            const n = activities.filter(x => x.parent_id === a.id).length;
            return `<option value="${a.id}">${escapeHtml(a.title)}（${n} 子活动）</option>`;
          }).join('')
        : '<option value="">暂无长期活动</option>';

      fillRosterActivities();
    } catch (e) { toastErr(e.message); }
  }

  /** 长期活动子项：默认收起，点击展开（减少长列表 clutter，尤其是含大量子项的长期任务） */
  const actExpanded = new Set();

  /** 长期活动时间区间：全部活动的最早开始 ~ 最晚结束；无子项显示「长期 / 循环」 */
  function aggregateRange(main) {
    const kids = activities.filter(a => a.parent_id === main.id);
    if (!kids.length) {
      return main.recurring
        ? '长期 / 循环'
        : fmtRange(main.start_time, main.end_time);
    }
    const s = Math.min.apply(null, kids.map(k => k.start_time));
    const e = Math.max.apply(null, kids.map(k => k.end_time));
    return `${fmtDate(s)} ~ ${fmtDate(e)}（${kids.length} 个子活动）`;
  }

  function renderActivities() {
    const { total, pages } = pageItems();
    const rows = filteredTreeRows();

    el('actRows').innerHTML = rows.length
      ? rows.map(r => {
        const a = r.act;
        const isMain = r.kind === 'main';
        const isChild = r.kind === 'child';
        const indent = isChild ? 'padding-left:26px;' : '';
        const kids = r.children || 0;
        const expanded = actExpanded.has(a.id);
        const caret = isMain
          ? (kids
            ? `<button type="button" class="tree-toggle${expanded ? ' open' : ''}" data-fold="${a.id}" aria-expanded="${expanded}" title="${expanded ? '收起活动' : '展开活动'}">${expanded ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:2px"><polyline points="6 9 12 15 18 9"/></svg> 收起' : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:2px"><polyline points="9 6 15 12 9 18"/></svg> 展开'}</button> `
            : '<span class="tree-caret leaf">•</span> ')
          : (isChild ? '<span class="tree-caret leaf">└</span>' : '<span class="tree-caret leaf">•</span>');
        // 折叠列固定宽度：标题与下方地点 / 备注左对齐到同一竖线（与运维端一致）
        const name = `
          <div class="act-title-line"><span class="act-name">${escapeHtml(a.title)}</span></div>
          ${safePlace(a.location) ? `<div class="muted" style="font-size:12px;margin-top:3px">📍 ${escapeHtml(safePlace(a.location))}</div>` : ''}
          ${a.remark ? `<div class="muted" style="font-size:12px;margin-top:2px">${escapeHtml(a.remark)}</div>` : ''}`;
        // 标签口径：长期活动 / 子活动（长期下的活动）/ 临时（独立单场）
        const type = isMain
          ? `<span class="badge manual" title="长期活动">长期</span>${r.children ? `<span class="tag">${r.children} 子活动</span>` : ''}`
          : (isChild ? `<span class="badge" title="长期活动下的活动">子活动</span>${r.cont ? '<span class="tag" title="接上一页的同一长期活动">续</span>' : ''}` : '<span class="badge">临时</span>');
        const phase = phaseBadge(a);
        const time = isMain ? aggregateRange(a) : fmtRange(a.start_time, a.end_time);
        const canDel = !!a.can_delete;
        const checked = (canDel && actSelected.has(a.id)) ? 'checked' : '';
        const delReason = a.can_delete ? '' : (a.delete_reason || '无删除权限，或仅上级管理员 / 运维者可删除他人创建的活动');
        const cbTitle = canDel ? '' : (delReason || '该活动您无法删除，不能勾选');
        return `<tr class="${isMain ? 'tree-main' : (isChild ? 'tree-child' : '')}">
          <td><input type="checkbox" class="act-cb" data-id="${a.id}" ${checked}${canDel ? '' : ' disabled'}${cbTitle ? ` title="${escapeHtml(cbTitle)}"` : ''}></td>
          <td class="act-caret-col">${caret}</td>
          <td style="${indent}">${name}</td>
          <td>${time}</td>
          <td>${escapeHtml(a.window_text || '')}</td>
          <td>${phase}</td>
          <td>${escapeHtml(a.policy_text || '')}</td>
          <td>${a.fence_id ? escapeHtml(a.fence_name || '-') : '不使用'}${(a.dest_lng != null && a.dest_lat != null) ? ' <span class="tag" title="已设置目的地标记">📍 终点</span>' : ''}${a.image_count ? ` <span class="tag" title="已配置图 ${a.image_count} 张">🖼 配图${a.image_count > 1 ? '×' + a.image_count : ''}</span>` : ''}</td>
          <td>${type}</td>
          <td>${objMetaHtml(a.created_at, a.creator_name, a.creator_role)}</td>
          <td class="row" style="gap:6px">
            <button class="btn sm" data-adetail="${a.id}">活动详情</button>
            ${canDel ? `<button class="btn sm danger" data-del="${a.id}">删除</button>` : `<button class="btn sm danger" data-del="${a.id}" disabled title="${escapeHtml(delReason)}">删除</button>`}
          </td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="11"><div class="empty">暂无活动</div></td></tr>';

    const _countable = activities.filter(a => !a.is_group);
    const _now = Date.now();
    const _upcoming = _countable.filter(a => (a.end_time||0) >= _now).length;
    const _history = _countable.length - _upcoming;
    el('actPageInfo').textContent = `待开展 ${_upcoming} / 已结束 ${_history} / 全部 ${_countable.length}`;
    const pageInput = el('actPageInput');
    const totalPagesEl = el('actTotalPages');
    if (pageInput) { pageInput.value = actPage; pageInput.max = pages; }
    if (totalPagesEl) totalPagesEl.textContent = pages;
    if (el('actPrev')) el('actPrev').disabled = actPage <= 1;
    if (el('actNext')) el('actNext').disabled = actPage >= pages;
    syncActBatchUI();

    qsa('#actRows [data-fold]').forEach(b => b.addEventListener('click', () => {
      const id = Number(b.getAttribute('data-fold'));
      if (actExpanded.has(id)) actExpanded.delete(id); else actExpanded.add(id);
      renderActivities();
    }));

    qsa('#actRows [data-del]').forEach(b => b.addEventListener('click', async () => {
      const id = Number(b.getAttribute('data-del'));
      const target = activities.find(a => a.id === id);
      const extra = target && target.is_group ? '（含其下所有活动）' : '';
      if (!await confirmBox('确认删除该活动' + extra + '？相关签到记录也会一并删除；删除后可由上级管理员 / 运维者协助恢复（保留操作记录）。')) return;
      try {
        await api.del('api/activities/' + id);
        actSelected.delete(id);
        toast('已删除');
        loadActivities();
      } catch (e) { toastErr(e.message); }
    }));

    qsa('#actRows [data-adetail]').forEach(b => b.addEventListener('click', () => {
      openActivityDetail(Number(b.getAttribute('data-adetail')));
    }));
    qsa('#actRows .act-cb').forEach(cb => cb.addEventListener('change', () => {
      const id = cb.getAttribute('data-id');
      if (cb.checked) actSelected.add(id); else actSelected.delete(id);
      syncActBatchUI();
    }));
  }

  /** 某活动的「结束时间」：长期活动取其最晚的子活动结束时间 */
  function actEnd(a) {
    return a.is_group ? childEnd(a) : a.end_time;
  }
  /** 阶段徽标：待开展 / 进行中 / 已结束 */
  function phaseBadge(a) {
    const now = Date.now();
    const end = actEnd(a);
    if (now < a.start_time) return '<span class="badge pending" title="活动阶段">待开展</span>';
    if (now > end) return '<span class="badge cancelled" title="活动阶段">已结束</span>';
    return '<span class="badge signed" title="活动阶段">进行中</span>';
  }
  /** 按标签 / 排序规则得到有序的顶层节点列表 */
  function sortTops(tops) {
    const now = Date.now();
    const timeCmp = (x, y) => (x.start_time || 0) - (y.start_time || 0);
    if (actSortOrder === 'name' || actSortOrder === 'name_desc') {
      const c = (x, y) => String(x.title || '').localeCompare(String(y.title || ''), 'zh');
      return tops.slice().sort((x, y) => actSortOrder === 'name_desc' ? -c(x, y) : c(x, y));
    }
    if (actSortOrder === 'asc') return tops.slice().sort((x, y) => timeCmp(x, y));
    if (actSortOrder === 'desc') return tops.slice().sort((x, y) => -timeCmp(x, y));
    // 智能排序：待开展优先（按开始时间升序，最快开始的在前），历史在后（按结束时间降序，最近结束的在前）
    if (actFilter === 'all') {
      const up = tops.filter(a => actEnd(a) >= now).sort(timeCmp);
      const hi = tops.filter(a => actEnd(a) < now).sort((x, y) => -timeCmp(x, y));
      return up.concat(hi);
    }
    const dir = actFilter === 'history' ? -1 : 1; // history：最近结束在前；upcoming：最快开始在前
    return tops.slice().sort((x, y) => dir * timeCmp(x, y));
  }

  /** 树形 + 筛选 + 排序：得到有序的顶层节点，以及各自（已展开的）活动 */
  function treeGroups() {
    const now = Date.now();
    let tops = activities.filter(a => !a.parent_id);
    if (actFilter !== 'all') {
      tops = tops.filter(a => {
        if (a.is_group) {
          const kids = activities.filter(k => k.parent_id === a.id);
          if (!kids.length) return false;
          return kids.some(k => actFilter === 'history' ? (k.end_time || 0) < now : (k.end_time || 0) >= now);
        }
        return actFilter === 'history' ? ((a.end_time || 0) < now) : ((a.end_time || 0) >= now);
      });
    }
    if (actSearch) {
      const q = actSearch;
      const hay = (a) => ((a.title || '') + ' ' + (a.location || '') + ' ' + (a.remark || '')).toLowerCase();
      tops = tops.filter(a => {
        if (hay(a).includes(q)) return true;
        if (a.is_group) return activities.some(k => k.parent_id === a.id && hay(k).includes(q));
        return false;
      });
    }
    tops = sortTops(tops);

    // 活动只有展开时才占名额；未展开的长期活动按 1 项计
    return tops.map(a => {
      const kids = a.is_group
        ? activities.filter(k => k.parent_id === a.id).sort((x, y) => (x.start_time || 0) - (y.start_time || 0))
        : [];
      const shown = a.is_group && actExpanded.has(a.id)
        ? (actFilter !== 'all' ? kids.filter(k => actFilter === 'history' ? (k.end_time || 0) < now : (k.end_time || 0) >= now) : kids)
        : [];
      return { act: a, kind: a.is_group ? 'main' : 'once', depth: 0, children: kids.length, shown };
    });
  }

  /** 展开后的完整行序列：顶层节点 + 已展开的活动（活动同样占一行） */
  function flatRows() {
    const flat = [];
    treeGroups().forEach(g => {
      flat.push({ act: g.act, kind: g.kind, depth: 0, children: g.children, pid: null });
      g.shown.forEach(k => flat.push({ act: k, kind: 'child', depth: 1, children: 0, pid: g.act.id }));
    });
    return flat;
  }

  /** 分页：每页按实际行数计算，活动与临时活动 / 长期活动一样各占一项 */
  function pageRows() {
    const flat = flatRows();
    const pages = Math.max(1, Math.ceil(flat.length / actPageSize));
    if (actPage > pages) actPage = pages;
    renderState.total = flat.length;
    renderState.pages = pages;
    const s = (actPage - 1) * actPageSize;
    const out = flat.slice(s, s + actPageSize);
    // 本页首行若是活动，说明它的长期活动在上一页，标注「续」
    if (out.length && out[0].pid) out[0].cont = true;
    return out;
  }

  function filteredTreeRows() { return pageRows(); }

  function childEnd(main) {
    const kids = activities.filter(a => a.parent_id === main.id);
    return kids.length ? Math.max.apply(null, kids.map(k => k.end_time)) : main.end_time;
  }

  function syncActBatchUI() {
    const { items, total, pages } = pageItems();
    const _countable = activities.filter(a => !a.is_group);
    const _now = Date.now();
    const _upcoming = _countable.filter(a => (a.end_time||0) >= _now).length;
    const _history = _countable.length - _upcoming;
    el('actPageInfo').textContent = `待开展 ${_upcoming} / 已结束 ${_history} / 全部 ${_countable.length}`;
    const delIds = items.filter(a => a.can_delete).map(a => a.id);
    el('actSelectAll').checked = !!delIds.length && delIds.every(id => actSelected.has(id));
    el('actSelectAll').indeterminate = delIds.some(id => actSelected.has(id)) && !el('actSelectAll').checked;
    el('actSelectedInfo').textContent = actSelected.size ? `已选 ${actSelected.size} 个` : '勾选活动后可批量删除';
    el('actBatchDel').disabled = actSelected.size === 0;
  }

  el('actSort').addEventListener('change', () => { actSortOrder = el('actSort').value; actPage = 1; renderActivities(); });
  el('actPageSize').addEventListener('change', () => { const v = el('actPageSize').value; actPageSize = v === 'all' ? 99999 : (Number(v) || 10); actPage = 1; renderActivities(); });
  if (el('actFilter')) el('actFilter').addEventListener('change', () => {
    actFilter = el('actFilter').value;
    actPage = 1; renderActivities();
  });
  el('actSearch').addEventListener('input', () => { actSearch = el('actSearch').value.trim().toLowerCase(); actPage = 1; renderActivities(); });
  el('actPrev').addEventListener('click', () => { if (actPage > 1) { actPage--; renderActivities(); } });
  el('actNext').addEventListener('click', () => { actPage++; renderActivities(); });
  if (el('actPageInput')) {
    el('actPageInput').addEventListener('change', () => {
      let v = parseInt(el('actPageInput').value, 10) || 1;
      const max = parseInt(el('actPageInput').max, 10) || 1;
      if (v < 1) v = 1; if (v > max) v = max;
      el('actPageInput').value = v;
      actPage = v;
      renderActivities();
    });
  }
  el('actSelectAll').addEventListener('change', () => {
    const { items } = pageItems();
    if (el('actSelectAll').checked) items.forEach(a => { if (a.can_delete) actSelected.add(a.id); });
    else items.forEach(a => actSelected.delete(a.id));
    syncActBatchUI();
  });
  el('actBatchDel').addEventListener('click', async () => {
    if (!actSelected.size) return;
    const delIds = activities.filter(a => actSelected.has(a.id) && a.can_delete).map(a => a.id);
    if (!delIds.length) return toast('所选活动均无删除权限，无法批量删除');
    if (!await confirmBox(`确认批量删除选中的 ${delIds.length} 个活动？相关签到记录也会一并删除；删除后可由上级管理员 / 运维者协助恢复（保留操作记录）。`)) return;
    try {
      const r = await api.post('api/activities/bulk-delete', { ids: delIds });
      toast(r.message || '已批量删除');
      delIds.forEach(id => actSelected.delete(id));
      loadActivities();
    } catch (e) { toastErr(e.message); }
  });
  el('reloadAct').addEventListener('click', loadActivities);

  el('aMode').addEventListener('change', syncModeUI);

  function syncModeUI() {
    const mode = el('aMode').value;
    el('onceBox').classList.toggle('hidden', mode !== 'once');
    el('recBox').classList.toggle('hidden', mode !== 'recurring');
    el('subBox').classList.toggle('hidden', mode !== 'sub');
    el('titleField').classList.toggle('hidden', mode === 'sub');
    if (el('locField')) el('locField').classList.toggle('hidden', mode === 'sub');
  }
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

  /* ---------------- 发布活动：目的地地图打点 ---------------- */
  let destMap = null;
  let destMarker = null;
  let destLatLng = null;      // { lat, lng }（GCJ-02，与高德底图一致）
  let fenceList = [];         // 活动范围列表（含多多边形）
  let destFenceLayer = null;  // 目的地地图上展示的所选活动范围图层
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
    if (destMarker) {
      destMarker.setLatLng(latlng);
    } else {
      const icon = L.divIcon({ className: 'dest-marker', html: '<div class="dest-pin">📍</div>', iconSize: [28, 28], iconAnchor: [14, 28] });
      destMarker = L.marker(latlng, { icon, draggable: true }).addTo(destMap);
      destMarker.on('dragend', () => {
        const p = destMarker.getLatLng();
        destLatLng = { lat: p.lat, lng: p.lng };
        updateDestState();
      });
    }
    if (recenter) destMap.setView(latlng, Math.max(destMap.getZoom(), 16));
    updateDestState();
  }
  function clearDestMarker() {
    destLatLng = null;
    if (destMarker && destMap) { destMap.removeLayer(destMarker); destMarker = null; }
    updateDestState();
  }
  /** 在目的地地图上展示所选活动范围的全部范围（多多边形） */
  function renderFenceOnDest(fence) {
    if (!destMap) return;
    if (!destFenceLayer) destFenceLayer = L.layerGroup().addTo(destMap);
    destFenceLayer.clearLayers();
    if (!fence || !fence.polygons || !fence.polygons.length) return;
    fence.polygons.forEach(ring => {
      if (!Array.isArray(ring) || ring.length < 3) return;
      L.polygon(ring.map(p => [Number(p[1]), Number(p[0])]), {
        color: '#0a7d3c', weight: 2, fillColor: '#0a7d3c', fillOpacity: 0.12
      }).addTo(destFenceLayer).bindTooltip(escapeHtml(fence.name || '活动范围'));
    });
  }
  /** 选了活动范围时：在目的地地图画出它的全部范围，并自动缩放到该范围 */
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

  /* ---------------- 发布活动：配图（最多 3 张，可逐张删除 / 一键清空） ---------------- */
  const MAX_ACT_IMAGES = 3;
  let actImages = [];                     // [{ data }] data 为压缩后的 dataURL

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

  // 发布表单位于独立「发布活动」分区：进入该分区时初始化地图（Leaflet 需容器可见才有正确尺寸）
  if (el('aDestClear')) el('aDestClear').addEventListener('click', () => clearDestMarker());
  if (el('aFence')) el('aFence').addEventListener('change', onFencePick);
  if (el('aDestUseMyLoc')) el('aDestUseMyLoc').addEventListener('click', () => {
    const blocked = geoUnavailableReason();
    if (blocked) return toastErr(blocked);
    el('aDestState').textContent = '定位中…';
    navigator.geolocation.getCurrentPosition(
      pos => {
        const [lng, lat] = wgs84ToGcj02(pos.coords.longitude, pos.coords.latitude);
        setDestMarker({ lat, lng }, true);
      },
      err => { el('aDestState').textContent = '定位失败：' + ((err && err.message) || '请检查定位权限'); },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  });

  el('publishBtn').addEventListener('click', async () => {
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
      // 客户端预校验：所选日期范围内最早的一场活动不得早于当前时间（与服务端一致）
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
      clearDestMarker();
      if (el('aMode')) { el('aMode').value = 'once'; syncModeUI(); }
      clearActImage();
      loadActivities();
    } catch (e) { toastErr(e.message); }
  });

  el('reloadAct').addEventListener('click', loadActivities);

  /* ---------------- 班级签到视图：当天活动 → 全员彩色状态 ---------------- */
  el('rosterDate').value = fmtDate(Date.now());
  // 选日期 → 重填活动下拉并直接加载；选活动 → 直接加载（不再需要「查看」按钮）
  el('rosterDate').addEventListener('change', () => { fillRosterActivities(); loadRoster(); });
  el('rosterActivity').addEventListener('change', loadRoster);

  /** 只列出所选当天的活动 */
  function fillRosterActivities() {
    const day = el('rosterDate').value;
    const list = activities.filter(a => !a.is_group && fmtDate(a.start_time) === day);
    el('rosterActivity').innerHTML = list.length
      ? list.map(a => `<option value="${a.id}">${escapeHtml(a.title)} · ${fmtSpan(a.start_time, a.end_time)}</option>`).join('')
      : '<option value="">当天无活动</option>';
  }

  const LEGEND = [
    { k: 'signed', t: '已签到' },
    { k: 'ontheway', t: '在途中' },
    { k: 'leave', t: '请假' },
    { k: 'absent', t: '缺勤' },
    { k: 'none', t: '待签到' }
  ];

  async function loadRoster() {
    const id = el('rosterActivity').value;
    if (!id) {
      if (el('rosterLegend')) el('rosterLegend').innerHTML = '';
      el('rosterGrid').innerHTML = '<div class="empty">当天没有活动</div>';
      return;
    }
    try {
      const d = await api.get('api/admin/checkins?activity_id=' + id);
      // 活动结束后：「在途中」「待签到」已折算为「缺勤」，图例与汇总都不再展示这两个标签
      const ended = d.activity && d.activity.end_time && Date.now() > d.activity.end_time;
      if (el('rosterLegend')) el('rosterLegend').innerHTML = (ended ? LEGEND.filter(l => l.k !== 'ontheway' && l.k !== 'none') : LEGEND)
        .map(l => `<span class="legend"><i class="sw ${l.k}"></i>${l.t}</span>`).join('');
      const rows = d.roster || [];
      if (!rows.length) {
        el('rosterGrid').innerHTML = '<div class="empty">暂无班级成员，请先在「用户管理」中添加</div>';
        return;
      }
      // display_status 取值：signed / ontheway / leave / absent / pending（待签到）
      const stat = { signed: 0, ontheway: 0, leave: 0, absent: 0, none: 0 };
      rows.forEach(r => {
        const k = r.display_status || 'pending';
        if (k === 'pending') stat.none += 1;
        else if (stat[k] !== undefined) stat[k] += 1;
      });
      const tw = ended ? '' : `<span class="badge ontheway">途中 ${stat.ontheway}</span>`;
      const pd = ended ? '' : `<span class="badge pending">待签到 ${stat.none}</span>`;

      el('rosterGrid').innerHTML =
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
          // 卡片右上角定位指示器：仅已上传定位时显示 📍（按是否范围内着色）；未上传则不显示占位符（不再以「—」占位）
          const showLoc = !locHidden && r.has_location;
          const locCls = showLoc ? (r.in_fence === 1 ? 'in' : (r.in_fence === 0 ? 'out' : 'na')) : 'none';
          const locTip = showLoc
            ? (r.in_fence === 1 ? '已上传定位·活动范围内' : (r.in_fence === 0 ? '已上传定位·活动范围外' : '已上传定位·未配置活动范围'))
            : '';
          const nmLen = [...(r.real_name || '')].length;
          const nmCls = nmLen > 12 ? ' xlong' : (nmLen > 7 ? ' long' : '');
          const locHidden = document.body.classList.contains('loc-disabled');
          const locSuffix = showLoc ? ' · 点击查看该生定位' : '';
          return `<div class="person ${st}" data-uid="${r.user_id}" data-has-loc="${showLoc ? 1 : 0}" title="${escapeHtml(r.real_name)}（${escapeHtml(r.student_id || '-')}）· ${checkinStatusText(raw)}${locSuffix}">
            ${showLoc ? `<span class="loc-badge ${locCls}" title="${locTip}" data-loc>📍</span>` : ''}
            <span class="nm${nmCls}">${escapeHtml(r.real_name)}</span>
            <small>${escapeHtml(r.student_id || '')}</small>
          </div>`;
        }).join('');
      // 长姓名（如新疆多段姓名）按卡片实际宽度缩小字号：确保单行、不换行、尽量不裁切
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
  /** 无定位 / 核验关闭 / 无权限时：仅展示签到信息的浮窗（复用 stuLocModal） */
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
  if (el('rosterGrid')) {
    el('rosterGrid').addEventListener('click', e => {
      const card = e.target.closest('.person');
      if (!card) return;
      const uid = card.getAttribute('data-uid');
      const actSel = el('opsActivity') || el('rosterActivity');
      const aid = actSel ? Number(actSel.value) : 0;
      if (!aid) { toast('请先选择活动'); return; }
      const locDisabled = document.body.classList.contains('loc-disabled');
      const hasLoc = card.getAttribute('data-has-loc') === '1';
      const canViewLoc = myPerm && myPerm.held && myPerm.held.VIEW_STUDENT_LOCATION;
      // 核验开关开启 + 有定位 + 有权限 → 地图+签到信息；否则仅签到信息
      if (!locDisabled && hasLoc && canViewLoc) {
        showStudentLocation(uid, aid);
      } else {
        showStudentInfo(uid, aid);
      }
    });
  }

  /* ---------------- 补签 / 退签 / 代请假 ---------------- */
  // 选择活动即加载（不再需要「查看」按钮）
  el('opsActivity').addEventListener('change', loadOps);

  async function loadOps() {
    const id = el('opsActivity').value;
    if (!id) {
      // 未选活动：不要弹 toast（会在切页 / 截图时残留），只在列表区显示空态
      if (el('opsRows')) el('opsRows').innerHTML = '<tr><td colspan="6"><div class="empty">请先在上方选择活动</div></td></tr>';
      return;
    }
    try {
      // 代请假 / 补签 / 退签门槛统一为「班委及以上」（cadre）；层级与后端 config.ROLE_LEVEL 对齐：cadre=1
      const lv = (myPerm.level || 0);
      const canProxyLeave = lv >= 1;
      const canSupplement = lv >= 1;
      if (!canProxyLeave && !canSupplement) {
        el('opsRows').innerHTML = '<tr><td colspan="6"><div class="empty">补签 / 退签 / 代请假为管理端操作，仅管理岗可执行</div></td></tr>';
        return;
      }
      const d = await api.get('api/admin/checkins?activity_id=' + id);
      const rows = d.roster || [];
      const ended = !d.activity || Date.now() > d.activity.end_time;
      el('opsRows').innerHTML = rows.length ? rows.map(r => {
        // 前置校验：退签前提是已签到；补签前提是「活动已结束且缺勤」
        const signed = r.status === 'signed';
        const onLeave = r.status === 'leave' || r.leave_status === 'approved' || r.leave_status === 'pending';
        const supDisabled = signed || !ended;
        const supTitle = signed ? '该学生已签到，无需补签'
          : (!ended ? '活动尚未结束，补签仅限活动结束后' : '补签（缺勤）');
        const unsDisabled = !signed;
        const unsTitle = signed ? '退签（已签到）' : '该学生尚未签到，无法退签';
        const leaveDisabled = signed || onLeave;
        const leaveTitle = signed ? '该学生已签到，无需请假'
          : (onLeave ? '该学生已请假（含待审/已准），无需重复代请假' : '代请假');
        return `
        <tr>
          <td>${escapeHtml(r.student_id || '-')}</td>
          <td>${escapeHtml(r.real_name)}</td>
          <td>${r.display_status ? checkinBadge(r.display_status) : checkinBadge('pending')}</td>
          <td>${document.body.classList.contains('loc-disabled') ? '—'
            : (r.in_fence === null || r.in_fence === undefined
              ? (r.status ? '<span class="badge pending">未采集定位</span>' : '-')
              : (r.in_fence ? '<span class="badge signed">活动范围内</span>' : '<span class="badge cancelled">活动范围外</span>'))}</td>
          <td>${r.created_at ? fmtDateTime(r.created_at) : '-'}</td>
          <td class="row ops-actions">
            <button class="btn sm ok" data-sup="${r.user_id}" ${supDisabled ? 'disabled' : ''} title="${supTitle}">补签</button>
            <button class="btn sm danger" data-uns="${r.user_id}" ${unsDisabled ? 'disabled' : ''} title="${unsTitle}">退签</button>
            <button class="btn sm warn" data-leave="${r.user_id}" ${leaveDisabled ? 'disabled' : ''} title="${leaveTitle}">代请假</button>
          </td>
        </tr>`;
      }).join('') : '<tr><td colspan="6"><div class="empty">暂无班级成员</div></td></tr>';

      const aid = Number(id);
      qsa('#opsRows [data-sup]').forEach(b => b.addEventListener('click', async () => {
        // 补签：动作为直接改签到状态，加普通确认避免误操作
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
        // 代请假直接生效（无需审核），但会留痕并给普通学生发回执
        const reason = await promptText('代请假', '该操作会直接把该普通学生记为「请假」，并发送回执提醒。',
          '例如：已电话确认因病缺席', true);
        if (reason === null) return;
        try {
      // 用户 id 为非纯数字字符串（如 yHsfG2），不能 Number() 强转（NaN→null 会被后端判为未选择）
      await api.post('api/admin/leave-for-user', { user_id: b.getAttribute('data-leave'), activity_id: aid, reason });
          toast('已代请假');
          loadOps();
        } catch (e) { toastErr(e.message); }
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

  /* ---------------- 申诉审核（初审 / 终审） ---------------- */
  const STAGE_BADGE = {
    initial: '<span class="badge pending">待初审</span>',
    final: '<span class="badge leave">待终审</span>',
    done: '<span class="badge">已结案</span>'
  };
  const APPEAL_TYPE = { leave: '请假', makeup: '补签' };

  async function loadLeaves() {
    try {
      const d = await api.get('api/admin/leave-requests');
      renderAppealTable('leaveRows', d.requests || [], el('showDoneLeave'));
    } catch (e) { toastErr(e.message); }
  }
  el('reloadLeaves').addEventListener('click', loadLeaves);
  el('showDoneLeave').addEventListener('change', loadLeaves);

  async function loadMakeups() {
    try {
      const d = await api.get('api/admin/makeup-requests');
      renderAppealTable('makeupRows', d.requests || [], el('showDoneMakeup'));
    } catch (e) { toastErr(e.message); }
  }
  el('reloadMakeups').addEventListener('click', loadMakeups);
  el('showDoneMakeup').addEventListener('change', loadMakeups);

  /** 清理已结案：删除管理范围内「已结案」的申诉，避免审核列表越堆越多。
   *  仅删申诉记录本身；已判定 / 已撤销的签到记录不受影响（可撤销）。 */
  async function clearDoneAppeals(kind, reload) {
    const label = kind === 'leave' ? '请假' : '补签';
    if (!confirm(`确定清理管理范围内「已结案」的${label}申诉吗？\n该操作不可撤销，但不影响已判定的签到结果。`)) return;
    try {
      const r = await api.post(`api/admin/${kind}-requests/clear-done`, {});
      toast(r.message || '已清理');
      await reload();
    } catch (e) { toastErr(e.message); }
  }
  if (el('clearDoneLeave')) el('clearDoneLeave').addEventListener('click', () => clearDoneAppeals('leave', loadLeaves));
  if (el('clearDoneMakeup')) el('clearDoneMakeup').addEventListener('click', () => clearDoneAppeals('makeup', loadMakeups));

  /** 申诉表格：按「阶段」分组展示，初审在前、终审紧随，已结案可折叠 */
  function renderAppealTable(boxId, rows, showDoneBox) {
    const showDone = !!(showDoneBox && showDoneBox.checked);
    const order = { final: 0, initial: 1, done: 2 };
    const list = rows
      .filter(r => showDone || r.stage !== 'done')
      .sort((a, b) => (order[a.stage] - order[b.stage]) || ((b.created_at || 0) - (a.created_at || 0)));

    el(boxId).innerHTML = list.length ? list.map(r => `
      <tr class="${r.stage === 'final' ? 'tree-main' : ''}">
        <td>${STAGE_BADGE[r.stage] || '-'}</td>
        <td>${escapeHtml(r.real_name)}${r.student_id ? `<div class="muted" style="font-size:12px">${escapeHtml(r.student_id)}</div>` : ''}</td>
        <td>${escapeHtml(r.title)}</td>
        <td>${escapeHtml(r.reason || '-')}</td>
        <td>${fmtDateTime(r.created_at)}</td>
        <td>${badge(r.status)}${r.appealed ? '<div class="muted" style="font-size:12px">普通学生已申诉：' + escapeHtml(r.appeal_reason || '') + '</div>' : ''}</td>
        <td class="row" style="gap:6px">
          <button class="btn sm" data-detail="${r._type}:${r.id}">详情</button>
          ${r.stage !== 'done'
            ? `<button class="btn sm ok" data-ap="${r._type}:${r.id}">${r.stage === 'final' ? '终审通过' : '批准'}</button>
               <button class="btn sm danger" data-rj="${r._type}:${r.id}">${r.stage === 'final' ? '终审驳回' : '驳回'}</button>`
            : ''}
          <button class="btn sm danger" data-del="${r._type}:${r.id}" title="删除该申诉记录（不可撤销）">删除</button>
        </td>
      </tr>`).join('')
      : `<tr><td colspan="7"><div class="empty">${showDone ? '暂无申请' : '暂无待办申请（可勾选「显示已结案」查看历史）'}</div></td></tr>`;

    qsa('#' + boxId + ' [data-detail]').forEach(b => b.addEventListener('click', () => {
      const v = String(b.getAttribute('data-detail') || '').split(':');
      openAppealReview(v[0], Number(v[1]), false);
    }));
    qsa('#' + boxId + ' [data-ap]').forEach(b => b.addEventListener('click', () => {
      const v = String(b.getAttribute('data-ap') || '').split(':');
      openAppealReview(v[0], Number(v[1]), true);
    }));
    qsa('#' + boxId + ' [data-rj]').forEach(b => b.addEventListener('click', () => {
      const v = String(b.getAttribute('data-rj') || '').split(':');
      openAppealReview(v[0], Number(v[1]), true, false);
    }));
    qsa('#' + boxId + ' [data-del]').forEach(b => b.addEventListener('click', () => {
      const v = String(b.getAttribute('data-del') || '').split(':');
      deleteAppeal(v[0], Number(v[1]));
    }));
  }

  /** 单条删除申诉记录（任意状态），用于「消灭」积压 / 无效申诉 */
  async function deleteAppeal(type, id) {
    const label = type === 'leave' ? '请假' : '补签';
    if (!confirm(`确定删除这条${label}申诉记录吗？\n删除后该学生将不再看到此申请，且不可撤销。`)) return;
    try {
      await api.post(`api/admin/${type}-requests/${id}/delete`, {});
      toast('已删除该申诉记录');
      if (type === 'leave') loadLeaves(); else loadMakeups();
    } catch (e) { toastErr(e.message); }
  }

  /**
   * 申诉详情弹窗：查看文本与佐证图片、回复沟通、执行初审 / 终审。
   * 直接点「批准 / 驳回」时也会先打开详情，避免不看材料就裁决。
   */
  async function openAppealReview(type, id, doJudge, presetApprove) {
    let d;
    try { d = await api.get('api/appeal/' + type + '/' + id); }
    catch (e) { return toastErr(e.message); }
    const r = d.request;
    const label = APPEAL_TYPE[type] || '申诉';
    const canInitial = d.can.initial;
    const canFinal = d.can.final;

    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.setAttribute('data-modal-kind', 'cancel');
    mask.innerHTML = `<div class="modal wide">
      <h3>${label}申诉详情</h3>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <span class="tag">${escapeHtml(d.owner ? d.owner.real_name : '-')}${d.owner && d.owner.student_id ? ' · ' + escapeHtml(d.owner.student_id) : ''}</span>
        <span class="tag">${escapeHtml(d.activity ? d.activity.title : '-')}</span>
        ${badge(r.status)}
        ${r.appealed ? '<span class="badge leave">普通学生已申诉</span>' : ''}
        ${r.final_status ? '<span class="badge manual">已终审</span>' : ''}
      </div>
      <div class="field"><label>普通学生理由</label><div class="muted">${escapeHtml(r.reason || '-')}</div></div>
      ${r.appeal_reason ? `<div class="field"><label>普通学生申诉理由</label><div class="muted">${escapeHtml(r.appeal_reason)}</div></div>` : ''}
      ${r.reply ? `<div class="field"><label>初审结果 / 留言</label><div class="muted">${badge(r.status)} ${escapeHtml(r.reply)}</div></div>` : ''}
      ${r.final_reply ? `<div class="field"><label>终审结果 / 留言</label><div class="muted">${badge(r.final_status)} ${escapeHtml(r.final_reply)}</div></div>` : ''}

      <div class="field"><label>佐证图片</label>
        <div class="att-grid">${attachmentsHtml(d.attachments)}</div>
      </div>
      <div class="field"><label>沟通记录</label>
        <div class="msg-list" data-msgs>${messagesHtml(d.messages)}</div>
      </div>
      <div class="field"><label>回复 / 裁决留言</label><textarea data-msg rows="2" placeholder="会同时发给普通学生（在线走站内提醒，离线走邮件）"></textarea></div>

      <div class="row end" style="margin-top:10px">
        <button class="btn" data-send type="button">仅回复</button>
        ${canInitial ? '<button class="btn primary" data-i1 type="button">初审批准</button><button class="btn danger" data-i0 type="button">初审驳回</button>' : ''}
        ${canFinal ? '<button class="btn primary" data-f1 type="button">终审通过</button><button class="btn danger" data-f0 type="button">终审驳回</button>' : ''}
        <button class="btn" data-close type="button">关闭</button>
      </div>
    </div>`;
    document.body.appendChild(mask);

    const close = () => mask.remove();
    const reload = async () => {
      close();
      if (type === 'leave') loadLeaves(); else loadMakeups();
    };
    mask.querySelector('[data-close]').addEventListener('click', close);
    mask.addEventListener('click', e => { if (e.target === mask) close(); });

    mask.querySelector('[data-send]').addEventListener('click', async () => {
      const body = String(mask.querySelector('[data-msg]').value || '').trim();
      if (!body) return toast('请填写回复内容');
      try {
        const res = await api.post('api/appeal/' + type + '/' + id + '/message', { body });
        mask.querySelector('[data-msgs]').innerHTML = messagesHtml(res.messages || []);
        mask.querySelector('[data-msg]').value = '';
        toast('已回复');
      } catch (e) { toastErr(e.message); }
    });

    const judge = async (stage, approve) => {
      const reply = String(mask.querySelector('[data-msg]').value || '').trim();
      try {
        const res = await api.post(`api/admin/${type === 'leave' ? 'leave' : 'makeup'}-requests/${id}/review`,
          { approve, reply });
        toast(res.message || '已裁决');
        await reload();
      } catch (e) { toastErr(e.message); }
    };
    const bind = (sel, stage, approve) => {
      const b = mask.querySelector(sel);
      if (b) b.addEventListener('click', () => judge(stage, approve));
    };
    bind('[data-i1]', 'initial', true);
    bind('[data-i0]', 'initial', false);
    bind('[data-f1]', 'final', true);
    bind('[data-f0]', 'final', false);

    // 从列表按钮直接点裁决：预填焦点到留言框，让审核人先看着材料再决定
    if (doJudge) {
      const ta = mask.querySelector('[data-msg]');
      if (ta) ta.focus();
      if (presetApprove === false) toast('请填写驳回理由后点击「驳回」');
    }
  }

  function attachmentsHtml(list) {
    if (!list || !list.length) return '<div class="muted" style="font-size:12px">无佐证材料</div>';
    return list.map(a =>
      `<img src="${url('api/appeal/attachment/' + a.id)}" data-full="${url('api/appeal/attachment/' + a.id)}" alt="佐证图片" title="点击放大查看" style="cursor:zoom-in">`
    ).join('');
  }

  function messagesHtml(list) {
    if (!list || !list.length) return '<div class="muted" style="font-size:12px">暂无沟通记录</div>';
    return list.map(m => `
      <div class="msg-item">
        <div class="who">${escapeHtml(m.real_name)}（${escapeHtml(m.role_title || '')}）· ${fmtDateTime(m.created_at)}</div>
        <div>${escapeHtml(m.body || '')}</div>
      </div>`).join('');
  }

  async function loadSettings() {
    try {
      const d = await api.get('api/admin/settings');
      const s = d.settings || {};
      if (el('setAllowMakeup')) el('setAllowMakeup').checked = String(s.allow_makeup) === '1';
      if (el('mailState')) el('mailState').innerHTML = d.mail_configured
        ? '邮件服务已配置，审核结果与提醒会发送到普通学生登记的邮箱。'
        : '<b>邮件服务未配置</b>：请在服务端填写 SMTP_* 环境变量后重启，提醒与结果邮件才会真正发出。';
    } catch (e) { toastErr(e.message); }
  }
  if (el('saveSettings')) el('saveSettings').addEventListener('click', async () => {
    try {
      const r = await api.post('api/admin/settings', { allow_makeup: el('setAllowMakeup').checked });
      toast(r.message || '设置已保存');
      loadSettings();
    } catch (e) { toastErr(e.message); }
  });

  /* ---------------- 账号管理（管理端 / 用户端 合并，与运维端同源） ---------------- */
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

  /** 把普通学生同步到日历 / 报告的选人下拉（沿用原有逻辑） */
  function fillAccountUserOptions() {
    const opts = members.length
      ? '<option value="" disabled hidden selected>请选择学生…</option>'
        + members.map(u => `<option value="${u.id}">${escapeHtml(u.real_name)}（${escapeHtml(u.student_id || '-')}）</option>`).join('')
      : '<option value="" disabled hidden selected>暂无学生</option>';
    if (el('cUser')) el('cUser').innerHTML = opts;
    if (el('rUser')) {
      const keep = el('rUser').value;
      el('rUser').innerHTML = '<option value="" disabled hidden selected>请选择学生…</option>'
        + (members.length
            ? members.map(u => `<option value="${u.id}">${escapeHtml(u.real_name)}（${escapeHtml(u.student_id || '-')}）</option>`).join('')
            : '');
      el('rUser').value = '';
      if (keep && members.some(u => String(u.id) === String(keep))) el('rUser').value = keep;
      if (el('rUser').value) loadReport(); else showReportHint();
    }
  }

  async function loadAccounts() {
    try {
      const d = await api.get('api/admin/users');
      accAll = d.users || [];
      mgrList = accAll.filter(u => u.role !== 'normal');
      userList = accAll.filter(u => u.role === 'normal');
      members = userList;
      paintAccList();
      fillAccountUserOptions();
    } catch (e) { toastErr(e.message); }
  }
  // 兼容既有调用点（添加 / 编辑 / 行操作 / 切到账号页 / 日历 / 报告）——统一走一次合并加载
  function loadManagers() { return loadAccounts(); }
  function loadUsers() { return loadAccounts(); }

  el('reloadAccList').addEventListener('click', loadAccounts);
  el('accListSearch').addEventListener('input', paintAccList);
  el('accListType').addEventListener('change', paintAccList);

  /* ---------------- 统一添加账号（管理端 / 用户端 二合一，与运维端同源） ---------------- */
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
      loadAccounts();
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
              loadAccounts();
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
      loadAccounts();
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
        loadAccounts(); loadResets();
      } catch (e) { toastErr(e.message); }
    }));
    qsa(selector + ' [data-cancel]').forEach(b => b.addEventListener('click', async () => {
      if (!await confirmBox('确认注销该账号？账号将被隐藏，重新登录需管理员恢复')) return;
      try {
        const r = await api.post('api/admin/users/' + b.getAttribute('data-cancel') + '/cancel', {});
        toast(r.message || '已注销');
        loadAccounts();
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
        loadAccounts();
      } catch (e) { toastErr(e.message); }
    }));
    qsa(selector + ' [data-restore]').forEach(b => b.addEventListener('click', async () => {
      const ok2 = await highRiskConfirm({
        title: '⚠ 恢复账号',
        danger: '此操作将清空该账号密码并结束其全部会话，账号转为「未激活」，需本人重新设置密码后登录。仅高一级管理员可执行。',
        text: '确认恢复该账号。', label: '确认恢复'
      });
      if (!ok2) return;
      try {
        const r = await api.post('api/admin/users/' + b.getAttribute('data-restore') + '/restore', ok2);
        toast(r.message || '已恢复');
        loadAccounts();
      } catch (e) { toastErr(e.message); }
    }));
  }

  /* ---------------- 日历与报告 ---------------- */
  el('cMode').addEventListener('change', () => {
    el('cUser').classList.toggle('hidden', el('cMode').value !== 'person');
    loadCalendar();
  });
  el('cUser').classList.add('hidden');
  el('cMonth').addEventListener('change', loadCalendar);
  el('cUser').addEventListener('change', loadCalendar);
  

  async function loadCalendar() {
    const month = el('cMonth').value || currentMonth();
    const box = el('calBox');
    try {
      if (el('cMode').value === 'person') {
        const uid = el('cUser').value;
        if (!uid) {
          box.innerHTML = '<div class="empty">请先在上方选择要查看的普通学生</div>';
          resetCalendarDetail(el('calDetailBox'));
          return;
        }
        const d = await api.get(`api/calendar/person/${uid}?month=${month}`);
        renderCalendar(box, d.month, d.days, el('calDetailBox'));
        box.insertAdjacentHTML('afterbegin',
          `<div class="row" style="margin-bottom:10px">
             <span class="tag">个人日历</span>
             <b>${escapeHtml(d.user.real_name)}（${escapeHtml(d.user.student_id || '无学号')}）</b>
             <span class="tag">出勤率 ${d.attendance_rate}%</span>
           </div>`);
      } else {
        const d = await api.get('api/calendar/class?month=' + month);
        renderCalendar(box, d.month, d.days, el('calDetailBox'));
        // 汇总当月各状态（跨所有活动），与班级签到视图的 6 态一致
        const agg = { signed: 0, ontheway: 0, leave: 0, absent: 0, pending: 0 };
        Object.values(d.days).forEach(arr => (arr || []).forEach(it => {
          ['signed', 'ontheway', 'leave', 'absent', 'pending'].forEach(k => {
            agg[k] += (it.counts && it.counts[k]) || 0;
          });
        }));
        box.insertAdjacentHTML('afterbegin',
          `<div class="row" style="margin-bottom:10px">
             <span class="tag">班级集体日历</span>
             <span class="tag">班级 ${d.members.length} 人</span>
             <span class="tag">当月活动 ${d.activity_count} 场</span>
           </div>`);
      }
    } catch (e) { toastErr(e.message); }
  }

  function showReportHint() {
    el('reportBox').innerHTML = '<div class="empty">请选择学生，报告将自动生成</div>';
  }
  el('rUser').addEventListener('change', loadReport);
  async function loadReport() {
    const uid = el('rUser').value;
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
          <span class="tag">活动总数 ${r.total_activities}</span>
          <span class="tag">已结束 ${r.signed + r.ontheway + r.leave + r.absent}</span>
          <span class="tag">待开始 ${r.pending}</span>
          <span class="tag">在途中 ${r.ontheway}</span>
          <span class="tag">管理员补签 ${r.manual}</span>
          <span class="tag">活动范围内签到 ${r.in_fence}</span>
          <span class="tag">活动范围外记录 ${r.out_fence}</span>
          <span class="tag">有效出勤率 ${r.effective_rate}%（已结束子活动）</span>
        </div>`;
    } catch (e) { toastErr(e.message); }
  }

  /* ---------------- 找回密码申请 ---------------- */
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
          <td>${r.status === 'pending'
            ? `<button class="btn sm warn" data-clr="${r.user_id}">清除密码</button>` : '-'}</td>
        </tr>`).join('') : '<tr><td colspan="6"><div class="empty">暂无申请</div></td></tr>';

      qsa('#resetRows [data-clr]').forEach(b => b.addEventListener('click', async () => {
        if (!await confirmBox('确认清除该账号密码？原密码将失效')) return;
        try {
          const r = await api.post('api/admin/users/' + b.getAttribute('data-clr') + '/clear-password');
          toast(r.message || '已清除');
          loadResets(); loadUsers();
        } catch (e) { toastErr(e.message); }
      }));
    } catch (e) { /* 忽略 */ }
  }
  el('reloadResets').addEventListener('click', loadResets);

  /* ---------------- 数据流 ---------------- */
  async function loadStream() {
    try {
      const d = await api.get('api/stream?limit=500');
      streamAll = d.events || [];
      streamPage = 1;
      renderStream();
    } catch (e) { toastErr(e.message); }
  }

  function renderStream() {
    const pages = Math.max(1, Math.ceil(streamAll.length / streamPageSize));
    if (streamPage > pages) streamPage = pages;
    const s = (streamPage - 1) * streamPageSize;
    const rows = streamAll.slice(s, s + streamPageSize);

    el('streamRows').innerHTML = rows.length ? rows.map(e => {
      const id = eventIdentity(e);
      const name = escapeHtml(e.actor_name || '系统');
      return `<tr>
        <td>${fmtDateTimeMs(e.created_at)}</td>
        <td><span class="tag ev-${eventCat(e.type)}">${escapeHtml(safeTypeText(e.type_text, e.type))}</span></td>
        <td>${name} <span class="badge ${id.cls}">${id.text}</span></td>
        <td>${escapeHtml(e.text || eventContent(e))}</td>
        <td><button class="btn sm" data-detail-stream="${e.id}">详情</button></td>
      </tr>
      <tr class="df-inline-detail" id="msd-${e.id}" style="display:none"><td colspan="5"><div class="empty">加载中…</div></td></tr>`;
    }).join('')
      : '<tr><td colspan="5"><div class="empty">暂无数据</div></td></tr>';

    const spi = el('streamPageInput'); const stp = el('streamTotalPages');
    if (spi) { spi.value = streamPage; spi.max = pages; }
    if (stp) stp.textContent = pages;
  }

  el('streamPageSize').addEventListener('change', () => { const v = Number(el('streamPageSize').value); streamPageSize = v === 0 ? (streamAll.length || 1) : v; streamPage = 1; renderStream(); });
  el('streamPrev').addEventListener('click', () => { if (streamPage > 1) { streamPage--; renderStream(); } });
  el('streamNext').addEventListener('click', () => { streamPage++; renderStream(); });
  if (el('streamPageInput')) el('streamPageInput').addEventListener('change', () => {
    let v = parseInt(el('streamPageInput').value, 10) || 1;
    const max = parseInt(el('streamPageInput').max, 10) || 1;
    if (v < 1) v = 1; if (v > max) v = max;
    el('streamPageInput').value = v; streamPage = v; renderStream();
  });
  el('reloadStream').addEventListener('click', loadStream);

  // 行内「操作记录详情」展开（事件委托，绑定一次）：拉取完整详情，时间精确到 .000
  const srows = el('streamRows');
  if (srows && !srows.dataset.detailBound) {
    srows.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-detail-stream]');
      if (!btn) return;
      const id = btn.getAttribute('data-detail-stream');
      const tr = document.getElementById('msd-' + id);
      if (!tr) return;
      if (tr.style.display === 'none') {
        tr.style.display = '';
        btn.textContent = '收起';
        if (!tr.dataset.loaded) {
          try {
            const d = await api.get('api/dataflow/' + id);
            tr.querySelector('td').innerHTML = streamDetailHtml(d.item || {});
            tr.dataset.loaded = '1';
          } catch (err) { tr.querySelector('td').innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`; }
        }
      } else { tr.style.display = 'none'; btn.textContent = '详情'; }
    });
    srows.dataset.detailBound = '1';
  }
  /* 行内「操作记录详情」表格：统一使用 api.js 的公共 streamDetailHtml，
     与用户端 / 运维端 / 数据流页完全一致（时间精确到 .000，含目标/内容/渠道/打码/撤回）。 */

  /* ---------------- 权限与工单 ---------------- */
  async function loadPerms() {
    try {
      const d = await api.get('api/permissions/mine');
      myPerm = d.state || myPerm;
      if (window.PermGate) { PermGate.init(myPerm); PermGate.apply(document); }
    } catch (e) { /* 忽略 */ }

    const lv = (myPerm && myPerm.level) || 0;
    const held = (myPerm && myPerm.perms) || {};
    const names = {
      FENCE_DRAW: '画/改/删活动范围', FENCE_POINT: '画目的地点图标', FENCE_VERIFY: '启动活动范围核验',
      FENCE_VIEW_MAP: '地图查看活动范围', VIEW_CHECKIN: '查看签到明细', VIEW_STATS: '统计报表',
      VIEW_AUDIT: '审计日志', VIEW_DATAFLOW: '查看数据流', VIEW_STUDENT_LOCATION: '查看学生定位',
      ACT_CREATE: '创建活动', ACT_MANAGE: '改活动',
      ACT_DELETE: '删除活动（高危）', ACT_RECURRING: '循环/活动', ADJ_INITIAL: '初步裁决', ADJ_FINAL: '终审/覆盖',
      AUTH_GRANT: '向下授权', AUTH_APPROVE_WO: '工单审批', AUTH_ACCOUNT: '账号管理',
      SYS_SETTINGS: '系统设置'
    };
    const chips = Object.keys(names).map(code =>
      `<span class="badge ${held[code] ? 'signed' : 'cancelled'}" title="${escapeHtml(names[code])}">${names[code]}</span>`
    ).join('');

    // 自动代管状态：缺小班主任 / 辅导员时由本级（班委）代行其基线权力
    const ac = myPerm.auto_cover || { covered: false };
    const acHtml = ac.covered
      ? `<div class="alert info" style="margin-bottom:8px">
           <b>自动代管中</b>：班级暂无在岗的${(ac.levels || []).map(l => (l === 'r2' ? '小班主任' : '辅导员')).join('、')}，
           已自动为你开通其 ${(ac.perms || []).length} 项基线管理权限。<br>
           上级账号到岗（本人注册设密）后这批权限会自动收回并通知你；代管权限不可再向下授权。
         </div>`
      : '';

    el('permStateBox').innerHTML = acHtml +
      `<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:8px">
         <span class="tag">身份 ${escapeHtml(me.role_title)}</span>
         <span class="tag">层级 ${identityOfLevel(lv)}</span>
         <span class="tag" data-loc>定位核验总开关 ${myPerm.location_verify_enabled ? '已开启' : '已关闭'}</span>
         <span class="badge ${myPerm.location_verify_allowed ? 'signed' : 'cancelled'}" data-loc>活动范围核验${myPerm.location_verify_allowed ? '可用' : '不可用'}</span>
       </div>
       <div class="row" style="gap:6px;flex-wrap:wrap">${chips}</div>
       <div class="muted" style="font-size:12px;margin-top:8px">绿色 = 已持有（角色基线或已被授予）；灰色 = 未持有，可通过工单申请。</div>
       <div class="muted" style="font-size:12px;margin-top:4px" data-loc>查看学生定位需持有「查看学生定位」权限（由辅导员及以上授予），且运维者需先在运维端开启「管理端定位查看」开关。</div>`;

    await loadGrants();
  }
  el('reloadPerms').addEventListener('click', loadPerms);

  async function loadGrants() {
    try {
      const d = await api.get('api/permissions/granted');
      const rows = d.grants || [];
      el('grantRows').innerHTML = rows.length ? rows.map(g => `
        <tr>
          <td>${escapeHtml(g.real_name)}</td>
          <td>${escapeHtml(g.role_title)}</td>
          <td><span class="tag">${escapeHtml(permLabel(g.perm_code))}</span></td>
          <td>${g.source === 'workorder' ? '工单审批' : '直接下放'}</td>
          <td>${g.expires_at ? fmtDateTime(g.expires_at) : '长期'}</td>
          <td><button class="btn sm danger" data-rv="${g.id}">收回</button></td>
        </tr>`).join('') : '<tr><td colspan="6"><div class="empty">暂无下放记录</div></td></tr>';
      qsa('#grantRows [data-rv]').forEach(b => b.addEventListener('click', async () => {
        try {
          const r = await api.post('api/permissions/revoke', { grant_id: Number(b.getAttribute('data-rv')) });
          toast(r.message || '已收回');
          loadGrants(); loadPerms();
        } catch (e) { toastErr(e.message); }
      }));
    } catch (e) {
      el('grantRows').innerHTML = `<tr><td colspan="6"><div class="empty">${escapeHtml(e.message)}</div></td></tr>`;
    }
  }
  el('reloadGrants').addEventListener('click', loadGrants);

  el('woNewBtn').addEventListener('click', async () => {
    // 未授权时 perm-gate 已在捕获阶段拦截并弹工单；此处仅处理「已持有 AUTH_GRANT」时的主动申请入口
    if (!window.PermGate || !PermGate.has('AUTH_GRANT')) return;
    // 由 perm-gate 弹「按权限名称选择」的列表再走工单流程：界面上不出现权限码
    await PermGate.openOrderPicker();
    loadMyOrders();
  });

  async function loadInbox() {
    try {
      const d = await api.get('api/workorders/inbox');
      const rows = d.orders || [];
      el('inboxRows').innerHTML = rows.length ? rows.map(w => `
        <tr>
          <td>${escapeHtml(w.real_name)}</td>
          <td>${escapeHtml(w.role_title)}</td>
          <td><span class="tag">${escapeHtml(w.kind === 'info' ? '信息 / 反馈' : permLabel(w.perm_code))}</span></td>
          <td>${escapeHtml(w.reason || '-')}</td>
          <td>${fmtDateTime(w.created_at)}</td>
          <td>${w.status === 'pending'
            ? `<button class="btn sm ok" data-ap="${w.id}" data-kind="${w.kind}">批准</button> <button class="btn sm danger" data-rj="${w.id}" data-kind="${w.kind}">驳回</button>`
            : `<span class="muted">${WO_STATUS[w.status] || w.status}</span>`}</td>
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
      approve ? (isInfo ? '可填写处理留言（可选）。' : '可填写审批留言（可选，会随邮件发给申请人）。') : '可填写驳回理由（可选，会随邮件发给申请人）。',
      approve ? '例如：已核实，尽快处理' : '例如：理由不充分', true, true
    );
    if (reply === null) return;
    let days = 0;
    if (approve && !isInfo) {
      const v = await formDialog('权限有效期', '留空或 0 表示长期有效。', [
        { name: 'days', label: '有效天数', value: '0' }
      ], '确认批准');
      if (!v) return;
      days = Number(v.days) || 0;
    }
    try {
      const r = await api.post('api/workorders/' + id + '/review', { approve, reply, days });
      toast(r.message || '已处理');
      loadInbox(); loadPerms();
    } catch (e) { toastErr(e.message); }
  }

  const WO_STATUS = { pending: '待审批', approved: '已批准', rejected: '已驳回', timeout: '超时驳回' };
  async function loadMyOrders() {
    try {
      const d = await api.get('api/workorders/mine');
      const rows = d.orders || [];
      el('myOrderRows').innerHTML = rows.length ? rows.map(w => `
        <tr>
          <td><span class="tag">${escapeHtml(w.kind === 'info' ? '信息 / 反馈' : permLabel(w.perm_code))}</span></td>
          <td>${escapeHtml(w.reason || '-')}</td>
          <td>${badge(w.status === 'approved' ? 'signed' : (w.status === 'pending' ? 'pending' : 'cancelled'))} ${WO_STATUS[w.status] || w.status}</td>
          <td>${escapeHtml(w.handler_name || '-')}</td>
          <td>${escapeHtml(w.reply || '-')}</td>
          <td>${fmtDateTime(w.created_at)}</td>
        </tr>`).join('') : '<tr><td colspan="6"><div class="empty">暂无提交记录</div></td></tr>';
    } catch (e) { /* 忽略 */ }
  }
  el('reloadMyOrders').addEventListener('click', loadMyOrders);

  /* ---------------- 通知偏好与系统设置 ---------------- */
  let notifyPrefs = {};

  // 班级级设置「前任 / 代管者留下」提示：上级到岗后需确认沿用或恢复默认
  function renderSysEditorHint(d) {
    const se = d && d.sys_editor;
    const canReset = d && d.can && d.can.reset_sys;
    const boxes = ['sysEditorHintNotify', 'sysEditorHintSec'];
    if (!se || !se.need_confirm || !canReset) {
      boxes.forEach(id => { const e = el(id); if (e) { e.classList.add('hidden'); e.innerHTML = ''; } });
      return;
    }
    const who = se.name
      ? `${escapeHtml(se.name)}${se.role_title ? '（' + escapeHtml(se.role_title) + '）' : ''}`
      : '代管期间的班级管理员';
    const when = se.at ? ' 于 ' + new Date(se.at).toLocaleString('zh-CN') : '';
    const html = `<b>请确认班级设置</b>：当前班级级设置（通知开关、定位核验等）由 ${who}${when} 设置。` +
      `你已到岗，建议确认是否沿用，或恢复出厂默认。` +
      `<div class="row end" style="margin-top:8px;gap:8px">` +
      `<button class="btn sm" id="seDismiss">沿用（我知道了）</button>` +
      `<button class="btn sm primary" id="seReset">恢复出厂默认</button></div>`;
    boxes.forEach(id => { const e = el(id); if (!e) return; e.innerHTML = html; e.classList.remove('hidden'); });
    qsa('#seDismiss').forEach(b => b.addEventListener('click', () => boxes.forEach(id => el(id).classList.add('hidden'))));
    qsa('#seReset').forEach(b => b.addEventListener('click', async () => {
      if (!await confirmBox('恢复出厂默认将清除所有班级级系统设置（运维者专属设置不受影响），确认继续？')) return;
      try {
        const r = await api.post('api/settings/reset-sys', {});
        toast(r.message || '已恢复出厂默认');
        loadNotify(); loadLv();
      } catch (e) { toastErr(e.message); }
    }));
  }

  async function loadNotify() {
    try {
      const d = await api.get('api/settings');
      notifyPrefs = d.notify_prefs || {};
      renderSysEditorHint(d);
      const lv = d.my_level || 0;
      el('notifyPrefBox').innerHTML = Object.keys(notifyPrefs).map(k => {
        const p = notifyPrefs[k];
        return `<div class="pref-row ${p.mandatory || !p.configurable ? 'locked' : ''}">
          <input type="checkbox" data-nt="${k}" ${p.enabled ? 'checked' : ''}
                 ${p.mandatory || !p.configurable ? 'disabled' : ''}>
          <div>
            <div class="pf-name">${escapeHtml(p.name)}</div>
            <div class="pf-meta">${p.mandatory
              ? '<span class="pf-lock">必提醒 · 不可取消</span>'
              : (p.configurable ? `可配置（需「${identityOfLevel(p.min_level)}」及以上）` : `不可配置（需「${identityOfLevel(p.min_level)}」及以上）`)}</div>
          </div>
        </div>`;
      }).join('');

      if (el('privacyBox')) el('privacyBox').textContent = d.privacy_text || '（尚未设置隐私告知文案）';

      // 维护中：立即进入维护按钮灰度禁用，并明确展示维护状态（避免重复入场）
      const maintOn = !!d.maintenance_enabled;
      if (el('maintOnBtn')) el('maintOnBtn').disabled = maintOn;
      if (el('maintStatus')) {
        const mi = d.maintenance || {};
        const restore = mi.restore_at || mi.end_at || '';
        el('maintStatus').textContent = maintOn
          ? `维护中${restore ? '（预计恢复：' + restore + '）' : ''}；结束维护仅运维端可操作`
          : '当前未处于维护状态';
      }
    } catch (e) { toastErr(e.message); }
  }
  el('reloadNotify').addEventListener('click', loadNotify);

  el('saveNotifyBtn').addEventListener('click', async () => {
    const prefs = {};
    qsa('#notifyPrefBox [data-nt]').forEach(i => {
      if (i.disabled) return;
      prefs[i.getAttribute('data-nt')] = i.checked;
    });
    try {
      const r = await api.put('api/settings/notify', { prefs });
      toast(r.message || '已保存');
      loadNotify();
    } catch (e) { toastErr(e.message); }
  });

  // 系统安全：定位核验总开关（需「启动活动范围核验」权限；与运维端同为「复选框 + 保存」）
  async function loadLv() {
    try {
      const d = await api.get('api/settings');
      renderSysEditorHint(d);
      const enabled = !!d.location_verify_enabled;
      document.body.classList.toggle('loc-disabled', !enabled);
      const need = !(d.can && d.can.location_verify);
      if (el('lvSwitch')) el('lvSwitch').checked = enabled;
      if (el('lvState')) {
        el('lvState').textContent = `当前：${enabled ? '已启用定位核验' : '已关闭定位核验'}` +
          (need ? '（需「启动活动范围核验」权限）' : '');
      }
    } catch (e) { toastErr(e.message); }
  }
  if (el('lvSave')) el('lvSave').addEventListener('click', async () => {
    try {
      const enabled = !!el('lvSwitch').checked;
      const r = await api.put('api/settings/location-verify', { enabled });
      toast(r.message || '已保存');
      loadLv(); loadPerms(); loadFences();
    } catch (e) { toastErr(e.message); }
  });
  if (el('reloadSecurity')) el('reloadSecurity').addEventListener('click', () => { loadLv(); loadSettings(); });

  /* 系统公告栏（仅运维者，AUTH_PRIVACY） */
  let announcementText = '';
  async function loadAnnouncement() {
    const item = el('announcementItem');
    if (item) {
      if (window.PermGate && !PermGate.has('AUTH_PRIVACY')) { item.classList.add('hidden'); return; }
      item.classList.remove('hidden');
    }
    try {
      const d = await api.get('api/settings');
      announcementText = d.announcement_text || '';
      const meta = el('announcementMeta');
      if (meta) meta.textContent = d.announcement_updated_at
        ? '最近发布：' + fmtDateTime(Number(d.announcement_updated_at))
        : '尚未发布过公告';
    } catch (e) { /* 忽略 */ }
  }
  if (el('editAnnouncementBtn')) el('editAnnouncementBtn').addEventListener('click', async () => {
    if (window.PermGate && !PermGate.has('AUTH_PRIVACY')) { toastErr('仅运维者可发布公告'); return; }
    const v = await formDialog('发布公告', '发布后会邮件通知全体用户，并在用户登录后弹窗展示（一次性确认后即不再弹出）。', [
      { name: 'text', label: '公告内容', multiline: true, rows: 8, value: announcementText, placeholder: '支持换行；发布后覆盖上一份公告' },
      { name: 'summary', label: '摘要（邮件中会展示）' }
    ], '发布并通知');
    if (!v) return;
    if (!v.text) { toastErr('公告内容不能为空'); return; }
    try {
      const r = await api.put('api/settings/announcement', { text: v.text, summary: v.summary });
      toast(r.message || '已发布'); loadAnnouncement();
    } catch (e) { toastErr(e.message); }
  });

  if (el('editPrivacyBtn')) el('editPrivacyBtn').addEventListener('click', async () => {
    if (!window.PermGate || !PermGate.has('AUTH_PRIVACY')) return;
    const v = await formDialog('编辑隐私告知', '更新后会邮件通知全体用户重新确认。', [
      { name: 'text', label: '隐私告知全文' },
      { name: 'summary', label: '变更摘要（邮件中会展示）' }
    ], '保存并通知');
    if (!v) return;
    try {
      const r = await api.put('api/settings/privacy', { text: v.text, summary: v.summary });
      toast(r.message || '已更新'); loadNotify();
    } catch (e) { toastErr(e.message); }
  });

  if (el('maintOnBtn')) el('maintOnBtn').addEventListener('click', async () => {
    if (!window.PermGate || !PermGate.has('SYS_MAINTENANCE')) return;
    if (el('maintOnBtn').disabled) return;   // 维护中：已灰度，避免重复入场
    if (!await confirmBox('确认进入维护模式？在线用户会先收到预告邮件。')) return;
    try {
      const r = await api.put('api/settings/maintenance', {
        enabled: true, restore_at: el('maintRestore').value.trim()
      });
      toast(r.message || '已进入维护模式'); loadNotify();
    } catch (e) { toastErr(e.message); }
  });
  if (el('maintOffBtn')) el('maintOffBtn').addEventListener('click', async () => {
    if (!window.PermGate || !PermGate.has('SYS_MAINTENANCE')) return;
    try {
      const r = await api.put('api/settings/maintenance', { enabled: false });
      toast(r.message || '维护已结束'); loadNotify();
    } catch (e) { toastErr(e.message); }
  });

  /* ---------------- 权限管理：批量授予被管理账号权限 ---------------- */
  let authzUsers = [];
  let authzCodes = [];
  function permLabel(code) {
    return (window.PermGate && PermGate.permLabel) ? PermGate.permLabel(code) : code;
  }

  async function loadAuthz() {
    try {
      const [codesRes, usersRes] = await Promise.all([
        api.get('api/permissions/codes'),
        api.get('api/admin/users')
      ]);
      authzCodes = codesRes.grantable || [];
      // 全部被管理账号都展示在「向下授权」对象列表中；但普通学生（role === 'normal'）用户端没有
      // 对应控件、授予后无法使用，故在前端置为「不可选」并标注，服务端同样会拒绝（见 permissions.js）。
      authzUsers = usersRes.users || [];
      renderAuthzPerms();
      renderAuthzUsers();
      loadGrants();
    } catch (e) { toastErr(e.message); }
  }

  function renderAuthzPerms() {
    const box = el('authzPerms');
    if (!box) return;
    box.innerHTML = authzCodes.length ? authzCodes.map(code => {
      const can = !window.PermGate || PermGate.has(code);
      return `<label class="chk" style="${can ? '' : 'opacity:.5'}">
        <input type="checkbox" class="authz-perm" value="${code}" ${can ? '' : 'disabled'}>
        ${escapeHtml(permLabel(code))}
      </label>`;
    }).join('') : '<div class="empty">没有可下放的权限（需先持有可下放的权限）</div>';
    box.querySelectorAll('.authz-perm').forEach(cb => cb.addEventListener('change', syncAuthzInfo));
  }

  function renderAuthzUsers() {
    const box = el('authzUsers');
    if (!box) return;
    const q = (el('authzSearch') ? el('authzSearch').value.trim().toLowerCase() : '');
    const list = authzUsers.filter(u => !q
      || String(u.real_name || '').toLowerCase().includes(q)
      || String(u.student_id || '').toLowerCase().includes(q));
    if (!list.length) {
      box.innerHTML = '<div class="empty">没有可管理的账号</div>';
      syncAuthzInfo();
      return;
    }
    box.innerHTML = list.map(u => {
      // 普通学生用户端无对应控件：禁止作为授权对象（置灰不可选），避免「下放后无法使用」
      const isStudent = u.role === 'normal';
      return `<label class="chk"${isStudent ? ' style="opacity:.55"' : ''}>
        <input type="checkbox" class="authz-user" value="${u.id}"${isStudent ? ' disabled' : ''}>
        ${escapeHtml(u.real_name)}${u.student_id ? `（${escapeHtml(u.student_id)}）` : ''}
        <span class="tag">${escapeHtml(u.role_title)}</span>
        ${isStudent ? '<span class="tag warn" title="普通学生端无对应控件，授予后无法使用，故不可授权">不可授权</span>' : ''}
      </label>`;
    }).join('');
    box.querySelectorAll('.authz-user').forEach(cb => cb.addEventListener('change', syncAuthzInfo));
    syncAuthzInfo();
  }

  function syncAuthzInfo() {
    const nu = qsa('#authzUsers .authz-user:checked').length;
    const np = qsa('#authzPerms .authz-perm:checked').length;
    if (el('authzSelInfo')) el('authzSelInfo').textContent = `已选 ${nu} 个账号 · ${np} 项权限`;
  }

  if (el('authzReload')) el('authzReload').addEventListener('click', loadAuthz);
  if (el('authzSearch')) el('authzSearch').addEventListener('input', renderAuthzUsers);
  if (el('authzAll')) el('authzAll').addEventListener('change', () => {
    const on = el('authzAll').checked;
    // 跳过被禁用的普通学生（用户端无对应控件，不可授权）
    qsa('#authzUsers .authz-user').forEach(cb => { if (!cb.disabled) cb.checked = on; });
    syncAuthzInfo();
  });
  if (el('authzGrantBtn')) el('authzGrantBtn').addEventListener('click', async () => {
    if (!window.PermGate || !PermGate.has('AUTH_GRANT')) return;   // 未授权：perm-gate 已弹工单
    const userIds = qsa('#authzUsers .authz-user:checked').map(cb => Number(cb.value));
    const codes = qsa('#authzPerms .authz-perm:checked').map(cb => cb.value);
    if (!userIds.length) return toast('请选择要授权的账号');
    if (!codes.length) return toast('请选择要授予的权限');
    const days = Number(el('authzDays').value) || 0;
    if (!await confirmDialog('批量授予权限', `将向 ${userIds.length} 个账号授予 ${codes.length} 项权限${days > 0 ? `（有效 ${days} 天）` : '（长期）'}，确认继续？`, '确认授予')) return;
    el('authzGrantBtn').disabled = true;
    try {
      const r = await api.post('api/permissions/grant-batch', { user_ids: userIds, perm_codes: codes, days });
      toast(r.message || '已授予');
      loadGrants();
    } catch (e) { toastErr(e.message); }
    finally { el('authzGrantBtn').disabled = false; }
  });

  /* ---------------- 分区联动加载 ---------------- */
  window.onSectionChange = function (name) {
    if (name === 'publish') { loadFences(); loadActivities(); ensureDestMap(); }
    if (name === 'activity') loadActivities();
    if (name === 'roster') { loadActivities().then(loadRoster); }
    if (name === 'review') { loadActivities().then(loadOps); loadLeaves(); loadMakeups(); }
    if (name === 'accounts') loadAccounts();
    if (name === 'calendar') { loadUsers().then(() => { loadCalendar(); loadResets(); }); }
    if (name === 'stream') {
      // 审计日志属高危（VIEW_AUDIT 最低 R2）：未授权时整页模糊 + 点击弹工单
      if (window.PermGate && !PermGate.has('VIEW_AUDIT')) {
        PermGate.lockPage(el('sec-stream'), ['VIEW_AUDIT']);
      } else {
        if (window.PermGate) PermGate.unlockPage(el('sec-stream'));
        loadStream();
      }
    }
    if (name === 'fences') loadFenceEditor();
    if (name === 'workorders') { loadInbox(); loadMyOrders(); loadResets(); }
    if (name === 'notify') { loadNotify(); }
    // 系统安全：权限管理已并入本分区（我的权限 / 向下授权 / 已下放的权限 + 全局安全开关）
    if (name === 'security') { loadLv(); loadPerms(); loadAuthz(); loadAnnouncement(); loadSettings(); }
    if (name === 'devices') loadDevices();
    if (name === 'accountinfo') { /* 账号信息分区由 account-info.js 负责渲染 */ }
    if (name === 'dashboard') loadStats();
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


  /* ---------------- 活动范围（批次 / 分页 / 批量；编辑器在独立页面） ---------------- */
  function loadFenceEditor() { return window.initFencePanel(); }

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

  init();
})();
