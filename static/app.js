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
const viewSel        = $("view-version");
const compareCard    = $("compare-card");
const compareTabsEl  = $("compare-tabs");
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
const compactSummaryEl = $("compact-summary");
const themeToggleBtn = $("theme-toggle");

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
  selectedFile: null,  // file path persisted in URL
  selection: null,     // { start: {side, line}, end: {side, line} }
  mode: "compare",     // "compare" | "view" — tab-driven, independent of left/right equality
};

// Paths that default to collapsed — noisy but frequently regenerated files.
const DEFAULT_COLLAPSED = new Set(["Cargo.lock"]);

// Skip syntax highlighting for files above this raw-byte size, to avoid
// spending seconds on massive lockfiles.
const MAX_HIGHLIGHT_BYTES = 512 * 1024;

const EXT_TO_LANG = {
  rs: "rust",
  toml: "ini", lock: "ini", ini: "ini",
  md: "markdown", markdown: "markdown",
  json: "json",
  yaml: "yaml", yml: "yaml",
  sh: "bash", bash: "bash", zsh: "bash",
  py: "python",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  c: "c", h: "c",
  cpp: "cpp", hpp: "cpp", cc: "cpp", cxx: "cpp", hh: "cpp",
  go: "go",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  rb: "ruby",
  php: "php",
  swift: "swift",
  scala: "scala",
  cs: "csharp",
  xml: "xml", html: "xml", htm: "xml", svg: "xml",
  css: "css",
  scss: "scss", sass: "scss",
  less: "less",
  sql: "sql",
  pl: "perl", perl: "perl",
  r: "r",
  lua: "lua",
  m: "objectivec", mm: "objectivec",
  graphql: "graphql", gql: "graphql",
};

function detectLanguage(path) {
  const name = (path.split("/").pop() || "").toLowerCase();
  if (!name) return null;
  if (name === "cargo.toml" || name === "cargo.lock") return "ini";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_TO_LANG[name.slice(dot + 1)] || null;
}

function highlightLines(text, lang) {
  if (!lang || typeof hljs === "undefined") return null;
  if (!hljs.getLanguage || !hljs.getLanguage(lang)) return null;
  let html;
  try {
    html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
  return splitHighlightedByLine(html);
}

// Walk the highlight.js-produced HTML and split it by "\n" while keeping the
// span stack balanced — open spans are closed at line ends and re-opened on
// the next line so every line stands on its own and can be injected into a
// row without breaking styling.
function splitHighlightedByLine(html) {
  const lines = [];
  const stack = [];
  let cur = "";
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      const end = html.indexOf(">", i);
      if (end < 0) { cur += html.slice(i); break; }
      const tag = html.slice(i, end + 1);
      if (tag.startsWith("</")) {
        if (stack.length) stack.pop();
      } else if (!tag.endsWith("/>")) {
        stack.push(tag);
      }
      cur += tag;
      i = end + 1;
    } else if (ch === "\n") {
      for (let k = 0; k < stack.length; k++) cur += "</span>";
      lines.push(cur);
      cur = stack.join("");
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  lines.push(cur);
  return lines;
}

function lineHtml(f, side, lineNum, fallback) {
  const hl = side === "new" ? f.rightHighlighted : f.leftHighlighted;
  if (hl && hl[lineNum - 1] !== undefined) return hl[lineNum - 1];
  return escapeHtml(fallback ?? "");
}

// ---------- URL hash ----------

function writeHash() {
  if (!state.crate) return;
  let h = state.crate.name;
  if (state.left && state.right) {
    // Single-version view collapses to "#crate/ver".
    h += state.left === state.right
      ? `/${state.left}`
      : `/${state.left}...${state.right}`;
  }
  if (state.selectedFile) {
    h += `/${state.selectedFile}`;
    if (state.selection) {
      const { start, end } = state.selection;
      const sp = start.side === "old" ? "R" : "L";
      const ep = end.side === "old" ? "R" : "L";
      if (start.side === end.side && start.line === end.line) {
        h += `?${sp}${start.line}`;
      } else {
        h += `?${sp}${start.line}-${ep}${end.line}`;
      }
    }
  }
  if (location.hash.slice(1) !== h) history.replaceState(null, "", `#${h}`);
}

function parseHash() {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash < 0) return { name: raw, left: null, right: null, file: null, range: null };
  const name = raw.slice(0, slash);
  const rest = raw.slice(slash + 1);

  // The version portion runs up to the next slash. "old...new" means compare;
  // a plain version is a single-version view (old == new).
  const nextSlash = rest.indexOf("/");
  const verPart = nextSlash < 0 ? rest : rest.slice(0, nextSlash);
  const afterVer = nextSlash < 0 ? "" : rest.slice(nextSlash + 1);

  let left, right;
  const sep = verPart.indexOf("...");
  if (sep < 0) {
    left = right = verPart;
  } else {
    left = verPart.slice(0, sep);
    right = verPart.slice(sep + 3);
  }

  let file = null, range = null;
  if (afterVer) {
    const q = afterVer.indexOf("?");
    if (q < 0) file = afterVer;
    else {
      file = afterVer.slice(0, q);
      range = parseLineRange(afterVer.slice(q + 1));
    }
  }
  return { name, left, right, file, range };
}

