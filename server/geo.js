'use strict';
const { FENCE_MAX_ACCURACY } = require('./config');

const PI = Math.PI;
const AXIS = 6378245.0;          // 克拉索夫斯基椭球长半轴
const ECC = 0.00669342162296594323;

/* ===================== 坐标系转换（防严重偏移的核心） ===================== */

function outOfChina(lng, lat) {
  return (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271);
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

/** WGS-84（GPS/多数浏览器） -> GCJ-02（火星坐标，国内地图） */
function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - ECC * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((AXIS * (1 - ECC)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180.0) / (AXIS / sqrtMagic * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

/** GCJ-02 -> WGS-84（迭代反解，3 次足够收敛到厘米级） */
function gcj02ToWgs84(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  let wlng = lng;
  let wlat = lat;
  for (let i = 0; i < 3; i++) {
    const g = wgs84ToGcj02(wlng, wlat);
    wlng += (lng - g[0]);
    wlat += (lat - g[1]);
  }
  return [wlng, wlat];
}

/* ===================== 几何计算 ===================== */

/** 射线法：点是否落在多边形内 */
function pointInPolygon(lng, lat, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function metersPerDegree(latRef) {
  return {
    lng: 111320 * Math.cos(latRef * PI / 180),
    lat: 110540
  };
}

/** 点到线段的距离（米） */
function pointToSegmentM(px, py, x1, y1, x2, y2) {
  const m = metersPerDegree(py);
  const ax = (px - x1) * m.lng;
  const ay = (py - y1) * m.lat;
  const bx = (x2 - x1) * m.lng;
  const by = (y2 - y1) * m.lat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.sqrt(ax * ax + ay * ay);
  let t = (ax * bx + ay * by) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = ax - t * bx;
  const dy = ay - t * by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 点到多边形的距离（米），在多边形内返回 0 */
function distanceToPolygonM(lng, lat, points) {
  if (pointInPolygon(lng, lat, points)) return 0;
  let min = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const d = pointToSegmentM(lng, lat, points[j][0], points[j][1], points[i][0], points[i][1]);
    if (d < min) min = d;
  }
  return min;
}

/* ===================== 活动范围判定（严格按绘制边界） ===================== */

/**
 * 严格判定：
 * 1) 依次尝试设备原始坐标、WGS-84→GCJ-02、GCJ-02→WGS-84 三种结果，任一落在活动范围多边形内即视为在活动范围内；
 * 2) 活动范围按绘制边界严格判定：不叠加任何定位精度补偿（缓冲由管理员画活动范围时主动往外预留）；
 * 3) 定位精度过差时由调用方直接拒绝，避免严重偏移导致误判。
 *
 * @returns {{inside:boolean, distance:number, matched:string}}
 */
/** 点是否落在任意一个多边形内（围栏可含多个范围，取并集） */
function pointInAnyPolygon(lng, lat, polygons) {
  for (const poly of polygons) {
    if (poly.length >= 3 && pointInPolygon(lng, lat, poly)) return true;
  }
  return false;
}

/** 点到一组多边形的最近距离（米），在任一多边形内返回 0 */
function minDistanceToPolygons(lng, lat, polygons) {
  let min = Infinity;
  for (const poly of polygons) {
    if (poly.length < 3) continue;
    const d = distanceToPolygonM(lng, lat, poly);
    if (d < min) min = d;
  }
  return min;
}

/**
 * 把一个围栏的 points_json 解析为「多多边形数组」并兼容旧单多边形格式。
 * 新格式：[[[lng,lat],...], [[lng,lat],...]]（一个围栏含多个范围）
 * 旧格式：[[lng,lat],...]（单多边形）→ 自动包裹为单元素数组
 */
/** 判断是否为「单个点」：数组数值对 [lng,lat] 或 {lat,lng} 对象 */
function isPoint(x) {
  if (Array.isArray(x) && x.length >= 2 && x.every(n => typeof n === 'number')) return true;
  if (x && typeof x === 'object' && (x.lat != null || x.lng != null)) return true;
  return false;
}

function parseFencePolygons(pointsJson) {
  let polys = [];
  try { polys = JSON.parse(pointsJson || '[]'); } catch (e) { polys = []; }
  if (!Array.isArray(polys)) polys = [];
  if (polys.length && isPoint(polys[0])) {
    polys = [polys]; // 旧单多边形兼容
  }
  const normPt = (p) => {
    let lng, lat;
    if (Array.isArray(p)) { lng = Number(p[0]); lat = Number(p[1]); }
    else if (p && typeof p === 'object') {
      if (p.lng != null && p.lat != null) { lng = Number(p.lng); lat = Number(p.lat); }
      else if (p[0] != null && p[1] != null) { lng = Number(p[0]); lat = Number(p[1]); }
    }
    if (lng == null || lat == null || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return [lng, lat];
  };
  return polys
    .map(poly => (Array.isArray(poly) ? poly.map(normPt).filter(Boolean) : []))
    .filter(poly => poly.length >= 3);
}

function evaluateFence(opts) {
  const fence = opts.fence || {};
  const lat = Number(opts.lat);
  const lng = Number(opts.lng);

  const polys = parseFencePolygons(fence.points_json);
  if (!polys.length) return { inside: false, distance: -1, matched: 'no-fence' };

  const ox = Number(fence.offset_lng) || 0;
  const oy = Number(fence.offset_lat) || 0;
  const applied = polys.map(poly => poly.map(p => [Number(p[0]) + ox, Number(p[1]) + oy]));

  const w2g = wgs84ToGcj02(lng, lat);
  const g2w = gcj02ToWgs84(lng, lat);
  const candidates = [
    { sys: 'reported', lng: lng + ox, lat: lat + oy },
    { sys: 'wgs84->gcj02', lng: w2g[0] + ox, lat: w2g[1] + oy },
    { sys: 'gcj02->wgs84', lng: g2w[0] + ox, lat: g2w[1] + oy }
  ];

  for (const c of candidates) {
    if (pointInAnyPolygon(c.lng, c.lat, applied)) {
      return { inside: true, distance: 0, matched: c.sys };
    }
  }

  let best = { distance: Infinity, sys: candidates[0].sys };
  candidates.forEach(c => {
    const d = minDistanceToPolygons(c.lng, c.lat, applied);
    if (d < best.distance) best = { distance: d, sys: c.sys };
  });

  // 严格判定：按绘制边界判定，落在边界上（距离恰为 0）视为在内
  return {
    inside: best.distance <= 0,
    distance: Math.round(best.distance),
    matched: best.sys
  };
}

/**
 * 最终生效状态（活动结束后才做换算）：
 *  · 一直在「在途中」→ 缺勤；
 *  · 请假申请：
 *      - 已批准（approved）→ 请假（正常请假 / 事后请假 通用）；
 *      - 正常请假（窗口关闭前提交）：待审核 / 未回应（pending）同样按「请假」占位；
 *      - 事后请假（申诉，is_appeal=1）：待审核 / 未回应（pending）视作缺勤，唯有批准才计请假 ——
 *        与“窗口关闭前”规则不同，避免“提交即请假”；
 *      - 已驳回（rejected）→ 缺勤（两类请假一致）；
 *  · 退签（cancelled）等价于「无有效签到」：活动期间（含开始前）按「待签到」、活动结束后按「缺勤」；
 *  · 未做任何选择（无记录，status=null）且未提交请假 → 活动期间「待签到」、结束后「缺勤」；
 *  · 其余（已签到 / 请假）保持原状态。
 * 说明：「待签到」「在途中」只在活动期间及之前存在；活动一结束二者自动归类为「缺勤」。
 * @param {string|null} status        签到状态 signed / ontheway / leave / absent / cancelled / null
 * @param {number} endTime            活动结束时间
 * @param {string} [leaveStatus]      关联的请假申请状态 pending / approved / rejected
 * @param {boolean} [leaveAppeal]     该请假是否为「事后请假」申诉（提交时未预置请假占位）
 * @returns {'signed'|'ontheway'|'leave'|'absent'|'pending'}
 */
function effectiveStatus(status, endTime, leaveStatus, leaveAppeal) {
  const ended = Number(endTime) && Date.now() > Number(endTime);
  // 退签等同无有效签到记录
  if (status === 'cancelled') status = null;
  const leaveApproved = leaveStatus === 'approved';
  // 已批准 → 请假（正常 / 申诉通用）
  if (leaveApproved && (status === 'leave' || (ended && !status))) return 'leave';
  // 正常请假（非申诉）：待审核 / 未回应 仍按「请假」占位（窗口关闭前规则）
  if (!leaveAppeal && leaveStatus && leaveStatus !== 'rejected' && (status === 'leave' || (ended && !status))) return 'leave';
  // 无记录 / 退签：结束前=待签到，结束后=缺勤
  if (!status) return ended ? 'absent' : 'pending';
  // 活动未结束：原样展示（已签到 / 在途中 / 请假）
  if (!ended) return status;
  if (status === 'ontheway') return 'absent';
  return status;
}

/* ===================== 签到窗口（服务端唯一信任源） ===================== */
const MIN = 60 * 1000;

function checkinWindow(activity) {
  const start = activity.start_time;
  const end = activity.end_time;
  const offset = (Number(activity.offset_minutes) || 0) * MIN;
  if (activity.policy === 'before_start') {
    // 签到截止至活动开始：默认提前 120 分钟可签
    return { open: start - (offset || 120 * MIN), close: start };
  }
  // before_end：开放时间统一应用「提前开放」偏移（此前 before_end 忽略该值，
  // 导致窗口恰好等于活动时间 —— 即「签到窗口显示出活动时间」的异常）
  return { open: start - offset, close: end };
}

function windowText(activity) {
  const w = checkinWindow(activity);
  // 精确到「分」（不含秒），便于阅读与核对签到窗口
  const p = (n) => String(n).padStart(2, '0');
  const f = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return `${f(w.open)} ~ ${f(w.close)}`;
}

function policyText(policy, offsetMinutes) {
  const off = Number(offsetMinutes) || 0;
  if (policy === 'before_start') return `签到截止至活动开始（提前${off || 120}分钟可签）`;
  if (policy === 'before_end') {
    return off > 0
      ? `签到截止至活动结束（提前${off}分钟可签）`
      : '签到截止至活动结束';
  }
  return '签到截止至活动结束';
}

module.exports = {
  pointInPolygon, distanceToPolygonM,
  wgs84ToGcj02, gcj02ToWgs84,
  evaluateFence, FENCE_MAX_ACCURACY, effectiveStatus,
  checkinWindow, windowText, policyText, MIN
};
