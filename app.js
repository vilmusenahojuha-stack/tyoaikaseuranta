/* =========================================================
  TyöaikaSeuranta - app.js (päivitetty)
  Muutokset:
  - PIN OK -> suoraan Työaika (viewMenu ohitetaan)
  - Varmistusdialogi (modal): ALOITA / TAUKO-JATKA / LOPETA / TANKKAUS
  - 1s välein vain live-laskenta (ei historiaa joka sekunti)
  - Turva: käynnissä oleva työ on käyttäjäkohtainen (lukitsee napit jos eri user)
========================================================= */

(() => {
  // ---------- CONFIG ----------
  const USERS = ["Juha", "Matti", "Janne", "Tommi"];
  const PIN = "1122";

  
  // Hardcoded endpoints
  const HARD_SHEETS_URL = "";
  const HARD_FUEL_URL = "https://vilmusenahojuha-stack.github.io/Tankkaus/";

const STORAGE = {
    session: "ta_session_v1",
    cfg: "ta_cfg_v1",
    running: "ta_running_v1",
    history: "ta_history_v1",
  };

  const DEFAULT_CFG = {
  sheetsUrl: "https://script.google.com/macros/s/AKfycbzrkZq5yOUCXspBLfiOzGh-5f8nf1enThMilrFyuiHXDAFsZ1ljn9oVXPczBQI_22cwoQ/exec",
  fuelUrl: "https://vilmusenahojuha-stack.github.io/Tankkaus/",
  plates: [],
};

  // ---------- DOM HELPERS ----------
  function normalizePlate(s){
  return String(s||"").trim().toUpperCase();
}

function renderPlates(){
  const sel = $("plateSelect");
  if (!sel) return;

  const cur = sel.value;
  sel.innerHTML = `<option value="">Valitse rekisteri…</option>`;

  for (const p of (cfg.plates || [])) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = p;
    sel.appendChild(o);
  }

  if ((cfg.plates || []).includes(cur)) sel.value = cur;
}
  const $ = (id) => document.getElementById(id);
  const toastEl = $("toast");

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.style.display = "block";
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => (toastEl.style.display = "none"), 2400);
  }

  function showView(viewId) {
    const ids = ["viewLogin", "viewPin", "viewMenu", "viewWork", "viewSettings"];
    ids.forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.style.display = id === viewId ? "block" : "none";
    });
  }

  function showModal(modalId, show) {
    const el = $(modalId);
    if (!el) return;
    el.style.display = show ? "flex" : "none";
  }

  function Sget(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  function Sset(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  // ---------- STATE ----------
  let cfg = Sget(STORAGE.cfg, DEFAULT_CFG);
  let session = Sget(STORAGE.session, { user: "", authed: false });
  let running = Sget(STORAGE.running, null);   // current running day
  let history = Sget(STORAGE.history, []);     // approved rows

  // running structure:
  // {
  //   id, user, startTs,
  //   breakSegments:[{s,e?}],
  //   perDiem:0|1|2,
  //   state:"running"|"break"
  // }

  // ---------- TIME HELPERS ----------
  function normalizePlate(s){ return String(s||"").trim().toUpperCase(); }
function getSelectedPlate(){ return normalizePlate($("plateSelect")?.value || ""); }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function toLocalDateStr(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  }
  function toLocalTimeStr(ts) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function minutesToHHMM(min) {
    min = Math.max(0, Math.round(min));
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${pad2(h)}:${pad2(m)}`;
  }
  
  // Minutes -> decimal hours string (60min=1, 90min=1.5)
  function minutesToHoursDec(min, decimals = 2) {
    const h = Math.max(0, Number(min) || 0) / 60;
    // round to decimals
    const factor = Math.pow(10, decimals);
    const rounded = Math.round(h * factor) / factor;
    // strip trailing zeros
    let s = String(rounded.toFixed(decimals));
    s = s.replace(/\.0+$/,"").replace(/(\.\d*[1-9])0+$/,"$1");
    return s;
  }
  
  function clampInt(x, min, max) {
    x = Number(x);
    if (!Number.isFinite(x)) x = min;
    return Math.min(max, Math.max(min, Math.round(x)));
  }

  function parseTimeToTsSameDay(baseDateTs, hhmm) {
    const d = new Date(baseDateTs);
    const [hh, mm] = (hhmm || "00:00").split(":").map(Number);
    d.setHours(hh || 0, mm || 0, 0, 0);
    return d.getTime();
  }

  // If end time is "earlier" than start time, treat as next day
  function ensureEndAfterStart(startTs, endTsCandidate) {
    if (endTsCandidate >= startTs) return endTsCandidate;
    return endTsCandidate + 24 * 60 * 60 * 1000;
  }

  // ---------- P / I / Y segmentation ----------
  // P = 06:00–18:00
  // I = 18:00–22:00
  // Y = 22:00–06:00
  function segmentTypeForDate(d) {
    const t = d.getHours() * 60 + d.getMinutes();
    if (t >= 6*60 && t < 18*60) return "day";
    if (t >= 18*60 && t < 22*60) return "eve";
    return "night";
  }

  function nextBoundaryTs(ts) {
    const d = new Date(ts);
    const y = d.getFullYear(), mo = d.getMonth(), da = d.getDate();
    const mins = d.getHours() * 60 + d.getMinutes();

    const make = (hour, minute, addDays=0) => new Date(y, mo, da + addDays, hour, minute, 0, 0).getTime();

    const b0600 = make(6,0,0);
    const b1800 = make(18,0,0);
    const b2200 = make(22,0,0);

    if (mins < 6*60) return b0600;
    if (mins < 18*60) return b1800;
    if (mins < 22*60) return b2200;
    return make(6,0,1);
  }

  function splitPIY(startTs, endTs) {
    let cur = startTs;
    const out = { day: 0, eve: 0, night: 0 };

    while (cur < endTs) {
      const type = segmentTypeForDate(new Date(cur));
      const nb = Math.min(nextBoundaryTs(cur), endTs);
      out[type] += (nb - cur) / 60000;
      cur = nb;
    }

    out.day = Math.round(out.day);
    out.eve = Math.round(out.eve);
    out.night = Math.round(out.night);
    return out;
  }

  function sumBreakMinutes(breakSegments, nowTs) {
    let total = 0;
    for (const b of breakSegments || []) {
      if (b.s && b.e) total += (b.e - b.s) / 60000;
      else if (b.s && !b.e) total += (nowTs - b.s) / 60000;
    }
    return Math.max(0, Math.round(total));
  }

  function computeDeduct(breakTotalMin) {
    return Math.max(0, breakTotalMin - 30);
  }

  function allocateDeduct(rawSeg, deductMin) {
    const day = rawSeg.day, eve = rawSeg.eve, night = rawSeg.night;
    const rawTotal = day + eve + night;
    if (rawTotal <= 0 || deductMin <= 0) return { dDay: 0, dEve: 0, dNight: 0 };

    let dDay = Math.floor(deductMin * (day / rawTotal));
    let dEve = Math.floor(deductMin * (eve / rawTotal));
    let dNight = Math.floor(deductMin * (night / rawTotal));
    let used = dDay + dEve + dNight;
    let rem = deductMin - used;

    const arr = [
      { k: "day", v: day },
      { k: "eve", v: eve },
      { k: "night", v: night },
    ].sort((a,b) => b.v - a.v);

    let i = 0;
    while (rem > 0 && i < 50) {
      const k = arr[i % arr.length].k;
      if (k === "day") dDay++;
      else if (k === "eve") dEve++;
      else dNight++;
      rem--;
      i++;
    }

    dDay = Math.min(dDay, day);
    dEve = Math.min(dEve, eve);
    dNight = Math.min(dNight, night);

    let shortage = deductMin - (dDay + dEve + dNight);
    if (shortage > 0) {
      const caps = [
        { k: "day", cap: day - dDay },
        { k: "eve", cap: eve - dEve },
        { k: "night", cap: night - dNight },
      ].sort((a,b) => b.cap - a.cap);

      for (const c of caps) {
        if (shortage <= 0) break;
        const add = Math.min(shortage, Math.max(0, c.cap));
        if (c.k === "day") dDay += add;
        if (c.k === "eve") dEve += add;
        if (c.k === "night") dNight += add;
        shortage -= add;
      }
    }

    return { dDay, dEve, dNight };
  }

  // ---------- SHEETS ----------
  // ---------- SHEETS: helpers ----------
async function sheetsPost(payload) {
  const url = (HARD_SHEETS_URL || (cfg?.sheetsUrl || "")).trim();
  if (!url) throw new Error("Sheets URL puuttuu (cfg.sheetsUrl).");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });

  const txt = await res.text();
  let data = null;
  try { data = JSON.parse(txt); } catch {}

  if (!res.ok || !data || data.ok !== true) {
    const msg = (data && (data.error || data.message)) ? (data.error || data.message) : txt;
    throw new Error(`Sheets virhe: ${String(msg).slice(0, 220)}`);
  }
  return data;
}

// Map Sheets-row -> app history entry (pidetään samat avaimet mitä list palauttaa)
function normalizeRow(r) {
  // Varmistus + defaultit, ettei render hajoa puuttuviin kenttiin
  return {
    user: r.user || "",
    plate: r.plate || "",
    startDate: r.startDate || "",
    startTime: r.startTime || "",
    endDate: r.endDate || "",
    endTime: r.endTime || "",
    breakTotalMin: Number(r.breakTotalMin || 0),
    breakDeductMin: Number(r.breakDeductMin || 0),
    dayMin: Number(r.dayMin || 0) || Math.round(Number(r.dayH || 0) * 60),
    eveMin: Number(r.eveMin || 0) || Math.round(Number(r.eveH || 0) * 60),
    nightMin: Number(r.nightMin || 0) || Math.round(Number(r.nightH || 0) * 60),
    totalMin: Number(r.totalMin || 0) || Math.round(Number(r.totalH || 0) * 60),
    perDiem: Number(r.perDiem || 0),
    approved: Boolean(r.approved),
    timestamp: r.timestamp || "",
    // paikallinen apukenttä (ei pakko käyttää)
    sent: true,
  };
}

// ---------- HISTORY: fetch from Sheets ----------
async function fetchHistoryFromSheets(user) {
  if (!user) return [];

  const data = await sheetsPost({
    action: "list",
    user: user
  });

  const rows = Array.isArray(data.rows) ? data.rows : [];

  // Normalisoidaan rivit UI:lle
  return rows.map(r => ({
    user: r.user || "",
    plate: r.plate || "",
    startDate: r.startDate || "",
    startTime: r.startTime || "",
    endDate: r.endDate || "",
    endTime: r.endTime || "",
    breakTotalMin: Number(r.breakTotalMin || 0),
    breakDeductMin: Number(r.breakDeductMin || 0),
    dayMin: Number(r.dayMin || 0) || Math.round(Number(r.dayH || 0) * 60),
    eveMin: Number(r.eveMin || 0) || Math.round(Number(r.eveH || 0) * 60),
    nightMin: Number(r.nightMin || 0) || Math.round(Number(r.nightH || 0) * 60),
    totalMin: Number(r.totalMin || 0) || Math.round(Number(r.totalH || 0) * 60),
    perDiem: Number(r.perDiem || 0),
    approved: Boolean(r.approved),
    timestamp: r.timestamp || "",
    sent: true
  }));
}

// ---------- HISTORY: always from Sheets ----------
async function refreshHistoryFromSheets() {
  const user = session?.user;
  if (!user) return;

  try {
    const rows = await fetchHistoryFromSheets(user);

    history = rows;
    Sset(`ta_history_cache_${user}`, history);

    renderAll({ full: true });

  } catch (err) {
    const cached = Sget(`ta_history_cache_${user}`, null);
    if (cached) {
      history = cached;
      renderAll({ full: true });
      toast("Offline-tila: näytetään viimeisin tallennettu historia.");
    } else {
      history = [];
      renderAll({ full: true });
      toast("Historiaa ei saatu ladattua.");
    }
  }
}
  async function postSheets(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const txt = await res.text();
    let data = null;
    try { data = JSON.parse(txt); } catch {}
    return { ok: res.ok && data && data.ok === true, resOk: res.ok, data, text: txt };
  }

  function entryToSheetRow(e) {
    return {
      user: e.user,
      plate: e.plate || "",
      startDate: e.startDate,
      startTime: e.startTime,
      endDate: e.endDate,
      endTime: e.endTime,
      breakTotalMin: e.breakTotalMin,
      breakDeductMin: e.breakDeductMin,
      dayH: Number((e.dayMin || 0) / 60),
      eveH: Number((e.eveMin || 0) / 60),
      nightH: Number((e.nightMin || 0) / 60),
      totalH: Number((e.totalMin || 0) / 60),
      perDiem: e.perDiem,
      approved: true,
      timestamp: new Date(e.approvedTs).toISOString(),
    };
  }

 async function trySendEntryToSheets(entry) {
  const url = (HARD_SHEETS_URL || (cfg.sheetsUrl || "")).trim();
  if (!url) {
    entry.sent = false;
    entry.sentErr = "Sheets URL puuttuu";
    persist();
    return false;
  }

  try {
    const r = await postSheets(url, {
      action: "append",
      rows: [entryToSheetRow(entry)],
    });

    const ok = (r && r.ok === true);
    if (!ok) {
      const msg = (r?.data?.error) ? String(r.data.error) : "Sheets-vastaus ei kelpaa";
      throw new Error(msg);
    }

    entry.sent = true;
    entry.sentErr = "";
    persist();

    // tärkein: aina päivitetään historia Sheetistä (tämä renderöi)
    await refreshHistoryFromSheets();

    return true;

  } catch (err) {
    entry.sent = false;
    entry.sentErr = String(err?.message || err);
    persist();

    // virhetilassa näytä paikallinen tila (ei refresh)
    renderAll({ full: true });
    return false;
  }
}

  async function syncUnsent() {
    const url = (HARD_SHEETS_URL || (cfg.sheetsUrl || "")).trim();
    const unsent = history.filter(h => h.approved && h.sent !== true);
    if (!unsent.length) return toast("Ei lähettämättömiä.");
    if (!url) return toast(`Sheets URL puuttuu. Jonossa ${unsent.length}.`);

    const payload = { action: "append", rows: unsent.map(entryToSheetRow) };

    toast(`Lähetetään ${unsent.length} kpl...`);
    try {
      const r = await postSheets(url, payload);
      if (r.ok) {
        const now = Date.now();
        for (const e of unsent) {
          e.sent = true;
          e.sentAt = now;
          e.sentErr = "";
        }
        persist();
        renderAll({ full: true });
        toast("Lähetys onnistui ✔");
      } else {
        toast("Lähetys epäonnistui ✖");
      }
    } catch (err) {
      toast(`Virhe: ${String(err && err.message ? err.message : err)}`);
    }
  }

  async function testSheets() {
    const url = (HARD_SHEETS_URL || ($("sheetsUrl")?.value || "")).trim();
    if (!url) return toast("Lisää /exec URL ensin.");
    toast("Testataan...");
    try {
      const r = await postSheets(url, { action: "ping" });
      toast(r.ok ? "Sheets OK ✔" : "Sheets ei vastaa oikein ✖");
    } catch {
      toast("Testi epäonnistui ✖");
    }
  }

  // ---------- CONFIRM MODAL (auto-injected) ----------
  function ensureConfirmModal() {
    if ($("modalConfirm")) return;

    const wrap = document.createElement("div");
    wrap.className = "modal";
    wrap.id = "modalConfirm";
    wrap.style.display = "none";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");

    wrap.innerHTML = `
      <div class="modalSheet">
        <div class="modalHead">
          <div>
            <div class="h2" id="confTitle">Varmistus</div>
            <div class="muted" id="confText"></div>
          </div>
          <button class="btn btn-ghost" id="confClose">✕</button>
        </div>
        <div class="btnbar">
          <button class="btn btn-ghost" id="confCancel">Peruuta</button>
          <button class="btn btn-blue" id="confOk">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
  }

  function confirmModal(text, okLabel = "OK") {
    ensureConfirmModal();
    return new Promise((resolve) => {
      const modal = $("modalConfirm");
      const t = $("confText");
      const ok = $("confOk");
      const cancel = $("confCancel");
      const close = $("confClose");

      if (t) t.textContent = text || "";
      if (ok) ok.textContent = okLabel || "OK";

      const cleanup = () => {
        ok?.removeEventListener("click", onOk);
        cancel?.removeEventListener("click", onCancel);
        close?.removeEventListener("click", onCancel);
      };

      const onOk = () => {
        cleanup();
        showModal("modalConfirm", false);
        resolve(true);
      };
      const onCancel = () => {
        cleanup();
        showModal("modalConfirm", false);
        resolve(false);
      };

      ok?.addEventListener("click", onOk);
      cancel?.addEventListener("click", onCancel);
      close?.addEventListener("click", onCancel);

      showModal("modalConfirm", true);
    });
  }

  // ---------- PERSIST / RENDER ----------
  function renderForeignRunningLock() {
  const box = document.getElementById("foreignRunningBox");
  const name = document.getElementById("foreignRunningUser");
  if (!box || !name) return;

  if (running && session.user && running.user !== session.user) {
    name.textContent = running.user;
    box.style.display = "block";
  } else {
    box.style.display = "none";
  }
}
  function persist() {
    Sset(STORAGE.cfg, cfg);
    Sset(STORAGE.session, session);
    Sset(STORAGE.running, running);
    Sset(STORAGE.history, history);
  }

  function setSubtitle() {
    const el = $("subtitle");
    if (!el) return;
    el.textContent = (session.authed && session.user) ? `Käyttäjä: ${session.user}` : "";
    const btn = $("btnLogout");
    if (btn) btn.style.display = session.authed ? "inline-block" : "none";
  }

  function updateUnsentCount() {
    const el = $("unsentCount");
    if (!el) return;
    const n = history.filter(h => h.approved && h.sent !== true).length;
    el.textContent = n ? `Jonossa: ${n}` : "";
  }

  function setPerDiemUI(val) {
    const buttons = document.querySelectorAll("#perDiemSeg .segbtn");
    buttons.forEach(b => b.classList.toggle("active", String(val) === String(b.dataset.perdiem)));
  }

  function perDiemText(v){
    if (String(v) === "1") return "Puoli";
    if (String(v) === "2") return "Koko";
    return "Ei";
  }

  function renderHistory() {
    const list = $("historyList");
    const hint = $("historyHint");
    if (!list) return;

    const arr = [...history].sort((a,b) =>
  new Date(b.timestamp || 0) - new Date(a.timestamp || 0)
);

    list.innerHTML = "";
    if (!arr.length) {
      list.innerHTML = `<div class="muted">Ei vielä merkintöjä.</div>`;
      if (hint) hint.textContent = "";
      return;
    }

    if (hint) hint.textContent = `${arr.length} kpl`;

    for (const e of arr) {
      const status = e.sent === true ? "ok" : "err";
      const statusChar = e.sent === true ? "✔" : "✖";
      const timeLine = `${e.startDate} ${e.startTime} → ${e.endDate} ${e.endTime}`;
      const plateTxt = e.plate ? `Auto: ${e.plate} | ` : "";
	const sub = `${plateTxt}
Työaika: ${minutesToHoursDec(e.totalMin)} h | 
Päivä: ${minutesToHoursDec(e.dayMin)} h | 
Ilta: ${minutesToHoursDec(e.eveMin)} h | 
Yö: ${minutesToHoursDec(e.nightMin)} h | 
Tauko: ${e.breakTotalMin} min (vähennys ${e.breakDeductMin} min) | 
Päiväraha: ${perDiemText(e.perDiem)}`;

      const div = document.createElement("div");
      div.className = "hist lock";
      div.innerHTML = `
        <div class="status ${status}" title="${e.sent === true ? "Lähetetty" : (e.sentErr || "Ei lähetetty")}">${statusChar}</div>
        <div class="meta">
          <div class="time"><b>${e.user}</b> — ${minutesToHoursDec(e.totalMin)}</div>
          <div class="sub">${timeLine}</div>
          <div class="sub">${sub}</div>
        </div>
      `;
      list.appendChild(div);
    }
  }

  function renderLive() {
    const now = Date.now();

    // totals from history
    const histTotal = history.reduce((sum, e) => sum + (e.totalMin || 0), 0);

    let todayMin = 0;
    let breakMin = 0;
    let deductMin = 0;

    if (running && running.startTs) {
      const endTs = now;
      const rawSeg = splitPIY(running.startTs, endTs);
      const breakTotalMin = sumBreakMinutes(running.breakSegments || [], endTs);
      const deduct = computeDeduct(breakTotalMin);
      const alloc = allocateDeduct(rawSeg, deduct);
      const adjSeg = {
        day: Math.max(0, rawSeg.day - alloc.dDay),
        eve: Math.max(0, rawSeg.eve - alloc.dEve),
        night: Math.max(0, rawSeg.night - alloc.dNight),
      };
      todayMin = adjSeg.day + adjSeg.eve + adjSeg.night;
      breakMin = breakTotalMin;
      deductMin = deduct;
    }

    $("liveToday").textContent = minutesToHoursDec(todayMin);
    $("liveAll").textContent = minutesToHoursDec(histTotal + todayMin);
    $("liveBreak").textContent = String(breakMin);
    $("liveDeduct").textContent = String(deductMin);

    // button states + user lock
    const btnStart = $("btnStart");
    const btnBreak = $("btnBreak");
    const btnStop = $("btnStop");

    if (!btnStart || !btnBreak || !btnStop) return;

    const hasRunning = !!running;
    const runningBelongsToUser = !hasRunning || (running.user === session.user);

    // default states
    btnStart.disabled = hasRunning;
    btnStop.disabled = !hasRunning;
    btnBreak.disabled = !hasRunning;

    if (!hasRunning) {
      btnBreak.textContent = "TAUKO";
    } else {
      btnBreak.textContent = (running.state === "break") ? "JATKA" : "TAUKO";
    }

    // lock if different user
    if (hasRunning && !runningBelongsToUser) {
      btnStart.disabled = true;
      btnBreak.disabled = true;
      btnStop.disabled = true;
      // (Ei lisätä uutta elementtiä HTML:ään — pidetään yksinkertaisena)
    }

    setPerDiemUI(hasRunning ? running.perDiem : 0);
  }

  function renderAll({ full } = { full: false }) {
    setSubtitle();
    updateUnsentCount();
    renderLive();
    if (full) renderHistory();
	renderForeignRunningLock();
  }

  // ---------- AUTH FLOW ----------
  function goLogin() {
    session = { user: "", authed: false };
    persist();
    setSubtitle();
    showView("viewLogin");
  }

  function goPin(user) {
    session.user = user;
    session.authed = false;
    persist();
    $("pinUser").textContent = user;
    $("pinInput").value = "";
    $("pinNote").textContent = "";
    showView("viewPin");
    setSubtitle();
    setTimeout(() => $("pinInput").focus(), 50);
  }

  async function goWork() {
  if (!session || !session.user) return;

  showView("viewWork");

  // Tyhjennä historia ensin, ettei näy vanha data hetken
  history = [];
  renderAll({ full: true });

  await refreshHistoryFromSheets();
}

  function goSettings() {
    showView("viewSettings");
    $("sheetsUrl").value = cfg.sheetsUrl || "";
    $("fuelUrl").value = cfg.fuelUrl || "";
    $("settingsNote").textContent = "";
    updateUnsentCount();
  }

  // ---------- WORK ACTIONS ----------
  async function startWork() {
    if (!session.authed || !session.user) return toast("Kirjaudu sisään.");
    if (running) return toast("Työ on jo käynnissä.");

    const ok = await confirmModal("Aloitetaanko työ nyt?", "ALOITA");
    if (!ok) return;

    const now = Date.now();
    running = {
      id: `run_${now}_${Math.random().toString(16).slice(2)}`,
      user: session.user,
      startTs: now,
      breakSegments: [],
      perDiem: 0,
      state: "running",
    };
    persist();
    toast("Työ aloitettu.");
    renderAll({ full: true });
  }

  async function toggleBreak() {
    if (!running) return;
    if (running.user !== session.user) return toast(`Käynnissä oleva työ kuuluu käyttäjälle ${running.user}.`);

    const label = (running.state === "break") ? "JATKA" : "TAUKO";
    const ok = await confirmModal(`${label} nyt?`, label);
    if (!ok) return;

    const now = Date.now();
    if (running.state === "running") {
      running.state = "break";
      running.breakSegments.push({ s: now });
      persist();
      toast("Tauko alkoi.");
    } else {
      running.state = "running";
      const last = running.breakSegments[running.breakSegments.length - 1];
      if (last && last.s && !last.e) last.e = now;
      persist();
      toast("Tauko päättyi.");
    }
    renderAll({ full: false });
  }

  function setPerDiem(val) {
    val = clampInt(val, 0, 2);
    if (running) {
      if (running.user !== session.user) return toast(`Käynnissä oleva työ kuuluu käyttäjälle ${running.user}.`);
      running.perDiem = val;
      persist();
      renderAll({ full: false });
    } else {
      toast("Päiväraha valitaan työpäivälle (aloita työ ensin) tai manuaalisessa lisäyksessä.");
    }
  }

  // ---------- SUMMARY MODAL (STOP / APPROVE) ----------
  let pendingSummary = null;

  function openSummaryFromRunningStop() {
    if (!running) return;
    if (running.user !== session.user) return toast(`Käynnissä oleva työ kuuluu käyttäjälle ${running.user}.`);

    const now = Date.now();

    if (running.state === "break") {
      const last = running.breakSegments[running.breakSegments.length - 1];
      if (last && last.s && !last.e) last.e = now;
      running.state = "running";
    }

    const startTs = running.startTs;
    const endTs = now;
    const breakTotalMin = sumBreakMinutes(running.breakSegments || [], endTs);

    pendingSummary = {
      mode: "stop",
      user: running.user,
      baseDateTs: startTs,
      startTs,
      endTs,
      breakTotalMin,
      perDiem: running.perDiem || 0,
    };

    fillSummaryUI();
    showModal("modalSummary", true);
  }

  function fillSummaryUI() {
    if (!pendingSummary) return;

    $("sumUser").value = pendingSummary.user;
    $("sumStartDate").value = toLocalDateStr(pendingSummary.startTs);

    $("sumStartTime").value = toLocalTimeStr(pendingSummary.startTs);
    $("sumEndTime").value = toLocalTimeStr(pendingSummary.endTs);

    $("sumBreakTotal").value = String(Math.max(0, Math.round(pendingSummary.breakTotalMin)));
    $("sumPerDiem").value = String(pendingSummary.perDiem);

    $("sumSub").textContent = pendingSummary.mode === "stop" ? "Tarkista ja hyväksy" : "Manuaalinen päivä – tarkista ja hyväksy";

    recalcSummaryPanel();
  }

  function recalcSummaryPanel() {
    if (!pendingSummary) return;

    const startTime = ($("sumStartTime").value || "00:00");
    const endTime = ($("sumEndTime").value || "00:00");
    const base = new Date(pendingSummary.startTs);
    base.setHours(0,0,0,0);
    const baseDayTs = base.getTime();

    let startTs = parseTimeToTsSameDay(baseDayTs, startTime);
    let endTs = parseTimeToTsSameDay(baseDayTs, endTime);
    endTs = ensureEndAfterStart(startTs, endTs);

    const breakTotalMin = clampInt($("sumBreakTotal").value, 0, 24*60);

    const rawSeg = splitPIY(startTs, endTs);
    const deductMin = computeDeduct(breakTotalMin);
    const alloc = allocateDeduct(rawSeg, deductMin);
    const adjSeg = {
      day: Math.max(0, rawSeg.day - alloc.dDay),
      eve: Math.max(0, rawSeg.eve - alloc.dEve),
      night: Math.max(0, rawSeg.night - alloc.dNight),
    };
    const totalMin = adjSeg.day + adjSeg.eve + adjSeg.night;

    $("sumDeduct").textContent = String(deductMin);
    $("sumTotal").textContent = minutesToHoursDec(totalMin);
    $("sumDay").textContent = minutesToHoursDec(adjSeg.day);
    $("sumEve").textContent = minutesToHoursDec(adjSeg.eve);
    $("sumNight").textContent = minutesToHoursDec(adjSeg.night);
  }

  function closeSummary() {
    pendingSummary = null;
    showModal("modalSummary", false);
  }

  async function approveSummary() {
    if (!pendingSummary) return;

    const startTime = ($("sumStartTime").value || "00:00");
    const endTime = ($("sumEndTime").value || "00:00");
    const breakTotalMin = clampInt($("sumBreakTotal").value, 0, 24*60);
    const perDiem = clampInt($("sumPerDiem").value, 0, 2);

    const base = new Date(pendingSummary.startTs);
    base.setHours(0,0,0,0);
    const baseDayTs = base.getTime();

    let startTs = parseTimeToTsSameDay(baseDayTs, startTime);
    let endTs = parseTimeToTsSameDay(baseDayTs, endTime);
    endTs = ensureEndAfterStart(startTs, endTs);

    const rawSeg = splitPIY(startTs, endTs);
    const deductMin = computeDeduct(breakTotalMin);
    const alloc = allocateDeduct(rawSeg, deductMin);
    const adjSeg = {
      day: Math.max(0, rawSeg.day - alloc.dDay),
      eve: Math.max(0, rawSeg.eve - alloc.dEve),
      night: Math.max(0, rawSeg.night - alloc.dNight),
    };
    const totalMin = adjSeg.day + adjSeg.eve + adjSeg.night;

    const entry = {
      id: `day_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      user: pendingSummary.user,
      startTs,
      endTs,
      startDate: toLocalDateStr(startTs),
      startTime: startTime,
      endDate: toLocalDateStr(endTs),
      endTime: toLocalTimeStr(endTs),
      breakTotalMin,
      breakDeductMin: deductMin,
      dayMin: adjSeg.day,
      eveMin: adjSeg.eve,
      nightMin: adjSeg.night,
      totalMin,
      perDiem,
      approved: true,
      approvedTs: Date.now(),
      sent: false,
	  plate: getSelectedPlate(),
      sentAt: null,
      sentErr: "",
    };

    history.push(entry);

    if (pendingSummary.mode === "stop") {
      running = null;
    }

    persist();
    closeSummary();
    toast("Tallennettu. Lähetetään Sheetiin...");

    await trySendEntryToSheets(entry);
    toast(entry.sent ? "Sheets: OK ✔" : "Sheets: epäonnistui ✖");
  }

  // ---------- MANUAL DAY ----------
  function openManual() {
    if (!session.authed || !session.user) return toast("Kirjaudu sisään.");

    const d = new Date();
    $("manDate").value = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
    $("manStart").value = "08:00";
    $("manEnd").value = "16:00";
    $("manBreak").value = "0";
    $("manPerDiem").value = "0";
    showModal("modalManual", true);
  }

  function closeManual() {
    showModal("modalManual", false);
  }

  function manualToSummary() {
    const dateStr = ($("manDate").value || "").trim();
    if (!dateStr) return toast("Valitse päivämäärä.");

    const startTime = $("manStart").value || "00:00";
    const endTime = $("manEnd").value || "00:00";
    const breakTotalMin = clampInt($("manBreak").value, 0, 24*60);
    const perDiem = clampInt($("manPerDiem").value, 0, 2);

    const [Y,M,D] = dateStr.split("-").map(Number);
    const base = new Date(Y, (M||1)-1, D||1, 0,0,0,0);
    const baseDayTs = base.getTime();

    let startTs = parseTimeToTsSameDay(baseDayTs, startTime);
    let endTs = parseTimeToTsSameDay(baseDayTs, endTime);
    endTs = ensureEndAfterStart(startTs, endTs);

    pendingSummary = {
      mode: "manual",
      user: session.user,
      baseDateTs: baseDayTs,
      startTs,
      endTs,
      breakTotalMin,
      perDiem,
    };

    closeManual();
    fillSummaryUI();
    showModal("modalSummary", true);
  }

  // ---------- EVENTS ----------
function bindEvents() {

  // User buttons
  document.querySelectorAll(".btn-user").forEach((b) => {
    b.addEventListener("click", () => {
      const user = b.dataset.user;
      if (!USERS.includes(user)) return;
      goPin(user);
    });
  });

  //	Clear foreign running (if another user has an active day)
  document.getElementById("btnClearForeignRunning")?.addEventListener("click", async () => {
    if (!running) return;

    const ok = await confirmModal(
      `Poistetaanko käynnissä oleva työ?\n\nKäyttäjä: ${running.user}\nAloitettu: ${new Date(running.startTs).toLocaleString()}`,
      "POISTA"
    );
    if (!ok) return;

    running = null;
    localStorage.removeItem("ta_running_v1");
    persist();
    toast("Käynnissä oleva työ poistettu.");
    renderAll({ full: true });
  });

    // PIN
    $("btnPinBack")?.addEventListener("click", () => showView("viewLogin"));
    $("btnPinOk")?.addEventListener("click", () => {
      const pin = ($("pinInput").value || "").trim();
      if (pin === PIN) {
        session.authed = true;
        persist();
        $("pinNote").textContent = "";
        toast("OK");
        goWork(); // <-- SUORAAN TYÖAIKAAN
      } else {
        $("pinNote").textContent = "Väärä PIN.";
        toast("Väärä PIN");
      }
      setSubtitle();
    });
    $("pinInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("btnPinOk")?.click();
    });

    // (Menu on yhä HTML:ssä, mutta voidaan pitää varalla)
    $("btnGoWork")?.addEventListener("click", goWork);
    $("btnGoSettings")?.addEventListener("click", goSettings);
    $("btnSwitchUser")?.addEventListener("click", goLogin);

    // Tankkaus: jos myöhemmin lisäät Work-näkymään nappiin id="btnFuel", tämä tukee sitä.
    const fuelHandler = async () => {
      const url = (HARD_FUEL_URL || (cfg.fuelUrl || "")).trim();
      if (!url) return toast("Fuel-URL puuttuu (Asetuksissa).");
      const ok = await confirmModal("Avataanko Tankkaus?", "TANKKAUS");
      if (!ok) return;
      window.location.href = url;
    };
    $("btnGoFuel")?.addEventListener("click", fuelHandler);
    $("btnFuel")?.addEventListener("click", fuelHandler);

    // Logout
    $("btnLogout")?.addEventListener("click", goLogin);

    // Work actions
	// Plates: täytä lista kerran kun eventit bindataan
renderPlates();

// Kun valinta vaihtuu, päivitä käynnissä olevalle päivälle
$("plateSelect")?.addEventListener("change", () => {
  if (!running || running.user !== session.user) return;
  running.plate = getSelectedPlate();
  persist();
});

// Lisää uusi rekisteri
$("btnAddPlate")?.addEventListener("click", () => {
  const raw = prompt("Uusi rekisterinumero (esim ABC-123):");
  const p = normalizePlate(raw);
  if (!p) return;

  if (!cfg.plates) cfg.plates = [];
  if (!cfg.plates.includes(p)) cfg.plates.push(p);

  cfg.plates.sort();
  persist();
  renderPlates();

  // valitse heti lisätty
  const sel = $("plateSelect");
  if (sel) sel.value = p;

  // jos työ käynnissä, päivitä siihenkin
  if (running && running.user === session.user) {
    running.plate = p;
    persist();
  }

  toast("Rekisterinumero lisätty.");
});
    $("btnBackMenu")?.addEventListener("click", goSettings); // menu pois -> mennään asetuksiin
    $("btnStart")?.addEventListener("click", async () => {
  // tallennetaan valittu rekisteri suoraan runningiin kun työ alkaa
  await startWork();
  if (running && running.user === session.user) {
    running.plate = getSelectedPlate();
    persist();
    renderAll({ full: false });
  }
});
    $("btnBreak")?.addEventListener("click", toggleBreak);
    $("btnStop")?.addEventListener("click", async () => {
      if (!running) return;
      if (running.user !== session.user) return toast(`Käynnissä oleva työ kuuluu käyttäjälle ${running.user}.`);
      const ok = await confirmModal("Lopetetaanko työ ja avataan koonti?", "LOPETA");
      if (!ok) return;
      openSummaryFromRunningStop();
    });

    // Per diem segment
    document.querySelectorAll("#perDiemSeg .segbtn").forEach((b) => {
      b.addEventListener("click", () => setPerDiem(b.dataset.perdiem));
    });

    // Manual
    $("btnManualDay")?.addEventListener("click", openManual);
    $("manCancel")?.addEventListener("click", closeManual);
    $("manClose")?.addEventListener("click", closeManual);
    $("manNext")?.addEventListener("click", manualToSummary);

    // Summary modal
    $("sumClose")?.addEventListener("click", closeSummary);
    $("sumCancel")?.addEventListener("click", closeSummary);
    $("sumApprove")?.addEventListener("click", approveSummary);
    ["sumStartTime","sumEndTime","sumBreakTotal","sumPerDiem"].forEach(id => {
      $(id)?.addEventListener("input", recalcSummaryPanel);
      $(id)?.addEventListener("change", recalcSummaryPanel);
    });

    // Settings
    $("btnBackMenu2")?.addEventListener("click", goWork);
    $("btnSaveSettings")?.addEventListener("click", () => {
      cfg.sheetsUrl = ($("sheetsUrl").value || "").trim();
      cfg.fuelUrl = ($("fuelUrl").value || "").trim();
      persist();
      $("settingsNote").textContent = "Tallennettu.";
      toast("Tallennettu");
      updateUnsentCount();
    });
    $("btnTestSheets")?.addEventListener("click", testSheets);
    $("btnSyncUnsent")?.addEventListener("click", syncUnsent);
  }

  // ---------- INIT ----------
  function init() {
    if (!Array.isArray(history)) history = [];
    if (running && !Array.isArray(running.breakSegments)) running.breakSegments = [];

    bindEvents();
    setSubtitle();

    // Boot route: jos authed, suoraan workiin (ei menu)
    if (session && session.authed && session.user) {
      goWork();
    } else {
      showView("viewLogin");
    }

    renderAll({ full: true });

    // Live timer (kevyt)
    setInterval(() => renderAll({ full: false }), 1000);
  }

  init();
})();