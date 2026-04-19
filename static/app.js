// crates-diff — all heavy lifting runs in the browser.
// The Deno server only proxies crates.io (CORS + User-Agent).

const $ = (id) => document.getElementById(id);

// --- DOM
const searchInput    = $("search");
const resultsEl      = $("results");
const compareEl      = $("compare");
const crateNameEl    = $("crate-name");
const crateLinkEl    = $("crate-link");
const leftSel        = $("left-version");
const rightSel       = $("right-version");
const statsEl        = $("stats");
const diffEl         = $("diff");
const toolbarEl      = $("toolbar");
const copyLinkBtn    = $("copy-link");
const expandAllBtn   = $("expand-all");
const collapseAllBtn = $("collapse-all");
const sidebarEl      = $("sidebar");
const fileTreeEl     = $("file-tree");
const filterTabsEl   = $("filter-tabs");
const diffPaneEl     = $("diff-pane");
const topbarEl       = document.querySelector(".topbar");
const topbarToggleBtn = $("topbar-toggle");

// --- state
const state = {
  crate: null,
  versions: [],
  left: null,
  right: null,
  loadToken: 0,
  files: new Map(),    // id -> FileData
  order: [],           // file ids in render order
  filter: "changed",   // "changed" | "all"
};

// Paths that default to collapsed — noisy but frequently regenerated files.
const DEFAULT_COLLAPSED = new Set(["Cargo.lock"]);

// ---------- URL hash ----------

function writeHash() {
  if (!state.crate) return;
  let h = state.crate.name;
  if (state.left && state.right) h += `/${state.left}...${state.right}`;
  if (location.hash.slice(1) !== h) history.replaceState(null, "", `#${h}`);
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
  if (!q) { resultsEl.hidden = true; resultsEl.innerHTML = ""; return; }
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&per_page=10`);
    const data = await res.json();
    renderResults(data.crates || []);
  } catch (err) { console.error(err); }
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
      li.addEventListener("mousedown", (e) => { e.preventDefault(); selectCrate(li.dataset.name); });
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
  diffEl.innerHTML =
    `<div class="loading"><span class="spinner"></span>Loading ${escapeHtml(name)}&hellip;</div>`;
  statsEl.innerHTML = "";
  toolbarEl.hidden = true;
  sidebarEl.hidden = true;

  try {
    const res = await fetch(`/api/crate/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`crate not found: ${name}`);
    const data = await res.json();
    state.crate = data.crate;
    state.versions = data.versions || [];
    if (!state.versions.length) throw new Error("no versions available");

    const byNum = new Map(state.versions.map((v) => [v.num, v]));
    const live = state.versions.filter((v) => !v.yanked);
    const fallbackRight = (live[0] ?? state.versions[0]).num;
    const fallbackLeft = (live[1] ?? live[0] ?? state.versions[1] ?? state.versions[0]).num;

    state.right = byNum.has(preferredRight) ? preferredRight : fallbackRight;
    state.left = byNum.has(preferredLeft) ? preferredLeft : fallbackLeft;

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

  const opts = state.versions.map((v) => {
    const label = v.yanked ? `${v.num} (yanked)` : v.num;
    const cls = v.yanked ? ' class="yanked"' : "";
    return `<option value="${escapeHtml(v.num)}"${cls}>${escapeHtml(label)}</option>`;
  }).join("");
  leftSel.innerHTML = opts;
  rightSel.innerHTML = opts;
  leftSel.value = state.left;
  rightSel.value = state.right;
}

leftSel.addEventListener("change", async () => {
  state.left = leftSel.value; writeHash(); await loadDiff();
});
rightSel.addEventListener("change", async () => {
  state.right = rightSel.value; writeHash(); await loadDiff();
});

// ---------- tarball fetch + parse (cached) ----------

