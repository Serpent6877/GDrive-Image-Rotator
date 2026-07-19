// Naming convention: {days}_{startHHMM}-{endHHMM}_{seq}_{label}.{ext}
//   days:  concatenated ISO weekday digits 1-7 (Mon=1 ... Sun=7), or "all"
//   hours: 24h HHMM-HHMM, same-day range (start <= now < end)
//   seq:   rotation order among images active at the same time
const NAME_PATTERN = /^(all|[1-7]+)_(\d{4})-(\d{4})_(\d+)_(.+)\.(\w+)$/i;

const SHEET_ID_STORAGE_KEY = "gdrive-slideshow:sheetId";
const ROTATE_INTERVAL_MS = 8000;
const RECHECK_INTERVAL_MS = 30000;
const FADE_MS = 1000;

const slideA = document.getElementById("slide-a");
const slideB = document.getElementById("slide-b");
const emptyMessage = document.getElementById("empty-message");
const setupPanel = document.getElementById("setup");
const setupForm = document.getElementById("setup-form");
const setupInput = document.getElementById("sheet-input");
const setupError = document.getElementById("setup-error");
let frontSlide = slideA;
let backSlide = slideB;

let activeQueue = [];
let rotateIndex = 0;
let rotateTimer = null;
let sheetId = null;

// Accepts a full "Share" link (docs.google.com/spreadsheets/d/{ID}/edit...)
// or a bare sheet ID typed/pasted directly.
function extractSheetId(input) {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9-_]+$/.test(trimmed)) return trimmed;
  return null;
}

function gvizUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json&t=${Date.now()}`;
}

// The gviz endpoint wraps its JSON in a JS call: /*O_o*/\ngoogle.visualization.Query.setResponse({...});
function parseGvizResponse(text) {
  const match = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\);?\s*$/);
  if (!match) throw new Error("Unrecognized response from Google Sheets");
  const payload = JSON.parse(match[1]);
  if (payload.status === "error") {
    const message = (payload.errors && payload.errors[0] && payload.errors[0].detailed_message) || "Sheet query failed";
    throw new Error(message);
  }
  return payload.table.rows
    .slice(1) // first row is the header: id, name
    .map((row) => ({
      id: row.c[0] && row.c[0].v,
      name: row.c[1] && row.c[1].v,
    }))
    .filter((entry) => entry.id && entry.name);
}

function showSetup(message) {
  clearInterval(rotateTimer);
  frontSlide.classList.remove("visible");
  backSlide.classList.remove("visible");
  emptyMessage.classList.remove("visible");
  setupError.textContent = message || "";
  setupPanel.classList.add("visible");
}

function hideSetup() {
  setupPanel.classList.remove("visible");
}

function parseEntry(entry) {
  const match = NAME_PATTERN.exec(entry.name);
  if (!match) {
    console.warn(`Skipping "${entry.name}": does not match naming convention`);
    return null;
  }
  const [, daysToken, startToken, endToken, seqToken] = match;
  return {
    id: entry.id,
    name: entry.name,
    days: daysToken.toLowerCase() === "all" ? "all" : new Set(daysToken.split("").map(Number)),
    startMin: Number(startToken.slice(0, 2)) * 60 + Number(startToken.slice(2)),
    endMin: Number(endToken.slice(0, 2)) * 60 + Number(endToken.slice(2)),
    seq: Number(seqToken),
  };
}

function isoWeekday(date) {
  return ((date.getDay() + 6) % 7) + 1; // Mon=1 ... Sun=7
}

function getActiveEntries(entries, now) {
  const isoDay = isoWeekday(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return entries
    .filter((e) => (e.days === "all" || e.days.has(isoDay)) && nowMin >= e.startMin && nowMin < e.endMin)
    .sort((a, b) => a.seq - b.seq);
}

function buildImageUrl(id, size = "w1600") {
  return `https://drive.google.com/thumbnail?id=${id}&sz=${size}`;
}

function fallbackImageUrl(id) {
  return `https://drive.google.com/uc?export=view&id=${id}`;
}

function showEmptyState() {
  frontSlide.classList.remove("visible");
  backSlide.classList.remove("visible");
  emptyMessage.classList.add("visible");
}

function displayEntry(entry) {
  emptyMessage.classList.remove("visible");
  backSlide.src = buildImageUrl(entry.id);
  backSlide.onerror = () => {
    backSlide.onerror = null;
    backSlide.src = fallbackImageUrl(entry.id);
  };
  backSlide.classList.add("visible");
  frontSlide.classList.remove("visible");
  [frontSlide, backSlide] = [backSlide, frontSlide];
}

function sameQueue(a, b) {
  return a.length === b.length && a.every((entry, i) => entry.id === b[i].id);
}

function startRotation(queue) {
  clearInterval(rotateTimer);
  activeQueue = queue;
  rotateIndex = 0;

  if (activeQueue.length === 0) {
    showEmptyState();
    return;
  }

  displayEntry(activeQueue[rotateIndex]);

  if (activeQueue.length > 1) {
    rotateTimer = setInterval(() => {
      rotateIndex = (rotateIndex + 1) % activeQueue.length;
      displayEntry(activeQueue[rotateIndex]);
    }, ROTATE_INTERVAL_MS);
  }
}

async function loadManifest() {
  const response = await fetch(gvizUrl(sheetId));
  if (!response.ok) throw new Error(`Failed to load sheet (${response.status})`);
  const text = await response.text();
  const raw = parseGvizResponse(text);
  return raw.map(parseEntry).filter(Boolean);
}

async function refresh() {
  try {
    const entries = await loadManifest();
    hideSetup();
    const queue = getActiveEntries(entries, new Date());
    if (!sameQueue(queue, activeQueue)) {
      startRotation(queue);
    }
  } catch (err) {
    console.error(err);
    showSetup(`Couldn't load that sheet: ${err.message}`);
  }
}

let refreshTimer = null;

function startApp(id) {
  sheetId = id;
  localStorage.setItem(SHEET_ID_STORAGE_KEY, id);
  clearInterval(refreshTimer);
  refresh();
  refreshTimer = setInterval(refresh, RECHECK_INTERVAL_MS);
}

setupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const id = extractSheetId(setupInput.value);
  if (!id) {
    setupError.textContent = "That doesn't look like a Google Sheets link or ID.";
    return;
  }
  startApp(id);
});

const params = new URLSearchParams(window.location.search);
const sheetParam = params.get("sheet");
const initialId = (sheetParam && extractSheetId(sheetParam)) || localStorage.getItem(SHEET_ID_STORAGE_KEY);

if (initialId) {
  if (sheetParam) setupInput.value = sheetParam;
  startApp(initialId);
} else {
  showSetup();
}
