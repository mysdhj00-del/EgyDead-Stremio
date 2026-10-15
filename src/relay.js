'use strict';
/**
 * Server-side playback "relay" endpoints for the CloudStream providers.
 *
 * The providers fail on the user's phone at the streaming sites' protected
 * playback steps (his network gets different responses even with browser
 * headers), while fetching from this server works. The relay performs the
 * unlock steps server-side and returns just the resulting embed / mirror /
 * final host URLs as JSON; the phone then talks only to this server for the
 * unlock and to the video hosts for playback.
 *
 * Routes (mounted by addon.js on the same port as the addon):
 *   GET /relay/egydead?url=<urlencoded EgyDead post/episode URL>
 *   GET /relay/animezid?vid=<uniq id from watch.php?vid=>
 *   GET /relay/mycima?vid=<id from vid.mycima.cc watch.php?vid=>
 */
const cheerio = require('cheerio');
const egy = require('./egydead');


// Desktop Chrome header set used for every upstream call (verified live
// 2026-10-15: both sites gate their playback steps on browser-like requests).
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ar-EG,ar;q=0.9,en;q=0.7',
};


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}


/** Minimal host-scoped cookie jar over undici responses. */
class CookieJar {
  constructor() {
    this.entries = new Map(); // "host|name" -> { host, name, value }
  }
  store(res, url) {
    const host = hostOf(url);
    if (!host) return;
    let lines = [];
    if (typeof res.headers.getSetCookie === 'function') {
      try {
        lines = res.headers.getSetCookie() || [];
      } catch {
        lines = [];
      }
    }
    if (!lines.length) {
      const single = res.headers.get('set-cookie');
      if (single) lines = [single];
    }
    for (const line of lines) {
      const first = String(line).split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (name) this.entries.set(`${host}|${name}`, { host, name, value });
    }
  }
  headerFor(url) {
    const host = hostOf(url);
    if (!host) return '';
    const pairs = [];
    for (const e of this.entries.values()) {
      if (host === e.host || host.endsWith('.' + e.host)) pairs.push(`${e.name}=${e.value}`);
    }
    return pairs.join('; ');
  }
}


/** fetch() that reports status + final URL and can carry a CookieJar. */
async function fetchFull(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || 25000);
  try {
    const headers = { ...BROWSER_HEADERS, ...(opts.headers || {}) };
    if (opts.referer) headers.Referer = opts.referer;
    if (opts.jar) {
      const cookie = opts.jar.headerFor(url);
      if (cookie) headers.Cookie = cookie;
    }
    const res = await fetch(url, {
      method: opts.method || 'GET',
      body: opts.body,
      redirect: 'follow',
      signal: controller.signal,
      headers,
    });
    if (opts.jar) opts.jar.store(res, url);
    const text = await res.text();
    return { status: res.status, text, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}


// ---------------------------------------------------------------- EgyDead
async function relayEgyDead(targetUrl) {
  const diag = { getCode: null, postCode: null, embedCount: 0, mirrorCount: 0 };
  const jar = new CookieJar();


  // a. Warm GET (also seeds any session cookies for the POST).
  try {
    const g = await fetchFull(targetUrl, { jar, referer: egy.BASE + '/' });
    diag.getCode = g.status;
  } catch (e) {
    diag.getError = String((e && e.message) || e);
  }


  // b. POST View=1 (form-encoded) to the same URL — the watch unlock.
  let postHtml = '';
  try {
    const p = await fetchFull(targetUrl, {
      method: 'POST',
      jar,
      referer: targetUrl,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ View: '1' }).toString(),
    });
    diag.postCode = p.status;
    postHtml = p.text;
  } catch (e) {
    diag.postError = String((e && e.message) || e);
  }


  // c. Embeds from the POST response: server list data-links + player iframe.
  const embeds = [];
  const seen = new Set();
  if (postHtml) {
    const $ = cheerio.load(postHtml);
    $('.serversList li[data-link]').each((_, el) => {
      const fixed = egy.fixUrl(($(el).attr('data-link') || '').trim());
      if (fixed && !seen.has(fixed)) {
        seen.add(fixed);
        embeds.push(fixed);
      }
    });
    const iframeSrc = $('.watchAreaMaster .holder iframe').first().attr('src');
    const fixedIframe = egy.fixUrl(iframeSrc && iframeSrc.trim());
    if (fixedIframe && !seen.has(fixedIframe)) {
      seen.add(fixedIframe);
      embeds.push(fixedIframe);
    }
  }
  diag.embedCount = embeds.length;


  // d. Expand MegaMax embeds through the Inertia "streams" prop (reuses the
  // addon's verified resolver; non-Inertia embeds simply yield no mirrors).
  const mirrors = [];
  const mSeen = new Set();
  for (const embed of embeds) {
    let groups = [];
    try {
      groups = await egy.megaMaxMirrors(embed, targetUrl);
    } catch {
      groups = [];
    }
    for (const g of groups) {
      for (const m of g.mirrors || []) {
        if (m && !mSeen.has(m)) {
          mSeen.add(m);
          mirrors.push(m);
        }
      }
    }
  }
  diag.mirrorCount = mirrors.length;


  return { ok: embeds.length > 0 || mirrors.length > 0, embeds, mirrors, diag };
}


