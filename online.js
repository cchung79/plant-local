"use strict";
// Online helpers for the plant app. Nothing here runs unless a button is pressed, and each service is used only
// when its key is filled in (설정 → 온라인 기능). Keys stay on this phone (separate from the backup file).
//   Pl@ntNet  - photo → species (500 free identifications a day; the key must allow this site's domain)
//   Wikidata / Wikipedia - Korean name, picture, short description (no key)
//   Perenual  - watering / sunlight / indoor / toxicity reference values (free key)
//   Kindwise plant.health - photo → disease suggestions (100 free credits)
//   Claude    - care proposal for a new plant, and answers to "왜 이렇게 됐을까요?" with the plant's own records

const KEYS_KEY = "plantlocal.keys";
const CLAUDE_MODEL = "claude-opus-5-5";
const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.132.1/+esm";

function keys() { try { return JSON.parse(localStorage.getItem(KEYS_KEY) || "{}"); } catch (e) { return {}; } }
function setKey(k, v) { const all = keys(); if (v) all[k] = v; else delete all[k]; try { localStorage.setItem(KEYS_KEY, JSON.stringify(all)); } catch (e) {} }

// ---- photos: shrink before sending/storing ----
function readImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      c.toBlob(b => resolve({ blob: b, dataUrl: c.toDataURL("image/jpeg", quality) }), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("사진을 열 수 없습니다")); };
    img.src = url;
  });
}
const b64 = dataUrl => dataUrl.slice(dataUrl.indexOf(",") + 1);

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) { let t = ""; try { t = (await r.text()).slice(0, 200); } catch (e) {} throw new Error(`${r.status} ${t}`); }
  return r.json();
}

// ---- Pl@ntNet ----
async function identify(blob, organ) {
  const k = keys().plantnet; if (!k) throw new Error("Pl@ntNet 키가 없습니다 (설정 → 온라인 기능)");
  const f = new FormData(); f.append("images", blob, "plant.jpg"); f.append("organs", organ || "auto");
  const j = await getJSON(`https://my-api.plantnet.org/v2/identify/all?api-key=${encodeURIComponent(k)}&lang=ko&nb-results=5`, { method: "POST", body: f });
  return (j.results || []).map(r => ({
    species: r.species.scientificNameWithoutAuthor, score: r.score,
    common: (r.species.commonNames || []).slice(0, 3), family: r.species.family?.scientificNameWithoutAuthor || "",
  }));
}

// ---- Wikidata + Wikipedia ----
async function wiki(species) {
  const W = "https://www.wikidata.org/w/api.php?format=json&origin=*";
  const s = await getJSON(`${W}&action=wbsearchentities&type=item&language=en&limit=5&search=${encodeURIComponent(species)}`);
  const ids = (s.search || []).map(x => x.id); if (!ids.length) return null;
  const e = await getJSON(`${W}&action=wbgetentities&props=labels|claims|sitelinks&languages=ko|en&ids=${ids.join("|")}`);
  // the item whose taxon name (P225) is exactly this species
  const item = ids.map(i => e.entities[i]).find(it => (it.claims?.P225 || []).some(c => c.mainsnak?.datavalue?.value === species)) || e.entities[ids[0]];
  const out = { qid: item.id, ko: item.labels?.ko?.value || "", en: item.labels?.en?.value || "", url: `https://www.wikidata.org/wiki/${item.id}` };
  const img = item.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if (img) out.image = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(img)}?width=320`;
  for (const lang of ["ko", "en"]) {
    const t = item.sitelinks?.[lang + "wiki"]?.title; if (!t) continue;
    try {
      const p = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`);
      out.summary = p.extract; out.summaryLang = lang; out.wikiUrl = p.content_urls?.mobile?.page || ""; break;
    } catch (err) {}
  }
  return out;
}

