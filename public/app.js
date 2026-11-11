// HUM web — the iPhone version of the desktop tray player.
// Talks only to its own Worker (/api/*); tokens stay in this phone's storage.

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = ms => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
const plural = n => n % 10 === 1 && n % 100 !== 11 ? "трек" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "трека" : "треков";

// ================================================================== storage

const store = {
  get(k, d) { try { const v = localStorage.getItem("hum." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("hum." + k, JSON.stringify(v)); } catch {} },
};
const S = Object.assign({
  source: "ya", tab: "wave", diversity: "default", padX: 0.7, padY: 0.75,
  scBase: "likes", scGenre: null, scNoSets: true, scOnlyNew: false, scFresh: false,
}, store.get("settings", {}));
const saveS = () => store.set("settings", S);
let tokens = store.get("tokens", {});

const VERSION = "4";

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));

// Short one-time QR from desktop HUM: https://…/#p=<id>.<key>. The Worker holds only the AES-GCM
// ciphertext under <id> (gone after one read); the key never leaves this #fragment.
let pairing = null;
function takePairCode() { return pairing ??= takePairCodeOnce().finally(() => { pairing = null; }); }

async function takePairCodeOnce() {
  const m = location.hash.match(/^#p=([a-z0-9]{6})\.([A-Za-z0-9_-]{43})$/);
  if (!m) return;
  history.replaceState(null, "", "/");
  try {
    // a fresh code may take a few seconds to reach the nearest Cloudflare location: retry for ~10 s
    let r, j;
    for (let attempt = 0; attempt < 6; attempt++) {
      r = await fetch("/api/pair/" + m[1], { cache: "no-store" });
      j = await r.json();
      if (r.ok || r.status !== 404) break;
      await new Promise(res => setTimeout(res, 1800));
    }
    if (!r.ok) throw new Error(j.error || "код недействителен");
    const raw = b64url(j.blob);
    const key = await crypto.subtle.importKey("raw", b64url(m[2]), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
    const o = JSON.parse(new TextDecoder().decode(plain));
    tokens = { ...tokens, ...(o.ya ? { ya: o.ya } : {}), ...(o.sc ? { sc: o.sc } : {}) };
    store.set("tokens", tokens);
    setTimeout(() => toast("Аккаунты перенесены с компьютера"), 400);
  } catch (e) { setTimeout(() => toast("Не удалось перенести: " + e.message), 400); }
}

// the older, long form: https://…/#pair=<base64url JSON> (still accepted)
if (location.hash.startsWith("#pair=")) {
  try {
    const b64 = location.hash.slice(6).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
    tokens = { ...tokens, ...(o.ya ? { ya: o.ya } : {}), ...(o.sc ? { sc: o.sc } : {}) };
    store.set("tokens", tokens);
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
  if (!r.ok) throw new Error(j?.error?.message || j?.error?.name || (typeof j?.error === "string" ? j.error : "") || `HTTP ${r.status}`);
  return j;
}
const ya = (p, o) => api("/api/ya/" + p, o).then(j => j?.result);
const yaPost = (p, form) => ya(p, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
const yaJson = (p, obj) => ya(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
const sc = (p, o) => api("/api/sc/" + p.replace(/^https:\/\/api-v2\.soundcloud\.com\//, ""), o);

// ================================================================== tracks

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
    synced: !!li.hasAvailableSyncLyrics, hasLyrics: !!(li.hasAvailableSyncLyrics || li.hasAvailableTextLyrics),
  };
}

function scTrack(n) {
  if (!n || (n.kind && n.kind !== "track") || n.policy === "BLOCK" || n.id == null) return null;
  const trans = (n.media?.transcodings || []).map(x => ({ url: x.url, protocol: x.format?.protocol || "", mime: x.format?.mime_type || "" }))
    .filter(x => x.url && !x.url.includes("/preview"));
  const art = n.artwork_url || n.user?.avatar_url;
  return {
    src: "sc", id: String(n.id), key: "sc:" + n.id,
    title: n.title || "Без названия",
    artist: n.publisher_metadata?.artist || n.user?.username || "—",
    dur: n.full_duration || n.duration || 0,
    cover: art ? art.replace("-large.", "-t300x300.") : null,
    big: art ? art.replace("-large.", "-t500x500.") : null,
    trans, auth: n.track_authorization,
    released: Date.parse(n.release_date || n.created_at || "") || 0,
    hasLyrics: false,
  };
}

// ================================================================== library

const acc = { ya: null, sc: null };
const lib = { liked: [], keys: new Set(), loading: false, activities: [] };
const has = s => !!acc[s];

async function connect() {
  const jobs = [];
  if (tokens.ya) jobs.push(ya("account/status").then(r => { acc.ya = { uid: r.account.uid, name: r.account.displayName || r.account.login }; })
    .catch(e => { acc.ya = null; toast("Яндекс: " + e.message); }));
  if (tokens.sc) jobs.push(sc("me").then(me => { acc.sc = { id: me.id, name: me.username }; })
    .catch(e => { acc.sc = null; toast("SoundCloud: " + e.message); }));
  await Promise.all(jobs);
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
  })().catch(e => toast("Яндекс: лайки не загрузились")));
  if (acc.sc) jobs.push((async () => {
    let next = `users/${acc.sc.id}/track_likes?limit=200&linked_partitioning=1`;
    for (let page = 0; page < 15 && next; page++) {
      const r = await sc(next);
      for (const it of r.collection || []) { const t = scTrack(it.track); if (t) { t.likedAt = Date.parse(it.created_at) || 0; all.push(t); } }
      next = r.next_href || null;
    }
  })().catch(e => toast("SoundCloud: лайки не загрузились")));
  await Promise.all(jobs);
  all.sort((a, b) => b.likedAt - a.likedAt);
  lib.liked = []; lib.keys.clear();
  for (const t of all) if (!lib.keys.has(t.key)) { lib.keys.add(t.key); lib.liked.push(t); }
  lib.loading = false;
  renderLikesList();
  renderWave();
}

async function loadActivities() {
  if (!acc.ya) return;
  try {
    const r = await ya("rotor/wave/settings?seeds=" + encodeURIComponent("user:onyourwave"));
    lib.activities = [];
    for (const b of r?.blocks || []) for (const st of b.items || [])
      if (st.id?.type && st.id?.tag && st.name) lib.activities.push({ name: st.name, seed: `${st.id.type}:${st.id.tag}` });
    renderWave();
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

function applyLike(t, liked) {
  if (liked && !lib.keys.has(t.key)) { lib.keys.add(t.key); t.likedAt = Date.now(); lib.liked.unshift(t); }
  if (!liked && lib.keys.has(t.key)) { lib.keys.delete(t.key); lib.liked = lib.liked.filter(x => x.key !== t.key); }
  document.querySelectorAll(`.heart[data-key="${CSS.escape(t.key)}"]`).forEach(b => { b.classList.toggle("on", liked); b.innerHTML = `<svg><use href="#i-heart${liked ? "-fill" : ""}"/></svg>`; });
  renderLikesList();
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
  { id: "active", title: "Бодрый", group: "Настроение", seeds: ["settingMoodEnergy:active"] },
  { id: "fun", title: "Весёлый", group: "Настроение", seeds: ["settingMoodEnergy:fun"] },
  { id: "calm", title: "Спокойный", group: "Настроение", seeds: ["settingMoodEnergy:calm"] },
  { id: "sad", title: "Грустный", group: "Настроение", seeds: ["settingMoodEnergy:sad"] },
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
const SC_BASES = [["likes", "Все лайки"], ["recent", "Свежие лайки"], ["old", "Давние лайки"], ["current", "От текущего трека"]];
const SC_GENRES = [[null, "Любой"], ["lofi", "Lo-fi"], ["phonk", "Phonk"], ["hip hop", "Hip-hop"], ["trap", "Trap"], ["electronic", "Electronic"],
  ["house", "House"], ["techno", "Techno"], ["drum and bass", "Drum & Bass"], ["ambient", "Ambient"], ["indie", "Indie"], ["rock", "Rock"],
  ["pop", "Pop"], ["r&b", "R&B"], ["jazz", "Jazz"], ["hyperpop", "Hyperpop"], ["русский рэп", "Русский рэп"]];

const P = { queue: [], i: -1, ctx: null, mix: null, ctxSrc: "ya", title: "", session: null, batch: null, seeds: [], waveSrc: "ya",
  gen: 0, busy: false, fetching: false, startedGen: -1, errors: 0, scOffset: 0 };
const cur = () => P.queue[P.i] || null;
const isWave = () => P.ctx === "mywave" || P.ctx === "mix";
const playing = () => !audio.paused && !audio.ended;

function setBusy(v) { P.busy = v; renderPlayer(); renderWave(); }
function setCtx(ctx, mix, src, title) { P.ctx = ctx; P.mix = mix; P.ctxSrc = src; P.title = title; renderWave(); }

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
        if (S.scGenre && a % 2 === 1) { const r = await sc(`search/tracks?q=${encodeURIComponent(S.scGenre)}&limit=40&offset=${P.scOffset}`); P.scOffset += 40; more.push(...(r.collection || []).map(scTrack).filter(Boolean)); }
        else {
          const c = cur();
          const seed = a === 0 && c?.src === "sc" ? c : S.scGenre ? P.queue[Math.floor(Math.random() * P.queue.length)] : pickScSeed();
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
  setBusy(true);
  try {
    const r = await yaJson("rotor/session/new", { seeds, includeTracksInResponse: true });
    if (g !== P.gen) return;
    P.waveSrc = "ya"; P.seeds = seeds; P.session = r.radioSessionId; P.batch = r.batchId;
    fb("radioStarted");
    setCtx(ctx, mix, "ya", title);
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

audio.addEventListener("playing", () => {
  if (!cur()) return;
  P.errors = 0;
  setBusy(false);
  if (P.startedGen !== P.gen && isWave()) { P.startedGen = P.gen; fb("trackStarted", cur()); }
});
audio.addEventListener("pause", renderPlayer);
audio.addEventListener("play", renderPlayer);
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
  S.tab = tab; saveS();
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("on", b.dataset.tab === tab);
  for (const p of ["wave", "likes", "search"]) $("#page-" + p).hidden = p !== tab;
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

function renderAll() { renderWave(); buildLikes(); buildSearch(); renderPlayer(); }

// ================================================================== UI: «Эфир»

function renderWave() {
  const el = $("#page-wave");
  const src = S.source;
  const connected = has(src);
  const onMine = P.ctx === "mywave" && P.ctxSrc === src;
  let h = `<div class="seg"><button data-act="src" data-v="ya" class="${src === "ya" ? "on" : ""}">Яндекс</button><button data-act="src" data-v="sc" class="${src === "sc" ? "on" : ""}">SoundCloud</button></div>`;

  if (!connected) {
    h += `<div class="card"><div class="t">${src === "ya" ? "Яндекс не подключён" : "SoundCloud не подключён"}</div>
      <div class="muted" style="margin-top:4px">Перенесите аккаунт с компьютера: в HUM на ПК нажмите «Подключить iPhone» и отсканируйте QR-код камерой.</div>
      <button class="btn" data-act="accounts">Аккаунты</button></div>`;
    el.innerHTML = h;
    return;
  }

  const sub = onMine && P.busy ? "Подбираю…" : "Просто то, что вам нравится. Без настроек";
  h += `<button class="mywave ${onMine ? "on" : ""}" data-act="mywave"><svg class="logo"><use href="#hum"/></svg>
    <span><div class="t">Мой эфир</div><div class="s">${sub}</div></span>
    <svg class="go"><use href="#i-${onMine && playing() ? "pause" : "play"}"/></svg></button>`;

  if (src === "ya") {
    const onMix = P.ctx === "mix";
    const chip = (id, title) => `<button class="chip ${onMix && P.mix === id ? "on" : ""}" data-act="mix" data-v="${esc(id)}">${esc(title)}</button>`;
    h += `<div class="h">Миксы <small>Тяните точку</small></div><div class="cap" style="margin-top:0">Настроение</div>
      <div class="chips">${MIXES.filter(m => m.group === "Настроение").map(m => chip(m.id, m.title)).join("")}</div>
      <div class="pad" id="pad">${padSvg(onMix && P.mix === "custom")}</div>
      <div class="seg" style="margin-top:6px">${[["favorite", "Знакомое"], ["default", "Любое"], ["discover", "Новое"]].map(([v, t]) =>
        `<button data-act="div" data-v="${v}" class="${S.diversity === v ? "on" : ""}">${t}</button>`).join("")}</div>`;
    for (const g of ["Характер и язык", "Подборки"])
      h += `<div class="cap">${g}</div><div class="chips">${MIXES.filter(m => m.group === g).map(m => chip(m.id, m.title)).join("")}</div>`;
    if (lib.activities.length)
      h += `<div class="cap">Занятия</div><div class="chips">${lib.activities.map((a, i) =>
        `<button class="chip ${onMix && P.mix === "act:" + a.seed ? "on" : ""}" data-act="activity" data-v="${i}">${esc(a.name)}</button>`).join("")}</div>`;
  } else {
    const scOn = P.ctx === "mywave" && P.ctxSrc === "sc";
    h += `<div class="h">Фильтры эфира <small>${scOn ? "применяются сразу" : "для «Мой эфир»"}</small></div>
      <div class="cap" style="margin-top:0">Основа</div><div class="chips">${SC_BASES.map(([v, t]) =>
        `<button class="chip ${S.scBase === v ? "on" : ""}" data-act="scbase" data-v="${v}">${t}</button>`).join("")}</div>
      <div class="cap">Жанр и вайб</div><div class="chips">${SC_GENRES.map(([v, t], i) =>
        `<button class="chip ${S.scGenre === v ? "on" : ""}" data-act="scgenre" data-v="${i}">${esc(t)}</button>`).join("")}</div>
      <div class="cap">Ещё</div><div class="chips">${[["scNoSets", "Без длинных сетов"], ["scOnlyNew", "Только незнакомое"], ["scFresh", "Свежее, за год"]].map(([k, t]) =>
        `<button class="chip check ${S[k] ? "on" : ""}" data-act="scflag" data-v="${k}">${t}</button>`).join("")}</div>`;
  }
  el.innerHTML = h;
  if (src === "ya") wirePad();
}

function scChanged() {
  saveS();
  if (P.ctx === "mywave" && P.ctxSrc === "sc") startScWave("mywave", "Мой эфир");
  renderWave();
}

$("#page-wave").addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const v = b.dataset.v;
  switch (b.dataset.act) {
    case "src": S.source = v; saveS(); renderWave(); buildSearch(); break;
    case "accounts": openAccounts(); break;
    case "mywave": unlock(); if (P.ctx === "mywave" && P.ctxSrc === S.source && cur()) toggle(); else playMyWave(S.source); break;
    case "mix": unlock(); playMix(v); break;
    case "activity": unlock(); playActivity(lib.activities[+v]); break;
    case "div": S.diversity = v; saveS(); if (P.ctx === "mix" && P.mix === "custom") playMix("custom"); renderWave(); break;
    case "scbase": S.scBase = v; scChanged(); break;
    case "scgenre": S.scGenre = SC_GENRES[+v][0]; scChanged(); break;
    case "scflag": S[v] = !S[v]; scChanged(); break;
  }
});

// ---------- mood pad: drag the point; x = sad → happy, y = quiet → energetic

function padSvg(active) {
  const W = 340, H = 150, L = 36, B = 22, T = 6;
  const aw = W - L - 2, ah = H - T - B - 4;
  const px = L + aw * S.padX, py = T + ah * (1 - S.padY);
  const sx = L, sy = T + ah * 0.78, ex = L + aw, ey = T + ah * (1 - (0.35 + S.padY * 0.3));
  const c = `M${sx},${sy} C${sx + (px - sx) * .55},${sy} ${px - (px - sx) * .45},${py} ${px},${py} C${px + (ex - px) * .45},${py} ${ex - (ex - px) * .55},${ey} ${ex},${ey}`;
  const col = active ? "#f2f2f2" : "#5c5c5c";
  let grid = "";
  for (let i = 0; i <= 4; i++) { const x = L + aw * i / 4; grid += `<line x1="${x}" y1="${T}" x2="${x}" y2="${T + ah}"/>`; }
  for (let i = 0; i <= 2; i++) { const y = T + ah * i / 2; grid += `<line x1="${L}" y1="${y}" x2="${L + aw}" y2="${y}"/>`; }
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-w="${W}" data-h="${H}">
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
  pad.addEventListener("pointercancel", () => { dragging = false; renderWave(); });
}

// ================================================================== UI: track rows (likes + search)

const lists = { likes: [], search: [] };

function rowHtml(t, list) {
  const liked = isLiked(t), c = cur();
  return `<div class="row ${c && c.key === t.key ? "cur" : ""}" data-act="play" data-list="${list}" data-key="${esc(t.key)}">
    <div class="cover row-c" ${coverStyle(t.cover)}></div>
    <div class="meta"><div class="t">${esc(t.title)}</div><div class="s"><span class="tag">${t.src === "ya" ? "ЯМ" : "SC"}</span><span>${esc(t.artist)}</span></div></div>
    <div class="d">${fmt(t.dur)}</div>
    <button class="heart ${liked ? "on" : ""}" data-act="like" data-key="${esc(t.key)}" aria-label="Нравится"><svg><use href="#i-heart${liked ? "-fill" : ""}"/></svg></button></div>`;
}

function onRowsClick(e) {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const all = [...lists.likes, ...lists.search, ...P.queue, ...lib.liked];
  const t = all.find(x => x.key === b.dataset.key);
  if (!t) return;
  if (b.dataset.act === "like") { e.stopPropagation(); toggleLike(t); return; }
  unlock();
  if (cur()?.key === t.key) return toggle();
  const list = lists[b.dataset.list];
  playList(list, list.indexOf(t), b.dataset.list === "likes" ? "likes" : "search", b.dataset.list === "likes" ? "Любимое" : "Поиск");
}

function markCurrent() {
  const c = cur();
  document.querySelectorAll(".row").forEach(r => r.classList.toggle("cur", !!c && r.dataset.key === c.key));
}

// ================================================================== UI: «Любимое»

let likesFilter = null, likesQuery = "";

function buildLikes() {
  const el = $("#page-likes");
  el.innerHTML = `<div class="h" style="margin-top:4px"><span style="font-size:20px">Любимое <small id="likesCount"></small></span>
      <span style="display:flex;gap:6px"><button class="ib" id="likesShuffle" aria-label="Перемешать"><svg><use href="#i-shuffle"/></svg></button>
      <button class="ib" id="likesPlay" aria-label="Слушать"><svg><use href="#i-play"/></svg></button></span></div>
    <div class="search"><svg><use href="#i-search"/></svg><input id="likesQ" type="search" placeholder="Поиск в любимом" autocomplete="off"></div>
    <div class="chips" id="likesFilters" style="margin-top:10px"></div>
    <div class="rows" id="likesRows"></div>`;
  $("#likesQ").addEventListener("input", e => { likesQuery = e.target.value.trim().toLowerCase(); renderLikesList(); });
  $("#likesFilters").addEventListener("click", e => { const b = e.target.closest("[data-v]"); if (!b) return; likesFilter = b.dataset.v || null; renderLikesList(); });
  $("#likesRows").addEventListener("click", onRowsClick);
  $("#likesPlay").addEventListener("click", () => { unlock(); playList(lists.likes, 0, "likes", "Любимое"); });
  $("#likesShuffle").addEventListener("click", () => { unlock(); playList(shuffle(lists.likes), 0, "likes", "Любимое · вперемешку"); });
  renderLikesList();
}

function renderLikesList() {
  const rows = $("#likesRows");
  if (!rows) return;
  const n = s => lib.liked.filter(t => t.src === s).length;
  $("#likesCount").textContent = `${lib.liked.length} ${plural(lib.liked.length)}`;
  $("#likesFilters").innerHTML = [["", "Все"], ...(has("ya") ? [["ya", `Яндекс · ${n("ya")}`]] : []), ...(has("sc") ? [["sc", `SoundCloud · ${n("sc")}`]] : [])]
    .map(([v, t]) => `<button class="chip ${(likesFilter || "") === v ? "on" : ""}" data-v="${v}">${t}</button>`).join("");
  lists.likes = lib.liked.filter(t => (!likesFilter || t.src === likesFilter) &&
    (!likesQuery || t.title.toLowerCase().includes(likesQuery) || t.artist.toLowerCase().includes(likesQuery)));
  rows.innerHTML = !has("ya") && !has("sc") ? `<div class="empty">Подключите Яндекс или SoundCloud — лайки из обоих сервисов соберутся здесь.</div>`
    : lib.loading && !lib.liked.length ? `<div class="empty">Загружаю лайки…</div>`
    : !lists.likes.length ? `<div class="empty">${likesQuery ? "Ничего не нашлось" : "Пока пусто"}</div>`
    : lists.likes.map(t => rowHtml(t, "likes")).join("");
}

// ================================================================== UI: «Поиск»

let searchTimer, searchReq = 0;

function buildSearch() {
  const el = $("#page-search");
  const q = $("#searchQ")?.value || "";
  el.innerHTML = `<div class="seg" style="margin-top:4px"><button data-v="ya" class="${S.source === "ya" ? "on" : ""}">Яндекс</button><button data-v="sc" class="${S.source === "sc" ? "on" : ""}">SoundCloud</button></div>
    <div class="search"><svg><use href="#i-search"/></svg><input id="searchQ" type="search" placeholder="Найти песню или исполнителя" autocomplete="off" enterkeyhint="search"></div>
    <div class="muted" id="searchStatus" style="margin:12px 2px 0"></div>
    <div class="rows" id="searchRows"></div>`;
  const input = $("#searchQ");
  input.value = q;
  input.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 450); });
  input.addEventListener("keydown", e => { if (e.key === "Enter") { input.blur(); runSearch(); } });
  el.querySelector(".seg").addEventListener("click", e => { const b = e.target.closest("[data-v]"); if (!b) return; S.source = b.dataset.v; saveS(); buildSearch(); renderWave(); runSearch(); });
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
    rows.innerHTML = list.map(t => rowHtml(t, "search")).join("");
  } catch (e) { if (req === searchReq) status.textContent = "Поиск не удался: " + e.message; }
}

// ================================================================== UI: player (mini + full screen)

function renderPlayer() {
  const t = cur();
  $("#mini").hidden = !t;
  if (!t) return;
  const icon = playing() ? "pause" : "play";
  const sub = P.busy && !playing() ? "Загружаю…" : t.artist;
  $("#miniCover").style.backgroundImage = t.cover ? `url('${t.cover}')` : "";
  $("#miniTitle").textContent = t.title;
  $("#miniSub").textContent = sub;
  $("#miniPlay").innerHTML = `<svg><use href="#i-${icon}"/></svg>`;

  $("#sheetCover").style.backgroundImage = t.big ? `url('${t.big}')` : "";
  $("#sheetTitle").textContent = t.title;
  $("#sheetArtist").textContent = t.album ? `${t.artist} · ${t.album}` : t.artist;
  $("#sheetTag").textContent = t.src === "ya" ? "ЯМ" : "SC";
  $("#sheetCtx").textContent = P.title;
  $("#sheetPlay").innerHTML = `<svg><use href="#i-${icon}"/></svg>`;
  const liked = isLiked(t);
  $("#sheetLike").innerHTML = `<svg><use href="#i-heart${liked ? "-fill" : ""}"/></svg>`;
  $("#sheetDislike").classList.toggle("dim", !isWave());
  $("#sheetDislike").disabled = !isWave();
  if (lyricsOpen && lyricsKey !== t.key) loadLyrics();
  if (P.ctx === "mywave") renderWaveButtonOnly();
}

function renderWaveButtonOnly() {
  const b = document.querySelector(".mywave .go use");
  if (b) b.setAttribute("href", `#i-${P.ctx === "mywave" && P.ctxSrc === S.source && playing() ? "pause" : "play"}`);
}

let lastPosState = 0;
function onTime() {
  const d = audio.duration && isFinite(audio.duration) ? audio.duration * 1000 : cur()?.dur || 0;
  const pos = audio.currentTime * 1000;
  const f = d ? pos / d : 0;
  $("#miniBar").style.width = (f * 100).toFixed(2) + "%";
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
$("#miniOpen").addEventListener("click", openSheet);
$("#sheetPlay").addEventListener("click", toggle);
$("#sheetNext").addEventListener("click", () => next());
$("#sheetPrev").addEventListener("click", prev);
$("#sheetDislike").addEventListener("click", dislike);
$("#sheetLike").addEventListener("click", () => toggleLike(cur()));
$("#sheetClose").addEventListener("click", () => closeSheet($("#sheet")));
$("#sheetCover").addEventListener("click", () => setLyrics(!lyricsOpen));
$("#lyricsToggle").addEventListener("click", () => setLyrics(!lyricsOpen));

function openSheet() { $("#sheet").hidden = false; renderPlayer(); onTime(); }
function closeSheet(el) {
  el.classList.add("closing");
  setTimeout(() => { el.hidden = true; el.classList.remove("closing"); }, 280);
}

// swipe down on the player to close it
(() => {
  let y0 = null;
  const sh = $("#sheet");
  sh.addEventListener("touchstart", e => { if (!e.target.closest(".lyrics, .seek")) y0 = e.touches[0].clientY; }, { passive: true });
  sh.addEventListener("touchend", e => { if (y0 != null && e.changedTouches[0].clientY - y0 > 90) closeSheet(sh); y0 = null; }, { passive: true });
})();

// ================================================================== lyrics

let lyricsOpen = false, lyricsKey = null, lyricsReq = 0, timed = [], activeLine = -1;

function setLyrics(open) {
  lyricsOpen = open;
  $("#lyricsToggle").classList.toggle("on", open);
  $("#lyrics").hidden = !open;
  $("#sheetCover").style.opacity = open ? "0" : "1";
  $("#sheetCover").style.pointerEvents = open ? "none" : "";
  if (open) loadLyrics();
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

function openAccounts() {
  const row = (src, name, title) => {
    const a = acc[src];
    return `<div class="acc"><div class="row1"><div><div class="t">${title}</div><div class="s">${a ? esc(a.name) : tokens[src] ? "токен не подошёл" : "не подключён"}</div></div>
      ${a || tokens[src] ? `<button class="btn sec" data-act="logout" data-v="${src}">Выйти</button>` : ""}</div>
      <details><summary>Ввести токен вручную</summary><input class="field" data-token="${src}" placeholder="${name}" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="btn" data-act="save" data-v="${src}">Сохранить</button></details></div>`;
  };
  $("#accountsBody").innerHTML = row("ya", "OAuth-токен Яндекса", "Яндекс") + row("sc", "oauth_token SoundCloud", "SoundCloud") +
    `<p class="note">Проще всего перенести аккаунты с компьютера: в HUM на ПК откройте «Аккаунты» → «Подключить iPhone» и наведите камеру на QR-код.</p>
     <p class="note">Чтобы HUM открывался как приложение: Safari → «Поделиться» → «На экран „Домой“».</p>
     <p class="note">Токены хранятся только на этом телефоне и уходят лишь в ваш собственный сервер HUM, который передаёт запросы сервисам.</p>
     <p class="note" style="opacity:.6">HUM web · версия ${VERSION}</p>`;
  $("#accounts").hidden = false;
}
$("#accountsBtn").addEventListener("click", openAccounts);
$("#accountsClose").addEventListener("click", () => closeSheet($("#accounts")));
$("#accountsBody").addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const src = b.dataset.v;
  if (b.dataset.act === "logout") { delete tokens[src]; acc[src] = null; store.set("tokens", tokens); lib.liked = lib.liked.filter(t => t.src !== src); lib.keys = new Set(lib.liked.map(t => t.key)); openAccounts(); renderAll(); }
  if (b.dataset.act === "save") {
    let v = $(`[data-token="${src}"]`).value.trim();
    const m = v.match(/access_token=([^&#\s]+)/); if (m) v = decodeURIComponent(m[1]);
    if (!v) return;
    tokens[src] = v; store.set("tokens", tokens);
    closeSheet($("#accounts"));
    connect();
  }
});

// ================================================================== start

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").then(r => r.update()).catch(() => {});
renderAll();
showTab(S.tab || "wave");
requestAnimationFrame(placeBlob);
takePairCode().then(connect);
// home-screen apps resume from memory: re-check accounts when coming back
document.addEventListener("visibilitychange", () => { if (!document.hidden && location.hash.startsWith("#p=")) takePairCode().then(connect); });
addEventListener("hashchange", () => { if (location.hash.startsWith("#p=")) takePairCode().then(connect); });
