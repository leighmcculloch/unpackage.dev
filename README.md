# unpackage.dev

A small [Deno] web app that lets you search [crates.io], [npmjs.com],
[proxy.golang.org][pkg.go.dev], [rubygems.org], [pypi.org], [nuget.org],
[hex.pm], and [pub.dev], and view a folder-style git diff between any two
published versions of a package.

Live at <https://unpackage.dev/>.

By default the right side shows the latest version and the left side shows the
version before it. Change either selector to diff any two versions; set `old`
to `None (just view source)` to browse a single version.

The comparison state lives in the URL hash, so a link like
<https://unpackage.dev/#crates.io/serde@1.0.227...1.0.228> opens
directly to that diff and is shareable. Line selections are included too, for
example `…@1.0.228/src/lib.rs?L10-L20`.

## Running locally

```
deno run --allow-net --allow-read --allow-env main.ts
```

Then open <http://localhost:8000>. Set `PORT` to override the port.

## How it works

The Deno server is intentionally tiny — it only proxies each registry's API so
the browser doesn't trip over CORS or missing `User-Agent` requirements:

- `GET /api/registry/{registry}/search?q=…` &rarr; search
- `GET /api/registry/{registry}/package/{name}` &rarr; package metadata and versions
- `GET /api/registry/{registry}/download/{name}/{version}` &rarr; the archive

`{registry}` is one of `crates.io`, `npmjs.com`, `proxy.golang.org`,
`rubygems.org`, `pypi.org`, `nuget.org`, `hex.pm`, or `pub.dev`.

Everything else happens in the browser:

- `pako` inflates gzipped tar archives (crates.io / npm); a small in-browser
  zip parser handles Go module archives.
- A small pax-aware tar parser extracts the file tree.
- `jsdiff` produces unified diffs per file.
- `highlight.js` applies syntax highlighting per token, split across diff rows.
- The browser Cache API stores archives so repeat comparisons are instant.

No shelling out, no git, no filesystem temp dirs.

## Project layout

```
main.ts             Deno server (proxy + static file serving)
static/index.html   UI shell
static/style.css    Styling (light + dark)
static/app.js       Search, archive parsing, diffing, URL-hash sync
```

## License

[Apache-2.0](./LICENSE)

[Deno]: https://deno.com
[crates.io]: https://crates.io
[npmjs.com]: https://www.npmjs.com
[pkg.go.dev]: https://pkg.go.dev
[rubygems.org]: https://rubygems.org
[pypi.org]: https://pypi.org
[nuget.org]: https://www.nuget.org
[hex.pm]: https://hex.pm
[pub.dev]: https://pub.dev
