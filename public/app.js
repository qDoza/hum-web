// HUM web — the iPhone version of the desktop tray player.
// Talks only to its own Worker (/api/*); tokens stay in this phone's storage.

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = ms => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
const plural = n => n % 10 === 1 && n % 100 !== 11 ? "трек" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "трека" : "треков";
const VERSION = "11";

// ================================================================== storage
// Tokens are kept twice (localStorage and a first-party cookie), so a home-screen app that loses one
// of them on a cold start still finds the other. The account names are cached too: a slow or failed
// check on launch no longer looks like being logged out.

const store = {
  get(k, d) { try { const v = localStorage.getItem("hum." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("hum." + k, JSON.stringify(v)); } catch {} },
};
const S = Object.assign({
  source: "ya", tab: "wave", diversity: "default", padX: 0.7, padY: 0.75,
  scBase: "likes", scGenre: null, scNoSets: true, scOnlyNew: false, scFresh: false,
}, store.get("settings", {}));
const saveS = () => store.set("settings", S);

// ================================================================== look («Оформление»)

const LOOK_DEFAULT = { accent: "mono", bg: "black", contrast: "normal", font: "system", shape: "soft", cover: "round", spin: true, plbg: "glass", vizStyle: "bars", vizAmt: 1, motion: "full" };
S.look = Object.assign({}, LOOK_DEFAULT, S.look || {});
const ACCENTS = [["mono", "Белый", "#f2f2f2"], ["cover", "По обложке", null], ["lime", "Лайм", "#c8f53c"], ["coral", "Коралл", "#ff6a55"], ["lilac", "Сирень", "#b38cff"],
  ["mint", "Мята", "#45e0b0"], ["amber", "Янтарь", "#ffb43d"], ["sky", "Небо", "#58b2ff"], ["pink", "Розовый", "#ff5ca8"], ["red", "Красный", "#ff3b3b"]];
const BGS = [["black", "Чёрный", "#000"], ["graphite", "Графит", "#1b1b1f"], ["midnight", "Полночь", "#0d1322"], ["warm", "Тёплый", "#19140f"], ["forest", "Лес", "#0e1812"], ["cover", "По обложке", null]];
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
// the colour the visualizer and the UI accent use right now
const accentRgb = () => { const a = ACCENTS.find(x => x[0] === S.look.accent); return a?.[2] ? hexRgb(a[2]) : null; };

function applyLook() {
  const L = S.look, root = document.documentElement;
  root.dataset.bg = L.bg; root.dataset.contrast = L.contrast; root.dataset.font = L.font; root.dataset.shape = L.shape;
  root.dataset.plbg = L.plbg; root.dataset.motion = L.motion;
  const coverRgb = (typeof viz !== "undefined" ? viz.target : [200, 200, 200]).map(Math.round);
  const ac = L.accent === "cover" ? coverRgb : accentRgb() || [242, 242, 242];
  root.style.setProperty("--ac", `rgb(${ac.join(",")})`);
  root.style.setProperty("--on-ac", lum(ac) > 0.5 ? "#000" : "#fff");
  root.style.setProperty("--cover-r", L.cover === "square" ? "18px" : "50%");
  if (L.bg === "cover") {
    const m = (k, add) => `rgb(${coverRgb.map(v => Math.round(v * k + add)).join(",")})`;
    root.style.setProperty("--bg", m(0.055, 0)); root.style.setProperty("--panel", m(0.1, 8)); root.style.setProperty("--chip", m(0.13, 14));
    root.style.setProperty("--mode", m(0.19, 20)); root.style.setProperty("--line", m(0.15, 14));
  } else for (const k of ["--bg", "--panel", "--chip", "--mode", "--line"]) root.style.removeProperty(k);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue("--bg").trim() || "#000";
}

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const toB64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function cookieTokens() {
  const m = document.cookie.match(/(?:^|;\s*)hum_t=([^;]+)/);
  if (!m) return null;
  try { return JSON.parse(new TextDecoder().decode(b64url(m[1]))); } catch { return null; }
}
function saveTokens() {
  store.set("tokens", tokens);
  const has = tokens.ya || tokens.sc;
  document.cookie = has
    ? `hum_t=${toB64url(new TextEncoder().encode(JSON.stringify(tokens)))}; Path=/; Max-Age=34560000; SameSite=Strict; Secure`
    : "hum_t=; Path=/; Max-Age=0; SameSite=Strict; Secure";
}
let tokens = store.get("tokens", null);
if (!tokens || (!tokens.ya && !tokens.sc)) tokens = cookieTokens() || tokens || {};
if (tokens.ya || tokens.sc) saveTokens();
navigator.storage?.persist?.().catch(() => {});

const isStandalone = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

// iPhone home-screen apps can get a viewport one status bar shorter than the screen that still starts at
// the very top, under the clock, while the strip at the bottom (home indicator) is not painted at all.
// So: pad the top by that difference, and don't reserve anything at the bottom; that strip is already spare.
const vp = { st: 0, sb: 0, H: 0, ih: 0, gap: 0 };
function fixViewport() {
  const root = document.documentElement;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  vp.st = parseFloat(cs.paddingTop) || 0; vp.sb = parseFloat(cs.paddingBottom) || 0;
  probe.remove();
  const portrait = innerHeight >= innerWidth;
  vp.H = portrait ? Math.max(screen.height, screen.width) : Math.min(screen.height, screen.width);
  vp.ih = innerHeight;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  vp.gap = ios && isStandalone() ? Math.max(0, vp.H - innerHeight) : 0;
  for (const k of ["--app-h", "--gap", "--safe-t", "--safe-b"]) root.style.removeProperty(k);
  if (vp.gap > 8) {
    root.style.setProperty("--safe-t", Math.max(vp.st, vp.gap) + "px");
    root.style.setProperty("--safe-b", "0px");
  } else if (ios && isStandalone() && vp.st === 0 && screen.height >= 812) {
    root.style.setProperty("--safe-t", "50px");
    root.style.setProperty("--safe-b", Math.max(vp.sb, 21) + "px");
  }
}
fixViewport();
addEventListener("resize", () => requestAnimationFrame(fixViewport));
addEventListener("orientationchange", () => setTimeout(fixViewport, 300));
setTimeout(fixViewport, 600);

// ================================================================== pairing
// Desktop QR: https://…/#p=<id>.<key>. The Worker holds only the AES-GCM ciphertext under <id>
// (gone after one read); the key never leaves this #fragment.
// The camera opens such links in Safari, whose storage is separate from the home-screen app, so after
// a Safari pairing we park the tokens again under a short code the user types into the app.

const ALPH = "abcdefghjkmnpqrstuvwxyz23456789";
let pairing = null, handoffCode = null;
function takePairCode() { return pairing ??= takePairCodeOnce().finally(() => { pairing = null; }); }

async function fetchBlob(id) {
  let r, j;
  // a fresh code may take a few seconds to reach the nearest Cloudflare location
  for (let attempt = 0; attempt < 6; attempt++) {
    r = await fetch("/api/pair/" + id, { cache: "no-store" });
    j = await r.json();
    if (r.ok || r.status !== 404) break;
    await new Promise(res => setTimeout(res, 1800));
  }
  if (!r.ok) throw new Error(j.error || "код недействителен");
  return b64url(j.blob);
}
async function decryptTokens(raw, key) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
  const o = JSON.parse(new TextDecoder().decode(plain));
  tokens = { ...tokens, ...(o.ya ? { ya: o.ya } : {}), ...(o.sc ? { sc: o.sc } : {}) };
  saveTokens();
}
const codeKey = async secret => crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hum-handoff:" + secret)), "AES-GCM", false, ["encrypt", "decrypt"]);

async function takePairCodeOnce() {
  const m = location.hash.match(/^#p=([a-z0-9]{6})\.([A-Za-z0-9_-]{43})$/);
  if (!m) return;
  history.replaceState(null, "", "/");
  try {
    const key = await crypto.subtle.importKey("raw", b64url(m[2]), "AES-GCM", false, ["decrypt"]);
    await decryptTokens(await fetchBlob(m[1]), key);
    setTimeout(() => toast("Аккаунты перенесены с компьютера"), 400);
    if (!isStandalone()) makeHandoff().then(c => { handoffCode = c; openAccounts(); }).catch(() => {});
  } catch (e) { setTimeout(() => toast("Не удалось перенести: " + e.message), 400); }
}

async function makeHandoff() {
  const secret = [...crypto.getRandomValues(new Uint8Array(4))].map(b => ALPH[b % ALPH.length]).join("");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await codeKey(secret), new TextEncoder().encode(JSON.stringify(tokens))));
  const blob = new Uint8Array(12 + ct.length); blob.set(iv); blob.set(ct, 12);
  const r = await fetch("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blob: toB64url(blob), ttl: 1800 }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return (j.id + secret).toUpperCase();
}

async function redeemCode(code) {
  const c = code.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (c.length !== 10) throw new Error("в коде 10 символов");
  await decryptTokens(await fetchBlob(c.slice(0, 6)), await codeKey(c.slice(6)));
}

// the older, long form: https://…/#pair=<base64url JSON> (still accepted)
if (location.hash.startsWith("#pair=")) {
  try {
    const o = JSON.parse(new TextDecoder().decode(b64url(location.hash.slice(6))));
    tokens = { ...tokens, ...(o.ya ? { ya: o.ya } : {}), ...(o.sc ? { sc: o.sc } : {}) };
    saveTokens();
    setTimeout(() => toast("Аккаунты перенесены с компьютера"), 400);
  } catch { setTimeout(() => toast("Ссылка для переноса повреждена"), 400); }
  history.replaceState(null, "", "/");
}

