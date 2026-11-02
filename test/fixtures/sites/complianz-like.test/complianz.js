// Gestore del consenso di prova con il markup e i cookie di Complianz. Il banner resta nel DOM dopo la scelta:
// chiuso = classe cmplz-dismissed (trasparente e spostato fuori dallo schermo), mostrato = cmplz-show.
(function () {
  var get = function (n) { var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; };
  var set = function (n, v) { document.cookie = n + '=' + v + '; max-age=31536000; path=/'; };
  window.complianz = { version: 'prova' };
  window.cmplz_set_cookie = set;
  var css = document.createElement('style');
  css.textContent =
    '.cmplz-cookiebanner{position:fixed;bottom:16px;left:16px;width:520px;background:#fff;border:1px solid #ccc;padding:16px;z-index:999;font:15px sans-serif;transition:none}' +
    '.cmplz-cookiebanner.cmplz-hidden{display:none}' +
    '.cmplz-cookiebanner.cmplz-dismissed{opacity:0;transform:translateY(200%);pointer-events:none}' +
    '.cmplz-header{display:flex;justify-content:space-between}.cmplz-close{background:none;border:0;width:28px;height:28px;cursor:pointer}' +
    '.cmplz-categories{display:none}.cmplz-categories.cmplz-fade-in{display:block}' +
    '.cmplz-btn{width:155px;height:45px;margin-right:10px;border:1px solid #ddd;font-size:15px}.cmplz-accept{background:#3b29ff;color:#fff}.cmplz-deny{background:#f9f9f9;color:#222}' +
    '.cmplz-save-preferences{display:none}.cmplz-categories-visible .cmplz-save-preferences{display:inline-block}.cmplz-categories-visible .cmplz-view-preferences{display:none}' +
    '.cmplz-manage-consent{position:fixed;right:20px;bottom:0;width:160px;height:40px;z-index:998}';
  document.head.appendChild(css);
  var b = document.querySelector('.cmplz-cookiebanner');
  var manage = document.querySelector('.cmplz-manage-consent');
  var categories = b.querySelector('.cmplz-categories');
  var show = function () { b.classList.remove('cmplz-dismissed', 'cmplz-hidden'); b.classList.add('cmplz-show'); manage.style.display = 'none'; };
  var dismiss = function () { b.classList.remove('cmplz-show', 'cmplz-categories-visible'); categories.classList.remove('cmplz-fade-in'); b.classList.add('cmplz-dismissed'); manage.style.display = 'flex'; };
  var save = function (m) {
    set('cmplz_banner-status', 'dismissed');
    set('cmplz_policy_id', '1');
    ['marketing', 'statistics', 'preferences'].forEach(function (c) { set('cmplz_' + c, m[c] ? 'allow' : 'deny'); });
    set('cmplz_functional', 'allow');
    set('cmplz_consented_services', '');
  };
  b.querySelector('.cmplz-deny').addEventListener('click', function () { save({}); dismiss(); });
  b.querySelector('.cmplz-accept').addEventListener('click', function () { save({ marketing: 1, statistics: 1, preferences: 1 }); dismiss(); });
  // la X scrive solo lo stato del banner, senza cookie di categoria
  b.querySelector('.cmplz-close').addEventListener('click', function () { set('cmplz_banner-status', 'dismissed'); dismiss(); });
  b.querySelector('.cmplz-view-preferences').addEventListener('click', function () { categories.classList.add('cmplz-fade-in'); b.classList.add('cmplz-categories-visible'); });
  b.querySelector('.cmplz-save-preferences').addEventListener('click', function () {
    var on = function (c) { var i = b.querySelector('input[data-category="cmplz_' + c + '"]'); return i && i.checked; };
    save({ statistics: on('statistics'), marketing: on('marketing'), preferences: on('preferences') });
    dismiss();
  });
  manage.addEventListener('click', show);
  if (get('cmplz_banner-status') === 'dismissed') dismiss();
  else setTimeout(show, 300);
})();
