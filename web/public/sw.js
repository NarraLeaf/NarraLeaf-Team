/*
 * The console's service worker: shows what the Team server pushes, and opens the console where
 * the notification points when one is clicked. It caches nothing - the console is a live view of
 * the server, and an old copy of it would only mislead.
 */
const PHRASES = {
  mention: "提到了你",
  reply: "回复了你",
  assigned: "给你分配了待办",
  "review-requested": "请你评审",
  "review-answered": "回复了你的评审",
  "access-requested": "申请了权限",
  "access-decided": "处理了你的权限申请",
  watch: "你关注的内容有更新",
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { summary: event.data ? event.data.text() : "" };
  }
  const phrase = PHRASES[message.kind];
  const who = message.actor ? `@${message.actor} ` : "";
  const title = message.title || (phrase ? `${who}${phrase}` : "NarraLeaf Team");
  const where = message.projectName ? `［${message.projectName}］` : "";
  const body = `${where}${message.summary || ""}`.trim();
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/console/icon.svg",
      badge: "/console/icon.svg",
      tag: message.id !== undefined ? `nlteam-${message.id}` : undefined,
      data: { url: message.url || "/console/notifications" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/console/notifications", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(`${self.location.origin}/console/`) && "focus" in client) {
          client.navigate(target).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
