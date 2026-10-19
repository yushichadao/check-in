/* 权限门禁组件（perm-gate）
 * ---------------------------------------------------------------
 * 规则（仅针对「高危且未授权」的控件）：
 *  - 按钮 / 下拉项 / 控件：灰度（grayscale + blur）+ 降透明度，保留可点击热区；
 *    点击 → 弹出「权限工单」确认弹窗（带入 PERM 码 + 可读名，可勾选 1~N 审批人、填理由）；
 *  - 整页高危操作都未授权 → 整页模糊 + 浮窗（.perm-page-lock），点击任意处同弹工单；
 *  - 角色基线的常规权限不在门禁范围（班委天然持有，不灰度）。
 *
 * 用法：
 *   PermGate.init(permState)                       // 由 /me 返回的 perm 对象
 *   PermGate.apply(root)                           // 扫描 [data-perm] 元素
 *   PermGate.lockPage(sectionEl, [codes])          // 整页门禁
 *   PermGate.has('FENCE_VERIFY')                   // 权限判定
 */
(function () {
  let state = { level: 0, perms: {}, location_verify_enabled: false, location_verify_allowed: false };
  let optionsCache = null;

  function has(code) { return !!(state.perms && state.perms[code]); }

  function init(permState) {
    state = Object.assign({ level: 0, perms: {} }, permState || {});
  }

  /** 拉取可申请权限 + 可选审批人（缓存，弹窗用） */
  async function loadOptions(force) {
    if (optionsCache && !force) return optionsCache;
    try {
      optionsCache = await api.get('api/workorders/options');
    } catch (e) {
      optionsCache = { perms: [], approvers: [], timeout_hours: 48 };
    }
    return optionsCache;
  }

  /**
   * 权限可读名。
   * 界面一律只展示可读名：未登记 / 未知的码也绝不回退成码本身，避免把内部权限码露给用户。
   */
  function permLabel(code) {
    const map = {
      // 活动范围
      FENCE_DRAW: '画/改/删活动范围（本人添加的）', FENCE_POINT: '画目的地点图标',
      FENCE_VERIFY: '启动活动范围核验', FENCE_VIEW_MAP: '地图查看活动范围',
      // 查看
      VIEW_COORD: '查看原始定位（始终禁用，不可授予）', VIEW_CHECKIN: '查看签到明细',
      VIEW_STUDENT_LOCATION: '查看学生定位',
      VIEW_STATS: '统计报表', VIEW_AUDIT: '查看审计日志',
      VIEW_DATAFLOW: '查看数据流（审计留痕）',
      // 活动
      ACT_CREATE: '创建活动（含地点文本）', ACT_MANAGE: '改活动（本人创建的）',
      ACT_DELETE: '删除活动（含批量/子项/长期任务，高危）', ACT_RECURRING: '循环/活动',
      // 审核
      ADJ_INITIAL: '请假/补签初步裁决', ADJ_FINAL: '终审 / 覆盖',
      // 授权
      AUTH_GRANT: '向下授权', AUTH_APPROVE_WO: '工单邮件审批',
      AUTH_ACCOUNT: '账号管理（含清除密码）', AUTH_PRIVACY: '隐私告知文案',
      // 系统
      SYS_MAINTENANCE: '维护模式开关', SYS_SETTINGS: '系统设置',
      // 学生固有能力（用户端也会列出，避免出现生码）
      STU_SELF: '查看本人信息', STU_JOIN_LOC: '参与定位签到',
      STU_APPEAL: '提交申诉（请假/补签）', STU_OWN_ACT: '查看本人签到记录',
      STU_PRIVACY: '隐私偏好', STU_DEVICE: '设备与会话管理', STU_NOTIFY: '接收提醒',
      // 运维者隔离能力
      OPS_ACCOUNT: '运维账号管理', OPS_AUDIT_STREAM: '审计流', OPS_MAINTENANCE: '维护兜底',
      OPS_DEPLOY: '部署', OPS_VERSION: '版本', OPS_DEVICES: '设备管理', OPS_EXPORT: '导出',
      // 账号重新启用（走工单流程，非权限表内的码）
      REACTIVATE: '账号重新启用'
    };
    return map[code] || '未知权限';
  }

  /**
   * 权限工单弹窗（下→上）：勾选 1~N 审批人（避免社死）+ 填理由。
   * @returns {Promise<boolean>} 是否提交成功
   */
  async function openOrderDialog(code, extraNote) {
    const opts = await loadOptions();
    const approvers = opts.approvers || [];
    if (!approvers.length) {
      toast('当前没有可选的审批人：需要层级高于你、能管理你、且持有「工单审批」权限的上级（或运维者）。请先联系运维者开通');
      return false;
    }

    return new Promise(resolve => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `<div class="modal">
        <h3>申请权限：${escapeHtml(permLabel(code))}</h3>
        <p style="margin:0">
          该操作属于<b>高危权限</b>，你当前未持有。提交工单后由你勾选的上级审批；审批通过即自动开通。
        </p>
        ${extraNote ? `<div class="alert warn" style="margin-bottom:10px">${escapeHtml(extraNote)}</div>` : ''}
        <div class="field">
          <label>选择审批人（可多选，建议只勾选必要的人，避免多人知晓）</label>
          <div class="row" style="gap:8px;flex-wrap:wrap">
            ${approvers.map(a => `<label class="chk">
              <input type="checkbox" class="wo-ap" value="${a.id}"> ${escapeHtml(a.real_name)}（${escapeHtml(a.role_title)}）
            </label>`).join('')}
          </div>
        </div>
        <div class="field">
          <label>申请理由</label>
          <textarea data-reason rows="3" placeholder="请说明用途与紧急程度，便于审批人判断"></textarea>
        </div>
        <div class="muted" style="font-size:12px">
          工单超过 ${opts.timeout_hours || 48} 小时未审批将自动驳回并邮件通知你。
        </div>
        <div class="row end" style="margin-top:10px">
          <button class="btn primary" data-yes type="button">提交工单</button>
          <button class="btn" data-no type="button">取消</button>
        </div>
      </div>`;
      document.body.appendChild(mask);

      const done = (v) => { mask.remove(); resolve(v); };
      mask.querySelector('[data-no]').addEventListener('click', () => done(false));
      mask.querySelector('[data-yes]').addEventListener('click', async () => {
        const ids = Array.prototype.slice.call(mask.querySelectorAll('.wo-ap:checked')).map(i => Number(i.value));
        const reason = String(mask.querySelector('[data-reason]').value || '').trim();
        if (!ids.length) return toast('请至少勾选一位审批人');
        if (!reason) return toast('请填写申请理由');
        try {
          const r = await api.post('api/workorders', { perm_code: code, reason, approver_ids: ids });
          toast(r.message || '已提交，等待审批');
          done(true);
        } catch (e) { toastErr(e.message); }
      });
      mask.addEventListener('click', e => { if (e.target === mask) done(false); });
    });
  }

  /**
   * 「主动申请高危权限」选择弹窗：从可申请的权限里按名称选一项，再走工单流程。
   * 界面只出现权限名称（不出现权限码），提交时后端按名称对应的权限受理。
   * @returns {Promise<boolean>} 是否成功提交
   */
  async function openOrderPicker() {
    const opts = await loadOptions();
    const perms = opts.perms || [];
    if (!perms.length) { toast('你没有可申请的高危权限（已全部持有）'); return false; }
    const picked = await new Promise(resolve => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `<div class="modal">
        <h3>申请高危权限</h3>
        <p style="margin:0">选择需要申请的权限，提交后由你勾选的上级审批。</p>
        <div class="field">
          <label>可申请的权限</label>
          <div class="row" style="gap:8px;flex-wrap:wrap">
            ${perms.map((p, i) => `<label class="chk">
              <input type="radio" name="wo-perm" value="${i}"> ${escapeHtml(p.name || permLabel(p.code))}
            </label>`).join('')}
          </div>
        </div>
        <div class="row end" style="margin-top:10px">
          <button class="btn primary" data-yes type="button">下一步</button>
          <button class="btn" data-no type="button">取消</button>
        </div>
      </div>`;
      document.body.appendChild(mask);
      const done = (v) => { mask.remove(); resolve(v); };
      mask.querySelector('[data-no]').addEventListener('click', () => done(null));
      mask.querySelector('[data-yes]').addEventListener('click', () => {
        const hit = mask.querySelector('[name="wo-perm"]:checked');
        if (!hit) { toast('请选择要申请的权限'); return; }
        done(perms[Number(hit.value)] || null);
      });
      mask.addEventListener('click', e => { if (e.target === mask) done(null); });
    });
    if (!picked || !picked.code) return false;
    return openOrderDialog(picked.code);
  }

  /**
   * 信息修改 / 反馈工单弹窗（用户端 / 管理端：本人无法直接编辑，提交后由上级处理）
   * @param {{reason?:string}} prefill 预填内容（如本人 / 目标账号信息）
   * @returns {Promise<boolean>} 是否提交成功
   */
  async function openInfoOrderDialog(prefill) {
    const opts = await loadOptions();
    const approvers = opts.approvers || [];
    if (!approvers.length) {
      toast('当前没有可选的处理人：需要层级高于你、能管理你、且持有「工单审批」权限的上级（或运维者）。请先联系运维者开通');
      return false;
    }
    const def = (prefill && prefill.reason) ? prefill.reason : '';
    return new Promise(resolve => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `<div class="modal">
        <h3>提交「信息修改 / 反馈」工单</h3>
        <p style="margin:0">你没有直接修改的权限，提交后由上级（管理员 / 运维者）协助处理。请说明需要修改的信息或反馈内容。</p>
        <div class="field">
          <label>选择处理人（可多选）</label>
          <div class="row" style="gap:8px;flex-wrap:wrap">
            ${approvers.map(a => `<label class="chk"><input type="checkbox" class="wo-ap" value="${a.id}"> ${escapeHtml(a.real_name)}（${escapeHtml(a.role_title)}）</label>`).join('')}
          </div>
        </div>
        <div class="field">
          <label>内容（需要修改的信息 / 反馈）</label>
          <textarea data-reason rows="4" placeholder="如：请帮我修改姓名为 XXX；或修改学号 / 邮箱 / 身份等">${escapeHtml(def)}</textarea>
        </div>
        <div class="muted" style="font-size:12px">工单超时未处理将自动驳回并通知你。</div>
        <div class="row end" style="margin-top:10px">
          <button class="btn primary" data-yes type="button">提交工单</button>
          <button class="btn" data-no type="button">取消</button>
        </div>
      </div>`;
      document.body.appendChild(mask);
      const done = (v) => { mask.remove(); resolve(v); };
      mask.querySelector('[data-no]').addEventListener('click', () => done(false));
      mask.querySelector('[data-yes]').addEventListener('click', async () => {
        const ids = Array.prototype.slice.call(mask.querySelectorAll('.wo-ap:checked')).map(i => Number(i.value));
        const reason = String(mask.querySelector('[data-reason]').value || '').trim();
        if (!ids.length) return toast('请至少勾选一位处理人');
        if (!reason) return toast('请填写内容');
        try {
          const r = await api.post('api/workorders', { kind: 'info', reason, approver_ids: ids });
          toast(r.message || '已提交，等待处理');
          done(true);
        } catch (e) { toastErr(e.message); }
      });
      mask.addEventListener('click', e => { if (e.target === mask) done(false); });
    });
  }

  /** 把某元素置为「灰度未授权」态，并接管点击 → 弹工单 */
  function markBlocked(el, code, note) {
    if (el.dataset.permBound === '1') return;
    el.dataset.permBound = '1';
    el.classList.add('perm-blocked');
    el.setAttribute('title', `需要「${permLabel(code)}」权限，点击可提交权限工单`);
    const handler = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await openOrderDialog(code, note);
    };
    el._permHandler = handler;
    el.addEventListener('click', handler, true);   // 捕获阶段：抢在业务 handler 之前拦截
  }

  /** 解除门禁（已授权 / 权限获批后调用），移除灰度与拦截 handler，恢复控件本身功能 */
  function unblock(el) {
    el.classList.remove('perm-blocked');
    if (el._permHandler) {
      el.removeEventListener('click', el._permHandler, true);
      el._permHandler = null;
    }
    if (el.dataset.permBound === '1') {
      delete el.dataset.permBound;
      el.removeAttribute('title');
    }
  }

  /** 扫描并应用门禁：元素上用 data-perm="FENCE_VERIFY" 声明所需权限 */
  function apply(root) {
    (root || document).querySelectorAll('[data-perm]').forEach(el => {
      const code = el.getAttribute('data-perm');
      if (!code) return;
      if (has(code)) { unblock(el); return; }
      markBlocked(el, code, el.getAttribute('data-perm-note') || '');
    });
  }

  /**
   * 整页门禁：该分区内所有 data-perm 都未授权 → 整页模糊 + 浮窗，点击任意处弹工单。
   * @param {HTMLElement} section 分区元素
   * @param {string[]} codes 需要的权限码（任一持有即解锁）
   */
  function lockPage(section, codes) {
    if (!section) return;
    const list = (codes || []).filter(Boolean);
    if (!list.length) return;
    if (list.some(has)) { unlockPage(section); return; }
    if (section.querySelector('.perm-page-lock')) {
      // 已上锁：刷新文案即可
      const tip = section.querySelector('.perm-page-lock .perm-lock-tip');
      if (tip) tip.textContent = list.map(permLabel).join('、');
      return;
    }
    const lock = document.createElement('div');
    lock.className = 'perm-page-lock';
    lock.innerHTML = `<div class="perm-lock-card">
      <div class="perm-lock-ico">🔒</div>
      <div class="perm-lock-title">该页面需要高危权限</div>
      <div class="perm-lock-tip">${escapeHtml(list.map(permLabel).join('、'))}</div>
      <div class="muted" style="font-size:12px;margin-top:6px">点击任意处提交权限工单，由上级审批后自动解锁</div>
    </div>`;
    lock.addEventListener('click', () => openOrderDialog(list[0]));
    section.classList.add('perm-locked');
    section.appendChild(lock);
  }

  function unlockPage(section) {
    if (!section) return;
    const lock = section.querySelector('.perm-page-lock');
    if (lock) lock.remove();
    section.classList.remove('perm-locked');
  }

  window.PermGate = { init, apply, has, lockPage, unlockPage, openOrderDialog, openOrderPicker, openInfoOrderDialog, permLabel, loadOptions };
})();
