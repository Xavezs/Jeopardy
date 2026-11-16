// SSRF-safe HTTP(S) GET for the media proxy
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns');

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(addr, bits, 'ipv6');

function isBlockedIp(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  const family = net.isIP(address);
  if (!family) return true;
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

function guardedLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) {
      return cb(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }));
    }
    if (options.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  });
}

function assertAllowedUrl(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw httpError(400, 'URL not allowed');
  if (u.username || u.password) throw httpError(400, 'URL not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw httpError(400, 'URL not allowed');
  if (net.isIP(host) && isBlockedIp(host)) throw httpError(400, 'URL not allowed');
}

function requestOnce(u, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const req = lib.request(u, {
      method: 'GET',
      lookup: guardedLookup,
      headers: { 'user-agent': 'ClayPardy-media-proxy', accept: '*/*', 'accept-encoding': 'identity' },
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        return done(resolve, { redirect: res.headers.location, status });
      }
      if (Number(res.headers['content-length']) > maxBytes) {
        res.destroy();
        return done(reject, httpError(413, 'Media too large'));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { res.destroy(); return done(reject, httpError(413, 'Media too large')); }
        chunks.push(c);
      });
      res.on('end', () => done(resolve, { status, contentType: res.headers['content-type'] || null, buffer: Buffer.concat(chunks) }));
      res.on('error', (e) => done(reject, e));
    });
    const timer = setTimeout(() => { req.destroy(new Error('timeout')); done(reject, new Error('timeout')); }, timeoutMs);
    req.on('error', (e) => done(reject, e.code === 'EBLOCKED' ? httpError(400, 'URL not allowed') : e));
    req.end();
  });
}

async function safeFetch(rawUrl, { timeoutMs = 25000, maxBytes = 100 * 1024 * 1024, maxRedirects = 5 } = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { throw httpError(400, 'Invalid url'); }
  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertAllowedUrl(u);
    const r = await requestOnce(u, { timeoutMs, maxBytes });
    if (!r.redirect) return r;
    try { u = new URL(r.redirect, u); } catch { throw httpError(502, 'Bad redirect'); }
  }
  throw httpError(502, 'Too many redirects');
}

// The proxy only serves media
function isAllowedMediaType(contentType) {
  const t = String(contentType || '').split(';')[0].trim().toLowerCase();
  return /^(image|video|audio)\//.test(t) || ['application/octet-stream', 'application/ogg', 'binary/octet-stream'].includes(t);
}

module.exports = { safeFetch, isBlockedIp, isAllowedMediaType };
