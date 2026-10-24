(function () {
  var P = location.port;
  function getC(n) { var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? m[1] : null; }
  var stored = getC('OptanonConsent');
  var groups = stored ? decodeURIComponent(stored).replace('groups=', '') : ',C0001,';
  window.OnetrustActiveGroups = groups;
  window.OneTrust = {
    GetDomainData: function () {
      return { Groups: [
        { GroupName: 'Cookie strettamente necessari', OptanonGroupId: 'C0001', Status: 'always active',
          Cookies: [{ Name: 'OptanonConsent', Host: 'www.sito-b.test' }, { Name: '_hjSessionUser_xxxxxxx', Host: 'sito-b.test' }], Hosts: [] },
        { GroupName: 'Cookie di prestazione', OptanonGroupId: 'C0002', Status: 'inactive',
          Cookies: [{ Name: '_ga', Host: 'sito-b.test' }, { Name: '_ga_xxxxxxxxxx', Host: 'sito-b.test' }, { Name: '_vecchio_cookie', Host: 'sito-b.test' }], Hosts: [] },
        { GroupName: 'Cookie di targeting', OptanonGroupId: 'C0004', Status: 'inactive', Cookies: [], Hosts: [] }
      ] };
    },
    RejectAll: function () { setConsent(false); },
    AllowAll: function () { setConsent(true); },
    UpdateConsent: function (type, value) { var p = value.split(':'); if (p[1] === '1') setGroups(window.OnetrustActiveGroups.replace(/,$/, '') + ',' + p[0] + ','); }
  };
  // Hotjar dichiarato tra i "necessari": attivo sempre
  document.cookie = '_hjSessionUser_42=abc; max-age=31536000; path=/';
  // Tagging lato server su sottodominio proprio
  fetch('http://sst.sito-b.test:' + P + '/g/collect?v=2&tid=G-B', { mode: 'no-cors' });
  apply(groups);
  if (!stored) setTimeout(showBanner, 300);
  // Link nel footer per riaprire le preferenze, come nei siti OneTrust
  var foot = document.createElement('footer');
  foot.innerHTML = '<a href="#" class="ot-sdk-show-settings">Impostazioni cookie</a>';
  document.body.appendChild(foot);
  foot.querySelector('a').onclick = function (e) { e.preventDefault(); if (!document.getElementById('onetrust-consent-sdk')) showBanner(); };

  function apply(g) {
    if (g.indexOf('C0002') >= 0) {
      // Violazione di prova: con la sola categoria "prestazioni" parte anche un pixel pubblicitario
      new Image().src = 'http://pixel.adtest.example:' + P + '/tr?id=perf-only';
      document.cookie = '_ga=GA1.1.1; max-age=63072000; path=/';
      document.cookie = '_ga_ABC123=GS1; max-age=63072000; path=/';
      fetch('http://analytics.stattest.example:' + P + '/g/collect?v=2&gcs=G111', { mode: 'no-cors' });
    }
    if (g.indexOf('C0004') >= 0) {
      document.cookie = '_fbp=fb.1; max-age=7776000; path=/';
      new Image().src = 'http://pixel.adtest.example:' + P + '/tr?id=b';
    }
  }
  function setConsent(all) {
    setGroups(all ? ',C0001,C0002,C0004,' : ',C0001,');
  }
  function setGroups(g) {
    document.cookie = 'OptanonConsent=' + encodeURIComponent('groups=' + g) + '; max-age=31536000; path=/';
    document.cookie = 'OptanonAlertBoxClosed=1; max-age=31536000; path=/';
    window.OnetrustActiveGroups = g;
    var sdk = document.getElementById('onetrust-consent-sdk');
    if (sdk) sdk.remove();
    apply(g);
  }
  function showBanner() {
    var sdk = document.createElement('div');
    sdk.id = 'onetrust-consent-sdk';
    sdk.innerHTML =
      '<div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #000;padding:16px;z-index:9999">' +
      '<p>Utilizziamo i cookie per finalità tecniche e, con il tuo consenso, per altre finalità.</p>' +
      '<button id="onetrust-pc-btn-handler">Impostazioni cookie</button> <button id="onetrust-accept-btn-handler">Accetta tutti</button></div>' +
      '<div id="onetrust-pc-sdk" style="display:none;position:fixed;top:10%;left:10%;right:10%;background:#fff;border:1px solid #000;padding:16px;z-index:10000">' +
      '<p>Centro preferenze privacy</p>' +
      '<label><input type="checkbox" id="ot-group-id-C0002"> Cookie di prestazione</label> ' +
      '<label><input type="checkbox" id="ot-group-id-C0004"> Cookie di targeting</label> ' +
      '<button class="ot-pc-refuse-all-handler">Rifiuta tutti</button> <button class="save-preference-btn-handler">Conferma le mie scelte</button></div>';
    document.body.appendChild(sdk);
    document.getElementById('onetrust-accept-btn-handler').onclick = function () { setConsent(true); };
    document.getElementById('onetrust-pc-btn-handler').onclick = function () {
      document.getElementById('onetrust-banner-sdk').style.display = 'none';
      document.getElementById('onetrust-pc-sdk').style.display = 'block';
    };
    sdk.querySelector('.ot-pc-refuse-all-handler').onclick = function () { setConsent(false); };
    sdk.querySelector('.save-preference-btn-handler').onclick = function () {
      var g = ',C0001,';
      ['C0002', 'C0004'].forEach(function (id) { if (document.getElementById('ot-group-id-' + id).checked) g += id + ','; });
      setGroups(g);
    };
  }
})();
