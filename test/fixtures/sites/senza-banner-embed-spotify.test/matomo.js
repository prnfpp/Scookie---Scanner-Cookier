// Matomo di prova senza "disableCookies" nella coda _paq ma senza cookie (modalità impostata lato server o nel
// plugin): hasCookies() è falso, nessun cookie _pk_*, parametro _id vuoto.
(function () {
  var q = window._paq || [];
  var cfg = { url: '/matomo.php', site: '1', pageview: false };
  q.forEach(function (c) {
    if (c[0] === 'setTrackerUrl') cfg.url = c[1];
    if (c[0] === 'setSiteId') cfg.site = c[1];
    if (c[0] === 'trackPageView') cfg.pageview = true;
  });
  var tracker = { hasCookies: function () { return false; }, isConsentRequired: function () { return false; } };
  window.Matomo = { getAsyncTrackers: function () { return [tracker]; } };
  if (cfg.pageview) navigator.sendBeacon(cfg.url + '?idsite=' + cfg.site + '&rec=1&r=654321&_id=&url=' + encodeURIComponent(location.href));
})();