async function fetchCrateFiles(name, version) {
  const url = `/api/download/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  let response;
  let cache = null;
  try { cache = await caches.open("crates-diff-v1"); response = await cache.match(url); }
  catch { /* Cache API unavailable */ }
  if (!response) {
    response = await fetch(url);
    if (!response.ok) throw new Error(`download failed: ${name} ${version}`);
    if (cache) { try { await cache.put(url, response.clone()); } catch { /* ignore */ } }
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  const tar = pako.inflate(buf);
  return parseTar(tar);
}

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
    if (typeFlag === "L") { pendingPath = rstripNul(dec.decode(body)); continue; }
    if (typeFlag === "K") continue;
    if (typeFlag === "5") { pendingPath = null; continue; }

    if (pendingPath) { fullName = pendingPath; pendingPath = null; }
    if (!fullName) continue;

    if (typeFlag === "0" || typeFlag === "\0" || header[156] === 0) {
      files[fullName] = body.slice();
    }
  }
  return files;
}

function rstripNul(s) { const i = s.indexOf("\0"); return i < 0 ? s : s.slice(0, i); }

function parsePax(text) {
  const out = {};
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] !== " ") j++;
    const len = parseInt(text.slice(i, j), 10);
    if (!len || i + len > text.length) break;
    const entry = text.slice(i, i + len - 1);
    const eq = entry.indexOf("=");
    if (eq > 0) {
      const key = entry.slice(entry.indexOf(" ") + 1, eq);
      out[key] = entry.slice(eq + 1);
    }
    i += len;
  }
  return out;
}

function stripTopDir(files) {
  const out = {};
  for (const [path, bytes] of Object.entries(files)) {
    const slash = path.indexOf("/");
    const rel = slash < 0 ? path : path.slice(slash + 1);
    if (rel) out[rel] = bytes;
  }
  return out;
}

// ---------- diff pipeline ----------

async function loadDiff() {
  const token = ++state.loadToken;
  const left = state.left, right = state.right;
  if (!left || !right) return;

  if (left === right) {
    diffEl.innerHTML = `<div class="empty">Select two different versions.</div>`;
    statsEl.innerHTML = "";
    toolbarEl.hidden = true;
    sidebarEl.hidden = true;
    return;
  }

  diffEl.innerHTML =
    `<div class="loading"><span class="spinner"></span>Fetching ${
      escapeHtml(state.crate.name)
    } ${escapeHtml(left)} and ${escapeHtml(right)}&hellip;</div>`;
  statsEl.innerHTML = "";
  toolbarEl.hidden = true;
  sidebarEl.hidden = true;

  try {
    const [leftFiles, rightFiles] = await Promise.all([
      fetchCrateFiles(state.crate.name, left).then(stripTopDir),
      fetchCrateFiles(state.crate.name, right).then(stripTopDir),
    ]);
    if (token !== state.loadToken) return;
    buildFileList(leftFiles, rightFiles);
    renderAll();
  } catch (err) {
    if (token !== state.loadToken) return;
    diffEl.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
    toolbarEl.hidden = true;
    sidebarEl.hidden = true;
  }
}

function buildFileList(left, right) {
  const paths = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
  state.files = new Map();
  state.order = [];

  let i = 0;
  for (const path of paths) {
    const a = left[path];
    const b = right[path];
    const id = `f${i++}`;

    const aIsBin = a ? isBinary(a) : false;
    const bIsBin = b ? isBinary(b) : false;
    const isBin = aIsBin || bIsBin;

    let status;
    if (!a)      status = "added";
    else if (!b) status = "removed";
    else if (bytesEqual(a, b)) status = "unchanged";
    else status = "modified";

    const data = {
      id, path, status,
      isBinary: isBin,
      leftText: null,
      rightText: null,
      hunks: null,
      adds: 0,
      dels: 0,
      fullyExpanded: false,
      expandedGaps: new Set(),
      collapsed: DEFAULT_COLLAPSED.has(path) || status === "unchanged",
    };

    if (status !== "unchanged" && !isBin) {
      data.leftText = a ? decodeText(a) : "";
      data.rightText = b ? decodeText(b) : "";
      data.hunks = Diff.structuredPatch(
        "", "", data.leftText, data.rightText, "", "", { context: 3 },
      ).hunks;
      for (const h of data.hunks) {
        for (const line of h.lines) {
          if (line.startsWith("+")) data.adds++;
          else if (line.startsWith("-")) data.dels++;
        }
      }
    }

    state.files.set(id, data);
  }

  // Use the same walk order as the sidebar tree: directories (alphabetical)
  // first, then files (alphabetical), at every level.
  state.order = treeOrderIds(buildTree([...state.files.values()]));
}

function treeOrderIds(node) {
  const out = [];
  const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [, child] of dirs) out.push(...treeOrderIds(child));
  const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  for (const { file } of sortedFiles) out.push(file.id);
  return out;
}

function renderAll() {
  const items = [...state.files.values()];
  const counts = {
    total: items.length,
    added:     items.filter((f) => f.status === "added").length,
    removed:   items.filter((f) => f.status === "removed").length,
    modified:  items.filter((f) => f.status === "modified").length,
    unchanged: items.filter((f) => f.status === "unchanged").length,
  };

  statsEl.innerHTML = renderStats(counts);
  toolbarEl.hidden = false;

  const anyChanged = counts.added + counts.removed + counts.modified > 0;
  sidebarEl.hidden = !items.length;

  renderSidebar();

  if (!anyChanged) {
    diffEl.innerHTML = `<div class="empty">No differences between these versions.</div>`;
    return;
  }

  const html = state.order.map((id) => renderFile(id)).join("");
  diffEl.innerHTML = html;
  applyFilterToDiff();
}

function applyFilterToDiff() {
  const hide = state.filter === "changed";
  diffEl.querySelectorAll('.file[data-status="unchanged"]').forEach((el) => {
    el.style.display = hide ? "none" : "";
  });
}

function renderStats({ total, added, removed, modified, unchanged }) {
  const chips = [`<span class="chip"><span class="n">${total}</span>&nbsp;files</span>`];
  if (added)     chips.push(`<span class="chip added"><span class="n">+${added}</span> added</span>`);
  if (removed)   chips.push(`<span class="chip removed"><span class="n">-${removed}</span> removed</span>`);
  if (modified)  chips.push(`<span class="chip modified"><span class="n">~${modified}</span> modified</span>`);
  if (unchanged) chips.push(`<span class="chip"><span class="n">${unchanged}</span> unchanged</span>`);
  return chips.join("");
}

// ---------- file rendering ----------

const CHEVRON_SVG =
  `<svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;

function renderFile(id) {
  const f = state.files.get(id);
  const classes = ["file"];
  if (f.collapsed) classes.push("collapsed");

  const badges = [`<span class="badge ${f.status}">${f.status}</span>`];
  if (f.isBinary) badges.push(`<span class="badge binary">binary</span>`);

  const isDiffable = f.status !== "unchanged" && !f.isBinary;
  const counts = isDiffable && (f.adds || f.dels)
    ? `<span class="counts"><span class="add">+${f.adds}</span><span class="del">-${f.dels}</span></span>`
    : "";
  const fullToggle = isDiffable
    ? `<button type="button" class="file-toggle-full" data-file="${f.id}">${f.fullyExpanded ? "Collapse to hunks" : "Expand full"}</button>`
    : "";

  let body;
  if (f.status === "unchanged") {
    body = `<div class="file-note">File is identical in both versions.</div>`;
  } else if (f.isBinary) {
    body = `<div class="file-note">Binary file differs.</div>`;
  } else {
    body = renderDiffBody(f);
  }

  return `
    <div class="${classes.join(" ")}" id="${f.id}" data-status="${f.status}" data-path="${escapeHtml(f.path)}">
      <div class="file-header">
        ${CHEVRON_SVG}
        <span class="path">${escapeHtml(f.path)}</span>
        ${counts}
        ${fullToggle}
        ${badges.join("")}
      </div>
      <div class="file-body">${body}</div>
    </div>
  `;
}

function renderDiffBody(f) {
  const hunks = f.fullyExpanded
    ? Diff.structuredPatch("", "", f.leftText, f.rightText, "", "",
        { context: Number.MAX_SAFE_INTEGER }).hunks
    : f.hunks;

  if (!hunks || !hunks.length) return "";

  // When fully expanded we never show gap expanders.
  if (f.fullyExpanded) return hunks.map((h) => renderHunk(h)).join("");

  const rightLines = f.rightText.split("\n");
  const leftLines = f.leftText.split("\n");
  // Patch line counts don't include an empty trailing element.
  const leftMax = trimTrailingEmpty(leftLines).length;
  const rightMax = trimTrailingEmpty(rightLines).length;
  const out = [];

  // Gap indexing: gap[i] is the gap BEFORE hunks[i]. gap[hunks.length] is the
  // trailing gap after the last hunk.
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    const prev = hunks[i - 1];
    const gapOldStart = prev ? prev.oldStart + prev.oldLines : 1;
    const gapNewStart = prev ? prev.newStart + prev.newLines : 1;
    const gapLen = Math.min(h.oldStart - gapOldStart, h.newStart - gapNewStart);

    if (gapLen > 0 && f.expandedGaps.has(i)) {
      out.push(renderGapLines(gapOldStart, gapNewStart, gapLen, rightLines));
      out.push(renderHunk(h));
    } else if (gapLen > 0) {
      // Merge the gap expander into this hunk's header row.
      out.push(renderHunk(h, { fileId: f.id, gapIdx: i, gapLen }));
    } else {
      out.push(renderHunk(h));
    }
  }

  // Trailing gap (after last hunk) has no following hunk — render standalone.
  const last = hunks[hunks.length - 1];
  const tailOldStart = last.oldStart + last.oldLines;
  const tailNewStart = last.newStart + last.newLines;
  const tailLen = Math.min(leftMax - tailOldStart + 1, rightMax - tailNewStart + 1);
  if (tailLen > 0) {
    const tailIdx = hunks.length;
    if (f.expandedGaps.has(tailIdx)) {
      out.push(renderGapLines(tailOldStart, tailNewStart, tailLen, rightLines));
    } else {
      out.push(renderStandaloneGap(f.id, tailIdx, tailLen));
    }
  }

  return out.join("");
}

