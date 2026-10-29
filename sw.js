// Shows crew notifications: live ones from the open app, and real pushes from the Cloudflare Worker (app closed).
// Chat and private-message pushes get a Reply button. Where the phone supports typing in the notification,
// the reply is sent from here as the signed-in person (their saved Firebase login), so the same database rules apply.
// No caching.
const PROJECT = "execute-over-excuses", PUSH_URL = "https://eoe-push.eoe-push.workers.dev";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Execute > Excuses", {
    body: d.body || "Your crew is active.", icon: "icon-192.png", badge: "icon-192.png",
    tag: d.tag || "eoe", renotify: true, vibrate: [200, 100, 200], data: { url: d.url || "./", reply: d.reply || null },
    actions: d.reply ? [{ action: "reply", type: "text", title: "Reply", placeholder: "Write a reply…" }, { action: "open", title: "Open" }] : [],
  }));
});

self.addEventListener("notificationclick", e => {
  const n = e.notification, data = n.data || {}, text = (e.reply || "").trim();
  n.close();
  if (e.action === "reply" && text && data.reply) {
    e.waitUntil(sendReply(data.reply, text)
      .then(() => self.registration.showNotification("Reply sent ✓", { body: text, icon: "icon-192.png", badge: "icon-192.png", tag: n.tag, silent: true }))
      .catch(() => openApp(data.url)));
    return;
  }
  e.waitUntil(openApp(data.url));
});

function openApp(url) {
  const href = new URL(url || "./", self.registration.scope).href;
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => x.url.startsWith(self.registration.scope));
    return c ? c.focus().then(w => w && w.navigate ? w.navigate(href).catch(() => w) : w) : self.clients.openWindow(href);
  });
}

/* ---------- sending a reply without opening the app ---------- */
const rid = (n = 12) => { const a = "abcdefghijkmnpqrstuvwxyz23456789"; let s = ""; for (const b of crypto.getRandomValues(new Uint8Array(n))) s += a[b % a.length]; return s; };
function authRow() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("firebaseLocalStorageDb");
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("firebaseLocalStorage")) return rej(new Error("no login"));
      const q = db.transaction("firebaseLocalStorage", "readonly").objectStore("firebaseLocalStorage").getAll();
      q.onerror = () => rej(q.error);
      q.onsuccess = () => { const row = q.result.find(x => String(x.fbase_key).startsWith("firebase:authUser:")); row ? res(row) : rej(new Error("no login")); };
    };
  });
}
async function signedIn() {
  const row = await authRow(), apiKey = row.fbase_key.split(":")[2], u = row.value, st = u.stsTokenManager || {};
  if (st.accessToken && st.expirationTime > Date.now() + 60000) return { uid: u.uid, tok: st.accessToken };
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(st.refreshToken) });
  const j = await r.json(); if (!j.id_token) throw new Error("refresh failed");
  return { uid: u.uid, tok: j.id_token };
}
const fv = v => typeof v === "number" ? { integerValue: String(Math.round(v)) } : Array.isArray(v) ? { arrayValue: { values: v.map(fv) } }
  : v && typeof v === "object" ? { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fv(x)])) } } : { stringValue: String(v ?? "") };
async function fsWrite(tok, path, obj, mask) {
  const q = mask ? mask.map(m => "updateMask.fieldPaths=" + encodeURIComponent(m)).join("&") : "currentDocument.exists=false";
  const r = await fetch(`${FS}/${path}?${q}`, { method: "PATCH", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify({ fields: fv(obj).mapValue.fields }) });
  if (!r.ok) throw new Error("write " + r.status);
}
async function sendReply(to, raw) {
  const text = raw.slice(0, 1000), { uid, tok } = await signedIn(), ts = Date.now(), mid = rid();
  let name = "";
  try { const p = await (await fetch(`${FS}/people/${uid}`, { headers: { Authorization: "Bearer " + tok } })).json(); name = p.fields?.name?.stringValue || ""; } catch {}
  let ping;
  if (to.t === "chat" && /^[A-Za-z0-9_-]{1,64}$/.test(to.gid)) {
    await fsWrite(tok, `groups/${to.gid}/chat/${mid}`, { by: uid, name, text, ts });
    fsWrite(tok, `groups/${to.gid}/reads/${uid}`, { ts }, ["ts"]).catch(() => {});
    ping = { type: "chat", gid: to.gid, id: mid };
  } else if (to.t === "dm" && String(to.pid).split("_").includes(uid)) {
    await fsWrite(tok, `dms/${to.pid}/msgs/${mid}`, { by: uid, text, ts });
    await fsWrite(tok, `dms/${to.pid}`, { u: to.pid.split("_"), last: { by: uid, name, text: text.slice(0, 140), ts }, read: { [uid]: ts } }, ["u", "last", "read.`" + uid + "`"]);
    ping = { type: "dm", pid: to.pid, id: mid };
  } else throw new Error("bad target");
  await fetch(PUSH_URL + "/notify", { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify(ping) }).catch(() => {});
}
