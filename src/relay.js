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

/**
 * Follows a launch URL by hand (redirect: 'manual'), returning the final
 * URL WITHOUT downloading the target page's body. The old flow fetched the
 * whole embed page per source just to learn where the 302 landed; on slow
 * hosts that was a large share of the relay's ~15 s. Cookies are stored
 * and re-sent per hop exactly like the jar flow in fetchFull.
 */
async function followLaunch(url, opts = {}) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const headers = { ...BROWSER_HEADERS, ...(opts.headers || {}) };
    if (opts.referer) headers.Referer = opts.referer;
    if (opts.jar) {
      const cookie = opts.jar.headerFor(current);
      if (cookie) headers.Cookie = cookie;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || 20000);
    let res;
    try {
      res = await fetch(current, { redirect: 'manual', signal: controller.signal, headers });
    } finally {
      clearTimeout(timer);
    }
    if (opts.jar) opts.jar.store(res, current);
    const loc = res.headers.get('location');
    if (res.body) res.body.cancel().catch(() => {});
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    return current;
  }
  return current;
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

async function relayAnimeZid(vid, wantDig = false) {
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

  // Resolve the sources with bounded concurrency (2 workers). The old
  // strictly-sequential flow (1.2 s pacing between sources) made every
  // relay call take ~15 s before the phone could start. Two-at-a-time
  // with the same 429 backoff keeps the site's throttle at bay (the
  // backoff rescues a throttled source locally, in parallel) while
  // roughly halving the wait. Results land in per-source slots so the
  // finals keep their priority order regardless of completion order.
  const slots = ordered.map(() => ({ finals: [], mirrorsPromise: null }));
  let nextIdx = 0;
  let collectedCount = 0;

  async function resolveOne(idx) {
    const src = ordered[idx];
    const slot = slots[idx];
    const provider = src.provider || 'unknown';
    if (collectedCount >= 12) return;
    if (Date.now() - startedAt > 110000) {
      diag.perSource[provider] = 'skipped-deadline';
      return;
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
      return;
    }

    // Follow the launch WITH the session cookies — without them the site
    // answers HTTP 410 and stays on animezid.org (verified live). Only the
    // redirect chain is walked; the embed page body is never downloaded.
    let absLaunch;
    try {
      absLaunch = new URL(launchUrl, AZ_BASE).toString();
    } catch {
      diag.perSource[provider] = 'bad-launch-url';
      return;
    }
    let finalUrl = null;
    try {
      finalUrl = await followLaunch(absLaunch, { jar, referer: playUrl, timeout: 20000 });
    } catch {
      diag.perSource[provider] = 'launch-error';
      return;
    }
    if (!finalUrl) {
      diag.perSource[provider] = 'launch-empty';
      return;
    }
    diag.perSource[provider] = hostOf(finalUrl) || finalUrl;
    slot.finals.push({ provider, url: finalUrl });

    // The CloudStream Uqload extractor doesn't know the .vc TLD; the same
    // embed path works on the canonical uqload.com host.
    try {
      const u = new URL(finalUrl);
      if (/^uqload\./i.test(u.hostname) && u.hostname.toLowerCase() !== 'uqload.com') {
        u.hostname = 'uqload.com';
        slot.finals.push({ provider, url: u.toString() });
      }
    } catch {
      /* finalUrl already recorded */
    }
    collectedCount++;

    // MegaMax finals are player pages the app has no extractor for —
    // start expanding this one into its per-quality mirrors right away,
    // in parallel with the remaining resolves.
    if (provider.toLowerCase() === 'megamax') {
      slot.mirrorsPromise = egy.megaMaxMirrors(finalUrl, playUrl).catch(() => []);
    }
  }

  const startedAt = Date.now();
  async function worker() {
    while (nextIdx < ordered.length) {
      const idx = nextIdx++;
      await resolveOne(idx);
    }
  }
  await Promise.all([worker(), worker(), worker()]);

  for (const slot of slots) finals.push(...slot.finals);

  // MegaMax mirrors, merged in source order (the expansions were started
  // during the resolve phase, so this is mostly just awaiting them).
  // Verified live on هزيم الرعد ep1 (2026-10-16): the mirrors (MixDrop,
  // LuluStream, Byse, RPMShare, MP4Upload...) are the only playable
  // servers left when the direct sources' uploads have died — the
  // official app lists the same mirror set.
  const extra = [];
  let mirrorTotal = 0;
  for (const slot of slots) {
    if (!slot.mirrorsPromise) continue;
    const groups = (await slot.mirrorsPromise) || [];
    for (const g of groups) {
      for (const m of g.mirrors || []) {
        if (m && !finals.some((x) => x.url === m) && !extra.some((x) => x.url === m)) {
          extra.push({ provider: 'MegaMax', url: m });
          mirrorTotal++;
        }
      }
    }
  }
  diag.perSource.MegaMaxMirrors = mirrorTotal;
  finals.push(...extra);

  // Deep-dig direct stream URLs server-side ONLY on explicit request
  // (dig=1). Since 2026-10-17 this is off by default: stream tokens are
  // IP-bound to the fetching IP, so the phone cannot play server-dug
  // directs anyway, and the dig stage (up to ~11s) delayed every
  // response. The provider digs on the phone itself (its own IP).
  const directs = wantDig ? await digDirects(finals, playUrl, diag) : [];

  return { ok: finals.length > 0 || directs.length > 0, finals, directs, diag };
}

