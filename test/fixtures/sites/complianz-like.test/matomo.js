// Tracker di prima parte in stile Matomo, che non rispetta il consenso: a ogni pagina rinnova i cookie _pk_* e
// invia un hit a /matomo.php con sendBeacon.
(function () {
  var m = document.cookie.match(/(?:^|; )_pk_id\.1\.ab12=([^;]*)/);
  var id = m ? m[1] : Math.random().toString(16).slice(2, 18) + '.' + Math.floor(Date.now() / 1000);
  document.cookie = '_pk_id.1.ab12=' + id + '; expires=' + new Date(Date.now() + 393 * 864e5).toUTCString() + '; path=/';
  document.cookie = '_pk_ses.1.ab12=1; expires=' + new Date(Date.now() + 1800e3).toUTCString() + '; path=/';
  navigator.sendBeacon('/matomo.php?idsite=1&rec=1&r=' + Math.floor(Math.random() * 1e6) + '&url=' + encodeURIComponent(location.href) + '&_id=' + id.split('.')[0]);
})();
