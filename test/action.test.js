const assert = require("node:assert/strict");
const test = require("node:test");
const { changes, markdown, registryFor } = require("../index.js");

const cases = [
  ["Cargo.toml", "crates.io", "serde", 'serde = "1.0.0"', 'serde = "1.0.1"'],
  ["package.json", "npmjs.com", "react", '{"dependencies":{"react":"18.2.0"}}', '{"dependencies":{"react":"18.3.0"}}'],
  ["deno.json", "jsr.io", "@std/assert", '{"imports":{"@std/assert":"jsr:@std/assert@1.0.0"}}', '{"imports":{"@std/assert":"jsr:@std/assert@1.1.0"}}'],
  ["go.mod", "proxy.golang.org", "github.com/acme/widget", "require github.com/acme/widget v1.0.0", "require github.com/acme/widget v1.1.0"],
  ["Gemfile", "rubygems.org", "rails", 'gem "rails", "7.0.0"', 'gem "rails", "7.1.0"'],
  ["pyproject.toml", "pypi.org", "requests", 'requests = "2.31.0"', 'requests = "2.32.0"'],
  ["app.csproj", "nuget.org", "Serilog", '<PackageReference Include="Serilog" Version="1.0.0" />', '<PackageReference Include="Serilog" Version="1.1.0" />'],
  ["mix.exs", "hex.pm", "plug", 'plug: "~> 1.14.0"', 'plug: "~> 1.15.0"'],
  ["pubspec.yaml", "pub.dev", "http", "http: ^1.0.0", "http: ^1.1.0"],
  ["DESCRIPTION", "cran.r-project.org", "dplyr", "Imports: dplyr (>= 1.0.0)", "Imports: dplyr (>= 1.1.0)"],
  ["Manifest.toml", "juliahub.com", "Example", 'Example = "1.0.0"', 'Example = "1.1.0"'],
  ["composer.json", "packagist.org", "guzzlehttp/guzzle", '{"require":{"guzzlehttp/guzzle":"7.8.0"}}', '{"require":{"guzzlehttp/guzzle":"7.9.0"}}'],
  ["pom.xml", "maven.org", "org.example:widget", 'org.example:widget = "1.0.0"', 'org.example:widget = "1.1.0"'],
];

test("recognizes every supported manifest family", () => {
  for (const [path, registry] of cases) assert.equal(registryFor(`packages/demo/${path}`), registry);
});

for (const [path, registry, name, before, after] of cases) {
  test(`detects ${registry} update in ${path}`, () => {
    const result = changes(`packages/demo/${path}`, before, after);
    assert.equal(result.length, 1);
    assert.equal(result[0].registry, registry);
    assert.equal(result[0].name, name);
    assert.notEqual(result[0].oldVersion, result[0].newVersion);
  });
}

test("handles scoped npm packages and monorepo manifests", () => {
  const result = changes("apps/web/package.json", '{"dependencies":{"@scope/pkg":"2.0.0"}}', '{"dependencies":{"@scope/pkg":"2.1.0"}}');
  assert.deepEqual(result[0], { registry: "npmjs.com", name: "@scope/pkg", oldVersion: "2.0.0", newVersion: "2.1.0" });
});

