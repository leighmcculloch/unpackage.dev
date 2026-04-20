import { serveDir } from "jsr:@std/http@1/file-server";

const USER_AGENT = "crates-diff (https://github.com/leighmcculloch)";

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

// ---------- router ----------

function handler(req: Request): Promise<Response> | Response {
  const url = new URL(req.url);

  if (url.pathname.startsWith("/api/registry/")) {
    const rest = url.pathname.slice("/api/registry/".length);
    const slash = rest.indexOf("/");
    const registry = slash < 0 ? rest : rest.slice(0, slash);
    const action = slash < 0 ? "" : rest.slice(slash + 1);

    if (action === "search") {
      const q = url.searchParams.get("q") ?? "";
      const per = url.searchParams.get("per_page") ?? "10";
      if (registry === "crates.io") return searchCratesIo(q, per);
      if (registry === "npmjs.com") return searchNpm(q, per);
      return new Response("unknown registry", { status: 400 });
    }
    if (action.startsWith("package/")) {
      const name = decodeURIComponent(action.slice("package/".length));
      if (registry === "crates.io") return packageCratesIo(name);
      if (registry === "npmjs.com") return packageNpm(name);
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
      return new Response("unknown registry", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  }

  return serveDir(req, { fsRoot: "static", quiet: true });
}

const port = Number(Deno.env.get("PORT") ?? 8000);
console.log(`crates-diff listening on http://localhost:${port}`);
Deno.serve({ port }, handler);
