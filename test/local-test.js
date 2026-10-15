'use strict';
/**
 * End-to-end local test against the LIVE EgyDead site:
 * manifest -> movie catalog -> meta -> streams (must contain a direct file),
 * then series catalog -> meta (must contain videos) -> first episode streams.
 * Usage: node addon.js &  then  node test/local-test.js [baseUrl]
 */
const BASE = process.argv[2] || 'http://localhost:7000';

async function get(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}
function enc(json) {
  return encodeURIComponent(JSON.stringify(json));
}

(async () => {
  const manifest = await get('/manifest.json');
  console.log('manifest:', manifest.id, manifest.version, 'catalogs:', manifest.catalogs.length);
  if (!manifest.catalogs.length) throw new Error('no catalogs');

  // --- movie flow ---
  const cat = await get('/catalog/movie/egydead.movies.english.json');
  console.log('movie catalog items:', cat.metas.length);
  if (!cat.metas.length) throw new Error('empty movie catalog');
  const movie = cat.metas[0];
  console.log(' first movie:', movie.name, movie.id.slice(0, 40) + '...');

  const meta = await get(`/meta/movie/${movie.id}.json`);
  console.log(' movie meta:', meta.meta.name, '| poster:', !!meta.meta.poster);

  const streams = await get(`/stream/movie/${movie.id}.json`);
  const direct = streams.streams.filter((s) => s.url);
  const ext = streams.streams.filter((s) => s.externalUrl);
  console.log(' movie streams: direct =', direct.length, '| external =', ext.length);
  for (const s of direct.slice(0, 6)) console.log('   ', s.name, '->', s.url.slice(0, 110));
  if (!direct.length) throw new Error('NO DIRECT STREAM for movie');

  // Verify the first direct stream actually answers.
  const head = await fetch(direct[0].url, {
    headers: (direct[0].behaviorHints && direct[0].behaviorHints.proxyHeaders
      ? direct[0].behaviorHints.proxyHeaders.request : {}),
  }).catch((e) => null);
  console.log(' first direct stream HTTP:', head && head.status, head && head.headers.get('content-type'));

  // --- series flow ---
  const scat = await get('/catalog/series/egydead.series.latest.json');
  console.log('series catalog items:', scat.metas.length);
  if (!scat.metas.length) throw new Error('empty series catalog');
  // Find a full series entry (serie page) for the deepest test.
  let seriesMeta = null;
  let chosen = null;
  for (const item of scat.metas.slice(0, 8)) {
    const m = await get(`/meta/series/${item.id}.json`);
    if (m.meta && Array.isArray(m.meta.videos) && m.meta.videos.length) {
      seriesMeta = m.meta; chosen = item; break;
    }
  }
  if (!seriesMeta) throw new Error('no series with videos in first 8 catalog items');
  console.log(' series:', seriesMeta.name, '| videos:', seriesMeta.videos.length);
  const ep = seriesMeta.videos[0];
  const estreams = await get(`/stream/series/${ep.id}.json`);
  const edirect = estreams.streams.filter((s) => s.url);
  console.log(' episode streams: direct =', edirect.length, '| external =', estreams.streams.length - edirect.length);
  for (const s of edirect.slice(0, 4)) console.log('   ', s.name, '->', s.url.slice(0, 110));
  if (!edirect.length) throw new Error('NO DIRECT STREAM for episode');

  console.log('ALL TESTS PASSED');
})().catch((e) => {
  console.error('TEST FAILED:', e.message);
  process.exit(1);
});
