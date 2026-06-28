// ImmoSnap PWA front-end.
// One "working location" (photo EXIF | device GPS | typed address | pinned point)
// feeds the existing POST /match. Map display uses Leaflet (tiles only); all
// geocoding / reverse-geocoding is Google, server-side (GET /geocode, /reverse).

const fileInput = document.querySelector("#file");
const dropzone = document.querySelector("#dropzone");
const gpsBadge = document.querySelector("#gps-badge");
const gpsBtn = document.querySelector("#gps-btn");
const hero = document.querySelector("#hero");
const result = document.querySelector("#result");
const previewImg = document.querySelector("#preview-img");
const rAgency = document.querySelector("#r-agency");
const rPhone = document.querySelector("#r-phone");
const rTown = document.querySelector("#r-town");
const statusEl = document.querySelector("#status");
const candHead = document.querySelector("#cand-head");
const candidates = document.querySelector("#candidates");
const tpl = document.querySelector("#candidate-template");
const resetBtn = document.querySelector("#reset");

// location panel
const locBadge = document.querySelector("#loc-badge");
const locAddr = document.querySelector("#loc-addr");
const mapWrap = document.querySelector("#map-wrap");
const adjustBtn = document.querySelector("#adjust-btn");
const manualBtn = document.querySelector("#manual-btn");
const manualForm = document.querySelector("#manual-form");
const manualInput = document.querySelector("#manual-input");
const manualHint = document.querySelector("#manual-hint");

// modal
const modal = document.querySelector("#map-modal");
const modalAddr = document.querySelector("#modal-addr");
const modalCancel = document.querySelector("#modal-cancel");
const modalConfirm = document.querySelector("#modal-confirm");

// ── location state: every source kept separately, one "working" derived ──────
let exifCoords = null, deviceCoords = null, manualCoords = null, pinCoords = null;
let working = null, source = null;
let lastFile = null;
let inlineMap = null, inlineMarker = null;
let modalMap = null, modalMarker = null, modalPick = null;
let addrToken = 0, modalAddrToken = 0;

const SOURCE_LABEL = { photo: "photo EXIF", device: "device GPS", manual: "address", pin: "pinned" };
const DEFAULT_CENTER = { lat: 50.8503, lon: 4.3517 }; // Brussels, when nothing else

function isValid(c) {
  return !!c && Number.isFinite(c.lat) && Number.isFinite(c.lon) && (c.lat !== 0 || c.lon !== 0);
}

