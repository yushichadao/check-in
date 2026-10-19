'use strict';
const db = require('./db');
const { NOTIFY_PREFS, notifyPrefVisible, LOCATION_VERIFY_DEFAULT } = require('./config');

/**
 * 系统设置（键值对）。未在库中显式设置时回退到默认值。
 *  - allow_makeup     是否允许普通学生发起补签（申诉）
 *  - location_verify_enabled  定位核验总开关（默认关；需 FENCE_VERIFY，基线辅导员 R3+，缺辅导员时由自动代管下放）
 *  - maintenance_enabled      维护模式
 *  - notify.NT_*      分层级通知偏好开关（mandatory 恒为开，不可关）
 * 注：旧提醒开关 notify_pre_start / notify_start / notify_absent 已废弃，
 *     统一由「用户端通知 / 提醒偏好」中的 NT_REMINDER_* / NT_CHECKIN_START / NT_NOT_CHECKED 控制。
 */
const DEFAULTS = {
  allow_makeup: '1',
  location_verify_enabled: LOCATION_VERIFY_DEFAULT ? '1' : '0',
  // 管理端定位查看总开关（运维者全局控制）：开启后，持有 VIEW_STUDENT_LOCATION 的管理员可在地图查看学生定位
  manager_location_view: '0',
  maintenance_enabled: '0',
  // 维护窗口（毫秒时间戳，空串表示未排期）与维护说明
  maintenance_start_at: '',
  maintenance_end_at: '',
  maintenance_notice: '',
  // 已触发过的排期开始时间：同一条排期只允许自动进入维护一次，避免「结束后又被拉回维护」
  maintenance_schedule_fired: '',
  // 数据流隐私打码：开启后「数据流页面显示」对姓名/学号/邮箱等隐私字段统一中间打 *（运维者/管理员可见打码内容，且保证相互可区分）；仅改变展示，不改存储原文
  // 安全默认：默认为 1（打码）。原默认 0 会让数据流默认输出他人邮箱明文，与「列表内脱敏」的承诺不符（已由联调实证）。
  dataflow_mask: '1',
  // 自动代管（缺小班主任/辅导员时由班委代行其基线权力）：默认开启。
  // 注意：本键【刻意不加入 BOOL_KEYS】—— 若加入，会被 POST /api/settings/basic（仅需 SYS_SETTINGS）改写，
  // 形成与 dataflow_mask 同类的越权旁路。它只能经 PUT /api/settings/auto-cover（仅运维者）修改。
  auto_cover_enabled: '1',
  // 最近一次代管变更时间（由 server/autocover.js 写入，供状态卡展示）
  auto_cover_updated_at: ''
};

/** 通知偏好 key：`notify.NT_REMINDER_60` */
function notifyKey(kind) { return `notify.${kind}`; }

Object.keys(NOTIFY_PREFS).forEach(k => { DEFAULTS[notifyKey(k)] = NOTIFY_PREFS[k].mandatory ? '1' : '1'; });

// 注意：dataflow_mask 不在此列表中。
// 它声明为「仅运维者可切换」，只能通过 POST /api/dataflow/mask 修改；
// 若放进 BOOL_KEYS，会被 POST /api/settings/basic（仅需 SYS_SETTINGS，小班主任即持有）一并改写，
// 造成管理端越权关闭隐私打码（已由联调实证）。
const BOOL_KEYS = ['allow_makeup'];

function get(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row && row.value !== null && row.value !== undefined) return row.value;
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key) ? DEFAULTS[key] : null;
}

function getBool(key) {
  return String(get(key)) === '1';
}

function set(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(key), String(value));
}

/** 全部设置（默认值 + 库中覆盖） */
function all() {
  const out = Object.assign({}, DEFAULTS);
  db.prepare('SELECT key, value FROM settings').all().forEach(r => { out[r.key] = r.value; });
  return out;
}

/* ------------------------- 通知偏好 ------------------------- */

