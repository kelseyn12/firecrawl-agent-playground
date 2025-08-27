// tools/agent/run.ts
import { Octokit } from "@octokit/rest";
import { execSync } from "node:child_process";
import fs from "node:fs";

function sh(cmd: string) { execSync(cmd, { stdio: "inherit" }); }

async function main() {
  const repoFull = process.env.GITHUB_REPOSITORY ?? "";
  const [owner, repo] = repoFull.split("/");
  if (!owner || !repo) {
    console.log("No GITHUB_REPOSITORY; local run ends.");
    return;
  }
  const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });

  // pick an open, triaged issue with a "repro-ready" comment and no "has-pr" label
  const { data: issues } = await octo.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue is:open label:triaged -label:has-pr`,
    per_page: 10,
    sort: "updated",
    order: "desc",
  });

  let target: { number: number } | null = null;
  for (const it of issues.items) {
    const { data: comments } = await octo.issues.listComments({ owner, repo, issue_number: it.number, per_page: 50 });
    if (comments.some(c => /repro-ready/i.test(c.body ?? ""))) {
      target = { number: it.number };
      break;
    }
  }

  if (!target) {
    console.log("No triaged issue with 'repro-ready' found.");
    return;
  }

  const branch = `agent/${target.number}`;
  // configure git actor (Actions runner)
  sh('git config user.name "agent-bot"');
  sh('git config user.email "agent-bot@users.noreply.github.com"');
  sh(`git checkout -b ${branch}`);

  // ensure CHANGELOG exists, then append one line
  if (!fs.existsSync("CHANGELOG.md")) fs.writeFileSync("CHANGELOG.md", "# Changelog\n\n");
  const line = `- chore(agent): placeholder change for issue #${target.number}\n`;
  fs.appendFileSync("CHANGELOG.md", line);

  sh("git add CHANGELOG.md");
  sh(`git commit -m "chore(agent): placeholder change for #${target.number}" || true`);
  sh(`git push origin ${branch}`);

  const pr = await octo.pulls.create({
    owner, repo,
    title: `[agent] placeholder PR for #${target.number}`,
    head: branch,
    base: "main",
    body: `Automated placeholder PR to verify agent branching & permissions.\n\nCloses #${target.number} (manual).`,
  });

  await octo.issues.addLabels({ owner, repo, issue_number: target.number, labels: ["has-pr"] });
  await octo.issues.createComment({ owner, repo, issue_number: target.number, body: `Opened PR: ${pr.data.html_url}` });

  console.log(`Opened PR ${pr.data.number} for issue #${target.number}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
