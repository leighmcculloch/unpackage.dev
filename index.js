const MARKER = "<!-- unpackage.dev dependency diff -->";
const BASE_URL = "https://unpackage.dev/#";

const registryByFile = [
  [/package\.json$|package-lock\.json$|npm-shrinkwrap\.json$/, "npmjs.com"],
  [/deno\.json(?:c)?$/, "jsr.io"],
  [/Cargo\.(toml|lock)$/, "crates.io"],
  [/go\.(mod|sum)$/, "proxy.golang.org"],
  [/Gemfile(?:\.lock)?$/, "rubygems.org"],
  [/requirements[^/]*\.txt$|pyproject\.toml$|poetry\.lock$|Pipfile(?:\.lock)?$/, "pypi.org"],
  [/\.csproj$|packages\.config$|paket\.dependencies$|packages\.lock\.json$/, "nuget.org"],
  [/mix\.exs$|mix\.lock$/, "hex.pm"],
  [/pubspec\.(yaml|lock)$/, "pub.dev"],
  [/DESCRIPTION$|NAMESPACE$/, "cran.r-project.org"],
  [/Project\.toml$|Manifest\.toml$/, "juliahub.com"],
  [/composer\.(json|lock)$/, "packagist.org"],
  [/pom\.xml$|build\.gradle(?:\.kts)?$|\.gradle$/, "maven.org"],
];

function registryFor(path) {
  return registryByFile.find(([re]) => re.test(path))?.[1] ?? null;
}

function version(value) {
  if (!value) return null;
  const clean = value.trim().replace(/^[=~^v<>=\s]+/, "").replace(/[,\s].*$/, "");
  return /^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(clean) ? clean : null;
}

function add(out, registry, name, oldValue, newValue) {
  const oldVersion = version(oldValue), newVersion = version(newValue);
  if (!name || !oldVersion || !newVersion) return;
  const key = `${registry}:${name}`;
  out.set(key, { registry, name, oldVersion, newVersion });
}

function jsonDeps(text, registry, out) {
  try {
    const data = JSON.parse(text);
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, value] of Object.entries(data[section] ?? {})) {
        const v = typeof value === "string" ? value : value?.version;
        add(out, registry, name, v, v);
      }
    }
  } catch { /* lockfiles and manifests below are handled textually */ }
}

