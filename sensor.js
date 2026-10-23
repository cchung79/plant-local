"use strict";
// Ecowitt soil moisture sensors through the official Ecowitt cloud API v3 (https://doc.ecowitt.net).
// The gateway (GW1200B) uploads to ecowitt.net; this page reads the owner's own data with the owner's
// Application Key + API Key (설정 → 온라인 기능). Nothing runs without those keys.

const ECO = "https://api.ecowitt.net/api/v3/";
const SENSOR_KEY = "plantlocal.sensor";          // last readings, per phone: {fetchedAt, channels: {n: {pct, t}}}
const SYNC_EVERY_MS = 5 * 60 * 1000;            // ask the cloud at most every 5 minutes
const LOG_EVERY_S = 3 * 3600, LOG_STEP = 5;      // keep a reading in the plant's records every 3 h, or when it moves 5 %
const RISE = 15;                                // a jump of 15 % or more since the last reading looks like watering

function sensorCache() { try { return JSON.parse(localStorage.getItem(SENSOR_KEY) || "{}"); } catch (e) { return {}; } }
function setSensorCache(c) { try { localStorage.setItem(SENSOR_KEY, JSON.stringify(c)); } catch (e) {} }
const ecoReady = () => { const k = keys(); return !!(k.ecowitt_app && k.ecowitt_api); };
const isoLocal = t => iso(new Date(t * 1000));
const ecoDate = d => `${iso(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;

const ECO_ERRORS = {
  40010: "Application Key가 맞지 않습니다", 40011: "API Key가 맞지 않습니다", 40012: "장치 MAC 주소가 맞지 않습니다",
  40017: "Application Key가 비어 있습니다", 40018: "API Key가 비어 있습니다", 40019: "장치를 먼저 찾아 주세요(설정 → 장치 찾기)",
  45001: "요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요", 48001: "이 키로 볼 수 없는 장치입니다", [-1]: "Ecowitt 서버가 바쁩니다",
};
async function eco(path, params) {
  const k = keys();
  const q = new URLSearchParams({ application_key: k.ecowitt_app || "", api_key: k.ecowitt_api || "", ...params });
  let r;
  try { r = await fetch(ECO + path + "?" + q.toString()); } catch (e) { throw new Error("인터넷 연결을 확인해 주세요"); }
  if (!r.ok) throw new Error(`Ecowitt 서버 오류 ${r.status}`);
  const j = await r.json();
  if (j.code !== 0) throw new Error((ECO_ERRORS[j.code] || "Ecowitt 오류") + ` (${j.code} ${j.msg || ""})`);
  return j.data;
}
async function ecoDevices() {
  const d = await eco("device/list", { limit: 50 });
  return (d.list || []).map(x => ({ name: x.name, mac: x.mac, type: x.stationtype || "" }));
}
function soilChannels(data) {          // {"soil_ch3": {"soilmoisture": {"time","value"}}} → {3: {pct, t}}
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    const m = /^soil_ch(\d+)$/.exec(k); if (!m || !v.soilmoisture) continue;
    out[+m[1]] = { pct: Math.round(parseFloat(v.soilmoisture.value)), t: parseInt(v.soilmoisture.time, 10) };
  }
  return out;
}
async function ecoHistory(ch, days = 7) {
  const end = new Date(), start = new Date(end - days * 86400000);
  const d = await eco("device/history", { mac: keys().ecowitt_mac || "", start_date: ecoDate(start), end_date: ecoDate(end),
                                          cycle_type: "30min", call_back: `soil_ch${ch}` });
  const list = d?.[`soil_ch${ch}`]?.soilmoisture?.list || {};
  return Object.entries(list).map(([t, v]) => [parseInt(t, 10), parseFloat(v)]).filter(x => isFinite(x[1])).sort((a, b) => a[0] - b[0]);
}

// read the sensors, keep readings in each plant's records, and notice probable watering
let syncing = null;
async function syncSensors(force) {
  if (!ecoReady() || !keys().ecowitt_mac) return null;
  const c = sensorCache();
  if (!force && c.fetchedAt && Date.now() - c.fetchedAt < SYNC_EVERY_MS) return c;
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const ch = soilChannels(await eco("device/real_time", { mac: keys().ecowitt_mac }));
      const cache = { fetchedAt: Date.now(), channels: ch }; setSensorCache(cache);
      let changed = false;
      for (const p of db.plants) {
        const r = p.sensorCh && ch[p.sensorCh]; if (!r || !isFinite(r.pct)) continue;
        const prev = db.log.filter(l => l.plant === p.id && l.type === "moist" && l.sensorT).sort((a, b) => b.sensorT - a.sensorT)[0];
        if (prev && r.t <= prev.sensorT) continue;
        if (prev && r.t - prev.sensorT < LOG_EVERY_S && Math.abs(r.pct - prev.value) < LOG_STEP) continue;
        db.log.push({ id: uid(), plant: p.id, type: "moist", date: isoLocal(r.t), value: r.pct, sensorT: r.t, note: `센서 CH${p.sensorCh}` });
        changed = true;
        const watered = prev && db.log.some(l => l.plant === p.id && l.type === "water" && l.date >= isoLocal(prev.sensorT));
        if (prev && r.pct - prev.value >= RISE && !watered) {
          (db.pending ??= []).push({ id: uid(), plant: p.id, from: prev.value, to: r.pct, date: isoLocal(r.t) });
        }
      }
      if (changed) save();
      return cache;
    } finally { syncing = null; }
  })();
  return syncing;
}
function sensorNow(p) { const c = sensorCache(); return p.sensorCh ? c.channels?.[p.sensorCh] || null : null; }
function agoText(ms) { const m = Math.round(ms / 60000); return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`; }

