const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rp = require('request-promise');
const { JSDOM } = require('jsdom');

const TARGET = process.env.TARGET_URL || 'https://cineby.sc';
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // expose publicly / LAN
const TARGET_ORIGIN = new URL(TARGET).origin;
const TARGET_HOSTNAME = new URL(TARGET).hostname;

const assetExt = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|txt|woff2?|ttf|eot|map)$/i;

// Common ad selectors (EasyList-inspired).
const adSelectors = [
  '.adsbygoogle',
  '.google-ads',
  '.ad-banner',
  '.ad',
  '.ads',
  '.advertisement',
  '.ad-container',
  '.popup',
  '.banner',
  '[id*="ad-"], [class*="ad-"]',
  '[id*="ads"], [class*="ads"]',
  '[id*="sponsor"], [class*="sponsor"]',
  'iframe[src*="doubleclick"]',
  'iframe[src*="googlesyndication"]',
  'iframe[src*="adservice"]',
  'script[src*="ads"]',
];

// Host list distilled from EasyList.
const adHosts = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'adsystem.com',
  'rubiconproject.com',
  'adnxs.com',
  'taboola.com',
  'outbrain.com',
  'criteo.com',
  'googletagservices.com',
  'googletagmanager.com',
];

const blockedUrlPattern = /(doubleclick|ads?\/|adservice|googleadservices|gampad|pagead|adserver|googlesyndication|pubmatic|taboola|outbrain|criteo|adnxs|rubiconproject)/i;
const popupTextPattern = /(allow notifications|enable notifications|subscribe|watch now|download now|click allow|continue to watch|open in app|install app)/i;

function shouldBlockUrl(url) {
  if (!url) return false;
  const value = String(url);
  return blockedUrlPattern.test(value) || adHosts.some((host) => value.includes(host));
}

function normalizeProxiedUrl(url) {
  if (!url) return null;
  const value = String(url).trim();
  if (!value || value.startsWith('#') || value.startsWith('javascript:') || value.startsWith('data:')) {
    return null;
  }

  try {
    const parsed = new URL(value, TARGET);
    if (shouldBlockUrl(parsed.href)) return null;
    if (parsed.hostname === TARGET_HOSTNAME) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return null;
  }

  return value;
}

function isOverlayLike(el) {
  if (!el || !el.getAttribute) return false;

  const attrs = [el.id, el.className, el.getAttribute('role'), el.getAttribute('aria-label')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/(popup|modal|overlay|backdrop|subscribe|notification|push|banner|interstitial|paywall)/i.test(attrs)) {
    return true;
  }

  const style = (el.getAttribute('style') || '').toLowerCase();
  const looksFullscreen =
    (style.includes('position:fixed') || style.includes('position: absolute')) &&
    (style.includes('z-index') || style.includes('inset:0') || style.includes('top:0')) &&
    (style.includes('width:100%') || style.includes('100vw')) &&
    (style.includes('height:100%') || style.includes('100vh'));

  const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return looksFullscreen && popupTextPattern.test(text);
}