function trimTrailingEmpty(arr) {
  // `"a\nb\n".split("\n")` yields ["a", "b", ""] — drop the final sentinel.
  if (arr.length && arr[arr.length - 1] === "") return arr.slice(0, -1);
  return arr;
}

function renderHunk(h, expand) {
  const out = [];
  const title = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
  if (expand) {
    const noun = expand.gapLen === 1 ? "line" : "lines";
    out.push(
      `<div class="line hunk expandable" data-file="${expand.fileId}" data-gap="${expand.gapIdx}" title="Expand ${expand.gapLen} unchanged ${noun}">` +
        `<span class="ln">↕ @@</span>` +
        `<span class="lc">${escapeHtml(title)}` +
          ` <span class="gap-label">· Show ${expand.gapLen} unchanged ${noun}</span>` +
        `</span>` +
      `</div>`,
    );
  } else {
    out.push(
      `<div class="line hunk"><span class="ln">@@</span><span class="lc">${escapeHtml(title)}</span></div>`,
    );
  }
  let oldNo = h.oldStart, newNo = h.newStart;
  for (const line of h.lines) {
    if (line.startsWith("\\")) {
      out.push(`<div class="line note"><span class="ln"></span><span class="ln"></span><span class="lc">${escapeHtml(line)}</span></div>`);
      continue;
    }
    const content = line.slice(1);
    if (line[0] === "+") {
      out.push(`<div class="line add"><span class="ln"></span><span class="ln">${newNo}</span><span class="lc">+${escapeHtml(content)}</span></div>`);
      newNo++;
    } else if (line[0] === "-") {
      out.push(`<div class="line del"><span class="ln">${oldNo}</span><span class="ln"></span><span class="lc">-${escapeHtml(content)}</span></div>`);
      oldNo++;
    } else {
      out.push(`<div class="line"><span class="ln">${oldNo}</span><span class="ln">${newNo}</span><span class="lc"> ${escapeHtml(content)}</span></div>`);
      oldNo++; newNo++;
    }
  }
  return out.join("");
}

