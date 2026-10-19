/* 独立活动范围页：查看 / 新建活动范围。
 * 一个活动范围（围栏）可包含多个多边形「范围」，在单个设置页内一并绘制与保存。
 * 注意：原「编辑已有活动范围」功能已移除——只允许新建（添加），不允许修改已有范围。
 * 地址参数：
 *   fence.html?id=12          查看某个活动范围
 *   fence.html?edit=1         新建活动范围
 */
(function () {
  const P = new URLSearchParams(location.search);
  const SHAPE_ICO = '<svg class="ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M12 3 21 8v8l-9 5-9-5V8l9-5Z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/></svg>';
  let me = null;
  let editor = null;
  let fences = [];          // 全部活动范围
  let current = null;       // 当前查看/编辑的活动范围
  let mode = 'view';        // view（查看）| new（新建 / 添加）
  let fLayerSat = false;    // 当前底图是否为卫星（持久状态）
  let fLayerToggle = null;  // 底图切换组件（bindLayerToggle）

  // 已移除「编辑已有活动范围」功能：仅保留「查看」与「新建（添加）」
  const isEditing = () => mode === 'new';

  /** 未保存草稿的会话存储键（按活动范围区分；新建用 'new'） */
  const draftKey = () => 'fenceDraft:' + ((current && current.id) || 'new');
  function saveDraftSession() {
    if (!editor) return;
    try { sessionStorage.setItem(draftKey(), JSON.stringify(editor.serialize())); } catch (e) { /* 忽略 */ }
  }
  function clearDraftSession() {
    try { sessionStorage.removeItem(draftKey()); } catch (e) { /* 忽略 */ }
  }
  function readDraftSession() {
    try { const s = sessionStorage.getItem(draftKey()); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  /** 离开编辑页前检查未保存草稿：有则弹确认，确认后清除会话草稿并继续；取消则留在编辑页 */
  async function leaveWithCheck(proceed) {
    if (editor && editor.dirty && readDraftSession()) {
      if (!await confirmBox('有未保存的修改，确定要离开并丢弃吗？')) return;
      clearDraftSession();
    }
    proceed();
  }

  async function init() {
    try {
      const d = await api.get('api/auth/me');
      me = d.user;
      if (!['ops', 'manager'].includes(me.role)) { goto(d.redirect); return; }
      if (window.PermGate) { PermGate.init(d.perm || {}); PermGate.apply(document); }
    } catch (e) { goto('login.html'); return; }

    const id = Number(P.get('id')) || 0;
    // 带 id 一律为「查看」；&edit=1 不再进入编辑（编辑功能已移除）
    mode = id ? 'view' : 'new';

    await loadAll();
    buildEditor();
    render();
  }

  async function loadAll() {
    try {
      const d = await api.get('api/fences');
      fences = d.fences || [];
    } catch (e) { toastErr(e.message); }
  }

  function buildEditor() {
    editor = new FenceEditor({
      mapId: 'fenceMap',
      onDraftChange: (draft, count) => {
        const box = el('fDraftCount');
        if (box) {
          box.classList.toggle('empty', count === 0);
          box.innerHTML = SHAPE_ICO + ` 图形 ${count} 个`;
        }
        saveDraftSession();
      }
    });
    editor.invalidate();
    if (!isEditing()) return;   // 查看模式：只显示地图与活动范围，不绑定绘制工具

    const toolBtns = { polygon: el('fPoly'), rect: el('fRect'), circle: el('fCircle'), select: el('fSelect') };
    function syncToolBtns(mode) {
      Object.entries(toolBtns).forEach(([k, b]) => { if (b) b.classList.toggle('active', k === mode); });
    }
    el('fPoly').addEventListener('click', () => { editor.setMode('polygon'); syncToolBtns('polygon'); });
    el('fRect').addEventListener('click', () => { editor.setMode('rect'); syncToolBtns('rect'); });
    el('fCircle').addEventListener('click', () => { editor.setMode('circle'); syncToolBtns('circle'); });
    el('fSelect').addEventListener('click', () => { editor.setMode('select'); syncToolBtns('select'); });
    el('fClear').addEventListener('click', () => {
      editor.clearDraft();
      syncToolBtns('');
      clearDraftSession();
      const box = el('fDraftCount');
      if (box) {
        box.classList.add('empty');
        box.innerHTML = SHAPE_ICO + ' 图形 0 个';
      }
    });
    fLayerToggle = bindLayerToggle(el('fLayerBtn'), {
      get: () => fLayerSat,
      set: (sat) => { fLayerSat = sat; if (editor) editor.setLayer(sat ? 'satellite' : 'street'); }
    });
    el('fSave').addEventListener('click', save);
    // 离开 / 刷新保护：存在未保存草稿时提醒
    window.addEventListener('beforeunload', (e) => {
      if (editor && editor.dirty && readDraftSession()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function render() {
    const id = Number(P.get('id')) || 0;
    if (id) current = fences.find(f => f.id === id) || null;

    // 已移除编辑功能：editCard 仅「新建」时显示
    const editing = mode === 'new';
    el('editCard').classList.toggle('hidden', !editing);
    if (el('editTitle')) el('editTitle').textContent = '新建活动范围';
    if (el('cardTitle')) el('cardTitle').textContent = editing ? '新建活动范围' : '活动范围详情';
    el('pageTitle').textContent = editing ? '新建活动范围' : '活动范围详情';
    el('pageHint').textContent = '';

    if (!editor) return;

    if (mode === 'view') {
      editor.renderFences(current ? [current] : []);
      if (current) fitTo([current]);
    } else {
      // 新建：清空地图，准备绘制
      editor.renderFences([]);
    }

    renderMeta();
  }

  /** 缩放到给定活动范围范围（含其多个多边形） */
  function fitTo(list) {
    const pts = [];
    (list || []).forEach(f => {
      const polys = (f.polygons && f.polygons.length) ? f.polygons
        : (Array.isArray(f.points) && f.points.length ? (Array.isArray(f.points[0]) && !Array.isArray(f.points[0][0]) ? [f.points] : f.points) : []);
      polys.forEach(poly => (poly || []).forEach(p => pts.push([Number(p[1]), Number(p[0])])));
    });
    if (!pts.length) return;
    try { editor.map.fitBounds(pts, { padding: [40, 40], maxZoom: 18 }); } catch (e) { /* 忽略 */ }
  }

  function renderMeta() {
    const box = el('fenceMeta');
    if (!current) {
      box.innerHTML = mode === 'new'
        ? '在地图上绘制活动范围（可绘制多个多边形范围，一起保存为一个活动范围）。系统自动处理坐标换算。'
        : '在地图上绘制活动范围后保存即可；系统自动处理坐标换算。';
      return;
    }
    const ranges = (current.polygons && current.polygons.length) || 0;
    const verts = (current.polygons || []).reduce((s, p) => s + (p ? p.length : 0), 0);
    box.innerHTML = `范围 <b>${ranges}</b> 个 ｜ 顶点共 <b>${verts}</b> 个 ｜ 坐标系 ${escapeHtml(current.coord_system)}
      ｜ ${(current.offset_lng || current.offset_lat) ? `偏移 ${current.offset_lng || 0}/${current.offset_lat || 0} ｜ ` : ''}严格按绘制边界判定`;
  }

  async function save() {
    const all = editor.getAllDraftsMeta();
    if (!all.length) return toast('请先在地图上绘制活动范围（至少 3 个顶点）');
    // 逐个范围校验「至少 3 个不重复顶点」，精确提示第几个范围非法，避免整次保存失败
    for (let i = 0; i < all.length; i++) {
      const uniq = new Set(all[i].points.map(p => Number(p[0]).toFixed(7) + ',' + Number(p[1]).toFixed(7)));
      if (uniq.size < 3) {
        return toast(`第 ${i + 1} 个范围顶点不足或重复（需至少 3 个不重复顶点），请检查后重试`);
      }
    }
    const name = el('fBatch').value.trim();
    if (!name) return toast('请填写活动范围名称后再保存');
    // 一个活动范围 = 多个多边形（范围），统一保存为一个围栏实体
    const points = all.map(x => x.points);
    try {
      // 仅在「第一次添加（新建）」时确认一次（持久化，避免每次都弹窗打断）
      if (!localStorage.getItem('fenceAddConfirmed')) {
        if (!await confirmBox('确认要新建该活动范围吗？保存后若需修改，只能在「活动范围」列表中删除并重新绘制。')) return;
        localStorage.setItem('fenceAddConfirmed', '1');
      }
      const r = await api.post('api/fences', { name, points });
      editor.clearDraft();
      clearDraftSession();
      toast('活动范围已创建');
      gotoReplace('fence.html?id=' + r.id);
    } catch (e) { toastErr(e.message); }
  }

  el('backBtn').addEventListener('click', () => {
    leaveWithCheck(() => {
      if (history.length > 1) history.back();
      else goto(me && me.role === 'ops' ? 'ops.html' : 'manager.html');
    });
  });
  el('reloadBtn').addEventListener('click', async () => { await loadAll(); render(); });

  init();
})();
