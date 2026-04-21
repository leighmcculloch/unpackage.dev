// unpackage.dev — all heavy lifting runs in the browser.
// The Deno server only proxies crates.io (CORS + User-Agent).

const $ = (id) => document.getElementById(id);

// --- DOM
const searchInput    = $("search");
const resultsEl      = $("results");
const compareEl      = $("compare");
const crateLinkEl    = $("crate-link");
const leftSel        = $("left-version");
const rightSel       = $("right-version");
const statsEl        = $("stats");
const diffEl         = $("diff");
const toolbarEl      = $("toolbar");
const expandAllBtn   = $("expand-all");
const collapseAllBtn = $("collapse-all");
const sidebarEl      = $("sidebar");
const fileTreeEl     = $("file-tree");
const filterTabsEl   = $("filter-tabs");
const downloadBtn    = $("download-btn");
const diffPaneEl     = $("diff-pane");
const topbarEl       = document.querySelector(".topbar");
const topbarToggleBtn = $("topbar-toggle");
const compactSummaryEl = $("compact-summary");
const themeToggleBtn = $("theme-toggle");
const registrySel    = $("registry-sel");

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
  registry: "crates.io", // "crates.io" | "npmjs.com" | ...
};

const KNOWN_REGISTRIES = new Set([
  "crates.io",
  "npmjs.com",
  "jsr.io",
  "proxy.golang.org",
  "rubygems.org",
  "pypi.org",
  "nuget.org",
  "hex.pm",
  "pub.dev",
]);

// Go module path escaping (uppercase → "!" + lowercase). Used to line up the
// module prefix inside a module zip with the escaped form in the archive.
function goEscape(s) {
  return s.replace(/[A-Z]/g, (c) => "!" + c.toLowerCase());
}

function apiSearchUrl(registry, q, per) {
  return `/api/registry/${registry}/search?q=${encodeURIComponent(q)}&per_page=${encodeURIComponent(per)}`;
}
function apiPackageUrl(registry, name) {
  // Names may contain "/" (scoped npm packages) — leave slashes literal so
  // they become part of the path, matching the server's routing.
  return `/api/registry/${registry}/package/${name}`;
}
function apiDownloadUrl(registry, name, version) {
  return `/api/registry/${registry}/download/${name}/${encodeURIComponent(version)}`;
}

function archiveExt(registry) {
  switch (registry) {
    case "crates.io":         return ".crate";
    case "npmjs.com":         return ".tgz";
    case "jsr.io":            return ".tgz";
    case "proxy.golang.org":  return ".zip";
    case "rubygems.org":      return ".gem";
    case "pypi.org":          return ".tar.gz";
    case "nuget.org":         return ".nupkg";
    case "hex.pm":            return ".tar";
    case "pub.dev":           return ".tar.gz";
    default:                  return ".archive";
  }
}

// How the archive bytes should be parsed before we see files.
function archiveFormat(registry) {
  switch (registry) {
    case "proxy.golang.org":
    case "nuget.org":
      return "zip";
    case "rubygems.org": return "gem";  // plain tar with data.tar.gz inside
    case "hex.pm":       return "hex";  // plain tar with contents.tar.gz inside
    default:             return "targz"; // crates.io, npmjs.com, pypi.org, pub.dev
  }
}

