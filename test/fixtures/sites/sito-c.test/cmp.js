(function () {
  var P = location.port;
  var c = (document.cookie.match(/(?:^|; )scelta=([^;]*)/) || [])[1];
  if (c === 'tutto') { document.cookie = '_ga=GA1.1.3; max-age=63072000; path=/'; new Image().src = 'http://pixel.adtest.example:' + P + '/tr?c=1'; }
  if (c) return;
  var host = document.createElement('consent-box');
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<div style="position:fixed;bottom:0;left:0;right:0;background:#ddd;padding:16px">' +
    '<span>Questo sito utilizza cookie. Puoi accettare o rifiutare.</span> ' +
    '<button class="no">Rifiuta tutti</button> <button class="si">Accetta tutti</button></div>';
  root.querySelector('.no').onclick = function () { document.cookie = 'scelta=necessari; max-age=15552000; path=/'; host.remove(); };
  root.querySelector('.si').onclick = function () { document.cookie = 'scelta=tutto; max-age=15552000; path=/'; host.remove(); location.reload(); };
})();
