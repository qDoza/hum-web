// HUM web — the Cloudflare Worker behind the iPhone app.
//
// Browsers may not call the Yandex Music / SoundCloud APIs directly (no CORS), so the app talks to
// this Worker on its own origin and the Worker forwards each request. Tokens live only on the phone
// and arrive per request in headers; the Worker stores nothing and logs nothing.
//
//   /api/ya/<path>       → api.music.yandex.net/<path>      (x-ya-token)
//   /api/ya-stream?id=   → signed direct mp3 link for a Yandex track
//   /api/ya-lyrics?id=   → the track's lyrics text (LRC when synced)
//   /api/sc/<path>       → api-v2.soundcloud.com/<path>     (x-sc-token, client_id added here)
//   /api/sc-client-id    → SoundCloud's current public client_id
//   /api/pipe?u=         → streams audio from Yandex storage / SoundCloud CDN (fallback only)
// Everything else is the static app in /public.

const YA = "https://api.music.yandex.net/";
const SC = "https://api-v2.soundcloud.com/";
const SIGN_SALT = "XGRlBW9FXlekgbPrRHuSiA";
const LYRICS_KEY = "p93jhgh689SBReK6ghtw62";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

let scClientId = null;          // cached per isolate
let scClientIdAt = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/ya/")) return await proxyYandex(request, p.slice(8) + url.search);
      if (p === "/api/ya-stream") return await yandexStream(request, url.searchParams.get("id"));
      if (p === "/api/ya-lyrics") return await yandexLyrics(request, url.searchParams.get("id"), url.searchParams.get("synced") === "1");
      if (p === "/api/sc-client-id") return json({ clientId: await clientId(url.searchParams.get("fresh") === "1") });
      if (p.startsWith("/api/sc/")) return await proxySoundCloud(request, p.slice(8) + url.search);
      if (p === "/api/pipe") return await pipe(request, url.searchParams.get("u"));
      if (p.startsWith("/api/")) return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 502);
    }
    return env.ASSETS.fetch(request);
  },
};

// ------------------------------------------------------------------ helpers

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function yaHeaders(request, extra = {}) {
  const h = { "X-Yandex-Music-Client": "YandexMusicAndroid/24023621", "Accept-Language": "ru", ...extra };
  const t = request.headers.get("x-ya-token");
  if (t) h.Authorization = "OAuth " + t;
  return h;
}

async function passBody(request) {
  return request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
}

function relay(r) {
  const h = new Headers();
  h.set("content-type", r.headers.get("content-type") || "application/json");
  h.set("cache-control", "no-store");
  return new Response(r.body, { status: r.status, headers: h });
}

// ------------------------------------------------------------------ Yandex

async function proxyYandex(request, path) {
  const extra = {};
  const ct = request.headers.get("content-type");
  if (ct) extra["Content-Type"] = ct;
  const r = await fetch(YA + path, { method: request.method, headers: yaHeaders(request, extra), body: await passBody(request) });
  return relay(r);
}

async function yaJson(request, path) {
  const r = await fetch(YA + path, { headers: yaHeaders(request) });
  const t = await r.text();
  if (!r.ok) throw new Error(`Яндекс ${r.status}: ${t.slice(0, 160)}`);
  return JSON.parse(t).result;
}

async function md5hex(s) {
  const d = await crypto.subtle.digest("MD5", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function yandexStream(request, id) {
  if (!id) return json({ error: "id required" }, 400);
  const infos = await yaJson(request, `tracks/${encodeURIComponent(id)}/download-info`);
  const best = infos.filter(i => i.codec === "mp3").sort((a, b) => (b.bitrateInKbps || 0) - (a.bitrateInKbps || 0))[0] || infos[0];
  if (!best) return json({ error: "трек недоступен" }, 404);
  const xml = await (await fetch(best.downloadInfoUrl)).text();
  const tag = n => (xml.match(new RegExp(`<${n}>([^<]*)</${n}>`)) || [])[1] || "";
  const path = tag("path");
  const sign = await md5hex(SIGN_SALT + path.slice(1) + tag("s"));
  return json({ url: `https://${tag("host")}/get-mp3/${sign}/${tag("ts")}${path}`, bitrate: best.bitrateInKbps });
}

async function yandexLyrics(request, id, synced) {
  if (!id) return json({ error: "id required" }, 400);
  const numeric = id.split(":")[0];
  const ts = Math.floor(Date.now() / 1000).toString();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(LYRICS_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(numeric + ts));
  const sign = btoa(String.fromCharCode(...new Uint8Array(mac)));
  const res = await yaJson(request, `tracks/${numeric}/lyrics?format=${synced ? "LRC" : "TEXT"}&timeStamp=${ts}&sign=${encodeURIComponent(sign)}`);
  if (!res?.downloadUrl) return json({ text: null });
  const text = await (await fetch(res.downloadUrl)).text();
  return json({ synced, text });
}

// ------------------------------------------------------------------ SoundCloud

async function clientId(fresh) {
  if (scClientId && !fresh && Date.now() - scClientIdAt < 6 * 3600_000) return scClientId;
  const html = await (await fetch("https://soundcloud.com/", { headers: { "User-Agent": UA } })).text();
  const scripts = [...html.matchAll(/<script crossorigin src="(https:\/\/[^"]+\.js)"/g)].map(m => m[1]).reverse();
  for (const src of scripts) {
    const js = await (await fetch(src, { headers: { "User-Agent": UA } })).text();
    const m = js.match(/client_id[:=]"?([A-Za-z0-9]{32})/);
    if (m) { scClientId = m[1]; scClientIdAt = Date.now(); return scClientId; }
  }
  throw new Error("не удалось получить client_id SoundCloud");
}

async function proxySoundCloud(request, pathAndQuery, retried = false) {
  const id = await clientId(retried);
  const target = new URL(SC + pathAndQuery);
  target.searchParams.set("client_id", id);
  const h = { "User-Agent": UA };
  const t = request.headers.get("x-sc-token");
  if (t) h.Authorization = "OAuth " + t;
  const r = await fetch(target, { method: request.method, headers: h, body: await passBody(request) });
  // a stale client_id answers 401/403: refresh it once
  if ((r.status === 401 || r.status === 403) && !retried && !t) return proxySoundCloud(request, pathAndQuery, true);
  return relay(r);
}

// ------------------------------------------------------------------ audio pipe (fallback)

const PIPE_HOSTS = [/\.storage\.yandex\.net$/, /\.music\.yandex\.net$/, /\.yandex\.ru$/, /\.sndcdn\.com$/, /\.soundcloud\.cloud$/];

async function pipe(request, u) {
  if (!u) return json({ error: "u required" }, 400);
  const target = new URL(u);
  if (target.protocol !== "https:" || !PIPE_HOSTS.some(rx => rx.test(target.hostname))) return json({ error: "host not allowed" }, 403);
  const h = {};
  const range = request.headers.get("range");
  if (range) h.Range = range;
  const r = await fetch(target, { headers: h });
  const out = new Headers();
  for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = r.headers.get(k);
    if (v) out.set(k, v);
  }
  return new Response(r.body, { status: r.status, headers: out });
}