// ------------------------------------------------- AnimeZid FAST lane
// (2026-10-17, the consolidated fix from Mohamed's solution session: the
// full relay resolves ~13 sources and expands MegaMax before it may
// answer (~4.5-7 s), although the phone only needs the first playable
// candidate. The fast lane runs the same session flow, then resolves
// sources in extractor-priority order and STOPS as soon as it holds a
// live Doodstream final - or, when Doodstream is absent/dead, after 3
// resolved finals. A Doodstream final is classified server-side: its
// embed page either shows the plain "Video not found" page (a dead
// file - measured: served without any gate) or the Cloudflare
// Turnstile gate page (a live file whose player bootstrap sits behind
// the gate). No MegaMax expansion here; the full endpoint stays the
// fallback. Stage timings ride in diag.stages so a DEBUG screenshot
// shows where the seconds went.)
function isDoodFinal(provider, url) {
  const p = (provider || '').toLowerCase();
  return (
    p.includes('dood') || p.includes('playmate') || /playmogo|doodstream|dood\./i.test(url || '')
  );
}

async function classifyDood(url, referer) {
  try {
    const r = await fetchFull(url, { referer, timeout: 8000 });
    const head = (r.text || '').slice(0, 4000);
    if (/<title>[^<]*not found/i.test(head) || /video you are looking for is not found/i.test(head)) {
      return 'dead';
    }
    return 'alive';
  } catch {
    return 'unknown';
  }
}

/** One source resolve + launch follow (the fast lane's lean variant of
 * resolveOne: 2 attempts, one short 429 backoff, no mirror work). */
async function resolveSourceFast(src, ctx) {
  const { createUrl, sessionId, jar, apiHeaders, playUrl, diag } = ctx;
  const provider = src.provider || 'unknown';
  const resolveUrl = `${createUrl}/${sessionId}/sources/${src.id}/resolve`;
  let launchUrl = null;
  let code = null;
  for (let attempt = 0; attempt < 2 && !launchUrl; attempt++) {
    if (attempt > 0) await sleep(2500);
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
    if (r.status === 429 && attempt < 1) continue;
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
    return null;
  }
  let absLaunch;
  try {
    absLaunch = new URL(launchUrl, AZ_BASE).toString();
  } catch {
    diag.perSource[provider] = 'bad-launch-url';
    return null;
  }
  let finalUrl = null;
  try {
    finalUrl = await followLaunch(absLaunch, { jar, referer: playUrl, timeout: 20000 });
  } catch {
    diag.perSource[provider] = 'launch-error';
    return null;
  }
  if (!finalUrl) {
    diag.perSource[provider] = 'launch-empty';
    return null;
  }
  diag.perSource[provider] = hostOf(finalUrl) || finalUrl;
  return finalUrl;
}