function renderGapLines(oldStart, newStart, length, rightLines) {
  const out = [];
  for (let i = 0; i < length; i++) {
    const oldNo = oldStart + i;
    const newNo = newStart + i;
    const content = rightLines[newNo - 1] ?? "";
    out.push(`<div class="line"><span class="ln">${oldNo}</span><span class="ln">${newNo}</span><span class="lc"> ${escapeHtml(content)}</span></div>`);
  }
  return out.join("");
}

function renderStandaloneGap(fileId, gapIdx, length) {
  const noun = length === 1 ? "line" : "lines";
  return `<div class="line gap" data-file="${fileId}" data-gap="${gapIdx}"><span class="ln">↕</span><span class="lc">Show ${length} unchanged ${noun}</span></div>`;
}

// ---------- sidebar ----------

function renderSidebar() {
  const items = state.order.map((id) => state.files.get(id));
  const filtered = state.filter === "changed"
    ? items.filter((f) => f.status !== "unchanged")
    : items;

  const totalChanged = items.filter((f) => f.status !== "unchanged").length;
  const totalAll = items.length;

  filterTabsEl.innerHTML = `
    <button class="filter-btn ${state.filter === "changed" ? "active" : ""}" data-filter="changed" type="button">Changed (${totalChanged})</button>
    <button class="filter-btn ${state.filter === "all"     ? "active" : ""}" data-filter="all"     type="button">All (${totalAll})</button>
  `;

  if (!filtered.length) {
    fileTreeEl.innerHTML = `<div class="empty" style="padding: 1rem 0.65rem;">No files.</div>`;
    return;
  }

  fileTreeEl.innerHTML = renderTree(buildTree(filtered), 0);
}

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node.dirs.has(name)) node.dirs.set(name, { dirs: new Map(), files: [] });
      node = node.dirs.get(name);
    }
    node.files.push({ name: parts[parts.length - 1], file: f });
  }
  return root;
}

