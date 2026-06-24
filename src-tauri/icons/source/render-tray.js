async (page) => {
  const out = '/Users/imekachi/Projects/earnin/ai-buddy/src-tauri/icons/source/tray-template-256.png';
  const size = 256;
  const svg = `<svg viewBox="212 212 600 600" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="512" cy="512" r="210" fill="none" stroke="#000000" stroke-width="100" stroke-linecap="round" stroke-dasharray="989.6 329.9"/>
    <circle cx="512" cy="512" r="104" fill="#000000"/>
    <circle cx="664" cy="360" r="86" fill="#000000"/>
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
