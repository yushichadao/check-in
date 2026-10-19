'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const secret = require('./secret');

try { require('dotenv').config(); } catch (e) { /* dotenv 可选 */ }

/* ===================== 内置默认配置（零配置直接上传即可运行） =====================
 * 下面就是「不写任何 .env 也能跑」的内置默认值——把整个项目上传到服务器后
 * 直接 `npm ci --omit=dev && npm start` 即可使用。
 * 需要覆盖任何一项时，在项目根目录放一个 .env（格式见 .env.example）即可，
 * 环境变量优先级最高，且 .env 不会被提交到仓库。
 * ----------------------------------------------------------------------------- */
const DEFAULTS = {
  PORT: '3000',
  NODE_ENV: 'production',
  TRUST_PROXY: '1',        // 位于 Nginx / Caddy 之后：1；直接对外暴露 IP：0
  COOKIE_SECURE: 'true',   // 默认仅走 HTTPS 传输 Cookie；auth.js 仅在 req.secure（TLS）时真正加 Secure 标记，纯 http 直连不受影响
  // HTTPS（可选）：留空证书路径则纯 HTTP 运行；配置 SSL_CERT/SSL_KEY 且文件存在即自动启用 HTTPS 监听
  HTTPS_PORT: '3443',      // HTTPS 监听端口（避开 443 以免需 root 权限）
  HTTPS_ONLY: 'false',     // true=仅 HTTPS（关闭 HTTP 监听），并强制 Cookie Secure
  REDIRECT_HTTP_TO_HTTPS: 'false', // true=保留 HTTP 但 301 跳转到 HTTPS，并强制 Cookie Secure
  SSL_CERT: '',            // 证书 fullchain 路径（PEM）
  SSL_KEY: '',             // 私钥路径（PEM）
  SSL_CA: '',              // 可选：证书链
  BASE_PATH: '/check-in',  // 子路径部署（https://域名/check-in）；部署在域名根目录请设为空
  TOKEN_TTL: '2h',
  WO_TIMEOUT_HOURS: '48',
  DB_DIR: ''               // 空 = 使用项目内 ./data
};

/** 读取环境变量；未设置或为空字符串时回落到内置默认值 */
function env(key, fallback) {
  const v = process.env[key];
  return (v === undefined || v === '') ? fallback : v;
}

/** 与 env 相同，但允许显式传空字符串（如 BASE_PATH= 表示部署在根目录） */
function envRaw(key, fallback) {
  const v = process.env[key];
  return v === undefined ? fallback : v;
}

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = env('DB_DIR', DEFAULTS.DB_DIR)
  ? path.resolve(env('DB_DIR', DEFAULTS.DB_DIR))
  : path.join(ROOT, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * JWT 密钥：优先环境变量；否则在 data 目录生成并持久化一个随机密钥，
 * 保证重启后已签发的令牌仍有效，同时避免把密钥写进代码库。
 */
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, '.jwt-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  try { fs.writeFileSync(file, secret, { mode: 0o600 }); } catch (e) { /* 忽略 Windows 权限位 */ }
  return secret;
}

/** 子路径部署前缀：如 BASE_PATH=/check-in，则访问 https://域名/check-in */
function normalizeBase(p) {
  if (!p) return '';
  let s = String(p).trim();
  if (s === '/') return '';
  if (!s.startsWith('/')) s = '/' + s;
  return s.replace(/\/+$/, '');
}

/* ===================== 三层命名（勿混用） =====================
 * ① 商品名（品牌）：PRODUCT_NAME = 班级签到系统 —— 代码固定的品牌，任何端都不可改；
 * ② 班级名      ：GROUP_NAME —— 运维者配置（如 通信工程2607班），作为副标题 / 字段；
 * ③ 系统全称    ：SYSTEM_NAME —— 本班这套系统的完整称呼（如 通信工程2607班签到系统）。
 *    优先取环境变量 SYSTEM_NAME；未设置时由 ② + ① 自动拼接（班级名已含商品名、
 *    或已以「系统」结尾时不重复拼接）。班级名未配置时运维者无法登录、注册发码也被拦截，
 *    即「可用系统里班级名必然已配置」，此处仅回退为商品名兜底。
 * 注：SMTP 发件人的**显示名**固定为 ① 品牌（见 mailer.js systemFrom()），不随 ③ 变化。
 */
const PRODUCT_NAME = '班级签到系统';
/** 商品名去掉「班级」后的后缀：班级名已以「班 / 班级」结尾时用它拼接，避免出现「X班班级签到系统」 */
const PRODUCT_SUFFIX = PRODUCT_NAME.replace(/^班级/, ''); // 签到系统