// ================================================================== API

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const h = { ...headers };
  if (tokens.ya) h["x-ya-token"] = tokens.ya;
  if (tokens.sc) h["x-sc-token"] = tokens.sc;
  const r = await fetch(path, { method, headers: h, body });
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch {}
  if (!r.ok) {
    const e = new Error(j?.error?.message || j?.error?.name || (typeof j?.error === "string" ? j.error : "") || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return j;
}
const ya = (p, o) => api("/api/ya/" + p, o).then(j => j?.result);
const yaPost = (p, form) => ya(p, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
const yaJson = (p, obj) => ya(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
const sc = (p, o) => api("/api/sc/" + p.replace(/^https:\/\/api-v2\.soundcloud\.com\//, ""), o);

// ================================================================== tracks

const YA_GENRES = { rusrap: "русский рэп", foreignrap: "рэп", rap: "рэп", rusrock: "русский рок", rock: "рок", ruspop: "русская поп", pop: "поп", electronics: "электроника", dance: "танцевальная", alternative: "альтернатива", indie: "инди", soundtrack: "саундтрек", relax: "релакс", estrada: "эстрада", metal: "метал", jazz: "джаз", rnb: "r&b", soul: "соул", folk: "фолк", classical: "классика", house: "house", techno: "techno", dnb: "drum & bass", lounge: "лаунж", local_indie: "инди" };

function yaTrack(n) {
  if (!n || n.available === false || n.id == null) return null;
  const al = (n.albums || [])[0];
  const id = String(n.id);
  const cv = n.coverUri || al?.coverUri;
  const li = n.lyricsInfo || {};
  return {
    src: "ya", id: al?.id ? `${id}:${al.id}` : id, key: "ya:" + id,
    title: (n.title || "Без названия") + (n.version ? ` (${n.version})` : ""),
    artist: (n.artists || []).map(a => a.name).filter(Boolean).join(", ") || "—",
    artists: (n.artists || []).filter(a => a.id && a.name && !a.various).map(a => ({ id: String(a.id), name: a.name })),
    album: al?.title, dur: n.durationMs || 0,
    cover: cv ? "https://" + cv.replace("%%", "200x200") : null,
    big: cv ? "https://" + cv.replace("%%", "600x600") : null,
    tiny: cv ? "https://" + cv.replace("%%", "50x50") : null,
    genre: al?.genre ? (YA_GENRES[al.genre] || al.genre) : null, year: al?.year || null,
    synced: !!li.hasAvailableSyncLyrics, hasLyrics: !!(li.hasAvailableSyncLyrics || li.hasAvailableTextLyrics),
  };
}

function scTrack(n) {
  if (!n || (n.kind && n.kind !== "track") || n.policy === "BLOCK" || n.id == null) return null;
  const trans = (n.media?.transcodings || []).map(x => ({ url: x.url, protocol: x.format?.protocol || "", mime: x.format?.mime_type || "" }))
    .filter(x => x.url && !x.url.includes("/preview"));
  const art = n.artwork_url || n.user?.avatar_url;
  const released = Date.parse(n.release_date || n.created_at || "") || 0;
  return {
    src: "sc", id: String(n.id), key: "sc:" + n.id,
    title: n.title || "Без названия",
    artist: n.publisher_metadata?.artist || n.user?.username || "—",
    dur: n.full_duration || n.duration || 0,
    cover: art ? art.replace("-large.", "-t300x300.") : null,
    big: art ? art.replace("-large.", "-t500x500.") : null,
    tiny: art ? art.replace("-large.", "-t67x67.") : null,
    genre: (n.genre || "").trim().toLowerCase() || null, year: released ? new Date(released).getFullYear() : null,
    trans, auth: n.track_authorization, released,
    hasLyrics: false,
  };
}

// ================================================================== library

const acc = { ya: null, sc: null };
const lib = { liked: [], keys: new Set(), loading: false, activities: [] };
const has = s => !!acc[s];

async function connect() {
  const cached = store.get("acc", {});
  for (const s of ["ya", "sc"]) acc[s] = tokens[s] ? (acc[s] || cached[s] || null) : null;
  renderAll();
  const check = async (s, fn, name) => {
    if (!tokens[s]) return;
    try { acc[s] = await fn(); }
    catch (e) {
      if (e.status === 401 || e.status === 403) { acc[s] = null; toast(`${name}: вход устарел, подключите заново`); }
      else if (!acc[s]) toast(`${name}: нет связи, попробую позже`);
    }
  };
  await Promise.all([
    check("ya", async () => { const r = await ya("account/status"); return { uid: r.account.uid, name: r.account.displayName || r.account.login }; }, "Яндекс"),
    check("sc", async () => { const me = await sc("me"); return { id: me.id, name: me.username }; }, "SoundCloud"),
  ]);
  store.set("acc", { ya: acc.ya, sc: acc.sc });
  renderAll();
  loadActivities();
  await loadLikes();
}

async function loadLikes() {
  lib.loading = true; renderLikesList();
  const all = [];
  const jobs = [];
  if (acc.ya) jobs.push((async () => {
    const r = await ya(`users/${acc.ya.uid}/likes/tracks`);
    const shorts = r?.library?.tracks || [];
    const stamps = new Map(shorts.map(s => [String(s.id), Date.parse(s.timestamp) || 0]));
    const ids = shorts.map(s => s.albumId ? `${s.id}:${s.albumId}` : String(s.id));
    for (let i = 0; i < ids.length; i += 250) {
      const res = await yaPost("tracks", { "track-ids": ids.slice(i, i + 250).join(","), "with-positions": "false" });
      for (const n of res || []) { const t = yaTrack(n); if (t) { t.likedAt = stamps.get(t.key.slice(3)) || 0; all.push(t); } }
    }
  })().catch(() => toast("Яндекс: лайки не загрузились")));
  if (acc.sc) jobs.push((async () => {
    let next = `users/${acc.sc.id}/track_likes?limit=200&linked_partitioning=1`;
    for (let page = 0; page < 15 && next; page++) {
      const r = await sc(next);
      for (const it of r.collection || []) { const t = scTrack(it.track); if (t) { t.likedAt = Date.parse(it.created_at) || 0; all.push(t); } }
      next = r.next_href || null;
    }
  })().catch(() => toast("SoundCloud: лайки не загрузились")));
  await Promise.all(jobs);
  all.sort((a, b) => b.likedAt - a.likedAt);
  lib.liked = []; lib.keys.clear();
  for (const t of all) if (!lib.keys.has(t.key)) { lib.keys.add(t.key); lib.liked.push(t); }
  lib.loading = false;
  renderLikesList(true);
  renderRecent();
}

async function loadActivities() {
  if (!acc.ya) return;
  try {
    const r = await ya("rotor/wave/settings?seeds=" + encodeURIComponent("user:onyourwave"));
    lib.activities = [];
    for (const b of r?.blocks || []) for (const st of b.items || [])
      if (st.id?.type && st.id?.tag && st.name) lib.activities.push({ name: st.name, seed: `${st.id.type}:${st.id.tag}` });
    if (S.source === "ya") renderHome();
  } catch {}
}

const isLiked = t => !!t && lib.keys.has(t.key);

async function toggleLike(t) {
  if (!t) return;
  const liked = !isLiked(t);
  applyLike(t, liked);
  try {
    if (t.src === "ya") await yaPost(`users/${acc.ya.uid}/likes/tracks/${liked ? "add-multiple" : "remove"}`, { "track-ids": t.id });
    else await sc(`users/${acc.sc.id}/track_likes/${t.id}`, { method: liked ? "PUT" : "DELETE" });
  } catch { applyLike(t, !liked); toast("Не удалось изменить лайк"); }
}

// only the hearts change in place; the long likes list is redrawn later, not on every tap
function applyLike(t, liked) {
  if (liked && !lib.keys.has(t.key)) { lib.keys.add(t.key); t.likedAt = Date.now(); lib.liked.unshift(t); }
  if (!liked && lib.keys.has(t.key)) { lib.keys.delete(t.key); lib.liked = lib.liked.filter(x => x.key !== t.key); }
  document.querySelectorAll(`.heart[data-key="${CSS.escape(t.key)}"]`).forEach(b => {
    b.classList.toggle("on", liked);
    b.innerHTML = `<svg><use href="#i-heart${liked ? "-fill" : ""}"/></svg>`;
    if (liked) { b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); }
  });
  if (!liked && S.tab === "likes") document.querySelectorAll(`#likesRows .row[data-key="${CSS.escape(t.key)}"]`).forEach(r => r.classList.add("gone"));
  likesDirty = true;
  clearTimeout(likesTimer);
  likesTimer = setTimeout(() => { if (likesDirty) renderLikesList(); renderRecent(); }, 450);
  renderPlayer();
}

async function streamUrl(t) {
  if (t.src === "ya") return (await api("/api/ya-stream?id=" + encodeURIComponent(t.id))).url;
  // SoundCloud retired most mp3 / adaptive streams; plain AAC HLS works (and Safari plays HLS natively)
  const rank = x => x.protocol === "hls" && x.mime.includes("mp4a") ? 0 : x.protocol === "progressive" ? 1 : x.protocol === "hls" && x.mime.includes("mpeg") && !x.mime.includes("mpegurl") ? 2 : x.protocol === "hls" ? 3 : 9;
  const list = t.trans.filter(x => !x.protocol.includes("encrypted")).sort((a, b) => rank(a) - rank(b));
  let last;
  for (const tc of list) {
    try {
      const r = await sc(tc.url + (t.auth ? "?track_authorization=" + encodeURIComponent(t.auth) : ""));
      if (r?.url) return r.url;
    } catch (e) { last = e; }
  }
  throw last || new Error("у трека нет открытого потока");
}

// ================================================================== player

const audio = $("#audio");
const MIXES = [
  { id: "custom", title: "Свой", group: "Настроение", seeds: [] },
  { id: "active", title: "Бодрое", group: "Настроение", seeds: ["settingMoodEnergy:active"] },
  { id: "fun", title: "Весёлое", group: "Настроение", seeds: ["settingMoodEnergy:fun"] },
  { id: "calm", title: "Спокойное", group: "Настроение", seeds: ["settingMoodEnergy:calm"] },
  { id: "sad", title: "Грустное", group: "Настроение", seeds: ["settingMoodEnergy:sad"] },
  { id: "favorite", title: "Любимое", group: "Характер и язык", seeds: ["settingDiversity:favorite"] },
  { id: "discover", title: "Новое", group: "Характер и язык", seeds: ["settingDiversity:discover"] },
  { id: "popular", title: "Хиты", group: "Характер и язык", seeds: ["settingDiversity:popular"] },
  { id: "ru", title: "Русское", group: "Характер и язык", seeds: ["settingLanguage:russian"] },
  { id: "foreign", title: "Иностранное", group: "Характер и язык", seeds: ["settingLanguage:not-russian"] },
  { id: "instrumental", title: "Без слов", group: "Характер и язык", seeds: ["settingLanguage:without-words"] },
  { id: "focus", title: "Фокус", group: "Подборки", seeds: ["settingMoodEnergy:calm", "settingLanguage:without-words"] },
  { id: "party", title: "Вечеринка", group: "Подборки", seeds: ["settingMoodEnergy:fun", "settingDiversity:popular"] },
  { id: "drive", title: "В дорогу", group: "Подборки", seeds: ["settingMoodEnergy:active", "settingDiversity:favorite"] },
  { id: "dig", title: "Раскопки", group: "Подборки", seeds: ["settingDiversity:discover", "settingLanguage:not-russian"] },
  { id: "rusnew", title: "Новое русское", group: "Подборки", seeds: ["settingDiversity:discover", "settingLanguage:russian"] },
  { id: "evening", title: "Тихий вечер", group: "Подборки", seeds: ["settingMoodEnergy:calm", "settingDiversity:favorite"] },
  { id: "rain", title: "Под дождь", group: "Подборки", seeds: ["settingMoodEnergy:sad", "settingDiversity:discover"] },
];
const SC_BASES = [["likes", "Все лайки"], ["recent", "Свежие лайки"], ["old", "Давние лайки"], ["current", "От текущего"]];
const SC_GENRES = [[null, "Любой"], ["lofi", "Lo-fi"], ["phonk", "Phonk"], ["hip hop", "Hip-hop"], ["trap", "Trap"], ["electronic", "Electronic"],
  ["house", "House"], ["techno", "Techno"], ["drum and bass", "Drum & Bass"], ["ambient", "Ambient"], ["indie", "Indie"], ["rock", "Rock"],
  ["pop", "Pop"], ["r&b", "R&B"], ["jazz", "Jazz"], ["hyperpop", "Hyperpop"], ["русский рэп", "Русский рэп"]];

const P = { queue: [], i: -1, ctx: null, mix: null, ctxSrc: "ya", title: "", session: null, batch: null, seeds: [], waveSrc: "ya",
  gen: 0, busy: false, fetching: false, startedGen: -1, errors: 0, scOffset: 0, vibeKey: null, vibeSeed: null, repeat: false };
const cur = () => P.queue[P.i] || null;
const isWave = () => P.ctx === "mywave" || P.ctx === "mix" || P.ctx === "vibe";
const playing = () => !audio.paused && !audio.ended;

function setBusy(v) { P.busy = v; renderPlayer(); updateHome(); }
function setCtx(ctx, mix, src, title) { P.ctx = ctx; P.mix = mix; P.ctxSrc = src; P.title = title; updateHome(); }

// iOS only lets audio start from a tap; play a moment of silence on the first tap so later
// programmatic play() calls (after network requests, at track end) are allowed.
let unlocked = false;
function unlock() {
  if (unlocked) return;
  unlocked = true;
  const rate = 8000, n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  if (!audio.src) { audio.src = URL.createObjectURL(new Blob([buf], { type: "audio/wav" })); audio.play().then(() => audio.pause()).catch(() => {}); }
}
document.addEventListener("touchend", unlock, { once: true, passive: true });
document.addEventListener("click", unlock, { once: true });

// ---------- gapless hand-over in the background
// iPhone lets a home-screen app start the next track while the screen is off only if it happens right
// away, in the same moment the old one ends: waiting for the network first gets the play() refused.
// So the next track's stream link is fetched ahead of time and swapped in without any await.

const pre = { key: null, url: null, at: 0, busy: false };
// Yandex links are signed with a timestamp and go stale after a while; SoundCloud HLS links live longer
const preFresh = t => pre.key === t.key && pre.url && Date.now() - pre.at < (t.src === "ya" ? 45000 : 300000);
const nextIndex = () => isWave() ? P.i + 1 : P.queue.length ? (P.i + 1) % P.queue.length : -1;

async function prefetchNext() {
  const t = P.queue[nextIndex()];
  if (!t || pre.busy || preFresh(t)) return;
  pre.busy = true;
  try { const url = await streamUrl(t); pre.key = t.key; pre.url = url; pre.at = Date.now(); }
  catch { pre.key = null; }
  pre.busy = false;
}

let handedOver = -1;
// near the end of a track: make sure the next link is ready, and switch a hair before the end so the
// audio session never goes idle (an idle session is what blocks the next play() with the screen off)
function watchEnd() {
  const c = cur();
  if (!c || !audio.duration || !isFinite(audio.duration) || audio.loop || P.repeat) return;
  const left = audio.duration - audio.currentTime;
  if (left < 40) prefetchNext();
  const n = P.queue[nextIndex()];
  if (left < 0.35 && !audio.paused && n && preFresh(n) && handedOver !== P.gen) {
    handedOver = P.gen;
    if (isWave()) fb("trackFinished", c, (c.dur || 0) / 1000);
    go(nextIndex());
  }
}

async function go(i) {
  if (!isWave() && P.queue.length) i = ((i % P.queue.length) + P.queue.length) % P.queue.length;
  if (i >= P.queue.length) { if (isWave()) await fetchMore(true); return; }
  if (i < 0) return;
  P.i = i;
  const t = P.queue[i];
  const g = ++P.gen;
  markCurrent();
  updateMediaSession();
  if (isWave() && i >= P.queue.length - 2) fetchMore(false);
  if (preFresh(t)) {
    // the link is already here: swap and play in this very moment, no network in between
    const url = pre.url;
    pre.key = null;
    t._direct = url; t._retried = false;
    audio.src = url;
    audio.play().catch(e => { if (g === P.gen && e?.name === "NotAllowedError") { setBusy(false); toast("Нажмите ▶, чтобы продолжить"); } });
    setBusy(true);
    if (!document.hidden) analyze(t);
    return;
  }
  audio.pause();
  setBusy(true);
  try {
    const url = await streamUrl(t);
    if (g !== P.gen) return;
    t._direct = url; t._retried = false;
    audio.src = url;
    if (!document.hidden) analyze(t);
    await audio.play();
  } catch (e) {
    if (g !== P.gen) return;
    if (e?.name === "NotAllowedError") { setBusy(false); toast("Нажмите ▶, чтобы начать"); return; }
    failed(e?.message || "ошибка");
  }
}

function failed(why) {
  setBusy(false);
  if (++P.errors < 5) next(false);
  else { P.errors = 0; toast("Не получается воспроизвести: " + why); }
}

async function fetchMore(playNext) {
  if (P.fetching) return;
  P.fetching = true;
  try {
    let more = [];
    if (P.waveSrc === "ya" && P.session) {
      try {
        const r = await yaJson(`rotor/session/${P.session}/tracks`, { queue: P.queue.slice(-10).map(t => t.id) });
        if (!r || r.unknownSession) throw new Error("session");
        P.batch = r.batchId || P.batch;
        more = (r.sequence || []).map(x => yaTrack(x.track)).filter(Boolean);
      } catch {
        const r = await yaJson("rotor/session/new", { seeds: P.seeds, includeTracksInResponse: true });
        P.session = r.radioSessionId; P.batch = r.batchId;
        more = (r.sequence || []).map(x => yaTrack(x.track)).filter(Boolean);
      }
    } else if (P.waveSrc === "sc" && acc.sc) {
      const known = new Set(P.queue.map(t => t.key));
      for (let a = 0; a < 3 && scFilter(more, known).length < 4; a++) {
        if (P.ctx !== "vibe" && S.scGenre && a % 2 === 1) { const r = await sc(`search/tracks?q=${encodeURIComponent(S.scGenre)}&limit=40&offset=${P.scOffset}`); P.scOffset += 40; more.push(...(r.collection || []).map(scTrack).filter(Boolean)); }
        else {
          const c = cur();
          const seed = P.ctx === "vibe" ? (a === 0 ? P.vibeSeed : shuffle([P.vibeSeed, ...P.queue.slice(-4)])[0])
            : a === 0 && c?.src === "sc" ? c : S.scGenre ? P.queue[Math.floor(Math.random() * P.queue.length)] : pickScSeed();
          if (seed) { const r = await sc(`tracks/${seed.id}/related?limit=25`); more.push(...(r.collection || []).map(scTrack).filter(Boolean)); }
        }
      }
      more = scFilter(shuffle(more), known);
    }
    const known = new Set(P.queue.map(t => t.key));
    P.queue.push(...more.filter(t => !known.has(t.key) && known.add(t.key)));
  } catch {}
  P.fetching = false;
  if (playNext) await go(P.i + 1);
}

function fb(type, t, played) {
  if (!P.session || P.waveSrc !== "ya") return;
  const ev = { type, timestamp: new Date().toISOString() };
  if (t) ev.trackId = t.id;
  if (played != null) ev.totalPlayedSeconds = Math.round(played * 10) / 10;
  const body = { event: ev, batchId: P.batch || "" };
  if (type === "radioStarted") body.from = "desktop_win-home-playlist_of_the_day-playlist-default";
  yaJson(`rotor/session/${P.session}/feedback`, body).catch(() => {});
}
const skipFb = () => { const t = cur(); if (t && isWave()) fb("skip", t, audio.currentTime || 0); };

// ---------- starting things

async function playMyWave(src) {
  if (src === "sc") return startScWave("mywave", "Мой эфир");
  return startYaWave(["user:onyourwave"], "mywave", null, "Мой эфир");
}

const moodFromPad = (x, y) => y >= 0.5 ? (x >= 0.5 ? "fun" : "active") : (x >= 0.5 ? "calm" : "sad");

function playMix(id) {
  const m = MIXES.find(x => x.id === id);
  const seeds = ["user:onyourwave"];
  if (id === "custom") { seeds.push("settingMoodEnergy:" + moodFromPad(S.padX, S.padY)); if (S.diversity !== "default") seeds.push("settingDiversity:" + S.diversity); }
  else seeds.push(...m.seeds);
  return startYaWave(seeds, "mix", id, "Микс · " + m.title);
}

const playActivity = a => startYaWave([a.seed], "mix", "act:" + a.seed, "Занятие · " + a.name);

async function startYaWave(seeds, ctx, mix, title) {
  if (!acc.ya) return toast("Подключите Яндекс");
  skipFb();
  const g = ++P.gen;
  setCtx(ctx, mix, "ya", title);
  setBusy(true);
  try {
    const r = await yaJson("rotor/session/new", { seeds, includeTracksInResponse: true });
    if (g !== P.gen) return;
    P.waveSrc = "ya"; P.seeds = seeds; P.session = r.radioSessionId; P.batch = r.batchId;
    fb("radioStarted");
    P.queue = (r.sequence || []).map(x => yaTrack(x.track)).filter(Boolean);
    P.i = -1;
    await go(0);
  } catch (e) { toast("Эфир не запустился: " + e.message); setBusy(false); }
}

function scSeeds() {
  const likes = lib.liked.filter(t => t.src === "sc");
  return S.scBase === "recent" ? likes.slice(0, 15) : S.scBase === "old" ? likes.slice(-40) : likes;
}
function pickScSeed() {
  const c = cur();
  if (S.scBase === "current" && c?.src === "sc") return c;
  const s = scSeeds();
  return s.length ? s[Math.floor(Math.random() * s.length)] : (c?.src === "sc" ? c : null);
}
function scFilter(list, known) {
  const seen = new Set(known);
  const yearAgo = Date.now() - 365 * 864e5;
  return list.filter(t => t.src === "sc" && t.trans.some(x => !x.protocol.includes("encrypted"))
    && !(S.scNoSets && t.dur > 8 * 60000) && !(S.scOnlyNew && isLiked(t)) && !(S.scFresh && (t.released || 0) < yearAgo)
    && !seen.has(t.key) && seen.add(t.key));
}

async function startScWave(ctx, title) {
  if (!acc.sc) return toast("Подключите SoundCloud");
  if (!S.scGenre && !scSeeds().length) return toast("Лайкните пару треков в SoundCloud — эфир соберётся из них");
  skipFb();
  const g = ++P.gen;
  setBusy(true);
  try {
    let start = [];
    if (S.scGenre) {
      const r = await sc(`search/tracks?q=${encodeURIComponent(S.scGenre)}&limit=40&offset=${Math.floor(Math.random() * 3) * 40}`);
      start = shuffle((r.collection || []).map(scTrack).filter(Boolean)).slice(0, 12);
      P.scOffset = 40;
    } else {
      const seed = pickScSeed();
      if (!S.scOnlyNew) start.push(seed);
      const r = await sc(`tracks/${seed.id}/related?limit=25`);
      start.push(...(r.collection || []).map(scTrack).filter(Boolean));
    }
    if (g !== P.gen) return;
    const q = scFilter(start, new Set());
    if (!q.length) { setBusy(false); return toast("Под эти фильтры ничего не нашлось — ослабьте их"); }
    P.waveSrc = "sc"; P.session = null;
    const genre = SC_GENRES.find(x => x[0] === S.scGenre);
    setCtx(ctx, null, "sc", S.scGenre ? `${title} · ${genre?.[1] || S.scGenre}` : title);
    P.queue = q; P.i = -1;
    await go(0);
  } catch (e) { toast("Эфир SoundCloud не запустился"); setBusy(false); }
}

// «Эфир по вайбу»: the current track keeps playing and becomes the seed of a new wave
async function startVibe() {
  const t = cur();
  if (!t) return;
  if (P.ctx === "vibe" && P.vibeKey === t.key) return toast("Уже играет эфир по этому треку");
  setBusy(true);
  try {
    let list;
    if (t.src === "ya") {
      if (!acc.ya) throw new Error("подключите Яндекс");
      const seeds = ["track:" + t.id.split(":")[0]];
      const r = await yaJson("rotor/session/new", { seeds, includeTracksInResponse: true });
      list = (r.sequence || []).map(x => yaTrack(x.track)).filter(Boolean);
      P.waveSrc = "ya"; P.seeds = seeds; P.session = r.radioSessionId; P.batch = r.batchId;
      fb("radioStarted");
    } else {
      if (!acc.sc) throw new Error("подключите SoundCloud");
      const r = await sc(`tracks/${t.id}/related?limit=30`);
      list = scFilter(shuffle((r.collection || []).map(scTrack).filter(Boolean)), new Set([t.key]));
      P.waveSrc = "sc"; P.session = null; P.vibeSeed = t;
    }
    list = list.filter(x => x.key !== t.key);
    if (!list.length) throw new Error("похожего не нашлось");
    P.vibeKey = t.key;
    setCtx("vibe", null, t.src, "Эфир по вайбу · " + t.title);
    P.queue = [t, ...list]; P.i = 0;
    setBusy(false);
    if (!playing() && audio.src && !audio.src.startsWith("blob:")) audio.play().catch(() => {});
    toast(`Дальше — похожее на «${t.title}»`);
  } catch (e) { setBusy(false); toast("Не получилось: " + e.message); }
}

function playList(list, start, ctx, title) {
  if (!list.length) return;
  skipFb();
  P.session = null;
  setCtx(ctx, null, list[start]?.src || "ya", title);
  P.queue = [...list]; P.i = -1;
  go(start);
}

// ---------- controls

function toggle() {
  unlock();
  if (!cur()) { const s = has(S.source) ? S.source : has("ya") ? "ya" : "sc"; return playMyWave(s); }
  if (playing()) audio.pause(); else audio.play().catch(() => {});
}
function next(user = true) { if (!cur()) return; if (user) skipFb(); go(P.i + 1); }
function prev() { if (!cur()) return; if (audio.currentTime > 3 || P.i <= 0) { audio.currentTime = 0; return; } go(P.i - 1); }
async function dislike() {
  const t = cur(); if (!t || !isWave()) return;
  next();
  if (isLiked(t)) toggleLike(t);
  if (t.src === "ya" && acc.ya) yaPost(`users/${acc.ya.uid}/dislikes/tracks/add-multiple`, { "track-ids": t.id }).catch(() => {});
  toast("Больше не будет попадаться");
}
function shuffleRest() {
  if (P.queue.length - P.i < 3) return;
  P.queue = [...P.queue.slice(0, P.i + 1), ...shuffle(P.queue.slice(P.i + 1))];
  toast("Дальше — вперемешку");
}

audio.addEventListener("playing", () => {
  if (!cur()) return;
  P.errors = 0;
  setBusy(false);
  if (P.startedGen !== P.gen && isWave()) { P.startedGen = P.gen; fb("trackStarted", cur()); }
});
audio.addEventListener("pause", () => { renderPlayer(); updateHome(); });
audio.addEventListener("play", () => { renderPlayer(); updateHome(); });
audio.addEventListener("ended", () => {
  if (handedOver === P.gen) return;
  handedOver = P.gen;
  const t = cur(); if (t && isWave()) fb("trackFinished", t, (t.dur || 0) / 1000);
  next(false);
});
audio.addEventListener("timeupdate", watchEnd);
audio.addEventListener("error", () => {
  const t = cur();
  if (!t || !audio.src || audio.src.startsWith("blob:")) return;
  if (!t._retried) {
    t._retried = true;
    const g = P.gen;
    streamUrl(t).then(url => { if (g !== P.gen) return; t._direct = url; audio.src = url; audio.play().catch(() => {}); }).catch(() => { if (g === P.gen) failed("поток недоступен"); });
    return;
  }
  // a Yandex link that refuses the phone directly gets one more try through the Worker
  if (t.src === "ya" && t._direct && !audio.src.includes("/api/pipe")) { audio.src = "/api/pipe?u=" + encodeURIComponent(t._direct); audio.play().catch(() => {}); return; }
  failed("поток недоступен");
});
audio.addEventListener("timeupdate", onTime);
audio.addEventListener("loadedmetadata", onTime);

// ---------- lock screen / Control Center

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const t = cur();
  if (!t) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album || P.title,
    artwork: t.big ? [{ src: t.big, sizes: t.src === "ya" ? "600x600" : "500x500", type: "image/jpeg" }] : [],
  });
}
// iPhone shows «−10 / +10 s» on the lock screen unless the seek actions are explicitly cleared;
// with them cleared it shows previous / next track. Re-applied on every track, since a new src can reset them.
function mediaHandlers() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
  set("play", () => audio.play());
  set("pause", () => audio.pause());
  set("nexttrack", () => next());
  set("previoustrack", () => prev());
  set("seekbackward", null);
  set("seekforward", null);
  set("seekto", d => { audio.currentTime = d.seekTime; });
}
mediaHandlers();
audio.addEventListener("loadedmetadata", mediaHandlers);

