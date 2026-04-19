// crates-diff — all heavy lifting runs in the browser.
// The Deno server only proxies crates.io (CORS + User-Agent).

const $ = (id) => document.getElementById(id);

const searchInput = $("search");
const resultsEl = $("results");
const compareEl = $("compare");
const crateNameEl = $("crate-name");
const crateLinkEl = $("crate-link");
const leftSel = $("left-version");
const rightSel = $("right-version");
const statsEl = $("stats");
const diffEl = $("diff");

const state = {
  crate: null,           // crates.io crate object
  versions: [],          // list of { num, yanked, ... }
  left: null,
  right: null,
  loadToken: 0,          // guards against out-of-order diff loads
};

// ---------- URL hash ----------

function writeHash() {
  if (!state.crate) return;
  let h = state.crate.name;
  if (state.left && state.right) h += `/${state.left}...${state.right}`;
  if (location.hash.slice(1) !== h) {
    history.replaceState(null, "", `#${h}`);
  }
}

function parseHash() {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash < 0) return { name: raw, left: null, right: null };
  const name = raw.slice(0, slash);
  const rest = raw.slice(slash + 1);
  const sep = rest.indexOf("...");
  if (sep < 0) return { name, left: null, right: null };
  return { name, left: rest.slice(0, sep), right: rest.slice(sep + 3) };
}

// ---------- search ----------

let searchTimer = 0;
let activeResultIdx = -1;
let currentResults = [];

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});

searchInput.addEventListener("keydown", (e) => {
  if (resultsEl.hidden) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeResultIdx = Math.min(activeResultIdx + 1, currentResults.length - 1);
    paintActiveResult();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeResultIdx = Math.max(activeResultIdx - 1, 0);
    paintActiveResult();
  } else if (e.key === "Enter") {
    if (activeResultIdx >= 0 && currentResults[activeResultIdx]) {
      e.preventDefault();
      selectCrate(currentResults[activeResultIdx].name);
    }
  } else if (e.key === "Escape") {
    resultsEl.hidden = true;
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search")) resultsEl.hidden = true;
});

async function runSearch() {
  const q = searchInput.value.trim();
  if (!q) {
    resultsEl.hidden = true;
    resultsEl.innerHTML = "";
    return;
  }
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&per_page=10`);
    const data = await res.json();
    renderResults(data.crates || []);
  } catch (err) {
    console.error(err);
  }
}

function renderResults(crates) {
  currentResults = crates;
  activeResultIdx = crates.length ? 0 : -1;
  if (!crates.length) {
    resultsEl.innerHTML = `<li class="empty">No crates found.</li>`;
  } else {
    resultsEl.innerHTML = crates.map((c, i) => `
      <li data-name="${escapeHtml(c.name)}" data-i="${i}">
        <div class="r-main">
          <span class="r-name">${escapeHtml(c.name)}</span>
          <span class="r-desc">${escapeHtml(c.description || "")}</span>
        </div>
        <span class="r-ver">${escapeHtml(c.max_version || c.newest_version || "")}</span>
      </li>
    `).join("");
    resultsEl.querySelectorAll("li").forEach((li) => {
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectCrate(li.dataset.name);
      });
    });
  }
  resultsEl.hidden = false;
  paintActiveResult();
}

function paintActiveResult() {
  resultsEl.querySelectorAll("li").forEach((li, i) => {
    li.classList.toggle("active", i === activeResultIdx);
  });
}

// ---------- crate selection ----------

async function selectCrate(name, preferredLeft = null, preferredRight = null) {
  resultsEl.hidden = true;
  searchInput.value = name;
  diffEl.innerHTML = `<div class="loading">Loading ${escapeHtml(name)}&hellip;</div>`;
  statsEl.textContent = "";

  try {
    const res = await fetch(`/api/crate/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`crate not found: ${name}`);
    const data = await res.json();
    state.crate = data.crate;
    state.versions = (data.versions || []).filter((v) => !v.yanked);

    if (!state.versions.length) {
      throw new Error("no non-yanked versions available");
    }

    const versionsByNum = new Map(state.versions.map((v) => [v.num, v]));
    const fallbackRight = state.versions[0].num;
    const fallbackLeft = state.versions[1]?.num ?? state.versions[0].num;

    state.right = versionsByNum.has(preferredRight) ? preferredRight : fallbackRight;
    state.left = versionsByNum.has(preferredLeft) ? preferredLeft : fallbackLeft;

    paintCompare();
    writeHash();
    await loadDiff();
  } catch (err) {
    diffEl.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
}