// Single source of truth for which location wins (mirrors src/lib/location.ts):
// pinned > typed address > photo EXIF > device GPS.
function recomputeWorking() {
  const pick = isValid(pinCoords) ? { c: pinCoords, s: "pin" }
    : isValid(manualCoords) ? { c: manualCoords, s: "manual" }
    : isValid(exifCoords) ? { c: exifCoords, s: "photo" }
    : isValid(deviceCoords) ? { c: deviceCoords, s: "device" }
    : null;
  working = pick ? pick.c : null;
  source = pick ? pick.s : null;
  return working;
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

// ── inline DISPLAY-ONLY map (no drag/zoom/scroll); whole thing taps to modal ──
function ensureInlineMap(lat, lon) {
  if (!window.L) return;
  try {
    if (!inlineMap) {
      inlineMap = L.map("map", {
        zoomControl: false, attributionControl: false,
        dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
        boxZoom: false, keyboard: false, touchZoom: false, tap: false,
      }).setView([lat, lon], 16);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(inlineMap);
      inlineMarker = L.marker([lat, lon]).addTo(inlineMap);
    } else {
      inlineMap.setView([lat, lon], 16);
      inlineMarker.setLatLng([lat, lon]);
    }
    setTimeout(() => { try { inlineMap.invalidateSize(); } catch {} }, 30);
  } catch {}
}

async function showResolvedAddress(coords) {
  const t = ++addrToken;
  locAddr.textContent = "Resolving address…";
  try {
    const r = await fetch(`/reverse?lat=${coords.lat}&lon=${coords.lon}`);
    if (!r.ok) { if (t === addrToken) locAddr.textContent = ""; return; }
    const d = await r.json();
    if (t === addrToken) locAddr.textContent = d.formatted || "";
  } catch { if (t === addrToken) locAddr.textContent = ""; }
}

function updateLocUI() {
  const has = isValid(working);
  mapWrap.hidden = !has;
  if (has) {
    const label = SOURCE_LABEL[source] || source;
    const txt = `📍 ${label}: ${working.lat.toFixed(4)}, ${working.lon.toFixed(4)}`;
    locBadge.textContent = txt; locBadge.className = "badge badge-ok";
    gpsBadge.textContent = txt; gpsBadge.className = "badge badge-ok";
    ensureInlineMap(working.lat, working.lon);
    if (source !== "manual") showResolvedAddress(working);
  } else {
    locBadge.textContent = "No location detected — enter an address below";
    locBadge.className = "badge badge-muted";
    gpsBadge.textContent = "No location in photo"; gpsBadge.className = "badge badge-muted";
    locAddr.textContent = "";
    manualForm.hidden = false; // surface the fallback prominently
  }
}

// ── expandable modal map: the ONLY place the pin can move ─────────────────────
function openModal() {
  const center = isValid(working) ? working : DEFAULT_CENTER;
  modalPick = { lat: center.lat, lon: center.lon };
  modalAddr.textContent = "";
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  if (!window.L) return;
  try {
    if (!modalMap) {
      modalMap = L.map("modal-map").setView([center.lat, center.lon], 16);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: "© OpenStreetMap",
      }).addTo(modalMap);
      modalMarker = L.marker([center.lat, center.lon], { draggable: true }).addTo(modalMap);
      modalMap.on("click", (e) => { modalMarker.setLatLng(e.latlng); setModalPick(e.latlng); });
      modalMarker.on("dragend", () => setModalPick(modalMarker.getLatLng()));
    } else {
      modalMap.setView([center.lat, center.lon], 16);
      modalMarker.setLatLng([center.lat, center.lon]);
    }
    setTimeout(() => { try { modalMap.invalidateSize(); } catch {} }, 60);
  } catch {}
}

