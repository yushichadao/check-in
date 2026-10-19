/* 活动范围面板（管理端 / 开发端共用）
 * - 每个活动范围可包含多个范围（多边形），在独立页面内一并设置与保存
 * - 分页、名称搜索
 * - 勾选后批量编辑（坐标系 / 偏移）与批量删除
 * - 点击卡片进入独立页面 fence.html 查看地图与活动范围；新建请在「活动范围」列表顶部「新建活动范围」
 */
(function () {
  const id = (x) => document.getElementById(x);
  let selectedIds = new Set();
  let page = 1;
  let bound = false;
  let items = [];

  async function load() {
    const box = id('fenceBox');
    if (!box) return;
    const qs = new URLSearchParams({
      page: String(page),
      pageSize: id('fencePageSize').value,
      q: id('fenceSearch').value.trim()
    });
    try {
      const d = await api.get('api/fences/paged?' + qs.toString());
      items = d.fences || [];
      render(d);
    } catch (e) {
      box.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
    }
  }

  function render(d) {
    const box = id('fenceBox');
    const rows = d.fences || [];
    box.innerHTML = rows.length ? rows.map(f => {
      const polys = f.polygons || [];
      const hasOffset = !!(f.offset_lng || f.offset_lat);
      const meta = objMetaHtml(f.created_at, f.creator_name, f.creator_role);
      return `
    <div class="card flat fence-card" data-card="${f.id}">
      <div class="fc-head">
        <label class="chk" title="勾选后可批量操作">
          <input type="checkbox" class="fence-cb" data-id="${f.id}" ${selectedIds.has(f.id) ? 'checked' : ''}>
        </label>
        <h3 class="fc-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</h3>
        <svg class="fc-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>
      </div>
      <div class="fc-tags">
        <span class="tag">图形 ${polys.length} 个</span>
        ${hasOffset ? `<span class="tag">偏移 ${f.offset_lng || 0} / ${f.offset_lat || 0}</span>` : ''}
      </div>
      ${meta}
      <div class="fc-foot">
        <span class="muted fc-hint">点击卡片查看地图与范围</span>
        <button class="btn sm danger" data-del="${f.id}">删除</button>
      </div>
    </div>`;
    }).join('') : '<div class="empty">尚未配置活动范围，点击「新建活动范围」开始绘制</div>';

    const fpi = id('fencePageInput'); const ftp = id('fenceTotalPages');
      if (fpi) { fpi.value = d.page; fpi.max = d.pages; }
      if (ftp) ftp.textContent = d.pages;
    const pageIds = rows.map(f => f.id);
    if (id('fenceSelectAll')) {
      id('fenceSelectAll').checked = !!pageIds.length && pageIds.every(x => selectedIds.has(x));
    }
    syncSelected();

    // 点击卡片任意空白处 → 进入独立页面查看地图与活动范围
    qsa('#fenceBox [data-card]').forEach(card => {
      card.style.cursor = 'pointer';
      card.addEventListener('click', (ev) => {
        if (ev.target.closest('button, input, label, select, a')) return;
        goto('fence.html?id=' + card.getAttribute('data-card'));
      });
    });
    qsa('#fenceBox [data-del]').forEach(b => b.addEventListener('click', async () => {
      const f = items.find(x => x.id === Number(b.getAttribute('data-del')));
      if (!await confirmBox(`确认删除活动范围「${f ? f.name : ''}」？删除后可由上级管理员 / 运维者在「操作记录详情」中撤回恢复。`)) return;
      try {
        const r = await api.del('api/fences/' + b.getAttribute('data-del'));
        toast(r.message || '已删除');
        selectedIds.delete(Number(b.getAttribute('data-del')));
        load();
      } catch (e) { toastErr(e.message); }
    }));
    qsa('#fenceBox .fence-cb').forEach(cb => cb.addEventListener('change', () => {
      const fid = Number(cb.getAttribute('data-id'));
      if (cb.checked) selectedIds.add(fid); else selectedIds.delete(fid);
      syncSelected();
    }));
  }

  function syncSelected() {
    if (id('fenceSelectedInfo')) {
      id('fenceSelectedInfo').textContent = selectedIds.size ? `已选 ${selectedIds.size} 个` : '勾选活动范围后可批量操作';
    }
    if (id('fenceBulkDel')) id('fenceBulkDel').disabled = selectedIds.size === 0;
  }

  async function bulkEdit() {
    const ids = Array.from(selectedIds);
    if (!ids.length) return toast('请先勾选活动范围');
    const v = await formDialog('批量编辑活动范围', `将对选中的 ${ids.length} 个活动范围统一修改（留空则不修改该项）。`, [
      { name: 'offset_lng', label: '经度偏移', placeholder: '留空不改' },
      { name: 'offset_lat', label: '纬度偏移', placeholder: '留空不改' }
    ], '保存修改');
    if (!v) return;

    const body = { ids };
    if (v.offset_lng !== '' && Number.isFinite(Number(v.offset_lng))) body.offset_lng = Number(v.offset_lng);
    if (v.offset_lat !== '' && Number.isFinite(Number(v.offset_lat))) body.offset_lat = Number(v.offset_lat);

    if (Object.keys(body).length === 1) return toast('没有需要修改的内容');
    try {
      const r = await api.post('api/fences/bulk-update', body);
      toast(r.message || '已批量修改');
      selectedIds.clear();
      load();
    } catch (e) { toastErr(e.message); }
  }

  async function bulkDelete() {
    const ids = Array.from(selectedIds);
    if (!ids.length) return toast('请先勾选活动范围');
    if (!await confirmBox(`确认删除选中的 ${ids.length} 个活动范围？被活动使用的活动范围会跳过；删除后可由上级管理员 / 运维者在「操作记录详情」中撤回恢复。`)) return;
    try {
      const r = await api.post('api/fences/bulk-delete', { ids });
      toast(r.message || '已批量删除');
      selectedIds.clear();
      load();
    } catch (e) { toastErr(e.message); }
  }

  /** 绑定交互并加载（可在切换分区时重复调用，绑定只做一次） */
  function initFencePanel() {
    if (!bound) {
      bound = true;
      const newBtn = id('fenceNew');
      if (newBtn) newBtn.addEventListener('click', () => goto('fence.html?edit=1'));
      if (id('reloadFences')) id('reloadFences').addEventListener('click', () => { page = 1; load(); });
      if (id('fenceSearch')) id('fenceSearch').addEventListener('input', () => { page = 1; load(); });
      if (id('fencePageSize')) id('fencePageSize').addEventListener('change', () => { page = 1; load(); });
      if (id('fencePrev')) id('fencePrev').addEventListener('click', () => { if (page > 1) { page -= 1; load(); } });
      if (id('fenceNext')) id('fenceNext').addEventListener('click', () => { page += 1; load(); });
      if (id('fencePageInput')) id('fencePageInput').addEventListener('change', () => {
        let v = parseInt(id('fencePageInput').value, 10) || 1;
        const max = parseInt(id('fencePageInput').max, 10) || 1;
        if (v < 1) v = 1; if (v > max) v = max;
        id('fencePageInput').value = v; page = v; load();
      });
      if (id('fenceSelectAll')) id('fenceSelectAll').addEventListener('change', () => {
        const on = id('fenceSelectAll').checked;
        items.forEach(f => { if (on) selectedIds.add(f.id); else selectedIds.delete(f.id); });
        load();
      });
      if (id('fenceBulkEdit')) id('fenceBulkEdit').addEventListener('click', bulkEdit);
      if (id('fenceBulkDel')) id('fenceBulkDel').addEventListener('click', bulkDelete);
    }
    return load();
  }

  window.initFencePanel = initFencePanel;
})();
