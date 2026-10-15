'use strict';
/**
 * EgyDead scraper - ported from the verified CloudStream provider (2026-10-15).
 *
 * Live-verified site structure (tv10.egydead.live, re-checked 2026-10-15):
 * - Content cards are a bare <a> wrapping <img> + <h1 class="BottomTitle"> +
 *   <span class="cat_name"> (archives wrap it in li.movieItem).
 * - Posts at /{slug}/, series at /serie/{slug}/, seasons at /season/{slug}/,
 *   episodes at /episode/{slug}/ (slug carries sXXeYY).
 * - Search: /?s={query}. Pagination: {base}?page={n}/.
 * - Watching is unlocked by POSTing View=1 to the same post URL; the watch
 *   view exposes .serversList li[data-link] embeds and the player iframe at
 *   .watchAreaMaster .holder iframe.
 * - The default host ("MegaMax", rotating *.top domains) is an Inertia/Vue
 *   app: its deferred "streams" prop (Inertia partial reload) lists, per
 *   quality, mirror links on well-known video hosts.
 */
const cheerio = require('cheerio');

const BASE = (process.env.EGYDEAD_BASE || 'https://tv10.egydead.live').replace(/\/+$/, '');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchText(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || 25000);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      body: opts.body,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en;q=0.8',
        ...(opts.referer ? { Referer: opts.referer } : {}),
        ...(opts.headers || {}),
      },
    });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function fixUrl(u) {
  if (!u) return null;
  u = String(u).trim();
  if (!u) return null;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return BASE + u;
  return u;
}

// ---------- id encoding ----------
// Stremio ids are opaque strings; we encode the EgyDead page URL so any
// catalog / meta / stream handler can recover it without a database.
const ID_PREFIX = 'egydead:';
function encodeId(url) {
  return ID_PREFIX + Buffer.from(url, 'utf8').toString('base64url');
}
function decodeId(id) {
  if (!id || typeof id !== 'string') return null;
  const raw = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
  try {
    const url = Buffer.from(raw, 'base64url').toString('utf8');
    return url.startsWith('http') ? url : null;
  } catch {
    return null;
  }
}

