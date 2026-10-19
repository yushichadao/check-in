/* 融合主题（大学风 + 精美风 + 机械风 + 有意思风，四风合为一体） + 白天 / 夜间切换。
 * 昼夜只切换「配色」：在 <html> 上写 data-mode="dark"|"light"，由 theme.css 覆盖配色变量，
 * 版式与组件结构完全不变。选择记在 localStorage；没选过则跟随系统 prefers-color-scheme。
 * 本脚本在 <head> 中同步执行，先着色再渲染，避免首屏闪白。 */
(function () {
  var KEY = 'checkin_theme_mode';   // 'dark' | 'light'

  function saved() {
    try {
      var v = localStorage.getItem(KEY);
      return (v === 'dark' || v === 'light') ? v : null;
    } catch (e) { return null; }
  }
  function systemDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /** 同步顶栏按钮的图标与文字（脚本在 <head> 执行时按钮尚未存在，故每次都重新查找） */
  function syncButtons(mode) {
    var dark = mode === 'dark';
    Array.prototype.forEach.call(document.querySelectorAll('#themeToggleBtn'), function (btn) {
      var use = btn.querySelector('use');
      if (use) use.setAttribute('href', dark ? '#ico-sun' : '#ico-moon');
      var txt = btn.querySelector('#themeToggleText');
      if (txt) txt.textContent = dark ? '白天' : '夜间';
      var tip = dark ? '切换到白天模式' : '切换到夜间模式';
      btn.setAttribute('title', tip);
      btn.setAttribute('aria-label', tip);
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    });
  }

  function current() {
    return document.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light';
  }

  /**
   * @param {'dark'|'light'} mode
   * @param {boolean} persist 是否写入 localStorage。仅用户主动切换时才写，
   *        否则「跟随系统」会被首次加载的结果固化，之后再也不跟系统变。
   */
  function apply(mode, persist) {
    var m = mode === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', 'fusion');
    document.documentElement.setAttribute('data-mode', m);
    if (persist) { try { localStorage.setItem(KEY, m); } catch (e) { /* 隐私模式忽略 */ } }
    syncButtons(m);
  }

  apply(saved() || (systemDark() ? 'dark' : 'light'), false);

  // 用户没显式选过时，跟随系统深浅色变化
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { if (!saved()) withTransition(function () { apply(mq.matches ? 'dark' : 'light'); }); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // 事件委托：按钮可能由页面脚本后插入，且 SVG 内部点击也能命中
  document.addEventListener('click', function (e) {
    var btn = (e.target && e.target.closest) ? e.target.closest('#themeToggleBtn') : null;
    if (!btn) return;
    e.preventDefault();
    toggle();
  });

  document.addEventListener('DOMContentLoaded', function () {
    syncButtons(current());
    // 旧的四主题切换入口已移除，若页面仍有残留容器则清空
    Array.prototype.forEach.call(document.querySelectorAll('.theme-switch'), function (box) { box.innerHTML = ''; });
  });

  /**
   * 切换时挂一次颜色过渡：CSS 变量本身不可过渡，但使用它们的颜色属性可以，
   * 故临时给根元素加 .theme-switching（见 theme.css 的同名规则），过渡结束即移除，
   * 以免长期占用元素自身的 transition（如按钮 hover 的抬升动效）。
   */
  function motionOk() {
    return !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function withTransition(fn) {
    var root = document.documentElement;
    var on = motionOk();
    if (on) root.classList.add('theme-switching');
    try { fn(); } finally {
      if (on) setTimeout(function () { root.classList.remove('theme-switching'); }, 380);
    }
  }

  /** 用户主动切换：写入 localStorage，此后以用户选择为准，不再跟随系统 */
  function toggle() { withTransition(function () { apply(current() === 'dark' ? 'light' : 'dark', true); }); }

  window.ThemeMode = {
    get: current,
    set: function (m) { withTransition(function () { apply(m, true); }); },
    toggle: toggle,
    withTransition: withTransition
  };
})();

/* 移动端底栏：按按钮数量动态分两行（按钮尺寸自动压缩，避免换行溢出） */
(function () {
  function fitSidebar() {
    var mobile = window.innerWidth <= 880;
    document.querySelectorAll('.sidebar').forEach(function (sb) {
      var items = sb.querySelectorAll('.nav-item');
      if (!mobile) {
        sb.style.gridTemplateColumns = '';
        items.forEach(function (it) { it.style.fontSize = ''; });
        return;
      }
      var n = items.length;
      if (!n) return;
      var cols = Math.ceil(n / 2); // 两行：列数 = 项数的一半向上取整
      sb.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
      var fs = cols > 5 ? 8 : (cols > 4 ? 9 : (cols > 3 ? 10 : 11));
      items.forEach(function (it) { it.style.fontSize = fs + 'px'; });
    });
  }
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  ready(fitSidebar);
  window.addEventListener('resize', fitSidebar);
  if (window.MutationObserver) {
    var obs = new MutationObserver(fitSidebar);
    ready(function () {
      var sb = document.querySelector('.sidebar');
      if (sb) obs.observe(sb, { childList: true, subtree: true });
    });
  }
})();

/* 移动端虚拟键盘：保证「正在输入的控件」（页面上、浮窗里、表格内的输入框都算）不被键盘遮挡。
 * ① 弹出时隐藏固定底栏（否则底栏被顶起、遮挡待填项）；
 * ② 把键盘实测高度写入 --kb-h：CSS 据此给文档预留底部留白（否则页面滚到底后无法继续上滚，
 *    表单底部的「提交 / 保存」按钮会被键盘永久遮住），并把浮窗整体收进可见区；
 * ③ 持续把当前控件保持在「视觉视口的可见区」内：键盘弹出带动画、控件位置与可见区高度都在变，
 *    故在聚焦瞬间、之后若干时点、以及每次 visualViewport 变化时反复校正。
 * 键盘高度以 visualViewport 实测（布局视口不变、仅视觉视口收缩），focusin 仅作旧浏览器兜底。 */
(function () {
  function isMobile() { return window.matchMedia && window.matchMedia('(max-width: 880px)').matches; }
  function isField(t) {
    if (!t) return false;
    if (t.tagName === 'TEXTAREA') return true;
    if (t.tagName !== 'INPUT') return false;
    // 仅「会弹出软键盘」的文本类输入才视为字段：勾选框 / 单选 / 按钮 / 文件等不弹键盘，
    // 若也触发键盘逻辑，会在部分浏览器（不支持 interactive-widget:overlays-content）上误加
    // body.kbd-open，把移动端底部菜单栏（.sidebar）错误隐藏。
    var type = (t.getAttribute('type') || 'text').toLowerCase();
    var text = ['text', 'email', 'password', 'search', 'tel', 'url',
                'number', 'date', 'time', 'datetime-local', 'month', 'week'];
    return text.indexOf(type) >= 0;
  }
  var vv = window.visualViewport || null;
  var focused = false;
  var baselineH = window.innerHeight || 0;   // 无键盘时的满高（载入即记录），作为 Android「压缩布局视口」模式的键盘高度参照
  var baselineW = window.innerWidth || 0;    // 同上的宽度基线：宽度整体变化 = 布局变了（不是键盘）

  /** 当前是否真有「会弹软键盘」的控件在聚焦（比 focused 标记可靠：焦点事件丢失时也能自愈） */
  function fieldFocused() {
    var a = document.activeElement;
    return !!(a && isField(a));
  }

  /**
   * 视觉视口被键盘遮挡的高度（仅在明显收缩时视为键盘）。
   * 注意排除「缩放」：双指 / 双击放大、以及 F12 设备模拟的「适应窗口」缩放同样会让视觉视口变矮，
   * 但它们不是键盘 —— 缩放时视觉视口的**宽度**会同步变化、且 scale != 1；键盘只压高度，宽度与 scale 不变。
   * 不区分的话，放大页面后底栏会被误判为「键盘弹出」而一直隐藏，即「菜单栏异常消失」。
   *
   * 两套键盘行为都要覆盖：
   *  - iOS / interactive-widget:overlays-content：布局视口不变，仅视觉视口收缩 → 直接 innerHeight - vv.height；
   *  - Android 默认「压缩布局视口」模式：布局与视觉视口同步收缩，innerHeight 与 vv.height 几乎相等，
   *    必须拿「无键盘时的满高 baselineH」来减，否则算成 0、导致底栏浮到键盘上方。
   *
   * 与基线比较这一路必须额外满足两个条件，否则会把「视口整体变小」当成键盘：
   *  ① 有文本控件正在聚焦（键盘总是因聚焦而弹出）；
   *  ② 宽度没变（F12 切手机端、窗口缩放、横竖屏切换都会同时改宽高，不是键盘）。
   *    典型故障：桌面窗口高 950 时载入 → baselineH=950，F12 切到 620 高的手机视口，
   *    差值 330 > 120 被当成键盘 → body.kbd-open 常驻 → 底栏被 display:none 永久隐藏、且永不恢复
   *    （基线因为「判定为键盘」而从不重设，形成死循环）。
   */
  function kbHeight() {
    var iw = window.innerHeight || 0;
    var widthStable = Math.abs((window.innerWidth || 0) - baselineW) <= 2;
    if (!vv) {                                        // 无 visualViewport：只能靠与基线比较（Android resize 模式）
      var dh0 = baselineH - iw;
      return (dh0 > 120 && widthStable && fieldFocused()) ? Math.round(dh0) : 0;
    }
    var dw = (window.innerWidth || 0) - (vv.width || 0);
    if (Math.abs(dw) > 2) return 0;                   // 横向也变了（放大或缩小）→ 是缩放，不是键盘
    if (vv.scale && Math.abs(vv.scale - 1) > 0.05) return 0; // scale != 1 → 是缩放，不是键盘
    var h = iw - (vv.height || 0);
    if (h > 120) return Math.round(h);                // iOS / overlays-content：视觉视口单独收缩
    var dh = baselineH - iw;                          // Android resize：布局视口同步收缩，与基线比较
    return (dh > 120 && widthStable && fieldFocused()) ? Math.round(dh) : 0;
  }

  var watchdog = null;
  function apply(open, h) {
    if (document.body) document.body.classList.toggle('kbd-open', !!open);
    if (open && h > 0) document.documentElement.style.setProperty('--kb-h', h + 'px');
    else document.documentElement.style.removeProperty('--kb-h');
    // 同步写入「视觉视口实测高度」--vv-h：浮窗 / 提示条在键盘弹出时的收缩量以它为准。
    // 不能用 100vh - kb-h 估算：Android 默认「压缩布局视口」模式下 100vh 本身已随键盘变小，
    // 再减 kb-h 会把键盘高度扣两次，浮窗被压成一条细缝（只露出当前聚焦的输入框）。
    if (open) {
      var vh = vv ? (vv.height || 0) : Math.max(0, (window.innerHeight || 0) - (h > 0 ? h : 0));
      if (vh > 0) document.documentElement.style.setProperty('--vv-h', Math.round(vh) + 'px');
      else document.documentElement.style.removeProperty('--vv-h');
    } else {
      document.documentElement.style.removeProperty('--vv-h');
    }
    // 看门狗：底栏绝不能长期隐藏。仅当「实测键盘已收起」且「当前没有输入控件在聚焦」时恢复，
    // 因此不会在真正打字时把底栏弹回来；只用于兜住焦点事件丢失等极端情况。
    if (open && !watchdog) {
      watchdog = setInterval(function () {
        // 兜底条件：只要「当前没有文本控件在聚焦」就恢复底栏。
        // 不能用「kbHeight() > 0」直接跳过：基线一旦被污染（如 F12 切换视口后基线偏大），
        // kbHeight() 会恒 > 0，底栏将永远无法恢复 —— 这正是「菜单栏异常消失」的根因。
        if (fieldFocused()) return;                  // 确实还在输入 → 保持隐藏
        focused = false; apply(false, 0);
      }, 1500);
    } else if (!open && watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
  }

  /** 可见区（视觉视口）在布局视口坐标系中的上下边界：被键盘盖住的下半部分不算可见 */
  function visibleBand() {
    var top = vv ? (vv.offsetTop || 0) : 0;
    var h = vv ? (vv.height || 0) : (window.innerHeight || 0);
    return { top: top + 8, bottom: top + h - 16 };
  }

  /** 最近的可滚动祖先（浮窗 / 表格容器），没有则返回 null */
  function scrollBox(t) {
    var p = t && t.parentElement;
    while (p) {
      var s = window.getComputedStyle ? window.getComputedStyle(p) : null;
      if (s && (s.overflowY === 'auto' || s.overflowY === 'scroll')) return p;
      p = p.parentElement;
    }
    return null;
  }

  /** 保证正在输入的控件不被虚拟键盘遮住（浮窗 / 表格内的控件同样适用） */
  function ensureVisible(t) {
    if (!t || !isField(t) || !t.getBoundingClientRect) return;
    var r = t.getBoundingClientRect();
    if (!r.height && !r.top) return;                   // 尚未布局（如处于收起状态的面板）
    var b = visibleBand();
    var delta = 0;
    if (r.bottom > b.bottom) {
      delta = r.bottom - b.bottom + 24;                // 连下方一点余量一起露出来
      var limit = r.top - b.top;                       // 控件本身高于可见区时，不要把它的顶部顶出去
      if (limit < delta) delta = limit > 0 ? limit : 0;
    } else if (r.top < b.top) {
      delta = r.top - b.top;
    }
    if (!delta) return;
    // 处在浮窗 / 可滚动容器内：交给该容器滚动（窗口滚动对 fixed 浮窗无效）
    var inModal = t.closest ? !!t.closest('.modal-mask') : false;
    if (inModal || scrollBox(t)) {
      try { t.scrollIntoView({ block: 'center' }); } catch (e) { try { t.scrollIntoView(); } catch (x) { /* 忽略 */ } }
      return;
    }
    try { window.scrollBy({ top: delta, behavior: 'smooth' }); }
    catch (e) { window.scrollBy(0, delta); }
  }

  /** 键盘弹出 / 收起都带动画：聚焦后按几个时点复检，避免拿动画中途的旧坐标计算 */
  function ensureLater(t) {
    [120, 320, 640, 1000].forEach(function (ms) {
      setTimeout(function () {
        if (document.activeElement !== t) return;
        apply(true, kbHeight());
        ensureVisible(t);
      }, ms);
    });
  }

  /** 重设满高基线：视口尺寸因「非键盘」理由变化时（窗口缩放、F12 设备模拟、横竖屏）必须调用，
   *  否则旧的满高基线会一直大于当前高度，被 kbHeight() 当成键盘高度，底栏被永久隐藏。 */
  function recalibrate(keepHeightWhileTyping) {
    baselineW = window.innerWidth || baselineW;
    // 正在输入时高度可能已被键盘压缩，此时不能拿它当「满高」基线（会让键盘高度算小）
    if (!keepHeightWhileTyping) baselineH = window.innerHeight || baselineH;
  }

  function sync() {
    // 宽度整体变化 → 布局变了（F12 切手机端 / 窗口缩放 / 横竖屏），先重设基线再算键盘高度
    if (Math.abs((window.innerWidth || 0) - baselineW) > 2) recalibrate(fieldFocused());
    if (!isMobile()) { focused = false; recalibrate(false); apply(false, 0); return; }
    var h = kbHeight();
    // 键盘已收起且当前无输入聚焦 → 重新校准满高基线，供 Android resize 模式下次计算键盘高度
    if (h === 0 && !fieldFocused()) recalibrate(false);
    // 有 visualViewport 时以实测为准（键盘收起但未失焦时能正确恢复底栏），无则退回 focusin 判定
    apply(h > 0 || (focused && !vv), h);
    if (focused) ensureVisible(document.activeElement);
  }

  document.addEventListener('focusin', function (e) {
    if (!isField(e.target)) return;
    focused = true;
    if (!isMobile()) return;
    apply(true, kbHeight());
    ensureVisible(e.target);
    ensureLater(e.target);
  });

  document.addEventListener('focusout', function () {
    // 延迟一下：焦点在表单项之间切换时不要误判为收起
    setTimeout(function () {
      var a = document.activeElement;
      if (!a || a === document.body || !isField(a)) { focused = false; apply(false, 0); }
    }, 120);
  });

  /* 跨过 880px 断点（手机 ⇄ 桌面切换，典型场景就是 F12 设备模拟开关）时直接复位：
     视口宽高整体变化，与「键盘弹出」在高度上无法区分，若不复位，底栏会被误判为键盘遮挡而隐藏。 */
  var mqMobile = window.matchMedia ? window.matchMedia('(max-width: 880px)') : null;
  function onBreakpoint() {
    focused = false;
    recalibrate(false);
    apply(false, 0);
  }
  if (mqMobile) {
    if (mqMobile.addEventListener) mqMobile.addEventListener('change', onBreakpoint);
    else if (mqMobile.addListener) mqMobile.addListener(onBreakpoint);
  }

  if (vv) vv.addEventListener('resize', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', function () { setTimeout(sync, 320); });
  sync();
})();

/* 浮窗（.modal-mask）打开时锁定背景滚动，避免滚动穿透到页面；
   并统一浮窗外观：顶部标题栏 + 右上角关闭按钮 */
(function () {
  function anyVisibleMask() {
    return Array.prototype.some.call(document.querySelectorAll('.modal-mask'), function (m) {
      if (m.classList.contains('hidden')) return false;   // 如 highRiskModal 用 .hidden 控制显隐
      if (m.style.display === 'none') return false;        // 如 dbBusy 用 style.display 控制显隐
      return true;                                        // 动态插入的浮窗（position:fixed → offsetParent 为 null，不能据此判断）
    });
  }
  /* 背景滚动锁定：浮窗存在时，把 body 设为 position:fixed 并补偿滚动位移，
     物理上把页面移出滚动流——这是唯一能在 iOS Safari / 微信内置浏览器等
     「body 上 overflow:hidden 拦不住触摸滚动」的环境里 100% 锁死背景滚动的办法。
     浮窗自身是 position:fixed 的独立滚动容器，不受影响（仍可正常上下滑动）。 */
  var locked = false;
  var savedScrollY = 0;
  var lockStyles = { position: '', top: '', left: '', right: '', width: '' };
  function lockScroll() {
    var b = document.body;
    savedScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
    lockStyles.position = b.style.position;
    lockStyles.top = b.style.top;
    lockStyles.left = b.style.left;
    lockStyles.right = b.style.right;
    lockStyles.width = b.style.width;
    b.style.position = 'fixed';
    b.style.top = '-' + savedScrollY + 'px';
    b.style.left = '0';
    b.style.right = '0';
    b.style.width = '100%';
  }
  function unlockScroll() {
    var b = document.body;
    b.style.position = lockStyles.position;
    b.style.top = lockStyles.top;
    b.style.left = lockStyles.left;
    b.style.right = lockStyles.right;
    b.style.width = lockStyles.width;
    window.scrollTo(0, savedScrollY);   // 恢复打开浮窗前的滚动位置，避免背景跳变
  }
  function sync() {
    var on = anyVisibleMask();
    // 用 locked 做幂等：仅在「无→有」「有→无」的跳变时真正加 / 解锁，
    // 避免浮窗内部 DOM 变化（补标题栏等）反复触发 MutationObserver 时重复执行。
    if (on && !locked) { lockScroll(); locked = true; }
    else if (!on && locked) { unlockScroll(); locked = false; }
    document.body.classList.toggle('modal-open', on);
    document.documentElement.classList.toggle('modal-open', on);
    enhanceAll();
  }

  /* ---------------- 浮窗外观统一：标题栏 + 右上角关闭 ----------------
   * 大量浮窗（confirmDialog / promptText / formDialog、各页面预置的 .modal-mask）
   * 只有裸 <h3> 标题与底部按钮，既无标题栏也无关闭按钮。这里在浮窗出现后统一补：
   *   .modal-head（sticky 标题栏，含左侧点缀条）+ 右上角 .modal-close（×），
   *   并把原标题之后的内容整体搬进 .modal-body（沿用与 .modal 相同的 gap 节奏）。
   * 移动的是原有 DOM 节点，事件监听与已保存的引用都不会失效。
   */
  function closeMaskEl(mask) {
    // 优先复用浮窗自己的「关闭 / 取消」入口，保证 Promise 正常 resolve、页面自己的收尾逻辑照常执行
    var btn = mask.querySelector('[data-close]') || mask.querySelector('[data-no]') || mask.querySelector('[data-no2]');
    if (!btn) {
      var list = mask.querySelectorAll('button');
      for (var i = 0; i < list.length; i++) {
        var t = (list[i].textContent || '').replace(/\s+/g, '');
        if (!list[i].disabled && /^(关闭|取消|返回|知道了|我知道了|稍后|返回列表)$/.test(t)) { btn = list[i]; break; }
      }
    }
    if (btn) { btn.click(); return; }
    // 兜底：页面预置浮窗沿用 hidden 机制收起；动态创建的直接移除
    if (mask.id) mask.classList.add('hidden');
    else if (mask.parentNode) mask.remove();
  }

  /** 取浮窗主标题：只认 .modal 的直接子级 h2 / h3（不依赖 :scope，兼容旧内核） */
  function findTitle(modal) {
    var kids = modal.children;
    for (var i = 0; i < kids.length; i++) {
      var tag = kids[i].tagName;
      if (tag === 'H2' || tag === 'H3') return kids[i];
    }
    return null;
  }

  /**
   * 浮窗类型区分：
   *  - cancel（取消型，保持原样）：需要用户做决定的浮窗 —— confirmDialog / promptText /
   *    formDialog / 密码验证 / 高危确认等，带「取消 / 否 / 暂不授权」一类出口。
   *    这类浮窗的用户注意力应落在底部决策按钮上，不改成顶部标题栏 + ×，位置也保持居中。
   *  - close（关闭型，统一改造）：纯查看 / 展示型 —— 地图查看、图片查看、公告、隐私政策、
   *    忘记密码等，只有「关闭」一类出口。统一顶部对齐 + 标题栏 + 右上角关闭按钮。
   * 页面可用 data-modal-kind="close|cancel" 显式指定，覆盖自动判定。
   */
  function modalKind(mask) {
    var k = mask.getAttribute('data-modal-kind');
    if (k === 'close' || k === 'cancel') return k;
    if (mask.querySelector('[data-no], [data-no2], [data-cancel]')) return 'cancel';
    var list = mask.querySelectorAll('button');
    for (var i = 0; i < list.length; i++) {
      var t = (list[i].textContent || '').replace(/\s+/g, '');
      if (/^(取消|否|不授权|暂不|拒绝)/.test(t)) return 'cancel';
    }
    return 'close';
  }

  function enhance(mask) {
    try {
      var modal = mask.querySelector('.modal');
      if (!modal) return;
      // 先定类型：取消型保持原样（不设 data-head-ready，后续状态变化时仍可重新判定）
      var kind = modalKind(mask);
      if (mask.getAttribute('data-modal-kind') !== kind) mask.setAttribute('data-modal-kind', kind);
      if (kind === 'cancel') return;
      if (modal.getAttribute('data-head-ready')) return;
      modal.setAttribute('data-head-ready', '1');
      // 内容滚动后给标题栏加底（.is-scrolled）：此前只有个别浮窗自己绑过，现统一处理
      if (!modal.getAttribute('data-scroll-bound')) {
        modal.setAttribute('data-scroll-bound', '1');
        modal.addEventListener('scroll', function () {
          modal.classList.toggle('is-scrolled', modal.scrollTop > 4);
        }, { passive: true });
      }
      if (modal.querySelector('.modal-head')) return;        // 已有标题栏（如 readModal）
      if (mask.getAttribute('data-no-head') != null) return; // 页面主动声明不需要
      if (mask.id === 'dbBusy') return;                      // 进度遮罩：无标题且不允许手动关闭
      var title = findTitle(modal);
      if (!title) return;                                    // 无标题的浮窗不强行加栏
      var head = document.createElement('div');
      head.className = 'modal-head';
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'modal-close';
      x.setAttribute('aria-label', '关闭');
      x.title = '关闭';
      x.innerHTML = '&times;';
      x.addEventListener('click', function () { closeMaskEl(mask); });
      // 直接搬移原标题元素（而不是复制文字再新建 h3）：保留 id / 属性 / 已绑定的事件，
      // 页面脚本后续改标题（如图片查看器的 #imgViewerTitle）才不会找不到元素。
      // 先收集 title 在原父元素中的后续兄弟（必须在 appendChild(title) 之前，
      // 否则 title 被移入 head 后 nextSibling 变成 x，导致 x 被误搬进 body）
      var sibs = [];
      var n = title.nextSibling;
      while (n) { sibs.push(n); n = n.nextSibling; }
      head.appendChild(title);
      head.appendChild(x);
      var body = document.createElement('div');
      body.className = 'modal-body';
      for (var si = 0; si < sibs.length; si++) body.appendChild(sibs[si]);
      modal.insertBefore(head, modal.firstChild);
      modal.appendChild(body);
    } catch (e) { /* 单个浮窗增强失败不应影响其余浮窗 */ }
  }

  function enhanceAll() {
    Array.prototype.forEach.call(document.querySelectorAll('.modal-mask'), function (m) {
      try { enhance(m); } catch (e) { /* 忽略 */ }
    });
  }
  // 注意：本脚本在 <head> 中同步执行，此时 document.body 仍为 null，
  // 直接 observe(document.body) 会抛 TypeError 并中断整个 IIFE（导致下面的 resize 监听与首次 sync() 都不执行，
  // 「弹窗打开时锁定背景滚动」整体失效）。因此必须在 DOM 就绪后再建立观察器并判空。
  if (window.MutationObserver) {
    var mObs = new MutationObserver(sync);
    var startObserve = function () {
      if (!mObs || !document.body) return;
      mObs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserve);
    else startObserve();
  }
  /* iOS Safari / 微信内置浏览器：html/body 上的 overflow:hidden 拦不住触摸滚动，
     手指在浮窗上（或浮窗滚到顶/底后继续滑）仍会带动下面的页面——即「浮窗上下滑动穿透」。
     这里做触摸层兜底：浮窗内真正可滚动的区域交给它自己滚（CSS 的 overscroll-behavior:contain
     已阻断滚动链），其余一律阻止默认滚动。

     关键：不能写死「.modal / .modal-body …」这类名字。窄屏（@media max-width:600px）下
     app.css 把滚动容器从 .modal（max-height:88vh; overflow:auto）切到了 .modal-mask
     （overflow-y:auto），.modal 本身被去高度限制、不再可滚。若还按名字匹配，手机上 .modal
     永远被误判「不可滚」→ 一律 preventDefault → 浮窗内滑不动、背景反而锁不住。
     故改为：从触摸点向上找【最近一个真正可滚的祖先】（overflow 为 auto/scroll 且内容溢出），
     命中即放行让它自己滚；否则锁背景。PC（滚 .modal）与手机（滚 .modal-mask）都正确，
     且 .modal-body 这类不裁剪容器不再误判。 */
  function scrollableAncestor(t) {
    var p = t;
    while (p && p.nodeType === 1 && p !== document.body && p !== document.documentElement) {
      var s = window.getComputedStyle(p);
      var oy = s.overflowY, ox = s.overflowX;
      var scrollable = (oy === 'auto' || oy === 'scroll' || ox === 'auto' || ox === 'scroll');
      if (scrollable && (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) return p;
      p = p.parentElement;
    }
    return null;
  }
  function blockScrollUnlessSelfScrolls(e) {
    if (!locked) return;
    var t = e.target;
    if (!t || !t.closest) return;
    // 地图 / 下拉 / 图片 / canvas：手势由控件自身处理，勿拦截
    if (t.closest('.leaflet-container, select, img, canvas')) return;
    // 落在可滚动祖先内 → 交给它自己滚（浮窗 / 遮罩 / 表格 / 文本域 / 私信框 …）
    if (scrollableAncestor(t)) return;
    e.preventDefault();   // 其余：锁住背景，杜绝滚动穿透
  }
  document.addEventListener('touchmove', blockScrollUnlessSelfScrolls, { passive: false });

  /* 桌面端兜底：极少数「滚动容器是 body 之外的包裹层」时，overflow:hidden 与 body 固定都拦不住
     鼠标滚轮；这里与触摸同逻辑——浮窗内可滚区域放行，其余阻止默认滚动（背景不动）。 */
  document.addEventListener('wheel', blockScrollUnlessSelfScrolls, { passive: false });

  window.addEventListener('resize', sync);
  /* 多时机补强：不少浮窗是页面脚本在 DOMContentLoaded 之后才注入 / 重建的
     （如动态创建的图片查看器、各端后渲染的预置浮窗），仅靠首次 sync 会漏掉。 */
  window.addEventListener('load', function () { sync(); setTimeout(enhanceAll, 300); });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { sync(); setTimeout(enhanceAll, 0); });
  } else sync();
})();

/* 禁止鼠标滚轮修改数字输入框的值 */
document.addEventListener('wheel', function(e) {
  if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'number') {
    e.preventDefault();
  }
}, { passive: false });