/**
 * 某类提醒当前是否应发送。
 * mandatory=true 的（必提醒）恒为 true，配置界面置灰禁用、不可取消。
 */
function notifyEnabled(kind) {
  const def = NOTIFY_PREFS[kind];
  if (!def) return true;                       // 未知类型默认发送
  if (def.mandatory) return true;              // 必提醒不可取消
  return getBool(notifyKey(kind));
}

/** 读取全部通知偏好（含 mandatory / min_level / 是否被锁） */
function notifyPrefs() {
  const out = {};
  Object.keys(NOTIFY_PREFS).forEach(k => {
    const def = NOTIFY_PREFS[k];
    out[k] = {
      key: k,
      name: def.name,
      mandatory: !!def.mandatory,
      min_level: def.min_level,
      enabled: notifyEnabled(k)
    };
  });
  return out;
}

/**
 * 写入通知偏好：mandatory 恒忽略写入（不可取消）。
 * @returns {boolean} 是否真的写入
 */
function setNotifyPref(kind, on) {
  const def = NOTIFY_PREFS[kind];
  if (!def || def.mandatory) return false;
  set(notifyKey(kind), on ? '1' : '0');
  return true;
}

/* ------------------------- 个人通知渠道偏好（自服务） ------------------------- */

/**
 * 前端分组：把 NT_* 类型归到更友好的「使用场景」分组，便于个人偏好面板展示。
 *   activity 活动与签到提醒（最容易被邮件骚扰的一类）
 *   review   退回 / 回执（裁决退回、核验 / 补签完成回执）
 *   system   工单 / 系统消息（必提醒，锁定）
 */
const NOTIFY_CAT = {
  NT_ACT_CREATE: 'activity', NT_CHECKIN_START: 'activity',
  NT_REMINDER_60: 'activity', NT_REMINDER_30: 'activity',
  NT_REMINDER_10: 'activity', NT_REMINDER_5: 'activity',
  NT_ACT_START: 'activity', NT_NOT_CHECKED: 'activity',
  NT_RETURN: 'review', NT_RECEIPT: 'review',
  NT_WO_REPLY: 'system', NT_SYS_MSG: 'system'
};
const NOTIFY_CAT_NAME = {
  activity: '活动与签到提醒',
  review: '退回 / 回执',
  system: '工单与系统消息'
};

/** 渠道取值白名单 */
const CHANNELS = ['both', 'inbox', 'off'];

/**
 * 读取某账号对某类通知的自选渠道（'both' | 'inbox' | 'off'）。
 * 未设置返回 null（调用方回退默认值 'both'）。
 */
function userNotifyChannel(userId, kind) {
  if (!userId || !kind) return null;
  const row = db.prepare('SELECT channel FROM user_notify_pref WHERE user_id = ? AND kind = ?').get(String(userId), String(kind));
  return row ? row.channel : null;
}

/**
 * 写入某账号对某类通知的渠道偏好。
 *  - 必提醒（mandatory）锁定为 'both'，不可改；
 *  - 仅学生会收到的类型（student_only），管理端 / 运维端不接受写入（设了也收不到）；
 *  - 渠道取值必须落在白名单；
 *  - 缺省（未设置过）即视为 'both'，删除该行即可回到默认。
 * @returns {boolean} 是否真的写入
 */
function setUserNotifyPref(userId, kind, channel, user) {
  const def = NOTIFY_PREFS[kind];
  if (!def || def.mandatory) return false;       // 必提醒不可改
  if (!notifyPrefVisible(kind, user)) return false;  // 对该角色无意义的类型不接受写入
  if (!CHANNELS.includes(channel)) return false;
  const uid = String(userId);
  if (channel === 'both') {
    // 回到默认：删除该行，避免库里堆满 'both'
    db.prepare('DELETE FROM user_notify_pref WHERE user_id = ? AND kind = ?').run(uid, String(kind));
  } else {
    db.prepare(`
      INSERT INTO user_notify_pref (user_id, kind, channel, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, kind) DO UPDATE SET channel = excluded.channel
    `).run(uid, String(kind), channel, Date.now());
  }
  return true;
}

