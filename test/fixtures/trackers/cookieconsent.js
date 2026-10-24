// Imitazione minima di vanilla-cookieconsent v2
(function () {
  function read() { var m = document.cookie.match(/(?:^|; )cc_cookie=([^;]*)/); return m ? JSON.parse(decodeURIComponent(m[1])) : null; }
  window.initCookieConsent = function () { return { allowedCategory: function (c) { var v = read(); return !!v && v.level.indexOf(c) >= 0; } }; };
  window.cc = window.initCookieConsent();
  if (read()) return;
  function save(level) {
    document.cookie = 'cc_cookie=' + encodeURIComponent(JSON.stringify({ level: level, revision: 0 })) + '; path=/';
    document.getElementById('cc--main').remove();
    if (level.indexOf('analytics') >= 0) document.cookie = '_ga=GA1.1.42; max-age=63072000; path=/';
    if (level.indexOf('marketing') >= 0) new Image().src = 'http://pixel.adtest.example:' + location.port + '/tr?g=1';
  }
  var root = document.createElement('div');
  root.id = 'cc--main';
  root.innerHTML = '<div id="cc_div" class="cc_div"><div id="cm" class="box bottom left" style="position:fixed;bottom:10px;left:10px;width:360px;background:#fff;border:1px solid #000;padding:12px">' +
    '<div id="c-inr"><p>Accettazione Cookies: usiamo cookie tecnici e, con il tuo consenso, analitici.</p>' +
    '<div id="c-bns"><button id="c-p-bn" class="c-bn">ACCETTA TUTTI</button> <button id="c-s-bn" class="c-bn c_link">RIFIUTA TUTTI</button> <a href="#" data-cc="c-settings">Personalizza</a></div></div></div>' +
    '<div id="s-cnt" style="display:none;position:fixed;top:10%;left:10%;background:#fff;border:1px solid;padding:12px">' +
    '<div class="c-bl"><b>Statistiche</b><input type="checkbox" class="c-tgl" value="analytics"></div>' +
    '<div class="c-bl"><b>Marketing</b><input type="checkbox" class="c-tgl" value="marketing"></div>' +
    '<button id="s-sv-bn">Salva impostazioni</button></div></div>';
  document.body.appendChild(root);
  document.getElementById('c-p-bn').onclick = function () { save(['necessary', 'analytics']); };
  document.getElementById('c-s-bn').onclick = function () { save(['necessary']); };
  root.querySelector('[data-cc="c-settings"]').onclick = function (e) { e.preventDefault(); document.getElementById('cm').style.display = 'none'; document.getElementById('s-cnt').style.display = 'block'; };
  document.getElementById('s-sv-bn').onclick = function () {
    var level = ['necessary'];
    root.querySelectorAll('.c-tgl').forEach(function (t) { if (t.checked) level.push(t.value); });
    save(level);
  };
})();