/**
 * 由「班级名 + 商品名」推导系统全称（纯函数：TUI 未落盘时也能预览草稿值）。
 * @param {string} clsName 班级名（GROUP_NAME）
 * @param {string} [customName] 显式指定的系统全称（SYSTEM_NAME），非空则直接采用
 */
function composeSystemName(clsName, customName) {
  const custom = String(customName || '').trim();
  if (custom) return custom;
  const cls = String(clsName || '').trim();
  if (!cls) return PRODUCT_NAME;
  if (cls.endsWith(PRODUCT_NAME) || cls.endsWith('系统')) return cls;
  // 班级名已带「班 / 班级 / 年级」等集体后缀时只接「签到系统」：通信工程2607班 → 通信工程2607班签到系统
  if (/(班|班级|年级|专业|学院|系)$/.test(cls)) return cls + PRODUCT_SUFFIX;
  return cls + PRODUCT_NAME;
}

function systemName() {
  return composeSystemName(env('GROUP_NAME', ''), env('SYSTEM_NAME', ''));
}

const SYSTEM_NAME = systemName();

/** 班级名称（GROUP_NAME）是否已配置：未配置时拦截发码、运维者登录需先配置 */
function isGroupNameConfigured() {
  const v = env('GROUP_NAME', '');
  return !!(v && String(v).trim());
}

/* ===================== RBAC 角色层级与权限码表 ===================== */

/** 角色等级：数字越大层级越高。运维者独立隔离（9），不参与业务授权链 */
const ROLE_LEVEL = { student: 0, cadre: 1, assistant: 2, counselor: 3, ops: 9 };

/** 身份（下拉展示名）→ 等级。原「班长 / 学委」合并为单一「班委」 */
const IDENTITY_LEVEL = {
  '普通学生': ROLE_LEVEL.student,
  '班委': ROLE_LEVEL.cadre,
  '小班主任': ROLE_LEVEL.assistant,
  '辅导员': ROLE_LEVEL.counselor,
  '运维者': ROLE_LEVEL.ops
};

/** 等级 → 数据库 role 粗粒度角色（保持与既有代码兼容） */
function roleOfLevel(level) {
  const n = Number(level) || 0;
  if (n >= ROLE_LEVEL.ops) return 'ops';
  if (n >= ROLE_LEVEL.cadre) return 'manager';
  return 'normal';
}

/** 等级 → 身份展示名 */
function identityOfLevel(level) {
  const n = Number(level) || 0;
  const hit = Object.keys(IDENTITY_LEVEL).find(k => IDENTITY_LEVEL[k] === n);
  return hit || '普通学生';
}

/** 由「粗粒度 role + role_title」推导等级（历史账号无 role_level 时兜底；角色等级唯一事实源） */
function roleLevelFromTitle(role, roleTitle) {
  if (role === 'ops') return ROLE_LEVEL.ops;
  if (role === 'manager') {
    if (roleTitle === '辅导员') return ROLE_LEVEL.counselor;
    if (roleTitle === '小班主任') return ROLE_LEVEL.assistant;
    return ROLE_LEVEL.cadre;
  }
  return ROLE_LEVEL.student;
}

/**
 * 权限码表。
 *  min    ：角色基线最低持有等级（role_level >= min 即天然持有，不可撤回）
 *  type   ：regular=常规（角色基线）| high_risk=高危（需工单/授权下放）|
 *           inherent=固有（普通学生固有能力，min=0）| isolated=运维者隔离 | denied=全部拒绝
 */
