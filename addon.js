'use strict';
/**
 * EgyDead addon for Stremio.
 * Catalogs / meta / search are scraped from tv10.egydead.live; streams are
 * resolved through the site's MegaMax mirror list and per-host extractors.
 */
const http = require('http');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const egy = require('./src/egydead');
const { extractDirect, hostName } = require('./src/extractors');
const { handleRelayRequest } = require('./src/relay');

const B = egy.BASE;

// Catalog definitions mirror the site's own menus (verified live 2026-10-15).
const MOVIE_CATS = [
  ['latest', `${B}/page/movies/`, 'أفلام - المضاف حديثاً'],
  ['english', `${B}/category/english-movies/`, 'أفلام أجنبية'],
  ['dubbed', `${B}/category/english-movies/%d8%a7%d9%81%d9%84%d8%a7%d9%85-%d8%a7%d8%ac%d9%86%d8%a8%d9%8a%d8%a9-%d9%85%d8%af%d8%a8%d9%84%d8%ac%d8%a9/`, 'أفلام أجنبية مدبلجة'],
  ['cartoon', `${B}/category/%d8%a7%d9%81%d9%84%d8%a7%d9%85-%d9%83%d8%b1%d8%aa%d9%88%d9%86/`, 'أفلام كرتون'],
  ['asian', `${B}/category/%d8%a7%d9%81%d9%84%d8%a7%d9%85-%d8%a7%d8%b3%d9%8a%d9%88%d9%8a%d8%a9/`, 'أفلام آسيوية'],
  ['documentary', `${B}/category/%d8%a7%d9%81%d9%84%d8%a7%d9%85-%d9%88%d8%ab%d8%a7%d8%a6%d9%82%d9%8a%d8%a9/`, 'أفلام وثائقية'],
  ['hindi', `${B}/category/hindi-movies/`, 'أفلام هندية'],
  ['turkish', `${B}/category/%d8%a7%d9%81%d9%84%d8%a7%d9%85-%d8%aa%d8%b1%d9%83%d9%8a%d8%a9/`, 'أفلام تركية'],
  ['anime', `${B}/category/%d8%a7%d9%81%d9%84%d8%a7%d9%85-%d8%a7%d9%86%d9%85%d9%8a/`, 'أفلام أنمي'],
  ['arabic', `${B}/category/%d8%a7%d9%81%d9%84%d8%a7%d9%85-%d8%b9%d8%b1%d8%a8%d9%8a/`, 'أفلام عربية'],
];
const SERIES_CATS = [
  ['latest', `${B}/series-category/english-series/`, 'مسلسلات أجنبية'],
  ['arabic', `${B}/series-category/arabic-series/`, 'مسلسلات عربية'],
  ['turkish', `${B}/series-category/turkish-series/`, 'مسلسلات تركية'],
  ['asian', `${B}/series-category/asian-series/`, 'مسلسلات آسيوية'],
  ['anime', `${B}/series-category/anime-series/`, 'مسلسلات أنمي'],
  ['cartoon', `${B}/series-category/cartoon-series/`, 'مسلسلات كرتون'],
  ['indian', `${B}/series-category/indian-series/`, 'مسلسلات هندية'],
  ['dubbed', `${B}/series-category/english-series-dubbed/`, 'مسلسلات أجنبية مدبلجة'],
  ['tvshows', `${B}/series-category/tv-shows/`, 'برامج تلفزيونية'],
];

const catalogDefs = new Map();
const catalogs = [];
for (const [key, url, name] of MOVIE_CATS) {
  const id = `egydead.movies.${key}`;
  catalogDefs.set(id, { url, kind: 'movie' });
  catalogs.push({ type: 'movie', id, name: `EgyDead | ${name}`, extra: [{ name: 'search' }, { name: 'skip' }] });
}
for (const [key, url, name] of SERIES_CATS) {
  const id = `egydead.series.${key}`;
  catalogDefs.set(id, { url, kind: 'series' });
  catalogs.push({ type: 'series', id, name: `EgyDead | ${name}`, extra: [{ name: 'search' }, { name: 'skip' }] });
}

const manifest = {
  id: 'live.egydead.stremio',
  version: '1.0.0',
  name: 'EgyDead',
  description: 'أفلام ومسلسلات وأنمي مترجمة من EgyDead - movies, series & anime with Arabic subtitles',
  logo: 'https://tv10.egydead.live/wp-content/uploads/2019/01/cropped-yXYdE2f-192x192.png',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  catalogs,
  idPrefixes: ['egydead'],
  behaviorHints: { configurable: false },
};

const builder = new addonBuilder(manifest);

// ---------- tiny TTL cache ----------
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = Promise.resolve().then(fn).catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

