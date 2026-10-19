'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const { recordEvent } = require('../logger');

const router = express.Router();
router.use(A.authRequired);

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

// 查看活动范围：FENCE_VIEW_MAP（班委 R1 起天然持有；普通学生无此权限）
router.use((req, res, next) => {
  if (req.method === 'GET') return A.requirePerm('FENCE_VIEW_MAP')(req, res, next);
  return A.requirePerm('FENCE_DRAW')(req, res, next);
});

const UNGROUPED = '未分组';

/** 判断是否为「单个点」：数组数值对 [lng,lat] 或 {lat,lng} 对象。用于区分「单多边形」与「多多边形」 */
function isPoint(x) {
  if (Array.isArray(x) && x.length >= 2 && x.every(n => typeof n === 'number')) return true;
  if (x && typeof x === 'object' && (x.lat != null || x.lng != null)) return true;
  return false;
}

/** 校验活动范围坐标：返回规范化后的「多多边形」数组（每个多边形 >=3 个不重复顶点）。
 *  兼容旧格式：单多边形 [[lng,lat],...] 自动包裹成 [ 多边形 ]。一个围栏可含多个范围。
 *  点既可以是 [lng,lat] 数组，也可以是 {lat,lng} 对象（旧数据 / 旧客户端）。 */
function normalizePolygons(raw) {
  let polys;
  if (Array.isArray(raw) && raw.length && isPoint(raw[0])) {
    polys = [raw]; // raw 本身是「一个多边形」
  } else {
    polys = raw;   // raw 是「多边形数组」
  }
  if (!Array.isArray(polys)) throw new Error('坐标数据格式不正确');
  const out = [];
  for (const r of polys) {
    const pts = (Array.isArray(r) ? r : [])
      .map(p => {
        let lng, lat;
        if (Array.isArray(p)) { lng = Number(p[0]); lat = Number(p[1]); }
        else if (p && typeof p === 'object') {
          // 兼容 {lat,lng} 对象写法（旧数据 / 旧客户端可能以此提交）
          if (p.lng != null && p.lat != null) { lng = Number(p.lng); lat = Number(p.lat); }
          else if (p[0] != null && p[1] != null) { lng = Number(p[0]); lat = Number(p[1]); }
        }
        if (lng == null || lat == null || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
        return [lng, lat]; // 统一为 [lng,lat]
      })
      .filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    const uniq = [];
    const seen = new Set();
    for (const p of pts) {
      const k = p[0].toFixed(7) + ',' + p[1].toFixed(7);
      if (!seen.has(k)) { seen.add(k); uniq.push(p); }
    }
    if (uniq.length < 3) throw new Error('每个活动范围至少需要 3 个不重复的顶点（封闭图形）');
    out.push(uniq);
  }
  if (!out.length) throw new Error('请至少绘制一个活动范围');
  return out;
}

function parsePoints(f, user) {
  let polys = [];
  try { polys = JSON.parse(f.points_json); } catch (e) { polys = []; }
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
  polys = polys
    .map(poly => (Array.isArray(poly) ? poly.map(normPt).filter(Boolean) : []))
    .filter(poly => poly.length >= 3);
  return Object.assign({}, f, {
    polygons: polys,
    range_count: polys.length,
    can_edit: !!user && (user.role === 'ops' || f.created_by === user.id ||
      (f.created_by === null && user.role === 'ops'))
  });
}

function allFences(user) {
  const rows = db.prepare('SELECT * FROM fences ORDER BY id').all();
  // 预取创建者（id -> {real_name, role_title}），避免每行各查一次库
  const ids = [...new Set(rows.map(f => f.created_by).filter(Boolean))];
  const creatorMap = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`SELECT id, real_name, role, role_title FROM users WHERE id IN (${ph})`)
      .all(...ids).forEach(u => { creatorMap[u.id] = u; });
  }
  return rows.map(f => {
    const d = parsePoints(f, user);
    const c = f.created_by ? creatorMap[f.created_by] : null;
    d.creator_name = c ? c.real_name : (f.created_by ? '已注销账号' : '未知');
    d.creator_role = c ? (c.role_title || c.role || '') : '';
    return d;
  });
}

/** 是否可改删该活动范围（仅本人添加的；运维者兜底） */
function canEditFence(user, fence) {
  if (!fence) return false;
  if (user.role === 'ops') return true;
  return fence.created_by === user.id;
}

/** 批次汇总：旧「同批多活动范围」概念已废弃（现一个围栏可含多个范围）。保留空实现避免调用方报错。 */
function listBatches() {
  return [];
}

/* ----------------------------- 活动范围列表 ----------------------------- */
// 不带参数时返回全部（活动发布等旧调用依赖此行为）
router.get('/', (req, res) => {
  return ok(res, { fences: allFences(req.user), batches: listBatches() });
});

