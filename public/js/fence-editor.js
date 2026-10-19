/* 活动范围地图编辑器（运维端 / 管理端共用）
 * 依赖：Leaflet（本地 vendor）+ polygon-clipping（本地 vendor，用于同批多活动范围 union 合并）
 *
 * 能力：
 *  - 一个活动范围可连续绘制并保存多个范围（多边形），各自独立、不自动合并
 *  - 圆形工具使用真正的 Leaflet 圆：可拖拽圆心、可拖拽半径把手，绘制时实时幽灵预览
 *  - 「选择」模式：多边形 / 矩形顶点显示小方块手柄，可拖拽移动、单击删除（含 hover 高亮）
 *  - 支持多草稿（一次画多个，保存时逐个入库）
 */
(function () {
  // 国内可用的高德（GCJ-02）瓦片：无需密钥，电子地图/卫星地图均可用。
  const TILE_STREET = {
    url: 'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
    attribution: '© 高德地图',
    subdomains: '1234'
  };
  const TILE_SAT = {
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    attribution: '© 高德地图',
    subdomains: '1234'
  };

  const COLOR_DRAFT = '#1666b8';
  const COLOR_SAVED = '#0a7d3c';
  function distM(a, b) {
    const m = 111320 * Math.cos(a.lat * Math.PI / 180);
    const dx = (b.lng - a.lng) * m;
    const dy = (b.lat - a.lat) * 110540;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** 圆心 + 半径（米）→ 多边形顶点（[lat,lng] 顺序） */
  function circleToLatLngs(center, radiusM, seg) {
    seg = seg || 64;
    const pts = [];
    const dLat = radiusM / 110540;
    const dLng = radiusM / (111320 * Math.cos(center.lat * Math.PI / 180));
    for (let i = 0; i < seg; i++) {
      const t = (i / seg) * 2 * Math.PI;
      pts.push([center.lat + dLat * Math.sin(t), center.lng + dLng * Math.cos(t)]);
    }
    return pts;
  }

  class FenceEditor {
    constructor(opts) {
      this.opts = Object.assign({
        center: [39.9929, 116.3569],
        zoom: 16,
        onSave: () => {},
        onDelete: () => {},
        onEdit: () => {},
        loadFences: () => [],
        onDraftChange: () => {}
      }, opts);

      // 禁用双击缩放：双击在本编辑器中专用于「闭合多边形」，不应触发地图缩放
      this.map = L.map(this.opts.mapId, { center: this.opts.center, zoom: this.opts.zoom, zoomControl: true, doubleClickZoom: false });
      this.street = L.tileLayer(TILE_STREET.url, { attribution: TILE_STREET.attribution, subdomains: TILE_STREET.subdomains, maxZoom: 18 });
      this.sat = L.tileLayer(TILE_SAT.url, { attribution: TILE_SAT.attribution, subdomains: TILE_SAT.subdomains, maxZoom: 18 });
      this.street.addTo(this.map);
      this.currentLayer = this.street;

      this.layers = L.layerGroup().addTo(this.map);     // 已保存活动范围
      this.draftLayer = L.layerGroup().addTo(this.map); // 正在绘制（当前草稿）
      this.savedDraftLayer = L.layerGroup().addTo(this.map); // 本次会话已画好的其它草稿
      this.locLayer = L.layerGroup().addTo(this.map);   // 实时定位点
      this.destLayer = L.layerGroup().addTo(this.map);  // 活动目的地（终点）标记

      this.mode = 'view';           // view | polygon | rect | circle | select
      this.draft = [];              // 当前草稿顶点 [{lat,lng}]
      this.drafts = [];             // 已完成的草稿（本次可保存多个）
      this.rectStart = null;
      this.circleCenter = null;
      this.circleGhost = null;
      this.editingId = null;
      this.activeId = null;          // 当前正在编辑的已保存活动范围 id（组编辑时用于回写）
      this.dirty = false;           // 自服务端载入后是否有未保存改动（用于刷新/离开保护）

      this._bindMapEvents();
    }

    setLayer(name) {
      if (name === 'satellite' && this.currentLayer !== this.sat) {
        this.map.removeLayer(this.street); this.sat.addTo(this.map); this.currentLayer = this.sat;
      } else if (name === 'street' && this.currentLayer !== this.street) {
        this.map.removeLayer(this.sat); this.street.addTo(this.map); this.currentLayer = this.street;
      }
    }

    _bindMapEvents() {
      this.map.on('click', (e) => {
        if (this.mode === 'polygon') this._polyClick(e);
        else if (this.mode === 'rect') this._rectClick(e);
        else if (this.mode === 'circle') this._circleClick(e);
      });
      this.map.on('mousemove', (e) => {
        if (this.mode === 'circle' && this.circleCenter) this._circleGhost(e);
        else if ((this.mode === 'polygon' || this.mode === 'rect') && this.draft.length) this._draftGhost(e);
      });
      this.map.on('dblclick', (e) => {
        if (this.mode === 'polygon') { L.DomEvent.stop(e); this._finishPolygon(); }
      });
      this.map.on('contextmenu', (e) => {
        L.DomEvent.stop(e);   // 始终阻止浏览器默认右键菜单
        if (this.mode === 'polygon') this._finishPolygon();   // 绘制中：右键闭合多边形
      });
    }

    /* -------------------- 绘制：多边形 -------------------- */
    _polyClick(e) {
      const p = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (this.draft.length >= 3) {
        const f = this.draft[0];
        const fp = this.map.latLngToContainerPoint([f.lat, f.lng]);
        const cp = this.map.latLngToContainerPoint([p.lat, p.lng]);
        if (fp.distanceTo(cp) < 12) { this._finishPolygon(); return; }   // 点回起点即闭合
      }
      this.draft.push(p);
      this._renderDraft();
    }

    _finishPolygon() {
      if (this.dedupePts(this.draft).length < 3) {
        // 双击收尾时，双击的前一次点击往往已把多边形作为草稿保存；此时 current draft
        // 只是双击带来的残留杂点（不足 3 个顶点），属于正常收尾，不应报「顶点不足」。
        // 仅当「还没有任何已保存草稿」时才提示真正画错了。
        if (this.drafts.length > 0) {
          this.draft = [];
          this._renderDraft();
          this._emitDraftChange();
          return;
        }
        toast('活动范围至少需要 3 个不重复的顶点（封闭图形），请重新绘制');
        return;
      }
      this._pushDraft();
      toast(`已添加第 ${this.drafts.length} 个活动范围草稿，可继续绘制或保存`);
    }

    /* -------------------- 绘制：矩形 -------------------- */
    _rectClick(e) {
      const p = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (!this.rectStart) { this.rectStart = p; this.draft = [p]; this._renderDraft(); return; }
      const a = this.rectStart, b = p;
      this.draft = [
        { lat: a.lat, lng: a.lng }, { lat: a.lat, lng: b.lng },
        { lat: b.lat, lng: b.lng }, { lat: b.lat, lng: a.lng }
      ];
      this.rectStart = null;
      this._pushDraft();
      toast(`已添加第 ${this.drafts.length} 个活动范围草稿，可继续绘制或保存`);
    }

    /* -------------------- 绘制：真圆 -------------------- */
    _circleClick(e) {
      const p = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (!this.circleCenter) {
        this.circleCenter = p;
        this._renderDraft();
        toast('已确定圆心，移动鼠标预览半径，再次点击确定半径');
        return;
      }
      const R = Math.max(2, distM(this.circleCenter, p));
      this.draft = circleToLatLngs(this.circleCenter, R)
        .map(ll => ({ lat: ll[0], lng: ll[1] }));
      this.circleCenter = null;
      this._pushDraft();
      toast(`已添加第 ${this.drafts.length} 个圆形活动范围草稿（半径约 ${Math.round(R)} 米）`);
    }

    /** 圆形绘制过程中的幽灵预览（随鼠标实时变化） */
    _circleGhost(e) {
      const R = Math.max(2, distM(this.circleCenter, e.latlng));
      const latlngs = circleToLatLngs(this.circleCenter, R);
      this.draftLayer.clearLayers();
      L.circle([this.circleCenter.lat, this.circleCenter.lng], {
        radius: R, color: COLOR_DRAFT, weight: 2, fillColor: COLOR_DRAFT, fillOpacity: 0.10, dashArray: '5,4'
      }).addTo(this.draftLayer);
      L.circleMarker([this.circleCenter.lat, this.circleCenter.lng], {
        radius: 5, color: COLOR_DRAFT, fillColor: '#fff', fillOpacity: 1
      }).addTo(this.draftLayer).bindTooltip('圆心', { permanent: true });
      const edge = latlngs[0];
      L.circleMarker(edge, { radius: 4, color: COLOR_DRAFT, fillColor: COLOR_DRAFT, fillOpacity: 1 })
        .addTo(this.draftLayer)
        .bindTooltip(`半径 ${Math.round(R)} 米`, { permanent: true });
    }

    /** 多边形 / 矩形绘制过程中：跟随鼠标的虚线幽灵线 */
    _draftGhost(e) {
      const last = this.draft[this.draft.length - 1];
      const latlngs = this.draft.map(p => [p.lat, p.lng]);
      this.draftLayer.clearLayers();
      L.polygon(latlngs.concat([[e.latlng.lat, e.latlng.lng]]), {
        color: COLOR_DRAFT, weight: 2, fillColor: COLOR_DRAFT, fillOpacity: 0.10, dashArray: '5,4'
      }).addTo(this.draftLayer);
      this._renderVertices();
      if (last) {
        L.polyline([[last.lat, last.lng], [e.latlng.lat, e.latlng.lng]], {
          color: COLOR_DRAFT, weight: 1, dashArray: '3,5', opacity: 0.7
        }).addTo(this.draftLayer);
      }
    }

    /* -------------------- 草稿管理 -------------------- */
    /** 把当前草稿收入「本次待保存」列表，并清空当前绘制区 */
    _pushDraft() {
      const dd = this.dedupePts(this.draft);
      if (dd.length < 3) {
        // 不足 3 个不重复顶点（如矩形/圆画得太小被去重）：清空半成品，避免遗留的草稿
        // 在下次收尾时误触发「至少需要 3 个顶点」的提示
        this.draft = [];
        this.rectStart = null;
        this.circleCenter = null;
        this._renderDraft();
        this._emitDraftChange();
        return;
      }
      this.drafts.push({ id: null, pts: dd });
      this.draft = [];
      this.rectStart = null;
      this.circleCenter = null;
      this.dirty = true;
      this._renderDraft();
      this._renderSavedDrafts();
      this._emitDraftChange();
    }

    /** 绘制完成：停留在草稿，等待保存（兼容旧调用） */
    _finishDraft() { /* no-op：现在支持多草稿，由 _pushDraft 收集 */ }

    _emitDraftChange() {
      if (this.opts.onDraftChange) {
        this.opts.onDraftChange(this.draft.slice(), this.drafts.length + (this.draft.length >= 3 ? 1 : 0));
      }
    }

    /** 渲染当前正在绘制的草稿 + 顶点手柄 */
    _renderDraft() {
      this.draftLayer.clearLayers();
      if (this.draft.length === 0) { this._emitDraftChange(); return; }
      const latlngs = this.draft.map(p => [p.lat, p.lng]);
      this._draftPoly = null;
      if (latlngs.length >= 3) {
        const poly = L.polygon(latlngs, {
          color: COLOR_DRAFT, weight: 2, fillColor: COLOR_DRAFT, fillOpacity: 0.12, dashArray: '5,4'
        }).addTo(this.draftLayer);
        this._draftPoly = poly;
      } else {
        L.polyline(latlngs, { color: COLOR_DRAFT, weight: 2, dashArray: '5,4' }).addTo(this.draftLayer);
      }
      this._renderVertices();
      this._emitDraftChange();
    }

    /** 仅更新多边形形状（不重建图层；供拖动顶点时使用，避免重建中断拖动） */
    _updateShape() {
      if (this._draftPoly && this.draft.length >= 3) {
        this._draftPoly.setLatLngs(this.draft.map(p => [p.lat, p.lng]));
      }
    }

    /** 顶点手柄：拖动移动、右键删除（select 模式下；单击不删除） */
    _renderVertices() {
      const editable = this.mode === 'select';
      this.draft.forEach((p, i) => {
        if (!editable) {
          L.circleMarker([p.lat, p.lng], { radius: 4, color: COLOR_DRAFT, weight: 2, fillColor: '#fff', fillOpacity: 1 })
            .addTo(this.draftLayer)
            .bindTooltip(`点 ${i + 1}`);
          return;
        }
        // 用可拖拽标记做顶点：层次更高、显示清晰，拖动由 Leaflet 处理，天然不与地图拖动/活动范围平移冲突
        const icon = L.divIcon({
          className: 'vertex-marker',
          html: '<div class="vertex-dot"></div>',
          iconSize: [14, 14], iconAnchor: [7, 7]
        });
        const m = L.marker([p.lat, p.lng], { icon, draggable: true, autoPan: false, keyboard: false }).addTo(this.draftLayer);
        m.bindTooltip(`顶点 ${i + 1}（拖动移动；右键删除）`, { direction: 'top' });
        // 拖动：暂停地图拖动（避免与地图平移冲突），只更新形状与坐标，不重建图层（重建会中断拖动）
        m.on('dragstart', () => { try { this.map.dragging.disable(); } catch (e) { /* 忽略 */ } });
        m.on('drag', (ev) => {
          const ll = ev.target.getLatLng();
          this.draft[i] = { lat: ll.lat, lng: ll.lng };
          this._updateShape();
        });
        m.on('dragend', () => {
          try { this.map.dragging.enable(); } catch (e) { /* 忽略 */ }
          this.dirty = true;
          this._renderDraft();
          this._emitDraftChange();
        });
        // 右键删除顶点（至少保留 3 个）——避免单击误删
        m.on('contextmenu', (ev) => {
          L.DomEvent.stopPropagation(ev);
          if (this.draft.length <= 3) { toast('活动范围至少需要 3 个顶点'); return; }
          this.draft.splice(i, 1);
          this.dirty = true;
          this._renderDraft();
          this._emitDraftChange();
        });
      });
    }

    /** 渲染本次已收集、尚未保存的其它草稿 */
    _renderSavedDrafts() {
      this.savedDraftLayer.clearLayers();
      this.drafts.forEach((d, idx) => {
        const latlngs = d.pts.map(p => [p.lat, p.lng]);
        const poly = L.polygon(latlngs, {
          color: COLOR_DRAFT, weight: 2, fillColor: COLOR_DRAFT, fillOpacity: 0.18
        }).addTo(this.savedDraftLayer)
          .bindTooltip(`待保存活动范围 ${idx + 1}（右键移除；点击可编辑顶点）`, { permanent: false });
        poly.on('contextmenu', async (ev) => {
          L.DomEvent.stop(ev);
          // 右键任意范围即移除该草稿（不再依赖「选择」模式；单击不会删除，避免误删）
          if (typeof confirmBox === 'function' && !await confirmBox('确认移除该草稿？')) return;
          this.drafts.splice(idx, 1);
          this._renderSavedDrafts();
          this._emitDraftChange();
          toast('已移除该草稿');
        });
        // 选择模式下：点击范围即把它载入当前草稿层进行顶点编辑
        if (this.mode === 'select') {
          poly.on('click', (ev) => { L.DomEvent.stopPropagation(ev); this._editDraft(idx); });
        }
      });
    }

    /** 把某个待保存草稿载入当前草稿层（this.draft）进行顶点编辑 */
    _editDraft(idx) {
      const d = this.drafts[idx];
      if (!d) return;
      this._commitDraft();                 // 先把正在编辑的草稿归位，避免丢失
      this.drafts.splice(idx, 1);
      this.draft = d.pts.map(p => ({ lat: Number(p.lat), lng: Number(p.lng) }));
      this.activeId = d.id;
      this.mode = 'select';
      this.dirty = true;
      this._renderSavedDrafts();
      this._renderDraft();
      this._emitDraftChange();
      toast('正在编辑该范围：拖动顶点修改，右键顶点删除；点击空白处或其它范围完成编辑');
      if (this.opts.onEdit) this.opts.onEdit();
    }

    /** 把当前正在编辑的草稿（this.draft）归位到草稿列表（切换工具 / 编辑其它范围前保存进度） */
    _commitDraft() {
      if (this.draft.length >= 3) {
        const dd = this.dedupePts(this.draft);
        if (dd.length >= 3) this.drafts.push({ id: this.activeId, pts: dd });
      }
      this.draft = [];
      this.activeId = null;
    }

    setMode(mode) {
      this.mode = mode;
      // 进入绘制模式前，先把正在编辑的草稿（this.draft）归位到草稿列表，避免丢失顶点修改；
      // 查看模式保留已载入草稿，避免「编辑→查看」误删未保存活动范围
      if (mode === 'polygon' || mode === 'rect' || mode === 'circle') { this._commitDraft(); this.draft = []; }
      this.rectStart = null;
      this.circleCenter = null;
      this.draftLayer.clearLayers();
      this.map.getContainer().style.cursor = (mode === 'view' || mode === 'select') ? '' : 'crosshair';
      this._renderDraft();
      this._emitDraftChange();
    }

    /** select 模式：顶点跟随鼠标拖动 */
    clearDraft() {
      this.drafts = [];
      this.draft = [];
      this.activeId = null;
      this.rectStart = null;
      this.circleCenter = null;
      this.savedDraftLayer.clearLayers();
      this.draftLayer.clearLayers();
      this.mode = 'view';
      this.dirty = false;            // 清空即无未保存改动，避免 beforeunload 误拦截后续跳转
      this.map.getContainer().style.cursor = '';
      this._emitDraftChange();
    }

    /** 序列化当前草稿（用于刷新 / 离开前的草稿保护） */
    serialize() {
      return {
        drafts: this.drafts.map(d => ({ id: d.id, pts: d.pts })),
        draft: this.draft,
        activeId: this.activeId,
        // 绘制中途态统一归到 select，便于刷新后继续编辑顶点
        mode: (this.mode === 'select' || this.mode === 'view') ? this.mode : 'select',
        dirty: this.dirty
      };
    }

    /** 还原草稿（浏览器刷新后恢复未保存内容）；成功返回 true */
    restore(data) {
      if (!data) return false;
      this.drafts = (data.drafts || []).map(d => ({ id: d.id, pts: (d.pts || []).map(p => ({ lat: p.lat, lng: p.lng })) }));
      this.draft = (data.draft || []).map(p => ({ lat: p.lat, lng: p.lng }));
      this.activeId = (data.activeId != null ? data.activeId : null);
      this.rectStart = null;
      this.circleCenter = null;
      this.dirty = !!data.dirty;
      this.mode = (data.mode === 'select' || data.mode === 'view') ? data.mode : 'select';
      this._renderSavedDrafts();
      this._renderDraft();
      this._emitDraftChange();
      return true;
    }

    /** 当前草稿多边形（[lng,lat] 顺序，闭合）；无当前草稿时返回 null */
    getDraftGCJ() {
      if (this.draft.length >= 3) return this._toGCJ(this.draft);
      return null;
    }

    /** 去除连续重复顶点（含首尾闭合造成的重复），精度与后端保持一致（7 位小数）。
     *  用于绘制 / 保存前清洗，避免 A,B,A 这类退化多边形触发「至少需要 3 个不重复顶点」。 */
    dedupePts(pts) {
      const out = [];
      for (const p of (pts || [])) {
        const lat = p && p.lat != null ? Number(p.lat) : Number(p && p[1]);
        const lng = p && p.lng != null ? Number(p.lng) : Number(p && p[0]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const last = out[out.length - 1];
        if (last && last.lat.toFixed(7) === lat.toFixed(7) && last.lng.toFixed(7) === lng.toFixed(7)) continue;
        out.push({ lat, lng });
      }
      if (out.length > 1) {
        const f = out[0], l = out[out.length - 1];
        if (f.lat.toFixed(7) === l.lat.toFixed(7) && f.lng.toFixed(7) === l.lng.toFixed(7)) out.pop();
      }
      return out;
    }

    /** 本次全部待保存草稿（含当前正在绘制的）→ [{id, points:[[lng,lat]...]}] */
    getAllDraftsMeta() {
      const out = this.drafts.map(d => ({ id: d.id, points: this._toGCJ(this.dedupePts(d.pts)) }));
      if (this.draft.length >= 3) out.push({ id: this.activeId, points: this._toGCJ(this.dedupePts(this.draft)) });
      return out;
    }
    /** 兼容别名：仅返回点集数组 */
    getAllDraftsGCJ() {
      return this.getAllDraftsMeta().map(d => d.points);
    }

    _toGCJ(list) {
      const pts = (list || []).map(p => {
        if (p && typeof p === 'object' && p.lat != null && p.lng != null) return [Number(p.lng), Number(p.lat)];
        if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
        return null;
      }).filter(Boolean);
      if (!pts.length) return [];
      const f = pts[0], l = pts[pts.length - 1];
      if (f[0] !== l[0] || f[1] !== l[1]) pts.push([f[0], f[1]]);
      return pts;
    }

    /** 已收集的草稿数量 + 当前草稿 */
    draftCount() { return this.drafts.length + (this.draft.length >= 3 ? 1 : 0); }

    /**
     * 渲染所有已保存活动范围。一个围栏可含多个多边形（范围），各自独立描边 + 半透明填充。
     */
    renderFences(fences) {
      this.layers.clearLayers();
      (fences || []).forEach(f => {
        // 兼容：新格式 f.polygons（多多边形数组）；旧格式 f.points（单多边形）
        const polys = (f.polygons && f.polygons.length)
          ? f.polygons
          : (Array.isArray(f.points) && f.points.length
            ? (Array.isArray(f.points[0]) && !Array.isArray(f.points[0][0]) ? [f.points] : f.points)
            : []);
        (polys || []).forEach(ring => {
          if (!Array.isArray(ring) || ring.length < 3) return;
          const latlngs = ring.map(p => [Number(p[1]), Number(p[0])]); // [lat,lng]
          L.polygon(latlngs, { color: COLOR_SAVED, weight: 2, fillColor: COLOR_SAVED, fillOpacity: 0.12 })
            .addTo(this.layers).bindTooltip(escapeHtml(f.name || ''));
        });
      });
    }

    /** 编辑某个已保存活动范围（一个围栏可含多个多边形范围）：把所有多边形载入草稿（id 用于保存时回写同一个围栏）。
     *  第一个范围直接载入「当前草稿层」以便立即拖拽顶点；其余在待保存草稿层，点击即可编辑。 */
    loadFence(fence) {
      this.activeId = (fence && fence.id != null) ? fence.id : null;
      this.drafts = [];
      this.draft = [];
      const polys = (fence && fence.polygons) || [];
      let first = true;
      polys.forEach(poly => {
        const pts = (Array.isArray(poly) ? poly : []).map(p => {
          if (p && typeof p === 'object' && p.lat != null && p.lng != null) return { lat: Number(p.lat), lng: Number(p.lng) };
          if (Array.isArray(p)) return { lat: Number(p[1]), lng: Number(p[0]) };
          return null;
        }).filter(Boolean);
        if (pts.length >= 3) {
          if (first) { this.draft = pts; first = false; }
          else this.drafts.push({ id: this.activeId, pts });
        }
      });
      this.dirty = false;           // 以服务端数据为基准，尚未改动
      this._renderSavedDrafts();
      this._renderDraft();
      this._emitDraftChange();
    }

    /**
     * 显示「我的位置」标记。
     * @param {Object} latlng {lat,lng}（已是底图坐标系，如 GCJ-02）
     * @param {string} text tooltip 文案
     * @param {boolean} [follow=true] 是否把地图视角移到定位点（连续定位时可关闭以便自由拖动查看）
     * @param {number} [accuracy] 定位精度（米），>0 时绘制半透明精度圈
     */
    showLocation(latlng, text, follow, accuracy) {
      this.locLayer.clearLayers();
      if (!latlng) return;
      if (accuracy && accuracy > 0) {
        L.circle([latlng.lat, latlng.lng], {
          radius: accuracy, color: '#c0392b', weight: 1, opacity: 0.4,
          fillColor: '#c0392b', fillOpacity: 0.08
        }).addTo(this.locLayer);
      }
      L.circleMarker([latlng.lat, latlng.lng], { radius: 7, color: '#c0392b', fillColor: '#c0392b', fillOpacity: 0.9 })
        .addTo(this.locLayer).bindTooltip(text || '当前位置', { permanent: true });
      if (follow !== false) this.map.setView([latlng.lat, latlng.lng], Math.max(this.map.getZoom(), 17));
    }

    /** 显示活动目的地（终点）标记：用醒目的旗帜图标，与定位点区分 */
    showDestination(latlng, text) {
      this.destLayer.clearLayers();
      if (!latlng || latlng.lat == null || latlng.lng == null) return;
      const icon = L.divIcon({
        className: 'dest-marker',
        html: '<div class="dest-pin">📍</div>',
        iconSize: [28, 28], iconAnchor: [14, 28], tooltipAnchor: [0, -16]
      });
      L.marker([latlng.lat, latlng.lng], { icon })
        .addTo(this.destLayer)
        .bindTooltip(text || '目的地（终点）', { permanent: true, direction: 'top' });
    }

    clearDestination() { this.destLayer.clearLayers(); }

    /** 清空「我的位置」标记与精度圈（切换活动 / 无活动时避免残留上一次的定位点） */
    clearLocation() { this.locLayer.clearLayers(); }

    /** 批量打点（管理/开发端查看普通学生定位，仅展示点位，不展示坐标数值） */
    showLocations(list) {
      this.locLayer.clearLayers();
      const pts = (list || []).filter(p => p.lat != null && p.lng != null);
      if (!pts.length) return;
      const colors = { signed: '#0a7d3c', ontheway: '#1666b8', leave: '#b4690e', cancelled: '#c0392b' };
      pts.forEach(p => {
        const c = colors[p.status] || '#475569';
        L.circleMarker([p.lat, p.lng], { radius: 6, color: c, fillColor: c, fillOpacity: 0.85 })
          .addTo(this.locLayer)
          .bindTooltip(`${p.real_name || ''}（${({ signed: '已签到', ontheway: '在途中', leave: '请假', cancelled: '已退签' }[p.status]) || p.status}）`, { permanent: false });
      });
      const latlngs = pts.map(p => [p.lat, p.lng]);
      this.map.fitBounds(latlngs, { padding: [40, 40], maxZoom: 18 });
    }

    invalidate() { setTimeout(() => this.map.invalidateSize(), 50); }
  }

  window.FenceEditor = FenceEditor;
})();
