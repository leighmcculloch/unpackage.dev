import assert from "node:assert/strict";
import { handler } from "../main.ts";

Deno.test("HTML revalidates and references immutable, content-addressed assets", async () => {
  const page = await handler(new Request("http://localhost/"));
  const html = await page.text();
  const paths = ["/", "/index.html"];
  for (
    const [name, type] of [["app.js", "text/javascript"], [
      "style.css",
      "text/css",
    ]]
  ) {
    const expected = await Deno.readFile(
      new URL(`../static/${name}`, import.meta.url),
    );
    const digest = await crypto.subtle.digest("SHA-256", expected);
    const hash = Array.from(
      new Uint8Array(digest),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const path = `/${name.replace(".", `.${hash}.`)}`;
    assert.ok(html.includes(`"${path}"`));
    assert.ok(!html.includes(`"/${name}"`));
    const response = await handler(new Request(`http://localhost${path}`));
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Type"),
      `${type}; charset=utf-8`,
    );
    assert.equal(
      response.headers.get("Content-Length"),
      String(expected.byteLength),
    );
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expected);
    paths.push(path);

    const missing = await handler(
      new Request(
        `http://localhost/${name.replace(".", `.${"0".repeat(64)}.`)}`,
      ),
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("Cache-Control"), "no-cache");
    await missing.body?.cancel();
  }

  for (const path of paths) {
    const cacheControl = path === "/" || path === "/index.html"
      ? "no-cache"
      : "public, max-age=31536000, immutable";
    const response = await handler(new Request(`http://localhost${path}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), cacheControl);
    const etag = response.headers.get("ETag");
    assert.ok(etag);
    if (cacheControl === "no-cache") assert.equal(await response.text(), html);
    else await response.body?.cancel();

    const unchanged = await handler(
      new Request(`http://localhost${path}`, {
        headers: { "If-None-Match": etag },
      }),
    );
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get("Cache-Control"), cacheControl);
    assert.equal(await unchanged.text(), "");

    const head = await handler(
      new Request(`http://localhost${path}`, { method: "HEAD" }),
    );
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("ETag"), etag);
    assert.equal(
      head.headers.get("Content-Length"),
      response.headers.get("Content-Length"),
    );
    assert.equal(await head.text(), "");
  }
});
