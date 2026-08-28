self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = { body: event.data?.text() || '' };
  }
  const url = new URL(payload.url || '/profesional/', self.location.origin).href;
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Reku', {
      body: payload.body || 'Tenés una nueva notificación.',
      icon: '/profesional/icon-192.png',
      badge: '/profesional/icon-192.png',
      tag: payload.tag || 'reku-professional',
      renotify: true,
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || `${self.location.origin}/profesional/`;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => client.url.startsWith(`${self.location.origin}/profesional/`));
      if (existing) {
        return existing.navigate(targetUrl).then((client) => client?.focus());
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
