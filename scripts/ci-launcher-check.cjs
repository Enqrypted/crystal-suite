// CI check of a packaged Crystal Suite started with --remote-debugging-port=<port>: reads the launcher page's
// text over the Chrome DevTools protocol and fails unless the app list rendered.
//   node scripts/ci-launcher-check.cjs <port>
const port = process.argv[2] || '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((p) => /launcher\.html/.test(p.url));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        const text = await new Promise((resolve) => {
          ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d.result?.result?.value || ''); };
          ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.body.innerText', returnByValue: true } }));
        });
        ws.close();
        console.log(text.replace(/\n+/g, ' | ').slice(0, 600));
        if (/All apps/.test(text) && /Photon/.test(text) && /Version 0\.\d+\.\d+/.test(text)) { console.log('LAUNCHER OK'); process.exit(0); }
      }
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  console.log('LAUNCHER DID NOT RENDER');
  process.exit(1);
})();
