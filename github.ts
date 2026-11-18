import { createRequire } from "node:module";

// Use the action's parser directly so website and action detection stay in sync.
const { changes, registryFor } = createRequire(import.meta.url)(
  "./index.js",
) as {
  registryFor(path: string): string | null;
  changes(path: string, before: string, after: string): DependencyChange[];
};

type DependencyChange = {
  registry: string;
  name: string;
  oldVersion: string | null;
  newVersion: string | null;
  change?: string;
};

export async function pullRequest(input: string): Promise<Response> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return new Response("Enter a GitHub pull request URL.", { status: 400 });
  }
  const match = url.pathname.match(
    /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/.*)?$/,
  );
  if (
    url.origin !== "https://github.com" || !match || url.username ||
    url.password
  ) {
    return new Response(
      "Enter a URL like https://github.com/owner/repo/pull/123.",
      {
        status: 400,
      },
    );
  }
  const [, owner, repo, number] = match;
  const path = `/repos/${owner}/${repo}`;

  async function github(endpoint: string, raw = false): Promise<Response> {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      headers: {
        "Accept": raw
          ? "application/vnd.github.raw+json"
          : "application/vnd.github+json",
        "User-Agent": "unpackage.dev",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const message = response.status === 404
        ? "Pull request or file not found. Only public GitHub repositories are supported."
        : response.status === 403 || response.status === 429
        ? "GitHub's API limit was reached. Please try again later."
        : `GitHub could not load this pull request (${response.status}).`;
      throw new Response(message, {
        status: response.status === 404 ? 404 : 502,
      });
    }
    return response;
  }

  async function fileAt(repository: string, sha: string, filename: string) {
    const encoded = filename.split("/").map(encodeURIComponent).join("/");
    return await (await github(
      `/repos/${repository}/contents/${encoded}?ref=${encodeURIComponent(sha)}`,
      true,
    )).text();
  }

  try {
    const pr = await (await github(`${path}/pulls/${number}`)).json();
    if (pr.changed_files > 3000) {
      return new Response(
        "This pull request exceeds GitHub's 3,000-file limit.",
        { status: 422 },
      );
    }
    if (!pr.head.repo) {
      return new Response(
        "The pull request's source repository is no longer available.",
        { status: 422 },
      );
    }
    // Compare against the merge base, not newer commits on the target branch.
    const comparison = await (await github(
      `${path}/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`,
    )).json();
    const dependencies = new Map<string, DependencyChange>();
    let supportedFiles = 0;
    for (
      let page = 1;
      page <= Math.max(1, Math.ceil(pr.changed_files / 100));
      page++
    ) {
      const files = await (await github(
        `${path}/pulls/${number}/files?per_page=100&page=${page}`,
      )).json();
      for (const file of files) {
        if (!registryFor(file.filename)) continue;
        supportedFiles++;
        const [before, after] = await Promise.all([
          file.status === "added" ? "" : fileAt(
            pr.base.repo.full_name,
            comparison.merge_base_commit.sha,
            file.previous_filename ?? file.filename,
          ),
          file.status === "removed"
            ? ""
            : fileAt(pr.head.repo.full_name, pr.head.sha, file.filename),
        ]);
        for (const dep of changes(file.filename, before, after)) {
          // Keep distinct version pairs when workspaces use different versions.
          dependencies.set(
            JSON.stringify([
              dep.registry,
              dep.name,
              dep.oldVersion,
              dep.newVersion,
            ]),
            dep,
          );
        }
      }
    }
    return Response.json({
      title: pr.title,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
      supportedFiles,
      dependencies: [...dependencies.values()].sort((a, b) =>
        a.name.localeCompare(b.name)
      ),
    }, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Pull request lookup failed", error);
    return new Response("Could not load this pull request. Please try again.", {
      status: 502,
    });
  }
}
