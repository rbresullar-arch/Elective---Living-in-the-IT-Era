/* PWA bootstrap — Living in the IT Era (GEEL 1)
   1. Registers sw.js on every page (offline copies of pages).
   2. On the hub (index.html) only: shows an "Install app" bar —
      Android/desktop Chrome: one-tap install; iOS Safari: Share → Add to Home Screen hint.
   Hidden when already installed, inside in-app browsers, or after "Not now" (14 days). */
(function () {
  'use strict';
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () {});
    });
  }

  var script = document.currentScript;
  if (!script || script.getAttribute('data-install') !== 'hub') return;

  var ua = navigator.userAgent || '';
  var inApp = /(FBAN|FBAV|FB_IAB|FBIOS|Messenger|Instagram|Line\/|MicroMessenger|TikTok|musical_ly|Bytedance|Twitter|GSA\/)/i.test(ua);
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  if (inApp || standalone) return;

  var KEY = 'itera_install_dismissed';
  try {
    var t = +localStorage.getItem(KEY);
    if (t && Date.now() - t < 14 * 864e5) return;
  } catch (e) {}

  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var iosSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  var deferred = null, bar = null;

  function css() {
    var s = document.createElement('style');
    s.textContent =
      '.pwa-bar{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom));transform:translate(-50%,140%);' +
      'width:min(440px,calc(100% - 32px));display:flex;align-items:center;gap:12px;padding:12px 12px 12px 14px;' +
      'background:var(--surface,#fff);color:var(--ink,#1D1D1F);border:.5px solid var(--sep,rgba(60,60,67,.18));' +
      'border-radius:18px;box-shadow:0 2px 4px rgba(0,0,0,.05),0 12px 32px rgba(0,0,0,.16);z-index:9000;' +
      'font:15px/1.3 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Helvetica Neue",Arial,sans-serif;' +
      'transition:transform .45s cubic-bezier(.2,.9,.25,1)}' +
      '.pwa-bar.on{transform:translate(-50%,0)}' +
      '.pwa-bar img{width:44px;height:44px;border-radius:10px;flex:none}' +
      '.pwa-bar .pwa-tx{flex:1;min-width:0}.pwa-bar b{display:block;font-weight:600}' +
      '.pwa-bar small{display:block;color:var(--muted,#6E6E73);font-size:13px}' +
      '.pwa-bar button{border:0;font:inherit;font-weight:600;cursor:pointer;border-radius:980px}' +
      '.pwa-go{background:var(--blue,#0071E3);color:#fff;padding:8px 16px}' +
      '.pwa-x{background:transparent;color:var(--muted,#6E6E73);padding:8px 6px;font-weight:500!important}' +
      '.pwa-share{display:inline-block;width:14px;height:16px;vertical-align:-3px;margin:0 1px}';
    document.head.appendChild(s);
  }

  var SHARE = '<svg class="pwa-share" viewBox="0 0 14 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 1v10M3.5 4.5 7 1l3.5 3.5M4 7.5H2.5v9h9v-9H10"/></svg>';

  /* Wait until the student is on the hub home screen with no sheet (terms, login, QR…) open. */
  var SHEETS = '#privacyPanel,#qrPanel,#unlockPanel,#cloudPanel,#logoutPanel,#codePanel';
  function hubFree() {
    var home = document.getElementById('screen-home');
    if (home && !home.classList.contains('active')) return false;
    var open = document.querySelectorAll(SHEETS);
    for (var i = 0; i < open.length; i++) if (getComputedStyle(open[i]).display !== 'none') return false;
    return true;
  }
  var want = null, mo = null;
  function show(mode) {
    want = mode;
    if (hubFree()) return render(mode);
    if (mo) return;
    mo = new MutationObserver(function () {
      if (want && hubFree()) { mo.disconnect(); mo = null; setTimeout(function () { if (hubFree()) render(want); else show(want); }, 800); }
    });
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  }

  function render(mode) {
    if (bar) return;
    css();
    bar = document.createElement('div');
    bar.className = 'pwa-bar';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Install app');
    bar.innerHTML =
      '<img src="icons/apple-touch-icon.png" alt="">' +
      '<div class="pwa-tx"><b>Install IT Era</b><small>' +
      (mode === 'ios' ? 'Tap ' + SHARE + ' Share, then <b style="display:inline">Add to Home Screen</b>.'
                      : 'Opens like an app. Works offline.') +
      '</small></div>' +
      (mode === 'ios' ? '' : '<button type="button" class="pwa-go">Install</button>') +
      '<button type="button" class="pwa-x">' + (mode === 'ios' ? 'OK' : 'Not now') + '</button>';
    document.body.appendChild(bar);
    requestAnimationFrame(function () { requestAnimationFrame(function () { bar.classList.add('on'); }); });

    var go = bar.querySelector('.pwa-go');
    if (go) go.addEventListener('click', function () {
      if (!deferred) return hide();
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; hide(); });
    });
    bar.querySelector('.pwa-x').addEventListener('click', function () {
      try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {}
      hide();
    });
  }

  function hide() {
    want = null;
    if (mo) { mo.disconnect(); mo = null; }
    if (!bar) return;
    bar.classList.remove('on');
    var b = bar; bar = null;
    setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 500);
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    setTimeout(function () { show('prompt'); }, 1500);
  });
  window.addEventListener('appinstalled', hide);
  if (iosSafari) window.addEventListener('load', function () { setTimeout(function () { show('ios'); }, 2500); });
})();