// ================================================================== UI: shell

let toastTimer;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

// restarts a one-shot CSS animation class on an element
function restart(el, cls) { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
// swaps an icon inside a button with a small morph, only when it really changes
function setIcon(btn, name) {
  if (!btn || btn._icon === name) return;
  const first = btn._icon === undefined;
  btn._icon = name;
  btn.innerHTML = `<svg><use href="#i-${name}"/></svg>`;
  if (!first) restart(btn, "morph");
}

const TABS = ["wave", "likes", "search"];
function showTab(tab) {
  const changed = S.tab !== tab;
  const dir = TABS.indexOf(tab) > TABS.indexOf(S.tab) ? "r" : "l";
  S.tab = tab; saveS();
  for (const b of document.querySelectorAll(".tab")) {
    const on = b.dataset.tab === tab;
    b.classList.toggle("on", on);
    if (on && changed) restart(b, "bump");
  }
  for (const p of TABS) {
    const el = $("#page-" + p);
    el.hidden = p !== tab;
    if (p === tab && changed) { el.classList.remove("enter", "enter-l", "enter-r"); void el.offsetWidth; el.classList.add("enter", "enter-" + dir); }
  }
  if (tab === "likes" && likesDirty) renderLikesList(true);
  placeBlob();
}
function placeBlob() {
  const b = document.querySelector(`.tab[data-tab="${S.tab}"]`), blob = $("#tabBlob");
  if (!b) return;
  blob.style.left = b.offsetLeft + "px";
  blob.style.width = b.offsetWidth + "px";
}
$("#tabs").addEventListener("click", e => { const b = e.target.closest(".tab"); if (b) showTab(b.dataset.tab); });
addEventListener("resize", placeBlob);

const coverStyle = url => url ? `style="background-image:url('${esc(url)}')"` : "";

function renderAll() { renderHome(); buildLikes(); buildSearch(); renderPlayer(); }

// ---------- bottom sheets

let openSheetEl = null;
function openSheet(el) {
  restart(el, "stagger");
  if (openSheetEl && openSheetEl !== el) openSheetEl.hidden = true;
  openSheetEl = el;
  $("#scrim").hidden = false; $("#scrim").classList.remove("out");
  el.hidden = false; el.classList.remove("out");
}
function closeSheet() {
  const el = openSheetEl;
  if (!el) return;
  openSheetEl = null;
  el.classList.add("out"); $("#scrim").classList.add("out");
  setTimeout(() => { if (openSheetEl !== el) { el.hidden = true; $("#scrim").hidden = true; } }, 280);
}
$("#scrim").addEventListener("click", closeSheet);
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", closeSheet));
document.querySelectorAll(".bsheet").forEach(sh => {
  let y0 = null;
  sh.addEventListener("touchstart", e => { if (e.target.closest(".grab, .bs-head")) y0 = e.touches[0].clientY; }, { passive: true });
  sh.addEventListener("touchend", e => { if (y0 != null && e.changedTouches[0].clientY - y0 > 60) closeSheet(); y0 = null; }, { passive: true });
});

// ================================================================== UI: «Эфир» (home)

const DIV_LABEL = { favorite: "Знакомое", default: "Любое", discover: "Новое" };
const discs = i => "k" + (i % 10);

function heroSub() {
  const src = S.source;
  const mine = isWave() && P.ctxSrc === src && cur();
  if (P.busy && P.ctxSrc === src && isWave()) return "Подбираю…";
  if (mine) return P.title;
  if (src === "ya") return `Яндекс · ${DIV_LABEL[S.diversity] || "Любое"}`;
  const g = SC_GENRES.find(x => x[0] === S.scGenre)?.[1];
  return `SoundCloud · ${S.scGenre ? g : SC_BASES.find(x => x[0] === S.scBase)?.[1]}`;
}

function renderHome() {
  const el = $("#page-wave");
  const src = S.source;
  const connected = has(src);
  let h = `<div class="hero">
      <canvas id="heroRings"></canvas>
      <div class="srcs"><button data-act="src" data-v="ya" class="${src === "ya" ? "on" : ""}">Яндекс</button><button data-act="src" data-v="sc" class="${src === "sc" ? "on" : ""}">SoundCloud</button></div>
      <button class="ib tune" data-act="tune" aria-label="Настройки эфира"><svg><use href="#i-tune"/></svg></button>
      <div class="mid"><div class="name">Мой эфир</div><div class="sub" id="heroSub"></div>
        <button class="hero-play" id="heroPlay" data-act="mywave" aria-label="Мой эфир"><svg><use href="#i-play"/></svg></button></div>
    </div>`;

  if (!connected) {
    h += `<div class="card"><div class="t">${src === "ya" ? "Яндекс не подключён" : "SoundCloud не подключён"}</div>
      <div class="muted" style="margin-top:4px">В HUM на компьютере нажмите «Подключить iPhone» и наведите камеру на QR-код. Если QR открылся в Safari, там появится код — введите его здесь.</div>
      <div class="codebox"><input class="field" id="homeCode" placeholder="КОД" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false"><button class="btn" data-act="code">Войти</button></div></div>`;
    el.innerHTML = h;
    updateHome();
    return;
  }

  if (src === "ya") {
    const moods = [["mywave", "Любое"], ...MIXES.filter(m => m.group === "Настроение" && m.id !== "custom").map(m => [m.id, m.title])];
    h += `<div class="chips row1">${moods.map(([id, t]) => `<button class="chip" data-act="${id === "mywave" ? "mywave" : "mix"}" data-v="${id}">${t}</button>`).join("")}</div>`;
    const mixes = [...MIXES.filter(m => m.group !== "Настроение").map(m => ({ act: "mix", v: m.id, t: m.title })),
      ...lib.activities.map((a, i) => ({ act: "activity", v: String(i), t: a.name }))];
    h += `<div class="h">Миксы <small>${mixes.length}</small></div><div class="mixes">${mixes.map((m, i) =>
      `<button class="mix" data-act="${m.act}" data-v="${esc(m.v)}"><span class="disc ${discs(i)}"></span><span>${esc(m.t)}</span></button>`).join("")}</div>`;
  } else {
    h += `<div class="chips row1">${SC_GENRES.map(([v, t], i) => `<button class="chip" data-act="scgenre-go" data-v="${i}">${esc(t)}</button>`).join("")}</div>`;
    h += `<div class="h">Основа эфира</div><div class="mixes">${SC_BASES.map(([v, t], i) =>
      `<button class="mix" data-act="scbase-go" data-v="${v}"><span class="disc ${discs(i + 3)}"></span><span>${t}</span></button>`).join("")}</div>`;
  }
  h += `<div class="h">Недавние лайки <button class="more" data-act="alllikes">Все</button></div><div class="rows" id="recentRows"></div>`;
  el.innerHTML = h;
  renderRecent();
  updateHome();
}

// cheap: only flips classes and text, so the hero canvas and scroll position survive
function updateHome() {
  const sub = $("#heroSub");
  if (!sub) return;
  const src = S.source;
  const mine = isWave() && P.ctxSrc === src && cur();
  sub.textContent = heroSub();
  const play = $("#heroPlay");
  setIcon(play, mine && playing() ? "pause" : "play");
  play.classList.toggle("busy", P.busy && isWave() && P.ctxSrc === src);
  document.querySelectorAll("#page-wave [data-act]").forEach(b => {
    const a = b.dataset.act, v = b.dataset.v;
    const on = a === "mywave" && b.classList.contains("chip") ? P.ctx === "mywave" && P.ctxSrc === "ya"
      : a === "mix" ? P.ctx === "mix" && P.mix === v
      : a === "activity" ? P.ctx === "mix" && P.mix === "act:" + lib.activities[+v]?.seed
      : a === "scgenre-go" ? (SC_GENRES[+v][0] === S.scGenre)
      : a === "scbase-go" ? S.scBase === v && !S.scGenre : null;
    if (on !== null) b.classList.toggle("on", !!on);
  });
}

function renderRecent() {
  const box = $("#recentRows");
  if (!box) return;
  lists.recent = lib.liked.slice(0, 6);
  box.innerHTML = lib.loading && !lib.liked.length ? skeleton(4)
    : !lists.recent.length ? `<div class="empty">Лайков пока нет</div>`
    : lists.recent.map(t => rowHtml(t, "recent")).join("");
}

$("#page-wave").addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const v = b.dataset.v;
  switch (b.dataset.act) {
    case "src": if (S.source !== v) { S.source = v; saveS(); renderHome(); buildSearch(); } break;
    case "tune": openTune(); break;
    case "mywave": restart($(".hero"), "burst"); unlock(); if (P.ctx === "mywave" && P.ctxSrc === S.source && cur()) toggle(); else if (isWave() && P.ctxSrc === S.source && cur() && b.id === "heroPlay") toggle(); else playMyWave(S.source); break;
    case "mix": unlock(); playMix(v); break;
    case "activity": unlock(); playActivity(lib.activities[+v]); break;
    case "scgenre-go": unlock(); S.scGenre = SC_GENRES[+v][0]; saveS(); startScWave("mywave", "Мой эфир"); updateHome(); break;
    case "scbase-go": unlock(); S.scBase = v; S.scGenre = null; saveS(); startScWave("mywave", "Мой эфир"); updateHome(); break;
    case "alllikes": showTab("likes"); break;
    case "code": submitCode($("#homeCode")); break;
  }
});
$("#page-wave").addEventListener("click", e => { if (e.target.closest("#recentRows")) onRowsClick(e); });

