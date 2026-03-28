const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rp = require('request-promise');
const { JSDOM } = require('jsdom');

const TARGET = process.env.TARGET_URL || 'https://cineby.sc';
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // expose publicly / LAN

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
      if (adHosts.some((host) => val.includes(host))) {
        el.remove();
      }
    });
  });

  // Strip HTML comments mentioning ads/sponsors.
  const iterator = document.createNodeIterator(document, dom.window.NodeFilter.SHOW_COMMENT);
  let commentNode;
  while ((commentNode = iterator.nextNode())) {
    if (/ad(s)?|sponsor/i.test(commentNode.nodeValue || '')) {
      commentNode.parentNode?.removeChild(commentNode);
    }
  }

  return dom.serialize();
}

const app = express();

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