// ---- 할 일 화면 위쪽: sensor status + "물 주셨나요?" cards ----
function sensorTopHtml() {
  if (!ecoReady()) return "";
  const c = sensorCache(), pend = (db.pending || []).filter(e => db.plants.some(p => p.id === e.plant));
  const linked = db.plants.filter(p => p.sensorCh).length;
  return pend.map(e => { const p = db.plants.find(x => x.id === e.plant);
      return `<div class="card suggest"><p><b>${esc(p.name)}</b> 흙 수분이 ${e.from}% → ${e.to}%로 올랐습니다 (${md(e.date)}). 물 주셨나요?</p>
        <div class="row2"><button class="btn btn-water" data-pw="${e.id}">${md(e.date)} 물 준 날로 기록</button><button class="btn btn-ghost" data-pn="${e.id}">아니요</button></div></div>`; }).join("") +
    `<div class="small" style="display:flex;justify-content:space-between;align-items:center;margin:4px 2px 0">
      <span>Ecowitt 센서 ${linked}개 연결 · ${c.fetchedAt ? agoText(Date.now() - c.fetchedAt) + " 받음" : "아직 안 받음"}</span>
      <button class="btn btn-ghost" id="ssync" style="padding:6px 10px">센서 새로 받기</button></div>`;
}
function bindSensorTop() {
  const b = document.getElementById("ssync");
  if (b) b.onclick = async () => { b.disabled = true; b.textContent = "받는 중…"; try { await syncSensors(true); render(); } catch (e) { toast(e.message); b.disabled = false; b.textContent = "센서 새로 받기"; } };
  for (const x of document.querySelectorAll("[data-pw]")) x.onclick = () => {
    const e = db.pending.find(y => y.id === x.dataset.pw); if (!e) return;
    if (!logsOf(e.plant, "water").some(l => l.date === e.date)) db.log.push({ id: uid(), plant: e.plant, type: "water", date: e.date, note: "센서로 알아챔" });
    db.pending = db.pending.filter(y => y !== e); save(); render(); toast(`${md(e.date)} 물 준 날로 기록했습니다`);
  };
  for (const x of document.querySelectorAll("[data-pn]")) x.onclick = () => { db.pending = db.pending.filter(y => y.id !== x.dataset.pn); save(); render(); };
}