/* --------------------------- 活动范围列表（分页） --------------------------- */
router.get('/paged', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(60, Math.max(1, Number(req.query.pageSize) || 6));
  const q = String(req.query.q || '').trim();
  const batch = String(req.query.batch || '').trim();   // '' 全部；'__none__' 未分组；否则为 batch_key

  let rows = allFences(req.user);
  if (q) rows = rows.filter(f => String(f.name).includes(q));
  if (batch === '__none__') rows = rows.filter(f => !f.batch_key);
  else if (batch) rows = rows.filter(f => String(f.batch_key || '') === batch);

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(page, pages);
  const items = rows.slice((cur - 1) * pageSize, cur * pageSize);

  return ok(res, { fences: items, total, page: cur, pageSize, pages, batches: listBatches() });
});

/* ----------------------------- 单条活动范围 ----------------------------- */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const f = db.prepare('SELECT * FROM fences WHERE id = ?').get(id);
  if (!f) return bad(res, '活动范围不存在', 404);
  const used = db.prepare('SELECT COUNT(*) AS c FROM activities WHERE fence_id = ?').get(id).c;
  return ok(res, { fence: parsePoints(f, req.user), used });
});

/** 批次：给定名称/键，补全另一个；同名批次自动归入同一批（同一批可含多个活动范围） */
function resolveBatch(batchKey, batchName) {
  let key = String(batchKey || '').trim();
  let name = String(batchName || '').trim();
  if (key && !name) {
    const row = db.prepare('SELECT batch_name FROM fences WHERE batch_key = ? AND batch_name IS NOT NULL LIMIT 1').get(key);
    name = (row && row.batch_name) || key;
  }
  if (!key && name) {
    const same = db.prepare('SELECT batch_key FROM fences WHERE batch_name = ? AND batch_key IS NOT NULL LIMIT 1').get(name);
    key = (same && same.batch_key) || ('FB' + Date.now() + Math.floor(Math.random() * 1000));
  }
  return { batch_key: key || null, batch_name: name || null };
}

