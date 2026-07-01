// ImmoSnap v2 front-end. Vanilla JS, no framework, no map dependency.
// Perf-first: Phase A (POST /match) returns candidates immediately, unscored;
// Phase B scores stream in via polling GET /match/:snapId/scores. exifr is
// self-hosted and imported lazily (only once a photo is picked), never eagerly.

const cameraInput = document.querySelector("#camera");
const fileInput = document.querySelector("#file");
const dropzone = document.querySelector("#dropzone");
const gpsBadge = document.querySelector("#gps-badge");
const gpsBtn = document.querySelector("#gps-btn");
const manualBtn = document.querySelector("#manual-btn");
const manualForm = document.querySelector("#manual-form");
const manualInput = document.querySelector("#manual-input");
const manualHint = document.querySelector("#manual-hint");
const topSnapBtn = document.querySelector("#top-snap");
const buildStamp = document.querySelector("#build-stamp");

const hero = document.querySelector("#hero");
const result = document.querySelector("#result");
const previewImg = document.querySelector("#preview-img");
const rAgency = document.querySelector("#r-agency");
const rPhone = document.querySelector("#r-phone");
const rTown = document.querySelector("#r-town");
const statusEl = document.querySelector("#status");
const candHead = document.querySelector("#cand-head");
const scoringNote = document.querySelector("#scoring-note");
const candidatesEl = document.querySelector("#candidates");
const candidateTpl = document.querySelector("#candidate-template");
const resetBtn = document.querySelector("#reset");

const tabbar = document.querySelector("#tabbar");
const viewScan = document.querySelector("#view-scan");
const viewHistory = document.querySelector("#view-history");
const historyList = document.querySelector("#history-list");
const historyEmpty = document.querySelector("#history-empty");
const historyCount = document.querySelector("#history-count");
const historyTemplate = document.querySelector("#history-template");
const clearHistoryBtn = document.querySelector("#clear-history");

