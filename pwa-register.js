const KSR_PWA_VERSION = '2026.07.29-new-exam-v6-merged';

if ('serviceWorker' in navigator) {
  let reloadingForNewWorker = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForNewWorker) return;
    reloadingForNewWorker = true;
    // Reload only once when a newly uploaded service worker takes control.
    window.location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register(
        `./service-worker.js?v=20260730-matching-pdf-v11&v=${encodeURIComponent(KSR_PWA_VERSION)}`,
        { scope: './', updateViaCache: 'none' }
      );

      if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }

      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            worker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });

      await registration.update();
      registration.active?.postMessage({ type: 'CLEAR_OLD_CACHES' });
    } catch (error) {
      console.error('KSR PWA registration failed:', error);
    }
  });
}