function renderTree(node, depth) {
  const out = [];
  const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, child] of dirs) {
    out.push(
      `<div class="tree-dir" style="padding-left:${depth * 12 + 10}px">` +
      `<svg class="dir-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>` +
      `<span class="tree-name">${escapeHtml(name)}</span>` +
      `</div>`,
    );
    out.push(renderTree(child, depth + 1));
  }
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  for (const { name, file } of files) {
    const sym = statusSymbol(file.status);
    out.push(
      `<div class="tree-file" data-file="${file.id}" style="padding-left:${depth * 12 + 10}px" title="${escapeHtml(file.path)}">` +
      `<span class="tree-status ${file.status}">${sym}</span>` +
      `<span class="tree-name">${escapeHtml(name)}</span>` +
      `</div>`,
    );
  }
  return out.join("");
}

function statusSymbol(status) {
  return status === "added"    ? "+"
       : status === "removed"  ? "−"
       : status === "modified" ? "~"
       :                         "·";
}

// ---------- event handlers ----------

// Re-render a single file in place, preserving its scroll position.
function rerenderFile(id) {
  const old = document.getElementById(id);
  if (!old) return;
  const tpl = document.createElement("template");
  tpl.innerHTML = renderFile(id).trim();
  old.replaceWith(tpl.content.firstChild);
}

