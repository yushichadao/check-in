/* 隐私政策页
 * —— 必须「读完」（滚动到内容底部）才算已读：
 *      · 到达底部后才写入本机已读指纹（含内容版本），注册页据此解锁勾选框；
 *      · 「我已阅读完」按钮在到达底部前保持禁用。
 * —— 指纹取内容哈希：政策内容变化时需重新阅读。
 */
(function () {
  const READ_KEY = 'checkin_privacy_read';
  let hash = '';

  function setHint(text, hide) {
    const hint = el('scrollHint');
    if (!hint) return;
    hint.textContent = text || '';
    hint.classList.toggle('hidden', !!hide);
  }

  /** 到达底部（或内容不足以产生滚动）即视为读完 */
  function atBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight <= 8;
  }

  function unlock() {
    const btn = el('doneBtn');
    if (btn) btn.disabled = false;
    setHint('已阅读至底部，可点击「我已阅读完」返回注册页。', false);
    try { localStorage.setItem(READ_KEY, hash); } catch (e) { /* 忽略 */ }
  }

  function back() {
    if (window.opener) { window.close(); return; }
    goto('register.html');
  }

  async function load() {
    const box = el('policyBox');
    let text = '';
    try {
      const d = await api.get('api/auth/privacy');
      text = d.text || '（暂无隐私政策内容）';
      box.textContent = text;
      if (d.updated_at && el('updatedTag')) {
        el('updatedTag').style.display = '';
        el('updatedTag').textContent = '更新于 ' + fmtDateTime(Number(d.updated_at));
      }
    } catch (e) {
      box.textContent = '隐私政策加载失败：' + e.message + '\n\n请返回重试，或联系管理员。';
      setHint('加载失败，请刷新重试。', false);
      return;
    }

    hash = privacyHash(text);

    // 已按同一版本读完：直接解锁
    let read = null;
    try { read = localStorage.getItem(READ_KEY); } catch (e) { /* 忽略 */ }
    if (read === hash) { unlock(); return; }

    // 内容短到无需滚动：视为已读完
    if (box.scrollHeight <= box.clientHeight + 8) { unlock(); return; }

    box.addEventListener('scroll', () => { if (atBottom(box)) unlock(); });
    // 兜底：窗口尺寸变化后可能无需滚动
    window.addEventListener('resize', () => { if (atBottom(box)) unlock(); });
  }

  el('doneBtn').addEventListener('click', back);
  load();
})();
