/* ZeroTier Central API client.
 *
 * This exists for the one part of subnet routing that cannot be done from the
 * client side: adding the managed route that tells the ZeroTier network to send
 * a physical LAN's traffic to this node.  Route authority lives with whoever
 * controls the network, so we talk to ZeroTier Central over HTTPS with a token
 * the user supplies.
 *
 * Both API generations are supported, because which one works depends on how
 * the token was created:
 *   legacy  https://api.zerotier.com/api/v1       Authorization: token <t>
 *   new     https://central.zerotier.com/api/v2   Authorization: Bearer <t>
 * We simply try them in order and keep the one that answers.
 *
 * Only Node built-ins -- the package has no npm dependencies.
 *
 * Every exported function calls back as cb(err, result, notes).  notes is the
 * third argument on BOTH paths -- failure notes are the ones worth reading
 * (which endpoint was tried, what it said), so they must not be dropped just
 * because the call failed.
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_BASES = [
  { name: 'api.zerotier.com (legacy)', base: 'https://api.zerotier.com/api/v1', prefix: 'token' },
  { name: 'central.zerotier.com', base: 'https://central.zerotier.com/api/v2', prefix: 'Bearer' },
];

/* Test seam: ZT_CENTRAL_BASES="name|base|prefix;name|base|prefix" points this
 * module at a local stub so the route logic can be exercised without touching
 * a real ZeroTier account. */
function candidates(token) {
  const raw = process.env.ZT_CENTRAL_BASES;
  const spec = raw
    ? raw.split(';').filter(Boolean).map((s) => {
        const [name, base, prefix] = s.split('|');
        return { name: name || base, base: base, prefix: prefix || 'Bearer' };
      })
    : DEFAULT_BASES;
  return spec.map((b) => ({
    name: b.name,
    base: String(b.base).replace(/\/+$/, ''),
    auth: b.prefix + ' ' + token,
  }));
}

function clip(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

/* One HTTP round trip.  cb(err, status, text); status is undefined when no
 * response was received at all, which is why err is checked first. */
function request(opts, cb) {
  let u;
  try { u = new URL(opts.base + opts.path); }
  catch (e) { return cb('bad api url: ' + e.message); }

  const lib = u.protocol === 'http:' ? http : https;
  const payload = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body), 'utf8');
  const headers = { Accept: 'application/json', 'User-Agent': 'fnos-zerotier' };
  if (opts.auth) headers.Authorization = opts.auth;
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = payload.length;
  }

  let done = false;
  let killer = null;
  const finish = (err, status, text) => {
    if (done) return;
    done = true;
    if (killer) clearTimeout(killer);
    cb(err, status, text);
  };

  let pr;
  try {
    pr = lib.request(u, { method: opts.method, headers }, (res) => {
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > 4 * 1024 * 1024) { res.destroy(); return finish('response too large'); }
        chunks.push(c);
      });
      res.on('end', () => finish(null, res.statusCode, Buffer.concat(chunks).toString('utf8')));
      res.on('error', (e) => finish('response error: ' + e.message));
    });
  } catch (e) {
    // a synchronous throw here would take the whole web server down with it
    return finish('request setup failed: ' + e.message);
  }

  pr.on('error', (e) => finish('network error: ' + e.message));

  const ms = opts.timeout || 20000;
  killer = setTimeout(() => {
    try { pr.destroy(); } catch (e) { /* already gone */ }
    finish('timeout after ' + Math.round(ms / 1000) + 's');
  }, ms);
  if (killer.unref) killer.unref();

  if (payload) pr.write(payload);
  pr.end();
}

function getNetwork(api, nwid, cb) {
  request({ base: api.base, auth: api.auth, method: 'GET', path: '/network/' + nwid }, (err, status, text) => {
    if (err) return cb(err);
    if (status !== 200) return cb(api.name + ' 返回 HTTP ' + status + '：' + clip(text));
    let net;
    try { net = JSON.parse(text); }
    catch (e) { return cb(api.name + ' 返回的不是 JSON'); }
    cb(null, net);
  });
}