function buildClientBlockerScript() {
  const selectorList = JSON.stringify(adSelectors);
  const hostList = JSON.stringify(adHosts);
  const urlRegex = blockedUrlPattern.toString();
  const popupRegex = popupTextPattern.toString();
  const targetOrigin = JSON.stringify(TARGET_ORIGIN);
  const targetHostname = JSON.stringify(TARGET_HOSTNAME);

  return `
(() => {
  const adSelectors = ${selectorList};
  const adHosts = ${hostList};
  const blockedUrlPattern = ${urlRegex};
  const popupTextPattern = ${popupRegex};
  const targetOrigin = ${targetOrigin};
  const targetHostname = ${targetHostname};

  const shouldBlockUrl = (value) => {
    if (!value) return false;
    const url = String(value);
    return blockedUrlPattern.test(url) || adHosts.some((host) => url.includes(host));
  };

  const toProxyPath = (value) => {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('data:')) return null;
    try {
      const parsed = new URL(raw, targetOrigin);
      if (shouldBlockUrl(parsed.href)) return null;
      if (parsed.hostname === targetHostname) {
        return parsed.pathname + parsed.search + parsed.hash;
      }
      if (parsed.hostname === window.location.hostname) {
        return parsed.pathname + parsed.search + parsed.hash;
      }
      return parsed.href;
    } catch {
      return raw;
    }
  };

  const isAllowedNavigation = (value) => {
    const resolved = toProxyPath(value);
    if (!resolved) return false;
    if (resolved.startsWith('/')) return true;
    try {
      const parsed = new URL(resolved, window.location.origin);
      return parsed.hostname === window.location.hostname || parsed.hostname === targetHostname;
    } catch {
      return false;
    }
  };

  const redirectToProxy = (value) => {
    const resolved = toProxyPath(value);
    if (!resolved) return false;
    if (resolved.startsWith('/')) {
      window.location.assign(resolved);
      return true;
    }
    return false;
  };

  const removeNode = (node) => {
    if (node && node.remove) node.remove();
  };

  const looksLikeOverlay = (el) => {
    if (!(el instanceof Element)) return false;

    const attrs = [el.id, el.className, el.getAttribute('role'), el.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (/(popup|modal|overlay|backdrop|subscribe|notification|push|banner|interstitial|paywall)/i.test(attrs)) {
      return true;
    }

    const style = window.getComputedStyle(el);
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
    const fullscreenLike =
      (style.position === 'fixed' || style.position === 'absolute') &&
      parseInt(style.zIndex || '0', 10) >= 1000 &&
      el.offsetWidth >= window.innerWidth * 0.6 &&
      el.offsetHeight >= window.innerHeight * 0.4;

    return fullscreenLike && popupTextPattern.test(text);
  };

  const cleanDom = (root = document) => {
    adSelectors.forEach((selector) => {
      root.querySelectorAll(selector).forEach(removeNode);
    });

    root.querySelectorAll('iframe, script, img, link, a').forEach((el) => {
      ['src', 'data-src', 'href'].forEach((attr) => {
        const value = el.getAttribute(attr);
        if (shouldBlockUrl(value)) {
          removeNode(el);
          return;
        }
        if (attr === 'href' && el.tagName === 'A') {
          const rewritten = toProxyPath(value);
          if (rewritten && rewritten !== value) {
            el.setAttribute('href', rewritten);
          }
        }
      });
    });

    root.querySelectorAll('body *').forEach((el) => {
      if (looksLikeOverlay(el)) {
        removeNode(el);
      }
    });
  };

  const originalOpen = window.open;
  window.open = function blockedWindowOpen(url, ...args) {
    if (!isAllowedNavigation(url)) return null;
    if (typeof url === 'string' && /pop|under|click|redirect|tab/i.test(url)) return null;
    if (redirectToProxy(url)) return null;
    return originalOpen.call(this, url, ...args);
  };

  const originalAssign = window.location.assign.bind(window.location);
  window.location.assign = (url) => {
    if (!isAllowedNavigation(url)) return;
    if (redirectToProxy(url)) return;
    originalAssign(url);
  };

  const originalReplace = window.location.replace.bind(window.location);
  window.location.replace = (url) => {
    if (!isAllowedNavigation(url)) return;
    const resolved = toProxyPath(url);
    if (resolved && resolved.startsWith('/')) {
      originalReplace(resolved);
      return;
    }
    originalReplace(url);
  };

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (originalFetch) {
    window.fetch = (input, init) => {
      const candidate = typeof input === 'string' ? input : input && input.url;
      if (shouldBlockUrl(candidate)) {
        return Promise.resolve(new Response('', { status: 204, statusText: 'Blocked by ad-clean proxy' }));
      }
      return originalFetch(input, init);
    };
  }

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__blockedByProxy = shouldBlockUrl(url);
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  const originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function patchedSend(body) {
    if (this.__blockedByProxy) {
      this.abort();
      return;
    }
    return originalXhrSend.call(this, body);
  };

  document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a') : null;
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    if (shouldBlockUrl(href) || /javascript:\\s*window\\.open/i.test(href) || !isAllowedNavigation(href)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const rewritten = toProxyPath(href);
    if (rewritten && rewritten.startsWith('/')) {
      event.preventDefault();
      event.stopPropagation();
      window.location.assign(rewritten);
    }
  }, true);

  const style = document.createElement('style');
  style.textContent = adSelectors.join(',\\n') + ' { display: none !important; visibility: hidden !important; }';
  document.documentElement.appendChild(style);

  cleanDom(document);
  new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) {
          if (looksLikeOverlay(node)) {
            removeNode(node);
            return;
          }
          cleanDom(node);
        }
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
  `.trim();
}

