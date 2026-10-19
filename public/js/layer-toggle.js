/* 底图切换（电子地图 / 卫星地图）统一组件：三端一致的「分段切换」控件。
 * 以两个并排选项（电子 / 卫星）呈现，当前选项高亮，切换性质一目了然；
 * 点击在两者间切换，并由 set 回调驱动底层图层。无外部长文案依赖。
 *
 * 用法：
 *   const t = bindLayerToggle(boxEl, {
 *     get: () => bool,        // 当前是否为卫星底图（状态以回调为准）
 *     set: (sat) => void      // 切换底层图层（如 editor.setLayer）
 *   });
 *   t.set(true) / t.sync() 可外部调用以同步状态。
 */
(function () {
  // 电子地图：折叠地图图标
  const ICON_MAP = '<svg class="ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14"/><path d="M15 6v14"/></svg>';
  // 卫星地图：网状地球（带经纬线），直观对应卫星/地球影像底图
  const ICON_SAT = '<svg class="ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="4.5" y1="7" x2="19.5" y2="7"/><line x1="4.5" y1="17" x2="19.5" y2="17"/><ellipse cx="12" cy="12" rx="4.5" ry="9"/><line x1="12" y1="3" x2="12" y2="21"/></svg>';

  function bindLayerToggle(box, opts) {
    opts = opts || {};
    const get = (typeof opts.get === 'function') ? opts.get : (() => false);
    const set = (typeof opts.set === 'function') ? opts.set : (() => {});

    function sync() {
      if (!box) return;
      const sat = !!get();
      box.innerHTML = `
        <button type="button" data-layer="street" class="${sat ? '' : 'active'}" aria-pressed="${sat ? 'false' : 'true'}" title="电子地图（点击切换为卫星地图）">${ICON_MAP}<span>电子</span></button>
        <button type="button" data-layer="satellite" class="${sat ? 'active' : ''}" aria-pressed="${sat ? 'true' : 'false'}" title="卫星地图（点击切换为电子地图）">${ICON_SAT}<span>卫星</span></button>`;
      box.setAttribute('title', sat ? '当前：卫星地图 · 点击切换为电子地图' : '当前：电子地图 · 点击切换为卫星地图');
    }

    function choose(sat) { set(!!sat); sync(); }

    box.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-layer]');
      if (!b) return;
      choose(b.getAttribute('data-layer') === 'satellite');
    });
    sync();

    return { sync, set: (v) => choose(!!v), isSat: () => !!get() };
  }

  window.bindLayerToggle = bindLayerToggle;
})();
