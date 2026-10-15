// Adds a GitHub link next to the project name in the chat header breadcrumb.
// T3 never renders the repo URL, so this reads the project's git remote from
// the breadcrumb's React props (activeProject.repositoryIdentity).
const GITHUB_MARK = '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>';

// git@github.com:Owner/Repo.git, ssh://git@github.com/Owner/Repo or
// https://github.com/Owner/Repo.git all become https://github.com/Owner/Repo.
const webUrl = (identity) => {
  const remote = identity?.locator?.remoteUrl;
  if (remote) {
    const match = remote.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/i);
    if (match) return `https://${match[1]}/${match[2]}`;
  }
  if (identity?.provider === "github" && identity.owner && identity.name) {
    return `https://github.com/${identity.owner}/${identity.name}`;
  }
  return null;
};

T3Mods.onScan("github-repo", () => {
  const breadcrumb = document.querySelector('header[data-chat-header="true"] nav ol');
  const projectCrumb = breadcrumb?.querySelector(":scope > li:first-child");
  if (!projectCrumb) return;
  const identity = T3Mods.reactProp(breadcrumb, "activeProject")?.repositoryIdentity;
  const url = webUrl(identity);
  let link = projectCrumb.querySelector(':scope > a[data-t3-mod="github-repo"]');

  if (!url) {
    link?.remove();
    return;
  }
  if (!link) {
    link = document.createElement("a");
    link.dataset.t3Mod = "github-repo";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className =
      "ml-1.5 inline-flex shrink-0 items-center rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";
    link.append(T3Mods.icon(GITHUB_MARK));
    projectCrumb.append(link);
  }
  if (link.href !== url) {
    const label = `Open ${url.replace(/^https:\/\/[^/]+\//, "")} on ${new URL(url).host}`;
    link.href = url;
    link.title = label;
    link.setAttribute("aria-label", label);
  }
});
