// tools/agent/triage.ts
import fs from "node:fs/promises";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import YAML from "yaml";

type Cfg = {
  labels: Record<string, string[]>;
  priorities: Record<string, string[]>;
  areas: string[];
};

function pick<T extends string>(map: Record<T, string[]>, text: string): T[] {
  const out = new Set<T>();
  const lower = (text || "").toLowerCase();
  for (const [label, words] of Object.entries(map) as [T, string[]][]) {
    for (const w of words) if (lower.includes(w.toLowerCase())) out.add(label);
  }
  return [...out];
}

async function readCfg(): Promise<Cfg> {
  const p = path.resolve(".firecrawl-agent.yml");
  console.log(`[triage] reading config: ${p}`);
  const raw = await fs.readFile(p, "utf8");
  const cfg = YAML.parse(raw) as Cfg;
  if (!cfg?.labels || !cfg?.priorities || !cfg?.areas) {
    throw new Error("[triage] invalid .firecrawl-agent.yml (missing labels/priorities/areas)");
  }
  return cfg;
}

async function main() {
  const repoFull = process.env.GITHUB_REPOSITORY ?? "";
  const [owner, repo] = repoFull.split("/");
  if (!owner || !repo) {
    console.log("[triage] No GITHUB_REPOSITORY (local run) — exiting.");
    return;
  }
  if (!process.env.GITHUB_TOKEN) {
    throw new Error("[triage] GITHUB_TOKEN is missing in env");
  }

  console.log(`[triage] repo: ${owner}/${repo}`);
  const cfg = await readCfg();

  const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });

  console.log("[triage] searching for newest open issue without 'triaged' label…");
  const res = await octo.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue is:open -label:triaged`,
    sort: "created",
    order: "desc",
    per_page: 1,
  });

  const issue = res.data.items[0];
  if (!issue) {
    console.log("[triage] no new issues to triage");
    return;
  }
  console.log(`[triage] found issue #${issue.number}: ${issue.title}`);

  const text = `${issue.title}\n\n${issue.body ?? ""}`;
  const base = pick(cfg.labels as any, text);
  const prios = pick(cfg.priorities as any, text);
  const area = cfg.areas.find(a => text.toLowerCase().includes(a.toLowerCase())) ?? "pipeline";

  const labelsToAdd = [...base, ...prios, `area:${area}`, "triaged"].filter(Boolean);
  console.log(`[triage] labels to add: ${labelsToAdd.join(", ") || "(none)"}`);

  if (labelsToAdd.length > 0) {
    await octo.issues.addLabels({ owner, repo, issue_number: issue.number, labels: labelsToAdd });
    console.log("[triage] labels added");
  }

  const checklist = `### Repro checklist
- Minimal input (URL / HTML snippet / API payload)
- Exact command(s) you ran
- Expected vs actual output
- Full error text (copy/paste)
- Environment: OS, Node, package versions

Reply with **repro-ready** when done. The agent will attempt an automated repro.`;

  await octo.issues.createComment({ owner, repo, issue_number: issue.number, body: checklist });
  console.log("[triage] checklist posted");
  console.log(`[triage] ✅ triaged issue #${issue.number}`);
}

main().catch(err => {
  console.error("[triage] ❌ FAILED");
  console.error(err?.stack || err);
  process.exit(1);
});