const lightbox = document.querySelector("#lightbox");
const lightboxImg = document.querySelector("#lightbox-img");

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// ── prominent version + timestamp (FR4) ────────────────────────────────────
fetch("/version")
  .then((r) => r.json())
  .then((v) => {
    const started = new Date(v.startedAt);
    const stamp = `${v.branch} v${v.version}${v.sha ? " · " + v.sha : ""} · up since ${started.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    buildStamp.textContent = stamp;
  })
  .catch(() => { buildStamp.textContent = "build unknown"; });

// ── tabs ────────────────────────────────────────────────────────────────
tabbar.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  for (const t of tabbar.querySelectorAll(".tab")) t.classList.toggle("is-active", t === btn);
  const showHistory = btn.dataset.tab === "history";
  viewScan.hidden = showHistory;
  viewHistory.hidden = !showHistory;
  if (showHistory) renderHistory();
});

function goToScanTab() {
  tabbar.querySelector('[data-tab="scan"]').click();
}

// persistent top snap control: always reachable, from any view/state
topSnapBtn.addEventListener("click", () => {
  goToScanTab();
  hero.hidden = false;
  result.hidden = true;
  cameraInput.click();
});

// ── location: photo EXIF -> device GPS -> manual address ──────────────────
let exifCoords = null, deviceCoords = null, manualCoords = null;
let working = null, workingSource = null;
let lastFile = null;
let pollToken = 0;
let activeSnapId = null;
let confirmedListingUrl = null;

function isValid(c) {
  return !!c && Number.isFinite(c.lat) && Number.isFinite(c.lon) && (c.lat !== 0 || c.lon !== 0);
}

function recomputeWorking() {
  const pick = isValid(manualCoords) ? { c: manualCoords, s: "manual" }
    : isValid(exifCoords) ? { c: exifCoords, s: "photo" }
    : isValid(deviceCoords) ? { c: deviceCoords, s: "device" }
    : null;
  working = pick ? pick.c : null;
  workingSource = pick ? pick.s : null;
}

const SOURCE_LABEL = { photo: "photo EXIF", device: "device GPS", manual: "typed address" };

function updateGpsBadge() {
  if (isValid(working)) {
    gpsBadge.textContent = `📍 ${SOURCE_LABEL[workingSource]}: ${working.lat.toFixed(4)}, ${working.lon.toFixed(4)}`;
    gpsBadge.className = "badge badge-ok";
  } else {
    gpsBadge.textContent = "No location yet";
    gpsBadge.className = "badge badge-muted";
  }
}

function getDeviceGps() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

// exifr is self-hosted (public/vendor/exifr-lite.esm.mjs) and imported lazily,
// on demand, only once a photo is actually picked. Never loaded eagerly.
let exifrPromise = null;
function loadExifr() {
  if (!exifrPromise) exifrPromise = import("./vendor/exifr-lite.esm.mjs");
  return exifrPromise;
}

gpsBtn.addEventListener("click", async () => {
  gpsBadge.textContent = "Getting device GPS…";
  const d = await getDeviceGps();
  if (!d) { gpsBadge.textContent = "Device GPS unavailable/denied"; gpsBadge.className = "badge badge-muted"; return; }
  deviceCoords = d; manualCoords = null;
  recomputeWorking(); updateGpsBadge();
  if (lastFile) runMatch();
});

manualBtn.addEventListener("click", () => {
  manualForm.hidden = !manualForm.hidden;
  if (!manualForm.hidden) manualInput.focus();
});

manualForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = manualInput.value.trim();
  if (!q) return;
  const submitBtn = document.querySelector("#manual-submit");
  submitBtn.disabled = true;
  manualHint.hidden = false;
  manualHint.textContent = "Looking up address…";
  try {
    const res = await fetch("/geocode?q=" + encodeURIComponent(q));
    if (res.status === 404) { manualHint.textContent = "Address not found, try adding the town/postcode."; return; }
    if (!res.ok) throw new Error("geocode " + res.status);
    const d = await res.json();
    manualCoords = { lat: d.lat, lon: d.lon };
    manualHint.hidden = true;
    recomputeWorking(); updateGpsBadge();
    if (lastFile) runMatch();
  } catch {
    manualHint.textContent = "Couldn't look up that address. Check it and try again.";
  } finally {
    submitBtn.disabled = false;
  }
});

// ── capture wiring ──────────────────────────────────────────────────────
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault(); dropzone.classList.remove("drag");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
cameraInput.addEventListener("change", () => { if (cameraInput.files[0]) handleFile(cameraInput.files[0]); });

resetBtn.addEventListener("click", () => {
  pollToken++; // stop any in-flight poll from writing into a torn-down panel
  activeSnapId = null; confirmedListingUrl = null;
  result.hidden = true; hero.hidden = false;
  candidatesEl.innerHTML = ""; candHead.hidden = true; resetBtn.hidden = true;
  fileInput.value = ""; cameraInput.value = "";
  exifCoords = deviceCoords = manualCoords = working = null; workingSource = null;
  manualForm.hidden = true; manualHint.hidden = true; manualInput.value = "";
  updateGpsBadge();
});

async function handleFile(file) {
  lastFile = file;
  hero.hidden = true;
  result.hidden = false;
  resetBtn.hidden = true;
  candidatesEl.innerHTML = "";
  candHead.hidden = true;
  manualForm.hidden = true; manualHint.hidden = true;
  rAgency.textContent = "—"; rPhone.textContent = ""; rTown.textContent = "";
  previewImg.src = URL.createObjectURL(file);

  exifCoords = deviceCoords = manualCoords = null;
  statusEl.className = "status spin";
  statusEl.textContent = "Reading location…";
  try {
    const exifr = await loadExifr();
    const g = await exifr.gps(file);
    if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) {
      exifCoords = { lat: g.latitude, lon: g.longitude };
    }
  } catch { /* no EXIF GPS, fall through */ }

  if (!isValid(exifCoords)) {
    statusEl.textContent = "Getting your location…";
    const d = await getDeviceGps();
    if (d) deviceCoords = d;
  }

  recomputeWorking();
  updateGpsBadge();

  if (!isValid(working)) {
    manualForm.hidden = false;
    manualHint.hidden = false;
    manualHint.textContent = "We couldn't detect a location. Type the property address, or continue without one.";
  }

  runMatch();
}

// ── Phase A + Phase B polling ───────────────────────────────────────────
async function runMatch() {
  if (!lastFile) return;
  const myToken = ++pollToken;
  statusEl.className = "status spin";
  statusEl.textContent = "Reading the sign, resolving the agency…";
  candidatesEl.innerHTML = "";
  candHead.hidden = true;

  const fd = new FormData();
  fd.set("image", lastFile);
  if (isValid(working)) { fd.set("lat", String(working.lat)); fd.set("lon", String(working.lon)); }

  let data;
  try {
    const res = await fetch("/match", { method: "POST", body: fd });
    if (!res.ok) throw new Error("server " + res.status);
    data = await res.json();
  } catch {
    if (myToken !== pollToken) return;
    statusEl.className = "status";
    statusEl.textContent = "Something went wrong reading that photo. Try another.";
    resetBtn.hidden = false;
    return;
  }
  if (myToken !== pollToken) return;

  activeSnapId = data.snapId;
  confirmedListingUrl = null;
  rAgency.textContent = data.agency || "Agency not detected";
  rPhone.textContent = data.phone ? "📞 " + data.phone : "";
  rTown.textContent = data.town ? "📍 " + data.town : "";

  await saveScan(data, lastFile);

  if (!data.candidates.length) {
    statusEl.className = "status is-none";
    statusEl.textContent = data.agency
      ? "No listings surfaced for this agency/town yet. Try a closer photo or add a location."
      : "Could not read the agency off the sign. Try a sharper photo.";
    resetBtn.hidden = false;
    return;
  }

  candHead.hidden = false;
  scoringNote.hidden = false;
  statusEl.textContent = "Scoring candidates…";
  renderCandidates(data.candidates);

  if (!data.scoring) {
    finalizeVerdict(data.matchKind, data.candidates);
    resetBtn.hidden = false;
    return;
  }

  pollScores(data.snapId, myToken);
}

function pollScores(snapId, myToken) {
  const iv = setInterval(async () => {
    if (myToken !== pollToken) { clearInterval(iv); return; }
    let d;
    try {
      const r = await fetch(`/match/${snapId}/scores`);
      if (!r.ok) { clearInterval(iv); return; }
      d = await r.json();
    } catch { clearInterval(iv); return; }
    if (myToken !== pollToken) { clearInterval(iv); return; }

    renderCandidates(d.candidates);
    if (d.status === "done" || d.status === "error") {
      clearInterval(iv);
      scoringNote.hidden = true;
      finalizeVerdict(d.matchKind, d.candidates);
      updateScanCandidates(snapId, d.candidates);
      resetBtn.hidden = false;
    }
  }, 1200);
}

function confidenceLabel(score, pending) {
  if (pending) return { text: "Scoring…", cls: "is-pending" };
  if (score >= 70) return { text: `Likely match (${score}%)`, cls: "is-high" };
  if (score >= 40) return { text: `Possible (${score}%)`, cls: "is-mid" };
  return { text: `Unlikely (${score}%)`, cls: "is-low" };
}

function renderCandidates(candidates) {
  candidatesEl.innerHTML = "";
  for (const c of candidates) {
    const node = candidateTpl.content.firstElementChild.cloneNode(true);
    const pending = c.reason === "pending";
    node.href = c.listingUrl;
    if (confirmedListingUrl && confirmedListingUrl === c.listingUrl) node.classList.add("is-top");
    const img = node.querySelector("img");
    img.src = c.facadeImageUrl || "/icon.svg";
    // Tapping the facade photo enlarges it; tapping the rest of the card opens
    // the listing (default anchor behaviour) and records the confirm.
    img.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLightbox(img.src);
    });
    node.querySelector(".card-addr").textContent = c.address || c.town || "Listing";
    node.querySelector(".card-price").textContent = c.price || "";
    const label = confidenceLabel(c.confidence ?? 0, pending);
    const confEl = node.querySelector(".card-confidence");
    confEl.textContent = label.text;
    confEl.classList.add(label.cls);
    node.addEventListener("click", () => {
      if (activeSnapId) confirmScanCandidate(activeSnapId, c.listingUrl);
    });
    candidatesEl.appendChild(node);
  }
}

function finalizeVerdict(matchKind, candidates) {
  statusEl.classList.remove("is-confident", "is-candidates", "is-none");
  if (!candidates.length) {
    statusEl.classList.add("is-none");
    statusEl.textContent = "No listings to compare.";
  } else if (matchKind === "confident") {
    statusEl.classList.add("is-confident");
    statusEl.textContent = "Strong match found. Confirm it is the right house.";
  } else {
    statusEl.classList.add("is-candidates");
    statusEl.textContent = "No confident match. Tap the right house to confirm.";
  }
}

function confirmScanCandidate(snapId, listingUrl) {
  confirmedListingUrl = listingUrl;
  fetch("/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapId, listingUrl }),
  }).catch(() => {});
  confirmScanInHistory(snapId, listingUrl);
  for (const card of candidatesEl.querySelectorAll(".card")) card.classList.remove("is-top");
  const match = [...candidatesEl.querySelectorAll(".card")].find((n) => n.getAttribute("href") === listingUrl);
  if (match) match.classList.add("is-top");
}

// ── scan history (per-device, localStorage) ────────────────────────────
const HISTORY_KEY = "immosnap.v2.history";
const HISTORY_LIMIT = 30;

function loadHistory() {
  try {
    const items = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function persistHistory(items) {
  let list = items.slice(0, HISTORY_LIMIT);
  while (list.length) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
      return list;
    } catch {
      list = list.slice(0, -1);
    }
  }
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
  return [];
}

function makeThumbnail(file, maxDim = 320) {
  return new Promise((resolve) => {
    if (!file) return resolve(null);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch { resolve(null); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

async function saveScan(data, file) {
  const thumbnail = await makeThumbnail(file);
  const record = {
    id: data.snapId,
    ts: Date.now(),
    thumbnail,
    agency: data.agency || null,
    phone: data.phone || null,
    town: data.town || null,
    matchKind: data.matchKind || null,
    candidates: data.candidates || [],
    confirmedListingUrl: null,
  };
  persistHistory([record, ...loadHistory().filter((r) => r.id !== record.id)]);
  renderHistory();
  return record;
}

function updateScanCandidates(snapId, candidates) {
  const history = loadHistory();
  const record = history.find((r) => r.id === snapId);
  if (!record) return;
  record.candidates = candidates;
  persistHistory(history);
}

function confirmScanInHistory(snapId, listingUrl) {
  const history = loadHistory();
  const record = history.find((r) => r.id === snapId);
  if (!record) return;
  record.confirmedListingUrl = listingUrl;
  persistHistory(history);
  renderHistory();
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(ts).toLocaleDateString();
}

function historyBadge(record) {
  if (record.confirmedListingUrl) return { text: "Confirmed", cls: "is-confident" };
  if (record.matchKind === "confident") return { text: "Strong match", cls: "is-confident" };
  if (record.candidates.length) return { text: `${record.candidates.length} candidates`, cls: "is-candidates" };
  return { text: "No listings", cls: "" };
}

function renderHistory() {
  const history = loadHistory();
  historyCount.textContent = String(history.length);
  historyCount.hidden = history.length === 0;
  clearHistoryBtn.hidden = history.length === 0;
  historyEmpty.hidden = history.length !== 0;

  historyList.innerHTML = "";
  for (const record of history) {
    const node = historyTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".history-thumb").src = record.thumbnail || "/icon.svg";
    node.querySelector(".history-agency").textContent = record.agency || "Unread agency";
    node.querySelector(".history-time").textContent = relativeTime(record.ts);
    node.querySelector(".history-sub").textContent = record.town || "Town unknown";
    const b = historyBadge(record);
    const badgeEl = node.querySelector(".history-badge");
    badgeEl.textContent = b.text;
    if (b.cls) badgeEl.classList.add(b.cls);
    node.addEventListener("click", () => openScan(record));
    historyList.appendChild(node);
  }
}

function openScan(record) {
  goToScanTab();
  activeSnapId = record.id;
  confirmedListingUrl = record.confirmedListingUrl || null;
  lastFile = null;
  pollToken++; // any earlier live poll stops touching the panel
  hero.hidden = true;
  result.hidden = false;
  resetBtn.hidden = false;
  candHead.hidden = false;
  scoringNote.hidden = true;
  previewImg.src = record.thumbnail || "/icon.svg";
  rAgency.textContent = record.agency || "Unknown agency";
  rPhone.textContent = record.phone ? "📞 " + record.phone : "";
  rTown.textContent = record.town ? "📍 " + record.town : "";
  renderCandidates(record.candidates);
  finalizeVerdict(record.matchKind, record.candidates);
}

clearHistoryBtn.addEventListener("click", () => {
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
  renderHistory();
});

// ── tap-to-enlarge lightbox (FR6): one reusable overlay, no dependency ──────
function openLightbox(src) {
  if (!src) return;
  lightboxImg.src = src;
  lightbox.hidden = false;
  lightbox.setAttribute("aria-hidden", "false");
}
function closeLightbox() {
  lightbox.hidden = true;
  lightbox.setAttribute("aria-hidden", "true");
  lightboxImg.src = "";
}
document.addEventListener("click", (e) => {
  const trigger = e.target.closest(".lightbox-trigger");
  if (!trigger) return;
  e.preventDefault();
  openLightbox(trigger.src);
});
lightbox.addEventListener("click", closeLightbox);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });

renderHistory();
updateGpsBadge();