// ---------- wave settings sheet

function openTune() { renderTune(); openSheet($("#tune")); }

function renderTune() {
  const el = $("#tuneBody");
  if (S.source === "ya") {
    const active = P.ctx === "mix" && P.mix === "custom";
    el.innerHTML = `<div class="cap">Своё настроение <span style="text-transform:none;letter-spacing:0;font-weight:400">— тяните точку</span></div>
      <div class="pad" id="pad">${padSvg(active)}</div>
      <div class="cap">Характер</div>
      <div class="seg">${[["favorite", "Знакомое"], ["default", "Любое"], ["discover", "Новое"]].map(([v, t]) =>
        `<button data-act="div" data-v="${v}" class="${S.diversity === v ? "on" : ""}">${t}</button>`).join("")}</div>
      <p class="note">Отпустите точку — заиграет микс «Свой» с этим настроением и характером. Характер применяется и к нему.</p>`;
    wirePad();
  } else {
    el.innerHTML = `<div class="cap">Основа</div><div class="chips">${SC_BASES.map(([v, t]) =>
        `<button class="chip ${S.scBase === v ? "on" : ""}" data-act="scbase" data-v="${v}">${t}</button>`).join("")}</div>
      <div class="cap">Жанр и вайб</div><div class="chips">${SC_GENRES.map(([v, t], i) =>
        `<button class="chip ${S.scGenre === v ? "on" : ""}" data-act="scgenre" data-v="${i}">${esc(t)}</button>`).join("")}</div>
      <div class="cap">Ещё</div><div class="chips">${[["scNoSets", "Без длинных сетов"], ["scOnlyNew", "Только незнакомое"], ["scFresh", "Свежее, за год"]].map(([k, t]) =>
        `<button class="chip check ${S[k] ? "on" : ""}" data-act="scflag" data-v="${k}">${t}</button>`).join("")}</div>
      <p class="note">Если эфир SoundCloud уже играет, фильтры применяются сразу.</p>`;
  }
}

$("#tuneBody").addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const v = b.dataset.v;
  switch (b.dataset.act) {
    case "div": S.diversity = v; saveS(); if (P.ctx === "mix" && P.mix === "custom") playMix("custom"); break;
    case "scbase": S.scBase = v; scChanged(); break;
    case "scgenre": S.scGenre = SC_GENRES[+v][0]; scChanged(); break;
    case "scflag": S[v] = !S[v]; scChanged(); break;
  }
  renderTune(); updateHome();
});
function scChanged() {
  saveS();
  if (P.ctx === "mywave" && P.ctxSrc === "sc") startScWave("mywave", "Мой эфир");
}

