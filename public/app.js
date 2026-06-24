const form = document.querySelector("#match-form");
const imageInput = document.querySelector("#image-input");
const preview = document.querySelector("#preview");
const statusEl = document.querySelector("#status");
const gpsButton = document.querySelector("#gps-button");
const gpsStatus = document.querySelector("#gps-status");
const submitButton = document.querySelector("#submit-button");
const resultPanel = document.querySelector("#result-panel");
const verdict = document.querySelector("#verdict");
const agencyName = document.querySelector("#agency-name");
const agencyPhone = document.querySelector("#agency-phone");
const agencyTown = document.querySelector("#agency-town");
const candidateList = document.querySelector("#candidate-list");
const candidateTemplate = document.querySelector("#candidate-template");

let coords = null;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  statusEl.textContent = "Photo ready. Submit to run OCR and listing resolve.";
});

gpsButton.addEventListener("click", async () => {
  if (!navigator.geolocation) {
    gpsStatus.textContent = "Geolocation is not available on this device.";
    return;
  }

  gpsStatus.textContent = "Requesting location…";
  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 300000,
      });
    });
    coords = {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
    };
    gpsStatus.textContent = `GPS attached: ${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`;
  } catch (error) {
    gpsStatus.textContent = `GPS unavailable: ${error.message || "permission denied"}`;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = imageInput.files?.[0];
  if (!file) return;

  resultPanel.hidden = true;
  candidateList.innerHTML = "";
  submitButton.disabled = true;
  statusEl.textContent = "Running OCR, resolving listings, and ranking candidates…";

  const payload = new FormData();
  payload.set("image", file);
  if (coords) {
    payload.set("lat", String(coords.lat));
    payload.set("lon", String(coords.lon));
  }

  try {
    const response = await fetch("/match", {
      method: "POST",
      body: payload,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

    renderResult(data);
    if (!data.candidates.length) {
      statusEl.textContent = data.agency
        ? `Read the sign as ${data.agency}, but found no listings to compare. Try a closer photo or add GPS.`
        : "Could not read the agency off the sign. Try a sharper photo of the sign.";
    } else if (data.matchKind === "confident") {
      statusEl.textContent = "Strong match found. Confirm it is the right house.";
    } else {
      statusEl.textContent = "No confident match. Tap the right house to confirm.";
    }
  } catch (error) {
    statusEl.textContent = `Match failed: ${error.message}`;
  } finally {
    submitButton.disabled = false;
  }
});

// Honest, evidence-light label for a single candidate's facade score.
function confidenceLabel(score) {
  if (score >= 70) return { text: `Likely match (${score}%)`, cls: "is-high" };
  if (score >= 40) return { text: `Possible (${score}%)`, cls: "is-mid" };
  return { text: `Unlikely (${score}%)`, cls: "is-low" };
}

function renderVerdict(data) {
  verdict.classList.remove("is-confident", "is-candidates", "is-none");
  if (!data.candidates.length) {
    verdict.classList.add("is-none");
    verdict.textContent = data.agency
      ? `${data.agency}: no listings to compare yet. Confirm manually or retake the photo.`
      : "Could not read the agency from the sign.";
  } else if (data.matchKind === "confident") {
    verdict.classList.add("is-confident");
    verdict.textContent = "Strong facade match. Please confirm it is the right house.";
  } else {
    verdict.classList.add("is-candidates");
    const where = data.town ? ` in ${data.town}` : "";
    verdict.textContent = `No confident match. Here are ${data.agency || "the agency"}'s candidates${where}. Tap the right one.`;
  }
  verdict.hidden = false;
}

function renderResult(data) {
  agencyName.textContent = data.agency || "Unknown agency";
  agencyPhone.textContent = data.phone || "-";
  agencyTown.textContent = data.town || "-";
  candidateList.innerHTML = "";
  renderVerdict(data);

  data.candidates.forEach((candidate, index) => {
    const node = candidateTemplate.content.firstElementChild.cloneNode(true);
    const img = node.querySelector(".candidate-image");
    const confidence = node.querySelector(".confidence");
    const link = node.querySelector(".listing-link");
    const address = node.querySelector(".address");
    const price = node.querySelector(".price");
    const confirmButton = node.querySelector(".confirm-button");

    img.src = candidate.facadeImageUrl || "/icon.svg";
    img.alt = candidate.address || `Candidate ${index + 1}`;
    const label = confidenceLabel(candidate.confidence ?? 0);
    confidence.textContent = label.text;
    confidence.classList.add(label.cls);
    // Only the top candidate of a confident result is pre-highlighted.
    if (data.matchKind === "confident" && index === 0) node.classList.add("is-top");
    link.href = candidate.listingUrl;
    address.textContent = candidate.address || candidate.town || "Address unavailable";
    price.textContent = candidate.price || "Price on listing";

    confirmButton.addEventListener("click", () => {
      document
        .querySelectorAll(".candidate-card.is-confirmed")
        .forEach((card) => card.classList.remove("is-confirmed"));
      node.classList.add("is-confirmed");
      statusEl.textContent = `Confirmed: ${candidate.address || candidate.listingUrl}`;
    });

    candidateList.appendChild(node);
  });

  resultPanel.hidden = false;
}