function pairs(text, registry, out) {
  const patterns = [
    /["']?(@?[\w./+:-]+)["']?\s*[:=]\s*["']?([^"'\s,]+)["']?/g,
    /^\s*([A-Za-z0-9_.@+/-]+)\s+([^\s#]+)/gm,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) add(out, registry, m[1], m[2], m[2]);
  }
  if (registry === "proxy.golang.org") {
    for (const m of text.matchAll(/^\s*require\s+([^\s]+)\s+v?([^\s]+)/gm)) add(out, registry, m[1], m[2], m[2]);
  }
  if (registry === "rubygems.org") {
    for (const m of text.matchAll(/gem\s+["']([^"']+)["']\s*,\s*["'][^0-9v]*v?([^"']+)["']/g)) add(out, registry, m[1], m[2], m[2]);
  }
  if (registry === "pub.dev") {
    for (const m of text.matchAll(/^\s*([\w-]+):\s*[~^<>= ]*([0-9][^\s]+)/gm)) add(out, registry, m[1], m[2], m[2]);
  }
  if (registry === "nuget.org") {
    for (const m of text.matchAll(/PackageReference\s+Include=["']([^"']+)["']\s+Version=["']([^"']+)["']/g)) add(out, registry, m[1], m[2], m[2]);
  }
  if (registry === "hex.pm") {
    for (const m of text.matchAll(/([\w-]+):\s*"~>\s*([0-9][^"]+)/g)) add(out, registry, m[1], m[2], m[2]);
  }
  if (registry === "cran.r-project.org") {
    for (const m of text.matchAll(/(?:Imports|Depends|Suggests):\s*([^\n]+)/g)) {
      for (const dep of m[1].matchAll(/([A-Za-z][\w.]*)\s*\(?(?:>=|==|=)?\s*([0-9][\w.]*)/g)) add(out, registry, dep[1], dep[2], dep[2]);
    }
  }
}

function extract(path, text, registry) {
  const out = new Map();
  if (/package\.json$/.test(path) || /deno\.jsonc?$/.test(path)) jsonDeps(text, registry, out);
  if (registry === "jsr.io") {
    try {
      const data = JSON.parse(text);
      for (const [name, value] of Object.entries(data.imports ?? {})) {
        const match = String(value).match(/@([0-9][^\s/]+)/);
        if (match) add(out, registry, name, match[1], match[1]);
      }
    } catch { /* textual parser below */ }
  }
  pairs(text, registry, out);
  return out;
}

function changes(path, before, after) {
  const registry = registryFor(path);
  if (!registry) return [];
  const oldDeps = extract(path, before, registry), newDeps = extract(path, after, registry);
  const result = [];
  for (const [key, newer] of newDeps) {
    const older = oldDeps.get(key);
    if (older && older.oldVersion !== newer.newVersion) {
      result.push({ registry, name: newer.name, oldVersion: older.oldVersion, newVersion: newer.newVersion });
    }
  }
  return result.filter((dep) => dep.name !== "Version");
}

async function api(path, token, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "unpackage-dev-action", ...(options.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function fileAt(repo, sha, path, token) {
  try {
    const data = await api(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(sha)}`, token);
    return data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : "";
  } catch (error) {
    if (String(error).includes("GitHub API 404")) return "";
    throw error;
  }
}

function markdown(deps) {
  if (!deps.length) return `${MARKER}\nNo dependency version changes found in this pull request.`;
  const rows = deps.sort((a, b) => a.name.localeCompare(b.name)).map((d) => {
    const link = `${BASE_URL}${d.registry}/${encodeURIComponent(d.name)}@${encodeURIComponent(d.oldVersion)}...${encodeURIComponent(d.newVersion)}`;
    return `| ${d.name} | ${d.oldVersion} | ${d.newVersion} | [View package diff](${link}) |`;
  });
  return `${MARKER}\n### Dependency changes\n\n| Dependency | Old | New | Unpackage diff |\n| --- | --- | --- | --- |\n${rows.join("\n")}`;
}

async function run() {
  const event = require(process.env.GITHUB_EVENT_PATH);
  if (event.pull_request == null) throw new Error("This action only supports pull_request events.");
  const token = process.env["INPUT_GITHUB-TOKEN"];
  if (!token) throw new Error("github-token is required");
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = event.pull_request;
  const files = await api(`/repos/${repo}/pulls/${pr.number}/files?per_page=100`, token);
  const deps = new Map();
  for (const file of files) {
    const path = file.filename;
    if (!registryFor(path) || file.status === "removed") continue;
    const [before, after] = await Promise.all([
      fileAt(repo, pr.base.sha, path, token), fileAt(repo, pr.head.sha, path, token),
    ]);
    for (const dep of changes(path, before, after)) deps.set(`${dep.registry}:${dep.name}`, dep);
  }
  const body = markdown([...deps.values()]);
  const comments = await api(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`, token);
  const existing = comments.find((comment) => comment.body?.includes(MARKER));
  if (!deps.size) {
    if (existing) {
      await api(`/repos/${repo}/issues/comments/${existing.id}`, token, { method: "DELETE" });
    }
    return;
  }
  if (existing) {
    await api(`/repos/${repo}/issues/comments/${existing.id}`, token, { method: "PATCH", body: JSON.stringify({ body }), headers: { "content-type": "application/json" } });
  } else {
    await api(`/repos/${repo}/issues/${pr.number}/comments`, token, { method: "POST", body: JSON.stringify({ body }), headers: { "content-type": "application/json" } });
  }
}

if (require.main === module) {
  run().catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { changes, markdown, registryFor };