/**
 * 读取某账号的全部个人通知渠道偏好（用于前端面板）。
 * 按角色过滤：仅普通学生会收到的类型（student_only）对管理端 / 运维端隐藏。
 * 返回数组，按 NOTIFY_PREFS 顺序；每项含：
 *   key, name, cat, cat_name, mandatory, min_level, channel(已解析), locked, configurable
 */
function userNotifyPrefs(userId, user) {
  const out = [];
  Object.keys(NOTIFY_PREFS).forEach(k => {
    const def = NOTIFY_PREFS[k];
    if (!notifyPrefVisible(k, user)) return;      // 该角色收不到 → 不展示
    const stored = userNotifyChannel(userId, k);
    const channel = stored || 'both';
    out.push({
      key: k,
      name: def.name,
      cat: NOTIFY_CAT[k] || 'system',
      cat_name: NOTIFY_CAT_NAME[NOTIFY_CAT[k]] || NOTIFY_CAT_NAME.system,
      mandatory: !!def.mandatory,
      min_level: def.min_level,
      channel,
      locked: !!def.mandatory,           // 必提醒锁定，前端置灰
      configurable: !def.mandatory
    });
  });
  return out;
}

/* ------------------------- 定位核验 / 维护模式 ------------------------- */

function locationVerifyEnabled() { return getBool('location_verify_enabled'); }

function setLocationVerify(on) { set('location_verify_enabled', on ? '1' : '0'); }

/* ------------------------- 自动代管（缺上级自动补位） ------------------------- */

/** 自动代管总开关（默认开；仅运维者可切换，独立接口，不经 BOOL_KEYS） */
function autoCoverEnabled() { return getBool('auto_cover_enabled'); }

function setAutoCover(on) { set('auto_cover_enabled', on ? '1' : '0'); }

function maintenanceEnabled() { return getBool('maintenance_enabled'); }

function setMaintenance(on) { set('maintenance_enabled', on ? '1' : '0'); }

/** 维护窗口信息（含排期起止与维护说明；维护说明即遮罩上展示的唯一文案） */
function maintenanceInfo() {
  return {
    enabled: getBool('maintenance_enabled'),
    start_at: Number(get('maintenance_start_at')) || null,
    end_at: Number(get('maintenance_end_at')) || null,
    notice: get('maintenance_notice') || ''
  };
}

/** 设置维护说明（维护遮罩上展示的唯一文案；立即开启时写入，结束维护时清空） */
function setMaintenanceNotice(n) { set('maintenance_notice', String(n || '').slice(0, 300)); }

/** 设置维护窗口（start_at/end_at 为时间戳或 null；notice 为说明） */
function setMaintenanceWindow(v) {
  const o = v || {};
  if (o.start_at !== undefined) {
    const next = o.start_at ? String(Number(o.start_at)) : '';
    // 排期开始时间被改写 → 视为一条新排期，清掉「已触发」标记，允许它再次自动触发
    if (next !== get('maintenance_start_at')) set('maintenance_schedule_fired', '');
    set('maintenance_start_at', next);
  }
  if (o.end_at !== undefined) set('maintenance_end_at', o.end_at ? String(Number(o.end_at)) : '');
  if (o.notice !== undefined) set('maintenance_notice', String(o.notice || '').slice(0, 300));
}

/** 隐私告知文案（默认内置；管理员可通过 AUTH_PRIVACY 覆盖）
 *  —— 本软件基于 MIT 协议开源发布，任何人可自由部署、修改与再分发（含商业用途）；
 *     数据由部署方私有化自持，软件著作权人不收集、不访问任何运行数据。 */