test("compares Go major-path replacements without merging coexisting majors", () => {
  const base = "github.com/go-chi/chi";
  for (const [oldName, oldVersion, name, newVersion] of [
    [base, "4.1.2+incompatible", `${base}/v5`, "5.5.0"],
    [`${base}/v5`, "5.5.0", `${base}/v12`, "12.0.1"],
    [`${base}/v5`, "5.5.0", base, "4.1.2+incompatible"],
  ]) {
    assert.deepEqual(changes("go.mod", `require ${oldName} v${oldVersion}`, `require ${name} v${newVersion}`), [
      { registry: "proxy.golang.org", name, oldVersion, newVersion },
    ]);
  }
  const before = `require (\n ${base} v4.1.2+incompatible\n ${base}/v5 v5.4.0\n)`;
  assert.deepEqual(changes("go.mod", before, `require ${base}/v5 v5.5.0`), [
    { registry: "proxy.golang.org", name: `${base}/v5`, oldVersion: "5.4.0", newVersion: "5.5.0" },
    { registry: "proxy.golang.org", name: base, oldVersion: "4.1.2+incompatible", newVersion: null, change: "removed" },
  ]);
  const ambiguous = changes("go.mod", before, `require ${base}/v6 v6.0.0`);
  assert.equal(ambiguous.length, 3);
  assert.ok(ambiguous.every(d => d.change === "added" || d.change === "removed"));
  const ambiguousAdditions = changes("go.mod", `require ${base}/v6 v6.0.0`, before);
  assert.equal(ambiguousAdditions.length, 3);
  assert.ok(ambiguousAdditions.every(d => d.change === "added" || d.change === "removed"));
  const addedMajor = changes("go.mod", `require ${base} v4.1.2+incompatible`, before);
  assert.deepEqual(addedMajor, [
    { registry: "proxy.golang.org", name: `${base}/v5`, oldVersion: null, newVersion: "5.4.0", change: "added" },
  ]);
});

test("detects JSR changes with caret specifiers and deno.lock", () => {
  const result = changes("deno.json", '{"imports":{"@std/http":"jsr:@std/http@^1.0.0"}}', '{"imports":{"@std/http":"jsr:@std/http@^1.1.3"}}');
  assert.deepEqual(result[0], { registry: "jsr.io", name: "@std/http", oldVersion: "1.0.0", newVersion: "1.1.3" });
  const lock = changes("deno.lock", '"jsr:@std/http@^1.0.0": "1.0.0"', '"jsr:@std/http@^1.1.3": "1.1.3"');
  assert.deepEqual(lock[0], { registry: "jsr.io", name: "@std/http", oldVersion: "1.0.0", newVersion: "1.1.3" });
  assert.equal(registryFor("services/api/deno.jsonc"), "jsr.io");
});

test("ignores unchanged and newly added dependencies", () => {
  assert.deepEqual(changes("package.json", '{"dependencies":{"a":"1.0.0"}}', '{"dependencies":{"a":"1.0.0","b":"2.0.0"}}'), [{ registry: "npmjs.com", name: "b", oldVersion: null, newVersion: "2.0.0", change: "added" }]);
});

test("reports added and removed dependencies without package links", () => {
  const result = changes("package.json", '{"dependencies":{"removed":"1.0.0"}}', '{"dependencies":{"added":"2.0.0"}}');
  assert.deepEqual(result, [
    { registry: "npmjs.com", name: "added", oldVersion: null, newVersion: "2.0.0", change: "added" },
    { registry: "npmjs.com", name: "removed", oldVersion: "1.0.0", newVersion: null, change: "removed" },
  ]);
  const body = markdown(result);
  assert.match(body, /\| added \| — \| 2\.0\.0 \| — \|/);
  assert.match(body, /\| removed \| 1\.0\.0 \| — \| — \|/);
});

test("creates stable direct links and an empty result", () => {
  const body = markdown([{ registry: "npmjs.com", name: "@scope/pkg", oldVersion: "1.0.0", newVersion: "1.1.0" }]);
  assert.match(body, /https:\/\/unpackage\.dev\/#npmjs\.com\/%40scope%2Fpkg@1\.0\.0\.\.\.1\.1\.0/);
  assert.match(markdown([]), /No dependency version changes found/);
});

test("does not treat an empty dependency result as a comment", () => {
  assert.equal(markdown([]).startsWith("<!-- unpackage.dev dependency diff -->"), true);
  assert.equal(changes("package.json", '{"dependencies":{"a":"1.0.0"}}', '{"dependencies":{"a":"1.0.0"}}').length, 0);
});