const PERMS = {
  /* 活动范围（原「电子围栏」已更名，下文统一称活动范围）
   *  - 画 / 改 / 删活动范围（FENCE_DRAW）、地图查看（FENCE_VIEW_MAP）、画目的地点（FENCE_POINT）
   *    均为管理员基线能力（regular，min=1）：运维者与管理端角色天然可操作，无需单独权限。
   *  - 启动活动范围核验（FENCE_VERIFY = 让用户端上传定位）才是真正的「权限」：
   *    高危（high_risk），基线仅 辅导员 R3 及以上（含运维者）可行使；
   *    缺辅导员时由「自动代管」下放至小班主任 / 班委（见 server/autocover.js，权限落在 r3 覆盖集）。
   *    绑定活动范围到活动属管理员基线能力，无需此权限；只有「启用让用户端上传定位核验」才受本权限 + 定位核验总开关约束。 */
  FENCE_DRAW: { min: 1, type: 'regular', name: '画/改/删活动范围（本人添加的）' },
  FENCE_POINT: { min: 1, type: 'regular', name: '画目的地点图标' },
  FENCE_VERIFY: { min: 3, type: 'high_risk', name: '启动活动范围核验（让用户端上传定位）' },
  FENCE_VIEW_MAP: { min: 1, type: 'regular', name: '地图查看活动范围' },
  /* 查看 */
  VIEW_COORD: { min: null, type: 'denied', name: '查看原始定位（始终禁用，不可授予）' },
  VIEW_CHECKIN: { min: 1, type: 'regular', name: '查看签到明细' },
  // 查看学生定位：运维者默认持有（基线）；管理端须由辅导员及以上层级授予，且受运维者全局开关约束
  VIEW_STUDENT_LOCATION: { min: ROLE_LEVEL.ops, type: 'regular', name: '查看学生定位', grant_min_level: ROLE_LEVEL.counselor },
  VIEW_STATS: { min: 1, type: 'regular', name: '统计报表' },
  VIEW_AUDIT: { min: 2, type: 'high_risk', name: '查看审计日志' },
  VIEW_DATAFLOW: { min: 2, type: 'regular', name: '查看数据流（审计留痕）' },
  /* 活动 */
  ACT_CREATE: { min: 1, type: 'regular', name: '创建活动（含地点文本）' },
  ACT_MANAGE: { min: 1, type: 'regular', name: '改活动（本人创建的）' },
  ACT_DELETE: { min: 3, type: 'high_risk', name: '删除活动（含批量/子项/长期任务，高危）' },
  ACT_RECURRING: { min: 1, type: 'regular', name: '循环/活动' },
  /* 审核 */
  ADJ_INITIAL: { min: 1, type: 'regular', name: '请假/补签初步裁决' },
  ADJ_FINAL: { min: 2, type: 'high_risk', name: '终审 / 覆盖' },
  /* 授权 */
  AUTH_GRANT: { min: 2, type: 'high_risk', name: '向下授权' },
  AUTH_APPROVE_WO: { min: 3, type: 'high_risk', name: '工单邮件审批' },
  AUTH_ACCOUNT: { min: 2, type: 'high_risk', name: '账号管理（含清除密码）' },
  // 隐私告知文案：仅运维者可编辑，绝不向下发放（孤立权限，不可基线持有/工单申请/授权下放）
  AUTH_PRIVACY: { min: 9, type: 'isolated', name: '隐私告知文案（仅运维者）' },
  /* 系统 */
  // 维护模式开关：仅运维者可操作（开启/结束），绝不向下发放（孤立权限）
  SYS_MAINTENANCE: { min: 9, type: 'isolated', name: '维护模式开关（仅运维者）' },
  SYS_SETTINGS: { min: 2, type: 'high_risk', name: '系统设置' }
};

/** 普通学生固有能力（R0 天然持有，不参与配置，用于触发下→上工单等） */
const STUDENT_PERMS = {
  STU_SELF: { min: 0, type: 'inherent', name: '查看本人信息' },
  STU_JOIN_LOC: { min: 0, type: 'inherent', name: '参与定位签到' },
  STU_APPEAL: { min: 0, type: 'inherent', name: '提交申诉（请假/补签）' },
  STU_OWN_ACT: { min: 0, type: 'inherent', name: '查看本人签到记录' },
  STU_PRIVACY: { min: 0, type: 'inherent', name: '隐私偏好' },
  STU_DEVICE: { min: 0, type: 'inherent', name: '设备与会话管理' },
  STU_NOTIFY: { min: 0, type: 'inherent', name: '接收提醒' }
};

/** 运维者隔离能力（level 9，独立隔离，不参与业务授权） */
const OPS_PERMS = {
  OPS_ACCOUNT: { min: 9, type: 'isolated', name: '运维账号管理' },
  OPS_AUDIT_STREAM: { min: 9, type: 'isolated', name: '审计流' },
  OPS_MAINTENANCE: { min: 9, type: 'isolated', name: '维护兜底' },
  OPS_DEPLOY: { min: 9, type: 'isolated', name: '部署' },
  OPS_VERSION: { min: 9, type: 'isolated', name: '版本' },
  OPS_DEVICES: { min: 9, type: 'isolated', name: '设备管理' },
  OPS_EXPORT: { min: 9, type: 'isolated', name: '导出' }
};