/* ----------------------------- 新建活动范围（一个围栏可含多个多边形范围） ----------------------------- */
router.post('/', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return bad(res, '请填写活动范围名称');
  let polygons;
  try { polygons = normalizePolygons(b.points); }
  catch (e) { return bad(res, e.message); }

  // 活动范围严格按绘制边界判定，不设容差（缓冲由管理员画活动范围时主动往外预留）
  const coord = String(b.coord_system || 'GCJ-02');
  const ox = Number(b.offset_lng) || 0;
  const oy = Number(b.offset_lat) || 0;

  const info = db.prepare(`
    INSERT INTO fences (name, points_json, coord_system, offset_lng, offset_lat,
                        created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, JSON.stringify(polygons), coord, ox, oy, req.user.id, Date.now());

  recordEvent('fence_create', req.user.id, info.lastInsertRowid, name, { id: info.lastInsertRowid });
  return ok(res, {
    id: info.lastInsertRowid,
    message: '活动范围已创建'
  });
});

/* ----------------------------- 更新活动范围 ----------------------------- */
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const fence = db.prepare('SELECT * FROM fences WHERE id = ?').get(id);
  if (!fence) return bad(res, '活动范围不存在', 404);
  if (!canEditFence(req.user, fence)) {
    return bad(res, '活动范围仅可由添加者本人修改 / 删除', 403);
  }

  const b = req.body || {};
  const name = String(b.name || fence.name || '').trim() || fence.name;
  let polygons = null;
  if (b.points !== undefined) {
    try { polygons = normalizePolygons(b.points); }
    catch (e) { return bad(res, e.message); }
  }

  const coord = b.coord_system || fence.coord_system;
  const ox = b.offset_lng !== undefined ? (Number(b.offset_lng) || 0) : fence.offset_lng;
  const oy = b.offset_lat !== undefined ? (Number(b.offset_lat) || 0) : fence.offset_lat;

  db.prepare(`
    UPDATE fences SET name = ?, points_json = ?, coord_system = ?, offset_lng = ?, offset_lat = ?
    WHERE id = ?
  `).run(name, polygons ? JSON.stringify(polygons) : fence.points_json, coord, ox, oy, id);

  recordEvent('fence_update', req.user.id, id, name, {
    id,
    before: { name: fence.name, points_json: fence.points_json }
  });
  return ok(res, { message: '活动范围已更新' });
});

/* --------------------------- 批量编辑（按批） --------------------------- */
/**
 * body: { ids:[], name_prefix, name_suffix, coord_system, offset_lng, offset_lat,
 *         batch_key, batch_name, move_batch:true }
 * 只对显式传入的字段生效；用于「同一批多个活动范围」的统一修改。
 */
router.post('/bulk-update', (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return bad(res, '请选择要批量修改的活动范围');

  let rows = ids.map(id => db.prepare('SELECT * FROM fences WHERE id = ?').get(id)).filter(Boolean);
  if (!rows.length) return bad(res, '所选活动范围不存在', 404);
  // 仅本人添加的活动范围可被批量修改
  rows = rows.filter(f => canEditFence(req.user, f));
  if (!rows.length) return bad(res, '所选活动范围中没有你可修改的（仅本人添加的活动范围可改）', 403);

  const prefix = b.name_prefix !== undefined ? String(b.name_prefix) : null;
  const suffix = b.name_suffix !== undefined ? String(b.name_suffix) : null;
  const coord = ['GCJ-02', 'WGS-84'].includes(b.coord_system) ? b.coord_system : null;
  const hasOffset = b.offset_lng !== undefined || b.offset_lat !== undefined;
  const batch = (b.batch_key !== undefined || b.batch_name !== undefined)
    ? resolveBatch(b.batch_key || '', b.batch_name || '')
    : null;

  let changed = 0;
  db.transaction(() => {
    const stmt = db.prepare(`
      UPDATE fences SET name = ?, coord_system = ?, offset_lng = ?, offset_lat = ?,
                        batch_key = ?, batch_name = ?
      WHERE id = ?
    `);
    rows.forEach(f => {
      let name = f.name;
      if (prefix !== null || suffix !== null) {
        // 避免重复叠加前缀
        if (prefix !== null && prefix && !name.startsWith(prefix)) name = prefix + name;
        if (suffix !== null && suffix && !name.endsWith(suffix)) name = name + suffix;
      }
      stmt.run(
        name,
        coord || f.coord_system,
        hasOffset ? (b.offset_lng !== undefined ? (Number(b.offset_lng) || 0) : f.offset_lng) : f.offset_lng,
        hasOffset ? (b.offset_lat !== undefined ? (Number(b.offset_lat) || 0) : f.offset_lat) : f.offset_lat,
        batch ? batch.batch_key : f.batch_key,
        batch ? batch.batch_name : f.batch_name,
        f.id
      );
      changed += 1;
    });
  })();

  recordEvent('fence_bulk_update', req.user.id, null, `批量修改 ${changed} 个活动范围`);
  return ok(res, { message: `已批量修改 ${changed} 个活动范围`, changed });
});

/* ----------------------------- 批量删除 ----------------------------- */
router.post('/bulk-delete', (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return bad(res, '请选择要删除的活动范围');

  const removed = [];
  const denied = [];
  const snapshots = [];
  db.transaction(() => {
    ids.forEach(id => {
      const f = db.prepare('SELECT * FROM fences WHERE id = ?').get(id);
      if (!f) return;
      if (!canEditFence(req.user, f)) { denied.push(`${f.name}（非本人添加）`); return; }
      const used = db.prepare('SELECT COUNT(*) AS c FROM activities WHERE fence_id = ?').get(id).c;
      if (used > 0) { denied.push(`${f.name}（被 ${used} 个活动使用）`); return; }
      db.prepare('DELETE FROM fences WHERE id = ?').run(id);
      removed.push(f.name);
      snapshots.push({
        id: f.id, name: f.name, points_json: f.points_json, coord_system: f.coord_system,
        offset_lng: f.offset_lng, offset_lat: f.offset_lat,
        batch_key: f.batch_key, batch_name: f.batch_name, created_by: f.created_by, created_at: f.created_at
      });
    });
  })();

  recordEvent('fence_bulk_delete', req.user.id, null, `批量删除 ${removed.length} 个活动范围`, { fences: snapshots });
  const msg = denied.length
    ? `已删除 ${removed.length} 个；${denied.length} 个未删除：${denied.join('、')}`
    : `已删除 ${removed.length} 个活动范围`;
  return ok(res, { message: msg, removed: removed.length, denied });
});

/* ----------------------------- 删除活动范围 ----------------------------- */
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const fence = db.prepare('SELECT * FROM fences WHERE id = ?').get(id);
  if (!fence) return bad(res, '活动范围不存在', 404);
  if (!canEditFence(req.user, fence)) {
    return bad(res, '活动范围仅可由添加者本人删除', 403);
  }

  const used = db.prepare('SELECT COUNT(*) AS c FROM activities WHERE fence_id = ?').get(id).c;
  if (used > 0) {
    return bad(res, `该活动范围正被 ${used} 个活动使用，请先为这些活动更换活动范围后再删除`, 409);
  }
  db.prepare('DELETE FROM fences WHERE id = ?').run(id);
  recordEvent('fence_delete', req.user.id, id, fence.name, {
    fence: {
      id: fence.id, name: fence.name, points_json: fence.points_json,
      coord_system: fence.coord_system, offset_lng: fence.offset_lng, offset_lat: fence.offset_lat,
      batch_key: fence.batch_key, batch_name: fence.batch_name,
      created_by: fence.created_by, created_at: fence.created_at
    }
  });
  return ok(res, { message: '活动范围已删除' });
});

module.exports = router;