function parseLineRange(s) {
  // Accepts L<n>, R<n>, or mixed-side ranges like L10-L20, R5-R15, L10-R25.
  const m = s.match(/^([LR])(\d+)(?:-([LR])(\d+))?$/);
  if (!m) return null;
  const sideOf = (c) => (c === "R" ? "old" : "new");
  const start = { side: sideOf(m[1]), line: parseInt(m[2], 10) };
  const end = m[3]
    ? { side: sideOf(m[3]), line: parseInt(m[4], 10) }
    : { ...start };
  return { start, end };
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

async function selectCrate(name, preferredLeft = null, preferredRight = null, preferredFile = null, preferredRange = null) {
  resultsEl.hidden = true;
  searchInput.value = name;
  diffEl.innerHTML =
    `<div class="loading"><span class="spinner"></span>Loading ${escapeHtml(name)}&hellip;</div>`;
  statsEl.innerHTML = "";
  toolbarEl.hidden = true;
  sidebarEl.hidden = true;
  state.selectedFile = preferredFile;
  state.selection = preferredRange;

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
    // A URL like #crate/ver is a single-version view; anything else starts in
    // compare mode, even if the two versions happen to match.
    state.mode = (preferredLeft && preferredRight && preferredLeft === preferredRight) ? "view" : "compare";

    paintCompare();
    writeHash();
    await loadDiff();
    if (state.selectedFile) applyFileNavigation();
  } catch (err) {
    diffEl.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
}

function paintCompare() {
  compareEl.hidden = false;
  crateNameEl.textContent = state.crate.name;
  crateLinkEl.href = `https://crates.io/crates/${state.crate.name}`;

  const opts = state.versions.map((v) => {
    const date = typeof v.created_at === "string" ? v.created_at.slice(0, 10) : "";
    let label = v.num;
    if (date) label += `  ·  ${date}`;
    if (v.yanked) label += "  (yanked)";
    const cls = v.yanked ? ' class="yanked"' : "";
    return `<option value="${escapeHtml(v.num)}"${cls}>${escapeHtml(label)}</option>`;
  }).join("");
  leftSel.innerHTML = opts;
  rightSel.innerHTML = opts;
  viewSel.innerHTML = opts;
  leftSel.value = state.left;
  rightSel.value = state.right;
  viewSel.value = state.right;
  applyMode();
  updateCompactSummary();
}

// Compare vs. view-source mode. Explicit — only changed by tab clicks or by
// loading a URL, so picking same old/new in compare mode doesn't silently
// flip the UI into view-source.
function applyMode() {
  compareCard.dataset.mode = state.mode;
  compareTabsEl.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === state.mode);
  });
  // Belt and braces: force visibility via inline styles so this works even if
  // the [data-mode] CSS rule is stale in a browser cache.
  compareCard.querySelectorAll(".versions.mode-compare").forEach((el) => {
    el.style.display = state.mode === "compare" ? "" : "none";
  });
  compareCard.querySelectorAll(".versions.mode-view").forEach((el) => {
    el.style.display = state.mode === "view" ? "" : "none";
  });
  if (state.mode === "view") viewSel.value = state.right;
}

