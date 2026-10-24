(function () {
  var P = location.port;
  function getC(n) { var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? m[1] : null; }
  function load(src) { var s = document.createElement('script'); s.src = src; document.head.appendChild(s); }
  function pixel(src) { new Image().src = src; }
  var consent = getC('consenso');
  // Prima di qualsiasi scelta: cookie statistico, pixel pubblicitario, ping Consent Mode negato
  document.cookie = '_ga=GA1.1.' + Date.now() + '; max-age=63072000; path=/';
  pixel('http://pixel.adtest.example:' + P + '/tr?id=123&ev=PageView');
  fetch('http://analytics.stattest.example:' + P + '/g/collect?v=2&tid=G-TEST&gcs=G100', { mode: 'no-cors' });
  // Elementi che nessuna fonte sa classificare
  document.cookie = 'xyz_misterioso=1; max-age=31536000; path=/';
  pixel('http://widget.ignoto.example:' + P + '/w.gif');
  // Rifiuto non rispettato: registrazione sessioni anche dopo "Rifiuta"
  if (consent === 'no') load('http://rec.sessiontest.example:' + P + '/rec.js');
  if (consent === 'si') { document.cookie = '_fbp=fb.1.1.1; max-age=7776000; path=/'; pixel('http://pixel.adtest.example:' + P + '/tr?ev=Consent'); }
  if (!consent) setTimeout(showBanner, 800);
  function showBanner() {
    var b = document.createElement('div');
    b.id = 'banner';
    b.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#eee;padding:20px;z-index:9999';
    b.innerHTML = '<p>Questo sito usa cookie per migliorare la tua esperienza.</p><button id="a">Accetta tutti</button> <button id="r">Rifiuta</button>';
    document.body.appendChild(b);
    b.querySelector('#a').onclick = function () { document.cookie = 'consenso=si; max-age=15552000; path=/'; document.cookie = '_gid=GA1.1.5; max-age=86400; path=/'; b.remove(); };
    b.querySelector('#r').onclick = function () { document.cookie = 'consenso=no; max-age=15552000; path=/'; b.remove(); load('http://rec.sessiontest.example:' + P + '/rec.js'); };
  }
})();
