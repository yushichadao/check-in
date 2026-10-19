/* 关于系统 + 反馈网站问题（用户端 / 管理端 / 运维端三端共用）
 * 依赖 api.js 提供的全局：api / toast / toastErr / escapeHtml / fmtDateTime
 */
(function () {
  'use strict';

  /** 软件许可协议（三端一致；版权声明已移到页脚，此处不再重复）
   *  —— 本软件基于 MIT 协议开源发布，任何人可自由使用、修改与再分发（含商业用途）。 */
  const RIGHTS_TEXT = [
    '《班级签到系统 · 软件许可协议》',
    '',
    '重要提示：本软件基于 MIT 协议开源发布。在安装、部署、修改或使用本软件前，请仔细阅读本协议。下载、安装、部署、修改或使用本软件，即表示你已阅读、理解并同意接受本协议全部条款。完整的许可文本以仓库根目录 LICENSE 文件（MIT）为准。',
    '',
    '一、开源与许可授予',
    '1. 本软件以 MIT 协议授权。软件著作权人（以下简称「授权人」）特此免费授予任何获得本软件副本的人不受限制的权利，包括但不限于使用、复制、修改、合并、出版、分发、再许可和／或出售本软件副本的权利，并允许本软件的所有接收者这样做，但须满足下列条件。',
    '2. 在遵守本协议的前提下，你可将本软件部署并运行于你自有或指定的服务器环境中，用于任何用途（含商业用途）；可制作运行所必需的备份副本，并可根据自身需求修改源代码、进行二次开发。',
    '3. 上述权利自你获得本软件之日起生效，无需支付任何许可费用，授权人亦不因此收取任何版税或授权费用。',
    '',
    '二、版权声明',
    '1. 本软件的著作权（含源代码、文档、界面设计、数据模型及全部衍生作品）归软件著作权人所有；MIT 协议仅授予前述使用权，不构成任何知识产权的转让。',
    '2. 你在对本软件进行修改或再分发时，须保留原始的版权声明与许可声明（见下文「许可声明」）。',
    '',
    '三、许可声明（须随附于所有副本）',
    'Copyright (c) 2026 余子晨（Yushichadao）',
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
    'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
    '',
    '四、免责与责任限制',
    '1. 本软件按「现状」提供，不提供任何明示或默示担保，包括但不限于对适销性、特定用途适用性与非侵权的担保。',
    '2. 在任何情况下，软件著作权人不对因使用或无法使用本软件而导致的任何直接、间接、偶然或后果性损失承担责任；但因本软件缺陷造成你人身损害或重大财产损失的除外。',
    '3. 本软件生成的签到、请假、补签与考勤统计结果仅供使用方内部参考，其认定以使用方所在单位或组织的相关规定为准。',
    '',
    '五、其他',
    '1. 本协议受中华人民共和国法律管辖，并按其解释。',
    '2. 若你未遵守本协议的许可条件（如未保留版权与许可声明），本许可自动终止，你应立即停止使用并销毁相关副本。',
    '3. 本协议任何条款被认定为无效，不影响其余条款的效力。',
    '',
    '软件著作权人：余子晨（Yushichadao）',
    '2026 年 10 月 13 日'
  ].join('\n');

  let aboutCache = null;
  let fbSelectedFiles = [];  // 反馈待上传图片（支持预览中移除）
  let maintEnabled = false;  // 维护模式：邮件发送暂停，反馈弹窗勾选框禁用

  /* ------------------------- 图片压缩 / 上传（反馈附带图片） ------------------------- */
  function compressImage(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('图片格式不支持'));
        img.onload = () => {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  async function uploadFeedbackImages(files) {
    const ids = [];
    for (const f of Array.prototype.slice.call(files).slice(0, 9)) {
      const dataUrl = await compressImage(f, 1280, 0.8);
      const r = await api.post('api/feedback/upload', { data: dataUrl, mime: 'image/jpeg', name: f.name });
      if (r && r.id) ids.push(r.id);
    }
    return ids;
  }

  /* ------------------------- 图片查看器（三端共用：缩略图点击放大 + 缩放 / 平移） ------------------------- */
  function injectImageViewer() {
    if (document.getElementById('imgViewerModal')) return;
    const mask = document.createElement('div');
    mask.className = 'modal-mask hidden';
    mask.id = 'imgViewerModal';
    mask.setAttribute('data-noscroll', '');   // 灯箱整窗禁止滚动，拖拽平移才顺手；高度交由 flex 收缩
    mask.innerHTML = `
      <div class="modal wide">
        <!-- 标题必须是 .modal 的直接子元素：统一浮窗外观（顶部标题栏 + 右上角关闭）据此识别主标题 -->
        <h3 id="imgViewerTitle">查看图片</h3>
        <div class="row" style="justify-content:flex-end;align-items:center;gap:6px">
          <button class="btn sm" id="imgZoomOut" type="button" title="缩小">－</button>
          <span id="imgZoomVal" style="min-width:48px;text-align:center;font-variant-numeric:tabular-nums">100%</span>
          <button class="btn sm" id="imgZoomIn" type="button" title="放大">＋</button>
          <button class="btn sm" id="imgZoomReset" type="button" title="复位">复位</button>
        </div>
        <div id="imgViewerStage" class="modal-flex" style="overflow:hidden;position:relative;background:#0f172a;border-radius:10px;cursor:grab;touch-action:none">
          <img id="imgViewerImg" alt="预览大图" style="display:block;margin:0 auto;max-width:100%;max-height:100%;will-change:transform;pointer-events:none">
        </div>
        <div class="row between" style="align-items:center;gap:10px">
          <span class="muted" style="font-size:12px" data-clean-hide>滚轮缩放，拖拽平移；点击空白处关闭</span>
          
        </div>
      </div>`;
    document.body.appendChild(mask);

    const img = mask.querySelector('#imgViewerImg');
    const stage = mask.querySelector('#imgViewerStage');
    const val = mask.querySelector('#imgZoomVal');
    let scale = 1, tx = 0, ty = 0;
    let dragging = false, dragId = null, sx = 0, sy = 0, stx = 0, sty = 0;
    // 缩放锚点 + 平移边界（这里有两个坑，都会表现成「图片拖不动」）：
    //  1) 图片布局盒常被舞台裁掉一截（舞台高度受 max-height 限制，尤其是手机长截图），
    //     若沿用 transform-origin: center center，缩放锚点落在布局盒中心、往往在视野之外，
    //     缩到 100% 以下时整张图会直接飞出可视区 —— 看起来就是图片消失 / 怎么拖都看不到。
    //     所以锚点取「舞台中心在图片坐标系中的位置」，缩放始终围绕看见的那块内容进行。
    //  2) 边界不能写成对称的 ±(sw+iw)/2：那既允许把图整张拖出视野，又忽略了上面的基准偏移。
    //     正确做法是限制「图片视觉盒不脱离舞台」：图比舞台小就在舞台内移动，比舞台大则边缘贴边。
    function geo() {
      const sw = stage.clientWidth, sh = stage.clientHeight;
      const iwL = img.clientWidth || 0, ihL = img.clientHeight || 0;
      const ox = Math.max(0, (sw - iwL) / 2);   // 图片在舞台内的水平偏移（margin:0 auto 居中、垂直贴顶）
      return {
        sw, sh, iwL, ihL,
        originX: sw / 2 - ox,                    // 舞台中心在图片坐标系中的位置
        originY: sh / 2,
        basisY: scale * (ihL / 2 - sh / 2),      // 舞台中心与图片视觉盒中心的固有偏移（随比例变化）
        limitX: Math.abs(sw - iwL * scale) / 2,
        limitY: Math.abs(sh - ihL * scale) / 2,
      };
    }
    function apply() {
      const g = geo();
      img.style.transformOrigin = `${g.originX}px ${g.originY}px`;
      tx = Math.max(-g.limitX, Math.min(g.limitX, tx));
      ty = Math.max(-g.limitY - g.basisY, Math.min(g.limitY - g.basisY, ty));
      img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
      val.textContent = Math.round(scale * 100) + '%';
    }
    function setScale(s) {
      const next = Math.min(6, Math.max(0.2, s));
      if (next === scale) { apply(); return; }
      // 以舞台中心为锚点缩放：补偿固有偏移，视野中心显示的图片内容在缩放前后保持不动
      const half = (img.clientHeight || 0) / 2 - stage.clientHeight / 2;
      ty += (scale - next) * half;
      scale = next;
      apply();
    }
    function openImageViewer(src, title) {
      if (!src) return;
      img.src = src;
      const t = document.getElementById('imgViewerTitle'); if (t) t.textContent = title || '查看图片';
      tx = 0; ty = 0; scale = 1;
      mask.classList.remove('hidden');
      apply();
      // 图片尺寸与舞台尺寸要等这一帧布局完成才准确，下一帧再校准一次锚点与边界
      requestAnimationFrame(apply);
    }
    window.openImageViewer = openImageViewer;
    mask.querySelector('#imgZoomIn').addEventListener('click', () => setScale(scale + 0.25));
    mask.querySelector('#imgZoomOut').addEventListener('click', () => setScale(scale - 0.25));
    mask.querySelector('#imgZoomReset').addEventListener('click', () => setScale(1));
    mask.addEventListener('click', e => { if (e.target === mask) { mask.classList.add('hidden'); setScale(1); } });
    stage.addEventListener('wheel', e => { e.preventDefault(); setScale(scale + (e.deltaY < 0 ? 0.25 : -0.25)); }, { passive: false });
    function startDrag(x, y) {
      dragging = true;
      sx = x; sy = y; stx = tx; sty = ty;
      stage.style.cursor = 'grabbing';
    }
    function moveDragTo(x, y) {
      if (!dragging) return;
      tx = stx + (x - sx);
      ty = sty + (y - sy);
      apply();
    }
    function endDrag() {
      if (!dragging) return;
      dragging = false; dragId = null;
      stage.style.cursor = 'grab';
    }
    // 优先用指针事件：鼠标 / 触摸 / 触控笔一套逻辑；触摸时浏览器会把指针隐式捕获到舞台，
    // 拖动全程不丢事件（旧实现把 mousemove 挂在 window 上，触摸 / 触控笔场景容易整段拖不动）。
    if (window.PointerEvent) {
      stage.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        dragId = e.pointerId;
        startDrag(e.clientX, e.clientY);
        try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      });
      // 监听挂在 window 上兜底：指针滑出舞台、或 setPointerCapture 不被支持时仍能继续平移
      window.addEventListener('pointermove', e => {
        if (!dragging || (dragId !== null && e.pointerId !== dragId)) return;
        moveDragTo(e.clientX, e.clientY);
        if (e.cancelable) e.preventDefault();
      });
      const endPtr = e => { if (dragId !== null && e.pointerId !== dragId) return; endDrag(); };
      window.addEventListener('pointerup', endPtr);
      window.addEventListener('pointercancel', endPtr);
    } else {
      // 极少数不支持指针事件的浏览器：回退为鼠标 / 触摸两套监听
      stage.addEventListener('mousedown', e => startDrag(e.clientX, e.clientY));
      window.addEventListener('mousemove', e => moveDragTo(e.clientX, e.clientY));
      window.addEventListener('mouseup', () => endDrag());
      stage.addEventListener('touchstart', e => { const t0 = e.touches[0]; if (t0) startDrag(t0.clientX, t0.clientY); }, { passive: true });
      stage.addEventListener('touchmove', e => { const t0 = e.touches[0]; if (t0) moveDragTo(t0.clientX, t0.clientY); }, { passive: true });
      stage.addEventListener('touchend', () => endDrag());
    }
    window.addEventListener('blur', () => endDrag());
    // 图片加载完成后重新校准：首次打开时 img.clientWidth 可能还是 0，锚点与边界会算错导致拖不动
    img.addEventListener('load', () => apply());
    // 窗口尺寸变化会改变舞台尺寸，锚点与边界随之重算（灯箱未打开时舞台尺寸为 0，跳过）
    window.addEventListener('resize', () => { if (!mask.classList.contains('hidden')) apply(); });
    // 文档级委托：所有带 data-full 的缩略图点击放大（含活动配图、申诉图片、反馈图片）
    document.addEventListener('click', e => {
      const t = e.target && e.target.closest ? e.target.closest('img[data-full]') : null;
      if (t) openImageViewer(t.getAttribute('data-full'), t.getAttribute('alt') || '查看图片');
    });
  }

  /* ------------------------- 注入反馈弹窗（动态创建，三端无需各自写 modal） ------------------------- */
  function injectFeedbackModal() {
    if (document.getElementById('feedbackModal')) return;
    // 反馈是「下级 → 运维者」的受理通道：运维端没有提交入口（服务端也会拒绝提交），
    // 无入口时不注入这个必然失败的提交表单，避免 F12 手动调出后提交报 403。
    if (!document.getElementById('openFeedbackBtn')) return;
    const mask = document.createElement('div');
    mask.className = 'modal-mask hidden';
    mask.id = 'feedbackModal';
    mask.innerHTML = `
      <div class="modal">
        <h3>向运维者反馈问题</h3>
        <div class="muted" style="font-size:13px;line-height:1.7" data-clean-hide>
          提交后将以<b>工单</b>形式进入系统、由<b>本系统的运维者（部署管理员）</b>受理，不会送抵软件开发方；若已配置邮件，亦可同时<b>发送邮件</b>给运维者。
        </div>
        <div class="field">
          <label>类型</label>
          <select id="fbType">
            <option value="bug">功能异常 / Bug</option>
            <option value="suggest">功能建议</option>
            <option value="other">其他</option>
          </select>
        </div>
        <div class="field"><label>标题</label>
          <input id="fbTitle" maxlength="80" placeholder="一句话概括你的问题或建议" autocomplete="off"></div>
        <div class="field"><label>详细描述</label>
          <textarea id="fbContent" rows="4" maxlength="1000" placeholder="请尽量描述复现步骤 / 期望效果 / 当前现象"></textarea></div>

        <div class="field"><label data-clean-hide>图片（选填，最多 9 张，便于运维者定位问题）</label>
          <input type="file" id="fbFiles" accept="image/*" multiple style="display:none">
          <button class="btn img-pick" id="fbFilesBtn" type="button">选择图片</button>
          <span class="muted" id="fbFilesHint" style="font-size:12px;margin-left:6px"></span>
          <div id="fbPreviews" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"></div>
        </div>
        <div class="field">
          <label class="chk"><input type="checkbox" id="fbByTicket" checked> 提交为工单（系统内记录，运维者可见并处理）</label>
          <label class="chk"><input type="checkbox" id="fbByEmail" checked> 同时发送邮件给运维者</label>
          <span class="muted" id="fbEmailNote" style="font-size:12px;display:block;margin-top:4px"></span>
        </div>
        <div class="row end">
          <button class="btn primary" id="fbSubmit" type="button">提交反馈</button>
          <button class="btn" id="fbCancel" type="button">取消</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    mask.querySelector('#fbCancel').addEventListener('click', () => mask.classList.add('hidden'));
    mask.addEventListener('click', (e) => { if (e.target === mask) mask.classList.add('hidden'); });
    mask.querySelector('#fbSubmit').addEventListener('click', submitFeedback);

    // 反馈图片：选择后本地预览（点击预览图可放大，点 × 可移除），提交时再实际上传
    const fbFiles = mask.querySelector('#fbFiles');
    const fbFilesBtn = mask.querySelector('#fbFilesBtn');
    const fbPreviews = mask.querySelector('#fbPreviews');
    const fbHint = mask.querySelector('#fbFilesHint');
    function renderFbPreviews() {
      fbPreviews.innerHTML = '';
      fbSelectedFiles.forEach((f, i) => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;width:64px;height:64px;flex:0 0 auto';
        const u = URL.createObjectURL(f);
        const im = document.createElement('img');
        im.src = u; im.title = '点击放大'; im.setAttribute('data-full', u);
        im.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:8px;cursor:zoom-in;display:block';
        const del = document.createElement('button');
        del.type = 'button'; del.textContent = '×'; del.title = '移除这张图片';
        del.style.cssText = 'position:absolute;top:-7px;right:-7px;width:20px;height:20px;line-height:18px;border-radius:50%;border:none;background:rgba(192,57,43,.95);color:#fff;cursor:pointer;font-size:14px;padding:0;z-index:2';
        del.addEventListener('click', (e) => { e.stopPropagation(); URL.revokeObjectURL(u); fbSelectedFiles.splice(i, 1); renderFbPreviews(); });
        wrap.appendChild(im); wrap.appendChild(del);
        fbPreviews.appendChild(wrap);
      });
      if (fbHint) fbHint.textContent = fbSelectedFiles.length ? `已选择 ${fbSelectedFiles.length} 张（最多 9 张）` : '';
    }
    if (fbFilesBtn && fbFiles) fbFilesBtn.addEventListener('click', () => fbFiles.click());
    if (fbFiles) fbFiles.addEventListener('change', () => {
      const all = Array.prototype.slice.call(fbFiles.files || []);
      for (const f of all) { if (fbSelectedFiles.length >= 9) { toast('最多 9 张，超出部分已忽略'); break; } fbSelectedFiles.push(f); }
      fbFiles.value = '';
      renderFbPreviews();
    });
  }

  /* ------------------------- 长文折叠：权利声明 / 隐私政策默认不直接显示全文 ------------------------- */
  function collapseToggle(btn, box) {
    if (!btn || !box) return;
    btn.addEventListener('click', () => {
      const collapsed = box.classList.toggle('collapsed');
      btn.textContent = collapsed ? '展开全文' : '收起';
    });
  }

  function setupTextCollapsibles() {
    // 保留权利声明：把已有容器包进折叠盒（仅处理一次）
    const rightsEl = document.getElementById('aboutRights');
    if (rightsEl && !rightsEl.dataset.collapsible) {
      rightsEl.dataset.collapsible = '1';
      const box = document.createElement('div');
      box.className = 'collapse-box collapsed';
      rightsEl.parentNode.insertBefore(box, rightsEl);
      box.appendChild(rightsEl);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn sm ghost';
      btn.textContent = '展开全文';
      btn.style.marginTop = '10px';
      box.after(btn);
      collapseToggle(btn, box);
    }

    // 隐私政策：三端一致动态注入折叠卡片（全文即时加载，折叠时与权利声明一样显示开头预览）
    const rightsCard = rightsEl && rightsEl.closest('.card');
    if (rightsCard && !document.getElementById('aboutPrivacyCard')) {
      const card = document.createElement('div');
      card.className = 'card';
      card.id = 'aboutPrivacyCard';
      card.innerHTML = `
        <header><h2>隐私政策</h2></header>
        <div class="muted" style="font-size:13px;line-height:1.8;margin-bottom:10px" data-clean-hide>
          了解本系统收集哪些信息、如何使用与保护你的信息。全文较长，默认不直接展示；
          注册时须在阅读页完整阅读后才能勾选同意。
        </div>
        <div class="collapse-box collapsed">
          <div class="muted" id="aboutPrivacy" style="white-space:pre-wrap;line-height:1.95"></div>
        </div>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn sm ghost';
      btn.textContent = '展开全文';
      btn.style.marginTop = '10px';
      card.appendChild(btn);
      rightsCard.after(card);

      const pbox = card.querySelector('.collapse-box');
      const ptext = card.querySelector('#aboutPrivacy');
      let loading = false;
      async function loadPrivacy() {
        if (loading) return;
        loading = true;
        try {
          const d = await api.get('api/auth/privacy');
          ptext.textContent = d.text || '（暂无隐私政策内容）';
        } catch (e) {
          ptext.textContent = '隐私政策加载失败：' + (e.message || '未知错误');
        } finally {
          loading = false;
        }
      }
      btn.addEventListener('click', () => {
        const collapsed = pbox.classList.toggle('collapsed');
        btn.textContent = collapsed ? '展开全文' : '收起';
      });
      // 与权利声明保持一致：折叠状态下也要显示开头几行的「预览」（渐隐收尾），
      // 因此全文在创建卡片时就加载，而不是等到首次展开才加载（那样折叠区是空的）。
      loadPrivacy();
    }
  }

  /* ------------------------- 加载关于信息 ------------------------- */
  async function loadAbout() {
    const infoEl = document.getElementById('aboutInfo');
    const rightsEl = document.getElementById('aboutRights');
    if (rightsEl && !rightsEl.dataset.filled) {
      rightsEl.textContent = RIGHTS_TEXT;
      rightsEl.dataset.filled = '1';
    }
    try {
      const d = await api.get('api/settings/public');
      aboutCache = d.about || {};
      if (infoEl) {
        const a = aboutCache;
        const emailBadge = a.email_available
          ? '<span class="badge approved">邮件已配置</span>'
          : '<span class="badge cancelled">邮件未配置</span>';
        // 三层命名别混：系统名称=系统全称（班级名+商品名 / SYSTEM_NAME 指定），班级名称=GROUP_NAME，
        // 商品名（品牌，固定「班级签到系统」）不在此单列——它已在页头与页脚出现。
        const sysName = a.system_name || a.group_name || '班级签到系统';
        const classField = a.group_name
          ? `<div class="about-field"><span class="about-label">班级名称</span><span class="about-value">${escapeHtml(a.group_name)}</span></div>`
          : '';
        infoEl.innerHTML = `
          <p class="about-intro" data-clean-hide>本系统面向本班，提供活动签到、考勤统计、请假补签与申诉等班级考勤管理功能。</p>
          <div class="grid cols-2 about-fields">
            <div class="about-field"><span class="about-label">系统名称</span><span class="about-value">${escapeHtml(sysName)}</span></div>
            ${classField}
            <div class="about-field"><span class="about-label">版本</span><span class="about-value">v${escapeHtml(a.version || '1.0.0')}</span></div>
            <div class="about-field"><span class="about-label">运维者</span><span class="about-value">${escapeHtml(a.ops || '余子晨')}</span></div>
            <div class="about-field"><span class="about-label">反馈受理</span><span class="about-value">工单（站内）+ 邮件（站外） ${emailBadge}</span></div>
          </div>`;
      }
      syncEmailNote();
    } catch (e) { /* 忽略：公开接口一般可用 */ }
  }

  function syncEmailNote() {
    const note = document.getElementById('fbEmailNote');
    const emailChk = document.getElementById('fbByEmail');
    const a = aboutCache || {};
    if (note) {
      if (maintEnabled) note.textContent = '系统维护中，邮件发送已暂停，可仅提交工单。';
      else if (a.email_available) note.textContent = '邮件将发送至：' + (a.feedback_email_mask || '运维者邮箱');
      else note.textContent = '当前未配置邮件服务，邮件渠道暂不可用，可仅提交工单。';
    }
    if (emailChk) {
      emailChk.disabled = maintEnabled || !a.email_available;
      if (maintEnabled) emailChk.checked = false;   // 维护中取消勾选，避免用户误以为会发邮件
    }
  }

  /* ------------------------- 反馈弹窗 ------------------------- */
  function openFeedback() {
    const m = document.getElementById('feedbackModal');
    if (!m) return;
    fbSelectedFiles = [];
    const pv = m.querySelector('#fbPreviews'); if (pv) pv.innerHTML = '';
    const fh = m.querySelector('#fbFilesHint'); if (fh) fh.textContent = '';
    m.classList.remove('hidden');
  }

  async function submitFeedback() {
    const type = (document.getElementById('fbType') || {}).value || 'bug';
    const subject = (document.getElementById('fbTitle').value || '').trim();
    const content = (document.getElementById('fbContent').value || '').trim();
    const contact = '';
    const asTicket = document.getElementById('fbByTicket') ? document.getElementById('fbByTicket').checked : true;
    const asEmail = document.getElementById('fbByEmail') ? document.getElementById('fbByEmail').checked : false;

    if (!subject) { toast('请填写反馈标题'); return; }
    if (!content) { toast('请填写反馈内容'); return; }
    if (!asTicket && !asEmail) { toast('请至少选择一种反馈方式（工单 / 邮件）'); return; }

    let attachmentIds = [];
    if (fbSelectedFiles.length) {
      toast('正在上传图片…');
      try { attachmentIds = await uploadFeedbackImages(fbSelectedFiles); }
      catch (e) { toastErr('图片上传失败：' + (e.message || '未知错误')); return; }
    }

    const btn = document.getElementById('fbSubmit');
    if (btn) btn.disabled = true;
    try {
      const r = await api.post('api/feedback', {
        type, subject, content, contact, as_ticket: asTicket, as_email: asEmail, attachment_ids: attachmentIds
      });
      toast(r.message || '反馈已提交，感谢你的反馈');
      document.getElementById('fbTitle').value = '';
      document.getElementById('fbContent').value = '';
      fbSelectedFiles = [];
      const pv = document.getElementById('fbPreviews'); if (pv) pv.innerHTML = '';
      const fh = document.getElementById('fbFilesHint'); if (fh) fh.textContent = '';
      document.getElementById('feedbackModal').classList.add('hidden');
    } catch (e) {
      toastErr(e.message || '提交失败');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ------------------------- 反馈工单列表（运维者看全部，其余看自己） ------------------------- */
  function statusBadge(status) {
    if (status === 'pending') return '<span class="badge pending">待处理</span>';
    if (status === 'handled') return '<span class="badge approved">已处理</span>';
    return '<span class="badge cancelled">已关闭</span>';
  }

  async function loadFeedbackList() {
    const box = document.getElementById('feedbackListBox');
    if (!box) return;
    box.innerHTML = '<div class="fb-loading">加载中…</div>';
    try {
      const r = await api.get('api/feedback');
      const list = r.feedbacks || [];
      if (!list.length) {
        box.innerHTML = '<div class="fb-empty">暂无反馈工单</div>';
        return;
      }
      const rows = list.map(f => {
        const tname = ({ bug: '功能异常', suggest: '功能建议', other: '其他' })[f.type] || f.type;
        const chParts = [];
        if (f.channel_ticket) chParts.push('站内');
        if (f.channel_email) chParts.push('站外');
        const channel = chParts.join('+') || '—';
        const reply = f.reply ? `<div class="fb-reply">${escapeHtml(f.reply)}</div>` : '';
        const att = (f.attachments && f.attachments.length)
          ? `<div class="fb-images">` + f.attachments.map(a => {
              const src = url('api/feedback/' + f.id + '/attachment/' + a.id);
              return `<img src="${src}" data-full="${src}" alt="反馈图片" title="点击放大查看">`;
            }).join('') + `</div>`
          : '';
        const handleBtn = (r.is_ops && f.status === 'pending')
          ? `<div class="row end" style="margin-top:8px"><button class="btn sm" data-handle="${f.id}" type="button">标记已处理</button></div>`
          : '';
        return `<div class="fb-card">
          <div class="fb-card-head"><b>${escapeHtml(f.subject)}</b>${statusBadge(f.status)}</div>
          <div class="fb-card-meta">${tname} · ${escapeHtml(f.reporter_name || '')}（${escapeHtml(f.reporter_role || '')}）<br>${fmtDateTime(f.created_at)} · 渠道：${channel}</div>
          <div class="fb-card-body">${escapeHtml(f.content)}</div>
          ${att}${reply}${handleBtn}
        </div>`;
      }).join('');
      box.innerHTML = rows;
      box.querySelectorAll('[data-handle]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await api.post('api/feedback/' + btn.getAttribute('data-handle') + '/handle', { status: 'handled' });
            toast('已标记为已处理');
            loadFeedbackList();
          } catch (e) { toastErr(e.message || '操作失败'); }
        });
      });
      box.classList.remove('hidden');
    } catch (e) {
      box.innerHTML = '<div class="fb-error">加载失败：' + escapeHtml(e.message || '') + '</div>';
      box.classList.remove('hidden');
    }
  }

  /* ------------------------- 页脚：版权声明 + ICP/公安 备案号（三端一致） ------------------------- */
  // 部署时请把下方备案号替换为实际备案号（工信部备案 + 公安备案）。
  const BEIAN = [
    { num: '浙ICP备2026068891号-1', url: 'https://beian.miit.gov.cn/', tip: '点击复制并打开工信部备案网站' },
    { gongan: true, num: '浙公网安备33038102332694号', url: 'http://www.beian.gov.cn/', tip: '点击复制并打开公安备案网站' }
  ];

  function injectFooter() {
    const sec = document.getElementById('sec-about');
    if (!sec || document.getElementById('aboutFooter')) return;

    const links = BEIAN.map(b => {
      const cls = b.gongan ? 'beian-link gongan' : 'beian-link';
      const icon = b.gongan
        ? '<img class="gongan-icon" src="images/beian-gongan.png" alt="公安备案图标" width="14" height="14">'
        : '';
      return `<span class="beian-item">${icon}<a class="${cls}" href="${b.url}" target="_blank" rel="noopener" ` +
        `data-copy="${b.num}" data-url="${b.url}" title="${b.tip}">${b.num}</a></span>`;
    }).join('');

    const footer = document.createElement('footer');
    footer.id = 'aboutFooter';
    footer.className = 'about-footer';
    footer.innerHTML = `
      <div class="about-footer-copy">Copyright © 2026 Yushichadao · 基于 MIT 协议开源发布</div>
      <div class="about-footer-copy">余子晨 版权所有，保留署名；使用、修改与再分发遵循 MIT 协议</div>
      <div class="about-footer-beian">
        ${links}
      </div>`;
    sec.appendChild(footer);

    // 点击备案号：复制备案号 + 打开对应网站主页
    footer.querySelectorAll('.beian-link').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const num = a.getAttribute('data-copy') || '';
        const url = a.getAttribute('data-url') || a.href;
        const go = () => { window.open(url, '_blank', 'noopener'); if (window.toast) toast('已复制备案号：' + num); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(num).then(go).catch(go);
        } else {
          go();
        }
      });
    });
  }

  function init() {
    injectImageViewer();
    injectFeedbackModal();
    injectFooter();

    // 维护模式：反馈弹窗的「发送邮件给运维者」勾选框随维护状态禁用 / 恢复
    if (window.MaintenanceGuard) window.MaintenanceGuard.subscribe(function (i) {
      maintEnabled = !!(i && i.enabled);
      syncEmailNote();
    });
    setupTextCollapsibles();
    const openBtn = document.getElementById('openFeedbackBtn');
    const listBtn = document.getElementById('openFeedbackListBtn');
    const listModal = document.getElementById('feedbackListModal');
    if (openBtn) openBtn.addEventListener('click', openFeedback);
    if (listBtn) listBtn.addEventListener('click', () => {
      if (listModal) { listModal.classList.remove('hidden'); loadFeedbackList(); }
    });
    if (listModal) listModal.addEventListener('click', e => { if (e.target === listModal) listModal.classList.add('hidden'); });

    loadAbout();

    // 「关于系统」分区被切到时刷新（运维者工单列表 / 邮件说明）。
    // 用 MutationObserver 监听 active 类，避免被各端自身的 onSectionChange 覆盖。
    const sec = document.getElementById('sec-about');
    if (sec && 'MutationObserver' in window) {
      const obs = new MutationObserver(() => {
        if (sec.classList.contains('active')) loadAbout();
      });
      obs.observe(sec, { attributes: true, attributeFilter: ['class'] });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
