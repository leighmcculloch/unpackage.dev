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

test("ignores unchanged and newly added dependencies", () => {
  assert.deepEqual(changes("package.json", '{"dependencies":{"a":"1.0.0"}}', '{"dependencies":{"a":"1.0.0","b":"2.0.0"}}'), []);
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