function safeFilename(name) {
  return name.replace(/^@/, "").replace(/\//g, "-");
}

function registryPackageUrl(registry, name) {
  switch (registry) {
    case "crates.io":         return `https://crates.io/crates/${name}`;
    case "npmjs.com":         return `https://www.npmjs.com/package/${name}`;
    case "jsr.io":            return `https://jsr.io/${name}`;
    // Archives come from proxy.golang.org; pkg.go.dev is where users read Go
    // module docs — point the "open on registry" link there.
    case "proxy.golang.org":  return `https://pkg.go.dev/${name}`;
    case "rubygems.org":      return `https://rubygems.org/gems/${name}`;
    case "pypi.org":          return `https://pypi.org/project/${name}/`;
    case "nuget.org":         return `https://www.nuget.org/packages/${name}`;
    case "hex.pm":            return `https://hex.pm/packages/${name}`;
    case "pub.dev":           return `https://pub.dev/packages/${name}`;
    default:                  return "#";
  }
}

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
  let h = `${state.registry}/${state.crate.name}`;
  if (state.left && state.right) {
    h += state.left === state.right
      ? `@${state.left}`
      : `@${state.left}...${state.right}`;
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

  // Registry is the first "/"-segment; default to crates.io for older URLs
  // that omit it.
  const firstSlash = raw.indexOf("/");
  const firstSegment = firstSlash < 0 ? raw : raw.slice(0, firstSlash);
  let registry, rest;
  if (KNOWN_REGISTRIES.has(firstSegment)) {
    registry = firstSegment;
    rest = firstSlash < 0 ? "" : raw.slice(firstSlash + 1);
  } else {
    registry = "crates.io";
    rest = raw;
  }
  if (!rest) return { registry, name: null, left: null, right: null, file: null, range: null };

  // Split name @ version. Names never contain "@" except at position 0 (npm
  // scope), so find the first "@" that isn't at the start of the remainder.
  const atStart = rest.startsWith("@") ? 1 : 0;
  const atIdx = rest.indexOf("@", atStart);
  let name, afterName;
  if (atIdx < 0) {
    name = rest;
    afterName = "";
  } else {
    name = rest.slice(0, atIdx);
    afterName = rest.slice(atIdx + 1);
  }

  let left = null, right = null, file = null, range = null;
  if (afterName) {
    const vs = afterName.indexOf("/");
    const verPart = vs < 0 ? afterName : afterName.slice(0, vs);
    const afterVer = vs < 0 ? "" : afterName.slice(vs + 1);
    const sep = verPart.indexOf("...");
    if (sep < 0) left = right = verPart;
    else {
      left = verPart.slice(0, sep);
      right = verPart.slice(sep + 3);
    }
    if (afterVer) {
      const q = afterVer.indexOf("?");
      if (q < 0) file = afterVer;
      else {
        file = afterVer.slice(0, q);
        range = parseLineRange(afterVer.slice(q + 1));
      }
    }
  }

  return { registry, name, left, right, file, range };
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
    const res = await fetch(apiSearchUrl(state.registry, q, "10"));
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
    const res = await fetch(apiPackageUrl(state.registry, name));
    if (!res.ok) throw new Error(`package not found: ${name}`);
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
    if (state.selectedFile) applyFileNavigation();
  } catch (err) {
    diffEl.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
}

function paintCompare() {
  compareEl.hidden = false;
  crateLinkEl.hidden = false;
  crateLinkEl.href = registryPackageUrl(state.registry, state.crate.name);
  crateLinkEl.textContent = `${state.registry} →`;

  const versionOpts = state.versions.map((v) => {
    const date = typeof v.created_at === "string" ? v.created_at.slice(0, 10) : "";
    let label = v.num;
    if (date) label += `  ·  ${date}`;
    if (v.yanked) label += "  (yanked)";
    const cls = v.yanked ? ' class="yanked"' : "";
    return `<option value="${escapeHtml(v.num)}"${cls}>${escapeHtml(label)}</option>`;
  }).join("");

  // "None" on the left means: don't compare, just view the right-side source.
  leftSel.innerHTML =
    `<option value="">None (just view source)</option>` + versionOpts;
  rightSel.innerHTML = versionOpts;

  leftSel.value = state.left === state.right ? "" : state.left;
  rightSel.value = state.right;

  updateCompactSummary();
}

function updateCompactSummary() {
  if (!compactSummaryEl) return;
  if (!state.crate || !state.left || !state.right) {
    compactSummaryEl.innerHTML = "";
    return;
  }
  const reg = `<span class="cs-registry">${escapeHtml(state.registry)}</span>`;
  const name = `<span class="cs-name">${escapeHtml(state.crate.name)}</span>`;
  if (state.left === state.right) {
    compactSummaryEl.innerHTML =
      `${reg}${name}<span class="cs-ver">${escapeHtml(state.right)}</span>`;
  } else {
    compactSummaryEl.innerHTML = reg + name +
      `<span class="cs-ver">${escapeHtml(state.left)}</span>` +
      `<span class="cs-arrow">→</span>` +
      `<span class="cs-ver">${escapeHtml(state.right)}</span>`;
  }
}

leftSel.addEventListener("change", async () => {
  state.left = leftSel.value === "" ? state.right : leftSel.value;
  updateCompactSummary();
  writeHash();
  await loadDiff();
});

rightSel.addEventListener("change", async () => {
  const wasViewSource = leftSel.value === "";
  state.right = rightSel.value;
  if (wasViewSource) state.left = state.right;
  updateCompactSummary();
  writeHash();
  await loadDiff();
});

// ---------- tarball fetch + parse (cached) ----------

function parseZip(buf) {
  const files = {};
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  const minEocd = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i; break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const total = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let p = cdOffset;
  for (let e = 0; e < total; e++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const compMethod = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const lho = view.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;

    if (view.getUint32(lho, true) !== 0x04034b50) continue;
    const lNameLen = view.getUint16(lho + 26, true);
    const lExtraLen = view.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);

    let bytes;
    if (compMethod === 0) bytes = data.slice();
    else if (compMethod === 8) {
      try { bytes = pako.inflateRaw(data); } catch { continue; }
    } else continue;
    files[name] = bytes;
  }
  return files;
}

