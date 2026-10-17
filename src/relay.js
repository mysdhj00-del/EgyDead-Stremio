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
 *   GET /relay/resolve?url=<urlencoded embed page URL> (generic: fetches an
 *       embed page server-side and extracts any direct media URL from it;
 *       used when the app's host-based extractors don't know an embed host)
 *   GET /relay/tattoo?url=<urlencoded wecima.tattoo page URL> (renders the
 *       page in headless Chromium — the only client class that passes
 *       tattoo's Cloudflare managed challenge — and returns the rendered
 *       HTML plus its [data-watch] watch-server embeds)
 */
const cheerio = require('cheerio');
const egy = require('./egydead');
const { impFetch } = require('./impfetch');

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

/**
 * Same contract as fetchFull, but through the Chrome-impersonating client
 * (see impfetch.js) — required for egydead.live since its 2026-10-17
 * Cloudflare fingerprint wall rejects plain fetch with a 403 challenge.
 */
async function fetchImp(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || 25000);
  try {
    const headers = { ...BROWSER_HEADERS, ...(opts.headers || {}) };
    if (opts.referer) headers.Referer = opts.referer;
    if (opts.jar) {
      const cookie = opts.jar.headerFor(url);
      if (cookie) headers.Cookie = cookie;
    }
    const res = await impFetch(url, {
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
    const g = await fetchImp(targetUrl, { jar, referer: egy.BASE + '/' });
    diag.getCode = g.status;
  } catch (e) {
    diag.getError = String((e && e.message) || e);
  }

  // b. POST View=1 (form-encoded) to the same URL — the watch unlock.
  let postHtml = '';
  try {
    const p = await fetchImp(targetUrl, {
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

// ------------------------------------------------- deep-dig (directs)
// Some finals' hosts hide the real stream inside Dean Edwards packed JS
// (uqload, lulustream, vidhide/filemoon family) or a token pattern
// (streamtape's get_video). Phone-side extractors fail on those from the
// user's network (verified 2026-10-16: only DoodStream emitted on-device
// while the embeds themselves were alive), so the relay digs the direct
// stream URL out server-side and returns it alongside the finals. Hosts
// whose flow cannot be dug statically (MixDrop's captcha gate, DoodStream
// family's pass_md5 two-step, KrakenFiles' form) are skipped — the app's
// extractor path still covers them where it works.
function packerToken(i, radix) {
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz';
  if (i === 0) return '0';
  let s = '';
  let n = i;
  while (n > 0) {
    s = digits[n % radix] + s;
    n = Math.floor(n / radix);
  }
  return s;
}

function unpackPackedJs(text) {
  const out = [];
  const re =
    /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)\)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    const radix = parseInt(m[2], 10);
    const count = parseInt(m[3], 10);
    const words = m[4].replace(/\\'/g, "'").split('|');
    const map = {};
    for (let i = 0; i < count; i++) {
      const t = packerToken(i, radix);
      map[t] = words[i] ? words[i] : t;
    }
    out.push(payload.replace(/\b\w+\b/g, (w) => (w in map ? map[w] : w)));
  }
  return out;
}

const DIRECT_JUNK =
  /(\.vtt|\.svg|\.png|\.jpe?g|\.gif|logo|thumb|\/images\/|sprite)/i;

function pickDirect(texts) {
  const found = [];
  for (const text of texts) {
    if (!text) continue;
    const pats = [
      /https?:\/\/[^\s"'\\<>]+\.m3u8(?:\?[^\s"'\\<>]*)?/g,
      /https?:\/\/[^\s"'\\<>]+\.mp4(?:\?[^\s"'\\<>]*)?/g,
      /wurl\s*[:=]\s*["'](https?:\/\/[^"']+)["']/g,
    ];
    for (const p of pats) {
      let mm;
      while ((mm = p.exec(text)) !== null) {
        const u = mm[1] || mm[0];
        if (!DIRECT_JUNK.test(u) && !found.includes(u)) found.push(u);
      }
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => {
    const score = (u) =>
      (/master\.m3u8/.test(u) ? 0 : /\.m3u8/.test(u) ? 1 : 2);
    return score(a) - score(b);
  });
  return found[0];
}

// Hosts whose stream is never statically diggable (captcha gates, pass_md5
// or form two-steps, JS app shells) — the app's extractor path owns them.
const DIG_SKIP_HOST =
  /(megamax\.|mixdrop|mxdrop|krakenfiles|upns\.|dood|playmogo|ds2play|streamwish|rpmhub|rpmshare|byse|mp4upload|savefiles)/i;

async function digEmbedDirect(embedUrl, referer) {
  const page = await fetchFull(embedUrl, { referer, timeout: 9000 });
  if (!page.text) return null;
  const host = hostOf(page.finalUrl || embedUrl) || '';
  if (/streamtape/.test(host)) {
    const m = page.text.match(
      /get_video\?id=[^"'&\s]+&expires=\d+&ip=[^"'&\s]+&token=[^"'&\s]+/
    );
    if (m) return `https://${host}/${m[0]}`;
    return null;
  }
  return pickDirect([page.text, ...unpackPackedJs(page.text)]);
}

async function digDirects(finals, referer, diag) {
  const seen = new Set();
  const candidates = [];
  for (const f of finals) {
    if (!f.url || seen.has(f.url)) continue;
    seen.add(f.url);
    const host = hostOf(f.url) || '';
    if (DIG_SKIP_HOST.test(host)) continue;
    // The uqload .vc/.com pair is one file on two hosts — dig it once.
    if (/^uqload\./i.test(host)) {
      let path = f.url;
      try {
        path = new URL(f.url).pathname;
      } catch {
        /* keep full url as the key */
      }
      const key = 'uqload' + path;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    candidates.push(f);
    if (candidates.length >= 12) break;
  }
  const directs = [];
  const jobs = candidates.map((f) =>
    digEmbedDirect(f.url, referer)
      .then((direct) => {
        if (direct) directs.push({ provider: f.provider, url: direct, via: f.url });
      })
      .catch(() => {})
  );
  await Promise.race([
    Promise.allSettled(jobs),
    new Promise((r) => setTimeout(r, 11000)),
  ]);
  diag.dug = directs.length;
  return directs;
}

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
  const startedAt = Date.now();
  for (const src of ordered) {
    // Resolve EVERY embedded_web source (Mohamed's rule after the هزيم
    // الرعد miss: the user must see all the site's servers, not a capped
    // subset — a dead first server must never hide the live ones behind
    // it). 12 is only a runaway safety bound; real sessions carry ≤ ~8.
    if (collected >= 12) break;
    const provider = src.provider || 'unknown';
    // Pace the resolves and respect an overall deadline: the site
    // throttles bursts (429s), so back-to-back resolving kills the tail
    // of the source list — exactly the "only one or two servers" failure
    // Mohamed flagged. Sources past the deadline are marked, not dropped
    // silently.
    if (collected > 0) await sleep(1200);
    if (Date.now() - startedAt > 110000) {
      diag.perSource[provider] = 'skipped-deadline';
      continue;
    }
    const resolveUrl = `${createUrl}/${sessionId}/sources/${src.id}/resolve`;

    let launchUrl = null;
    let code = null;
    for (let attempt = 0; attempt < 3 && !launchUrl; attempt++) {
      if (attempt > 0) await sleep(attempt === 1 ? 4000 : 9000); // 429 backoff, two retries
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
      if (r.status === 429 && attempt < 2) continue;
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

  // MegaMax finals are player pages the app has no extractor for — expand
  // them here into their per-quality mirror URLs (extractor-known hosts),
  // exactly like the EgyDead relay does for its embeds. Verified live on
  // هزيم الرعد ep1 (2026-10-16): the mirrors (MixDrop, LuluStream, Byse,
  // RPMShare, MP4Upload...) are the only playable servers left when the
  // direct sources' uploads have died — the official app lists the same
  // mirror set.
  const extra = [];
  for (const f of finals.slice()) {
    if ((f.provider || '').toLowerCase() !== 'megamax') continue;
    let groups = [];
    try {
      groups = await egy.megaMaxMirrors(f.url, playUrl);
    } catch {
      groups = [];
    }
    let n = 0;
    for (const g of groups) {
      for (const m of g.mirrors || []) {
        if (m && !finals.some((x) => x.url === m) && !extra.some((x) => x.url === m)) {
          extra.push({ provider: 'MegaMax', url: m });
          n++;
        }
      }
    }
    diag.perSource.MegaMaxMirrors = n;
  }
  finals.push(...extra);

  // Deep-dig direct stream URLs server-side for the hosts the phone's
  // extractors cannot open from the user's network (packed-JS players).
  const directs = await digDirects(finals, playUrl, diag);

  return { ok: finals.length > 0 || directs.length > 0, finals, directs, diag };
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

// --------------------------------------------------------------- Resolve
/**
 * Generic embed resolver: fetch an embed page server-side and pull any
 * direct media URL out of it (JW-style file: entries, ArtPlayer's videoUrl
 * constant, or a bare .m3u8/.mp4 URL in the page). Complements the app's
 * host-based extractors for embed hosts they don't know (or know only
 * under a different TLD).
 */
async function relayResolve(target, ref) {
  const diag = { code: null, directCount: 0 };
  // Many embed hosts bounce referer-less requests to the site's homepage
  // (verified with akhbarworld: no referer → 302 to the front page).
  let referer = ref || '';
  if (!referer) {
    try {
      referer = new URL(target).origin + '/';
    } catch {
      referer = '';
    }
  }
  const res = await fetchFull(target, { timeout: 25000, referer });
  diag.code = res.status;
  const text = (res.text || '').replace(/\\\//g, '/');
  const direct = [];
  const seen = new Set();
  const push = (u) => {
    const fixed = (u || '').trim();
    if (fixed.startsWith('http') && !seen.has(fixed)) {
      seen.add(fixed);
      direct.push({ url: fixed, type: fixed.includes('.m3u8') ? 'm3u8' : 'video' });
    }
  };
  for (const m of text.matchAll(/file\s*:\s*["'](https?:[^"']+)["']/g)) push(m[1]);
  for (const m of text.matchAll(/videoUrl\s*=\s*"(https?:[^"]+)"/g)) push(m[1]);
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g)) push(m[0]);
  if (!direct.length) {
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/g)) push(m[0]);
  }
  diag.directCount = direct.length;
  return { ok: direct.length > 0, direct, diag };
}

// ---------------------------------------------------------------- routes
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- WeCima tattoo: headless-Chrome page relay ----------
// Verified 2026-10-16: every non-browser client is refused by tattoo's
// Cloudflare managed challenge on inner pages (the CloudStream app, curl
// incl. TLS-impersonated and cookie-warmed sessions, this server's plain
// fetch, reader proxies — all 403 "Just a moment"), while genuine Chrome
// passes. So the page is rendered in headless Chromium and the provider
// consumes the rendered HTML / embeds. One browser is kept alive across
// requests (launch cost + any clearance the profile earns), pages are
// per-request, and rendered pages are cached briefly — a series hub and
// its episode page are typically requested seconds apart.

const tattooCache = new Map(); // url -> { at, payload }
const TATTOO_TTL_MS = 10 * 60 * 1000;
let tattooBrowser = null;
let tattooLaunching = null;

async function getTattooBrowser() {
  if (tattooBrowser) return tattooBrowser;
  if (!tattooLaunching) {
    tattooLaunching = (async () => {
      const spart = require('@sparticuz/chromium');
      const chromium = spart.default || spart;
      const puppeteer = require('puppeteer-core');
      const execPath = await chromium.executablePath();
      const args = [
        ...(chromium.args || []),
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ];
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
      if (proxy) {
        try {
          const pu = new URL(proxy);
          args.push('--proxy-server=' + pu.protocol + '//' + pu.host);
        } catch {
          /* direct egress */
        }
      }
      tattooBrowser = await puppeteer.launch({
        args,
        executablePath: execPath,
        headless: chromium.headless !== undefined ? chromium.headless : true,
      });
      tattooBrowser.on('disconnected', () => {
        tattooBrowser = null;
        tattooLaunching = null;
      });
      return tattooBrowser;
    })();
  }
  return tattooLaunching;
}

async function relayTattoo(target) {
  const parsed = new URL(target);
  if (parsed.hostname !== 'wecima.tattoo') {
    return { ok: false, error: 'host must be wecima.tattoo' };
  }
  const cached = tattooCache.get(target);
  if (cached && Date.now() - cached.at < TATTOO_TTL_MS) return cached.payload;
  const browser = await getTattooBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
    await page
      .goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(() => {});
    // The managed challenge auto-clears in a real engine; poll until the
    // real page (full-size, no challenge marker) is what the DOM holds.
    let html = '';
    for (let i = 0; i < 25; i++) {
      html = await page.content().catch(() => '');
      if (html && !html.includes('Just a moment') && html.length > 20000) break;
      await sleep(2000);
    }
    const $ = cheerio.load(html || '');
    const embeds = [];
    $('[data-watch]').each((_, el) => {
      const u = $(el).attr('data-watch');
      if (u && u.startsWith('http') && !embeds.includes(u)) embeds.push(u);
    });
    const payload = {
      ok: !!html && !html.includes('Just a moment') && html.length > 20000,
      html,
      embeds,
      diag: {
        len: (html || '').length,
        embeds: embeds.length,
        title: $('title').text() || '',
      },
    };
    if (payload.ok) {
      if (tattooCache.size > 60) tattooCache.clear();
      tattooCache.set(target, { at: Date.now(), payload });
    }
    return payload;
  } finally {
    await page.close().catch(() => {});
  }
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
  if (url.pathname === '/relay/page') {
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
      const r = await fetchImp(parsed.toString(), {
        referer: 'https://' + parsed.hostname + '/',
        timeout: 30000,
      });
      sendJson(res, 200, {
        ok: r.status === 200,
        code: r.status,
        finalUrl: r.finalUrl,
        text: (r.text || '').slice(0, 2500000),
      });
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
  if (url.pathname === '/relay/resolve') {
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
    const host = parsed.hostname.toLowerCase();
    if (
      !/^https?:$/.test(parsed.protocol) ||
      host === 'localhost' ||
      host === '::1' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      sendJson(res, 400, { ok: false, error: 'url must be a public http(s) URL' });
      return true;
    }
    const ref = url.searchParams.get('ref') || '';
    try {
      sendJson(res, 200, await relayResolve(parsed.toString(), ref));
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }
  if (url.pathname === '/relay/wecima') {
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
    if (!/^https?:$/.test(parsed.protocol) || parsed.hostname !== 'wecima.mobile') {
      sendJson(res, 400, { ok: false, error: 'url must be a wecima.mobile http(s) URL' });
      return true;
    }
    try {
      sendJson(res, 200, await relayWeCima(parsed.toString()));
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }
  if (url.pathname === '/relay/tattoo') {
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
    if (!/^https?:$/.test(parsed.protocol) || parsed.hostname !== 'wecima.tattoo') {
      sendJson(res, 400, { ok: false, error: 'url must be a wecima.tattoo http(s) URL' });
      return true;
    }
    try {
      sendJson(res, 200, await relayTattoo(parsed.toString()));
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- WeCima mobile
/**
 * The full wecima.mobile playback protocol, server-side (the phone's
 * direct fetches to this host throw — timeout/TLS class failures seen
 * on-device as DEBUG "watch=err" — while the same pages answer curl and
 * the phone's browser; the EgyDead lesson: move the chain server-side).
 * GET /watch/{slug} (cookie jar) -> inline servers[] + watchResolveKey +
 * csrfToken -> POST /watch/resolve {key, index} per server -> /m/{hash}
 * fragment -> 302/meta-refresh target = the server's real embed.
 * Returns every resolved embed (no first-hit stop).
 */
async function relayWeCima(watchUrl) {
  const diag = { watch: null, servers: 0, resolved: 0 };
  const embeds = [];
  const jar = new CookieJar();
  const origin = 'https://wecima.mobile';
  let page;
  try {
    page = await fetchFull(watchUrl, { jar, referer: origin + '/', timeout: 30000 });
    diag.watch = page.status;
  } catch (e) {
    diag.watchError = String((e && e.message) || e);
    return { ok: false, embeds, diag };
  }
  const html = page.text || '';
  const key = (html.match(/watchResolveKey\s*=\s*"([^"]+)"/) || [])[1];
  const csrf = (html.match(/csrfToken\s*=\s*"([^"]+)"/) || [])[1];
  let servers = [];
  const sm = html.match(/const servers = (\[[\s\S]*?\]);/);
  if (sm) {
    try {
      servers = JSON.parse(sm[1]);
    } catch {
      servers = [];
    }
  }
  diag.servers = servers.length;
  if (!key || !csrf || !servers.length) return { ok: false, embeds, diag };
  const seen = new Set();
  for (let i = 0; i < servers.length; i++) {
    const sname = (servers[i] && servers[i].name) || `server${i}`;
    try {
      const r = await fetchFull(origin + '/watch/resolve', {
        method: 'POST',
        jar,
        referer: watchUrl,
        timeout: 20000,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrf,
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json',
        },
        body: JSON.stringify({ key, index: i }),
      });
      const j = JSON.parse(r.text);
      if (!j || !j.ok || !j.url) {
        diag[`resolve${i}`] = 'fail';
        continue;
      }
      diag.resolved++;
      const fragUrl = j.url.startsWith('http') ? j.url : origin + j.url;
      const f = await fetchFull(fragUrl, { jar, referer: watchUrl, timeout: 15000 });
      let embed = null;
      if (f.finalUrl && !f.finalUrl.includes('wecima.mobile')) {
        embed = f.finalUrl;
      } else {
        const mm =
          (f.text || '').match(/url='([^']+)'/) ||
          (f.text || '').match(/<a href="([^"]+)"/);
        if (mm) embed = mm[1];
      }
      if (embed && embed.startsWith('http') && !seen.has(embed)) {
        seen.add(embed);
        embeds.push({ name: sname, url: embed });
      }
    } catch (e) {
      diag[`resolve${i}`] = String((e && e.message) || e).slice(0, 60);
    }
  }
  return { ok: embeds.length > 0, embeds, diag };
}

module.exports = {
  handleRelayRequest,
  relayEgyDead,
  relayAnimeZid,
  relayMyCima,
  relayResolve,
  relayTattoo,
  relayWeCima,
  CookieJar,
  BROWSER_HEADERS,
};
