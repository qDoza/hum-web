// HUM web — the iPhone version of the desktop tray player.
// Talks only to its own Worker (/api/*); tokens stay in this phone's storage.

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = ms => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
const plural = n => n % 10 === 1 && n % 100 !== 11 ? "трек" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "трека" : "треков";
const VERSION = "5";

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

async function go(i) {
  if (!isWave() && P.queue.length) i = ((i % P.queue.length) + P.queue.length) % P.queue.length;
  if (i >= P.queue.length) { if (isWave()) await fetchMore(true); return; }
  if (i < 0) return;
  P.i = i;
  const t = P.queue[i];
  const g = ++P.gen;
  audio.pause();
  setBusy(true);
  markCurrent();
  updateMediaSession();
  if (isWave() && i >= P.queue.length - 2) fetchMore(false);
  try {
    const url = await streamUrl(t);
    if (g !== P.gen) return;
    t._direct = url;
    audio.src = url;
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
audio.addEventListener("ended", () => { const t = cur(); if (t && isWave()) fb("trackFinished", t, (t.dur || 0) / 1000); next(false); });
audio.addEventListener("error", () => {
  const t = cur();
  if (!t || !audio.src || audio.src.startsWith("blob:")) return;
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
if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => audio.play());
  ms.setActionHandler("pause", () => audio.pause());
  ms.setActionHandler("nexttrack", () => next());
  ms.setActionHandler("previoustrack", () => prev());
  try { ms.setActionHandler("seekto", d => { audio.currentTime = d.seekTime; }); } catch {}
}

// ================================================================== UI: shell

let toastTimer;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

function showTab(tab) {
  const changed = S.tab !== tab;
  S.tab = tab; saveS();
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("on", b.dataset.tab === tab);
  for (const p of ["wave", "likes", "search"]) {
    const el = $("#page-" + p);
    el.hidden = p !== tab;
    if (p === tab && changed) { el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter"); }
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
  play.innerHTML = `<svg><use href="#i-${mine && playing() ? "pause" : "play"}"/></svg>`;
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
  box.innerHTML = lib.loading && !lib.liked.length ? `<div class="empty">Загружаю лайки…</div>`
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
    case "mywave": unlock(); if (P.ctx === "mywave" && P.ctxSrc === S.source && cur()) toggle(); else if (isWave() && P.ctxSrc === S.source && cur() && b.id === "heroPlay") toggle(); else playMyWave(S.source); break;
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

const lists = { likes: [], search: [], recent: [] };

function rowHtml(t, list, i = -1) {
  const liked = isLiked(t), c = cur();
  return `<div class="row ${c && c.key === t.key ? "cur" : ""}${i >= 0 && i < 14 ? " in" : ""}" ${i >= 0 && i < 14 ? `style="animation-delay:${i * 28}ms"` : ""} data-act="play" data-list="${list}" data-key="${esc(t.key)}">
    <div class="cover row-c" ${coverStyle(t.cover)}></div>
    <div class="meta"><div class="t">${esc(t.title)}</div><div class="s"><span class="tag">${t.src === "ya" ? "ЯМ" : "SC"}</span><span>${esc(t.artist)}</span></div></div>
    <div class="d">${fmt(t.dur)}</div>
    <button class="heart ${liked ? "on" : ""}" data-act="like" data-key="${esc(t.key)}" aria-label="Нравится"><svg><use href="#i-heart${liked ? "-fill" : ""}"/></svg></button></div>`;
}

function onRowsClick(e) {
  const b = e.target.closest("[data-act]");
  if (!b || (b.dataset.act !== "like" && b.dataset.act !== "play")) return;
  const all = [...lists.likes, ...lists.search, ...lists.recent, ...P.queue, ...lib.liked];
  const t = all.find(x => x.key === b.dataset.key);
  if (!t) return;
  if (b.dataset.act === "like") { e.stopPropagation(); toggleLike(t); return; }
  unlock();
  if (cur()?.key === t.key) return toggle();
  const name = b.dataset.list;
  const list = name === "recent" ? lib.liked : lists[name];
  playList(list, list.indexOf(t), name === "search" ? "search" : "likes", name === "search" ? "Поиск" : "Любимое");
}

function markCurrent() {
  const c = cur();
  document.querySelectorAll(".row").forEach(r => r.classList.toggle("cur", !!c && r.dataset.key === c.key));
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
    : lib.loading && !lib.liked.length ? `<div class="empty">Загружаю лайки…</div>`
    : !lists.likes.length ? `<div class="empty">${likesQuery ? "Ничего не нашлось" : "Пока пусто"}</div>`
    : lists.likes.map((t, i) => rowHtml(t, "likes", animate ? i : -1)).join("");
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
  const t = cur();
  $("#mini").hidden = !t;
  if (!t) return;
  const icon = playing() ? "pause" : "play";
  $("#miniCover").style.backgroundImage = t.cover ? `url('${t.cover}')` : "";
  $("#miniTitle").textContent = t.title;
  $("#miniSub").textContent = P.busy && !playing() ? "Загружаю…" : t.artist;
  $("#miniPlay").innerHTML = `<svg><use href="#i-${icon}"/></svg>`;

  if (shownKey !== t.key) {
    shownKey = t.key;
    // crossfade the cover, the glow behind the glass and the titles
    const front = coverFront === "A" ? $("#cvA") : $("#cvB"), back = coverFront === "A" ? $("#cvB") : $("#cvA");
    back.style.backgroundImage = t.big ? `url('${t.big}')` : "";
    back.classList.remove("hide"); front.classList.add("hide");
    coverFront = coverFront === "A" ? "B" : "A";
    for (const g of [$("#glow1"), $("#glow2")]) g.style.backgroundImage = t.cover ? `url('${t.cover}')` : "";
    const ti = $("#plTitles"); ti.classList.remove("swap"); void ti.offsetWidth; ti.classList.add("swap");
    $("#plTitle").textContent = t.title;
    $("#plArtist").textContent = t.album ? `${t.artist} · ${t.album}` : t.artist;
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
  $("#plPlay").innerHTML = `<svg><use href="#i-${icon}"/></svg>`;
  $("#plCover").classList.toggle("paused", !playing() && !P.busy);
  const liked = isLiked(t);
  $("#plLike").innerHTML = `<svg><use href="#i-heart${liked ? "-fill" : ""}"/></svg>`;
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

let playerOpen = false;
function openPlayer() {
  playerOpen = true;
  pl.hidden = false;
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
    if (mode === "side") $("#plCover").style.translate = `${dx * 0.35}px 0`;
  }, { passive: true });
  pl.addEventListener("touchend", e => {
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0, v = dy / Math.max(1, Date.now() - t0);
    if (mode === "down") {
      if (dy > 120 || v > 0.6) closePlayer();
      else { pl.classList.remove("drag"); pl.style.transform = ""; }
    } else if (mode === "side") {
      $("#plCover").style.translate = "";
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

const viz = { color: [200, 200, 200], target: [200, 200, 200], level: 0, energy: 0, bpm: 110, kick: 0 };
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
      if (cur()?.key === t.key) document.documentElement.style.setProperty("--accent", viz.target.map(Math.round).join(", "));
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

// No real beat detection: tapping the audio with Web Audio on iPhone breaks background playback.
// The rings follow a steady pulse per track that starts, stops and seeks with the music.
function pulseAt(sec) {
  const bp = 60 / viz.bpm, ph = (sec % bp) / bp, beat = Math.floor(sec / bp) % 4;
  const kick = Math.exp(-ph * 7) * (beat === 0 ? 1 : beat === 2 ? 0.8 : 0.55);
  const hat = Math.exp(-(((ph + 0.5) % 1)) * 10) * 0.28;
  return kick + hat;
}

function fitCanvas(c) {
  const r = c.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return d;
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

function drawHero(t) {
  const c = $("#heroRings");
  if (!c || !c.offsetParent) return;
  const d = fitCanvas(c), x = c.getContext("2d"), w = c.width, h = c.height, cx = w / 2, cy = h / 2;
  x.clearRect(0, 0, w, h);
  const mine = isWave() && P.ctxSrc === S.source && cur();
  const e = mine ? viz.energy : 0;
  const base = Math.min(w, h) * 0.36;
  for (let k = 0; k < 5; k++) {
    x.strokeStyle = `rgba(242,242,242,${(0.6 - k * 0.11).toFixed(3)})`;
    x.lineWidth = d * (k ? 1 : 1.7);
    ring(x, cx, cy, base * (1 + k * 0.07) + e * k * 4 * d, t, k, d * (3 + e * 12) * (1 + k * 0.3));
  }
}

function drawPlayer(t) {
  const c = $("#plRings");
  const d = fitCanvas(c), x = c.getContext("2d"), w = c.width, h = c.height, cx = w / 2, cy = h / 2;
  x.clearRect(0, 0, w, h);
  if (lyricsOpen) return;
  const [r, g, b] = viz.color.map(Math.round);
  const e = viz.energy;
  const cr = $("#plCover").offsetWidth / 2 * d * (1 + e * 0.03);
  // spectrum ticks hugging the cover
  const N = 96;
  x.lineCap = "round";
  x.lineWidth = 2 * d;
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2 - Math.PI / 2;
    const v = 0.5 + 0.5 * Math.sin(i * 0.9 + t * 2.6) * Math.sin(i * 0.37 - t * 1.7);
    const len = (2 + viz.level * 3 + e * 20 * v + viz.kick * 10 * v) * d;
    const r0 = cr + 9 * d;
    x.strokeStyle = `rgba(${r},${g},${b},${(0.35 + v * 0.45).toFixed(3)})`;
    x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); x.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len)); x.stroke();
  }
  // flowing rings
  for (let k = 0; k < 4; k++) {
    const mixW = k / 4;
    x.strokeStyle = `rgba(${Math.round(r + (255 - r) * mixW)},${Math.round(g + (255 - g) * mixW)},${Math.round(b + (255 - b) * mixW)},${(0.62 - k * 0.13).toFixed(3)})`;
    x.lineWidth = d * (k ? 1.1 : 1.8);
    ring(x, cx, cy, cr + (40 + k * 13) * d + e * k * 5 * d, t, k, d * (3 + viz.level * 3 + e * 12) * (1 + k * 0.45));
  }
}

function frame(ms) {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const t = ms / 1000;
  viz.level += ((playing() ? 1 : 0) - viz.level) * 0.04;
  for (let i = 0; i < 3; i++) viz.color[i] += (viz.target[i] - viz.color[i]) * 0.05;
  const p = viz.level * pulseAt(audio.currentTime || 0);
  viz.energy += (p - viz.energy) * (p > viz.energy ? 0.6 : 0.18);
  viz.kick *= 0.92;
  if (playerOpen) {
    drawPlayer(t);
    $("#plCover").style.scale = (1 + viz.energy * 0.025 + viz.kick * 0.04).toFixed(4);
    $("#glow1").style.opacity = (0.42 + viz.energy * 0.28).toFixed(3);
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
     <p class="note" style="opacity:.6">HUM web · версия ${VERSION}${isStandalone() ? " · приложение" : " · Safari"}</p>`;
  openSheet($("#accounts"));
}
$("#accountsBtn").addEventListener("click", openAccounts);
$("#accountsBody").addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const src = b.dataset.v;
  if (b.dataset.act === "logout") { delete tokens[src]; acc[src] = null; saveTokens(); store.set("acc", { ya: acc.ya, sc: acc.sc }); lib.liked = lib.liked.filter(t => t.src !== src); lib.keys = new Set(lib.liked.map(t => t.key)); openAccounts(); renderAll(); }
  if (b.dataset.act === "code") submitCode($("#accCode"));
  if (b.dataset.act === "save") {
    let v = $(`[data-token="${src}"]`).value.trim();
    const m = v.match(/access_token=([^&#\s]+)/); if (m) v = decodeURIComponent(m[1]);
    if (!v) return;
    tokens[src] = v; saveTokens();
    closeSheet();
    connect();
  }
});

// ================================================================== start

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").then(r => r.update()).catch(() => {});
renderAll();
showTab(S.tab || "wave");
requestAnimationFrame(placeBlob);
takePairCode().then(connect);
// home-screen apps resume from memory: pick up a new pairing link or a check that failed offline
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (location.hash.startsWith("#p=")) takePairCode().then(connect);
  else if ((tokens.ya && !acc.ya) || (tokens.sc && !acc.sc)) connect();
});
addEventListener("hashchange", () => { if (location.hash.startsWith("#p=")) takePairCode().then(connect); });
