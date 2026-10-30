// The Arrivo app's security check page (captcha.html). Renders Cloudflare Turnstile and hands the token to the app
// through the WebView bridge (window.ReactNativeWebView.postMessage). Nothing else: no form, no storage of our own,
// no analytics. Messages are JSON: { source: 'arrivo-captcha', type: 'token', token } | { …, type: 'expired' } |
// { …, type: 'error', code: 'unavailable' | 'failed' | 'timeout' }. The app checks the source, the page URL and the
// token format (mobile/src/requests/captcha.ts).
(() => {
  'use strict';
  const SITE_KEY = '0x4AAAAAAFizYRLd8XZ4zD4r';
  // Cloudflare's test key that always passes (https://developers.cloudflare.com/turnstile/troubleshooting/testing/):
  // the real widget only allows drfellingood.github.io, so local previews use this one.
  const TEST_SITE_KEY = '1x00000000000000000000AA';
  const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const LOAD_TIMEOUT_MS = 20000;

  const TEXT = {
    'zh-Hans': {
      title: '安全验证', intro: '确认你不是机器人后，就会回到「出岛」App 继续提交。', loading: '正在加载验证…',
      done: '验证完成，正在返回 App…', doneOutside: '验证完成。这个页面只在「出岛」App 里使用，可以关闭。', expired: '验证已过期，正在重新验证…', failed: '验证没有通过。请点「再试一次」。',
      unavailable: '无法加载验证。请检查网络后点「再试一次」。', retry: '再试一次', failedInApp: '验证没有完成，正在返回 App…', outside: '这个页面只在「出岛」App 里使用。',
    },
    'zh-Hant': {
      title: '安全驗證', intro: '確認你不是機器人後，就會回到「出岛」App 繼續提交。', loading: '正在載入驗證…',
      done: '驗證完成，正在返回 App…', doneOutside: '驗證完成。這個頁面只在「出岛」App 裡使用，可以關閉。', expired: '驗證已過期，正在重新驗證…', failed: '驗證沒有通過。請點「再試一次」。',
      unavailable: '無法載入驗證。請檢查網路後點「再試一次」。', retry: '再試一次', failedInApp: '驗證沒有完成，正在返回 App…', outside: '這個頁面只在「出岛」App 裡使用。',
    },
    en: {
      title: 'Security check', intro: 'Once we know you\'re not a bot, you\'ll go straight back to the Arrivo app to submit your request.', loading: 'Loading the check…',
      done: 'Done. Going back to the app…', doneOutside: 'Done. This page is only used inside the Arrivo app; you can close it.', expired: 'The check expired. Checking again…', failed: 'The check didn\'t pass. Tap “Try again”.',
      unavailable: 'The check couldn\'t load. Check your connection, then tap “Try again”.', retry: 'Try again', failedInApp: 'The check didn\'t finish. Going back to the app…', outside: 'This page is only used inside the Arrivo app.',
    },
  };

  /** ?lang=zh-Hans | zh-Hant | en from the app; otherwise the browser language. */
  function pickLang() {
    const asked = new URLSearchParams(location.search).get('lang');
    if (asked && Object.prototype.hasOwnProperty.call(TEXT, asked)) return asked;
    const nav = String(navigator.language || '').toLowerCase();
    if (/^zh-(hant|tw|hk|mo)/.test(nav)) return 'zh-Hant';
    return nav.startsWith('zh') ? 'zh-Hans' : 'en';
  }
  const lang = pickLang();
  const t = TEXT[lang];
  const widgetLang = lang === 'zh-Hant' ? 'zh-tw' : lang === 'en' ? 'en' : 'zh-cn';

  // Trusted Types (CSP: require-trusted-types-for 'script'; trusted-types default). api.js can replace itself with a
  // newer build by assigning a string to a new script element's src. Only that exact form may pass: api.js under
  // /turnstile/v0/ (optionally a versioned folder), with no other query than ours (render=explicit,
  // onload=arrivoCaptchaReady) plus the upgrade's own _upgrade=true and _cb=<digits>. Same rule as the workbench
  // (workbench/js/load-turnstile.js, isTurnstileScript).
  const ALLOWED_PARAMS = { render: v => v === 'explicit', onload: v => v === 'arrivoCaptchaReady', _upgrade: v => v === 'true', _cb: v => /^\d{1,16}$/.test(v) };
  const isTurnstileScript = value => {
    let url;
    try { url = new URL(String(value)); } catch { return false; }
    if (url.origin !== 'https://challenges.cloudflare.com' || url.username || url.password || url.hash) return false;
    if (!/^\/turnstile\/v0\/(?:[a-z0-9]{1,8}\/[A-Za-z0-9]{1,40}\/)?api\.js$/.test(url.pathname)) return false;
    const seen = new Set();
    for (const [key, val] of url.searchParams) {
      if (seen.has(key) || !Object.prototype.hasOwnProperty.call(ALLOWED_PARAMS, key) || !ALLOWED_PARAMS[key](val)) return false;
      seen.add(key);
    }
    return seen.has('onload') && seen.has('render');
  };
  if (window.trustedTypes && !window.trustedTypes.defaultPolicy) {
    window.trustedTypes.createPolicy('default', { createScriptURL: value => isTurnstileScript(value) ? value : null });
  }

  const $ = id => document.getElementById(id);
  document.documentElement.lang = lang;
  document.title = `出岛 Arrivo · ${t.title}`;
  $('title').textContent = t.title;
  $('intro').textContent = t.intro;
  $('retry').textContent = t.retry;
  const status = text => { $('status').textContent = text; };
  status(t.loading);

  const bridge = window.ReactNativeWebView;
  const send = message => {
    if (bridge && typeof bridge.postMessage === 'function') bridge.postMessage(JSON.stringify({ source: 'arrivo-captcha', ...message }));
  };
  if (!bridge) $('intro').textContent = `${t.intro} ${t.outside}`;

  if (window.top !== window.self) { status(t.outside); return; }

  let widgetId = null;
  const showRetry = show => { $('retry').hidden = !show; };
  // In the app, a failure is handed to the app (it carries on without a token; Supabase decides), so the page shows
  // no retry button of its own there. In a normal browser the button stays.
  const fail = code => {
    status(bridge ? t.failedInApp : code === 'unavailable' ? t.unavailable : t.failed);
    showRetry(!bridge);
    send({ type: 'error', code });
  };

  const timer = setTimeout(() => { if (widgetId === null) fail('unavailable'); }, LOAD_TIMEOUT_MS);
  $('turnstile-api').addEventListener('error', () => { clearTimeout(timer); fail('unavailable'); });

  $('retry').addEventListener('click', () => {
    showRetry(false);
    if (widgetId === null || !window.turnstile) { location.reload(); return; }
    status(t.loading);
    window.turnstile.reset(widgetId);
  });

  window.arrivoCaptchaReady = () => {
    clearTimeout(timer);
    widgetId = window.turnstile.render('#widget', {
      sitekey: LOCAL ? TEST_SITE_KEY : SITE_KEY,
      action: 'app_first_request',
      language: widgetLang,
      theme: 'auto',
      size: 'flexible',
      callback: token => {
        showRetry(false);
        status(bridge ? t.done : t.doneOutside);
        send({ type: 'token', token });
      },
      'expired-callback': () => { status(t.expired); send({ type: 'expired' }); },
      'timeout-callback': () => fail('timeout'),
      // true: this page shows its own message and retry button.
      'error-callback': () => { fail('failed'); return true; },
    });
    status('');
  };
})();