/** 全部权限码（合并） */
const ALL_PERMS = Object.assign({}, PERMS, STUDENT_PERMS, OPS_PERMS);

/**
 * 通知/提醒偏好。
 *  mandatory=true 为「必提醒」，界面开关置灰禁用、恒为开、不可取消。
 *  min_level 为「可配置该提醒的最低角色等级」（1=班委：经自动代管/向下授权取得 SYS_SETTINGS 后亦可调；2=小班主任；3=辅导员）。
 *  student_only=true 表示「仅普通学生会收到」：活动与签到类提醒的收件人恒为普通学生，
 *  管理端 / 运维端收不到，故其个人偏好面板中直接隐藏，避免出现「设了也永远收不到」的无效项。
 */
const NOTIFY_PREFS = {
  NT_ACT_CREATE: { name: '活动创建提醒', mandatory: false, min_level: 1, student_only: true },
  NT_CHECKIN_START: { name: '签到开始提醒', mandatory: false, min_level: 1, student_only: true },
  NT_REMINDER_60: { name: '活动前 60 分钟提醒', mandatory: false, min_level: 1, student_only: true },
  NT_REMINDER_30: { name: '活动前 30 分钟提醒', mandatory: false, min_level: 1, student_only: true },
  NT_REMINDER_10: { name: '活动前 10 分钟提醒', mandatory: false, min_level: 1, student_only: true },
  NT_REMINDER_5: { name: '活动前 5 分钟提醒', mandatory: false, min_level: 1, student_only: true },
  NT_ACT_START: { name: '活动开始提醒', mandatory: false, min_level: 1, student_only: true },
  NT_NOT_CHECKED: { name: '缺勤提醒', mandatory: false, min_level: 1, student_only: true },
  NT_RETURN: { name: '退回提醒（裁决退回）', mandatory: false, min_level: 1, student_only: true },
  NT_RECEIPT: { name: '回执提醒（核验/补签完成）', mandatory: false, min_level: 1, student_only: true },
  NT_WO_REPLY: { name: '工单回复提醒', mandatory: true, min_level: 3 },
  NT_SYS_MSG: { name: '系统消息', mandatory: true, min_level: 3 }
};

/**
 * 某类提醒对该账号是否「有意义」（应在个人通知偏好面板中展示）。
 * 活动与签到类提醒的收件人恒为普通学生（见 notify.js）：管理端 / 运维端收不到，
 * 因此对其隐藏——避免出现「设置了却永远收不到」的无效选项。
 */
function notifyPrefVisible(kind, user) {
  const def = NOTIFY_PREFS[kind];
  if (!def || !def.student_only) return true;      // 非学生专属：所有人都有意义
  if (!user) return true;                          // 未知角色：保守不隐藏
  return String(user.role) === 'normal';           // 仅普通学生会收到
}

/** 定位核验总开关默认值：默认关闭；需 FENCE_VERIFY（基线辅导员 R3+，缺辅导员时由自动代管下放）方可开启 */
const LOCATION_VERIFY_DEFAULT = false;

/** 定位模式（互斥二选一） */
const LOCATION_MODES = { ONLY_ENDPOINT: 'only_endpoint', USE_FENCE: 'use_fence' };

/** 工单自动超时（小时）：超时后自动驳回并发邮件 */
const WO_TIMEOUT_HOURS = Number(env('WO_TIMEOUT_HOURS', DEFAULTS.WO_TIMEOUT_HOURS));