const DEFAULT_PRIVACY = [
  '《班级签到系统 · 隐私政策》',
  '',
  '引言',
  '《班级签到系统》（以下简称「本软件」）是一款基于 MIT 协议开源发布的软件，采用私有化部署，面向班级与组织的考勤管理。本软件由使用者（部署方）自行运行在自有或指定的服务器上，所有业务数据均存储于部署方自己的服务器；软件著作权人既不运营任何公共服务，也不收集、不远程访问任何部署实例中的数据。',
  '本政策面向本系统的全部使用者——学生、班级管理员与运维人员。只要你在本系统中留有个人信息，即受本政策约束。本政策说明本软件在运行过程中收集哪些信息、如何使用与保护这些信息，以及你作为使用者拥有哪些权利。请在注册前完整阅读本政策；勾选「我已阅读并同意」即表示你理解并接受本政策全部内容。',
  '实际收集并处理你个人信息的「个人信息处理者」为部署并使用本系统的班级或组织；其名称与联系方式、以及各类信息的具体保存期限，均以部署方公示的《隐私告知》为准（本内置文本为模板，部署方可在「隐私告知」中补充与本组织规定一致的内容）。本政策中的「运维者」即该处理者指定的运维人员（详见第七条）。',
  '',
  '一、本软件收集哪些信息',
  '1. 账号与身份信息：姓名、身份（普通学生 / 班委 / 小班主任 / 辅导员 / 运维者）、学号（仅学生）、你的邮箱、账号创建时间与启用状态。你的账号须由相应管理员预先登记姓名、学号与身份，你再到注册页用一致信息完成邮箱验证码验证并设置密码，因此本系统不接受任意注册。',
  '2. 认证信息：密码仅以不可逆的哈希摘要保存，任何人都无法看到密码原文；注册与找回密码所用的邮箱验证码仅保存哈希值、有效期与尝试次数，不保存验证码明文。',
  '3. 签到信息：你对每场活动提交的签到状态（已签到 / 在途中 / 请假 / 缺勤 / 退签）、提交时间、是否由管理员代为操作（代请假、补签、退签），以及是否落在活动范围内。',
  '4. 定位信息：仅在活动范围核验开启、且你本人已授权后，才保存你签到时提交的经纬度与定位精度，详见第五条。',
  '5. 设备与会话信息：设备类型、浏览器名称、设备识别码、登录 IP、最近活动时间与在线状态，用于「一台手机 + 一台电脑」的登录限制、异地登录识别、会话管理与操作审计。',
  '6. 申诉与沟通信息：请假 / 补签的理由、你填写的地点文本、上传的图片材料、与审核人之间的留言及裁决结果。',
  '7. 工单信息：权限申请、信息修改反馈、账号重启用等工单的申请内容、审批人与审批结果。',
  '8. 操作留痕（数据流）：每次操作的动作、操作者、操作对象、内容摘要、投递渠道与时间；由系统自动触发的操作，操作者记为「系统」。',
  '9. 反馈信息：你通过「反馈网站问题」提交的问题描述与截图。',
  '',
  '二、本软件如何收集',
  '· 密码与验证码：密码与验证码均只在服务端以哈希形式保存，前端与传输过程中不以明文落库；',
  '· 定位：不做后台持续定位，也不记录你的行动轨迹。仅在活动范围核验总开关开启、且你本人已授权的前提下，才会在你点击「签到」的瞬间于前台获取一次位置；请假、补签申诉及管理员代操作均不涉及定位采集；',
  '· 其他信息：姓名、学号、邮箱等均由你在注册 / 使用过程中主动提供，或由班级管理员在管辖范围内录入。',
  '',
  '三、本软件如何使用这些信息',
  '· 完成签到，以及请假 / 补签的提交与两级审核；',
  '· 生成班级考勤统计、班级与个人签到日历；',
  '· 发送活动、签到、审核结果与账号安全相关的必要提醒；',
  '· 账号安全管理（设备管理、异地登录识别、找回密码）；',
  '· 事后追溯与争议核对（操作留痕）。',
  '补充说明：是否处于活动范围内只作记录参考，不在范围内也可正常提交签到，系统不会因此阻止你签到。',
  '',
  '四、本软件不做什么',
  '· 不采集通讯录、短信、通话、相册、麦克风、摄像头等与签到无关的个人信息；',
  '· 不在服务端保存你的密码原文或验证码明文；',
  '· 不向任何第三方出售你的个人信息，也不将其用于广告、营销或用户画像；',
  '· 不做后台持续定位，不记录你的行动轨迹。',
  '',
  '五、定位与活动范围',
  '· 活动范围核验的总开关由持有相应权限的管理员控制；即便开关开启，也只有在你本人明确同意上传定位后才会采集。定位属于敏感个人信息，其采集须经你主动开启「定位上传授权」并单独确认，该同意独立于对本政策整体接受的同意；定位仅在你主动签到时获取；请假、补签申诉及管理员代操作均不涉及定位。',
  '· 你可以在「账号信息 → 定位上传授权」随时查看、取消或重新授权；不授权同样可以正常签到，只是不会采集位置。授权与否属于你的个人隐私，不写入操作留痕。',
  '· 采集到的坐标随该次签到记录一并保存：你只能在自己的签到记录中查看自己的定位；持有「查看学生定位」权限且相应查看开关打开的管理员，可在地图上查看你的定位，其查看行为同样会被留痕。当核验关闭、你未授权、活动未设置范围，或该次签到由管理员代为操作（非你本人）时，界面显示「未采集定位」；仅当核验开启、你已授权、活动已设范围且为你本人签到时，界面才显示「活动范围内」或「活动范围外」。',
  '· 你随时可以取消授权，取消之后的签到不再采集位置；此前已保存的记录用于班级考勤存档，不做删除。',
  '',
  '六、邮件与通知',
  '· 你登记的邮箱用于：注册激活验证码、找回密码验证码、密码变更与异地登录等安全提醒，以及活动、签到、审核结果等必要通知。邮箱为必填项，未通过邮箱验证的账号不能登录。',
  '· 系统按你是否正在使用本系统自动选择渠道：在线操作时只发站内消息；离线或长时间不活动时，按你在「账号信息 → 通知偏好」自选的渠道决定是否同时发邮件。你可将活动与签到提醒改为「仅站内消息」或「关闭」，避免邮件打扰。',
  '· 以下几项不可关闭：注册激活与找回密码验证码、密码变更与异地登录提醒、工单与系统消息——它们关系账号安全与你必须知晓的处理结果。',
  '· 新账号首次登录后需完成一次通知偏好设置才能进入系统，之后可随时修改。',
  '· 系统界面内不展示他人完整邮箱，姓名、学号、邮箱等隐私字段统一做中间打码；但邮件须经第三方邮件服务（SMTP）投递，因此邮件服务商与持有发件邮箱的运维者在技术上可看到你的邮箱地址。界面打码只约束页面展示，不约束这条投递链路；运维者不会主动查阅邮箱，也不将其用于约定之外的目的。',
  '',
  '七、谁能看到你的信息',
  '· 你自己：可查看你自己的签到记录、申诉、工单、通知偏好与个人资料；',
  '· 班级管理员：在其管理范围与权限等级内查看所管理学生的签到明细、申诉材料与统计，不能查看超出管辖范围的数据；',
  '· 运维者：承担系统运维，必要时可访问服务器数据；运维端的数据流列表默认对姓名、学号等字段做中间打码。运维者即部署本项目的人，并非软件著作权人；',
  '· 上述数据流打码仅约束页面展示与导出，不改变数据库中存储的原文；运维者因可访问服务器，在技术上仍可能读到原始内容。密码以不可逆摘要、邮箱验证码以哈希保存，这类信息即便运维者直接访问服务器也无法还原为明文。',
  '· 可见范围由分级授权决定（运维者 ＞ 辅导员 ＞ 小班主任 ＞ 班委 ＞ 学生），上级仅能管理其管理范围内的下级账号；',
  '· 某一管理层级暂缺在岗人员时（仅被预置、尚未注册激活的账号不算在岗），该层级的基线权限由下一级在岗管理岗依「自动代管」规则临时行使：辅导员暂缺时由在岗小班主任优先代行，小班主任也暂缺则由在岗班委代行；小班主任暂缺时由在岗班委代行。上级一经注册到岗，代管权限立即自动收回并通知代管人，代管所得权限不可再向下授权；',
  '· 申诉的图片与文字仅限你本人及其可管理的上级查看。',
  '',
  '八、存储地点、留存与安全',
  '· 数据存储于本系统运行的服务器（数据库与上传文件目录）中，由部署方自行控制，不会上传至任何第三方平台，软件著作权人亦无法远程访问；',
  '· 会话凭证由服务端签发、带有效期，且浏览器脚本无法读取；系统通过 HTTPS 加密通道传输数据，部署时应启用 TLS 证书以保障传输安全；',
  '· 密码以不可逆摘要保存、邮箱验证码以哈希保存；操作留痕支持开启「中间部分加密」，开启后未经解密无法直接读到完整内容；',
  '· 签到、请假、补签与操作留痕用于班级考勤存档，在达成处理目的所必需的最短期限内保存；各类信息的具体保存期限由部署方依其管理规定确定，超出期限或你注销账号后按部署方规则删除或匿名化处理。邮箱验证码过期即自动失效；',
  '· 除邮件投递所必需的邮件服务商外，本软件不向任何第三方提供你的个人信息；因法律法规要求或安全事件处置需要而提供的除外。',
  '',
  '九、你的权利',
  '· 查看：在「账号信息 / 签到记录 / 申诉 / 反馈工单」中查看你自己的数据；',
  '· 更正：邮箱可自助更新；姓名、学号、身份由相应管理员维护，如需更正请提交工单或联系相应管理员；',
  '· 管理：随时调整通知渠道偏好、定位上传授权、修改密码、结束不再使用的设备会话；',
  '· 撤回同意：取消定位上传授权即停止采集位置；',
  '· 注销：在「账号安全」中申请注销账号（作隐藏处理）；账号注销后相关信息的删除或继续留存，按部署方公示的保存规则执行（详见第八条）。',
  '· 联系：通过系统内「反馈网站问题」联系运维者；涉及考勤记录更正的，联系班级管理员。',
  '',
  '十、未成年人保护',
  '· 若你未满 18 周岁，请在监护人知情并同意后阅读本政策并使用本系统。',
  '',
  '十一、开源与权利',
  '· 本软件以 MIT 协议开源发布（见仓库根目录 LICENSE 文件），任何人可自由使用、复制、修改、合并、再分发（含商业用途），并可在保留版权与许可声明的前提下进行二次开发；软件著作权人不为本软件提供任何明示或默示担保，亦不对使用本软件产生的任何后果承担责任。',
  '· 本软件按「现状」提供。考勤、请假、补签与统计数据仅供部署方内部参考，其认定以部署方所在单位或组织的规定为准。',
  '',
  '十二、政策更新与生效',
  '· 本政策更新后会在系统内通知，并按内容变更要求你重新阅读并确认，之后继续使用即视为接受更新后的政策。',
  '· 本政策自 2026 年 10 月 13 日起生效。勾选「我已阅读并同意《隐私政策》」并完成注册，即表示你已完整阅读、理解并接受本政策全部内容。',
  '',
  '软件著作权人：余子晨（Yushichadao）',
  '2026 年 10 月 13 日'
].join('\n');