// ---- plant sheet: channel choice + 7-day graph ----
function sensorFieldHtml(p) {
  if (!ecoReady()) return "";
  const ch = sensorCache().channels || {};
  const opts = Array.from({ length: 16 }, (_, i) => i + 1).map(n =>
    `<option value="${n}" ${p.sensorCh === n ? "selected" : ""}>CH${n}${ch[n] ? ` · 지금 ${ch[n].pct}%` : ""}</option>`).join("");
  return `<div class="field"><label>토양 센서<span class="hint">Ecowitt 채널</span></label><select id="sch"><option value="">없음</option>${opts}</select></div>`;
}
function sensorGraphHtml(p) {
  if (!ecoReady() || !p.sensorCh) return "";
  const n = sensorNow(p);
  return `<h2>센서 수분 (CH${p.sensorCh})</h2><div class="card"><div class="small">${n ? `지금 <b>${n.pct}%</b> · ${agoText(Date.now() - n.t * 1000)} · 기준 ${p.moistureMin}%` : "아직 값이 없습니다"}</div>
    <div id="sgraph" class="small" style="margin-top:8px">7일 기록을 불러오는 중…</div></div>`;
}
function bindSensor(p) {
  const sel = document.querySelector(".sheet #sch");
  if (sel) sel.onchange = async () => {
    const old = p.sensorCh || null; p.sensorCh = sel.value ? +sel.value : null;
    db.log.push({ id: uid(), plant: p.id, type: "edit", date: today(), note: `토양 센서 ${old ? "CH" + old : "없음"} → ${p.sensorCh ? "CH" + p.sensorCh : "없음"}` });
    save(); try { await syncSensors(true); } catch (e) { toast(e.message); } drawPlant(p);
  };
  const g = document.querySelector(".sheet #sgraph");
  if (g) ecoHistory(p.sensorCh).then(pts => { if (g.isConnected) g.innerHTML = pts.length ? sparkline(pts, p.moistureMin) : "지난 7일 기록이 없습니다"; })
    .catch(e => { if (g.isConnected) g.textContent = "기록을 못 불러왔습니다: " + e.message; });
}
function sparkline(pts, min) {
  const W = 320, H = 110, pad = 18, t0 = pts[0][0], t1 = pts.at(-1)[0] || t0 + 1;
  const x = t => pad + (W - 2 * pad) * (t - t0) / Math.max(1, t1 - t0), y = v => H - pad - (H - 2 * pad) * v / 100;
  const line = pts.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const days = []; for (let d = new Date(t0 * 1000); d <= new Date(t1 * 1000); d.setDate(d.getDate() + 1)) days.push(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
  const last = pts.at(-1);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="최근 7일 흙 수분">
    <line x1="${pad}" x2="${W - pad}" y1="${y(min)}" y2="${y(min)}" stroke="var(--red)" stroke-dasharray="4 4" stroke-width="1"/>
    <text x="${pad + 34}" y="${y(min) - 4}" font-size="10" fill="var(--red)">기준 ${min}%</text>
    ${days.filter(d => d >= t0).map(d => `<text x="${x(d)}" y="${H - 4}" font-size="10" fill="var(--sub)" text-anchor="middle">${md(iso(new Date(d * 1000)))}</text>`).join("")}
    <path d="${line}" fill="none" stroke="var(--green)" stroke-width="2"/>
    <circle cx="${x(last[0])}" cy="${y(last[1])}" r="3" fill="var(--green)"/>
    <text x="${pad}" y="${y(100) + 10}" font-size="10" fill="var(--sub)">100%</text><text x="${pad}" y="${y(0) - 3}" font-size="10" fill="var(--sub)">0%</text>
  </svg>`;
}

// ---- settings ----
function ecoSettingsHtml() {
  const k = keys();
  return `<div style="padding:6px 0;border-bottom:1px solid var(--line)"><label class="small"><b>Ecowitt</b> — 토양 수분 센서. ecowitt.net 로그인 → Private Center에서 만든 키 2개 <a href="https://www.ecowitt.net/home/user" target="_blank" rel="noopener">키 받기</a></label>
    <input type="password" autocomplete="off" data-key="ecowitt_app" value="${esc(k.ecowitt_app || "")}" placeholder="Application Key" style="margin-top:4px">
    <input type="password" autocomplete="off" data-key="ecowitt_api" value="${esc(k.ecowitt_api || "")}" placeholder="API Key" style="margin-top:6px">
    <div class="toggle" style="padding-top:8px"><span class="small" id="eres">${k.ecowitt_mac ? `장치: ${esc(k.ecowitt_name || "")} (${esc(k.ecowitt_mac)})` : "키를 넣고 장치를 찾아 주세요."}</span><button class="btn btn-ghost" id="efind" style="white-space:nowrap">장치 찾기</button></div>
    <div id="elink">${k.ecowitt_mac ? channelLinksHtml() : ""}</div></div>`;
}
function channelLinksHtml() {
  const chs = Object.entries(sensorCache().channels || {});
  if (!chs.length) return "";
  return `<div class="small" style="margin-top:8px"><b>센서가 꽂힌 화분</b></div>` + chs.map(([n, v]) => {
    const cur = db.plants.find(p => p.sensorCh === +n);
    return `<div class="field"><label>CH${n} · 지금 ${v.pct}%<span class="hint">${agoText(Date.now() - v.t * 1000)}</span></label>
      <select data-link="${n}"><option value="">연결 안 함</option>${db.plants.map(p => `<option value="${p.id}" ${cur === p ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>`;
  }).join("");
}
function bindChannelLinks() {
  for (const sel of document.querySelectorAll("[data-link]")) sel.onchange = async () => {
    const ch = +sel.dataset.link;
    for (const p of db.plants) if (p.sensorCh === ch && p.id !== sel.value) {           // one pot per channel
      p.sensorCh = null; db.log.push({ id: uid(), plant: p.id, type: "edit", date: today(), note: `토양 센서 CH${ch} → 없음` });
    }
    const p = db.plants.find(x => x.id === sel.value);
    if (p) { const old = p.sensorCh; p.sensorCh = ch; db.log.push({ id: uid(), plant: p.id, type: "edit", date: today(), note: `토양 센서 ${old ? "CH" + old : "없음"} → CH${ch}` }); }
    save();
    try { await syncSensors(true); } catch (e) {}
    toast(p ? `CH${ch}을 ${p.name}에 연결했습니다` : `CH${ch} 연결을 풀었습니다`);
    document.getElementById("elink").innerHTML = channelLinksHtml(); bindChannelLinks();
  };
}
function bindEcoSettings() {
  const b = document.getElementById("efind"), out = document.getElementById("eres"); if (!b) return;
  bindChannelLinks();
  b.onclick = async () => {
    if (!ecoReady()) { out.textContent = "키 2개를 먼저 넣어 주세요."; return; }
    b.disabled = true; out.textContent = "찾는 중…";
    try {
      const list = await ecoDevices();
      if (!list.length) { out.textContent = "이 계정에 장치가 없습니다. 게이트웨이가 ecowitt.net에 올리고 있는지 확인해 주세요."; return; }
      const d = list[0]; setKey("ecowitt_mac", d.mac); setKey("ecowitt_name", d.name);
      const c = await syncSensors(true), chs = Object.entries(c?.channels || {});
      out.innerHTML = `<b style="color:var(--green)">찾음</b> — ${esc(d.name)} (${esc(d.mac)})${list.length > 1 ? ` 외 ${list.length - 1}대` : ""}<br>` +
        (chs.length ? `토양 센서: ${chs.map(([n, v]) => `CH${n} ${v.pct}%`).join(", ")} — 아래에서 화분을 골라 주세요` : "토양 센서 값이 아직 없습니다");
      document.getElementById("elink").innerHTML = channelLinksHtml(); bindChannelLinks();
    } catch (e) { out.innerHTML = `<b style="color:var(--red)">안 됨</b> — ${esc(e.message)}`; }
    finally { b.disabled = false; }
  };
}
