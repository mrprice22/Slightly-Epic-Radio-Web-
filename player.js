// Slightly Epic Radio — embeddable player
// URL params (all optional):
//   station=<id | title-slug>   e.g. ?station=zen-garden
//   theme=light|dark|auto       (default auto)
//   accent=<hex>                e.g. ?accent=ff6a3d
(function () {
  'use strict';

  var CFG = window.SER_CONFIG || {};
  var PROXY = (CFG.PROXY_BASE || '').replace(/\/+$/, '');
  var POLL_MS = CFG.META_POLL_MS || 20000;
  var params = new URLSearchParams(location.search);

  var $ = function (id) { return document.getElementById(id); };
  var player = $('player'), audio = $('audio'), sel = $('station'), playBtn = $('play');
  var logo = $('logo'), npTrack = $('np-track'), npText = $('np-text');
  var vol = $('volume'), muteBtn = $('mute'), volWrap = document.querySelector('.vol');

  var stations = [];
  var current = null;      // station object
  var wantPlaying = false; // user intent
  var triedProxy = false;  // per-attempt fallback flag for https streams
  var metaTimer = null, metaAbort = null;
  var lastVolume = 80;

  // ── storage (may throw in private mode / blocked storage) ────────────────
  var store = {
    get: function (k) { try { return localStorage.getItem('ser.' + k); } catch (_) { return null; } },
    set: function (k, v) { try { localStorage.setItem('ser.' + k, v); } catch (_) {} },
  };

  // ── theme / accent ───────────────────────────────────────────────────────
  var theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  var accent = params.get('accent');
  if (accent && /^#?[0-9a-f]{3,8}$/i.test(accent)) {
    document.documentElement.style.setProperty('--accent', accent[0] === '#' ? accent : '#' + accent);
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function setState(s) { player.dataset.state = s; }

  function streamSrc(st, viaProxy) {
    var direct = /^https:/i.test(st.streamUrl);
    if (direct && !viaProxy) return st.streamUrl;
    return PROXY + '/stream?u=' + encodeURIComponent(st.streamUrl);
  }

  var npFull = '';
  function setNowPlaying(text) {
    if (text === npFull) return;
    npFull = text;
    npTrack.classList.remove('scroll');
    npText.textContent = text;
    // Scroll only if it overflows; duplicate the text for a seamless loop.
    requestAnimationFrame(function () {
      if (npText.scrollWidth > npTrack.clientWidth + 2) {
        npText.textContent = '';
        for (var i = 0; i < 2; i++) { var b = document.createElement('b'); b.textContent = text; npText.appendChild(b); }
        npTrack.style.setProperty('--marquee-dur', Math.max(8, text.length * 0.28) + 's');
        npTrack.classList.add('scroll');
      }
    });
  }

  function idleText() { return current ? current.title : 'Slightly Epic Radio'; }

  // ── stations ─────────────────────────────────────────────────────────────
  function loadStations() {
    return fetch('stations.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) { stations = (data.stations || []).filter(function (s) { return s.streamUrl; }); });
  }

  function pickInitial() {
    var want = params.get('station');
    if (want) {
      var byId = stations.find(function (s) { return String(s.id) === want; });
      var bySlug = stations.find(function (s) { return slug(s.title) === slug(want); });
      if (byId || bySlug) return byId || bySlug;
    }
    var saved = store.get('station'); // stored by stream URL: ids shift when reordered
    return stations.find(function (s) { return s.streamUrl === saved; }) || stations[0];
  }

  function renderSelect() {
    sel.textContent = '';
    stations.forEach(function (s, i) {
      var o = document.createElement('option');
      o.value = String(i); o.textContent = s.title;
      sel.appendChild(o);
    });
    sel.disabled = false; playBtn.disabled = false;
  }

  function showStation(st) {
    current = st;
    sel.value = String(stations.indexOf(st));
    if (st.logo) {
      logo.hidden = false;
      logo.src = st.logo;
    } else {
      logo.hidden = true; logo.removeAttribute('src');
    }
    if (player.dataset.state !== 'playing') setNowPlaying(idleText());
    updateMediaSession('');
  }
  logo.addEventListener('error', function () { logo.hidden = true; });

  // ── playback ─────────────────────────────────────────────────────────────
  function start() {
    if (!current) return;
    wantPlaying = true;
    triedProxy = false;
    setState('loading');
    setNowPlaying('Connecting…');
    audio.src = streamSrc(current, false);
    var p = audio.play();
    if (p && p.catch) p.catch(function (err) {
      if (err && err.name === 'NotAllowedError') { stop(); return; }
      // other failures surface through the 'error' event
    });
  }

  function stop() {
    wantPlaying = false;
    // Drop the connection entirely: a paused live stream keeps downloading,
    // and resuming would play stale audio.
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    stopMeta();
    setState('idle');
    setNowPlaying(idleText());
    playBtn.setAttribute('aria-pressed', 'false');
    playBtn.setAttribute('aria-label', 'Play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }

  audio.addEventListener('playing', function () {
    if (!wantPlaying) return;
    setState('playing');
    playBtn.setAttribute('aria-pressed', 'true');
    playBtn.setAttribute('aria-label', 'Pause');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    if (!metaTimer) startMeta();
  });
  audio.addEventListener('waiting', function () { if (wantPlaying) setState('loading'); });
  audio.addEventListener('error', function () {
    if (!wantPlaying || !audio.getAttribute('src')) return;
    // https stream failed directly (bad cert, CORS-less redirect, etc.) → try the proxy once.
    if (!triedProxy && /^https:/i.test(current.streamUrl) && PROXY) {
      triedProxy = true;
      audio.src = streamSrc(current, true);
      audio.play().catch(function () {});
      return;
    }
    wantPlaying = false;
    stopMeta();
    setState('error');
    setNowPlaying('Station offline — try another');
    playBtn.setAttribute('aria-pressed', 'false');
    playBtn.setAttribute('aria-label', 'Play');
  });
  audio.addEventListener('ended', function () { if (wantPlaying) start(); }); // stream dropped → reconnect

  playBtn.addEventListener('click', function () {
    if (wantPlaying) stop(); else start();
  });

  sel.addEventListener('change', function () {
    var st = stations[Number(sel.value)];
    if (!st) return;
    store.set('station', st.streamUrl);
    var wasPlaying = wantPlaying;
    if (wasPlaying) { stopMeta(); npFull = ''; }
    showStation(st);
    if (wasPlaying) start();
    else if (player.dataset.state === 'error') { setState('idle'); setNowPlaying(idleText()); }
  });

  // ── now playing ──────────────────────────────────────────────────────────
  function startMeta() {
    stopMeta();
    if (!current || !current.metaUrl || current.metaType === 'none' || !PROXY) {
      setNowPlaying(current ? current.title : '');
      updateMediaSession('');
      metaTimer = -1; // mark as "running" so 'playing' events don't restart it
      return;
    }
    var st = current;
    var tick = function () {
      if (metaAbort) metaAbort.abort();
      metaAbort = new AbortController();
      fetch(PROXY + '/meta?u=' + encodeURIComponent(st.metaUrl) + '&type=' + encodeURIComponent(st.metaType),
            { signal: metaAbort.signal })
        .then(function (r) { return r.ok ? r.json() : { display: '' }; })
        .then(function (m) {
          if (st !== current || !wantPlaying) return;
          var text = (m && m.display) || st.title;
          setNowPlaying(text);
          updateMediaSession(m && m.display ? m : '');
        })
        .catch(function () { if (st === current && wantPlaying) setNowPlaying(st.title); });
    };
    tick();
    metaTimer = setInterval(tick, POLL_MS);
  }
  function stopMeta() {
    if (metaTimer && metaTimer !== -1) clearInterval(metaTimer);
    metaTimer = null;
    if (metaAbort) { metaAbort.abort(); metaAbort = null; }
  }

  // ── Media Session (OS / lock-screen controls) ────────────────────────────
  function updateMediaSession(meta) {
    if (!('mediaSession' in navigator) || !current) return;
    try {
      var art = current.logo ? [{ src: new URL(current.logo, location.href).href }] : [];
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta && meta.title ? meta.title : current.title,
        artist: meta && meta.artist ? meta.artist : (meta ? current.title : 'Slightly Epic Radio'),
        album: current.title,
        artwork: art,
      });
    } catch (_) {}
  }
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', function () { if (!wantPlaying) start(); });
      navigator.mediaSession.setActionHandler('pause', function () { if (wantPlaying) stop(); });
      navigator.mediaSession.setActionHandler('stop', function () { if (wantPlaying) stop(); });
    } catch (_) {}
  }

  // ── volume ───────────────────────────────────────────────────────────────
  function applyVolume(v, save) {
    v = Math.max(0, Math.min(100, Math.round(v)));
    vol.value = String(v);
    vol.style.setProperty('--fill', v + '%');
    audio.volume = v / 100;
    audio.muted = v === 0;
    volWrap.dataset.level = v === 0 ? 'muted' : v < 45 ? 'low' : 'high';
    muteBtn.setAttribute('aria-label', v === 0 ? 'Unmute' : 'Mute');
    if (v > 0) lastVolume = v;
    if (save) store.set('volume', String(v));
  }
  vol.addEventListener('input', function () { applyVolume(Number(vol.value), true); });
  muteBtn.addEventListener('click', function () {
    applyVolume(Number(vol.value) === 0 ? (lastVolume || 80) : 0, true);
  });

  // ── report height to the embedding page (optional auto-resize) ───────────
  if (window.parent !== window && 'ResizeObserver' in window) {
    new ResizeObserver(function () {
      window.parent.postMessage({ type: 'slightly-epic-radio:height', height: Math.ceil(player.getBoundingClientRect().height) + 2 }, '*');
    }).observe(player);
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  var savedVol = Number(store.get('volume'));
  applyVolume(store.get('volume') !== null && !isNaN(savedVol) ? savedVol : 80, false);

  loadStations().then(function () {
    if (!stations.length) throw new Error('empty');
    renderSelect();
    showStation(pickInitial());
  }).catch(function () {
    sel.textContent = '';
    var o = document.createElement('option'); o.textContent = 'Stations unavailable'; sel.appendChild(o);
    setState('error');
    setNowPlaying('Could not load the station list');
  });
})();
