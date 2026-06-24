const form = document.querySelector("#match-form");
const imageInput = document.querySelector("#image-input");
const preview = document.querySelector("#preview");
const statusEl = document.querySelector("#status");
const gpsButton = document.querySelector("#gps-button");
const gpsStatus = document.querySelector("#gps-status");
const submitButton = document.querySelector("#submit-button");
const resultPanel = document.querySelector("#result-panel");
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
    statusEl.textContent = data.candidates.length
      ? "Tap the right listing to confirm the match."
      : "OCR worked, but no candidates were resolved from the portals.";
  } catch (error) {
    statusEl.textContent = `Match failed: ${error.message}`;
  } finally {
    submitButton.disabled = false;
  }
});

function renderResult(data) {
  agencyName.textContent = data.agency || "Unknown agency";
  agencyPhone.textContent = data.phone || "-";
  agencyTown.textContent = data.town || "-";
  candidateList.innerHTML = "";

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
    confidence.textContent = `${candidate.confidence}% confidence`;
    link.href = candidate.listingUrl;
    address.textContent = candidate.address || "Address unavailable";
    price.textContent = candidate.price || "Price unavailable";

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
