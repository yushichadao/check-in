/* 消息中心（普通学生端 / 管理端 / 运维端共用）
 * ---------------------------------------------------------------
 * 服务端按「是否在线」分层投递：在线写站内消息、离线发邮件。
 * 本组件负责：轮询未读 → toast 提醒 → 侧边栏角标 →
 * 进入分区查看（分层：紧急 / 重要 / 普通），支持翻页、单条 / 批量删除。
 * 删除为本人消息管理操作：按 user_id 隔离、不写数据流留痕、无需二次验证。
 */
(function () {
  const LEVEL_TEXT = { urgent: '紧急', notice: '重要', info: '普通' };
  let PAGE_SIZE = 15;
  let seenMax = 0;          // 已弹过 toast 的最大消息 id
  let unread = 0;
  let navItem = null;
  let dot = null;
  let section = null;
  let listBox = null;
  let pagerBox = null;
  let pageSizeSel = null, prevBtn = null, nextBtn = null, infoEl = null;
  let pages = 1;
  let loaded = false;
  let page = 1;

  function setUnread(n) {
    unread = n || 0;
    if (!dot) return;
    dot.textContent = unread > 99 ? '99+' : String(unread);
    dot.classList.toggle('hidden', unread === 0);
    if (navItem) navItem.title = unread ? `消息中心（${unread} 条未读）` : '消息中心';
  }

  function renderList(items) {
    if (!listBox) return;
    if (!items || !items.length) { listBox.innerHTML = '<div class="empty">暂无消息</div>'; return; }
    listBox.innerHTML = items.map(n => `
      <div class="nt-item ${n.level} ${n.read ? '' : 'unread'}" data-id="${n.id}">
        <label class="chk nt-check"><input type="checkbox" data-id="${n.id}" aria-label="选择此消息"></label>
        <div class="nt-body">
          <div>${escapeHtml(n.title)}<span class="nt-lv ${n.level}">${LEVEL_TEXT[n.level] || '普通'}</span></div>
          ${n.body ? `<div class="muted" style="font-size:12px">${escapeHtml(n.body)}</div>` : ''}
          <div class="nt-meta">${fmtDateTime(n.created_at)}${n.read ? ' · 已读' : ' · 未读'}</div>
        </div>
        <button class="btn sm danger nt-del" data-del="${n.id}" type="button" title="删除这条消息">删除</button>
      </div>`).join('');
    const selall = section && section.querySelector('[data-selall]');
    if (selall) selall.checked = false;
  }

  async function deleteIds(ids) {
    ids = (ids || []).map(Number).filter(Boolean);
    if (!ids.length) { toast('请先选择要删除的消息'); return; }
    if (!await confirmBox(`确认删除选中的 ${ids.length} 条消息？此操作不可恢复（仅删除本人消息，不写数据流留痕）。`, true)) return;
    try {
      const d = await api.del('api/notifications', { ids });
      await loadPage(page);
      // 若本页已删空且不是第一页，回退到上一页，避免停在空白页
      if (listBox && listBox.querySelector('.empty') && page > 1) await loadPage(page - 1);
      refreshUnread();
      toast(d.message || '已删除');
    } catch (e) { toastErr(e.message); }
  }

  async function refreshUnread() {
    try {
      const d = await api.get('api/notifications/pending');
      setUnread(d.unread || 0);
    } catch (e) { /* 忽略 */ }
  }

  function renderPager(total, pgs, cur) {
    if (infoEl) infoEl.textContent = `共 ${total} 条 · 第 ${cur}/${pgs} 页`;
    if (prevBtn) prevBtn.disabled = cur <= 1;
    if (nextBtn) nextBtn.disabled = cur >= pgs;
  }

  async function loadPage(p) {
    try {
      const size = PAGE_SIZE > 0 ? Math.min(PAGE_SIZE, 100) : 100;
      const d = await api.get(`api/notifications?page=${p}&pageSize=${size}`);
      page = d.page || p;
      const total = d.total || 0;
      pages = PAGE_SIZE > 0 ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;
      const items = d.items || [];
      renderList(items);
      renderPager(total, pages, page);
      // 进入消息中心即视为已读：把本页未读标记已读并同步界面与角标
      const unreadIds = items.filter(i => !i.read).map(i => i.id);
      if (unreadIds.length) {
        try {
          await api.post('api/notifications/read', { ids: unreadIds });
          unreadIds.forEach(id => { const it = items.find(x => x.id === id); if (it) it.read = true; });
          renderList(items);
        } catch (e) { /* 标记失败则保留未读显示 */ }
      }
      refreshUnread();
    } catch (e) { toastErr(e.message); }
  }

  async function markAll() {
    try {
      await api.post('api/notifications/read', { ids: [] });
      await loadPage(1);
      refreshUnread();
    } catch (e) { toastErr(e.message); }
  }

  function ensureShell() {
    if (!section || listBox) return;
    section.innerHTML = `
      <div class="card">
        <header><h2>消息中心</h2></header>
        <div class="muted" style="font-size:12px;line-height:1.7" data-clean-hide>
          任意设备在线且活动时，仅在消息中心提醒；全部离线或在线不活动时，会按你的「通知偏好」决定是否同时发邮件。
          不想被邮件打扰，可在「账号信息 → 通知偏好」把活动提醒改为「仅站内消息」或「关闭」（密码 / 异地登录等安全邮件强制保留）。
        </div>
        <div class="row" style="justify-content:space-between;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap">
          <label class="chk"><input type="checkbox" data-selall> 全选本页</label>
          <div class="row end" style="gap:8px">
            <button class="btn sm danger" data-del-sel type="button">删除所选</button>
            <button class="btn sm" id="notifyMarkAll" type="button">全部标为已读</button>
          </div>
        </div>
        <div class="nt-list" data-list style="max-height:56vh;overflow:auto;margin-top:10px"><div class="empty">加载中…</div></div>
        <div class="row act-pager">
          <select id="ntPageSize" style="width:auto">
            <option value="10">每页 10 项</option><option value="15" selected>每页 15 项</option><option value="20">每页 20 项</option>
            <option value="30">每页 30 项</option><option value="50">每页 50 项</option><option value="100">每页 100 项</option>
            <option value="200">每页 200 项</option><option value="0">所有项</option>
          </select>
          <button class="btn sm" id="ntPrev" type="button">上一页</button>
          <span class="muted" id="ntPageInfo"></span>
          <button class="btn sm" id="ntNext" type="button">下一页</button>
        </div>
      </div>`;
    listBox = section.querySelector('[data-list]');
    pagerBox = section.querySelector('.act-pager');
    pageSizeSel = section.querySelector('#ntPageSize');
    prevBtn = section.querySelector('#ntPrev');
    nextBtn = section.querySelector('#ntNext');
    infoEl = section.querySelector('#ntPageInfo');
    if (prevBtn) prevBtn.onclick = () => { if (page > 1) loadPage(page - 1); };
    if (nextBtn) nextBtn.onclick = () => { if (page < pages) loadPage(page + 1); };
    if (pageSizeSel) pageSizeSel.onchange = () => {
      PAGE_SIZE = Number(pageSizeSel.value) || 0;
      page = 1;
      loadPage(1);
    };

    // 单条删除
    listBox.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) deleteIds([del.getAttribute('data-del')]);
    });
    // 单条勾选 → 同步「全选」状态
    listBox.addEventListener('change', (e) => {
      if (e.target.matches('input[data-id]')) {
        const selall = section.querySelector('[data-selall]');
        if (selall) {
          const boxes = listBox.querySelectorAll('input[data-id]');
          selall.checked = boxes.length > 0 && Array.from(boxes).every(c => c.checked);
        }
      }
    });
    // 全选本页
    const selall = section.querySelector('[data-selall]');
    if (selall) selall.addEventListener('change', () => {
      listBox.querySelectorAll('input[data-id]').forEach(c => { c.checked = selall.checked; });
    });
    // 批量删除
    const delSel = section.querySelector('[data-del-sel]');
    if (delSel) delSel.addEventListener('click', () => {
      const ids = Array.from(listBox.querySelectorAll('input[data-id]:checked')).map(c => c.getAttribute('data-id'));
      deleteIds(ids);
    });
    const all = section.querySelector('#notifyMarkAll');
    if (all) all.addEventListener('click', markAll);
  }

  async function poll(silent) {
    try {
      const d = await api.get('api/notifications/pending');
      const items = d.items || [];
      setUnread(d.unread || 0);
      const fresh = items.filter(i => i.id > seenMax).sort((a, b) => a.id - b.id);
      if (fresh.length) {
        seenMax = fresh[fresh.length - 1].id;
        if (!silent) {
          fresh.forEach((n, idx) => {
            if (n.level === 'urgent' || idx === 0) {
              setTimeout(() => toast(`[${LEVEL_TEXT[n.level] || '消息'}] ${n.title}`), idx * 300);
            }
          });
          if (fresh.length > 1) {
            setTimeout(() => toast(`另有 ${fresh.length - 1} 条消息，前往消息中心查看`), fresh.length * 300);
          }
        }
      }
      if (loaded && section && section.classList.contains('active')) {
        loadPage(page);
      }
    } catch (e) { /* 忽略轮询异常 */ }
  }

  function openMsg() {
    ensureShell();
    loaded = true;
    loadPage(1);
  }

  function start() {
    if (isAuthPage()) return;
    navItem = document.querySelector('.nav-item[data-section="msg"]');
    section = document.querySelector('#sec-msg');
    if (!navItem || !section) return;
    dot = navItem.querySelector('.n-badge');
    ensureShell();
    navItem.addEventListener('click', openMsg);
    poll(true).then(() => { setUnread(unread); });
    setInterval(() => poll(false), 20000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(false); });
  }

  window.NotifyCenter = { start, poll, open: openMsg };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