// ---- Perenual ----
async function perenual(species) {
  const k = keys().perenual; if (!k) return null;
  const P = "https://perenual.com/api/v2";
  const list = await getJSON(`${P}/species-list?key=${encodeURIComponent(k)}&q=${encodeURIComponent(species)}`);
  const hit = (list.data || []).find(x => (x.scientific_name || []).some(n => n.toLowerCase() === species.toLowerCase())) || (list.data || [])[0];
  if (!hit) return null;
  let d; try { d = await getJSON(`${P}/species/details/${hit.id}?key=${encodeURIComponent(k)}`); } catch (e) { return { name: hit.common_name, limited: String(e.message) }; }
  return {
    name: d.common_name, watering: d.watering, benchmark: d.watering_general_benchmark ? `${d.watering_general_benchmark.value} ${d.watering_general_benchmark.unit}` : "",
    sunlight: (d.sunlight || []).join(", "), indoor: d.indoor, careLevel: d.care_level,
    toxicHuman: d.poisonous_to_humans, toxicPet: d.poisonous_to_pets,
  };
}

// ---- Kindwise plant.health ----
async function health(dataUrl) {
  const k = keys().kindwise; if (!k) return null;
  const j = await getJSON("https://plant.id/api/v3/health_assessment?language=ko,en&details=local_name,description,treatment,cause", {
    method: "POST", headers: { "Content-Type": "application/json", "Api-Key": k }, body: JSON.stringify({ images: [dataUrl], similar_images: false }),
  });
  const r = j.result || {};
  return {
    healthy: r.is_healthy?.probability ?? null,
    diseases: (r.disease?.suggestions || []).slice(0, 4).map(s => ({
      name: s.details?.local_name || s.name, p: s.probability, description: s.details?.description || "",
      treatment: s.details?.treatment || null, cause: s.details?.cause || "",
    })),
  };
}

// ---- Claude ----
let sdkPromise = null;
async function claude(system, content, schema) {
  const k = keys().claude; if (!k) throw new Error("Claude 키가 없습니다 (설정 → 온라인 기능)");
  sdkPromise ??= import(SDK_URL);
  const { default: Anthropic } = await sdkPromise;
  const client = new Anthropic({ apiKey: k, dangerouslyAllowBrowser: true });   // the key is the owner's own, kept on this phone
  const res = await client.beta.messages.create({
    model: CLAUDE_MODEL, max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    system, messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal") throw new Error("Claude가 이 요청에 답하지 않았습니다");
  if (res.stop_reason === "max_tokens") throw new Error("답이 너무 길어 잘렸습니다. 다시 시도해 주세요");
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  return JSON.parse(text);
}
const CARE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["korean_name", "water_warm_days", "water_cold_days", "fert_on", "fert_warm_days", "fert_cold_days", "moisture_min_pct", "light", "location", "location_reason", "notes"],
  properties: {
    korean_name: { type: "string" },
    water_warm_days: { type: "integer" }, water_cold_days: { type: "integer" },
    fert_on: { type: "boolean" }, fert_warm_days: { type: ["integer", "null"] }, fert_cold_days: { type: ["integer", "null"] },
    moisture_min_pct: { type: "integer" },
    light: { type: "string" }, location: { type: "string" }, location_reason: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
  },
};
const DIAG_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["summary", "urgency", "causes", "checks", "actions", "water_change_days", "water_change_reason"],
  properties: {
    summary: { type: "string" },
    urgency: { type: "string", enum: ["바로", "며칠 안", "지켜보기"] },
    causes: { type: "array", items: { type: "object", additionalProperties: false, required: ["cause", "likelihood", "why"],
      properties: { cause: { type: "string" }, likelihood: { type: "string", enum: ["높음", "중간", "낮음"] }, why: { type: "string" } } } },
    checks: { type: "array", items: { type: "string" } },
    actions: { type: "array", items: { type: "string" } },
    water_change_days: { type: ["integer", "null"] }, water_change_reason: { type: "string" },
  },
};
function myLocations() { return [...new Set(db.plants.map(p => p.location).filter(Boolean))]; }
function plantContext(p) {
  const s = season(today());
  const recent = logsOf(p.id).slice(0, 20).map(l => `${l.date} ${l.type}${l.value != null ? " " + l.value + "%" : ""}${l.note ? " (" + l.note + ")" : ""}`).join("\n");
  return `식물: ${p.name} (${p.species || "학명 모름"})\n위치: ${p.location}\n화분: ${p.pot?.type || "?"} ${p.pot?.cm ? p.pot.cm + "cm" : ""} 흙: ${p.pot?.soil || "?"}\n` +
    `지금 계절: ${SEASON_KO[s]} (따뜻한 계절 ${monthsText("warm")}, 추운 계절 ${monthsText("cold")})\n` +
    `물 간격: 따뜻 ${p.water.warm ?? "-"}일 / 추운 ${p.water.cold ?? "-"}일, 비료: ${p.fert.on ? `따뜻 ${p.fert.warm ?? "안 함"} / 추운 ${p.fert.cold ?? "안 함"}일` : "안 함"}\n` +
    `물 줄 기준 수분: ${p.moistureMin}% (수분계 0~100%)\n메모: ${p.note || "-"}\n최근 기록(최신순, 오늘 ${today()}):\n${recent || "없음"}`;
}

