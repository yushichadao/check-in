// 禁止登录后的页面被「密码箱」（浏览器内置密码管理器 / 1Password / LastPass / Bitwarden 等插件）
// 自动填表。仅应在登录后的页面引入（manager.html / user.html / ops.html / fence.html / dataflow.html）。
// 原理：
//   1) 所有表单与输入框关闭浏览器原生 autocomplete；
//   2) 给字段加各大密码管理器插件识别的忽略属性，使其不自动填表、也不提示保存；
//   3) 密码框 / 邮箱框在加载时设为 readonly，用户交互（点击 / 聚焦）后才解锁，
//      从而既阻止自动填充，也阻止浏览器弹出「是否保存密码」提示。
(function () {
  'use strict';

  // 常见密码管理器插件的「忽略自动填充」属性
  var IGNORE_ATTRS = {
    'data-1p-ignore': '',           // 1Password
    'data-lpignore': 'true',        // LastPass
    'data-bwignore': '',            // Bitwarden
    'data-dashlane-ignore': 'true', // Dashlane
    'data-form-type': 'other'       // 通用提示：非登录表单
  };

  function unlock(e) {
    var el = e.currentTarget;
    if (el.hasAttribute('readonly')) el.removeAttribute('readonly');
    el.removeEventListener('focus', unlock, true);
    el.removeEventListener('pointerdown', unlock, true);
    el.removeEventListener('click', unlock, true);
  }

  function protectField(el) {
    if (!el || el.__afProtected) return;
    var tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;
    if (el.type === 'hidden' || el.disabled) { el.__afProtected = true; return; }

    el.setAttribute('autocomplete', 'off');

    for (var k in IGNORE_ATTRS) {
      if (IGNORE_ATTRS[k] === '') el.setAttribute(k, '');
      else el.setAttribute(k, IGNORE_ATTRS[k]);
    }

    // 密码框 / 邮箱框：加载时只读，交互后解锁，杜绝自动填充与保存提示
    if (el.type === 'password' || el.type === 'email') {
      el.setAttribute('readonly', '');
      el.addEventListener('focus', unlock, true);
      el.addEventListener('pointerdown', unlock, true);
      el.addEventListener('click', unlock, true);
    }

    el.__afProtected = true;
  }

  function protectAll(root) {
    root = root || document;
    var forms = root.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) forms[i].setAttribute('autocomplete', 'off');
    var fields = root.querySelectorAll('input, textarea, select');
    for (var j = 0; j < fields.length; j++) protectField(fields[j]);
  }

  function init() {
    protectAll(document);
    // 兜底：处理运行时动态插入的弹窗 / 表单（如修改密码、忘记密码、高危确认）
    if (typeof MutationObserver !== 'undefined' && document.body) {
      var mo = new MutationObserver(function (muts) {
        for (var m = 0; m < muts.length; m++) {
          var added = muts[m].addedNodes;
          for (var n = 0; n < added.length; n++) {
            if (added[n].nodeType === 1) protectAll(added[n]);
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