module.exports = {
  ROOT,
  DATA_DIR,
  DEFAULTS,
  BASE_PATH: normalizeBase(envRaw('BASE_PATH', DEFAULTS.BASE_PATH)),
  PORT: Number(env('PORT', DEFAULTS.PORT)),
  DB_PATH: env('DB_PATH', path.join(DATA_DIR, 'app.db')),
  JWT_SECRET: loadSecret(),
  TOKEN_TTL: env('TOKEN_TTL', DEFAULTS.TOKEN_TTL),
  NODE_ENV: env('NODE_ENV', DEFAULTS.NODE_ENV),
  // 注意：必须转成「数值」再交给 app.set('trust proxy', ...)。
  // Express 对字符串按「可信 IP / 子网列表」解析，'1' 既不是 IP 也不是子网 → 实际不信任任何代理，
  // 造成 X-Forwarded-For 被忽略、req.ip 恒为直连地址（反代部署下全站共用一个限流桶、异地登录判定失效）。
  TRUST_PROXY: (() => {
    const v = String(env('TRUST_PROXY', DEFAULTS.TRUST_PROXY));
    return /^\d+$/.test(v) ? Number(v) : v;
  })(),
  COOKIE_SECURE: String(env('COOKIE_SECURE', DEFAULTS.COOKIE_SECURE)) === 'true',

  // HTTPS（可选，零配置默认不启用）
  HTTPS_PORT: Number(env('HTTPS_PORT', DEFAULTS.HTTPS_PORT)),
  HTTPS_ONLY: String(env('HTTPS_ONLY', DEFAULTS.HTTPS_ONLY)) === 'true',
  REDIRECT_HTTP_TO_HTTPS: String(env('REDIRECT_HTTP_TO_HTTPS', DEFAULTS.REDIRECT_HTTP_TO_HTTPS)) === 'true',
  SSL_CERT: env('SSL_CERT', DEFAULTS.SSL_CERT),
  SSL_KEY: env('SSL_KEY', DEFAULTS.SSL_KEY),
  SSL_CA: env('SSL_CA', DEFAULTS.SSL_CA),

  // 邮件（SMTP）：用于“忘记密码”的邮箱验证码。未配置 host/user/pass 时该功能自动禁用
  MAIL: {
    host: env('SMTP_HOST', ''),
    port: Number(env('SMTP_PORT', '465')),
    secure: String(env('SMTP_SECURE', 'true')) === 'true',
    user: env('SMTP_USER', ''),
    // 授权码：终端里明文显示便于核对，但 .env 里存的是密文（见 server/secret.js），此处解密后交给发信组件
    pass: secret.decrypt(env('SMTP_PASS', '')),
    from: env('MAIL_FROM', '') || env('SMTP_USER', ''),
    subject: env('MAIL_SUBJECT', ''),
    // 正文模板，支持占位符：{code} 验证码、{minutes} 有效期分钟、{app} 系统名
    // 邮件内的「系统名」默认取系统全称（如 通信工程2607班签到系统），可用 MAIL_SYSTEM_NAME 覆盖
    text: env('MAIL_TEXT', ''),
    systemName: env('MAIL_SYSTEM_NAME', SYSTEM_NAME)
  },

  // 允许的最大定位误差（米）：精度差于此值直接拒绝签到
  FENCE_MAX_ACCURACY: Number(env('FENCE_MAX_ACCURACY', '200')),

  // 活动范围默认端点（GCJ-02）：部署相关，留空由运维者在运维端自行绘制，避免泄露原部署物理位置
  DEFAULT_FENCE: [],

  // 初始运维者账号（seed 创建，用于后续在运维端建立其他账号）
  // 注意：不再预置密码——运维者同样需要在注册页完成邮箱验证并自行设置密码后才能登录；
  // 忘记密码时可用 `npm run reset-ops` 在服务器终端重置（会同时标记为已验证，避免被验证逻辑锁死）。
  OPS_INIT: {
    real_name: env('OPS_NAME', '运维者'),
    identity: '运维者'
  },

  // 品牌名称（商品名，固定）：用于邮件落款、SMTP 发件人显示名、系统标题区；运维者/用户端不可改动
  PRODUCT_NAME,
  // 系统全称（班级名 + 商品名，可用 SYSTEM_NAME 直接指定）：标题、关于页、邮件正文系统名
  SYSTEM_NAME,
  // 班级名称：GROUP_NAME 为班级名（如 通信工程2607班），留空表示尚未配置
  GROUP_NAME: env('GROUP_NAME', ''),
  APP_VERSION: env('APP_VERSION', '1.0.0'),
  // 反馈网站问题的收件邮箱：优先环境变量；留空时回退到运维者账号登记的邮箱
  FEEDBACK_EMAIL: env('FEEDBACK_EMAIL', ''),
  // 软件作者与联系方式（显示在配置向导首页）；可用环境变量覆盖
  AUTHOR_NAME: env('AUTHOR_NAME', '余子晨'),
  AUTHOR_EMAIL: env('AUTHOR_EMAIL', 'yushichadao@qq.com'),

  /* ------------------------- RBAC ------------------------- */
  ROLE_LEVEL,
  IDENTITY_LEVEL,
  roleOfLevel,
  identityOfLevel,
  roleLevelFromTitle,
  PERMS,
  STUDENT_PERMS,
  OPS_PERMS,
  ALL_PERMS,
  NOTIFY_PREFS,
  notifyPrefVisible,
  LOCATION_VERIFY_DEFAULT,
  LOCATION_MODES,
  WO_TIMEOUT_HOURS,
  isGroupNameConfigured,
  systemName,
  composeSystemName
};