// --------------------------------------------------------------- AnimeZid
const AZ_BASE = 'https://animezid.org';
// Extractor-support order (same reasoning as the provider's v2: hosts the
// CloudStream app can actually play first; SPA shells / hang-prone last).
const AZ_PRIORITY = [
  'PlayMate',
  'DoodStream',
  'Uqload',
  'Abyss',
  'VidTube',
  'StreamP2P',
  'UPNShare',
  'RPMShare',
  'StreamRuby',
  'MegaMax',
];


async function relayAnimeZid(vid) {
  const diag = { protected: null, sourceCount: 0, perSource: {} };
  const finals = [];
  const jar = new CookieJar();
  const playUrl = `${AZ_BASE}/play.php?vid=${encodeURIComponent(vid)}`;


  // a. Play page — protected attrs live on the element carrying
  // data-playback-create-url (rendered only for browser-like requests).
  const play = await fetchFull(playUrl, {
    jar,
    referer: `${AZ_BASE}/watch.php?vid=${encodeURIComponent(vid)}`,
  });
  const $ = cheerio.load(play.text);
  const holder = $('[data-playback-create-url]').first();
  const prot = holder.attr('data-playback-protected');
  diag.protected = prot === undefined ? null : prot;
  const csrf = holder.attr('data-playback-csrf');
  let createUrl = holder.attr('data-playback-create-url');
  if (!csrf || !createUrl) {
    return { ok: false, finals, diag, error: `playback attrs missing (HTTP ${play.status})` };
  }
  createUrl = new URL(createUrl, AZ_BASE).toString().replace(/\/+$/, '');


  // b. Create the playback session. The Sec-Fetch/Origin set is required —
  // the endpoint answers 403 without it (verified live).
  const apiHeaders = {
    'X-Playback-CSRF': csrf,
    'Content-Type': 'application/json',
    Origin: AZ_BASE,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
  const sessRes = await fetchFull(createUrl, {
    method: 'POST',
    jar,
    referer: playUrl,
    headers: apiHeaders,
    body: JSON.stringify({ content_id: vid }),
  });
  let session = null;
  try {
    session = JSON.parse(sessRes.text);
  } catch {
    session = null;
  }
  if (!session || !session.session_id) {
    return { ok: false, finals, diag, error: `session create failed: HTTP ${sessRes.status}` };
  }
  const sessionId = session.session_id;


  // c. embedded_web sources in extractor-priority order, resolved one at a
  // time (the site throttles resolve calls: 201 then 429s back-to-back).
  const allSources = Array.isArray(session.sources) ? session.sources : [];
  const web = allSources.filter((s) => s && s.type === 'embedded_web');
  diag.sourceCount = web.length;
  const prio = (s) => {
    const i = AZ_PRIORITY.indexOf(s.provider || '');
    return i === -1 ? AZ_PRIORITY.length : i;
  };
  const ordered = web.slice().sort((a, b) => prio(a) - prio(b));


  let collected = 0;
  for (const src of ordered) {
    if (collected >= 3) break;
    const provider = src.provider || 'unknown';
    const resolveUrl = `${createUrl}/${sessionId}/sources/${src.id}/resolve`;


    let launchUrl = null;
    let code = null;
    for (let attempt = 0; attempt < 2 && !launchUrl; attempt++) {
      if (attempt > 0) await sleep(3000); // 429 backoff, one retry
      let r;
      try {
        r = await fetchFull(resolveUrl, {
          method: 'POST',
          jar,
          referer: playUrl,
          headers: apiHeaders,
          body: '{}',
        });
      } catch {
        code = 'error';
        continue;
      }
      code = r.status;
      if (r.status === 429 && attempt === 0) continue;
      if (r.status >= 200 && r.status < 300) {
        try {
          const j = JSON.parse(r.text);
          launchUrl = j.launch_url || j.launchUrl || j.url || null;
        } catch {
          launchUrl = null;
        }
      }
    }
    if (!launchUrl) {
      diag.perSource[provider] = code;
      continue;
    }


    // Follow the launch WITH the session cookies — without them the site
    // answers HTTP 410 and stays on animezid.org (verified live).
    let absLaunch;
    try {
      absLaunch = new URL(launchUrl, AZ_BASE).toString();
    } catch {
      diag.perSource[provider] = 'bad-launch-url';
      continue;
    }
    let finalUrl = null;
    try {
      const l = await fetchFull(absLaunch, { jar, referer: playUrl, timeout: 20000 });
      finalUrl = l.finalUrl;
    } catch {
      diag.perSource[provider] = 'launch-error';
      continue;
    }
    if (!finalUrl) {
      diag.perSource[provider] = 'launch-empty';
      continue;
    }
    diag.perSource[provider] = hostOf(finalUrl) || finalUrl;
    finals.push({ provider, url: finalUrl });


    // The CloudStream Uqload extractor doesn't know the .vc TLD; the same
    // embed path works on the canonical uqload.com host.
    try {
      const u = new URL(finalUrl);
      if (/^uqload\./i.test(u.hostname) && u.hostname.toLowerCase() !== 'uqload.com') {
        u.hostname = 'uqload.com';
        finals.push({ provider, url: u.toString() });
      }
    } catch {
      /* finalUrl already recorded */
    }
    collected++;
  }


  return { ok: finals.length > 0, finals, diag };
}


// ---------------------------------------------------------------- MyCima
const MC_BASE = 'https://vid.mycima.cc';

/**
 * MyCima (vid.mycima.cc) has no unlock/session step — the watch page's
 * play.php?vid={id} lists every server as a direct embed URL — but the
 * user's phone receives that page stripped/unreliably on some titles (the
 * same failure class as EgyDead). The relay performs the play.php fetch
 * server-side and returns the embed list; collection mirrors the provider:
 * iframes + embed anchors + a raw-URL sweep, ad/asset hosts filtered out.
 */
async function relayMyCima(vid) {
  const diag = { playCode: null, embedCount: 0 };
  const safeVid = encodeURIComponent(vid);
  const res = await fetchFull(`${MC_BASE}/play.php?vid=${safeVid}`, {
    referer: `${MC_BASE}/watch.php?vid=${safeVid}`,
    timeout: 30000,
  });
  diag.playCode = res.status;

  const embeds = [];
  const seen = new Set();
  const push = (u) => {
    const fixed = (u || '').trim();
    if (fixed.startsWith('http') && !seen.has(fixed)) {
      seen.add(fixed);
      embeds.push(fixed);
    }
  };
  const $ = cheerio.load(res.text);
  $('iframe[src]').each((_, el) => {
    const src = ($(el).attr('src') || '').trim();
    if (src.startsWith('http') && !src.includes('mycima.cc')) push(src);
  });
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (
      href.startsWith('http') &&
      !href.startsWith(MC_BASE) &&
      (href.includes('/e/') || href.includes('/embed'))
    ) {
      push(href);
    }
  });
  const sweep = res.text.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
  for (const u of sweep) {
    if (
      !u.startsWith(MC_BASE) &&
      (u.includes('/e/') || u.includes('/embed')) &&
      !u.includes('google') &&
      !u.includes('facebook') &&
      !u.includes('aglo') &&
      !u.includes('.js') &&
      !u.includes('.css') &&
      !u.includes('.png') &&
      !u.includes('.jpg')
    ) {
      push(u);
    }
  }
  diag.embedCount = embeds.length;
  return { ok: embeds.length > 0, embeds, diag };
}


