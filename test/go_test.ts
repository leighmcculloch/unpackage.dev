import assert from "node:assert/strict";
import { handler } from "../main.ts";

Deno.test("Go API compares versions across module major paths", async () => {
  const base = "github.com/Acme/widget";
  const originalFetch = globalThis.fetch;
  const lists: Record<string, string> = {
    [base]: "v1.2.0\nv4.0.0+incompatible\nv1.10.0\n",
    [`${base}/v5`]: "v5.0.0\nv5.1.0\n",
    [`${base}/v12`]: "v12.0.0\n",
  };
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    if (url.hostname === "pkg.go.dev") {
      return Promise.resolve(
        new Response(
          `<a href="/${base}">base</a>
         <a href="/${base}/v5">v5</a>
         <a href="/${base}/v12">v12</a>
         <a href="/${base}/v2">missing</a>
         <a href="/${base}/other/v3">unrelated submodule</a>`,
        ),
      );
    }
    assert.equal(url.hostname, "proxy.golang.org");
    const [path, file] = url.pathname.slice(1).split("/@v/");
    const module = path.replace(/!([a-z])/g, (_, c) => c.toUpperCase());
    if (file === "list") {
      return Promise.resolve(
        new Response(lists[module] ?? "not found", {
          status: module in lists ? 200 : 404,
        }),
      );
    }
    const version = file.replace(/\.zip$/, "");
    const exists = lists[module]?.split("\n").includes(version);
    return Promise.resolve(
      new Response(`${module}@${version}/source.go`, {
        status: exists ? 200 : 404,
      }),
    );
  };
  try {
    for (const name of [base, `${base}/v5`, `${base}/v12`]) {
      const response = await handler(
        new Request(
          `http://localhost/api/registry/proxy.golang.org/package/${name}`,
        ),
      );
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.deepEqual(data.versions.map((v: { num: string }) => v.num), [
        "v12.0.0",
        "v5.1.0",
        "v5.0.0",
        "v4.0.0+incompatible",
        "v1.10.0",
        "v1.2.0",
      ]);
      for (const [module, versions] of Object.entries(lists)) {
        for (const version of versions.trim().split("\n")) {
          const archive = await handler(
            new Request(
              `http://localhost/api/registry/proxy.golang.org/download/${name}/${version}`,
            ),
          );
          assert.equal(archive.status, 200);
          assert.equal(await archive.text(), `${module}@${version}/source.go`);
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
