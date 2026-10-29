// Shows crew notifications: live ones from the open app, and real pushes from the Cloudflare Worker (app closed). No caching.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Execute > Excuses", {
    body: d.body || "Your crew is active.", icon: "icon-192.png", badge: "icon-192.png",
    tag: d.tag || "eoe", renotify: true, vibrate: [200, 100, 200], data: { url: d.url || "./" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => x.url.startsWith(self.registration.scope));
    return c ? c.focus().then(w => w && w.navigate ? w.navigate(url).catch(() => w) : w) : self.clients.openWindow(url);
  }));
});