// ---------------------------------------------------------------- routes
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}


/** Handles /relay/* requests; returns true when the path was a relay path. */
async function handleRelayRequest(req, res, url) {
  if (url.pathname === '/relay/egydead') {
    const target = url.searchParams.get('url');
    if (!target) {
      sendJson(res, 400, { ok: false, error: 'missing url param' });
      return true;
    }
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad url' });
      return true;
    }
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes('egydead')) {
      sendJson(res, 400, { ok: false, error: 'url must be an EgyDead http(s) URL' });
      return true;
    }
    try {
      sendJson(res, 200, await relayEgyDead(parsed.toString()));
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }
  if (url.pathname === '/relay/animezid') {
    const vid = url.searchParams.get('vid');
    if (!vid || !/^[A-Za-z0-9_-]+$/.test(vid)) {
      sendJson(res, 400, { ok: false, error: 'missing/bad vid param' });
      return true;
    }
    try {
      sendJson(res, 200, await relayAnimeZid(vid));
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }
  if (url.pathname === '/relay/mycima') {
    const vid = url.searchParams.get('vid');
    if (!vid || !/^[A-Za-z0-9_-]+$/.test(vid)) {
      sendJson(res, 400, { ok: false, error: 'missing/bad vid param' });
      return true;
    }
    try {
      sendJson(res, 200, await relayMyCima(vid));
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }
  return false;
}


module.exports = {
  handleRelayRequest,
  relayEgyDead,
  relayAnimeZid,
  relayMyCima,
  CookieJar,
  BROWSER_HEADERS,
};