function stripArchivePrefix(files, registry, name, version) {
  if (registry === "proxy.golang.org") {
    // Go module zips nest content under {escaped-module}@{version}/… with
    // multiple slashes, which the generic detector below can't handle.
    const prefix = `${goEscape(name)}@${version}/`;
    const out = {};
    for (const [p, b] of Object.entries(files)) {
      if (p.startsWith(prefix)) out[p.slice(prefix.length)] = b;
    }
    return out;
  }
  return stripCommonTopDir(files);
}

// If every path shares the same top-level directory, strip it. Handles
// crates.io ("{name}-{version}/"), npm ("package/"), pypi sdists
// ("{name}-{version}/"), and leaves nuget/rubygems/hex/pub.dev alone since
// they don't have a uniform root.
function stripCommonTopDir(files) {
  const paths = Object.keys(files);
  if (!paths.length) return files;
  const slash = paths[0].indexOf("/");
  if (slash < 0) return files;
  const prefix = paths[0].slice(0, slash + 1);
  if (!paths.every((p) => p.startsWith(prefix))) return files;
  const out = {};
  for (const p of paths) out[p.slice(prefix.length)] = files[p];
  return out;
}

async function fetchCrateFiles(name, version) {
  const url = apiDownloadUrl(state.registry, name, version);
  let response;
  let cache = null;
  try { cache = await caches.open("unpackage-v1"); response = await cache.match(url); }
  catch { /* Cache API unavailable */ }
  if (!response) {
    response = await fetch(url);
    if (!response.ok) throw new Error(`download failed: ${name} ${version}`);
    if (cache) { try { await cache.put(url, response.clone()); } catch { /* ignore */ } }
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  const fmt = archiveFormat(state.registry);
  if (fmt === "zip") return parseZip(buf);
  if (fmt === "gem") return extractGem(parseTar(buf));
  if (fmt === "hex") return extractHex(parseTar(buf));
  // Default: gzipped tar (crates.io, npmjs.com, pypi.org, pub.dev).
  return parseTar(pako.inflate(buf));
}

function extractNestedTarGz(outer, innerName) {
  const inner = outer[innerName];
  if (!inner) throw new Error(`archive missing ${innerName}`);
  return parseTar(pako.inflate(inner));
}

// .gem archives wrap the actual source in data.tar.gz and the gemspec-style
// metadata in metadata.gz. Expose both — meta-gems like `rails` have almost
// nothing in data.tar.gz and their real info lives in metadata.gz.
function extractGem(outer) {
  const files = extractNestedTarGz(outer, "data.tar.gz");
  const meta = outer["metadata.gz"];
  if (meta) {
    try { files["METADATA.yaml"] = pako.inflate(meta); } catch { /* ignore */ }
  }
  return files;
}

// hex.pm archives put source under contents.tar.gz and expose
// metadata.config, CHECKSUM, and VERSION alongside it. Keep those visible.
function extractHex(outer) {
  const files = extractNestedTarGz(outer, "contents.tar.gz");
  for (const name of ["metadata.config", "CHECKSUM", "VERSION"]) {
    if (outer[name]) files[name] = outer[name];
  }
  return files;
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
    const registry = state.registry;
    const leftPromise = fetchCrateFiles(state.crate.name, left)
      .then((f) => stripArchivePrefix(f, registry, state.crate.name, left));
    const rightPromise = sameVersion
      ? leftPromise
      : fetchCrateFiles(state.crate.name, right)
        .then((f) => stripArchivePrefix(f, registry, state.crate.name, right));
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

  statsEl.innerHTML = renderStats(counts, state.left === state.right);
  toolbarEl.hidden = false;

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

function renderStats({ total, added, removed, modified, unchanged }, viewSource) {
  const chips = [`<span class="chip"><span class="n">${total}</span>&nbsp;files</span>`];
  if (added)     chips.push(`<span class="chip added"><span class="n">+${added}</span> added</span>`);
  if (removed)   chips.push(`<span class="chip removed"><span class="n">-${removed}</span> removed</span>`);
  if (modified)  chips.push(`<span class="chip modified"><span class="n">~${modified}</span> modified</span>`);
  // When we're just viewing source (not comparing), every file is trivially
  // "unchanged" — that chip adds noise without conveying anything useful.
  if (unchanged && !viewSource) {
    chips.push(`<span class="chip"><span class="n">${unchanged}</span> unchanged</span>`);
  }
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

async function downloadVersion(name, version) {
  const url = apiDownloadUrl(state.registry, name, version);
  let response;
  try {
    const cache = await caches.open("unpackage-v1");
    response = await cache.match(url);
  } catch { /* cache unavailable */ }
  if (!response) response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${name} ${version}`);
  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = `${safeFilename(name)}-${version}${archiveExt(state.registry)}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
}

downloadBtn.addEventListener("click", async () => {
  if (!state.crate || !state.right) return;
  downloadBtn.disabled = true;
  try {
    await downloadVersion(state.crate.name, state.right);
    if (state.left && state.left !== state.right) {
      // Small delay so the browser processes the first download before the second.
      await new Promise((r) => setTimeout(r, 300));
      await downloadVersion(state.crate.name, state.left);
    }
  } catch (err) {
    console.error("[unpackage.dev] download failed:", err);
  } finally {
    downloadBtn.disabled = false;
  }
});

function syncTopToggleLabel() {
  const collapsed = topbarEl.classList.contains("collapsed");
  const label = topbarToggleBtn.querySelector(".label");
  if (label) label.textContent = collapsed ? "Edit" : "Hide top";
  topbarToggleBtn.title = collapsed ? "Edit" : "Hide top";
}

function setTopCollapsed(collapsed) {
  topbarEl.classList.toggle("collapsed", collapsed);
  syncTopToggleLabel();
}

topbarToggleBtn.addEventListener("click", () => {
  topbarEl.classList.toggle("collapsed");
  syncTopToggleLabel();
});

// Scrolling down past the top hides the top bar. Simply reaching the top
// again does NOT bring it back — users have to overscroll (pull up past the
// edge with the wheel or a touch swipe) to reveal it.
diffPaneEl.addEventListener("scroll", () => {
  if (diffPaneEl.scrollTop > 5 && !topbarEl.classList.contains("collapsed")) {
    setTopCollapsed(true);
  }
  if (diffPaneEl.scrollTop > 0) pullAccum = 0;
});

const PULL_THRESHOLD = 60; // pixels of upward pull required at scrollTop=0
let pullAccum = 0;
let pullTimer = 0;

function registerPull(dy) {
  // dy > 0 means "finger/wheel is pulling down" (revealing content above).
  if (diffPaneEl.scrollTop !== 0) { pullAccum = 0; return; }
  if (!topbarEl.classList.contains("collapsed")) return;
  if (dy <= 0) return;
  pullAccum += dy;
  clearTimeout(pullTimer);
  pullTimer = setTimeout(() => { pullAccum = 0; }, 400);
  if (pullAccum > PULL_THRESHOLD) {
    setTopCollapsed(false);
    pullAccum = 0;
  }
}

diffPaneEl.addEventListener("wheel", (e) => {
  // Negative deltaY = scroll up = pull down gesture.
  registerPull(-e.deltaY);
}, { passive: true });

let touchLastY = null;
diffPaneEl.addEventListener("touchstart", (e) => {
  touchLastY = e.touches[0]?.clientY ?? null;
}, { passive: true });
diffPaneEl.addEventListener("touchmove", (e) => {
  if (touchLastY == null) return;
  const y = e.touches[0]?.clientY ?? touchLastY;
  const dy = y - touchLastY;
  touchLastY = y;
  registerPull(dy);
}, { passive: true });
diffPaneEl.addEventListener("touchend", () => { touchLastY = null; pullAccum = 0; }, { passive: true });

// ---------- theme toggle ----------

function storedTheme() {
  try {
    const v = localStorage.getItem("unpackage-theme");
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
  try { localStorage.setItem("unpackage-theme", next); } catch { /* private mode / quota */ }
  document.documentElement.setAttribute("data-theme", next);
  updateThemeToggleTitle();
  console.log("[unpackage.dev] theme →", next, "| data-theme now:", document.documentElement.getAttribute("data-theme"));
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

function syncRegistryUI() {
  registrySel.value = state.registry;
  searchInput.placeholder = `Search ${state.registry}\u2026`;
}

registrySel.addEventListener("change", () => {
  state.registry = registrySel.value;
  syncRegistryUI();
  // Drop stale results but don't wipe anything else; the user hasn't asked
  // for a new package yet.
  resultsEl.hidden = true;
  resultsEl.innerHTML = "";
});

window.addEventListener("hashchange", () => {
  const parsed = parseHash();
  if (!parsed) return;
  const sameCrate = state.crate
    && state.registry === parsed.registry
    && state.crate.name === parsed.name;
  const sameVersions = sameCrate && parsed.left === state.left && parsed.right === state.right;
  if (sameVersions) {
    state.selectedFile = parsed.file;
    state.selection = parsed.range;
    if (parsed.file) applyFileNavigation();
    else applyHighlight();
  } else if (sameCrate) {
    if (parsed.left) state.left = parsed.left;
    if (parsed.right) state.right = parsed.right;
    leftSel.value = state.left === state.right ? "" : state.left;
    rightSel.value = state.right;
    state.selectedFile = parsed.file;
    state.selection = parsed.range;
    loadDiff().then(() => { if (parsed.file) applyFileNavigation(); });
  } else {
    state.registry = parsed.registry;
    syncRegistryUI();
    if (parsed.name) {
      selectCrate(parsed.name, parsed.left, parsed.right, parsed.file, parsed.range);
    }
  }
});

(async function init() {
  syncTopToggleLabel();
  const parsed = parseHash();
  if (parsed) {
    state.registry = parsed.registry;
    syncRegistryUI();
    if (parsed.name) {
      await selectCrate(parsed.name, parsed.left, parsed.right, parsed.file, parsed.range);
      // Opening a direct comparison link — give the diff the whole screen
      // until the user scrolls back to the top.
      if (parsed.left && parsed.right) setTopCollapsed(true);
    }
  } else {
    syncRegistryUI();
  }
  searchInput.focus();
})();
