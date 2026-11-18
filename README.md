# unpackage.dev

Compare the actual source of two versions of a package, side by side, in your
browser.

Live at <https://unpackage.dev>.

## Why

When you bump a dependency, you want to know what actually changed. The most
convenient way most developers do this is to open the package on GitHub and
eyeball the commits between two tags.

But the code on GitHub is not the code you install.

Registries — crates.io, npmjs.com, proxy.golang.org, and friends — serve
tarballs that a publisher built and uploaded. Those tarballs can contain
pre-built output, extra generated files, omitted source, entirely different
files, or in the worst case a supply-chain attack. GitHub is the repo; the
registry is what actually lands in your `node_modules`, `~/.cargo/registry`,
or `site-packages`. Reading GitHub is mostly security theatre when auditing a
dependency update.

A few ecosystems have nice tools for this — [diff.rs] for Rust crates, for
example — but there's no cross-ecosystem place you can go with any package
name and a pair of versions and just _see_ the diff of what's actually being
shipped.

unpackage.dev is that place. It fetches the registry archives, unpacks them in
your browser, and shows you a proper folder-style diff — file tree, per-file
expandable hunks, syntax highlighting, and shareable deep links down to
selected line ranges — for every supported ecosystem.

## Supported ecosystems

| Language | Registry |
| --- | --- |
| Rust | [crates.io] |
| JavaScript | [npmjs.com] |
| TypeScript / Deno | [jsr.io] |
| Go | [proxy.golang.org] (docs on [pkg.go.dev]) |
| Ruby | [rubygems.org] |
| Python | [pypi.org] |
| .NET | [nuget.org] |
| Elixir / Erlang | [hex.pm] |
| Dart | [pub.dev] |
| R | [CRAN][cran] |
| Julia | [juliahub.com] (archives via [JuliaRegistries/General][julia-general] and GitHub) |
| PHP | [packagist.org] |
| Java | Maven Central ([search.maven.org]) |

Want another ecosystem? [Open an issue][issues] — happy to add more.

## How to use it

### Review a pull request

Open **Review a pull request**, paste a public GitHub pull request URL,
and click **Find changes**. The website lists detected dependency
updates, additions, and removals. Click **View diff** to compare published
packages, or **View source** for an added or removed dependency. The list stays
available while you review packages, and the URL preserves the PR for sharing.

No action installation or GitHub sign-in is needed. Detection reuses the action's
manifest parsers; unsupported lockfile formats and unpinned dependencies may not
be detected. Private repositories are not supported. GitHub's unauthenticated
API limits apply, so large PRs or busy periods may require trying again later.

### GitHub Action

Projects can add the bundled action to a pull-request workflow:

```yaml
steps:
- uses: leighmcculloch/unpackage.dev@main
```

The action reads changed dependency manifests from the pull request, supports
all ecosystems listed above, and updates one pull-request comment with old and
new versions plus direct unpackage.dev links. Give the job `contents: read` and
`pull-requests: write` permissions. It is intentionally limited to pull
requests.

1. Pick the ecosystem from the dropdown and start typing a package name.
2. Pick the version you're on in the _old_ dropdown, and the version you're
   moving to in the _new_ dropdown. If you leave _old_ as `None (just view
   source)`, you just browse a single version.
3. The file tree on the left lists what changed (or every file, if you switch
   the filter to `All`). Clicking a file scrolls to it. Clicking a gutter line
   number selects that line — Shift-click to extend a range.
4. Copy the URL from the address bar to share the exact view you're looking
   at. URLs look like
   `#crates.io/serde@1.0.227...1.0.228/src/lib.rs?L10-L20` — registry, package,
   version range, file path, and line range all round-trip.
5. Hit _Download_ in the file browser if you want the original tarball(s) the
   app fetched, to look at them offline.

## Running locally

```
deno task start
```

Then open <http://localhost:8000>. Set `PORT` to override the port.

## How it works

The Deno server is a tiny proxy — most registries don't send CORS headers and
some require a `User-Agent`, so the browser can't reach them directly. The
server normalises each registry's search/metadata/download APIs to a single
shape:

- `GET /api/registry/{registry}/search?q=…`
- `GET /api/registry/{registry}/package/{name}`
- `GET /api/registry/{registry}/download/{name}/{version}`

For PR review, `GET /api/github/pull-request?url=…` reads public manifests from
GitHub at the PR's merge base and head, then uses the action's dependency parser
to return version changes. It never executes repository code or posts comments.

`{registry}` is one of `crates.io`, `npmjs.com`, `jsr.io`,
`proxy.golang.org`, `rubygems.org`, `pypi.org`, `nuget.org`, `hex.pm`,
`pub.dev`, `cran.r-project.org`, `juliahub.com`, `packagist.org`, or
`maven.org`.

Everything else happens in the browser:

- `pako` inflates gzipped tar archives. An in-browser zip parser handles Go
  module and NuGet archives. Ruby `.gem` and Hex `.tar` archives wrap a nested
  `data.tar.gz` / `contents.tar.gz` that the frontend unpacks transparently
  and decorates with gem/hex metadata files so meta-packages aren't empty.
- A small pax-aware tar parser extracts the file tree.
- `jsdiff` produces unified diffs per file.
- `highlight.js` applies syntax highlighting per token, split across diff rows.
- The browser Cache API stores archives so repeat comparisons and history
  navigation are instant.

No shelling out, no `git`, no filesystem temp dirs — everything is client-side
after the initial proxy hop.

## Contributing

Issues and PRs welcome at <https://github.com/leighmcculloch/unpackage.dev>.
The most interesting contribution is probably adding another registry — look
at how crates.io / npm / Go are wired up in `main.ts` and `static/app.js`,
mirror the pattern, and open a PR.

## License

[Apache-2.0](./LICENSE)

[Deno]: https://deno.com
[diff.rs]: https://diff.rs
[issues]: https://github.com/leighmcculloch/unpackage.dev/issues
[crates.io]: https://crates.io
[npmjs.com]: https://www.npmjs.com
[jsr.io]: https://jsr.io
[proxy.golang.org]: https://proxy.golang.org
[pkg.go.dev]: https://pkg.go.dev
[rubygems.org]: https://rubygems.org
[pypi.org]: https://pypi.org
[nuget.org]: https://www.nuget.org
[hex.pm]: https://hex.pm
[pub.dev]: https://pub.dev
[cran]: https://cran.r-project.org
[juliahub.com]: https://juliahub.com
[julia-general]: https://github.com/JuliaRegistries/General
[packagist.org]: https://packagist.org
[search.maven.org]: https://search.maven.org
