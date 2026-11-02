// Slightly Epic Radio — web player config.
//
// PROXY_BASE is the deployed Cloudflare Worker (see worker/). It relays http://
// streams over https and serves parsed now-playing metadata.
// When the player is opened from localhost it uses `wrangler dev` instead.
(function () {
  var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  window.SER_CONFIG = {
    PROXY_BASE: local
      ? 'http://127.0.0.1:8787'
      : 'https://slightly-epic-radio-proxy.jamesprice-slightlyepic.workers.dev',
    META_POLL_MS: 20000, // same interval as the Android app
  };
})();
