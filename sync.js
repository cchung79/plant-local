"use strict";
// Keep this phone in step with the home server (Cloudflare Worker + D1, see server/).
// Records go up when they change and come back from the other phone; the newest change of a record wins.
// Connection = one "연결 코드" (server address + home key), kept with the other keys (not in backups).

const SHADOW_KEY = "plantlocal.shadow";      // what the server already has from us: {since, recs: {"kind/id": json}}
function serverOn() { const k = keys(); return !!(k.server_url && k.home_key); }
function shadow() { try { return JSON.parse(localStorage.getItem(SHADOW_KEY) || "{}"); } catch (e) { return {}; } }
function setShadow(s) { try { localStorage.setItem(SHADOW_KEY, JSON.stringify(s)); } catch (e) {} }

// the app's data as server records
function records() {
  const out = {};
  for (const p of db.plants) out["plant/" + p.id] = p;
  for (const l of db.log) out["log/" + l.id] = l;
  for (const e of db.pending || []) out["pending/" + e.id] = e;
  for (const [t, th] of Object.entries(db.chats || {})) out["chat/" + t] = { target: t, thread: th };
  for (const t of db.trash || []) out["trash/" + t.id] = t;
  out["meta/seasons"] = db.seasons;
  return out;
}
function applyRows(rows) {
  const by = { plant: new Map(db.plants.map(p => [p.id, p])), log: new Map(db.log.map(l => [l.id, l])), pending: new Map((db.pending || []).map(e => [e.id, e])),
              trash: new Map((db.trash || []).map(t => [t.id, t])) };
  db.chats ??= {};
  for (const r of rows) {
    if (r.kind === "meta") {
      if (r.id === "seasons" && r.data) db.seasons = r.data;
      if (r.id === "sensors" && r.data) setSensorCache(r.data);
      continue;
    }
    if (r.kind === "chat") { if (r.deleted) delete db.chats[r.id]; else db.chats[r.id] = r.data.thread || []; continue; }
    const m = by[r.kind]; if (!m) continue;
    if (r.deleted) m.delete(r.id); else m.set(r.id, r.data);
  }
  db.plants = [...by.plant.values()]; db.log = [...by.log.values()]; db.pending = [...by.pending.values()]; db.trash = [...by.trash.values()];
}