async function relayAnimeZidFast(vid) {
  const t0 = Date.now();
  const diag = { fast: 1, protected: null, sourceCount: 0, perSource: {}, stages: {} };
  const finals = [];
  const jar = new CookieJar();
  const playUrl = `${AZ_BASE}/play.php?vid=${encodeURIComponent(vid)}`;

  const play = await fetchFull(playUrl, {
    jar,
    referer: `${AZ_BASE}/watch.php?vid=${encodeURIComponent(vid)}`,
  });
  diag.stages.playMs = Date.now() - t0;
  const $ = cheerio.load(play.text);
  const holder = $('[data-playback-create-url]').first();
  const prot = holder.attr('data-playback-protected');
  diag.protected = prot === undefined ? null : prot;
  const csrf = holder.attr('data-playback-csrf');
  let createUrl = holder.attr('data-playback-create-url');
  if (!csrf || !createUrl) {
    diag.stages.totalMs = Date.now() - t0;
    return {
      ok: false, fast: true, ds: 'none', finals, directs: [], diag,
      error: `playback attrs missing (HTTP ${play.status})`,
    };
  }
  createUrl = new URL(createUrl, AZ_BASE).toString().replace(/\/+$/, '');

  const apiHeaders = {
    'X-Playback-CSRF': csrf,
    'Content-Type': 'application/json',
    Origin: AZ_BASE,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
  const tSess = Date.now();
  const sessRes = await fetchFull(createUrl, {
    method: 'POST',
    jar,
    referer: playUrl,
    headers: apiHeaders,
    body: JSON.stringify({ content_id: vid }),
  });
  diag.stages.sessionMs = Date.now() - tSess;
  let session = null;
  try {
    session = JSON.parse(sessRes.text);
  } catch {
    session = null;
  }
  if (!session || !session.session_id) {
    diag.stages.totalMs = Date.now() - t0;
    return {
      ok: false, fast: true, ds: 'none', finals, directs: [], diag,
      error: `session create failed: HTTP ${sessRes.status}`,
    };
  }
  const sessionId = session.session_id;

  const allSources = Array.isArray(session.sources) ? session.sources : [];
  const web = allSources.filter((s) => s && s.type === 'embedded_web');
  diag.sourceCount = web.length;
  const prio = (s) => {
    const i = AZ_PRIORITY.indexOf(s.provider || '');
    return i === -1 ? AZ_PRIORITY.length : i;
  };
  const ordered = web.slice().sort((a, b) => prio(a) - prio(b));

  const tRes = Date.now();
  let ds = 'none';
  for (const src of ordered) {
    if (ds === 'alive') break;
    if (finals.length >= 3) break;
    if (Date.now() - t0 > 9000) {
      diag.stopped = 'cap';
      break;
    }
    const provider = src.provider || 'unknown';
    if (provider.toLowerCase() === 'megamax') continue;
    const finalUrl = await resolveSourceFast(src, {
      createUrl,
      sessionId,
      jar,
      apiHeaders,
      playUrl,
      diag,
    });
    if (!finalUrl) continue;
    finals.push({ provider, url: finalUrl });
    try {
      const u = new URL(finalUrl);
      if (/^uqload\./i.test(u.hostname) && u.hostname.toLowerCase() !== 'uqload.com') {
        u.hostname = 'uqload.com';
        finals.push({ provider, url: u.toString() });
      }
    } catch {
      /* finalUrl already recorded */
    }
    if (isDoodFinal(provider, finalUrl)) {
      ds = await classifyDood(finalUrl, playUrl);
      diag.ds = ds;
    }
  }
  diag.stages.resolveMs = Date.now() - tRes;
  diag.stages.totalMs = Date.now() - t0;
  return { ok: finals.length > 0, fast: true, ds, finals, directs: [], diag };
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

/**
 * v11 STREAMING variant of the AnimeZid relay: same protected session
 * flow and the same resolve discipline as relayAnimeZid, but every
 * final is emitted (NDJSON line via [emit]) THE MOMENT it lands
 * instead of after the whole pool finishes — the phone starts its
 * extractor pass on the first arrivals while the rest keep resolving.
 * MegaMax mirrors are emitted from inside the worker as soon as that
 * source's expansion returns. [state.aborted] is set by the route
 * when the client disconnects; workers stop starting new resolves.
 */
async function relayAnimeZidStream(vid, emit, state) {
  const t0 = Date.now();
  const diag = { stages: {}, perSource: {}, sourceCount: 0 };
  const jar = new CookieJar();
  const playUrl = `${AZ_BASE}/play.php?vid=${encodeURIComponent(vid)}`;
  let count = 0;
  const sendFinal = (provider, url) => {
    count++;
    emit({ t: 'final', provider, url });
  };
  try {
    const play = await fetchFull(playUrl, {
      jar,
      referer: `${AZ_BASE}/watch.php?vid=${encodeURIComponent(vid)}`,
    });
    diag.stages.playMs = Date.now() - t0;
    emit({ t: 'stage', name: 'play', ms: diag.stages.playMs });
    const $ = cheerio.load(play.text);
    const holder = $('[data-playback-create-url]').first();
    const csrf = holder.attr('data-playback-csrf');
    let createUrl = holder.attr('data-playback-create-url');
    if (!csrf || !createUrl) {
      emit({ t: 'done', ok: false, count, error: `playback attrs missing (HTTP ${play.status})`, diag });
      return;
    }
    createUrl = new URL(createUrl, AZ_BASE).toString().replace(/\/+$/, '');
    const apiHeaders = {
      'X-Playback-CSRF': csrf,
      'Content-Type': 'application/json',
      Origin: AZ_BASE,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    };
    const tSess = Date.now();
    const sessRes = await fetchFull(createUrl, {
      method: 'POST',
      jar,
      referer: playUrl,
      headers: apiHeaders,
      body: JSON.stringify({ content_id: vid }),
    });
    diag.stages.sessionMs = Date.now() - tSess;
    emit({ t: 'stage', name: 'session', ms: diag.stages.sessionMs });
    let session = null;
    try {
      session = JSON.parse(sessRes.text);
    } catch {
      session = null;
    }
    if (!session || !session.session_id) {
      emit({ t: 'done', ok: false, count, error: `session create failed: HTTP ${sessRes.status}`, diag });
      return;
    }
    const sessionId = session.session_id;
    const allSources = Array.isArray(session.sources) ? session.sources : [];
    const web = allSources.filter((s) => s && s.type === 'embedded_web');
    diag.sourceCount = web.length;
    const prio = (s) => {
      const i = AZ_PRIORITY.indexOf(s.provider || '');
      return i === -1 ? AZ_PRIORITY.length : i;
    };
    const ordered = web.slice().sort((a, b) => prio(a) - prio(b));
    let nextIdx = 0;

    async function resolveOneS(idx) {
      if (state.aborted) return;
      const src = ordered[idx];
      const provider = src.provider || 'unknown';
      if (count >= 40) return;
      if (Date.now() - t0 > 60000) {
        diag.perSource[provider] = 'skipped-deadline';
        return;
      }
      const resolveUrl = `${createUrl}/${sessionId}/sources/${src.id}/resolve`;
      let launchUrl = null;
      let code = null;
      for (let attempt = 0; attempt < 3 && !launchUrl; attempt++) {
        if (attempt > 0) await sleep(attempt === 1 ? 4000 : 9000);
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
        return;
      }
      let absLaunch;
      try {
        absLaunch = new URL(launchUrl, AZ_BASE).toString();
      } catch {
        diag.perSource[provider] = 'bad-launch-url';
        return;
      }
      let finalUrl = null;
      try {
        finalUrl = await followLaunch(absLaunch, { jar, referer: playUrl, timeout: 20000 });
      } catch {
        diag.perSource[provider] = 'launch-error';
        return;
      }
      if (!finalUrl) {
        diag.perSource[provider] = 'launch-empty';
        return;
      }
      diag.perSource[provider] = hostOf(finalUrl) || finalUrl;
      sendFinal(provider, finalUrl);
      try {
        const u = new URL(finalUrl);
        if (/^uqload\./i.test(u.hostname) && u.hostname.toLowerCase() !== 'uqload.com') {
          u.hostname = 'uqload.com';
          sendFinal(provider, u.toString());
        }
      } catch {
        /* finalUrl already emitted */
      }
      if (provider.toLowerCase() === 'megamax') {
        const mirrors = await egy.megaMaxMirrors(finalUrl, playUrl).catch(() => []);
        for (const m of mirrors) sendFinal('MegaMax', m);
      }
    }

    async function worker() {
      while (!state.aborted && nextIdx < ordered.length) {
        const idx = nextIdx++;
        await resolveOneS(idx);
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    diag.stages.resolveMs = Date.now() - t0 - diag.stages.playMs - diag.stages.sessionMs;
    diag.totalMs = Date.now() - t0;
    emit({ t: 'done', ok: count > 0, count, diag });
  } catch (e) {
    diag.totalMs = Date.now() - t0;
    emit({ t: 'done', ok: false, count, error: String((e && e.message) || e), diag });
  }
}

/**
 * PROBE (2026-10-17 night): can this service's own headless Chromium
 * (the tattoo stack) pass EgyDead's NEW interactive Cloudflare
 * challenge — auto-clear or by clicking the Turnstile checkbox — and
 * mint a cf_clearance cookie? Decides the browser-relay branch.
 * Host-locked to egydead domains.
 */
async function relayBrowserTest(target) {
  const parsed = new URL(target);
  if (!parsed.hostname.includes('egydead')) {
    return { ok: false, error: 'host must be an EgyDead domain' };
  }
  const t0 = Date.now();
  const el = () => Date.now() - t0;
  const browser = await getTattooBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const state = async () => {
      const html = await page.content().catch(() => '');
      return { challenged: html.includes('Just a moment'), len: html.length };
    };
    let solvedBy = 'none';
    for (let i = 0; i < 15; i++) {
      const s = await state();
      if (!s.challenged && s.len > 20000) {
        solvedBy = 'auto';
        break;
      }
      await sleep(2000);
    }
    let clicked = false;
    if (solvedBy === 'none') {
      for (const frame of page.frames()) {
        const fu = frame.url() || '';
        if (fu.includes('challenges.cloudflare.com') || fu.includes('turnstile')) {
          try {
            const box = await frame.$('input[type="checkbox"], label, body');
            if (box) {
              await box.click();
              clicked = true;
            }
          } catch {
            /* fall through to coordinate click */
          }
          if (!clicked) {
            try {
              const bodyEl = await frame.evaluateHandle(() => document.body);
              const bb = await bodyEl.asElement().boundingBox();
              if (bb) {
                await page.mouse.click(bb.x + 30, bb.y + bb.height / 2);
                clicked = true;
              }
            } catch {
              /* no click possible */
            }
          }
          break;
        }
      }
      for (let i = 0; i < 20; i++) {
        const s = await state();
        if (!s.challenged && s.len > 20000) {
          solvedBy = 'click';
          break;
        }
        await sleep(2000);
      }
    }
    const s = await state();
    const title = await page.title().catch(() => '');
    const cookies = await page.cookies().catch(() => []);
    const cfCookies = cookies.filter((c) => c.name.includes('cf')).map((c) => c.name);
    return {
      ok: solvedBy !== 'none',
      solvedBy,
      clicked,
      ms: el(),
      title: (title || '').slice(0, 90),
      len: s.len,
      cfCookies,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// ------------------------------------------------- EgyDead .ca stream proxy
// (2026-10-18) egybestvid stream tokens are bound to (fetching IP +
// User-Agent) — measured live: the playlist/variants/segments answer 200
// only when every request carries the SAME IP and the SAME UA that dug
// the embed, and 403 otherwise. The CloudStream player cannot be made
// to present the dig's identity reliably on the user's device, so the
// provider now plays through this proxy instead: the phone talks ONLY
// to this server, and this server performs the dig AND every playlist /
// segment fetch with ONE fixed identity (its own IP + VID_UA below),
// which satisfies the binding entirely server-side.
//   GET /relay/vid?src=<urlencoded egybestvid embed URL>
//       -> { ok, master: <proxied master playlist URL>, diag }
//   GET /relay/hls?u=<base64url target>&r=<base64url referer>
//       -> the target fetched with the proxy identity; playlists are
//          rewritten so every resource resolves back through /relay/hls.
const VID_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const vidCache = new Map(); // embed src -> { at, master }
const VID_CACHE_TTL_MS = 30 * 60 * 1000;

// Server-side hit log (2026-10-18): the user's phone verdicts carry no
// diagnostics, so the relay records its own recent requests in memory —
// one tap on his phone becomes fully visible here (did /relay/vid
// arrive? did the player follow with the master, variants, segments?).
// Read via GET /relay/hits?k=<HITS_KEY>. Operational data only:
// timestamps, routes, the public embed id, statuses, byte counts.
const HITS_KEY = 'saher-obs-7f3';
const hitLog = [];
function logHit(route, info) {
  hitLog.push({ t: new Date().toISOString(), route, ...info });
  if (hitLog.length > 120) hitLog.shift();
}

const b64e = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const b64d = (s) => Buffer.from(String(s || ''), 'base64url').toString('utf8');

function proxyBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers.host || 'egydead-stremio.onrender.com';
  return `${proto}://${host}`;
}

function hlsProxyUrl(req, target, referer) {
  return `${proxyBase(req)}/relay/hls?u=${encodeURIComponent(b64e(target))}&r=${encodeURIComponent(b64e(referer))}`;
}

function isVidHost(host) {
  const h = (host || '').toLowerCase();
  return h === 'egybestvid.com' || h.endsWith('.egybestvid.com');
}

async function relayVid(req, src) {
  const parsed = new URL(src);
  if (!isVidHost(parsed.hostname)) {
    return { ok: false, error: 'src must be an egybestvid embed URL' };
  }
  const cached = vidCache.get(src);
  if (cached && Date.now() - cached.at < VID_CACHE_TTL_MS) {
    logHit('vid', { src: src.split('/').pop(), ok: true, cached: 1 });
    return { ok: true, master: hlsProxyUrl(req, cached.master, src), diag: { cached: 1 } };
  }
  const page = await fetchFull(src, {
    referer: 'https://egydead.ca/',
    timeout: 25000,
    headers: { 'User-Agent': VID_UA },
  });
  const text = (page.text || '').replace(/\\\//g, '/');
  let master = null;
  const fileM = text.match(/file\s*:\s*["'](https?:[^"']+\.m3u8[^"']*)["']/);
  if (fileM) master = fileM[1];
  if (!master) {
    const bare = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
    if (bare) master = bare[0];
  }
  if (!master) {
    logHit('vid', { src: src.split('/').pop(), ok: false, code: page.status });
    return { ok: false, diag: { code: page.status, len: text.length }, error: 'no m3u8 in embed page' };
  }
  if (vidCache.size > 100) vidCache.clear();
  vidCache.set(src, { at: Date.now(), master });
  logHit('vid', { src: src.split('/').pop(), ok: true, cached: 0 });
  return {
    ok: true,
    master: hlsProxyUrl(req, master, src),
    diag: { code: page.status, cached: 0 },
  };
}

async function relayHls(req, res, target, referer) {
  const parsed = new URL(target);
  if (!isVidHost(parsed.hostname)) {
    sendJson(res, 400, { ok: false, error: 'target host not allowed' });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  res.on('close', () => {
    clearTimeout(timer);
    controller.abort();
  });
  let up;
  try {
    // The FULL browser header set, identical to the dig's — measured by
    // the /relay/vidtest probe (2026-10-18): with UA+Referer alone the
    // CDN answers 403 even from the digging IP; with the complete set
    // (sec-ch-ua, Accept, Accept-Language...) it answers 200. The token
    // evidently validates against the dig's whole header profile.
    up = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { ...BROWSER_HEADERS, Referer: referer || 'https://egydead.ca/' },
    });
  } catch (e) {
    clearTimeout(timer);
    logHit('hls', { err: String((e && e.message) || e).slice(0, 60) });
    sendJson(res, 502, { ok: false, error: String((e && e.message) || e) });
    return;
  }
  const ctype = (up.headers.get('content-type') || '').toLowerCase();
  const isPlaylist = target.includes('.m3u8') || ctype.includes('mpegurl');
  if (isPlaylist) {
    const text = await up.text();
    clearTimeout(timer);
    if (up.status !== 200 || !text.startsWith('#EXTM3U')) {
      // Never rewrite an error page as if it were a playlist.
      logHit('hls', { kind: 'playlist-err', status: up.status });
      res.writeHead(up.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text.slice(0, 500));
      return;
    }
    const out = text.split('\n').map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return t.replace(/URI="([^"]+)"/g, (whole, uri) => {
          try {
            const abs = new URL(uri, target).toString();
            return `URI="${hlsProxyUrl(req, abs, referer)}"`;
          } catch {
            return whole;
          }
        });
      }
      try {
        const abs = new URL(t, target).toString();
        return hlsProxyUrl(req, abs, referer);
      } catch {
        return line;
      }
    }).join('\n');
    logHit('hls', { kind: 'playlist', status: up.status, bytes: out.length });
    res.writeHead(up.status, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache',
    });
    res.end(out);
    return;
  }
  const headers = {
    'Content-Type': ctype || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  };
  const len = up.headers.get('content-length');
  if (len) headers['Content-Length'] = len;
  res.writeHead(up.status, headers);
  if (!up.body) {
    clearTimeout(timer);
    res.end();
    return;
  }
  const { Readable, Transform } = require('stream');
  const rs = Readable.fromWeb(up.body);
  let segBytes = 0;
  const counter = new Transform({
    transform(chunk, enc, cb) {
      segBytes += chunk.length;
      cb(null, chunk);
    },
  });
  rs.on('error', () => {
    clearTimeout(timer);
    try { res.end(); } catch { /* closed */ }
  });
  rs.on('end', () => {
    clearTimeout(timer);
    logHit('hls', { kind: 'segment', status: up.status, bytes: segBytes });
  });
  rs.pipe(counter).pipe(res);
}