function privacyText() {
  return get('privacy_text') || '';
}

/** 隐私文案：优先使用管理员设置，未设置时返回内置默认文案 */
function privacyTextOrDefault() {
  return privacyText() || DEFAULT_PRIVACY;
}

function setPrivacyText(text) { set('privacy_text', String(text || '')); }

function announcementText() {
  return get('announcement_text') || '';
}
function setAnnouncementText(text) { set('announcement_text', String(text || '')); }
function announcementUpdatedAt() { return get('announcement_updated_at') || null; }

/* ---------------- 班级级系统设置的「最后修改者」追踪 ----------------
 * 上级（辅导员 / 小班主任）可能后到岗：此时班上的班级级设置往往是由代管期间的班委留下的。
 * 记录最后修改者，供「到岗后确认沿用 / 恢复默认」的提示与操作使用。
 */
function markSysEditor(user) {
  if (!user || !user.id) return;
  set('sys_editor_id', String(user.id));
  set('sys_editor_at', String(Date.now()));
}

/** 当前查看者层级（兼容 role_level 缺失的历史账号） */
function levelOf(user) {
  if (!user) return -1;
  if (user.role_level !== null && user.role_level !== undefined) return Number(user.role_level);
  try { return Number(require('./auth').userLevel(user)); } catch (e) { return -1; }
}