// ---------- cards / listings ----------
function detectKind(catName, href) {
  const cat = catName || '';
  if (href.includes('/episode/') || href.includes('/season/') || href.includes('/serie/')) return 'series';
  if (/مسلسل|برامج|برنامج|انمي|أنمي/.test(cat)) return 'series';
  return 'movie';
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const seen = new Map();
  $('li.movieItem > a, a:has(.BottomTitle)').each((_, el) => {
    const a = $(el);
    const href = fixUrl(a.attr('href'));
    if (!href || !href.startsWith(BASE)) return;
    if (/\/(type|category|series-category|year|quality|country|language|tag)\//.test(href)) return;
    const title = (a.find('h1.BottomTitle, .BottomTitle').first().text() || a.attr('title') || '').trim();
    if (!title) return;
    const poster = fixUrl(a.find('img').first().attr('src') || a.find('img').first().attr('data-src'));
    const catName = a.find('span.cat_name').first().text().trim();
    const yearMatch = title.match(/(19|20)\d{2}/);
    if (!seen.has(href)) {
      seen.set(href, {
        id: encodeId(href),
        type: detectKind(catName, href),
        name: cleanTitle(title),
        poster,
        releaseInfo: yearMatch ? yearMatch[0] : undefined,
        _href: href,
        _cat: catName,
      });
    }
  });
  return [...seen.values()];
}

/** Strip the site's Arabic framing ("مشاهدة فيلم X مترجم") down to the work's name. */
function cleanTitle(title) {
  return title
    .replace(/^مشاهدة\s+/, '')
    .replace(/^(فيلم|مسلسل|انمي|أنمي)\s+/, '')
    .replace(/\s+مترجم(ة)?\s*(كامل)?\s*$/g, '')
    .replace(/\s+مدبلج\s*$/g, '')
    .trim() || title;
}

async function fetchCatalogPage(pageUrl, page) {
  const url = page <= 1 ? pageUrl : `${pageUrl}?page=${page}/`;
  const html = await fetchText(url, { referer: BASE + '/' });
  return parseCards(html);
}

async function search(query) {
  const url = `${BASE}/?s=${encodeURIComponent(query)}`;
  const html = await fetchText(url, { referer: BASE + '/' });
  return parseCards(html);
}

// ---------- detail pages ----------
function pageMeta($) {
  const title =
    $('.singleTitle span em').first().text().trim() ||
    $('.singleTitle').first().text().trim() ||
    $('h1').first().text().trim();
  const poster =
    fixUrl($('.single-thumbnail img').first().attr('src')) ||
    fixUrl($('meta[property="og:image"]').attr('content'));
  const plot =
    $('.extra-content p').first().text().trim() || $('.singleStory').first().text().trim() || undefined;
  const yearText = $('.LeftBox a[href*="/year/"]').first().text().trim();
  const genres = [];
  $('.LeftBox a[href*="/type/"]').each((_, el) => {
    const t = $(el).text().trim();
    if (t) genres.push(t);
  });
  return { title, poster, plot, year: /^\d{4}$/.test(yearText) ? yearText : undefined, genres };
}

function episodeNumberOf(href, text) {
  const m = /\/episode\/[^/]*?e(\d{1,4})/i.exec(href || '');
  if (m) return parseInt(m[1], 10);
  const nums = (text || '').match(/\d{1,4}/g);
  return nums ? parseInt(nums[nums.length - 1], 10) : undefined;
}
function seasonNumberOf(href) {
  const m = /-s(\d{1,3})\b/i.exec(href || '');
  return m ? parseInt(m[1], 10) : undefined;
}

function parseEpisodes($, seasonNumber) {
  const byUrl = new Map();
  $('a[href*="/episode/"]').each((_, el) => {
    const a = $(el);
    const href = fixUrl(a.attr('href'));
    if (!href || !href.includes('/episode/') || byUrl.has(href)) return;
    const ep = episodeNumberOf(href, a.text());
    const season = seasonNumberOf(href) || seasonNumber || 1;
    byUrl.set(href, {
      id: encodeId(href),
      title: (a.text() || '').trim() || (ep ? `الحلقة ${ep}` : 'حلقة'),
      season: season || 1,
      episode: ep,
      released: undefined,
    });
  });
  return [...byUrl.values()].sort(
    (x, y) => (x.season - y.season) || ((x.episode || 1e9) - (y.episode || 1e9))
  );
}

async function fetchMeta(url) {
  const html = await fetchText(url, { referer: BASE + '/' });
  const $ = cheerio.load(html);
  const info = pageMeta($);

  if (url.includes('/serie/')) {
    const seasonLinks = new Map();
    $('a[href*="/season/"]').each((_, el) => {
      const href = fixUrl($(el).attr('href'));
      if (href && href.includes('/season/') && !seasonLinks.has(href)) {
        seasonLinks.set(href, seasonNumberOf(href));
      }
    });
    let videos = [];
    if (seasonLinks.size === 0) {
      videos = parseEpisodes($, 1);
    } else {
      let idx = 0;
      for (const [seasonUrl, seasonNum] of seasonLinks) {
        idx++;
        try {
          const sHtml = await fetchText(seasonUrl, { referer: url });
          videos = videos.concat(parseEpisodes(cheerio.load(sHtml), seasonNum || idx));
        } catch { /* skip a dead season page */ }
      }
      videos.sort((x, y) => (x.season - y.season) || ((x.episode || 1e9) - (y.episode || 1e9)));
    }
    return { info, videos, kind: 'series' };
  }

  if (url.includes('/season/')) {
    return { info, videos: parseEpisodes($, seasonNumberOf(url)), kind: 'series' };
  }

  if (url.includes('/episode/')) {
    const ep = episodeNumberOf(url, info.title);
    return {
      info,
      videos: [{ id: encodeId(url), title: info.title, season: seasonNumberOf(url) || 1, episode: ep }],
      kind: 'series',
    };
  }

  return { info, videos: [], kind: 'movie' };
}

// ---------- watch / streams ----------
function collectEmbeds($, into) {
  $('.serversList li').each((_, el) => {
    const link = ($(el).attr('data-link') || '').trim();
    if (link) into.add(fixUrl(link));
  });
  const iframe = $('.watchAreaMaster .holder iframe').first().attr('src');
  if (iframe && iframe.trim() && !/youtube\.com/.test(iframe)) into.add(fixUrl(iframe));
}

/**
 * Resolve a MegaMax embed page to its mirror list via the Inertia
 * partial reload verified for the CloudStream provider:
 * returns [{ quality, mirrors: [url, ...] }].
 */
async function megaMaxMirrors(embed, referer) {
  const pageText = await fetchText(embed, { referer });
  const m = /<script[^>]*data-page[^>]*>(\{.*?\})<\/script>/s.exec(pageText);
  if (!m) return [];
  let pageJson;
  try { pageJson = JSON.parse(m[1]); } catch { return []; }
  const version = pageJson.version;
  if (!version) return [];
  const component = pageJson.component || 'files/mirror/video';
  const streamsText = await fetchText(embed, {
    referer: embed,
    headers: {
      'X-Inertia': 'true',
      'X-Inertia-Version': version,
      'X-Inertia-Partial-Component': component,
      'X-Inertia-Partial-Data': 'streams',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  let streams;
  try { streams = JSON.parse(streamsText).props.streams; } catch { return []; }
  if (!streams || streams.status !== 'success' || !Array.isArray(streams.data)) return [];
  return streams.data.map((q) => ({
    quality: q.label || q.quality || '',
    mirrors: (q.mirrors || []).map((x) => fixUrl(x.link)).filter(Boolean),
  }));
}

/** All candidate embed URLs for a movie/episode page, mirrors expanded. */
async function fetchStreamCandidates(pageUrl) {
  const embeds = new Set();
  try {
    const body = new URLSearchParams({ View: '1' }).toString();
    const html = await fetchText(pageUrl, {
      method: 'POST',
      body,
      referer: pageUrl,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    collectEmbeds(cheerio.load(html), embeds);
  } catch { /* fall through to plain GET */ }
  if (embeds.size === 0) {
    try {
      const html = await fetchText(pageUrl, { referer: BASE + '/' });
      collectEmbeds(cheerio.load(html), embeds);
    } catch { /* nothing */ }
  }

  const candidates = []; // { embed, quality }
  for (const embed of embeds) {
    let expanded = false;
    if (/\/iframe\//.test(embed)) {
      try {
        const groups = await megaMaxMirrors(embed, pageUrl);
        for (const g of groups) {
          for (const mirror of g.mirrors) {
            candidates.push({ embed: mirror, quality: g.quality });
            expanded = true;
          }
        }
      } catch { /* keep the raw embed as fallback */ }
    }
    if (!expanded) candidates.push({ embed, quality: '' });
  }
  return candidates;
}

module.exports = {
  BASE,
  encodeId,
  decodeId,
  parseCards,
  fetchCatalogPage,
  search,
  fetchMeta,
  fetchStreamCandidates,
  cleanTitle,
};
