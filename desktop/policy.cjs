const SITE_URL = 'https://www.metro-designer.com/';
const SITE_ORIGINS = new Set(['https://www.metro-designer.com', 'https://metro-designer.com']);

function isSite(url) {
  try { return SITE_ORIGINS.has(new URL(url).origin); } catch { return false; }
}

function isExternalLink(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch { return false; }
}

function isExport(url) {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'blob:' && SITE_ORIGINS.has(parsed.origin)) ||
      /^data:(image\/png|video\/webm|application\/json)[;,]/i.test(url);
  } catch { return false; }
}

module.exports = { SITE_URL, isSite, isExternalLink, isExport };
