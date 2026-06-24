async (page) => {
  const out = '/Users/imekachi/Projects/earnin/ai-buddy/src-tauri/icons/source/app-icon-1024.png';
  const size = 1024;
  const svg = `<svg viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="tile" x1="512" y1="0" x2="512" y2="1024" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#262628"/><stop offset="1" stop-color="#161618"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="1024" height="1024" rx="224" fill="url(#tile)"/>
    <g transform="translate(512 512) scale(1.3) translate(-512 -512)">
      <circle cx="512" cy="512" r="210" fill="none" stroke="#FFFFFF" stroke-width="92" stroke-linecap="round" stroke-dasharray="989.6 329.9"/>
      <circle cx="512" cy="512" r="96" fill="#FFFFFF"/>
      <circle cx="664" cy="360" r="80" fill="#FFFFFF"/>
    </g>
  </svg>`;
  const html = `<!doctype html><html><head><meta charset="utf8"><style>
    html,body{margin:0;padding:0;background:transparent}
    #wrap{width:${size}px;height:${size}px} #wrap svg{width:${size}px;height:${size}px;display:block}
  </style></head><body><div id="wrap">${svg}</div></body></html>`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(html, { waitUntil: 'networkidle' });
  const el = await page.$('#wrap');
  await el.screenshot({ path: out, omitBackground: true });
  return out;
}