// ---- 식물 추가 (photo → identify → reference → proposal → edit → save) ----
let addState = null;
function openAddPlant() {
  sheet?.remove(); sheet = document.createElement("div"); sheet.className = "sheet"; document.body.appendChild(sheet); document.body.classList.add("locked");
  addState = { photo: null, blob: null, cands: [], species: "", wiki: null, per: null, prop: null };
  drawAdd();
}
function drawAdd(msg) {
  const a = addState, k = keys(), locs = myLocations(), p = a.prop;
  sheet.innerHTML = `
  <header><button id="back">‹ 취소</button><h1 style="flex:1;font-size:18px;margin:0">식물 추가</h1></header>
  <main>
    <div class="card">
      <b>1. 사진</b>
      <div class="row2" style="margin-top:8px">
        <label class="btn btn-ghost" style="text-align:center">사진 찍기/고르기<input type="file" id="ph" accept="image/*" capture="environment" style="display:none"></label>
        <select id="organ"><option value="auto">부위: 자동</option><option value="leaf">잎</option><option value="flower">꽃</option><option value="fruit">열매</option><option value="bark">줄기</option></select>
      </div>
      ${a.photo ? `<img src="${a.photo}" style="width:100%;border-radius:10px;margin-top:8px">` : ""}
      <button class="btn btn-moist" id="idbtn" style="width:100%;margin-top:8px" ${a.blob ? "" : "disabled"}>${k.plantnet ? "이 사진으로 식물 찾기" : "식물 찾기 (Pl@ntNet 키 필요)"}</button>
      ${a.cands.length ? `<div style="margin-top:8px">${a.cands.map((c, i) => `<label class="toggle" style="border-bottom:1px solid var(--line)"><span><b><i>${esc(c.species)}</i></b> ${Math.round(c.score * 100)}%<br><span class="small">${esc(c.common.join(", ") || c.family)}</span></span><input type="radio" name="cand" value="${i}" ${a.species === c.species ? "checked" : ""} style="width:auto"></label>`).join("")}</div>
        <p class="small">식물 식별: Pl@ntNet (plantnet.org)</p>` : ""}
    </div>
    <div class="card">
      <b>2. 학명</b> <span class="small">사진 없이 직접 써도 됩니다</span>
      <div class="row2" style="margin-top:8px"><input id="sp" value="${esc(a.species)}" placeholder="예: Monstera deliciosa"><button class="btn btn-ghost" id="look">참고 정보 찾기</button></div>
      ${a.wiki ? `<div style="display:flex;gap:10px;margin-top:10px">${a.wiki.image ? `<img src="${a.wiki.image}" style="width:84px;height:84px;object-fit:cover;border-radius:10px">` : ""}
        <div class="small"><b>${esc(a.wiki.ko || a.wiki.en)}</b> · <a href="${a.wiki.url}" target="_blank" rel="noopener">Wikidata</a>${a.wiki.wikiUrl ? ` · <a href="${esc(a.wiki.wikiUrl)}" target="_blank" rel="noopener">위키백과</a>` : ""}<br>${esc((a.wiki.summary || "").slice(0, 260))}${(a.wiki.summary || "").length > 260 ? "…" : ""}</div></div>` : ""}
      ${a.per ? `<div class="small" style="margin-top:8px">Perenual: 물 ${esc(a.per.watering || "?")}${a.per.benchmark ? ` (${esc(a.per.benchmark)})` : ""} · 햇빛 ${esc(a.per.sunlight || "?")} · 실내 ${a.per.indoor ? "가능" : "?"} · 관리 ${esc(a.per.careLevel || "?")} · 독성(사람/반려동물) ${a.per.toxicHuman ? "있음" : "없음"}/${a.per.toxicPet ? "있음" : "없음"}${a.per.limited ? ` <br>(상세 정보 제한: ${esc(a.per.limited)})` : ""}</div>` : ""}
      ${p ? `<div class="card suggest" style="margin:10px 0 0"><p><b>Claude 제안</b> — ${esc(p.light)}<br>위치: <b>${esc(p.location)}</b> — ${esc(p.location_reason)}</p>${p.notes.length ? `<ul class="small" style="margin:0;padding-left:18px">${p.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}<p class="small" style="margin:8px 0 0">아래 칸에 넣어 두었습니다. 고쳐서 저장하세요.</p></div>` : ""}
    </div>
    ${msg ? `<div class="card" style="border-color:var(--red);color:var(--red)">${esc(msg)}</div>` : ""}
    <div class="card">
      <b>3. 내 일정</b>
      <div class="field"><label>이름(별명)</label><input id="nm" value="${esc(a.name ?? (p?.korean_name || a.wiki?.ko || ""))}"></div>
      <div class="field"><label>위치</label><input id="lc" list="locs2" value="${esc(a.loc ?? (p?.location || ""))}"><datalist id="locs2">${locs.map(l => `<option value="${esc(l)}">`).join("")}</datalist></div>
      <div class="field"><label>물 · 따뜻한 계절</label><div class="unit"><input type="number" inputmode="numeric" id="ww" value="${p?.water_warm_days ?? 10}"><span>일</span></div></div>
      <div class="field"><label>물 · 추운 계절</label><div class="unit"><input type="number" inputmode="numeric" id="wc" value="${p?.water_cold_days ?? 14}"><span>일</span></div></div>
      <div class="toggle"><label for="fo">비료 일정 사용</label><input type="checkbox" id="fo" style="width:auto;transform:scale(1.4)" ${p?.fert_on ? "checked" : ""}></div>
      <div class="field"><label>비료 · 따뜻한 계절<span class="hint">비우면 안 함</span></label><div class="unit"><input type="number" inputmode="numeric" id="fw" value="${p?.fert_warm_days ?? ""}"><span>일</span></div></div>
      <div class="field"><label>비료 · 추운 계절<span class="hint">비우면 안 함</span></label><div class="unit"><input type="number" inputmode="numeric" id="fc" value="${p?.fert_cold_days ?? ""}"><span>일</span></div></div>
      <div class="field"><label>물 줄 기준 수분</label><div class="unit"><input type="number" inputmode="numeric" id="mm" value="${p?.moisture_min_pct ?? 30}"><span>%</span></div></div>
      <div class="unit" style="margin-top:8px"><span>마지막 물 준 날</span><input type="date" id="lw" max="${today()}"></div>
      <button class="btn btn-ghost" id="ask" style="width:100%;margin-top:10px" ${a.species ? "" : "disabled"}>${k.claude ? "Claude에게 일정·위치 제안 받기" : "제안 받기 (Claude 키 필요)"}</button>
      <button class="btn btn-moist" id="save" style="width:100%;margin-top:8px">저장</button>
    </div>
  </main>`;
  const $ = id => sheet.querySelector("#" + id);
  const keep = () => { a.name = $("nm").value; a.loc = $("lc").value; a.species = $("sp").value.trim(); };
  $("back").onclick = closeSheet;
  $("ph").onchange = async e => {
    const f = e.target.files[0]; if (!f) return; keep();
    try { const big = await readImage(f, 1280, 0.85); a.blob = big.blob; a.photo = big.dataUrl; a.thumb = (await readImage(f, 256, 0.7)).dataUrl; a.cands = []; drawAdd(); }
    catch (err) { drawAdd(err.message); }
  };
  $("idbtn").onclick = async () => {
    keep(); busy($("idbtn"), "찾는 중…");
    try { a.cands = await identify(a.blob, $("organ").value); if (a.cands[0]) a.species = a.cands[0].species; drawAdd(a.cands.length ? "" : "비슷한 식물을 찾지 못했습니다. 잎이나 꽃이 크게 나오게 다시 찍어 보세요."); }
    catch (err) { drawAdd("식물 찾기 실패: " + err.message); }
  };
  for (const r of sheet.querySelectorAll('input[name="cand"]')) r.onchange = () => { keep(); a.species = a.cands[+r.value].species; a.wiki = a.per = a.prop = null; drawAdd(); };
  $("look").onclick = async () => {
    keep(); if (!a.species) return; busy($("look"), "찾는 중…");
    const errs = [];
    try { a.wiki = await wiki(a.species); } catch (err) { errs.push("위키데이터: " + err.message); }
    try { a.per = await perenual(a.species); } catch (err) { errs.push("Perenual: " + err.message); }
    drawAdd(errs.join(" / "));
  };
  $("ask").onclick = async () => {
    keep(); busy($("ask"), "Claude가 생각하는 중…");
    try {
      if (!a.wiki) { try { a.wiki = await wiki(a.species); } catch (err) {} }
      if (!a.per) { try { a.per = await perenual(a.species); } catch (err) {} }
      const others = db.plants.map(x => `${x.name} (${x.species}) @ ${x.location}: 물 ${x.water.warm}/${x.water.cold}일, 기준 ${x.moistureMin}%`).join("\n");
      const text = `새로 들여온 식물의 관리 일정을 제안해 주세요.\n학명: ${a.species}\n` +
        (a.wiki?.summary ? `위키백과 요약: ${a.wiki.summary}\n` : "") + (a.per ? `Perenual 참고값: ${JSON.stringify(a.per)}\n` : "") +
        `우리 집 위치 목록: ${myLocations().join(", ") || "없음"}\n이미 키우는 식물과 주인이 정한 간격(참고):\n${others}\n` +
        `계절: 따뜻한 계절 ${monthsText("warm")}, 추운 계절 ${monthsText("cold")}. 수분계는 0~100%.`;
      const content = [{ type: "text", text }];
      if (a.photo) content.unshift({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64(a.photo) } });
      a.prop = await claude("당신은 한국 가정의 실내 식물 관리를 돕습니다. 주인은 수분계로 흙을 재고 일정을 직접 고칩니다. " +
        "제안은 출발점이므로 보수적으로(과습보다 약간 건조하게) 잡고, 위치는 가능하면 주어진 위치 목록에서 고르세요. 모든 글은 한국어로 짧게 씁니다.", content, CARE_SCHEMA);
      a.name = a.name || a.prop.korean_name; a.loc = a.loc || a.prop.location;
      drawAdd();
    } catch (err) { drawAdd("제안 받기 실패: " + err.message); }
  };
  $("save").onclick = () => {
    keep();
    const n = v => { const x = parseInt(v, 10); return Number.isFinite(x) && x > 0 ? x : null; };
    const pl = {
      id: "p" + uid(), name: a.name.trim() || a.species || "새 식물", species: a.species, location: a.loc.trim(),
      pot: { type: "", cm: null, soil: "" }, sizeCm: null,
      water: { warm: n($("ww").value), cold: n($("wc").value) },
      fert: { on: $("fo").checked, warm: n($("fw").value), cold: n($("fc").value) },
      moistureMin: Math.min(100, parseInt($("mm").value, 10) || 30), note: "", careRef: {}, photo: a.thumb || null,
      ref: { wikidata: a.wiki?.qid || null, perenual: a.per || null, claude: a.prop ? { light: a.prop.light, notes: a.prop.notes } : null },
    };
    if (a.prop || a.per) pl.careRef = { src: [a.prop && "Claude", a.per && "Perenual"].filter(Boolean).join("·"), light: a.prop?.light || a.per?.sunlight || "",
                                        toxic: a.per ? (a.per.toxicHuman || a.per.toxicPet ? "독성 있음" : "독성 없음") : "" };
    db.plants.push(pl);
    if ($("lw").value) db.log.push({ id: uid(), plant: pl.id, type: "water", date: $("lw").value, note: "" });
    save(); toast(`"${pl.name}"을(를) 추가했습니다`); openPlant(pl.id);
  };
}
function busy(btn, t) { btn.disabled = true; btn.textContent = t; }

// ---- 상태 묻기 (plant detail) ----
function diagCardHtml(p) {
  const k = keys(), ready = k.claude || k.kindwise;
  return `<h2>사진으로 상태 묻기</h2>
  <div class="card" id="dg">
    ${ready ? "" : `<p class="small" style="margin-top:0">설정 → 온라인 기능에서 Claude 키(또는 Kindwise 키)를 넣으면 쓸 수 있습니다.</p>`}
    <label class="btn btn-ghost" style="display:block;text-align:center">사진 찍기/고르기<input type="file" id="dph" accept="image/*" capture="environment" style="display:none"></label>
    <div id="dprev"></div>
    <textarea id="dq" rows="2" placeholder="예: 아랫잎이 노랗게 변해요" style="margin-top:8px"></textarea>
    <button class="btn btn-moist" id="dgo" style="width:100%;margin-top:8px" ${ready ? "" : "disabled"}>물어보기</button>
    <div id="dres"></div>
  </div>`;
}
function bindDiag(p) {
  const $ = id => sheet.querySelector("#" + id); let photo = null;
  $("dph").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { photo = (await readImage(f, 1280, 0.85)).dataUrl; $("dprev").innerHTML = `<img src="${photo}" style="width:100%;border-radius:10px;margin-top:8px">`; }
    catch (err) { toast(err.message); }
  };
  $("dgo").onclick = async () => {
    const q = $("dq").value.trim(); if (!photo && !q) { toast("사진이나 질문을 넣어 주세요"); return; }
    busy($("dgo"), "살펴보는 중…"); const out = $("dres"); let html = "", kw = null;
    if (photo && keys().kindwise) {
      try {
        kw = await health(photo);
        html += `<div class="card" style="margin:10px 0 0"><b>plant.health</b> — 건강할 확률 ${kw.healthy == null ? "?" : Math.round(kw.healthy * 100) + "%"}` +
          (kw.diseases.length ? `<ul class="small" style="padding-left:18px">${kw.diseases.map(d => `<li><b>${esc(d.name)}</b> ${Math.round(d.p * 100)}%${d.cause ? ` — ${esc(d.cause)}` : ""}</li>`).join("")}</ul>` : "") + `</div>`;
      } catch (err) { html += `<p class="small">plant.health 실패: ${esc(err.message)}</p>`; }
    }
    let ans = null;
    if (keys().claude) {
      try {
        const content = [{ type: "text", text: `${plantContext(p)}\n\n주인의 질문: ${q || "사진 속 상태가 괜찮은지 봐 주세요."}` +
          (kw ? `\n\nplant.health 결과(참고, 틀릴 수 있음): ${JSON.stringify(kw)}` : "") }];
        if (photo) content.unshift({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64(photo) } });
        ans = await claude("당신은 한국 가정의 실내 식물 상태를 함께 살피는 도우미입니다. 사진과 기록(물 준 날, 수분계 값, 간격)을 근거로 " +
          "가능성 높은 원인부터 말하고, 집에서 확인할 것과 할 일을 구체적으로 씁니다. 사진만으로 확실하지 않으면 그렇다고 말합니다. " +
          "물 간격을 바꾸는 게 맞다고 판단될 때만 water_change_days에 지금 계절의 새 간격(일)을 넣고, 아니면 null. 한국어로 짧게.", content, DIAG_SCHEMA);
        html += `<div class="card suggest" style="margin:10px 0 0"><p><b>${esc(ans.summary)}</b> <span class="badge ${ans.urgency === "바로" ? "b-late" : "b-moist"}">${esc(ans.urgency)}</span></p>
          ${ans.causes.length ? `<div class="small"><b>원인 후보</b><ul style="padding-left:18px;margin:4px 0">${ans.causes.map(c => `<li>${esc(c.cause)} (${esc(c.likelihood)}) — ${esc(c.why)}</li>`).join("")}</ul></div>` : ""}
          ${ans.checks.length ? `<div class="small"><b>확인할 것</b><ul style="padding-left:18px;margin:4px 0">${ans.checks.map(c => `<li>${esc(c)}</li>`).join("")}</ul></div>` : ""}
          ${ans.actions.length ? `<div class="small"><b>할 일</b><ul style="padding-left:18px;margin:4px 0">${ans.actions.map(c => `<li>${esc(c)}</li>`).join("")}</ul></div>` : ""}
          ${ans.water_change_days ? `<p class="small">${esc(ans.water_change_reason)}</p><button class="btn btn-ghost" id="dchg">${SEASON_KO[season(today())]} 물 간격 ${p.water[season(today())] ?? "-"}일 → ${ans.water_change_days}일로 바꾸기</button>` : ""}
          </div>`;
      } catch (err) { html += `<p class="small" style="color:var(--red)">Claude 실패: ${esc(err.message)}</p>`; }
    }
    if (ans || kw) {
      db.log.push({ id: uid(), plant: p.id, type: "diag", date: today(), note: (q ? q + " → " : "") + (ans ? ans.summary : (kw.diseases[0]?.name || "건강해 보임")) });
      save();
    }
    out.innerHTML = html; $("dgo").disabled = false; $("dgo").textContent = "다시 물어보기";
    const chg = sheet.querySelector("#dchg"); if (chg) chg.onclick = () => setInterval_(p, season(today()), ans.water_change_days);
  };
}

// ---- settings: keys ----
function keysSettingsHtml() {
  const k = keys();
  const row = (id, label, hint, url) => `<div style="padding:6px 0;border-bottom:1px solid var(--line)"><label class="small"><b>${label}</b> — ${hint} <a href="${url}" target="_blank" rel="noopener">키 받기</a></label>
    <input type="password" autocomplete="off" data-key="${id}" value="${esc(k[id] || "")}" placeholder="${k[id] ? "" : "비어 있음"}" style="margin-top:4px"></div>`;
  return `<h2>온라인 기능 (선택)</h2>
  <div class="card">
    <p class="small" style="margin-top:0">버튼을 누를 때만 인터넷을 씁니다. 키는 이 폰에만 저장되고 백업 파일에는 들어가지 않습니다. 사진과 식물 기록은 그 버튼의 서비스로만 보내집니다.</p>
    ${row("plantnet", "Pl@ntNet", "사진으로 식물 찾기, 하루 500회 무료. 키 설정에서 이 사이트 주소를 허용해야 합니다.", "https://my.plantnet.org/")}
    ${row("perenual", "Perenual", "물·햇빛 참고값 (무료 키, 일부 식물은 유료)", "https://perenual.com/docs/api")}
    ${row("kindwise", "Kindwise plant.health", "사진으로 병해 찾기, 처음 100크레딧 무료", "https://admin.kindwise.com/signup")}
    ${row("claude", "Claude (Anthropic)", "새 식물 일정 제안, 상태 묻기. 사용한 만큼 요금", "https://console.anthropic.com/")}
  </div>`;
}
function bindKeys() {
  for (const inp of document.querySelectorAll("[data-key]")) inp.onchange = () => { setKey(inp.dataset.key, inp.value.trim()); toast(inp.value.trim() ? "키를 저장했습니다" : "키를 지웠습니다"); };
}