diffEl.addEventListener("click", (e) => {
  // Gap expander — both standalone gap rows and merged hunk-header rows.
  const gap = e.target.closest(".line.gap, .line.hunk.expandable");
  if (gap) {
    const f = state.files.get(gap.dataset.file);
    if (f) {
      f.expandedGaps.add(parseInt(gap.dataset.gap, 10));
      rerenderFile(f.id);
    }
    return;
  }

  // Fully expand / collapse back to hunks.
  const fullBtn = e.target.closest(".file-toggle-full");
  if (fullBtn) {
    e.stopPropagation();
    const f = state.files.get(fullBtn.dataset.file);
    if (f) {
      f.fullyExpanded = !f.fullyExpanded;
      if (f.fullyExpanded) f.collapsed = false;
      rerenderFile(f.id);
    }
    return;
  }

  // Header click → toggle collapse for the card.
  const header = e.target.closest(".file-header");
  if (header) {
    const fileEl = header.parentElement;
    fileEl.classList.toggle("collapsed");
    const f = state.files.get(fileEl.id);
    if (f) f.collapsed = fileEl.classList.contains("collapsed");
  }
});

sidebarEl.addEventListener("click", (e) => {
  const filterBtn = e.target.closest(".filter-btn");
  if (filterBtn) {
    state.filter = filterBtn.dataset.filter;
    renderSidebar();
    applyFilterToDiff();
    return;
  }
  const fileItem = e.target.closest(".tree-file");
  if (fileItem) {
    const id = fileItem.dataset.file;
    const el = document.getElementById(id);
    if (!el) return;
    // Auto-expand the target so the user actually sees content after scroll.
    if (el.classList.contains("collapsed")) {
      el.classList.remove("collapsed");
      const f = state.files.get(id);
      if (f) f.collapsed = false;
    }
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    sidebarEl.querySelectorAll(".tree-file.active").forEach((e) => e.classList.remove("active"));
    fileItem.classList.add("active");
  }
});

// ---------- toolbar actions ----------

copyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    const label = copyLinkBtn.querySelector(".label");
    const prev = label ? label.textContent : null;
    copyLinkBtn.classList.add("copied");
    if (label) label.textContent = "Copied";
    setTimeout(() => {
      copyLinkBtn.classList.remove("copied");
      if (label && prev) label.textContent = prev;
    }, 1200);
  } catch { /* insecure context */ }
});

expandAllBtn.addEventListener("click", () => {
  diffEl.querySelectorAll(".file").forEach((el) => {
    el.classList.remove("collapsed");
    const f = state.files.get(el.id);
    if (f) f.collapsed = false;
  });
});

collapseAllBtn.addEventListener("click", () => {
  diffEl.querySelectorAll(".file").forEach((el) => {
    el.classList.add("collapsed");
    const f = state.files.get(el.id);
    if (f) f.collapsed = true;
  });
});

topbarToggleBtn.addEventListener("click", () => {
  const collapsed = topbarEl.classList.toggle("collapsed");
  const label = topbarToggleBtn.querySelector(".label");
  if (label) label.textContent = collapsed ? "Show top" : "Hide top";
  topbarToggleBtn.title = collapsed ? "Show top" : "Hide top";
});

// ---------- helpers ----------

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isBinary(bytes) {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function decodeText(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

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
    if (parsed.left && parsed.left !== state.left) { state.left = parsed.left; leftSel.value = parsed.left; }
    if (parsed.right && parsed.right !== state.right) { state.right = parsed.right; rightSel.value = parsed.right; }
    loadDiff();
  } else {
    selectCrate(parsed.name, parsed.left, parsed.right);
  }
});

(async function init() {
  const parsed = parseHash();
  if (parsed?.name) await selectCrate(parsed.name, parsed.left, parsed.right);
  searchInput.focus();
})();