const PAGE_SIZE = 25;
async function catalogItems(def) {
  // Aggregate the first 3 site pages (~144 cards) once, then slice by the
  // client's skip so pagination stays consistent while the cache lives.
  const all = [];
  const seen = new Set();
  for (let p = 1; p <= 3; p++) {
    const items = await egy.fetchCatalogPage(def.url, p);
    if (items.length === 0) break;
    for (const it of items) {
      if (it.type !== def.kind) continue;
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      all.push(it);
    }
  }
  return all;
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const def = catalogDefs.get(id);
  if (!def) return { metas: [] };
  const skip = parseInt((extra && extra.skip) || '0', 10) || 0;

  let items;
  if (extra && extra.search) {
    items = (await egy.search(extra.search)).filter((it) => it.type === type);
    return { metas: items.slice(0, PAGE_SIZE).map(toMetaPreview) };
  }
  items = await cached(`cat:${id}`, 10 * 60 * 1000, () => catalogItems(def));
  return { metas: items.slice(skip, skip + PAGE_SIZE).map(toMetaPreview) };
});

function toMetaPreview(it) {
  return {
    id: it.id,
    type: it.type,
    name: it.name,
    poster: it.poster || undefined,
    releaseInfo: it.releaseInfo,
    posterShape: 'poster',
  };
}

builder.defineMetaHandler(async ({ type, id }) => {
  const url = egy.decodeId(id);
  if (!url) return { meta: {} };
  const { info, videos, kind } = await cached(`meta:${url}`, 30 * 60 * 1000, () => egy.fetchMeta(url));
  const meta = {
    id,
    type: kind === 'series' ? 'series' : 'movie',
    name: egy.cleanTitle(info.title || 'EgyDead'),
    poster: info.poster || undefined,
    background: info.poster || undefined,
    description: info.plot,
    releaseInfo: info.year,
    genres: info.genres && info.genres.length ? info.genres : undefined,
  };
  if (meta.type === 'series') {
    meta.videos = videos.map((v) => ({
      id: v.id,
      title: v.title || `الحلقة ${v.episode || ''}`.trim(),
      season: v.season || 1,
      episode: v.episode || 1,
      released: v.released || new Date(0).toISOString(),
    }));
  }
  return { meta };
});

builder.defineStreamHandler(async ({ id }) => {
  const url = egy.decodeId(id);
  if (!url) return { streams: [] };
  const streams = await cached(`streams:${url}`, 5 * 60 * 1000, () => resolveStreams(url));
  return { streams };
});

async function resolveStreams(pageUrl) {
  const candidates = await egy.fetchStreamCandidates(pageUrl);
  const direct = [];
  const external = [];
  const queue = [...candidates];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const cand = queue.shift();
      const host = hostName(cand.embed);
      const label = [host, cand.quality].filter(Boolean).join(' ');
      let files = [];
      try { files = await extractDirect(cand.embed, pageUrl); } catch { files = []; }
      if (files.length) {
        for (const f of files) {
          let origin = '';
          try { origin = new URL(cand.embed).origin; } catch { /* ignore */ }
          direct.push({
            name: `EgyDead | ${label}`,
            title: `${label} - ${f.kind.toUpperCase()}`,
            url: f.url,
            behaviorHints: {
              notWebReady: false,
              proxyHeaders: {
                request: {
                  Referer: origin ? origin + '/' : cand.embed,
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
                },
              },
            },
          });
        }
      } else {
        external.push({
          name: `EgyDead | ${label}`,
          title: `${label} - فتح في المتصفح`,
          externalUrl: cand.embed,
          _host: host,
        });
      }
    }
  });
  await Promise.all(workers);
  // Direct playable streams first; browser fallbacks last, one per host
  // (the same host repeats across qualities and would flood the list).
  const seenHosts = new Set();
  const externalDeduped = external
    .filter((s) => {
      if (seenHosts.has(s._host)) return false;
      seenHosts.add(s._host);
      return true;
    })
    .map(({ _host, ...rest }) => rest);
  return [...direct, ...externalDeduped];
}

const port = parseInt(process.env.PORT || '7000', 10);

// One HTTP server for everything on this port: the Stremio addon protocol
// (SDK router), the addon's landing page, and the /relay/* JSON endpoints
// the CloudStream providers use for their server-side playback unlock.
const addonRouter = getRouter(builder.getInterface());
let landingHTML = null;
try {
  landingHTML = require('stremio-addon-sdk/src/landingTemplate')(manifest);
} catch {
  landingHTML = null; // cosmetic only; the addon works without it
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (url.pathname.startsWith('/relay/')) {
    handleRelayRequest(req, res, url)
      .then((handled) => {
        if (!handled && !res.writableEnded) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'unknown relay route' }));
        }
      })
      .catch((e) => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
        }
      });
    return;
  }
  if ((url.pathname === '/' || url.pathname === '') && landingHTML) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(landingHTML);
    return;
  }
  addonRouter(req, res, () => {
    if (!res.writableEnded) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ err: 'not found' }));
    }
  });
});
server.listen(port, () => {
  console.log(`EgyDead Stremio addon listening on http://localhost:${port}/manifest.json`);
});