function setModalPick(latlng) {
  modalPick = { lat: latlng.lat, lon: latlng.lng };
  const t = ++modalAddrToken;
  modalAddr.textContent = "Resolving…";
  fetch(`/reverse?lat=${modalPick.lat}&lon=${modalPick.lon}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (t === modalAddrToken) modalAddr.textContent = (d && d.formatted) || ""; })
    .catch(() => { if (t === modalAddrToken) modalAddr.textContent = ""; });
}

function closeModal() {
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

// ── wiring ────────────────────────────────────────────────────────────────
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault(); dropzone.classList.remove("drag");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

gpsBtn.addEventListener("click", async () => {
  gpsBadge.textContent = "Getting device GPS…";
  const d = await getDeviceGps();
  if (!d) { gpsBadge.textContent = "Device GPS unavailable/denied"; return; }
  // explicit "use device instead" → device overrides the other sources
  deviceCoords = d; exifCoords = null; manualCoords = null; pinCoords = null;
  recomputeWorking(); updateLocUI();
  if (lastFile) runMatch();
});

// tapping the static thumbnail opens the adjust modal
mapWrap.addEventListener("click", openModal);
adjustBtn.addEventListener("click", openModal);

manualBtn.addEventListener("click", () => {
  manualForm.hidden = !manualForm.hidden;
  if (!manualForm.hidden) manualInput.focus();
});

manualForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = manualInput.value.trim();
  if (!q) return;
  manualHint.hidden = false; manualHint.textContent = "Looking up address…";
  const submitBtn = document.querySelector("#manual-submit");
  submitBtn.disabled = true;
  try {
    const res = await fetch("/geocode?q=" + encodeURIComponent(q));
    if (res.status === 404) { manualHint.textContent = "Address not found — try adding the town/postcode."; return; }
    if (!res.ok) throw new Error("geocode " + res.status);
    const d = await res.json();
    manualCoords = { lat: d.lat, lon: d.lon };
    pinCoords = null; // a freshly typed address supersedes an earlier pin
    manualHint.hidden = true;
    recomputeWorking(); updateLocUI();
    locAddr.textContent = q; // show what the user typed
    runMatch();
  } catch {
    manualHint.textContent = "Couldn't look up that address. Check it and try again.";
  } finally {
    submitBtn.disabled = false;
  }
});

modalConfirm.addEventListener("click", () => {
  if (modalPick) {
    pinCoords = { lat: modalPick.lat, lon: modalPick.lon };
    recomputeWorking(); updateLocUI(); // pin wins → reverse-geocodes + refreshes thumbnail
    closeModal();
    runMatch();
  } else {
    closeModal();
  }
});
modalCancel.addEventListener("click", closeModal); // discard
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

resetBtn.addEventListener("click", () => {
  result.hidden = true; hero.hidden = false; candidates.innerHTML = "";
  candHead.hidden = true; resetBtn.hidden = true; fileInput.value = "";
  exifCoords = deviceCoords = manualCoords = pinCoords = working = null; source = null;
  mapWrap.hidden = true; manualForm.hidden = true; manualHint.hidden = true; manualInput.value = "";
  locBadge.textContent = "No location yet"; locBadge.className = "badge badge-muted"; locAddr.textContent = "";
  gpsBadge.textContent = "No location yet"; gpsBadge.className = "badge badge-muted";
});

// ── process a chosen photo: resolve initial location, then run the match ──────
async function handleFile(file) {
  lastFile = file;
  hero.hidden = true;
  result.hidden = false;
  resetBtn.hidden = true;
  candidates.innerHTML = "";
  candHead.hidden = true;
  manualHint.hidden = true; manualForm.hidden = true;
  rAgency.textContent = "—"; rPhone.textContent = ""; rTown.textContent = "";
  previewImg.src = URL.createObjectURL(file);

  // fresh photo → fresh location decision
  exifCoords = deviceCoords = manualCoords = pinCoords = null;

  // 1) photo EXIF GPS (Google Photos keeps it)
  statusEl.textContent = "Reading location…"; statusEl.className = "status spin";
  try {
    if (window.exifr) {
      const g = await window.exifr.gps(file);
      if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) {
        exifCoords = { lat: g.latitude, lon: g.longitude };
      }
    }
  } catch { /* ignore */ }

  // 2) no EXIF? try device GPS (you're standing at the sign)
  if (!isValid(exifCoords)) {
    statusEl.textContent = "Getting your location…";
    const d = await getDeviceGps();
    if (d) deviceCoords = d;
  }

  recomputeWorking();
  updateLocUI();

  // 3) neither photo nor device → offer manual entry up front
  if (!isValid(working)) {
    manualForm.hidden = false;
    manualHint.hidden = false;
    manualHint.textContent = "We couldn't detect a location. Type the property address, or drop a pin on the map.";
  }

  runMatch();
}

// ── run the matcher from the current working location (no location reset) ─────
async function runMatch() {
  if (!lastFile) return;
  statusEl.textContent = "Reading the sign and finding listings…";
  statusEl.className = "status spin";
  candidates.innerHTML = "";
  candHead.hidden = true;

  const fd = new FormData();
  fd.set("image", lastFile);
  if (isValid(working)) { fd.set("lat", String(working.lat)); fd.set("lon", String(working.lon)); }

  try {
    const res = await fetch("/match", { method: "POST", body: fd });
    if (!res.ok) throw new Error("server " + res.status);
    render(await res.json());
  } catch {
    statusEl.className = "status";
    statusEl.textContent = "Something went wrong reading that photo. Try another.";
    resetBtn.hidden = false;
  }
}

function render(data) {
  rAgency.textContent = data.agency || "Agency not detected";
  rPhone.textContent = data.phone ? "📞 " + data.phone : "";
  rTown.textContent = data.town ? "📍 " + data.town : "";
  statusEl.className = "status";

  const list = (data.candidates || []).filter((c) => c.listingUrl);
  if (!list.length) {
    statusEl.textContent = "No listings surfaced yet — adjust the location or enter the address to refine.";
    resetBtn.hidden = false;
    return;
  }
  statusEl.textContent = "";
  candHead.hidden = false;
  for (const c of list) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.href = c.listingUrl;
    const img = node.querySelector("img");
    if (c.facadeImageUrl) { img.src = c.facadeImageUrl; } else { img.parentElement.style.display = "none"; }
    node.querySelector(".card-addr").textContent = c.address || "Listing";
    node.querySelector(".card-price").textContent = c.price ? c.price : "";
    candidates.appendChild(node);
  }
  resetBtn.hidden = false;
}