// mood pad: drag the point; x = sad → happy, y = quiet → energetic
function padSvg(active) {
  const W = 340, H = 150, L = 36, B = 22, T = 6;
  const aw = W - L - 2, ah = H - T - B - 4;
  const px = L + aw * S.padX, py = T + ah * (1 - S.padY);
  const sx = L, sy = T + ah * 0.78, ex = L + aw, ey = T + ah * (1 - (0.35 + S.padY * 0.3));
  const c = `M${sx},${sy} C${sx + (px - sx) * .55},${sy} ${px - (px - sx) * .45},${py} ${px},${py} C${px + (ex - px) * .45},${py} ${ex - (ex - px) * .55},${ey} ${ex},${ey}`;
  const col = active ? "#f2f2f2" : "#8a8a8a";
  let grid = "";
  for (let i = 0; i <= 4; i++) { const x = L + aw * i / 4; grid += `<line x1="${x}" y1="${T}" x2="${x}" y2="${T + ah}"/>`; }
  for (let i = 0; i <= 2; i++) { const y = T + ah * i / 2; grid += `<line x1="${L}" y1="${y}" x2="${L + aw}" y2="${y}"/>`; }
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <g stroke="#2a2a2a" stroke-dasharray="3 4" vector-effect="non-scaling-stroke">${grid}</g>
    <path d="${c} L${ex},${T + ah} L${sx},${T + ah} Z" fill="rgba(242,242,242,${active ? .1 : .05})"/>
    <path d="${c}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${active ? `<circle cx="${px}" cy="${py}" r="14" fill="none" stroke="rgba(242,242,242,.25)" vector-effect="non-scaling-stroke"/>` : ""}
    <circle cx="${px}" cy="${py}" r="7.5" fill="${col}"/>
    <g fill="#8a8a8a" font-size="10.5" font-family="-apple-system,system-ui">
      <text x="0" y="${T + 9}">бодро</text><text x="0" y="${T + ah}">тихо</text>
      <text x="${L}" y="${H - 2}">грустно</text><text x="${L + aw / 2}" y="${H - 2}" text-anchor="middle">спокойно</text><text x="${L + aw}" y="${H - 2}" text-anchor="end">весело</text>
    </g></svg>`;
}

function wirePad() {
  const pad = $("#pad");
  if (!pad) return;
  const W = 340, H = 150, L = 36, B = 22, T = 6, aw = W - L - 2, ah = H - T - B - 4;
  let dragging = false;
  const move = e => {
    const r = pad.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * W, y = (e.clientY - r.top) / r.height * H;
    S.padX = Math.min(1, Math.max(0, (x - L) / aw));
    S.padY = Math.min(1, Math.max(0, 1 - (y - T) / ah));
    pad.innerHTML = padSvg(true);
  };
  pad.addEventListener("pointerdown", e => { dragging = true; pad.setPointerCapture(e.pointerId); move(e); });
  pad.addEventListener("pointermove", e => { if (dragging) move(e); });
  pad.addEventListener("pointerup", () => { if (!dragging) return; dragging = false; saveS(); unlock(); playMix("custom"); });
  pad.addEventListener("pointercancel", () => { dragging = false; renderTune(); });
}

// ================================================================== UI: track rows (likes + search)

const lists = { likes: [], search: [], recent: [], arpop: [], arall: [] };

function rowHtml(t, list, i = -1) {
  const liked = isLiked(t), c = cur();
  return `<div class="row ${c && c.key === t.key ? "cur" : ""}${i >= 0 && i < 14 ? " in" : ""}" ${i >= 0 && i < 14 ? `style="animation-delay:${i * 28}ms"` : ""} data-act="play" data-list="${list}" data-key="${esc(t.key)}">
    <div class="cover row-c" ${coverStyle(t.cover)}>${c && c.key === t.key ? '<span class="eq"><i></i><i></i><i></i></span>' : ""}</div>
    <div class="meta"><div class="t">${esc(t.title)}</div><div class="s"><span class="tag">${t.src === "ya" ? "ЯМ" : "SC"}</span><span>${esc(t.artist)}</span></div></div>
    <div class="d">${fmt(t.dur)}</div>
    <button class="heart ${liked ? "on" : ""}" data-act="like" data-key="${esc(t.key)}" aria-label="Нравится"><svg><use href="#i-heart${liked ? "-fill" : ""}"/></svg></button></div>`;
}

function onRowsClick(e) {
  const b = e.target.closest("[data-act]");
  if (!b || (b.dataset.act !== "like" && b.dataset.act !== "play")) return;
  const all = [...lists.likes, ...lists.search, ...lists.recent, ...lists.arpop, ...lists.arall, ...P.queue, ...lib.liked];
  const t = all.find(x => x.key === b.dataset.key);
  if (!t) return;
  if (b.dataset.act === "like") { e.stopPropagation(); toggleLike(t); return; }
  unlock();
  if (cur()?.key === t.key) return toggle();
  const name = b.dataset.list;
  if (name === "arpop" || name === "arall") { const l = [...lists.arpop, ...lists.arall]; return playList(l, l.indexOf(t), "artist", AR.name); }
  const list = name === "recent" ? lib.liked : lists[name];
  playList(list, list.indexOf(t), name === "search" ? "search" : "likes", name === "search" ? "Поиск" : "Любимое");
}

function markCurrent() {
  const c = cur();
  document.querySelectorAll(".row.cur").forEach(r => { r.classList.remove("cur"); r.querySelector(".eq")?.remove(); });
  if (!c) return;
  document.querySelectorAll(`.row[data-key="${CSS.escape(c.key)}"]`).forEach(r => {
    r.classList.add("cur");
    r.querySelector(".cover")?.insertAdjacentHTML("beforeend", '<span class="eq"><i></i><i></i><i></i></span>');
  });
}

// ================================================================== UI: «Любимое»

let likesFilter = null, likesQuery = "", likesDirty = true, likesTimer;

function buildLikes() {
  const el = $("#page-likes");
  el.innerHTML = `<div class="h" style="margin-top:8px"><span style="font-size:24px">Любимое <small id="likesCount"></small></span>
      <span style="display:flex;gap:6px"><button class="ib" id="likesShuffle" aria-label="Перемешать"><svg><use href="#i-shuffle"/></svg></button>
      <button class="ib" id="likesPlay" aria-label="Слушать"><svg><use href="#i-play"/></svg></button></span></div>
    <div class="search"><svg><use href="#i-search"/></svg><input id="likesQ" type="search" placeholder="Поиск в любимом" autocomplete="off"></div>
    <div class="chips" id="likesFilters" style="margin-top:10px"></div>
    <div class="rows" id="likesRows"></div>`;
  $("#likesQ").addEventListener("input", e => { likesQuery = e.target.value.trim().toLowerCase(); renderLikesList(); });
  $("#likesFilters").addEventListener("click", e => { const b = e.target.closest("[data-v]"); if (!b) return; likesFilter = b.dataset.v || null; renderLikesList(true); });
  $("#likesRows").addEventListener("click", onRowsClick);
  $("#likesPlay").addEventListener("click", () => { unlock(); playList(lists.likes, 0, "likes", "Любимое"); });
  $("#likesShuffle").addEventListener("click", () => { unlock(); playList(shuffle(lists.likes), 0, "likes", "Любимое · вперемешку"); });
  renderLikesList();
}

function renderLikesList(animate = false) {
  const rows = $("#likesRows");
  if (!rows) return;
  likesDirty = false;
  const n = s => lib.liked.filter(t => t.src === s).length;
  $("#likesCount").textContent = `${lib.liked.length} ${plural(lib.liked.length)}`;
  $("#likesFilters").innerHTML = [["", "Все"], ...(has("ya") ? [["ya", `Яндекс · ${n("ya")}`]] : []), ...(has("sc") ? [["sc", `SoundCloud · ${n("sc")}`]] : [])]
    .map(([v, t]) => `<button class="chip ${(likesFilter || "") === v ? "on" : ""}" data-v="${v}">${t}</button>`).join("");
  lists.likes = lib.liked.filter(t => (!likesFilter || t.src === likesFilter) &&
    (!likesQuery || t.title.toLowerCase().includes(likesQuery) || t.artist.toLowerCase().includes(likesQuery)));
  rows.innerHTML = !has("ya") && !has("sc") ? `<div class="empty">Подключите Яндекс или SoundCloud — лайки из обоих сервисов соберутся здесь.</div>`
    : lib.loading && !lib.liked.length ? skeleton(8)
    : !lists.likes.length ? `<div class="empty">${likesQuery ? "Ничего не нашлось" : "Пока пусто"}</div>`
    : null;
  // null above = there are rows to show: the first screen now, the rest in small chunks
  if (!rows.innerHTML) chunked(rows, lists.likes, (t, i) => rowHtml(t, "likes", animate ? i : -1));
}

const skeleton = n => Array.from({ length: n }, (_, i) => `<div class="row skel" style="animation-delay:${i * 60}ms"><div class="cover row-c"></div><div class="meta"><div class="sk w1"></div><div class="sk w2"></div></div></div>`).join("");

let chunkJob = 0;
function chunked(el, list, html) {
  const job = ++chunkJob;
  el.innerHTML = list.slice(0, 40).map(html).join("");
  let i = 40;
  const step = () => {
    if (job !== chunkJob || i >= list.length) return;
    el.insertAdjacentHTML("beforeend", list.slice(i, i + 120).map((t, k) => html(t, -1 - k)).join(""));
    i += 120;
    setTimeout(step, 30);
  };
  setTimeout(step, 60);
}

// ================================================================== UI: «Поиск»

let searchTimer, searchReq = 0;

function buildSearch() {
  const el = $("#page-search");
  const q = $("#searchQ")?.value || "";
  el.innerHTML = `<div class="h" style="margin-top:8px"><span style="font-size:24px">Поиск</span></div>
    <div class="seg"><button data-v="ya" class="${S.source === "ya" ? "on" : ""}">Яндекс</button><button data-v="sc" class="${S.source === "sc" ? "on" : ""}">SoundCloud</button></div>
    <div class="search"><svg><use href="#i-search"/></svg><input id="searchQ" type="search" placeholder="Найти песню или исполнителя" autocomplete="off" enterkeyhint="search"></div>
    <div class="muted" id="searchStatus" style="margin:12px 2px 0"></div>
    <div class="rows" id="searchRows"></div>`;
  const input = $("#searchQ");
  input.value = q;
  input.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 450); });
  input.addEventListener("keydown", e => { if (e.key === "Enter") { input.blur(); runSearch(); } });
  el.querySelector(".seg").addEventListener("click", e => { const b = e.target.closest("[data-v]"); if (!b) return; S.source = b.dataset.v; saveS(); buildSearch(); renderHome(); runSearch(); });
  $("#searchRows").addEventListener("click", onRowsClick);
  if (!has(S.source)) $("#searchStatus").textContent = (S.source === "ya" ? "Яндекс" : "SoundCloud") + " не подключён — откройте «Аккаунты»";
  else if (lists.search.length && q) $("#searchRows").innerHTML = lists.search.map(t => rowHtml(t, "search")).join("");
}

async function runSearch() {
  const q = $("#searchQ").value.trim(), src = S.source, req = ++searchReq;
  const status = $("#searchStatus"), rows = $("#searchRows");
  if (q.length < 2 || !has(src)) { if (!q) { rows.innerHTML = ""; status.textContent = ""; } return; }
  status.textContent = "Ищу…";
  try {
    let list;
    if (src === "ya") list = ((await ya(`search?text=${encodeURIComponent(q)}&type=track&page=0&nocorrect=false`))?.tracks?.results || []).map(yaTrack).filter(Boolean);
    else list = ((await sc(`search/tracks?q=${encodeURIComponent(q)}&limit=40`)).collection || []).map(scTrack).filter(Boolean);
    if (req !== searchReq) return;
    lists.search = list;
    status.textContent = list.length ? `${src === "ya" ? "Яндекс" : "SoundCloud"} · ${list.length} ${plural(list.length)}` : "Ничего не нашлось";
    rows.innerHTML = list.map((t, i) => rowHtml(t, "search", i)).join("");
  } catch (e) { if (req === searchReq) status.textContent = "Поиск не удался: " + e.message; }
}

// ================================================================== UI: player (mini + full screen)

const pl = $("#player");
let shownKey = null, coverFront = "A";

function renderPlayer() {
  document.body.classList.toggle("is-playing", playing());
  const t = cur();
  $("#mini").hidden = !t;
  if (!t) return;
  const icon = playing() ? "pause" : "play";
  $("#miniCover").style.backgroundImage = t.cover ? `url('${t.cover}')` : "";
  $("#miniTitle").textContent = t.title;
  $("#miniSub").textContent = P.busy && !playing() ? "Загружаю…" : t.artist;
  setIcon($("#miniPlay"), icon);

  if (shownKey !== t.key) {
    shownKey = t.key;
    // crossfade the cover, the glow behind the glass and the titles
    const front = coverFront === "A" ? $("#cvA") : $("#cvB"), back = coverFront === "A" ? $("#cvB") : $("#cvA");
    back.style.backgroundImage = t.big ? `url('${t.big}')` : "";
    back.classList.remove("hide"); front.classList.add("hide");
    coverFront = coverFront === "A" ? "B" : "A";
    for (const g of [$("#glow1"), $("#glow2")]) g.style.backgroundImage = t.cover ? `url('${t.cover}')` : "";
    const ti = $("#plTitles"); ti.classList.remove("swap"); void ti.offsetWidth; ti.classList.add("swap");
    restart($("#miniOpen"), "slide");
    $("#plTitle").textContent = t.title;
    // Yandex artists are links to their page
    const who = t.src === "ya" && t.artists?.length ? t.artists.map(a => `<button class="ar-link" data-artist="${esc(a.id)}">${esc(a.name)}</button>`).join(", ") : esc(t.artist);
    $("#plArtist").innerHTML = t.album ? `${who} · ${esc(t.album)}` : who;
    tintFrom(t);
    viz.bpm = 84 + (hash(t.key) % 48);
    if (lyricsOpen) loadLyrics();
  }
  const tags = [`<span class="pill">${t.src === "ya" ? "Яндекс" : "SoundCloud"}</span>`];
  if (t.genre) tags.push(`<span class="pill">${esc(t.genre)}</span>`);
  if (t.year) tags.push(`<span class="pill">${t.year}</span>`);
  if (t.hasLyrics) tags.push(`<button class="pill ${lyricsOpen ? "on" : ""}" data-act="lyrics"><svg><use href="#i-lyrics"/></svg>Текст</button>`);
  $("#plTags").innerHTML = tags.join("");
  $("#lyricsBtn").classList.toggle("on", lyricsOpen);
  $("#lyricsBtn").style.opacity = t.hasLyrics ? "1" : ".35";
  $("#plCtx").textContent = P.title;
  setIcon($("#plPlay"), icon);
  $("#plCover").classList.toggle("paused", !playing() && !P.busy);
  const liked = isLiked(t);
  setIcon($("#plLike"), liked ? "heart-fill" : "heart");
  const left = $("#plLeft");
  left.innerHTML = `<svg><use href="#i-${isWave() ? "dislike" : "shuffle"}"/></svg>`;
  left.setAttribute("aria-label", isWave() ? "Не нравится" : "Перемешать");
  $("#plRepeat").classList.toggle("on", P.repeat);
  const vibeOn = P.ctx === "vibe" && P.vibeKey === t.key;
  $("#plVibe").classList.toggle("on", vibeOn);
  $("#vibeSub").textContent = vibeOn ? "Играет: похожее на этот трек" : `Похожее по звучанию на «${t.title}»`;
  $("#plVibe .vibe-go").textContent = vibeOn ? "Играет" : "Запустить";
  updateHome();
}

let lastPosState = 0;
function onTime() {
  const d = audio.duration && isFinite(audio.duration) ? audio.duration * 1000 : cur()?.dur || 0;
  const pos = audio.currentTime * 1000;
  const f = d ? Math.min(1, pos / d) : 0;
  $("#miniBar").style.transform = `scaleX(${f.toFixed(4)})`;
  if (!seeking) {
    $("#seek").value = Math.round(f * 1000);
    $("#seek").style.setProperty("--p", (f * 100).toFixed(2) + "%");
    $("#tPos").textContent = fmt(pos);
  }
  $("#tDur").textContent = fmt(d);
  followLyrics(pos);
  if ("mediaSession" in navigator && navigator.mediaSession.setPositionState && Date.now() - lastPosState > 4000 && d > 0) {
    lastPosState = Date.now();
    try { navigator.mediaSession.setPositionState({ duration: d / 1000, position: Math.min(d / 1000, audio.currentTime), playbackRate: 1 }); } catch {}
  }
}

let seeking = false;
const seek = $("#seek");
seek.addEventListener("input", () => {
  seeking = true;
  const d = audio.duration && isFinite(audio.duration) ? audio.duration * 1000 : cur()?.dur || 0;
  seek.style.setProperty("--p", seek.value / 10 + "%");
  $("#tPos").textContent = fmt(d * seek.value / 1000);
});
seek.addEventListener("change", () => {
  const d = audio.duration && isFinite(audio.duration) ? audio.duration : (cur()?.dur || 0) / 1000;
  if (d) audio.currentTime = d * seek.value / 1000;
  seeking = false;
});

$("#miniPlay").addEventListener("click", toggle);
$("#miniNext").addEventListener("click", () => next());
$("#miniOpen").addEventListener("click", openPlayer);
$("#plPlay").addEventListener("click", toggle);
$("#plNext").addEventListener("click", () => next());
$("#plPrev").addEventListener("click", prev);
$("#plLeft").addEventListener("click", () => isWave() ? dislike() : shuffleRest());
$("#plRepeat").addEventListener("click", () => { P.repeat = !P.repeat; audio.loop = P.repeat; renderPlayer(); toast(P.repeat ? "Повтор трека включён" : "Повтор выключен"); });
$("#plLike").addEventListener("click", () => { toggleLike(cur()); const b = $("#plLike"); b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); });
$("#plClose").addEventListener("click", closePlayer);
$("#plVibe").addEventListener("click", startVibe);
$("#lyricsBtn").addEventListener("click", () => setLyrics(!lyricsOpen));
$("#plTags").addEventListener("click", e => { if (e.target.closest("[data-act=lyrics]")) setLyrics(!lyricsOpen); });

let playerOpen = false, swiping = false;
function openPlayer() {
  playerOpen = true;
  pl.hidden = false;
  restart(pl, "stagger");
  renderPlayer(); onTime();
  requestAnimationFrame(() => requestAnimationFrame(() => pl.classList.add("open")));
}
function closePlayer() {
  playerOpen = false;
  pl.classList.remove("open", "drag");
  pl.style.transform = "";
  setTimeout(() => { if (!playerOpen) pl.hidden = true; }, 560);
}

// gestures: drag the player down to close it; swipe the cover sideways for next / previous; double-tap it to like
(() => {
  let x0 = 0, y0 = 0, t0 = 0, mode = null, lastTap = 0;
  pl.addEventListener("touchstart", e => {
    if (e.target.closest(".seek, .lyrics, .pl-tags, .controls")) { mode = "none"; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); mode = null;
  }, { passive: true });
  pl.addEventListener("touchmove", e => {
    if (mode === "none") return;
    const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
    if (!mode && Math.hypot(dx, dy) > 8) mode = Math.abs(dy) > Math.abs(dx) ? (dy > 0 ? "down" : "none") : e.target.closest("#plStage") ? "side" : "none";
    if (mode === "down") { pl.classList.add("drag"); pl.style.transform = `translateY(${Math.max(0, dy)}px)`; }
    if (mode === "side") swiping = true, $("#plCover").style.translate = `${dx * 0.35}px 0`;
  }, { passive: true });
  pl.addEventListener("touchend", e => {
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0, v = dy / Math.max(1, Date.now() - t0);
    if (mode === "down") {
      if (dy > 120 || v > 0.6) closePlayer();
      else { pl.classList.remove("drag"); pl.style.transform = ""; }
    } else if (mode === "side") {
      swiping = false; $("#plCover").style.translate = "";
      if (dx < -60) next(); else if (dx > 60) prev();
    } else if (!mode && e.target.closest("#plCover")) {
      if (Date.now() - lastTap < 320) { const t = cur(); if (t && !isLiked(t)) toggleLike(t); heartBurst(); lastTap = 0; }
      else lastTap = Date.now();
    }
    mode = null;
  }, { passive: true });
})();

function heartBurst() {
  const b = $("#plLike"); b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop");
  viz.kick = 1;
}

// ================================================================== visuals: cover light + rings

const viz = { color: [200, 200, 200], target: [200, 200, 200], level: 0, low: 0, mid: 0, high: 0, hit: 0, bpm: 110, kick: 0 };
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// the dominant vivid colour of the cover tints the rings, the play-button glow and the lyrics
function tintFrom(t) {
  const url = t.tiny || t.cover;
  if (!url) { viz.target = [200, 200, 200]; return; }
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    try {
      const c = document.createElement("canvas"); c.width = c.height = 16;
      const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0, 16, 16);
      const d = x.getImageData(0, 0, 16, 16).data;
      let r = 0, g = 0, b = 0, w = 0;
      for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        const sat = mx ? (mx - mn) / mx : 0, wt = 0.05 + sat * sat * (mx / 255);
        r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
      }
      viz.target = lift([r / w, g / w, b / w]);
      if (cur()?.key === t.key) { document.documentElement.style.setProperty("--accent", viz.target.map(Math.round).join(", ")); if (S.look.accent === "cover" || S.look.bg === "cover") applyLook(); }
    } catch {}
  };
  img.src = "/api/img?u=" + encodeURIComponent(url);
}
// keep the hue, make it bright enough to glow on black
function lift([r, g, b]) {
  const mx = Math.max(r, g, b, 1), k = 235 / mx;
  const out = [r * k, g * k, b * k];
  const avg = (out[0] + out[1] + out[2]) / 3;
  return out.map(v => Math.min(255, avg + (v - avg) * 1.25));
}

// ---------- beat analysis
// Tapping the playing <audio> with Web Audio would mute it in the background on iPhone, so the track is
// fetched a second time (same origin, through the Worker), decoded at 16 kHz and boiled down to four
// curves at 50 frames/s: bass, mids, highs and onsets. The visuals then follow the real music by time.
// SoundCloud streams are HLS segments, which can't be decoded this way: they get a synthetic pulse.

const ana = { key: null, low: null, mid: null, high: null, hit: null };
globalThis.humViz = () => ({ track: ana.key, frames: ana.low?.length || 0, viz: { ...viz } });

// the number crunching runs in a Web Worker, so the interface never stalls while a track is analysed
function bandsJob(c0, c1, sr) {
  const hop = Math.round(sr / 50), n = Math.floor(c0.length / hop);
  const low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n), hit = new Float32Array(n);
  const k = f => Math.exp(-2 * Math.PI * f / sr);
  const aL = k(140), aM1 = k(350), aM2 = k(2500), aH = k(5000);
  let l = 0, m1 = 0, m2 = 0, h = 0;
  for (let i = 0, s = 0; i < n; i++) {
    let el = 0, em = 0, eh = 0;
    for (let j = 0; j < hop; j++, s++) {
      const x = c1 ? (c0[s] + c1[s]) * 0.5 : c0[s];
      l = l * aL + x * (1 - aL); m1 = m1 * aM1 + x * (1 - aM1); m2 = m2 * aM2 + x * (1 - aM2); h = h * aH + x * (1 - aH);
      el += l * l; em += (m2 - m1) * (m2 - m1); eh += (x - h) * (x - h);
    }
    low[i] = Math.sqrt(el / hop); mid[i] = Math.sqrt(em / hop); high[i] = Math.sqrt(eh / hop);
  }
  for (let i = 1; i < n; i++) hit[i] = Math.max(0, low[i] - low[i - 1]) * 2 + Math.max(0, mid[i] - mid[i - 1]);
  // stretch each curve between its quiet (4th) and loud (97th) percentile, so every track fills the range
  const norm = a => { const s = Float32Array.from(a).sort(), lo = s[Math.floor(s.length * 0.04)], hi = s[Math.floor(s.length * 0.97)] || 1, span = Math.max(1e-6, hi - lo); for (let i = 0; i < a.length; i++) a[i] = Math.min(1.3, Math.max(0, (a[i] - lo) / span)); };
  // mids and highs barely change in level; what the eye wants is their attacks, so mix those in
  const punch = a => { const tr = new Float32Array(a.length); let avg = a[0] || 0; for (let i = 0; i < a.length; i++) { tr[i] = Math.max(0, a[i] - avg); avg += (a[i] - avg) * 0.08; } norm(tr); for (let i = 0; i < a.length; i++) a[i] = a[i] * 0.7 + tr[i] * 0.55; };
  [low, mid, high, hit].forEach(norm);
  punch(mid); punch(high);
  return { low, mid, high, hit };
}
let anaWorker = null;
function crunch(c0, c1, sr) {
  try {
    anaWorker ??= new Worker(URL.createObjectURL(new Blob([`onmessage = e => { const r = (${bandsJob})(e.data.c0, e.data.c1, e.data.sr); postMessage(r, [r.low.buffer, r.mid.buffer, r.high.buffer, r.hit.buffer]); };`], { type: "text/javascript" })));
  } catch { return Promise.resolve(bandsJob(c0, c1, sr)); }
  return new Promise(ok => {
    anaWorker.onmessage = e => ok(e.data);
    const a = c0.slice(), b = c1 ? c1.slice() : null;
    anaWorker.postMessage({ c0: a, c1: b, sr }, b ? [a.buffer, b.buffer] : [a.buffer]);
  });
}

async function analyze(t) {
  if (!t || t.src !== "ya" || !t._direct || S.viz === false || ana.key === t.key) return;
  ana.key = t.key; ana.low = null;
  try {
    const r = await fetch("/api/pipe?u=" + encodeURIComponent(t._direct));
    if (!r.ok || ana.key !== t.key) return;
    const data = await r.arrayBuffer();
    if (ana.key !== t.key) return;
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ab = await new Promise((ok, no) => { const p = new AC(1, 16000, 16000).decodeAudioData(data, ok, no); p?.catch?.(no); });
    if (ana.key !== t.key) return;
    const sr = ab.sampleRate, c0 = ab.getChannelData(0), c1 = ab.numberOfChannels > 1 ? ab.getChannelData(1) : null;
    const { low, mid, high, hit } = await crunch(c0, c1, sr);
    if (ana.key !== t.key) return;
    Object.assign(ana, { low, mid, high, hit });
  } catch { if (ana.key === t.key) ana.key = null; }
}

// a steady per-track pulse for whatever couldn't be analysed
function pulseAt(sec) {
  const bp = 60 / viz.bpm, ph = (sec % bp) / bp, beat = Math.floor(sec / bp) % 4;
  const kick = Math.exp(-ph * 7) * (beat === 0 ? 1 : beat === 2 ? 0.85 : 0.6);
  const snare = beat % 2 ? Math.exp(-ph * 9) * 0.7 : 0;
  const hat = Math.exp(-(((ph * 2) % 1)) * 10) * 0.5;
  return [kick, 0.35 + snare + 0.15 * Math.sin(sec * 1.7), 0.25 + hat, ph < 0.08 ? kick : 0];
}

function bandsAt(sec) {
  const c = cur();
  if (ana.low && c && ana.key === c.key) {
    const i = Math.min(ana.low.length - 1, Math.max(0, Math.round(sec * 50) + 1));
    return [ana.low[i], ana.mid[i], ana.high[i], ana.hit[i]];
  }
  return pulseAt(sec);
}

// Sizes are learnt from ResizeObserver, never measured inside the frame loop: reading layout right after
// writing styles each frame forces the browser to redo layout 60 times a second, which is what made things stutter.
const DPR = Math.min(devicePixelRatio || 1, 2);
const box = new WeakMap();          // element -> { w, h } in CSS pixels
const ro = new ResizeObserver(entries => {
  for (const e of entries) {
    const { width, height } = e.contentRect;
    box.set(e.target, { w: width, h: height });
    if (e.target instanceof HTMLCanvasElement) { e.target.width = Math.round(width * DPR); e.target.height = Math.round(height * DPR); }
  }
});
function fitCanvas(c) {
  if (!box.has(c)) { ro.observe(c); box.set(c, { w: 0, h: 0 }); }
  return DPR;
}

function ring(x, cx, cy, r, t, k, amp) {
  x.beginPath();
  for (let a = 0; a <= Math.PI * 2 + 0.001; a += Math.PI / 90) {
    const n = Math.sin(a * 3 + t * 0.8 + k * 1.3) * 0.5 + Math.sin(a * 5 - t * 1.2 + k * 2.1) * 0.32 + Math.sin(a * 2 + t * 0.45 + k) * 0.42;
    const rr = r + n * amp;
    a ? x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr) : x.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  x.closePath();
  x.stroke();
}

// 64 bars per half, mirrored left/right: bass at the top, highs at the bottom, like the music channels
const BARS = 64;
const barVals = new Float32Array(BARS);
const barSeed = Float32Array.from({ length: BARS }, (_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1);

function updateBars(t) {
  const [lo, mi, hi] = [viz.low, viz.mid, viz.high];
  for (let i = 0; i < BARS; i++) {
    const f = i / (BARS - 1);
    const band = f < 0.28 ? lo * (1.1 - f) + mi * f : f < 0.7 ? mi * (0.85 + 0.3 * Math.sin(f * 9 + t * 1.3)) + lo * 0.15 : hi * (0.75 + 0.35 * Math.sin(f * 17 - t * 2.1)) + mi * 0.12;
    const wob = 0.65 + 0.35 * Math.sin(t * (3 + barSeed[i] * 4) + i * 0.8) * Math.sin(t * 1.3 + i * 0.37);
    const target = Math.max(0, band * wob) * viz.level;
    barVals[i] += (target - barVals[i]) * (target > barVals[i] ? 0.55 : 0.14);
  }
}

// dust that flies out of the cover; bass pushes it faster
const dust = Array.from({ length: 70 }, () => ({ a: Math.random() * Math.PI * 2, r: Math.random(), v: 0.2 + Math.random() * 0.8, s: 0.6 + Math.random() * 1.6 }));

function drawHero(t) {
  const c = $("#heroRings");
  if (!c) return;
  const d = fitCanvas(c), x = c.getContext("2d"), w = c.width, h = c.height, cx = w / 2, cy = h / 2;
  if (!w || !h) return;
  x.clearRect(0, 0, w, h);
  const mine = isWave() && P.ctxSrc === S.source && cur();
  const lo = mine ? viz.low : 0, mi = mine ? viz.mid : 0;
  const base = Math.min(w, h) * 0.36 * (1 + lo * 0.05);
  for (let k = 0; k < 5; k++) {
    const [ar, ag, ab] = S.look.accent === "cover" ? viz.color.map(Math.round) : accentRgb() || [242, 242, 242];
    x.strokeStyle = `rgba(${ar},${ag},${ab},${(0.6 - k * 0.11).toFixed(3)})`;
    x.lineWidth = d * (k ? 1 : 1.7);
    ring(x, cx, cy, base * (1 + k * 0.07) + lo * k * 6 * d, t * (1 + mi), k, d * (3 + lo * 16 + mi * 6) * (1 + k * 0.3));
  }
}

function drawPlayer(t, dt) {
  const c = $("#plRings");
  const d = fitCanvas(c), x = c.getContext("2d"), w = c.width, h = c.height, cx = w / 2, cy = h / 2;
  x.clearRect(0, 0, w, h);
  if (lyricsOpen) return;
  const style = S.look.vizStyle;
  if (style === "off") return;
  const [r, g, b] = (accentRgb() && S.look.accent !== "mono" ? accentRgb() : viz.color).map(Math.round);
  const lo = viz.low, mi = viz.mid, hi = viz.high, hit = viz.hit;
  const cr = (coverBox().w || 200) / 2 * d * (1 + lo * 0.11 + hit * 0.06) * (S.look.cover === "square" ? 1.13 : 1);
  const room = Math.min(w / 2, h / 2) - cr;
  if (style === "minimal") {
    x.strokeStyle = `rgba(${r},${g},${b},${(0.55 + hit * 0.4).toFixed(3)})`;
    x.lineWidth = d * (1.5 + lo * 2.5);
    ring(x, cx, cy, cr + (14 + lo * 16) * d, t, 1, d * (1 + mi * 5));
    return;
  }
  if (style === "waves") {
    for (let k = 0; k < 6; k++) {
      const f = k / 6;
      x.strokeStyle = `rgba(${Math.round(r + (255 - r) * f)},${Math.round(g + (255 - g) * f)},${Math.round(b + (255 - b) * f)},${(0.75 - k * 0.1).toFixed(3)})`;
      x.lineWidth = d * (k ? 1.3 : 2.4);
      ring(x, cx, cy, cr + (12 + k * 12) * d + lo * (8 + k * 6) * d, t * (1 + mi), k, d * (3 + lo * 14 + mi * 10 + hi * 4) * (1 + k * 0.35));
    }
    return;
  }
  updateBars(t);

  // dust
  x.fillStyle = `rgba(${r},${g},${b},0.75)`;
  x.beginPath();
  if (S.look.motion !== "reduced") for (const p of dust) {
    p.r += dt * p.v * (0.04 + viz.level * 0.1 + lo * 0.5 + hit * 0.8);
    if (p.r > 1) { p.r = 0; p.a = Math.random() * Math.PI * 2; }
    const rr = cr + p.r * (room + 40 * d) * 1.1, sz = p.s * d * (1 + lo);
    const px = cx + Math.cos(p.a) * rr, py = cy + Math.sin(p.a) * rr;
    x.globalAlpha = Math.min(1, (1 - p.r) * 1.4);
    x.moveTo(px + sz, py); x.arc(px, py, sz, 0, Math.PI * 2);
  }
  x.fill();
  x.globalAlpha = 1;

  // mirrored spectrum bars with a glow
  const r0 = cr + 7 * d, maxLen = Math.max(18 * d, room - 14 * d);
  const bars = (scale, width, alpha, glow) => {
    x.beginPath();
    for (let side = -1; side <= 1; side += 2)
      for (let i = 0; i < BARS; i++) {
        const a = -Math.PI / 2 + side * (i + 0.5) / BARS * Math.PI;
        const len = (2.5 * d + barVals[i] * maxLen * scale);
        x.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        x.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
      }
    x.lineWidth = width * d; x.lineCap = "round";
    x.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    x.stroke();
    // fake glow: the same bars again, wide and faint (canvas shadows are slow on iPhone)
    if (glow) { x.lineWidth = (width + glow) * d; x.strokeStyle = `rgba(${r},${g},${b},0.16)`; x.stroke(); }
  };
  bars(1, 3.2, 0.9, 5 + lo * 7);
  bars(0.55, 1.4, 0.95, 0);

  // two thin waves riding just outside the bars
  for (let k = 0; k < 2; k++) {
    x.strokeStyle = `rgba(255,255,255,${(0.35 - k * 0.15 + hit * 0.3).toFixed(3)})`;
    x.lineWidth = d * (1.2 - k * 0.4);
    ring(x, cx, cy, r0 + maxLen * (0.55 + k * 0.25) + lo * 10 * d, t * (1 + mi * 1.5), k + 3, d * (2 + mi * 9 + hi * 5) * (1 + k));
  }
}

const coverEl = $("#plCover"), glow1El = $("#glow1"), glow2El = $("#glow2");
ro.observe(coverEl);
const coverBox = () => box.get(coverEl) || { w: 0, h: 0 };
// write a style only when it really changes (every write invalidates styles)
const put = (el, prop, v) => { if (el["_" + prop] !== v) { el["_" + prop] = v; el.style[prop] = v; } };

let lastFrame = 0, spin = 0, odd = false;
function frame(ms) {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  // nothing animated on screen: skip the frame entirely; idle home ring: 30 fps is plenty
  if (!playerOpen && S.tab !== "wave") return;
  odd = !odd;
  if (!playerOpen && !playing() && viz.level < 0.02 && odd) return;
  const t = ms / 1000, dt = Math.min(0.05, (ms - lastFrame) / 1000 || 0.016);
  lastFrame = ms;
  viz.level += ((playing() ? 1 : 0) - viz.level) * 0.05;
  for (let i = 0; i < 3; i++) viz.color[i] += (viz.target[i] - viz.color[i]) * 0.05;
  const [lo, mi, hi, hit] = bandsAt(audio.currentTime || 0).map(v => v * viz.level * S.look.vizAmt);
  const ease = (k, v, up, down) => { viz[k] += (v - viz[k]) * (v > viz[k] ? up : down); };
  ease("low", lo, 0.6, 0.15); ease("mid", mi, 0.5, 0.15); ease("high", hi, 0.6, 0.2); ease("hit", Math.min(1, hit + viz.kick), 0.8, 0.12);
  viz.kick *= 0.92;
  if (playerOpen) {
    drawPlayer(t, dt);
    const cv = coverEl;
    spin = S.look.spin && S.look.cover !== "square" ? (spin + dt * 9 * viz.level) % 360 : spin * 0.9;
    put(cv, "scale", (1 + viz.low * 0.11 + viz.hit * 0.06).toFixed(3));
    put(cv, "rotate", (spin + Math.sin(t * 1.7) * viz.mid * 2).toFixed(1) + "deg");
    if (!swiping && S.look.motion !== "reduced") {
      const sh = viz.hit > 0.55 ? (viz.hit - 0.55) * 9 : 0;
      put(cv, "translate", sh ? `${((Math.random() - 0.5) * sh).toFixed(1)}px ${((Math.random() - 0.5) * sh).toFixed(1)}px` : "");
    }
    const gk = S.look.plbg === "vivid" ? 1.5 : 1;
    put(glow1El, "opacity", ((0.35 + viz.low * 0.4 + viz.hit * 0.15) * gk).toFixed(2));
    put(glow1El, "scale", (1 + viz.low * 0.08).toFixed(3));
    put(glow2El, "opacity", (0.25 + viz.high * 0.35).toFixed(2));
  } else if (S.tab === "wave") drawHero(t);
}
requestAnimationFrame(frame);

// ================================================================== lyrics

let lyricsOpen = false, lyricsKey = null, lyricsReq = 0, timed = [], activeLine = -1;

function setLyrics(open) {
  const t = cur();
  if (open && t && !t.hasLyrics) return toast(t.src === "sc" ? "SoundCloud не отдаёт тексты песен" : "Для этого трека текста нет");
  lyricsOpen = open;
  $("#lyrics").hidden = !open;
  $("#plStage").classList.toggle("lyr", open);
  if (open) loadLyrics();
  renderPlayer();
}

async function loadLyrics() {
  const t = cur(), box = $("#lyricsIn"), wrap = $("#lyrics");
  lyricsKey = t?.key; timed = []; activeLine = -1;
  wrap.classList.remove("plain");
  const none = msg => { box.innerHTML = `<div class="none">${msg}</div>`; };
  if (!t) return none("Включите что-нибудь");
  if (t.src === "sc") return none("SoundCloud не отдаёт тексты песен");
  if (!t.hasLyrics) return none("Для этого трека текста нет");
  none("Загружаю текст…");
  const req = ++lyricsReq;
  try {
    const r = await api(`/api/ya-lyrics?id=${encodeURIComponent(t.id)}&synced=${t.synced ? 1 : 0}`);
    if (req !== lyricsReq) return;
    if (!r?.text) return none("Для этого трека текста нет");
    const html = [];
    for (const raw of r.text.replace(/\r/g, "").split("\n")) {
      if (r.synced) {
        const m = raw.match(/^\s*\[(\d+):(\d+(?:[.,]\d+)?)\]\s?(.*)$/);
        if (!m) continue;
        const ms = +m[1] * 60000 + parseFloat(m[2].replace(",", ".")) * 1000;
        timed.push(ms);
        html.push(`<div class="ln" data-ms="${ms}">${esc(m[3].trim() || "•")}</div>`);
      } else html.push(`<div class="ln">${esc(raw || " ")}</div>`);
    }
    wrap.classList.toggle("plain", !r.synced);
    box.innerHTML = html.join("");
    wrap.scrollTop = 0;
    followLyrics(audio.currentTime * 1000, true);
  } catch { if (req === lyricsReq) none("Не удалось загрузить текст"); }
}

$("#lyricsIn").addEventListener("click", e => {
  const ln = e.target.closest(".ln[data-ms]");
  if (ln && audio.duration) audio.currentTime = +ln.dataset.ms / 1000;
});

function followLyrics(pos, force = false) {
  if (!lyricsOpen || !timed.length) return;
  let idx = -1;
  for (let i = 0; i < timed.length; i++) if (timed[i] <= pos + 250) idx = i; else break;
  if (idx === activeLine && !force) return;
  activeLine = idx;
  const lines = $("#lyricsIn").children;
  for (let i = 0; i < lines.length; i++) { lines[i].classList.toggle("cur", i === idx); lines[i].classList.toggle("past", i < idx); }
  const el = lines[Math.max(0, idx)], wrap = $("#lyrics");
  if (el) wrap.scrollTo({ top: el.offsetTop + el.offsetHeight / 2 - wrap.clientHeight / 2, behavior: force ? "auto" : "smooth" });
}

// ================================================================== accounts

async function submitCode(input) {
  const v = input?.value || "";
  try {
    await redeemCode(v);
    toast("Аккаунты подключены");
    if (openSheetEl) closeSheet();
    connect();
  } catch (e) { toast("Код не подошёл: " + e.message); }
}

function openAccounts() {
  const row = (src, name, title) => {
    const a = acc[src];
    return `<div class="acc"><div class="row1"><div><div class="t">${title}</div><div class="s">${a ? esc(a.name) : tokens[src] ? "проверяю вход…" : "не подключён"}</div></div>
      ${a || tokens[src] ? `<button class="btn sec" data-act="logout" data-v="${src}">Выйти</button>` : ""}</div>
      <details><summary>Ввести токен вручную</summary><input class="field" data-token="${src}" placeholder="${name}" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="btn" data-act="save" data-v="${src}">Сохранить</button></details></div>`;
  };
  const code = handoffCode ? `<div class="acc"><div class="t">Код для HUM на экране «Домой»</div>
      <div class="bigcode">${handoffCode.slice(0, 5)} ${handoffCode.slice(5)}</div>
      <div class="s">Эта страница открыта в Safari, а у приложения на экране «Домой» своё хранилище. Откройте HUM с экрана «Домой» и введите этот код в «Аккаунтах». Код действует 30 минут, один раз.</div></div>` : "";
  $("#accountsBody").innerHTML = code + row("ya", "OAuth-токен Яндекса", "Яндекс") + row("sc", "oauth_token SoundCloud", "SoundCloud") +
    `<div class="acc"><div class="t">Войти по коду</div><div class="s">Код из 10 символов появляется после сканирования QR в Safari.</div>
      <div class="codebox"><input class="field" id="accCode" placeholder="КОД" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false"><button class="btn" data-act="code">Войти</button></div></div>
     <p class="note">Проще всего перенести аккаунты с компьютера: в HUM на ПК откройте «Аккаунты» → «Подключить iPhone» и наведите камеру на QR-код.</p>
     <p class="note">Чтобы HUM открывался как приложение: Safari → «Поделиться» → «На экран „Домой“».</p>
     <p class="note">Токены хранятся только на этом телефоне и уходят лишь в ваш собственный сервер HUM, который передаёт запросы сервисам.</p>
     <div class="acc toggle"><div><div class="t">Живой визуализатор</div><div class="s">Кольца и полосы двигаются по настоящему звуку трека Яндекса. Для этого трек скачивается ещё раз — вдвое больше трафика.</div></div><button class="switch ${S.viz !== false ? "on" : ""}" data-act="viz" aria-label="Живой визуализатор"></button></div>
     <p class="note" style="opacity:.6">HUM web · версия ${VERSION}${isStandalone() ? " · приложение" : " · Safari"} · экран ${vp.H}/${vp.ih}, отступы ${Math.round(vp.st)}/${Math.round(vp.sb)}${vp.gap ? ", поправка " + vp.gap : ""}</p>`;
  openSheet($("#accounts"));
}
$("#accountsBtn").addEventListener("click", openAccounts);
$("#accountsBody").addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const src = b.dataset.v;
  if (b.dataset.act === "logout") { delete tokens[src]; acc[src] = null; saveTokens(); store.set("acc", { ya: acc.ya, sc: acc.sc }); lib.liked = lib.liked.filter(t => t.src !== src); lib.keys = new Set(lib.liked.map(t => t.key)); openAccounts(); renderAll(); }
  if (b.dataset.act === "code") submitCode($("#accCode"));
  if (b.dataset.act === "viz") { S.viz = S.viz === false; saveS(); b.classList.toggle("on", S.viz); if (S.viz) analyze(cur()); else { ana.key = null; ana.low = null; } }
  if (b.dataset.act === "save") {
    let v = $(`[data-token="${src}"]`).value.trim();
    const m = v.match(/access_token=([^&#\s]+)/); if (m) v = decodeURIComponent(m[1]);
    if (!v) return;
    tokens[src] = v; saveTokens();
    closeSheet();
    connect();
  }
});

// ================================================================== «Оформление» sheet

function lookOpts(key, items) {
  return `<div class="opts">${items.map(([v, label, pv]) => `<button class="opt ${S.look[key] === v ? "on" : ""}" data-look="${key}" data-v="${v}"><span class="pv" ${pv?.style ? `style="${pv.style}"` : ""}>${pv?.html ?? ""}</span>${label}</button>`).join("")}</div>`;
}

function renderLook() {
  const L = S.look;
  const sw = ACCENTS.map(([v, name, hex]) => `<button class="sw ${L.accent === v ? "on" : ""}" data-look="accent" data-v="${v}" aria-label="${name}" style="background:${hex || "conic-gradient(#ff6a55,#ffb43d,#c8f53c,#45e0b0,#58b2ff,#b38cff,#ff5ca8,#ff6a55)"}"></button>`).join("");
  const bgs = BGS.map(([v, name, hex]) => [v, name, { style: `background:${hex || "linear-gradient(135deg,#3a1d14,#0d1322 55%,#0e1812)"};box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)` }]);
  $("#lookBody").innerHTML = `
    <div class="ap-sec"><div class="cap">Акцент</div><div class="swatches">${sw}</div></div>
    <div class="ap-sec"><div class="cap">Фон</div>${lookOpts("bg", bgs)}</div>
    <div class="ap-sec"><div class="cap">Контраст</div>${lookOpts("contrast", [["normal", "Обычный", { html: "Аа", style: "color:#8a8a8a" }], ["high", "Высокий", { html: "Аа", style: "color:#fff;box-shadow:inset 0 0 0 1px #777" }]])}</div>
    <div class="ap-sec"><div class="cap">Шрифт</div>${lookOpts("font", [["system", "Обычный", { html: "Аа", style: "font-family:-apple-system,system-ui" }], ["rounded", "Округлый", { html: "Аа", style: "font-family:ui-rounded,'SF Pro Rounded',system-ui" }], ["serif", "С засечками", { html: "Аа", style: "font-family:ui-serif,'New York',Georgia,serif" }], ["mono", "Моно", { html: "Аа", style: "font-family:ui-monospace,'SF Mono',Menlo,monospace" }]])}</div>
    <div class="ap-sec"><div class="cap">Форма кнопок</div>${lookOpts("shape", [["soft", "Мягкая", { html: '<span style="width:44px;height:20px;border-radius:7px;background:var(--mode)"></span>' }], ["pill", "Капсулы", { html: '<span style="width:44px;height:20px;border-radius:10px;background:var(--mode)"></span>' }], ["sharp", "Острая", { html: '<span style="width:44px;height:20px;border-radius:2px;background:var(--mode)"></span>' }]])}</div>
    <div class="ap-sec"><div class="cap">Плеер</div>
      ${lookOpts("cover", [["round", "Пластинка", { html: '<span style="width:26px;height:26px;border-radius:50%;background:var(--mode)"></span>' }], ["square", "Квадрат", { html: '<span style="width:26px;height:26px;border-radius:6px;background:var(--mode)"></span>' }]])}
      <div style="height:8px"></div>
      ${lookOpts("plbg", [["glass", "Стекло", { style: "background:linear-gradient(135deg,#3a2a24,#141414)" }], ["vivid", "Ярко", { style: "background:linear-gradient(135deg,#b4553a,#3a1d60)" }], ["black", "Чёрный", { style: "background:#050505;box-shadow:inset 0 0 0 1px #2a2a2a" }]])}
      <div class="ap-row"><div><div class="t">Вращать обложку</div><div class="s">Крутится как пластинка, пока играет (только круглая)</div></div><button class="switch ${L.spin ? "on" : ""}" data-look="spin" aria-label="Вращать обложку"></button></div>
    </div>
    <div class="ap-sec"><div class="cap">Визуализатор</div>
      ${lookOpts("vizStyle", [["bars", "Полосы", { html: '<svg viewBox="0 0 24 24"><path d="M5 15v-4M9 17V7M13 19V5M17 16V8M21 14v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' }], ["waves", "Волны", { html: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".6"/></svg>' }], ["minimal", "Минимум", { html: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>' }], ["off", "Выкл", { html: "—" }]])}
      <div style="height:8px"></div>
      ${lookOpts("vizAmt", [["0.6", "Спокойно", { html: "∿" }], ["1", "Обычно", { html: "〰" }], ["1.5", "Мощно", { html: "≋" }]])}
    </div>
    <div class="ap-sec"><div class="ap-row"><div><div class="t">Меньше движения</div><div class="s">Без дрожи, частиц и плавающего света</div></div><button class="switch ${L.motion === "reduced" ? "on" : ""}" data-look="motion" aria-label="Меньше движения"></button></div></div>
    <button class="btn sec ap-reset" data-look="reset">Вернуть как было</button>`;
  // the intensity buttons store numbers: mark the active one by value
  $("#lookBody").querySelectorAll('[data-look="vizAmt"]').forEach(b => b.classList.toggle("on", +b.dataset.v === +L.vizAmt));
}

$("#lookBody").addEventListener("click", e => {
  const b = e.target.closest("[data-look]");
  if (!b) return;
  const k = b.dataset.look, v = b.dataset.v;
  if (k === "reset") S.look = { ...LOOK_DEFAULT };
  else if (k === "spin") S.look.spin = !S.look.spin;
  else if (k === "motion") S.look.motion = S.look.motion === "reduced" ? "full" : "reduced";
  else if (k === "vizAmt") S.look.vizAmt = +v;
  else S.look[k] = v;
  saveS(); applyLook(); renderLook(); placeBlob();
});
$("#lookBtn").addEventListener("click", () => { renderLook(); openSheet($("#look")); });

// ================================================================== artist page (Yandex)

const AR = { id: null, name: "", req: 0 };
const nf = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(".0", "") + " млн" : n >= 1e3 ? Math.round(n / 1e3) + " тыс" : String(n);

async function openArtist(id, name) {
  const page = $("#artist");
  page.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => page.classList.add("open")));
  AR.id = id; AR.name = name;
  const req = ++AR.req;
  $("#arName").textContent = name;
  $("#arSub").textContent = "";
  const bg = $("#arBg"); bg.style.backgroundImage = ""; bg.style.transform = "";
  $("#arPopular").innerHTML = `<div class="empty">Загружаю…</div>`;
  $("#arAll").innerHTML = ""; $("#arAllH").hidden = true;
  $("#arScroll").scrollTop = 0;
  lists.arpop = []; lists.arall = [];
  try {
    const r = await ya(`artists/${id}/brief-info`);
    if (req !== AR.req) return;
    const a = r?.artist || {};
    const img = a.cover?.uri || a.ogImage;
    if (img) { bg.style.animation = "none"; bg.style.backgroundImage = `url('https://${img.replace("%%", "1000x1000")}')`; void bg.offsetWidth; bg.style.animation = ""; }
    const bits = [];
    if (a.genres?.length) bits.push(a.genres.slice(0, 2).map(g => YA_GENRES[g] || g).join(", "));
    if (r.stats?.lastMonthListeners) bits.push(nf(r.stats.lastMonthListeners) + " слушателей за месяц");
    else if (a.counts?.tracks) bits.push(a.counts.tracks + " " + plural(a.counts.tracks));
    $("#arSub").textContent = bits.join(" · ");
    lists.arpop = (r.popularTracks || []).map(yaTrack).filter(Boolean);
    $("#arPopular").innerHTML = lists.arpop.length ? lists.arpop.map((t, i) => rowHtml(t, "arpop", i)).join("") : `<div class="empty">Треков нет</div>`;
    const all = await ya(`artists/${id}/tracks?page=0&page-size=100`);
    if (req !== AR.req) return;
    const seen = new Set(lists.arpop.map(t => t.key));
    lists.arall = (all?.tracks || []).map(yaTrack).filter(t => t && !seen.has(t.key));
    $("#arAllH").hidden = !lists.arall.length;
    $("#arAll").innerHTML = lists.arall.map(t => rowHtml(t, "arall")).join("");
  } catch (e) { if (req === AR.req) $("#arPopular").innerHTML = `<div class="empty">Не загрузилось: ${esc(e.message)}</div>`; }
}
function closeArtist() {
  const page = $("#artist");
  page.classList.remove("open");
  setTimeout(() => { if (!page.classList.contains("open")) page.hidden = true; }, 520);
}
$("#plArtist").addEventListener("click", e => { const b = e.target.closest("[data-artist]"); if (b) openArtist(b.dataset.artist, b.textContent); });
$("#arBack").addEventListener("click", closeArtist);
$("#arPopular").addEventListener("click", onRowsClick);
$("#arAll").addEventListener("click", onRowsClick);
$("#arPlay").addEventListener("click", () => { unlock(); const l = [...lists.arpop, ...lists.arall]; if (l.length) playList(l, 0, "artist", AR.name); });
$("#arWave").addEventListener("click", () => { unlock(); startYaWave(["artist:" + AR.id], "mix", "artist:" + AR.id, "Эфир · " + AR.name); });
// the photo stretches when pulled down and drifts up slower than the list
$("#arScroll").addEventListener("scroll", e => {
  const y = e.target.scrollTop;
  $("#arBg").style.transform = y < 0 ? `scale(${(1 - y / 400).toFixed(3)})` : `translateY(${(y * 0.4).toFixed(1)}px)`;
}, { passive: true });
// swipe right to go back, like a native page
(() => {
  let x0 = null, y0 = 0;
  const page = $("#artist");
  page.addEventListener("touchstart", e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  page.addEventListener("touchend", e => { if (x0 != null && e.changedTouches[0].clientX - x0 > 90 && Math.abs(e.changedTouches[0].clientY - y0) < 60) closeArtist(); x0 = null; }, { passive: true });
})();

// ================================================================== native feel
// no pinch / double-tap zoom, no text selection or long-press menus outside input fields
document.addEventListener("gesturestart", e => e.preventDefault(), { passive: false });
document.addEventListener("dblclick", e => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener("contextmenu", e => { if (!e.target.closest("input, textarea")) e.preventDefault(); });

// ================================================================== start

applyLook();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").then(r => r.update()).catch(() => {});
renderAll();
showTab(S.tab || "wave");
requestAnimationFrame(placeBlob);
requestAnimationFrame(() => { const sp = $("#splash"); if (sp) { sp.classList.add("gone"); setTimeout(() => sp.remove(), 600); } });
takePairCode().then(connect);
// home-screen apps resume from memory: pick up a new pairing link or a check that failed offline
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (cur()?._direct) analyze(cur());
  if (location.hash.startsWith("#p=")) takePairCode().then(connect);
  else if ((tokens.ya && !acc.ya) || (tokens.sc && !acc.sc)) connect();
});
addEventListener("hashchange", () => { if (location.hash.startsWith("#p=")) takePairCode().then(connect); });
