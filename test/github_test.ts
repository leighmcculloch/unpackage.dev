import assert from "node:assert/strict";
import { handler } from "../main.ts";

function request(url = "https://github.com/acme/project/pull/42") {
  return new Request(
    `http://localhost/api/github/pull-request?url=${encodeURIComponent(url)}`,
  );
}

Deno.test("PR review paginates, uses the merge base and fork, and preserves workspace versions", async () => {
  const original = globalThis.fetch;
  const manifest = (version: string) =>
    JSON.stringify({ dependencies: { widget: version } });
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    const path = url.pathname;
    if (path.endsWith("/pulls/42")) {
      return Promise.resolve(Response.json({
        title: "Update dependencies",
        changed_files: 104,
        base: { sha: "base-tip", repo: { full_name: "acme/project" } },
        head: { sha: "head", repo: { full_name: "contributor/project" } },
      }));
    }
    if (path.includes("/compare/")) {
      return Promise.resolve(
        Response.json({ merge_base_commit: { sha: "merge-base" } }),
      );
    }
    if (path.endsWith("/files")) {
      return Promise.resolve(
        Response.json(
          url.searchParams.get("page") === "1"
            ? Array.from(
              { length: 100 },
              (_, i) =>
                i === 99
                  ? ({ filename: "mirror/package.json", status: "modified" })
                  : ({ filename: `docs/${i}.md` }),
            )
            : [
              {
                filename: "app/package.json",
                previous_filename: "old/package.json",
                status: "renamed",
              },
              { filename: "other/package.json", status: "modified" },
              { filename: "new/package.json", status: "added" },
              { filename: "removed/package.json", status: "removed" },
            ],
        ),
      );
    }
    const before = path.startsWith("/repos/acme/project/contents/");
    assert.equal(url.searchParams.get("ref"), before ? "merge-base" : "head");
    if (before) {
      assert.ok(
        !path.includes("/app/"),
        "renames must use their previous path",
      );
      assert.ok(!path.includes("/new/"), "added files have no base content");
    } else {
      assert.ok(path.startsWith("/repos/contributor/project/contents/"));
      assert.ok(
        !path.includes("/removed/"),
        "removed files have no head content",
      );
    }
    return Promise.resolve(
      new Response(manifest(
        path.includes("/new/")
          ? "5.0.0"
          : path.includes("/removed/")
          ? "6.0.0"
          : path.includes("/other/")
          ? before ? "3.0.0" : "4.0.0"
          : before
          ? "1.0.0"
          : "2.0.0",
      )),
    );
  };
  try {
    const response = await handler(request());
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.supportedFiles, 5);
    assert.deepEqual(result.dependencies, [
      {
        registry: "npmjs.com",
        name: "widget",
        oldVersion: "1.0.0",
        newVersion: "2.0.0",
      },
      {
        registry: "npmjs.com",
        name: "widget",
        oldVersion: "3.0.0",
        newVersion: "4.0.0",
      },
      {
        registry: "npmjs.com",
        name: "widget",
        oldVersion: null,
        newVersion: "5.0.0",
        change: "added",
      },
      {
        registry: "npmjs.com",
        name: "widget",
        oldVersion: "6.0.0",
        newVersion: null,
        change: "removed",
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("PR review distinguishes empty results from unreadable manifests", async () => {
  const original = globalThis.fetch;
  let failFile = false;
  globalThis.fetch = (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/42")) {
      return Promise.resolve(Response.json({
        title: "No updates",
        changed_files: 1,
        base: { sha: "base", repo: { full_name: "acme/project" } },
        head: { sha: "head", repo: { full_name: "acme/project" } },
      }));
    }
    if (path.includes("/compare/")) {
      return Promise.resolve(
        Response.json({ merge_base_commit: { sha: "base" } }),
      );
    }
    if (path.endsWith("/files")) {
      return Promise.resolve(
        Response.json([{ filename: "package.json", status: "modified" }]),
      );
    }
    return Promise.resolve(
      new Response('{"dependencies":{"a":"1.0.0"}}', {
        status: failFile ? 404 : 200,
      }),
    );
  };
  try {
    const empty = await handler(request());
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).dependencies, []);
    failFile = true;
    const failure = await handler(request());
    assert.equal(failure.status, 404);
    assert.match(await failure.text(), /not found/);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("PR review rejects invalid URLs and reports upstream failures without partial results", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Invalid input must not fetch");
  };
  try {
    for (
      const url of [
        "invalid",
        "https://evil.test/acme/project/pull/42",
        "https://github.com/acme/project/issues/42",
      ]
    ) {
      const response = await handler(request(url));
      assert.equal(response.status, 400);
      await response.body?.cancel();
    }
    for (const status of [404, 403, 429, 500]) {
      globalThis.fetch = () =>
        Promise.resolve(new Response("upstream", { status }));
      const response = await handler(request());
      assert.equal(response.status, status === 404 ? 404 : 502);
      assert.match(
        await response.text(),
        status === 404 ? /public/ : status === 500 ? /could not load/ : /limit/,
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});
