import { serveDir } from "@std/http/file-server";

const USER_AGENT = "unpackage.dev (https://github.com/leighmcculloch)";

// ---------- crates.io adapters ----------

function crateHeaders(): HeadersInit {
  return { "User-Agent": USER_AGENT, "Accept": "application/json" };
}

async function searchCratesIo(q: string, per: string): Promise<Response> {
  const u = `https://crates.io/api/v1/crates?q=${
    encodeURIComponent(q)
  }&per_page=${encodeURIComponent(per)}`;
  const r = await fetch(u, { headers: crateHeaders() });
  return new Response(await r.text(), {
    status: r.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function packageCratesIo(name: string): Promise<Response> {
  const u = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`;
  const r = await fetch(u, { headers: crateHeaders() });
  return new Response(await r.text(), {
    status: r.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function downloadCratesIo(
  name: string,
  version: string,
): Promise<Response> {
  const u = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${
    encodeURIComponent(version)
  }/download`;
  const r = await fetch(u, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
  });
  if (!r.ok || !r.body) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  return new Response(r.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ---------- npm adapters ----------

async function searchNpm(q: string, per: string): Promise<Response> {
  const u = `https://registry.npmjs.org/-/v1/search?text=${
    encodeURIComponent(q)
  }&size=${encodeURIComponent(per)}`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  const crates = Array.isArray(data.objects)
    // deno-lint-ignore no-explicit-any
    ? data.objects.map((o: any) => ({
      name: o?.package?.name ?? "",
      description: o?.package?.description ?? "",
      max_version: o?.package?.version ?? "",
    }))
    : [];
  return new Response(JSON.stringify({ crates }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function packageNpm(name: string): Promise<Response> {
  const u = `https://registry.npmjs.org/${name}`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  const time: Record<string, string> = data.time ?? {};
  const nums = Object.keys(data.versions ?? {});
  const versions = nums.map((num) => ({
    num,
    yanked: false,
    created_at: time[num] ?? "",
  }));
  versions.sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || "")
  );
  return new Response(
    JSON.stringify({
      crate: {
        name: data.name ?? name,
        description: data.description ?? "",
      },
      versions,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}

async function downloadNpm(name: string, version: string): Promise<Response> {
  const lastSlash = name.lastIndexOf("/");
  const unscoped = lastSlash >= 0 ? name.slice(lastSlash + 1) : name;
  const u = `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`;
  const r = await fetch(u, { redirect: "follow" });
  if (!r.ok || !r.body) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  return new Response(r.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ---------- Go module proxy adapters (proxy.golang.org) ----------

// Go module paths and versions are escaped on the wire: every uppercase
// letter X becomes "!x" to avoid case-insensitive filesystem ambiguity.
function goEscape(s: string): string {
  return s.replace(/[A-Z]/g, (c) => "!" + c.toLowerCase());
}

function searchGo(q: string): Response {
  // Go has no public module search API — echo the input as a single result
  // so the user can press Enter / click to load it directly.
  const q2 = q.trim();
  const crates = q2 ? [{ name: q2, description: "", max_version: "" }] : [];
  return new Response(JSON.stringify({ crates }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
    },
  });
}

async function packageGo(name: string): Promise<Response> {
  const escaped = goEscape(name);
  const r = await fetch(`https://proxy.golang.org/${escaped}/@v/list`, {
    headers: { "Accept": "text/plain" },
  });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const list = (await r.text()).split("\n").map((s) => s.trim()).filter((s) =>
    s
  );
  list.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const versions = list.map((num) => ({ num, yanked: false, created_at: "" }));
  return new Response(
    JSON.stringify({
      crate: { name, description: "" },
      versions,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}

async function downloadGo(name: string, version: string): Promise<Response> {
  const u = `https://proxy.golang.org/${goEscape(name)}/@v/${
    goEscape(version)
  }.zip`;
  const r = await fetch(u, { redirect: "follow" });
  if (!r.ok || !r.body) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  return new Response(r.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ---------- JSR adapters (jsr.io) ----------

// JSR package names are always scoped "@scope/name". The npm compatibility
// mirror (npm.jsr.io) collapses the scope separator to a double underscore:
// @scope/name → @jsr/scope__name.
function jsrNpmName(name: string): string {
  if (!name.startsWith("@")) return name;
  const slash = name.indexOf("/");
  if (slash < 0) return name;
  return `@jsr/${name.slice(1, slash)}__${name.slice(slash + 1)}`;
}

async function searchJsr(q: string, per: string): Promise<Response> {
  const u = `https://api.jsr.io/packages?query=${encodeURIComponent(q)}&limit=${
    encodeURIComponent(per)
  }`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  const crates = Array.isArray(data.items)
    // deno-lint-ignore no-explicit-any
    ? data.items.map((p: any) => ({
      name: `@${p.scope}/${p.name}`,
      description: p.description ?? "",
      max_version: p.latestVersion ?? "",
    }))
    : [];
  return new Response(JSON.stringify({ crates }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function packageJsr(name: string): Promise<Response> {
  const npmName = jsrNpmName(name);
  const r = await fetch(`https://npm.jsr.io/${npmName}`, {
    headers: { "Accept": "application/json" },
  });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  const time: Record<string, string> = data.time ?? {};
  const nums = Object.keys(data.versions ?? {});
  const versions = nums.map((num) => ({
    num,
    yanked: false,
    created_at: time[num] ?? "",
  }));
  versions.sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || "")
  );
  return new Response(
    JSON.stringify({
      crate: { name, description: data.description ?? "" },
      versions,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}

async function downloadJsr(name: string, version: string): Promise<Response> {
  // JSR's tarball URL is registry-versioned (e.g. ".../~/11/..."), so we
  // can't build it from name + version alone — look it up in metadata.
  const npmName = jsrNpmName(name);
  const mr = await fetch(`https://npm.jsr.io/${npmName}`, {
    headers: { "Accept": "application/json" },
  });
  if (!mr.ok) {
    return new Response(`upstream error: ${mr.status}`, { status: mr.status });
  }
  const meta = await mr.json();
  const tarball = meta.versions?.[version]?.dist?.tarball;
  if (!tarball) {
    return new Response(`unknown version: ${name}@${version}`, { status: 404 });
  }
  const r = await fetch(tarball, { redirect: "follow" });
  if (!r.ok || !r.body) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  return new Response(r.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ---------- CRAN adapters (cran.r-project.org — R) ----------

function searchCran(q: string): Response {
  // CRAN doesn't expose a public JSON search API — echo the input so the
  // user can type a full package name and press enter.
  const q2 = q.trim();
  const crates = q2 ? [{ name: q2, description: "", max_version: "" }] : [];
  return new Response(JSON.stringify({ crates }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
    },
  });
}

async function packageCran(name: string): Promise<Response> {
  const u = `https://crandb.r-pkg.org/${encodeURIComponent(name)}/all`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  // deno-lint-ignore no-explicit-any
  const vs: Record<string, any> = data.versions ?? {};
  const versions = Object.keys(vs).map((num) => ({
    num,
    yanked: false,
    created_at: vs[num]?.["Date/Publication"] ?? vs[num]?.date ?? "",
  }));
  versions.sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || "")
  );
  return new Response(
    JSON.stringify({
      crate: { name, description: data.Title ?? "" },
      versions,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}

async function downloadCran(
  name: string,
  version: string,
): Promise<Response> {
  // Current version lives in src/contrib; older versions move to Archive/.
  const encName = encodeURIComponent(name);
  const encVer = encodeURIComponent(version);
  const current =
    `https://cran.r-project.org/src/contrib/${encName}_${encVer}.tar.gz`;
  let r = await fetch(current, { redirect: "follow" });
  if (r.status === 404) {
    const archive =
      `https://cran.r-project.org/src/contrib/Archive/${encName}/${encName}_${encVer}.tar.gz`;
    r = await fetch(archive, { redirect: "follow" });
  }
  if (!r.ok || !r.body) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  return new Response(r.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ---------- Julia adapters (JuliaRegistries/General → GitHub) ----------

// Packages in the General registry are sharded under their uppercase first
// letter: `E/Example/`. Package.toml holds the repo URL, Versions.toml lists
// release versions.
function juliaRegistryDir(name: string): string {
  const letter = name[0]?.toUpperCase() ?? "";
  return `${letter}/${name}`;
}

function searchJulia(q: string): Response {
  // No public Julia search API — echo input.
  const q2 = q.trim();
  const crates = q2 ? [{ name: q2, description: "", max_version: "" }] : [];
  return new Response(JSON.stringify({ crates }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
    },
  });
}

async function packageJulia(name: string): Promise<Response> {
  const path = juliaRegistryDir(name);
  const u =
    `https://raw.githubusercontent.com/JuliaRegistries/General/master/${path}/Versions.toml`;
  const r = await fetch(u);
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const text = await r.text();
  // Versions.toml has sections like `["1.2.3"]\ngit-tree-sha1 = "..."` — grab
  // the quoted header of each section.
  const nums: string[] = [];
  const re = /^\["([^"]+)"\]/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) nums.push(match[1]);
  nums.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const versions = nums.map((num) => ({ num, yanked: false, created_at: "" }));
  return new Response(
    JSON.stringify({
      crate: { name, description: "" },
      versions,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}

async function downloadJulia(
  name: string,
  version: string,
): Promise<Response> {
  const path = juliaRegistryDir(name);
  // Package.toml: `repo = "https://github.com/..."` — parse that and fetch
  // the corresponding GitHub tag tarball.
  const pr = await fetch(
    `https://raw.githubusercontent.com/JuliaRegistries/General/master/${path}/Package.toml`,
  );
  if (!pr.ok) {
    return new Response(`upstream error: ${pr.status}`, { status: pr.status });
  }
  const pkgToml = await pr.text();
  const repoMatch = pkgToml.match(/^repo\s*=\s*"([^"]+)"/m);
  if (!repoMatch) {
    return new Response("no repo in Package.toml", { status: 404 });
  }
  let repo = repoMatch[1].replace(/\/+$/, "");
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  const tarUrl = `${repo}/archive/refs/tags/v${
    encodeURIComponent(version)
  }.tar.gz`;
  const r = await fetch(tarUrl, { redirect: "follow" });
  if (!r.ok || !r.body) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  return new Response(r.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ---------- RubyGems adapters (rubygems.org) ----------

async function searchRubyGems(q: string, per: string): Promise<Response> {
  const u = `https://rubygems.org/api/v1/search.json?query=${
    encodeURIComponent(q)
  }`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  const n = parseInt(per, 10) || 10;
  const crates = Array.isArray(data)
    // deno-lint-ignore no-explicit-any
    ? data.slice(0, n).map((p: any) => ({
      name: p.name ?? "",
      description: p.info ?? "",
      max_version: p.version ?? "",
    }))
    : [];
  return new Response(JSON.stringify({ crates }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function packageRubyGems(name: string): Promise<Response> {
  const u = `https://rubygems.org/api/v1/versions/${
    encodeURIComponent(name)
  }.json`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  const versions = Array.isArray(data)
    // deno-lint-ignore no-explicit-any
    ? data.map((v: any) => ({
      num: v.number ?? "",
      yanked: !!v.yanked,
      created_at: v.created_at ?? "",
    }))
    : [];
  return new Response(
    JSON.stringify({
      crate: { name, description: "" },
      versions,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}

async function downloadRubyGems(
  name: string,
  version: string,
): Promise<Response> {
  const u = `https://rubygems.org/gems/${encodeURIComponent(name)}-${
    encodeURIComponent(version)
  }.gem`;
  const r = await fetch(u, { redirect: "follow" });
  if (!r.ok || !r.body) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  return new Response(r.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ---------- PyPI adapters (pypi.org) ----------

function searchPypi(q: string): Response {
  // PyPI doesn't expose a public JSON search API, so the "search" just echoes
  // the query as a single result.
  const q2 = q.trim();
  const crates = q2 ? [{ name: q2, description: "", max_version: "" }] : [];
  return new Response(JSON.stringify({ crates }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
    },
  });
}

async function packagePypi(name: string): Promise<Response> {
  const u = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  // deno-lint-ignore no-explicit-any
  const releases: Record<string, any[]> = data.releases ?? {};
  const versions = Object.keys(releases).map((num) => {
    const dists = releases[num] ?? [];
    const uploaded = dists[0]?.upload_time_iso_8601 ?? dists[0]?.upload_time ??
      "";
    // deno-lint-ignore no-explicit-any
    const yanked = dists.some((d: any) => d.yanked);
    return { num, yanked, created_at: uploaded };
  });
  versions.sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || "")
  );
  return new Response(
    JSON.stringify({
      crate: {
        name: data.info?.name ?? name,
        description: data.info?.summary ?? "",
      },
      versions,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}

async function downloadPypi(name: string, version: string): Promise<Response> {
  // Fetch the per-version metadata to find the source distribution URL.
  const mu = `https://pypi.org/pypi/${encodeURIComponent(name)}/${
    encodeURIComponent(version)
  }/json`;
  const mr = await fetch(mu, { headers: { "Accept": "application/json" } });
  if (!mr.ok) {
    return new Response(`upstream error: ${mr.status}`, { status: mr.status });
  }
  const meta = await mr.json();
  // deno-lint-ignore no-explicit-any
  const sdist = (meta.urls ?? []).find((u: any) => u.packagetype === "sdist");
  if (!sdist?.url) {
    return new Response(`no source distribution for ${name} ${version}`, {
      status: 404,
    });
  }
  const dr = await fetch(sdist.url, { redirect: "follow" });
  if (!dr.ok || !dr.body) {
    return new Response(`upstream error: ${dr.status}`, { status: dr.status });
  }
  return new Response(dr.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ---------- NuGet adapters (nuget.org) ----------

async function searchNuget(q: string, per: string): Promise<Response> {
  const u = `https://azuresearch-usnc.nuget.org/query?q=${
    encodeURIComponent(q)
  }&take=${encodeURIComponent(per)}&prerelease=true`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  const crates = Array.isArray(data.data)
    // deno-lint-ignore no-explicit-any
    ? data.data.map((p: any) => ({
      name: p.id ?? "",
      description: p.description ?? "",
      max_version: p.version ?? "",
    }))
    : [];
  return new Response(JSON.stringify({ crates }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function packageNuget(name: string): Promise<Response> {
  const id = name.toLowerCase();
  const u = `https://api.nuget.org/v3-flatcontainer/${id}/index.json`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  const list: string[] = Array.isArray(data.versions) ? data.versions : [];
  list.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const versions = list.map((num) => ({ num, yanked: false, created_at: "" }));
  return new Response(
    JSON.stringify({
      crate: { name, description: "" },
      versions,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}

async function downloadNuget(
  name: string,
  version: string,
): Promise<Response> {
  const id = name.toLowerCase();
  const ver = version.toLowerCase();
  const u =
    `https://api.nuget.org/v3-flatcontainer/${id}/${ver}/${id}.${ver}.nupkg`;
  const r = await fetch(u, { redirect: "follow" });
  if (!r.ok || !r.body) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  return new Response(r.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ---------- Hex adapters (hex.pm — Erlang / Elixir) ----------

async function searchHex(q: string, per: string): Promise<Response> {
  const u = `https://hex.pm/api/packages?search=${
    encodeURIComponent(q)
  }&sort=downloads`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  const n = parseInt(per, 10) || 10;
  const crates = Array.isArray(data)
    // deno-lint-ignore no-explicit-any
    ? data.slice(0, n).map((p: any) => ({
      name: p.name ?? "",
      description: p.meta?.description ?? "",
      max_version: p.latest_stable_version ?? p.latest_version ?? "",
    }))
    : [];
  return new Response(JSON.stringify({ crates }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function packageHex(name: string): Promise<Response> {
  const u = `https://hex.pm/api/packages/${encodeURIComponent(name)}`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  const versions = Array.isArray(data.releases)
    // deno-lint-ignore no-explicit-any
    ? data.releases.map((v: any) => ({
      num: v.version ?? "",
      yanked: false,
      created_at: v.inserted_at ?? "",
    }))
    : [];
  return new Response(
    JSON.stringify({
      crate: {
        name: data.name ?? name,
        description: data.meta?.description ?? "",
      },
      versions,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}

async function downloadHex(name: string, version: string): Promise<Response> {
  const u = `https://repo.hex.pm/tarballs/${encodeURIComponent(name)}-${
    encodeURIComponent(version)
  }.tar`;
  const r = await fetch(u, { redirect: "follow" });
  if (!r.ok || !r.body) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  return new Response(r.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ---------- pub.dev adapters (Dart / Flutter) ----------

async function searchPub(q: string, per: string): Promise<Response> {
  const u = `https://pub.dev/api/search?q=${encodeURIComponent(q)}`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  const n = parseInt(per, 10) || 10;
  const crates = Array.isArray(data.packages)
    // deno-lint-ignore no-explicit-any
    ? data.packages.slice(0, n).map((p: any) => ({
      name: p.package ?? "",
      description: "",
      max_version: "",
    }))
    : [];
  return new Response(JSON.stringify({ crates }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function packagePub(name: string): Promise<Response> {
  const u = `https://pub.dev/api/packages/${encodeURIComponent(name)}`;
  const r = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  const data = await r.json();
  const versions: { num: string; yanked: boolean; created_at: string }[] =
    Array.isArray(data.versions)
      // deno-lint-ignore no-explicit-any
      ? data.versions.map((v: any) => ({
        num: v.version ?? "",
        yanked: !!v.retracted,
        created_at: v.published ?? "",
      }))
      : [];
  versions.sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || "")
  );
  return new Response(
    JSON.stringify({
      crate: {
        name: data.name ?? name,
        description: data.latest?.pubspec?.description ?? "",
      },
      versions,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}

async function downloadPub(name: string, version: string): Promise<Response> {
  const u = `https://pub.dev/api/archives/${encodeURIComponent(name)}-${
    encodeURIComponent(version)
  }.tar.gz`;
  const r = await fetch(u, { redirect: "follow" });
  if (!r.ok || !r.body) {
    return new Response(`upstream error: ${r.status}`, { status: r.status });
  }
  return new Response(r.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ---------- abuse mitigation ----------

// Deno Deploy sets this. Locally it's unset, so abuse checks are skipped to
// keep `deno task start` and CI curl-tests friction-free.
const IS_DEPLOY = !!Deno.env.get("DENO_DEPLOYMENT_ID");

const RATE_LIMIT = 120; // requests per window, per IP
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0].trim() : "local";
}

// True if the request was made by the website itself (same-origin Origin or
// Referer). Non-browser clients with no such headers are rejected when
// deployed so the proxy can't be turned into a general-purpose package
// mirror.
function sameOrigin(req: Request): boolean {
  const url = new URL(req.url);
  const self = `${url.protocol}//${url.host}`;
  const origin = req.headers.get("Origin");
  if (origin) return origin === self;
  const referer = req.headers.get("Referer");
  if (referer) {
    try {
      return new URL(referer).origin === self;
    } catch {
      return false;
    }
  }
  return !IS_DEPLOY;
}

function rateLimited(req: Request): boolean {
  if (!IS_DEPLOY) return false;
  const ip = clientIp(req);
  const now = Date.now();
  let times = hits.get(ip) ?? [];
  times = times.filter((t) => now - t < RATE_WINDOW_MS);
  if (times.length >= RATE_LIMIT) {
    hits.set(ip, times);
    return true;
  }
  times.push(now);
  hits.set(ip, times);
  // Periodic prune so the Map doesn't grow without bound under attack.
  if (hits.size > 5000) {
    for (const [key, arr] of hits) {
      const kept = arr.filter((t) => now - t < RATE_WINDOW_MS);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
  }
  return false;
}

// ---------- router ----------

function handler(req: Request): Promise<Response> | Response {
  const url = new URL(req.url);

  if (url.pathname.startsWith("/api/registry/")) {
    if (!sameOrigin(req)) {
      return new Response("forbidden", { status: 403 });
    }
    if (rateLimited(req)) {
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)) },
      });
    }
    const rest = url.pathname.slice("/api/registry/".length);
    const slash = rest.indexOf("/");
    const registry = slash < 0 ? rest : rest.slice(0, slash);
    const action = slash < 0 ? "" : rest.slice(slash + 1);

    if (action === "search") {
      const q = url.searchParams.get("q") ?? "";
      const per = url.searchParams.get("per_page") ?? "10";
      if (registry === "crates.io") return searchCratesIo(q, per);
      if (registry === "npmjs.com") return searchNpm(q, per);
      if (registry === "proxy.golang.org") return searchGo(q);
      if (registry === "jsr.io") return searchJsr(q, per);
      if (registry === "cran.r-project.org") return searchCran(q);
      if (registry === "juliahub.com") return searchJulia(q);
      if (registry === "rubygems.org") return searchRubyGems(q, per);
      if (registry === "pypi.org") return searchPypi(q);
      if (registry === "nuget.org") return searchNuget(q, per);
      if (registry === "hex.pm") return searchHex(q, per);
      if (registry === "pub.dev") return searchPub(q, per);
      return new Response("unknown registry", { status: 400 });
    }
    if (action.startsWith("package/")) {
      const name = decodeURIComponent(action.slice("package/".length));
      if (registry === "crates.io") return packageCratesIo(name);
      if (registry === "npmjs.com") return packageNpm(name);
      if (registry === "proxy.golang.org") return packageGo(name);
      if (registry === "jsr.io") return packageJsr(name);
      if (registry === "cran.r-project.org") return packageCran(name);
      if (registry === "juliahub.com") return packageJulia(name);
      if (registry === "rubygems.org") return packageRubyGems(name);
      if (registry === "pypi.org") return packagePypi(name);
      if (registry === "nuget.org") return packageNuget(name);
      if (registry === "hex.pm") return packageHex(name);
      if (registry === "pub.dev") return packagePub(name);
      return new Response("unknown registry", { status: 400 });
    }
    if (action.startsWith("download/")) {
      const rest2 = action.slice("download/".length);
      const lastSlash = rest2.lastIndexOf("/");
      if (lastSlash < 0) return new Response("bad request", { status: 400 });
      const name = decodeURIComponent(rest2.slice(0, lastSlash));
      const version = decodeURIComponent(rest2.slice(lastSlash + 1));
      if (registry === "crates.io") return downloadCratesIo(name, version);
      if (registry === "npmjs.com") return downloadNpm(name, version);
      if (registry === "proxy.golang.org") return downloadGo(name, version);
      if (registry === "jsr.io") return downloadJsr(name, version);
      if (registry === "cran.r-project.org") return downloadCran(name, version);
      if (registry === "juliahub.com") return downloadJulia(name, version);
      if (registry === "rubygems.org") return downloadRubyGems(name, version);
      if (registry === "pypi.org") return downloadPypi(name, version);
      if (registry === "nuget.org") return downloadNuget(name, version);
      if (registry === "hex.pm") return downloadHex(name, version);
      if (registry === "pub.dev") return downloadPub(name, version);
      return new Response("unknown registry", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  }

  return serveDir(req, { fsRoot: "static", quiet: true });
}

const port = Number(Deno.env.get("PORT") ?? 8000);
console.log(`unpackage.dev listening on http://localhost:${port}`);
Deno.serve({ port }, handler);
