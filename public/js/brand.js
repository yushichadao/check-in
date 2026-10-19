/* 品牌注入：文档标题用「系统全称」（班级名+商品名，如 通信工程2607班签到系统）；
 * [data-brand] 填商品名（品牌，固定）、[data-subtitle] 填班级名（空则隐藏）。
 * 后端 /api/settings/public 提供 product_name、system_name 与 about.group_name（班级名）。
 * 仅在 DOM 就绪后注入，不改任何视觉样式。
 * 接口路径按当前页面 pathname 自适应 BASE_PATH（如 /check-in），不写死根路径。 */
(function () {
  'use strict';

  // 部署子路径自适应：/check-in/login.html -> 基础路径 /check-in/
  function apiUrl(path) {
    var p = location.pathname;
    var base = p.slice(0, p.lastIndexOf('/') + 1);
    if (/^https?:\/\//.test(path) || path.charAt(0) === '/') return path;
    return base + path;
  }

  function apply(productName, groupName, systemName) {
    var pn = productName || '班级签到系统';
    // 标签页标题 = 系统全称（班级名 + 商品名）；未配置班级名时回退商品名
    document.title = systemName || (groupName ? groupName + pn : pn);
    var brands = document.querySelectorAll('[data-brand]');
    for (var i = 0; i < brands.length; i++) brands[i].textContent = pn;
    var subs = document.querySelectorAll('[data-subtitle]');
    for (var j = 0; j < subs.length; j++) {
      var el = subs[j];
      if (groupName) { el.textContent = groupName; el.classList.remove('hidden'); }
      else { el.classList.add('hidden'); }
    }
  }
  function load() {
    if (!window.fetch) return;
    fetch(apiUrl('api/settings/public'), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          var groupName = d.group_name || (d.about && d.about.group_name);
          var sysName = d.system_name || (d.about && d.about.system_name);
          apply(d.product_name, groupName, sysName);
        }
      })
      .catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
