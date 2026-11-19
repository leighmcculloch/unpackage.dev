const MARKER = "<!-- unpackage.dev dependency diff -->";
const BASE_URL = "https://unpackage.dev/#";

function log(message, data = {}) {
  console.log(`[unpackage.dev] ${message} ${JSON.stringify(data)}`);
}

const registryByFile = [
  [/package\.json$|package-lock\.json$|npm-shrinkwrap\.json$/, "npmjs.com"],
  [/deno\.json(?:c)?$|deno\.lock$/, "jsr.io"],
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
        const match = String(value).match(/@([\^~<>=v]*[0-9][^\s/]+)/);
        if (match) add(out, registry, name, match[1], match[1]);
      }
    } catch { /* textual parser below */ }
  }
  if (registry === "jsr.io" && /deno\.lock$/.test(path)) {
    for (const m of text.matchAll(/jsr:@([^/]+\/[^@"]+)@[^"\s]+["']?\s*:\s*["']([^"']+)["']/g)) {
      add(out, registry, `@${m[1]}`, m[2], m[2]);
    }
  }
  pairs(text, registry, out);
  return out;
}

function changes(path, before, after) {
  const registry = registryFor(path);
  if (!registry) {
    log("Skipping unsupported file", { path });
    return [];
  }
  const oldDeps = extract(path, before, registry), newDeps = extract(path, after, registry);
  log("Parsed dependency file", { path, ecosystem: registry === "jsr.io" ? "Deno / JSR" : registry, registry, beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after), beforeDependencies: [...oldDeps.values()], afterDependencies: [...newDeps.values()] });
  if (registry === "proxy.golang.org") {
    const base = (name) => name.startsWith("gopkg.in/") ? name : name.replace(/\/v(?:[2-9]|[1-9]\d+)$/, "");
    const removed = [...oldDeps].filter(([key]) => !newDeps.has(key));
    const added = [...newDeps].filter(([key]) => !oldDeps.has(key));
    // Match exact paths first. Only pair a major-path replacement when neither
    // side has multiple unmatched majors of the same module to choose from.
    for (const [key, newer] of added) {
      const matches = removed.filter(([, older]) => base(older.name) === base(newer.name));
      if (matches.length === 1 && added.filter(([, dep]) => base(dep.name) === base(newer.name)).length === 1) {
        oldDeps.set(key, matches[0][1]);
        oldDeps.delete(matches[0][0]);
      }
    }
  }
  const result = [];
  for (const [key, newer] of newDeps) {
    const older = oldDeps.get(key);
    if (!older) {
      result.push({ registry, name: newer.name, oldVersion: null, newVersion: newer.newVersion, change: "added" });
    } else if (older.oldVersion !== newer.newVersion) {
      result.push({ registry, name: newer.name, oldVersion: older.oldVersion, newVersion: newer.newVersion });
    }
  }
  for (const [key, older] of oldDeps) {
    if (!newDeps.has(key)) {
      result.push({ registry, name: older.name, oldVersion: older.oldVersion, newVersion: null, change: "removed" });
    }
  }
  const filtered = result.filter((dep) => dep.name !== "Version");
  log("Dependency comparison complete", { path, changes: filtered });
  return filtered;
}

async function api(path, token, options = {}) {
  const method = options.method ?? "GET";
  log("GitHub API request", { method, path });
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "unpackage-dev-action", ...(options.headers ?? {}) },
  });
  log("GitHub API response", { method, path, status: response.status, ok: response.ok });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function fileAt(repo, sha, path, token) {
  log("Reading file", { path, sha });
  try {
    const data = await api(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(sha)}`, token);
    const content = data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : "";
    log("Read file", { path, sha, bytes: Buffer.byteLength(content), encoding: data.encoding });
    return content;
  } catch (error) {
    if (String(error).includes("GitHub API 404")) {
      log("File does not exist at revision", { path, sha });
      return "";
    }
    throw error;
  }
}

function markdown(deps) {
  if (!deps.length) return `${MARKER}\nNo dependency version changes found in this pull request.`;
  const rows = deps.sort((a, b) => a.name.localeCompare(b.name)).map((d) => {
    const link = d.oldVersion && d.newVersion
      ? `[View package diff](${BASE_URL}${d.registry}/${encodeURIComponent(d.name)}@${encodeURIComponent(d.oldVersion)}...${encodeURIComponent(d.newVersion)})`
      : "—";
    return `| ${d.name} | ${d.oldVersion ?? "—"} | ${d.newVersion ?? "—"} | ${link} |`;
  });
  return `${MARKER}\n### Dependency changes\n\n| Dependency | Old | New | Unpackage diff |\n| --- | --- | --- | --- |\n${rows.join("\n")}`;
}

async function run() {
  log("Action started", { repository: process.env.GITHUB_REPOSITORY, eventPath: process.env.GITHUB_EVENT_PATH });
  const event = require(process.env.GITHUB_EVENT_PATH);
  log("Loaded event", { eventName: process.env.GITHUB_EVENT_NAME, hasPullRequest: event.pull_request != null });
  if (event.pull_request == null) throw new Error("This action only supports pull_request events.");
  const token = process.env["INPUT_GITHUB-TOKEN"];
  if (!token) throw new Error("github-token is required");
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = event.pull_request;
  log("Pull request context", { number: pr.number, baseSha: pr.base.sha, headSha: pr.head.sha });
  const files = await api(`/repos/${repo}/pulls/${pr.number}/files?per_page=100`, token);
  log("Changed files received", { count: files.length, files: files.map((file) => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions })) });
  const deps = new Map();
  for (const file of files) {
    const path = file.filename;
    const registry = registryFor(path);
    if (!registry) {
      log("Skipping changed file without supported registry", { path, status: file.status });
      continue;
    }
    if (file.status === "removed") {
      log("Skipping removed dependency file", { path, registry });
      continue;
    }
    log("Processing dependency file", { path, registry, status: file.status });
    const [before, after] = await Promise.all([
      fileAt(repo, pr.base.sha, path, token), fileAt(repo, pr.head.sha, path, token),
    ]);
    for (const dep of changes(path, before, after)) deps.set(`${dep.registry}:${dep.name}`, dep);
  }
  log("All dependency changes collected", { count: deps.size, changes: [...deps.values()] });
  const body = markdown([...deps.values()]);
  const comments = await api(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`, token);
  const existing = comments.find((comment) => comment.body?.includes(MARKER));
  log("Existing bot comment lookup", { commentCount: comments.length, found: Boolean(existing), commentId: existing?.id ?? null });
  if (!deps.size) {
    if (existing) {
      log("Deleting stale bot comment because no version changes remain", { commentId: existing.id });
      await api(`/repos/${repo}/issues/comments/${existing.id}`, token, { method: "DELETE" });
    }
    log("Action finished without posting a comment", { reason: "no dependency version changes" });
    return;
  }
  if (existing) {
    log("Updating bot comment", { commentId: existing.id, dependencyCount: deps.size, body });
    await api(`/repos/${repo}/issues/comments/${existing.id}`, token, { method: "PATCH", body: JSON.stringify({ body }), headers: { "content-type": "application/json" } });
  } else {
    log("Creating bot comment", { dependencyCount: deps.size, body });
    await api(`/repos/${repo}/issues/${pr.number}/comments`, token, { method: "POST", body: JSON.stringify({ body }), headers: { "content-type": "application/json" } });
  }
  log("Action finished", { dependencyCount: deps.size, commentAction: existing ? "updated" : "created" });
}

if (require.main === module) {
  run().catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { changes, markdown, registryFor, log };
