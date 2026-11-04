// Matomo di prova: legge la coda _paq, rispetta "disableCookies" (nessun cookie _pk_*), invia un solo hit di pageview
// al caricamento con sendBeacon e il parametro _id vuoto, come il tracker reale in modalità senza cookie.
(function () {
  var q = window._paq || [];
  var cfg = { cookies: true, url: '/matomo.php', site: '1', pageview: false };
  q.forEach(function (c) {
    if (c[0] === 'disableCookies') cfg.cookies = false;
    if (c[0] === 'setTrackerUrl') cfg.url = c[1];
    if (c[0] === 'setSiteId') cfg.site = c[1];
    if (c[0] === 'trackPageView') cfg.pageview = true;
  });
  var tracker = { hasCookies: function () { return cfg.cookies; }, isConsentRequired: function () { return false; } };
  window.Matomo = { getAsyncTrackers: function () { return [tracker]; } };
  if (cfg.cookies) document.cookie = '_pk_id.' + cfg.site + '.abcd=0123456789abcdef.1700000000.; max-age=33696000; path=/';
  if (cfg.pageview) {
    var id = cfg.cookies ? '0123456789abcdef' : '';
    navigator.sendBeacon(cfg.url + '?idsite=' + cfg.site + '&rec=1&r=123456&_id=' + id + '&url=' + encodeURIComponent(location.href) + '&action_name=' + encodeURIComponent(document.title));
  }
})();