let syncTimer = null, syncing_ = null, syncAgain = false, lastSyncAt = 0, lastSyncError = "";
function scheduleSync() { if (!serverOn()) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow().catch(e => reportError(e.message, "sync")), 1500); }
async function serverCall(path, body) {
  const k = keys();
  let r;
  try {
    r = await fetch(k.server_url.replace(/\/$/, "") + path, { method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "X-Home-Key": k.home_key }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw new Error("서버에 연결할 수 없습니다(인터넷 확인)"); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error("집 열쇠가 맞지 않습니다. 연결 코드를 다시 넣어 주세요");
  if (!r.ok) throw new Error(j.error || `서버 오류 ${r.status}`);
  return j;
}
async function syncNow(opts = {}) {
  if (!serverOn()) return null;
  if (syncing_) { syncAgain = true; return syncing_; }     // changes made meanwhile go in the next round
  syncing_ = (async () => {
    try {
      const sh = opts.replace ? {} : shadow(), cur = records(), now = Date.now(), changes = [];
      if (!opts.replace) {
        for (const [k, v] of Object.entries(cur)) {
          const s = JSON.stringify(v);
          if (sh.recs?.[k] !== s) { const [kind, ...id] = k.split("/"); changes.push({ kind, id: id.join("/"), data: v, updated: now }); }
        }
        for (const k of Object.keys(sh.recs || {})) if (!(k in cur)) { const [kind, ...id] = k.split("/"); changes.push({ kind, id: id.join("/"), deleted: true, updated: now }); }
      }
      const res = await serverCall("/api/sync", { since: opts.replace ? 0 : (sh.since || 0), changes });
      if (opts.replace) { db.plants = []; db.log = []; db.pending = []; db.chats = {}; db.trash = []; }
      applyRows(res.rows);
      dedupe();
      try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {}
      const recs = {}; for (const [k, v] of Object.entries(records())) recs[k] = JSON.stringify(v);
      setShadow({ since: res.now, recs });
      lastSyncAt = Date.now(); lastSyncError = "";
      if (res.rows.length && !sheet && (tab === "todo" || tab === "plants")) render();
      return res;
    } catch (e) { lastSyncError = e.message; throw e; }
    finally { syncing_ = null; if (syncAgain) { syncAgain = false; scheduleSync(); } }
  })();
  return syncing_;
}

// 연결 코드 = base64url of {"u": server address, "k": home key}
function parseCode(code) {
  let j;
  try {
    const t = code.trim().replace(/^.*#?connect=/, "").replace(/-/g, "+").replace(/_/g, "/");
    j = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(t), c => c.charCodeAt(0))));
  } catch (e) { throw new Error("연결 코드가 맞지 않습니다"); }
  if (!/^https:\/\//.test(j.u) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(j.u)) throw new Error("주소가 이상합니다");
  if (!j.k || j.k.length < 16) throw new Error("열쇠가 이상합니다");
  return j;
}
async function connectWith(code, mode) {     // mode: "merge" (put this phone's data together with the server's) or "replace"
  const { u, k } = parseCode(code);
  setKey("server_url", u); setKey("home_key", k);
  try {
    const h = await serverCall("/api/health");
    if (!mode) mode = h.counts?.plant && db.plants.length ? "ask" : "merge";
    if (mode === "ask") return { ask: true, serverPlants: h.counts.plant };
    setShadow({});
    await syncNow({ replace: mode === "replace" });
    return { ok: true };
  } catch (e) { setKey("server_url", ""); setKey("home_key", ""); throw e; }
}

function serverSettingsHtml() {
  const k = keys();
  if (!serverOn()) return `<div class="card"><p class="small" style="margin-top:0">서버에 연결하면 아이폰과 노트10이 같은 기록을 보고, 앱을 열지 않아도 서버가 15분마다 센서를 읽어 둡니다.</p>
    <label class="small">연결 코드</label><textarea id="ccode" rows="3" placeholder="받은 연결 코드를 붙여 넣으세요" autocomplete="off"></textarea>
    <button class="btn btn-moist" id="cgo" style="width:100%;margin-top:8px">연결</button><div class="small" id="cmsg2" style="margin-top:6px"></div></div>`;
  return `<div class="card"><div class="small">연결됨: ${esc(k.server_url)}</div>
    <div class="small" id="sstat" style="margin-top:6px">${lastSyncAt ? "마지막 동기화 " + agoText(Date.now() - lastSyncAt) : "아직 동기화 안 함"}${lastSyncError ? ` · <span style="color:var(--red)">${esc(lastSyncError)}</span>` : ""}</div>
    <div class="row2" style="margin-top:8px"><button class="btn btn-moist" id="snow">지금 동기화</button><button class="btn btn-ghost" id="soff" style="color:var(--red)">연결 끊기</button></div>
    <p class="small" style="margin-bottom:0">센서는 서버가 15분마다 읽습니다. 연결을 끊어도 이 폰의 기록은 그대로 남습니다.</p></div>`;
}
function bindServerSettings() {
  const go = document.getElementById("cgo");
  if (go) go.onclick = async () => {
    const code = document.getElementById("ccode").value, msg = document.getElementById("cmsg2");
    go.disabled = true; msg.textContent = "연결하는 중…";
    try {
      let r = await connectWith(code);
      if (r.ask) {
        msg.innerHTML = `서버에 이미 식물 ${r.serverPlants}그루가 있습니다. 이 폰(${db.plants.length}그루)의 기록을 어떻게 할까요?
          <div class="row2" style="margin-top:6px"><button class="btn btn-moist" id="cmerge">합치기</button><button class="btn btn-ghost" id="crepl">서버 것으로 바꾸기</button></div>`;
        document.getElementById("cmerge").onclick = async () => { await connectWith(code, "merge"); toast("서버와 합쳤습니다"); renderSettings(); };
        document.getElementById("crepl").onclick = async () => { await connectWith(code, "replace"); toast("서버 데이터로 바꿨습니다"); renderSettings(); };
        go.disabled = false; return;
      }
      toast("서버에 연결했습니다"); renderSettings();
    } catch (e) { msg.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`; go.disabled = false; }
  };
  const now = document.getElementById("snow");
  if (now) now.onclick = async () => { now.disabled = true; try { await syncNow(); toast("동기화했습니다"); } catch (e) { toast(e.message); } renderSettings(); };
  const off = document.getElementById("soff");
  if (off) off.onclick = () => { if (confirm("서버 연결을 끊을까요? 이 폰의 기록은 남습니다.")) { setKey("server_url", ""); setKey("home_key", ""); setShadow({}); renderSettings(); } };
}