function injectClientBlockers(document) {
  const script = document.createElement('script');
  script.textContent = buildClientBlockerScript();

  const style = document.createElement('style');
  style.textContent = `
${adSelectors.join(',\n')} {
  display: none !important;
  visibility: hidden !important;
}
  `.trim();

  if (document.head) {
    document.head.appendChild(style);
    document.head.appendChild(script);
    return;
  }

  document.documentElement.appendChild(style);
  document.documentElement.appendChild(script);
}

function stripAds(html) {
  const dom = new JSDOM(html);
  const { document } = dom.window;

  // Remove obvious ad elements.
  adSelectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => node.remove());
  });

  // Remove elements pointing to known ad hosts.
  const attrCandidates = ['src', 'data-src', 'href'];
  document.querySelectorAll('img, iframe, script, link').forEach((el) => {
    attrCandidates.forEach((attr) => {
      const val = el.getAttribute(attr);
      if (!val) return;
      if (shouldBlockUrl(val)) {
        el.remove();
      }
    });
  });

  document.querySelectorAll('a').forEach((el) => {
    const href = el.getAttribute('href');
    if (shouldBlockUrl(href)) {
      el.remove();
      return;
    }

    const rewrittenHref = normalizeProxiedUrl(href);
    if (rewrittenHref) {
      el.setAttribute('href', rewrittenHref);
      el.removeAttribute('target');
      el.setAttribute('rel', 'noopener noreferrer');
    }

    const onclick = el.getAttribute('onclick') || '';
    if (/window\.open|pop|under|redirect/i.test(onclick)) {
      el.removeAttribute('onclick');
    }
  });

  document.querySelectorAll('body *').forEach((el) => {
    if (isOverlayLike(el)) {
      el.remove();
    }
  });

  // Strip HTML comments mentioning ads/sponsors.
  const iterator = document.createNodeIterator(document, dom.window.NodeFilter.SHOW_COMMENT);
  let commentNode;
  while ((commentNode = iterator.nextNode())) {
    if (/ad(s)?|sponsor/i.test(commentNode.nodeValue || '')) {
      commentNode.parentNode?.removeChild(commentNode);
    }
  }

  injectClientBlockers(document);

  return dom.serialize();
}

const app = express();

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

// Block obvious ad network requests early (applies to all routes).
app.use((req, res, next) => {
  const targetUrl = new URL(req.originalUrl, TARGET);
  if (blockedUrlPattern.test(targetUrl.href) || adHosts.some((h) => targetUrl.hostname.includes(h))) {
    console.log(`Blocked ad request: ${targetUrl.href}`);
    return res.status(204).end();
  }
  next();
});

// HTML rewriting route.
app.use(async (req, res, next) => {
  const accept = req.headers.accept || '';
  const wantsHtml = req.method === 'GET' && !assetExt.test(req.path) && accept.includes('text/html');
  if (!wantsHtml) return next();

  const targetUrl = new URL(req.originalUrl, TARGET).toString();
  try {
    const html = await rp({
      uri: targetUrl,
      gzip: true,
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (ad-filter-proxy)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 15000,
    });

    const cleaned = stripAds(html);
    res.type('html').send(cleaned);
  } catch (err) {
    console.error('Failed to fetch/clean HTML:', err.message);
    res.status(502).send('Failed to load upstream content.');
  }
});

// Everything else: proxy straight through.
app.use(
  '/',
  createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    autoRewrite: true,
    logLevel: 'warn',
  })
);

app.use((err, req, res, _next) => {
  console.error('App error:', err.message);
  res.status(500).send('Proxy failed to load upstream content.');
});

app.listen(PORT, HOST, () => {
  console.log(`Ad-clean proxy running at http://${HOST}:${PORT} -> ${TARGET}`);
});

