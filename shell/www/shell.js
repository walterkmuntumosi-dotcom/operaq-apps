/* Opening / no connection: go (back) to the company's app. app.json is written by prepare.mjs at build time. */
(function () {
  function open(cfg) {
    if (cfg.brand) document.documentElement.style.setProperty('--brand', cfg.brand);
    if (cfg.background) document.documentElement.style.setProperty('--bg', cfg.background);
    var retry = document.getElementById('retry');
    if (retry) { retry.onclick = function () { location.href = cfg.startUrl; }; return; }
    location.replace(cfg.startUrl);
  }
  fetch('app.json').then(function (r) { return r.json(); }).then(open).catch(function () {
    var m = document.getElementById('msg'); if (m) m.textContent = 'This app could not start. Please reinstall it.';
  });
})();