/**
 * PROBE (2026-10-18): why did the proxied master fetch answer 403 while
 * the dig (same server, seconds earlier) succeeded? One request performs
 * the dig, then fetches the master with (a) minimal headers (UA+Referer)
 * and (b) the full browser header set, and reads this service's egress
 * IP twice — separating IP rotation from header completeness.
 */
async function relayVidTest(src) {
  const out = { ips: [], dig: null, minimal: null, full: null };
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch('https://api.ipify.org?format=json', { timeout: 10000 });
      const j = await r.json();
      out.ips.push(j.ip);
    } catch (e) {
      out.ips.push('err:' + String((e && e.message) || e).slice(0, 40));
    }
  }
  const page = await fetchFull(src, {
    referer: 'https://egydead.ca/',
    timeout: 25000,
    headers: { 'User-Agent': VID_UA },
  });
  const text = (page.text || '').replace(/\\\//g, '/');
  const m = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
  out.dig = { code: page.status, hasM3u8: !!m };
  if (!m) return out;
  const master = m[0];
  try {
    const r1 = await fetch(master, {
      redirect: 'follow',
      headers: { 'User-Agent': VID_UA, Referer: src },
    });
    out.minimal = { code: r1.status, head: (await r1.text()).slice(0, 40) };
  } catch (e) {
    out.minimal = { error: String((e && e.message) || e).slice(0, 60) };
  }
  try {
    const r2 = await fetch(master, {
      redirect: 'follow',
      headers: { ...BROWSER_HEADERS, Referer: src },
    });
    out.full = { code: r2.status, head: (await r2.text()).slice(0, 40) };
  } catch (e) {
    out.full = { error: String((e && e.message) || e).slice(0, 60) };
  }
  return out;
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
    if (url.searchParams.get('stream') === '1') {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      const state = { aborted: false };
      res.on('close', () => {
        state.aborted = true;
      });
      const emit = (obj) => {
        if (state.aborted) return;
        try {
          res.write(`${JSON.stringify(obj)}\n`);
        } catch {
          state.aborted = true;
        }
      };
      try {
        await relayAnimeZidStream(vid, emit, state);
      } catch (e) {
        emit({ t: 'done', ok: false, error: String((e && e.message) || e) });
      }
      try {
        res.end();
      } catch {
        /* already closed */
      }
      return true;
    }
    try {
      const t0 = Date.now();
      const out = url.searchParams.get('fast') === '1'
        ? await relayAnimeZidFast(vid)
        : await relayAnimeZid(vid, url.searchParams.get('dig') === '1');
      if (out && out.diag) out.diag.totalMs = Date.now() - t0;
      sendJson(res, 200, out);
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
  if (url.pathname === '/relay/hits') {
    if (url.searchParams.get('k') !== HITS_KEY) {
      sendJson(res, 403, { ok: false, error: 'bad key' });
      return true;
    }
    sendJson(res, 200, { ok: true, hits: hitLog });
    return true;
  }
  if (url.pathname === '/relay/vid') {
    const src = url.searchParams.get('src');
    if (!src) {
      sendJson(res, 400, { ok: false, error: 'missing src param' });
      return true;
    }
    try {
      sendJson(res, 200, await relayVid(req, src));
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }
  if (url.pathname === '/relay/hls') {
    const target = b64d(url.searchParams.get('u'));
    const referer = b64d(url.searchParams.get('r'));
    if (!target) {
      sendJson(res, 400, { ok: false, error: 'missing u param' });
      return true;
    }
    try {
      await relayHls(req, res, target, referer);
    } catch (e) {
      if (!res.headersSent) {
        sendJson(res, 502, { ok: false, error: String((e && e.message) || e) });
      }
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
  if (url.pathname === '/relay/browsertest') {
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
      sendJson(res, 200, await relayBrowserTest(parsed.toString()));
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
