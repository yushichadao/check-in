// clean-mode.js — 用户端「清爽模式」全局控制器
// 依赖全局：api, toast, toastErr
// 设计：仅作用于用户端——给 <body> 加/去 .clean-mode 类（CSS 据此隐藏次要内容），
//       并把偏好持久化到 users.clean_mode。与 PermGate / AccountInfo 同级全局对象。
// 原则：本地先切类（瞬时生效、不阻断核心流程），再异步落库；接口异常时本地仍生效并 toast 提示。
(function () {
  let on = true; // 默认开启，与后端 DEFAULT 1 一致

  /** 把当前状态应用到 <body> 类 */
  function apply() {
    document.body.classList.toggle('clean-mode', !!on);
  }

  /**
   * 用 /me 返回的偏好初始化（缺省按开启处理）。
   * @param {{clean_mode?: number|boolean}} opts
   */
  function init(opts) {
    const v = opts && opts.clean_mode;
    on = !(v === 0 || v === false || v === '0');
    apply();
  }

  function isOn() { return !!on; }

  /**
   * 设置清爽模式状态。
   * @param {boolean} val 目标状态
   * @param {{silent?: boolean}} [opts] silent=true 时不落库、不弹提示（仅本地切类）
   * @returns {Promise<void>}
   */
  function set(val, opts) {
    const next = !!val;
    on = next;
    apply(); // 先本地切类，UI 立即生效
    if (opts && opts.silent) return Promise.resolve();
    const payload = { clean_mode: on ? 1 : 0 };
    return api.post('api/auth/me/clean-mode', payload)
      .then(() => { if (typeof toast === 'function') toast(on ? '已开启清爽模式' : '已关闭清爽模式'); })
      .catch(err => {
        if (typeof toastErr === 'function') toastErr((err && err.message) || '清爽模式保存失败');
      });
  }

  /** 切换开/关，resolve 为切换后的新状态 */
  function toggle(opts) {
    return set(!on, opts).then(() => on);
  }

  window.CleanMode = { init, set, toggle, isOn };
})();
