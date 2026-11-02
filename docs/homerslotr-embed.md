# Brief: add the Slightly Epic Radio bar to homerslotr.com

For whoever maintains the wiki generator (`nwn-manager wiki` in `GIT/nwn_manager`). The player needs no server work. This is a small change to the generated site's `site.js` and stylesheet.

## What the site gets

- **A slim (54px) radio bar** fixed to the bottom of every page: station dropdown, play/pause, volume, logo and now-playing.
- **Playback carries over from page to page.** When a visitor clicks a link while listening, the bar on the next page picks the same station back up. That takes about a second in Chrome and Edge. In Firefox and Safari, which block automatic sound, it shows *Tap ▶ to keep listening*. The player handles all of this itself.
- **Returning visitors get their last station.** The player remembers it in its own storage, so the site needs no cookies or code for this.
- **First-time visitors get the admin's default station**, set via a `default=` parameter the site controls.

## 1. Inject the bar from `site.js` (generator template)

Every page already loads `assets/site.js`, so add this there and call `initRadio()` from the existing `DOMContentLoaded` handler, next to `initNav`, `initMap` and the rest. This is a single change, with no need to touch the ~11k page templates.

```js
/* ── Radio bar ──────────────────────────────────────────────────────────────
 * Slightly Epic Radio, docked along the bottom of every page. The player
 * remembers each visitor's station and carries playback over page loads by
 * itself; the site only places it. RADIO_DEFAULT is the station first-time
 * visitors get (slug from the table in this brief; '' = the player's first). */
const RADIO_DEFAULT = '';   // ← filled from WIKI_RADIO_DEFAULT_STATION by the generator
const RADIO_PLAYER  = 'https://slightly-epic-radio-web.jamesprice-slightlyepic.workers.dev/player.html';

function initRadio() {
  if (document.querySelector('main[data-no-radio]')) return;          // per-page opt-out
  try { if (localStorage.getItem('radio-hidden') === '1') return; } catch (e) {}

  const q = new URLSearchParams({ size: 'slim', theme: 'dark', accent: 'c8a045' });
  if (RADIO_DEFAULT) q.set('default', RADIO_DEFAULT);

  const f = document.createElement('iframe');
  f.className = 'radio-bar';
  f.title = 'Slightly Epic Radio';
  f.src = RADIO_PLAYER + '?' + q.toString();
  f.allow = 'autoplay; encrypted-media';   // required: lets playback resume after a link click
  document.body.appendChild(f);
  document.documentElement.classList.add('has-radio');
}
```

## 2. CSS (`style.css` or `theme.css`)

```css
iframe.radio-bar {
  position: fixed; left: 0; right: 0; bottom: 0;
  width: 100%; height: 54px; border: 0;
  z-index: 90;            /* below the nav dropdowns (100 / 102), so menus aren't covered */
  color-scheme: dark;
}
html.has-radio body { padding-bottom: 54px; }   /* keep the footer clear of the bar */
```

- **`accent=c8a045`** is the site's NWN gold (`--accent` in `theme.css`), and `theme=dark` matches the near-black background.
- **Don't add `loading="lazy"`.** The bar is always in view, and lazy loading would only delay it.

## 3. Admin default station

- **Add one setting**, e.g. `WIKI_RADIO_DEFAULT_STATION` (season block or generator config), and have the generator write it into `RADIO_DEFAULT`. Empty means no default, and the player starts on its first station.
- **A change takes effect at the next wiki refresh** (when `site.js` is regenerated).
- **Precedence:** the default only applies to visitors who have never picked or played a station on homerslotr.com. Everyone else keeps their own.

| Slug for `default=` | id | Station |
|---|---|---|
| `todd-s-rockn-blues` | 0 | Todd's Rockn'Blues |
| `edm-techno-forever` | 2 | EDM Techno Forever |
| `electronic-dance-radio` | 3 | Electronic Dance Radio |
| `classical-public-domain-radio` | 4 | Classical Public Domain Radio |
| `the-epic-channel` | 5 | The Epic Channel |
| `uturn-classic-rock` | 7 | UTurn Classic Rock |
| `alternative` | 8 | Alternative |
| `stacey-radio` | 9 | Stacey Radio |
| `time-2-chill-radio` | 12 | Time 2 Chill Radio |
| `ultimate-chill-pop` | 13 | Ultimate Chill (Pop) |
| `the-jazz-groove` | 14 | The Jazz Groove |
| `zen-garden` | 15 | Zen Garden |
| `synthetic-fm` | 16 | Synthetic FM |
| `synthetic-fm-ita` | 17 | Synthetic FM (ITA) |
| `radio-popolare-ita` | 18 | Radio Popolare (ITA) |
| `spooky-audio-machine` | 19 | Spooky Audio Machine |
| `thursday-game-night` | 20 | Thursday Game Night |
| `pac-man-audio-chaos` | 21 | PAC-MAN Audio Chaos |

The slug is the station title lowercased, with each run of other characters replaced by `-`. An unknown slug falls back to the first station; it never breaks the bar. The live list is always in `stations.json`.

## 4. Optional extras

- **Per-page opt-out:** add `data-no-radio` to a page's `<main>` to leave the bar off that page.
- **"Hide radio" toggle:** a small footer link that does `localStorage.setItem('radio-hidden','1'); location.reload()`, plus a matching "show" link. This is the site's own storage and purely site-side.
- **Nicer address, and steadier storage:** in the Cloudflare dashboard, add a custom domain such as `radio.homerslotr.com` to the `slightly-epic-radio-web` Worker, then use that in `RADIO_PLAYER`. The player then counts as the same site as homerslotr.com, which browsers are more relaxed about for storage and autoplay. Nothing in the player changes.

## 5. Later, if gap-free playback is wanted (phase 2, optional)

Any full page load reloads the bar, so there will always be roughly a one-second gap, plus the tap prompt in Firefox and Safari. Removing the gap entirely needs the site to stop doing full page loads for internal links:

- In `site.js`, intercept same-origin `<a>` clicks, `fetch()` the target page and parse it.
- Replace the current `<main>` and `<title>` with the new ones, `history.pushState()`, and handle `popstate` for back and forward.
- Re-run the per-page initialisers (`initMap()`, the search pages' setup, footer timestamp, online badge).
- Fall back to a normal navigation for pages with their own inline scripts (`items/search.html`, `creatures/search.html`), for downloads and external links, and whenever anything throws.

Because the radio iframe sits outside `<main>`, it is never touched, so playback never stops. This touches every page's behaviour, so it's worth doing only if the one-second gap bothers people.

## How to check it

1. Open any wiki page: the gold-accented bar sits at the bottom, and the footer is fully visible above it.
2. Press play, then click a nav link. In Chrome or Edge, music resumes on the new page within about a second. In Firefox or Safari, the bar shows *Tap ▶ to keep listening*, and one tap resumes.
3. Pause, then click a link: the next page stays paused.
4. In a private window with `WIKI_RADIO_DEFAULT_STATION` set, the bar opens on that station. Pick another, reload, and your pick sticks.
5. Hover the nav dropdowns: the menus draw over the bar, not under it.
