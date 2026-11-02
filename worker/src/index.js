// Slightly Epic Radio — stream + metadata proxy (Cloudflare Worker)
//
// Why this exists: most stations only stream over plain http://, and browsers
// refuse to play http audio inside an https page. This Worker relays those
// streams (and their now-playing metadata) over https.
//
// It is NOT an open proxy: it only relays URLs that appear in the published
// stations.json (env.STATIONS_URL). Adding a station in the Manager and
// pushing the web repo automatically allows it here within a few minutes.
//
// Routes:
//   GET /stream?u=<streamUrl>          → audio passthrough
//   GET /meta?u=<metaUrl>&type=<icecast|shoutcast>
//                                      → { artist, title, display }
//   GET /health                        → "ok"

const STATIONS_TTL_MS = 5 * 60 * 1000;
const META_TTL_MS = 15 * 1000;
const UA = 'SlightlyEpicRadioWeb/1.0 (+https://github.com/mrprice22)';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Type',
};

// Per-isolate memo caches (the Cache API is a no-op on workers.dev).
let stationsCache = { at: 0, list: null };
const metaCache = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405);

    try {
      switch (url.pathname) {
        case '/health': return text('ok');
        case '/stream': return await handleStream(url, request, env);
        case '/meta':   return await handleMeta(url, env, ctx);
        default:        return text('Not found', 404);
      }
    } catch (e) {
      return text(`Proxy error: ${e.message}`, 502);
    }
  },
};

// ─── allowlist ────────────────────────────────────────────────────────────────
async function getStations(env) {
  const now = Date.now();
  if (stationsCache.list && now - stationsCache.at < STATIONS_TTL_MS) return stationsCache.list;
  if (!env.STATIONS_URL) throw new Error('STATIONS_URL is not configured');
  const res = await fetch(env.STATIONS_URL, { headers: { 'User-Agent': UA }, cf: { cacheTtl: 60 } });
  if (!res.ok) {
    if (stationsCache.list) return stationsCache.list; // serve stale on failure
    throw new Error(`could not load stations.json (${res.status})`);
  }
  const data = await res.json();
  stationsCache = { at: now, list: Array.isArray(data.stations) ? data.stations : [] };
  return stationsCache.list;
}

// ─── /stream ──────────────────────────────────────────────────────────────────
async function handleStream(url, request, env) {
  const target = url.searchParams.get('u');
  if (!target) return text('Missing u', 400);
  const station = (await getStations(env)).find(s => s.streamUrl === target);
  if (!station) return text('Stream not in station list', 403);

  const upstream = await fetch(target, {
    method: request.method,
    headers: { 'User-Agent': UA, 'Icy-MetaData': '0', 'Accept': '*/*' },
    redirect: 'follow',
  });
  if (!upstream.ok) return text(`Upstream returned ${upstream.status}`, 502);

  const fallbackType = station.streamFormat === 'aac' ? 'audio/aac' : 'audio/mpeg';
  let type = upstream.headers.get('Content-Type') || fallbackType;
  if (!/^audio\/|^application\/ogg/i.test(type)) type = fallbackType; // some servers say text/html

  return new Response(upstream.body, {
    status: 200,
    headers: { ...CORS, 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

// ─── /meta ────────────────────────────────────────────────────────────────────
async function handleMeta(url, env, ctx) {
  const target = url.searchParams.get('u');
  if (!target) return text('Missing u', 400);
  const station = (await getStations(env)).find(s => s.metaUrl && s.metaUrl === target);
  if (!station) return text('Metadata URL not in station list', 403);
  const type = (station.metaType || url.searchParams.get('type') || 'none').toLowerCase();

  const cached = metaCache.get(target);
  if (cached && Date.now() - cached.at < META_TTL_MS) return json(cached.body);

  let np = { artist: '', title: '' };
  try {
    const res = await fetch(target, {
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const body = await res.text();
      if (type === 'icecast')   np = parseIcecast(body, station.streamUrl);
      if (type === 'shoutcast') np = parseShoutcast(body);
    }
  } catch (_) { /* fall through with empty metadata, same as the Android app */ }

  const out = { ...np, display: displayText(np) };
  metaCache.set(target, { at: Date.now(), body: out });
  if (metaCache.size > 200) metaCache.delete(metaCache.keys().next().value);
  return json(out);
}

// Ported from Slightly-Epic-Radio-Android-/…/data/MetadataFetcher.kt
function parseIcecast(body, streamUrl) {
  let data;
  try { data = JSON.parse(body); } catch { return { artist: '', title: '' }; }
  const src = data && data.icestats && data.icestats.source;
  let source = null;
  if (Array.isArray(src)) {
    // Multi-mount servers: prefer the mount that matches our stream, else first.
    let path = '';
    try { path = new URL(streamUrl).pathname; } catch {}
    source = src.find(s => path && typeof s.listenurl === 'string' && s.listenurl.endsWith(path)) || src[0];
  } else if (src && typeof src === 'object') {
    source = src;
  }
  if (!source) return { artist: '', title: '' };

  const yp = str(source.yp_currently_playing);
  if (yp) return parseTrack(yp);
  const title = str(source.title);
  if (title) return parseTrack(title);
  return { artist: '', title: stripHtml(str(source.server_description)) };
}

function parseShoutcast(body) {
  // 7.html: <body>listeners,status,peak,max,unique,bitrate,song title</body>
  const m = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!m) return { artist: '', title: '' };
  const parts = m[1].split(',');
  if (parts.length < 7) return { artist: '', title: '' };
  return parseTrack(parts.slice(6).join(',').trim());
}

function parseTrack(raw) {
  const cleaned = stripHtml(raw);
  const i = cleaned.indexOf(' - ');
  return i > 0
    ? { artist: cleaned.slice(0, i).trim(), title: cleaned.slice(i + 3).trim() }
    : { artist: '', title: cleaned.trim() };
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<\/?br\s*\/?>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();
}

function displayText({ artist, title }) {
  if (artist && title) return `${artist} - ${title}`;
  return title || '';
}

const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=15' },
  });
}
function text(msg, status = 200) {
  return new Response(msg, { status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
}