function updateCompactSummary() {
  if (!compactSummaryEl) return;
  if (!state.crate || !state.left || !state.right) {
    compactSummaryEl.innerHTML = "";
    return;
  }
  const name = `<span class="cs-name">${escapeHtml(state.crate.name)}</span>`;
  if (state.left === state.right) {
    compactSummaryEl.innerHTML = `${name}<span class="cs-ver">${escapeHtml(state.right)}</span>`;
  } else {
    compactSummaryEl.innerHTML = name +
      `<span class="cs-ver">${escapeHtml(state.left)}</span>` +
      `<span class="cs-arrow">→</span>` +
      `<span class="cs-ver">${escapeHtml(state.right)}</span>`;
  }
}

leftSel.addEventListener("change", async () => {
  state.left = leftSel.value;
  updateCompactSummary();
  writeHash();
  await loadDiff();
});
rightSel.addEventListener("change", async () => {
  state.right = rightSel.value;
  updateCompactSummary();
  writeHash();
  await loadDiff();
});
viewSel.addEventListener("change", async () => {
  state.left = state.right = viewSel.value;
  leftSel.value = state.left;
  rightSel.value = state.right;
  updateCompactSummary();
  writeHash();
  await loadDiff();
});

compareTabsEl.addEventListener("click", async (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  const wanted = btn.dataset.mode;
  if (wanted !== "view" && wanted !== "compare") return;

  const before = { mode: state.mode, left: state.left, right: state.right };

  if (wanted === "view") {
    state.mode = "view";
    state.left = state.right;
    leftSel.value = state.left;
  } else {
    // Compare: keep the current "new" (state.right) and always set "old" to
    // the version immediately prior to it.
    state.mode = "compare";
    const live = state.versions.filter((v) => !v.yanked);
    const idx = live.findIndex((v) => v.num === state.right);
    let newLeft = idx >= 0 ? live[idx + 1]?.num : undefined;
    if (!newLeft) newLeft = live.find((v) => v.num !== state.right)?.num;
    if (newLeft) {
      state.left = newLeft;
      leftSel.value = newLeft;
    }
  }

  const changed = before.mode !== state.mode
               || before.left !== state.left
               || before.right !== state.right;
  applyMode();
  updateCompactSummary();
  writeHash();
  if (changed) await loadDiff();
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

  const sameVersion = left === right;
  const loadingText = sameVersion
    ? `Fetching ${escapeHtml(state.crate.name)} ${escapeHtml(left)}&hellip;`
    : `Fetching ${escapeHtml(state.crate.name)} ${escapeHtml(left)} and ${escapeHtml(right)}&hellip;`;
  diffEl.innerHTML = `<div class="loading"><span class="spinner"></span>${loadingText}</div>`;
  statsEl.innerHTML = "";
  toolbarEl.hidden = true;
  sidebarEl.hidden = true;

  try {
    const leftPromise = fetchCrateFiles(state.crate.name, left).then(stripTopDir);
    const rightPromise = sameVersion
      ? leftPromise
      : fetchCrateFiles(state.crate.name, right).then(stripTopDir);
    const [leftFiles, rightFiles] = await Promise.all([leftPromise, rightPromise]);
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
  const sameVersion = state.left === state.right;

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

    // In single-version (view source) mode we want the whole tree browsable
    // up front, with files expanded so their contents are visible. Cargo.lock
    // stays collapsed by default regardless because it's noisy.
    const isLock = DEFAULT_COLLAPSED.has(path);
    const data = {
      id, path, status,
      isBinary: isBin,
      leftText: null,
      rightText: null,
      hunks: null,
      adds: 0,
      dels: 0,
      fullyExpanded: sameVersion && !isBin && status === "unchanged" && !isLock,
      expandedGaps: new Set(),
      collapsed: isLock || (status === "unchanged" && !sameVersion),
    };

    if (!isBin) {
      data.leftText = a ? decodeText(a) : "";
      data.rightText = b ? decodeText(b) : "";
      if (status !== "unchanged") {
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
      const lang = detectLanguage(path);
      if (lang) {
        if (data.leftText.length && data.leftText.length <= MAX_HIGHLIGHT_BYTES) {
          data.leftHighlighted = highlightLines(data.leftText, lang);
        }
        if (data.rightText.length && data.rightText.length <= MAX_HIGHLIGHT_BYTES) {
          data.rightHighlighted = status === "unchanged"
            ? data.leftHighlighted
            : highlightLines(data.rightText, lang);
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
  applyMode();

  const anyChanged = counts.added + counts.removed + counts.modified > 0;
  // If nothing changed (view source, or genuinely identical versions) default
  // the sidebar filter to "all" so the user sees every file.
  if (!anyChanged) state.filter = "all";
  sidebarEl.hidden = !items.length;

  renderSidebar();

  if (!items.length) {
    diffEl.innerHTML = `<div class="empty">No files.</div>`;
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
  const expandable = !f.isBinary;
  let fullToggle = "";
  if (expandable) {
    const label = f.status === "unchanged"
      ? (f.fullyExpanded ? "Hide content" : "Show content")
      : (f.fullyExpanded ? "Collapse to hunks" : "Expand full");
    fullToggle = `<button type="button" class="file-toggle-full" data-file="${f.id}">${label}</button>`;
  }

  let body;
  if (f.isBinary) {
    body = `<div class="file-note">Binary file differs.</div>`;
  } else if (f.status === "unchanged") {
    body = f.fullyExpanded
      ? renderUnchangedBody(f)
      : `<div class="file-note">File is identical in both versions.</div>`;
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
  if (f.fullyExpanded) return hunks.map((h) => renderHunk(f, h)).join("");

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
    const expanded = f.expandedGaps.has(i);

    if (gapLen > 0) {
      if (expanded) {
        out.push(renderGapLines(f, gapOldStart, gapNewStart, gapLen));
      }
      out.push(renderHunk(f, h, { fileId: f.id, gapIdx: i, gapLen, expanded }));
    } else {
      out.push(renderHunk(f, h));
    }
  }

  // Trailing gap (after last hunk) has no following hunk — render standalone.
  const last = hunks[hunks.length - 1];
  const tailOldStart = last.oldStart + last.oldLines;
  const tailNewStart = last.newStart + last.newLines;
  const tailLen = Math.min(leftMax - tailOldStart + 1, rightMax - tailNewStart + 1);
  if (tailLen > 0) {
    const tailIdx = hunks.length;
    const expanded = f.expandedGaps.has(tailIdx);
    if (expanded) {
      out.push(renderGapLines(f, tailOldStart, tailNewStart, tailLen));
    }
    out.push(renderStandaloneGap(f.id, tailIdx, tailLen, expanded));
  }

  return out.join("");
}

function trimTrailingEmpty(arr) {
  // `"a\nb\n".split("\n")` yields ["a", "b", ""] — drop the final sentinel.
  if (arr.length && arr[arr.length - 1] === "") return arr.slice(0, -1);
  return arr;
}

function renderHunk(f, h, expand) {
  const out = [];
  const title = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
  if (expand) {
    const noun = expand.gapLen === 1 ? "line" : "lines";
    const action = expand.expanded ? "Hide" : "Show";
    out.push(
      `<div class="line hunk expandable" data-file="${expand.fileId}" data-gap="${expand.gapIdx}" title="${action} ${expand.gapLen} unchanged ${noun}">` +
        `<span class="ln">↕ @@</span>` +
        `<span class="lc">${escapeHtml(title)}` +
          ` <span class="gap-label">· ${action} ${expand.gapLen} unchanged ${noun}</span>` +
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
      const html = lineHtml(f, "new", newNo, content);
      out.push(`<div class="line add" data-new-line="${newNo}"><span class="ln"></span><span class="ln">${newNo}</span><span class="lc">+${html}</span></div>`);
      newNo++;
    } else if (line[0] === "-") {
      const html = lineHtml(f, "old", oldNo, content);
      out.push(`<div class="line del" data-old-line="${oldNo}"><span class="ln">${oldNo}</span><span class="ln"></span><span class="lc">-${html}</span></div>`);
      oldNo++;
    } else {
      const html = lineHtml(f, "new", newNo, content);
      out.push(`<div class="line" data-old-line="${oldNo}" data-new-line="${newNo}"><span class="ln">${oldNo}</span><span class="ln">${newNo}</span><span class="lc"> ${html}</span></div>`);
      oldNo++; newNo++;
    }
  }
  return out.join("");
}

function renderUnchangedBody(f) {
  // Both sides are identical; render the full file with matching line numbers.
  const lines = trimTrailingEmpty(f.rightText.split("\n"));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const html = lineHtml(f, "new", n, lines[i]);
    out.push(
      `<div class="line" data-old-line="${n}" data-new-line="${n}"><span class="ln">${n}</span><span class="ln">${n}</span><span class="lc"> ${html}</span></div>`,
    );
  }
  return out.join("");
}

function renderGapLines(f, oldStart, newStart, length) {
  const rightLines = f.rightText.split("\n");
  const out = [];
  for (let i = 0; i < length; i++) {
    const oldNo = oldStart + i;
    const newNo = newStart + i;
    const html = lineHtml(f, "new", newNo, rightLines[newNo - 1]);
    out.push(`<div class="line" data-old-line="${oldNo}" data-new-line="${newNo}"><span class="ln">${oldNo}</span><span class="ln">${newNo}</span><span class="lc"> ${html}</span></div>`);
  }
  return out.join("");
}

function renderStandaloneGap(fileId, gapIdx, length, expanded) {
  const noun = length === 1 ? "line" : "lines";
  const action = expanded ? "Hide" : "Show";
  return `<div class="line gap" data-file="${fileId}" data-gap="${gapIdx}"><span class="ln">↕</span><span class="lc">${action} ${length} unchanged ${noun}</span></div>`;
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
  // Clicking toggles expansion so the user can collapse it back.
  const gap = e.target.closest(".line.gap, .line.hunk.expandable");
  if (gap) {
    const f = state.files.get(gap.dataset.file);
    if (f) {
      const idx = parseInt(gap.dataset.gap, 10);
      if (f.expandedGaps.has(idx)) f.expandedGaps.delete(idx);
      else f.expandedGaps.add(idx);
      rerenderFile(f.id);
      applyHighlight();
    }
    return;
  }

  // Fully expand / collapse back to hunks. Collapsing resets all gap
  // expansions so "Collapse to hunks" genuinely restores the hunk view.
  const fullBtn = e.target.closest(".file-toggle-full");
  if (fullBtn) {
    e.stopPropagation();
    const f = state.files.get(fullBtn.dataset.file);
    if (f) {
      f.fullyExpanded = !f.fullyExpanded;
      if (f.fullyExpanded) f.collapsed = false;
      else f.expandedGaps.clear();
      rerenderFile(f.id);
      applyHighlight();
    }
    return;
  }

  // Click on a line-number gutter → select that line (Shift to extend range).
  // First gutter = old side, second gutter = new side.
  const lnEl = e.target.closest(".ln");
  if (lnEl) {
    const lineEl = lnEl.closest(".line[data-new-line], .line[data-old-line]");
    if (lineEl) {
      const gutters = lineEl.querySelectorAll(".ln");
      const idx = [...gutters].indexOf(lnEl);
      let side = null, anchor = null;
      if (idx === 0 && lineEl.dataset.oldLine) {
        side = "old";
        anchor = parseInt(lineEl.dataset.oldLine, 10);
      } else if (idx === 1 && lineEl.dataset.newLine) {
        side = "new";
        anchor = parseInt(lineEl.dataset.newLine, 10);
      }
      if (side) {
        e.stopPropagation();
        handleLineSelect(lineEl, side, anchor, e.shiftKey);
        return;
      }
    }
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

// ---------- line selection ----------

function handleLineSelect(lineEl, side, anchor, extend) {
  const fileEl = lineEl.closest(".file");
  if (!fileEl) return;
  const f = state.files.get(fileEl.id);
  if (!f) return;
  const endpoint = { side, line: anchor };
  const sameFile = state.selectedFile === f.path;
  if (extend && sameFile && state.selection) {
    // Keep the anchor (start) fixed, move head (end) to the clicked endpoint.
    state.selection = { start: state.selection.start, end: endpoint };
  } else {
    state.selectedFile = f.path;
    state.selection = { start: endpoint, end: endpoint };
  }
  applyHighlight();
  writeHash();
}

function findLineByEndpoint(fileEl, endpoint) {
  const attr = endpoint.side === "old" ? "data-old-line" : "data-new-line";
  return fileEl.querySelector(`.line[${attr}="${endpoint.line}"]`);
}

function applyHighlight() {
  diffEl.querySelectorAll(".line.selected").forEach((el) => el.classList.remove("selected"));
  if (!state.selection || !state.selectedFile) return;
  const f = [...state.files.values()].find((x) => x.path === state.selectedFile);
  if (!f) return;
  const fileEl = document.getElementById(f.id);
  if (!fileEl) return;
  const { start, end } = state.selection;
  const startEl = findLineByEndpoint(fileEl, start);
  const endEl = findLineByEndpoint(fileEl, end);
  if (!startEl && !endEl) return;
  if (!startEl || !endEl) {
    // One endpoint isn't rendered (inside a collapsed gap). Highlight only
    // what we can find rather than nothing.
    (startEl || endEl).classList.add("selected");
    return;
  }
  if (startEl === endEl) {
    startEl.classList.add("selected");
    return;
  }
  const pos = startEl.compareDocumentPosition(endEl);
  const [first, last] = pos & Node.DOCUMENT_POSITION_FOLLOWING
    ? [startEl, endEl]
    : [endEl, startEl];
  let el = first;
  while (el) {
    if (el.classList?.contains("line") && (el.dataset.newLine || el.dataset.oldLine)) {
      el.classList.add("selected");
    }
    if (el === last) break;
    el = el.nextElementSibling;
  }
}

function applyFileNavigation() {
  const f = [...state.files.values()].find((x) => x.path === state.selectedFile);
  if (!f) return;
  if (state.selection) {
    const { start, end } = state.selection;
    if (f.status === "unchanged" && !f.isBinary) {
      // Unchanged files don't render lines until "Show content" is toggled,
      // so force it on so the selection can land somewhere.
      f.fullyExpanded = true;
    } else if (start.side === end.side) {
      expandGapsCoveringRange(f, {
        side: start.side,
        a: Math.min(start.line, end.line),
        b: Math.max(start.line, end.line),
      });
    } else {
      // Mixed-side range — fully expand the file so both endpoints render.
      f.fullyExpanded = true;
    }
    rerenderFile(f.id);
  }
  const el = document.getElementById(f.id);
  if (!el) return;
  if (el.classList.contains("collapsed")) {
    el.classList.remove("collapsed");
    f.collapsed = false;
  }
  if (state.selection) {
    applyHighlight();
    const target = findLineByEndpoint(el, state.selection.start)
                || findLineByEndpoint(el, state.selection.end);
    if (target) { target.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
  }
  el.scrollIntoView({ block: "start", behavior: "smooth" });
}

// Expand any gaps that fall within the selected line range so the highlighted
// lines are actually visible when navigating from a shared URL. Gap line
// numbering is unchanged on both sides, so we can use either depending on the
// selection side.
function expandGapsCoveringRange(f, range) {
  if (!f.hunks || !f.hunks.length) return;
  const useOld = range.side === "old";
  const leftMax = trimTrailingEmpty(f.leftText.split("\n")).length;
  const rightMax = trimTrailingEmpty(f.rightText.split("\n")).length;
  for (let i = 0; i < f.hunks.length; i++) {
    const h = f.hunks[i];
    const prev = f.hunks[i - 1];
    const gapOldStart = prev ? prev.oldStart + prev.oldLines : 1;
    const gapNewStart = prev ? prev.newStart + prev.newLines : 1;
    const gapLen = Math.min(h.oldStart - gapOldStart, h.newStart - gapNewStart);
    if (gapLen <= 0) continue;
    const start = useOld ? gapOldStart : gapNewStart;
    const end = start + gapLen - 1;
    if (range.b >= start && range.a <= end) f.expandedGaps.add(i);
  }
  const last = f.hunks[f.hunks.length - 1];
  const tailOldStart = last.oldStart + last.oldLines;
  const tailNewStart = last.newStart + last.newLines;
  const tailLen = Math.min(leftMax - tailOldStart + 1, rightMax - tailNewStart + 1);
  if (tailLen > 0) {
    const start = useOld ? tailOldStart : tailNewStart;
    const end = start + tailLen - 1;
    if (range.b >= start && range.a <= end) f.expandedGaps.add(f.hunks.length);
  }
}

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
    const f = state.files.get(id);
    if (!f) return;
    const el = document.getElementById(id);
    if (!el) return;
    if (el.classList.contains("collapsed")) {
      el.classList.remove("collapsed");
      f.collapsed = false;
    }
    // Selecting a file from the sidebar clears any active line selection and
    // records the file in the URL.
    state.selectedFile = f.path;
    state.selection = null;
    applyHighlight();
    writeHash();
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

// ---------- theme toggle ----------

function storedTheme() {
  try {
    const v = localStorage.getItem("crates-diff-theme");
    return (v === "light" || v === "dark") ? v : null;
  } catch { return null; }
}

function currentTheme() {
  return storedTheme() ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function updateThemeToggleTitle() {
  const t = currentTheme();
  themeToggleBtn.title = t === "dark" ? "Switch to light theme" : "Switch to dark theme";
}

themeToggleBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const next = currentTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem("crates-diff-theme", next); } catch { /* private mode / quota */ }
  document.documentElement.setAttribute("data-theme", next);
  updateThemeToggleTitle();
  console.log("[crates-diff] theme →", next, "| data-theme now:", document.documentElement.getAttribute("data-theme"));
});

// Keep the tooltip in sync if the OS theme changes while in "auto" mode.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!storedTheme()) updateThemeToggleTitle();
});

updateThemeToggleTitle();

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
  const sameCrate = state.crate && state.crate.name === parsed.name;
  const sameVersions = sameCrate && parsed.left === state.left && parsed.right === state.right;
  if (sameVersions) {
    // Just navigation: update file + range without reloading tarballs.
    state.selectedFile = parsed.file;
    state.selection = parsed.range;
    if (parsed.file) applyFileNavigation();
    else applyHighlight();
  } else if (sameCrate) {
    if (parsed.left) { state.left = parsed.left; leftSel.value = parsed.left; }
    if (parsed.right) { state.right = parsed.right; rightSel.value = parsed.right; }
    state.selectedFile = parsed.file;
    state.selection = parsed.range;
    state.mode = (parsed.left && parsed.right && parsed.left === parsed.right) ? "view" : "compare";
    applyMode();
    loadDiff().then(() => { if (parsed.file) applyFileNavigation(); });
  } else {
    selectCrate(parsed.name, parsed.left, parsed.right, parsed.file, parsed.range);
  }
});

(async function init() {
  const parsed = parseHash();
  if (parsed?.name) await selectCrate(parsed.name, parsed.left, parsed.right, parsed.file, parsed.range);
  searchInput.focus();
})();
