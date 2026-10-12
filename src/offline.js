// Registers the service worker. On the private build it also downloads every game file in
// the background; with an imported pack everything is already on the device.
export const offline = { done: 0, total: 0, ready: false, supported: 'serviceWorker' in navigator };

export async function registerWorker() {
  if (!offline.supported || location.protocol === 'file:') return null;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    // The first visit is not controlled until the worker claims the page.
    if (!navigator.serviceWorker.controller) {
      await new Promise(ok => {
        navigator.serviceWorker.addEventListener('controllerchange', ok, { once: true });
        setTimeout(ok, 3000);
      });
    }
    return reg;
  } catch (e) { return null; }
}

export async function setupOffline(reg) {
  try {
    if (localStorage.getItem('pvz2web.pack')) { offline.ready = true; offline.total = offline.done = 1; return; }
  } catch (e) { /* ignore */ }
  const sw = reg && (reg.active || navigator.serviceWorker.controller);
  if (!sw) return;
  const ch = new MessageChannel();
  ch.port1.onmessage = e => {
    offline.done = e.data.done;
    offline.total = e.data.total;
    offline.ready = e.data.total > 0 && e.data.done >= e.data.total;
  };
  sw.postMessage({ type: 'download-all' }, [ch.port2]);
}