function paintCompare() {
  compareEl.hidden = false;
  crateNameEl.textContent = state.crate.name;
  crateLinkEl.href = `https://crates.io/crates/${state.crate.name}`;

  const opts = state.versions
    .map((v) => `<option value="${escapeHtml(v.num)}">${escapeHtml(v.num)}</option>`)
    .join("");
  leftSel.innerHTML = opts;
  rightSel.innerHTML = opts;
  leftSel.value = state.left;
  rightSel.value = state.right;
}

leftSel.addEventListener("change", async () => {
  state.left = leftSel.value;
  writeHash();
  await loadDiff();
});

rightSel.addEventListener("change", async () => {
  state.right = rightSel.value;
  writeHash();
  await loadDiff();
});

// ---------- tarball fetch + parse (cached) ----------

async function fetchCrateFiles(name, version) {
  const url = `/api/download/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  let response;
  let cache = null;
  try {
    cache = await caches.open("crates-diff-v1");
    response = await cache.match(url);
  } catch {
    // Cache API may be unavailable (insecure context / private mode)
  }
  if (!response) {
    response = await fetch(url);
    if (!response.ok) throw new Error(`download failed: ${name} ${version}`);
    if (cache) {
      try { await cache.put(url, response.clone()); } catch {}
    }
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  const tar = pako.inflate(buf);
  return parseTar(tar);
}

// Minimal pax-aware tar parser. Returns { [path]: Uint8Array }.
function parseTar(buf) {
  const dec = new TextDecoder("utf-8", { fatal: false });
  const files = {};
  let offset = 0;
  let pendingPath = null;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);

    let empty = true;
    for (let i = 0; i < 512; i++) if (header[i] !== 0) { empty = false; break; }
    if (empty) break;

    const name   = rstripNul(dec.decode(header.subarray(0, 100)));
    const prefix = rstripNul(dec.decode(header.subarray(345, 500)));
    const sizeStr = rstripNul(dec.decode(header.subarray(124, 136))).trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const typeFlag = String.fromCharCode(header[156] || 0x30);

    offset += 512;
    const body = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    let fullName = prefix ? `${prefix}/${name}` : name;

    if (typeFlag === "x" || typeFlag === "X") {
      const pax = parsePax(dec.decode(body));
      if (pax.path) pendingPath = pax.path;
      continue;
    }
    if (typeFlag === "L") {
      pendingPath = rstripNul(dec.decode(body));
      continue;
    }
    if (typeFlag === "K") continue; // GNU long link
    if (typeFlag === "5") { pendingPath = null; continue; } // dir

    if (pendingPath) { fullName = pendingPath; pendingPath = null; }
    if (!fullName) continue;

    // Regular file (type '0' or NUL-defaulted to '0')
    if (typeFlag === "0" || typeFlag === "\0" || header[156] === 0) {
      files[fullName] = body.slice();
    }
  }
  return files;
}

function rstripNul(s) {
  const i = s.indexOf("\0");
  return i < 0 ? s : s.slice(0, i);
}

function parsePax(text) {
  const out = {};
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] !== " ") j++;
    const len = parseInt(text.slice(i, j), 10);
    if (!len || i + len > text.length) break;
    const entry = text.slice(i, i + len - 1); // drop trailing \n
    const eq = entry.indexOf("=");
    if (eq > 0) {
      const key = entry.slice(entry.indexOf(" ") + 1, eq);
      out[key] = entry.slice(eq + 1);
    }
    i += len;
  }
  return out;
}

// Strip the top-level "crate-name-version/" directory from each path.
function stripTopDir(files) {
  const out = {};
  for (const [path, bytes] of Object.entries(files)) {
    const slash = path.indexOf("/");
    const rel = slash < 0 ? path : path.slice(slash + 1);
    if (rel) out[rel] = bytes;
  }
  return out;
}

// ---------- diff ----------

async function loadDiff() {
  const token = ++state.loadToken;
  const left = state.left, right = state.right;
  if (!left || !right) return;

  if (left === right) {
    diffEl.innerHTML = `<div class="empty">Select two different versions.</div>`;
    statsEl.textContent = "";
    return;
  }

  diffEl.innerHTML = `<div class="loading">Fetching ${escapeHtml(state.crate.name)} ${escapeHtml(left)} and ${escapeHtml(right)}&hellip;</div>`;
  statsEl.textContent = "";

  try {
    const [leftFiles, rightFiles] = await Promise.all([
      fetchCrateFiles(state.crate.name, left).then(stripTopDir),
      fetchCrateFiles(state.crate.name, right).then(stripTopDir),
    ]);
    if (token !== state.loadToken) return;
    renderDiff(leftFiles, rightFiles);
  } catch (err) {
    if (token !== state.loadToken) return;
    diffEl.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
}

function renderDiff(left, right) {
  const paths = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();

  let added = 0, removed = 0, modified = 0, unchanged = 0;
  const fragments = [];

  for (const path of paths) {
    const a = left[path];
    const b = right[path];

    if (a && b && bytesEqual(a, b)) { unchanged++; continue; }

    let status;
    if (!a) status = "added";
    else if (!b) status = "removed";
    else status = "modified";

    if (status === "added") added++;
    else if (status === "removed") removed++;
    else modified++;

    const aIsBin = a ? isBinary(a) : false;
    const bIsBin = b ? isBinary(b) : false;

    if (aIsBin || bIsBin) {
      fragments.push(renderFile(path, status, `<div class="line">Binary file differs.</div>`, true));
      continue;
    }

    const aText = a ? decodeText(a) : "";
    const bText = b ? decodeText(b) : "";
    const patch = Diff.createPatch(path, aText, bText, "", "", { context: 3 });
    fragments.push(renderFile(path, status, renderPatchBody(patch), false));
  }

  const total = paths.length;
  statsEl.textContent =
    `${total} files · ${added} added · ${removed} removed · ${modified} modified · ${unchanged} unchanged`;

  if (!fragments.length) {
    diffEl.innerHTML = `<div class="empty">No differences between these versions.</div>`;
  } else {
    diffEl.innerHTML = fragments.join("");
    diffEl.querySelectorAll(".file-header").forEach((h) => {
      h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed"));
    });
  }
}

function renderFile(path, status, bodyHtml, isBinary) {
  const badges = [];
  badges.push(`<span class="badge ${status}">${status}</span>`);
  if (isBinary) badges.push(`<span class="badge binary">binary</span>`);
  return `
    <div class="file" data-path="${escapeHtml(path)}">
      <div class="file-header">
        <span class="path">${escapeHtml(path)}</span>
        <span>${badges.join("")}</span>
      </div>
      <div class="file-body">${bodyHtml}</div>
    </div>
  `;
}

function renderPatchBody(patch) {
  // Drop jsdiff's "Index:" / "===" header and its own ---/+++ lines; we show the path separately.
  const lines = patch.split("\n");
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("Index: ")) continue;
    if (line.startsWith("=====")) continue;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("@@")) {
      out.push(`<div class="hunk line">${escapeHtml(line)}</div>`);
    } else if (line.startsWith("+")) {
      out.push(`<div class="line add">${escapeHtml(line)}</div>`);
    } else if (line.startsWith("-")) {
      out.push(`<div class="line del">${escapeHtml(line)}</div>`);
    } else if (line.startsWith("\\")) {
      out.push(`<div class="line">${escapeHtml(line)}</div>`);
    } else {
      out.push(`<div class="line">${escapeHtml(line)}</div>`);
    }
  }
  return out.join("");
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isBinary(bytes) {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 0) return true;
  }
  return false;
}

function decodeText(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// ---------- utilities ----------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- bootstrap ----------

window.addEventListener("hashchange", () => {
  const parsed = parseHash();
  if (!parsed) return;
  if (state.crate && state.crate.name === parsed.name) {
    // Just version change
    if (parsed.left && parsed.left !== state.left) {
      state.left = parsed.left;
      leftSel.value = parsed.left;
    }
    if (parsed.right && parsed.right !== state.right) {
      state.right = parsed.right;
      rightSel.value = parsed.right;
    }
    loadDiff();
  } else {
    selectCrate(parsed.name, parsed.left, parsed.right);
  }
});

(async function init() {
  const parsed = parseHash();
  if (parsed?.name) {
    await selectCrate(parsed.name, parsed.left, parsed.right);
  }
  searchInput.focus();
})();
