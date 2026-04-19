import { serveDir } from "jsr:@std/http/file-server";

const CRATES_IO_API = "https://crates.io/api/v1";
const USER_AGENT = "crates-diff (https://github.com/leighmcculloch)";

function crateHeaders(): HeadersInit {
  return {
    "User-Agent": USER_AGENT,
    "Accept": "application/json",
  };
}

async function proxyJson(upstream: string): Promise<Response> {
  const res = await fetch(upstream, { headers: crateHeaders() });
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    const per = url.searchParams.get("per_page") ?? "10";
    return proxyJson(
      `${CRATES_IO_API}/crates?q=${encodeURIComponent(q)}&per_page=${encodeURIComponent(per)}`,
    );
  }

  if (url.pathname.startsWith("/api/crate/")) {
    const name = url.pathname.slice("/api/crate/".length);
    return proxyJson(`${CRATES_IO_API}/crates/${encodeURIComponent(name)}`);
  }

  if (url.pathname.startsWith("/api/download/")) {
    const rest = url.pathname.slice("/api/download/".length);
    const slash = rest.indexOf("/");
    if (slash < 0) return new Response("bad request", { status: 400 });
    const name = rest.slice(0, slash);
    const version = rest.slice(slash + 1);
    const upstream =
      `${CRATES_IO_API}/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}/download`;
    const res = await fetch(upstream, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    if (!res.ok || !res.body) {
      return new Response(`upstream error: ${res.status}`, { status: res.status });
    }
    return new Response(res.body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  return serveDir(req, { fsRoot: "static", quiet: true });
}

const port = Number(Deno.env.get("PORT") ?? 8000);
console.log(`crates-diff listening on http://localhost:${port}`);
Deno.serve({ port }, handler);