function pushRoutes(api, nwid, routes, cb) {
  // A partial config update is officially supported, but `routes` is a whole
  // array, so the caller always sends the complete merged list.
  request({
    base: api.base,
    auth: api.auth,
    method: 'POST',
    path: '/network/' + nwid,
    body: { config: { routes: routes } },
  }, (err, status, text) => {
    if (err) return cb(err);
    if (status !== 200 && status !== 201) {
      return cb(api.name + ' 拒绝更新（HTTP ' + status + '）：' + clip(text));
    }
    cb(null);
  });
}

function routesOf(net) {
  const cfg = (net && net.config) || {};
  if (!Array.isArray(cfg.routes)) return [];
  return cfg.routes
    .filter((r) => r && r.target)
    .map((r) => ({ target: r.target, via: r.via }));
}

/* Find which API base this token can actually use. */
function resolve(token, nwid, cb) {
  const cands = candidates(token);
  const notes = [];
  let i = 0;
  const next = () => {
    if (i >= cands.length) {
      return cb('ZeroTier Central 未接受该 API Token（两个接口都试过了）', null, notes);
    }
    const api = cands[i++];
    getNetwork(api, nwid, (err, net) => {
      if (err) { notes.push(api.name + '：' + err); return next(); }
      notes.push(api.name + '：可用');
      cb(null, { api: api, net: net }, notes);
    });
  };
  next();
}

/* Add (or repoint) a managed route.  Verifies by reading the network back, so
 * a write that silently did nothing can never be reported as success. */
function addRoute(token, nwid, target, via, cb) {
  resolve(token, nwid, (err, ok, notes) => {
    if (err) return cb(err, null, notes);
    const api = ok.api;
    const routes = routesOf(ok.net);
    const hit = routes.find((r) => r.target === target);

    if (hit && hit.via === via) {
      notes.push('托管路由 ' + target + ' → ' + via + ' 已存在');
      return cb(null, { changed: false, routes: routes }, notes);
    }
    if (hit) {
      hit.via = via;
      notes.push('把已有路由 ' + target + ' 的经由地址改为 ' + via);
    } else {
      routes.push({ target: target, via: via });
      notes.push('新增托管路由 ' + target + ' → ' + via);
    }

    pushRoutes(api, nwid, routes, (err2) => {
      if (err2) return cb(err2, null, notes);
      getNetwork(api, nwid, (err3, net2) => {
        if (err3) { notes.push('写入已发出，但回读失败：' + err3); return cb('无法确认托管路由是否生效', null, notes); }
        const back = routesOf(net2).find((r) => r.target === target);
        if (!back) return cb('写入后回读，网络上仍没有 ' + target + ' 这条路由', null, notes);
        notes.push('回读确认：' + back.target + ' → ' + back.via);
        cb(null, { changed: true, routes: routesOf(net2) }, notes);
      });
    });
  });
}

/* Drop a managed route by target.  Same read-back verification. */
function removeRoute(token, nwid, target, cb) {
  resolve(token, nwid, (err, ok, notes) => {
    if (err) return cb(err, null, notes);
    const api = ok.api;
    const all = routesOf(ok.net);
    const kept = all.filter((r) => r.target !== target);
    if (kept.length === all.length) {
      notes.push('网络上本来就没有 ' + target + ' 这条托管路由');
      return cb(null, { changed: false, routes: kept }, notes);
    }
    pushRoutes(api, nwid, kept, (err2) => {
      if (err2) return cb(err2, null, notes);
      getNetwork(api, nwid, (err3, net2) => {
        if (err3) { notes.push('写入已发出，但回读失败：' + err3); return cb('无法确认托管路由是否已移除', null, notes); }
        const still = routesOf(net2).find((r) => r.target === target);
        if (still) return cb('写入后回读，' + target + ' 这条路由仍然存在', null, notes);
        notes.push('回读确认：' + target + ' 已从托管路由中移除');
        cb(null, { changed: true, routes: routesOf(net2) }, notes);
      });
    });
  });
}

/* Read-only probe used by the status panel. */
function listRoutes(token, nwid, cb) {
  resolve(token, nwid, (err, ok, notes) => {
    if (err) return cb(err, null, notes);
    cb(null, routesOf(ok.net), notes);
  });
}

module.exports = {
  addRoute: addRoute,
  removeRoute: removeRoute,
  listRoutes: listRoutes,
  clip: clip,
};
