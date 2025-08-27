// tools/agent/triage.ts
import fs from "node:fs/promises";
import path from "node:path";
import { Octokit } from "@octokit/rest";

type Cfg = {
  labels: Record<string,string[]>;
  priorities: Record<string,string[]>;
  areas: string[];
};

function pick<T extends string>(map: Record<T,string[]>, text: string): T[] {
  const hit = new Set<T>();
  const lower = text.toLowerCase();
  for (const [label, words] of Object.entries(map) as [T,string[]][]) {
    for (const w of words) if (lower.includes(w.toLowerCase())) hit.add(label);
  }
  return [...hit];
}

async function readCfg(): Promise<Cfg> {
  const p = path.resolve(".firecrawl-agent.yml");
  const raw = await fs.readFile(p, "utf8");
  // super-light YAML parse without deps:
  // we only need the keyword lists; for simplicity you can keep this minimal or install "yaml"
  const yaml = await import("yaml");
  return yaml.parse(raw) as Cfg;
}

async function main() {
  const repoFull = process.env.GITHUB_REPOSITORY ?? "";
  const [owner, repo] = repoFull.split("/");
  if (!owner || !repo) {
    console.log("No GITHUB_REPOSITORY; running locally. Exit.");
    return;
  }

  const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const { data: issues } = await octo.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue is:open -label:triaged`,
    per_page: 1,
    sort: "created",
    order: "desc",
  });
  const issue = issues.items[0];
  if (!issue) {
    console.log("No new issues to triage.");
    return;
  }

  const cfg = await readCfg();
  const text = `${issue.title}\n\n${issue.body ?? ""}`;

  const baseLabels = pick(cfg.labels as any, text); // ["bug"] | ["docs"] | ["perf"]...
  const prios = pick(cfg.priorities as any, text);  // ["P0"] | ["P1"]...
  // naive area guess: match keyword by name
  const area =
    cfg.areas.find(a => text.toLowerCase().includes(a.toLowerCase())) ?? "pipeline";

  const labelsToAdd = [...baseLabels, ...prios, `area:${area}`, "triaged"].filter(Boolean);

  if (labelsToAdd.length) {
    await octo.issues.addLabels({ owner, repo, issue_number: issue.number, labels: labelsToAdd });
  }

  // post repro checklist
  await octo.issues.createComment({
    owner, repo, issue_number: issue.number,
    body: `### Repro checklist
- Minimal input (URL / HTML snippet / API payload)
- Exact command(s) you ran
- Expected vs actual output
- Full error text (copy/paste)
- Environment: OS, Node version, package versions

Reply with **repro-ready** when done. The agent will attempt an automated repro.`,
  });

  console.log(`Triaged #${issue.number} with labels: ${labelsToAdd.join(", ")}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
