# crates-diff

A small [Deno] web app that lets you search [crates.io] and view a folder-style
git diff between any two published versions of a crate.

Live at <https://crate-diff.leigh.deno.net/>.

By default the right side shows the latest version and the left side shows the
version before it. Change either selector to diff any two versions.

The comparison state lives in the URL hash, so a link like
<https://crate-diff.leigh.deno.net/#serde/1.0.227...1.0.228> opens directly to
that diff and is shareable.

## Running locally

```
deno run --allow-net --allow-read --allow-env main.ts
```

Then open <http://localhost:8000>. Set `PORT` to override the port.

## How it works

The Deno server is intentionally tiny. It only exists to proxy three crates.io
endpoints because crates.io does not serve CORS headers to browsers and
requires a `User-Agent`:

- `GET /api/search?q=...` &rarr; crates.io crate search
- `GET /api/crate/{name}` &rarr; crate metadata and versions
- `GET /api/download/{name}/{version}` &rarr; the raw `.crate` tarball

Everything else happens in the browser:

- `pako` inflates the gzipped `.crate`.
- A small pax-aware tar parser extracts the file tree.
- `jsdiff` produces unified diffs per file.
- The browser Cache API stores tarballs so repeat comparisons are instant.

No shelling out, no git, no filesystem temp dirs.

## Project layout

```
main.ts             Deno server (proxy + static file serving)
static/index.html   UI shell
static/style.css    Styling (light + dark)
static/app.js       Search, tar parsing, diffing, URL-hash sync
```

## License

[Apache-2.0](./LICENSE)

[Deno]: https://deno.com
[crates.io]: https://crates.io