/**
 * 班级级设置的最后修改者信息 + 当前查看者是否需要确认沿用。
 * need_confirm = 查看者层级更高（新上级到岗），或原设置者已不在岗（未激活 / 已注销 / 已禁用）。
 */
function sysEditor(viewer) {
  const id = String(get('sys_editor_id') || '');
  const at = Number(get('sys_editor_at')) || null;
  if (!id) return { id: null, name: null, role_title: null, at: null, level: null, off_duty: false, need_confirm: false };
  const row = db.prepare('SELECT id, real_name, role_title, role_level, disabled, status, password_hash FROM users WHERE id = ?').get(id);
  if (!row) return { id: null, name: null, role_title: null, at, level: null, off_duty: true, need_confirm: true };
  const offDuty = !!row.disabled || String(row.status) === 'cancelled' || !row.password_hash;
  const lv = levelOf(row);
  return {
    id: row.id, name: row.real_name, role_title: row.role_title, at, level: lv, off_duty: offDuty,
    need_confirm: levelOf(viewer) > lv || offDuty
  };
}

/** 恢复班级级系统设置为出厂默认：仅运维者 / 持 SYS_SETTINGS 者可用，运维者专属键与迁移标记保留 */
function resetSysSettings(user) {
  const keep = new Set([
    'rbac_clean_v1', 'user_id_text_v1',                 // 迁移标记
    'auto_cover_enabled', 'auto_cover_updated_at',      // 仅运维者
    'manager_location_view', 'dataflow_mask',           // 仅运维者
    'maintenance_enabled', 'maintenance_start_at', 'maintenance_end_at', 'maintenance_notice',
    'privacy_text', 'privacy_updated_at',
    'announcement_text', 'announcement_updated_at',
    'sys_editor_id', 'sys_editor_at'
  ]);
  db.transaction(() => {
    db.prepare('SELECT key FROM settings').all().forEach(r => {
      if (!keep.has(r.key)) db.prepare('DELETE FROM settings WHERE key = ?').run(r.key);
    });
  })();
  markSysEditor(user);
}

module.exports = {
  get, getBool, set, all, DEFAULTS, BOOL_KEYS,
  notifyKey, notifyEnabled, notifyPrefs, setNotifyPref, NOTIFY_PREFS,
  userNotifyChannel, setUserNotifyPref, userNotifyPrefs, NOTIFY_CAT_NAME, CHANNELS,
  locationVerifyEnabled, setLocationVerify,
  autoCoverEnabled, setAutoCover,
  maintenanceEnabled, setMaintenance, maintenanceInfo, setMaintenanceWindow, setMaintenanceNotice,
  privacyText, privacyTextOrDefault, setPrivacyText, DEFAULT_PRIVACY,
  announcementText, setAnnouncementText, announcementUpdatedAt,
  markSysEditor, sysEditor, resetSysSettings
};
