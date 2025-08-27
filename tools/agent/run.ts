// tools/agent/run.ts
import { Octokit } from "@octokit/rest";
import { execSync } from "node:child_process";
import type { ExecSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { fileURLToPath } from "node:url";

// ---------- utilities ----------
function sh(cmd: string, opts: ExecSyncOptions = {}) {
  const o: ExecSyncOptions = { stdio: "inherit", ...opts };
  execSync(cmd, o);
}

function run(cmd: string, opts: ExecSyncOptions = {}) {
  const o: ExecSyncOptions = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts };
  return execSync(cmd, o).toString();
}

function writeFileSafe(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function now() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// very small unified diff applier (new files & line edits)
// supports patches produced by our prompt; not a full patch engine.
function applyUnifiedDiff(diff: string) {
  const files = diff.split(/^diff --git .*$/m).filter(Boolean);
  for (const block of files) {
    const fileHeader = block.match(/\n\+\+\+ b\/([^\n]+)\n/);
    const newPath = fileHeader?.[1];
    const oldHeader = block.match(/\n--- a\/([^\n]+)\n/);
    const oldPath = oldHeader?.[1] ?? newPath;

    if (!newPath) continue;

    // If it's a brand new file, grab the @@ chunk and reconstruct lines after '+' (except '+++', '---')
    if (/new file mode/.test(block) || !fs.existsSync(newPath)) {
      const lines: string[] = [];
      const hunks = block.split(/^@@ .*@@.*$/m).slice(1);
      for (const h of hunks) {
        for (const ln of h.split("\n")) {
          if (ln.startsWith("+")) lines.push(ln.slice(1));
          else if (!ln.startsWith("-") && !ln.startsWith("\\")) lines.push(ln);
        }
      }
      writeFileSafe(newPath, lines.join("\n").replace(/^\n/, ""));
      continue;
    }

    // For edits, we’ll just replace file content with the “after” view reconstructed from hunks.
    // (Good enough for small patches.)
const pathToRead = oldPath ?? newPath;          // fall back to newPath if oldPath is missing
const original = fs.readFileSync(pathToRead, "utf8").split("\n");
let after = original.slice();

    // If the patch includes a full-file blob (common with our prompt), prefer lines after '+' ignoring '-'.
    const hunks = block.split(/^@@ .*@@.*$/m).slice(1);
    if (hunks.length) {
      const reconstructed: string[] = [];
      for (const h of hunks) {
        for (const ln of h.split("\n")) {
          if (ln.startsWith("+")) reconstructed.push(ln.slice(1));
          else if (!ln.startsWith("-") && !ln.startsWith("\\")) reconstructed.push(ln);
        }
      }
      if (reconstructed.length) after = reconstructed;
    }

    writeFileSafe(newPath, after.join("\n"));
  }
}

// ---------- config ----------
type AgentCfg = {
  conventions?: {
    whitelistPaths?: string[];
    testCmd?: string;
  };
};

function loadAgentCfg(): AgentCfg {
  const cfgPath = path.resolve(".firecrawl-agent.yml");
  if (!fs.existsSync(cfgPath)) return {};
  const raw = fs.readFileSync(cfgPath, "utf8");
  return YAML.parse(raw) ?? {};
}

// ---------- openai ----------
type OpenAIResp = { content: string };
async function llm(prompt: string): Promise<OpenAIResp> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  // Short, deterministic responses for CI
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  const content = completion.choices?.[0]?.message?.content ?? "";
  return { content };
}

// ---------- core ----------
async function main() {
  const repoFull = process.env.GITHUB_REPOSITORY ?? "";
  const [owner, repo] = repoFull.split("/");
  if (!owner || !repo) {
    console.log("[run] local run; exiting.");
    return;
  }
  if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN missing");

  const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const cfg = loadAgentCfg();
  const testCmd = cfg.conventions?.testCmd ?? "pnpm test";
  const whitelist = new Set(
    (cfg.conventions?.whitelistPaths ?? ["packages/", "src/", "docs/", "CHANGELOG.md"]).map(p =>
      p.replace(/^\.\//, "")
    )
  );

  // 1) Find target issue: open, triaged, no has-pr, has 'repro-ready' comment
  const search = await octo.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue is:open label:triaged -label:has-pr`,
    sort: "updated",
    order: "desc",
    per_page: 10,
  });

  let target: { number: number; title: string; body?: string } | null = null;
  for (const it of search.data.items) {
    const { data: comments } = await octo.issues.listComments({
      owner,
      repo,
      issue_number: it.number,
      per_page: 50,
    });
    if (comments.some(c => /repro-ready/i.test(c.body ?? ""))) {
      target = { number: it.number, title: it.title, body: it.body ?? "" };
      break;
    }
  }

  if (!target) {
    console.log("[run] no triaged issue with 'repro-ready' found");
    return;
  }
  console.log(`[run] working on issue #${target.number}: ${target.title}`);

  // 2) Git branch
  const branch = `agent/${target.number}-${now()}`;
  sh('git config user.name "agent-bot"');
  sh('git config user.email "agent-bot@users.noreply.github.com"');
  sh(`git checkout -b ${branch}`);

  // 3) Generate a failing test (Vitest)
  const safeTestName = target.title.replace(/[^\w\- ]+/g, "").slice(0, 60).trim().replace(/\s+/g, "_");
  const testFile = path.join("tests", "agent", `issue_${target.number}.${safeTestName}.test.ts`);

  const testBody = `import { describe, it, expect } from "vitest";
import { runHtmlToMd } from "./utils";

describe("issue #${target.number}: ${target.title.replace(/"/g, '\\"')}", () => {
  it("reproduces the reported behavior", async () => {
    const html = ${JSON.stringify((target.body || "").slice(0, 2000) || "<div>example</div>")};
    const md = await runHtmlToMd(html);
    // Update this expect once a real repro is known. Start by asserting it is non-empty:
    expect(md).toBeTruthy();
    // Example failure we *want* initially:
    expect(md).toContain("__EXPECTED_THAT_FAILS__");
  });
});
`;
  writeFileSafe(testFile, testBody);
  console.log(`[run] wrote failing test: ${testFile}`);

  // 4) Run tests (expect failure)
  let testsFailed = false;
  try {
    sh(testCmd);
  } catch {
    testsFailed = true;
    console.log("[run] tests failed as expected; proceeding to patch");
  }

  // 5) If tests didn't fail, we still continue to patch minimal code (keeps loop moving)
  // Get a unified diff proposal from the LLM, constrained to whitelist paths.
  const repoRoot = run("pwd").trim();
  const fileList = run("git ls-files").split("\n").slice(0, 400).join("\n");
  const prompt = `
You are a careful code-mod bot.

Goal: propose a **minimal unified diff** to fix issue #${target.number} in repo "${owner}/${repo}".
The failing test is at: ${testFile}

Only modify files under these allowed paths: ${Array.from(whitelist).join(", ")}.
If a change must be outside these, instead modify code in allowed areas and/or adjust the test accordingly.

Rules:
- Output **only** a single unified diff (git format) touching at most 3 files.
- Prefer small, targeted changes.
- If you must create a new file (e.g., a helper), include it as a new file in the diff.
- Do not include explanations outside the diff.

Repo root: ${repoRoot}
Known files (truncated):
${fileList}
`.trim();

  const { content } = await llm(prompt);
  const diffText = (content || "").trim();

  if (!/^diff --git /m.test(diffText)) {
    console.log("[run] LLM did not return a unified diff; skipping patch application.");
  } else {
    // Guardrail: ensure all paths in diff are whitelisted
  // Collect paths from the diff and ensure they are strings
const addedPaths = [...diffText.matchAll(/\n\+\+\+ b\/([^\n]+)\n/g)]
  .map(m => m[1])
  .filter((p): p is string => typeof p === "string" && p.length > 0);

// normalize "./" prefixes for comparison
const norm = (s: string) => s.replace(/^[.][/\\]/, "");

// true if any touched path is outside the whitelist
const badPath = addedPaths.some(p =>
  !Array.from(whitelist).some(w => norm(p).startsWith(norm(w)))
);

if (badPath) {
  console.log("[run] diff touches non-whitelisted paths; rejecting.");
} else {
  fs.writeFileSync(".agent.diff", diffText, "utf8"); // ← normal quotes
  console.log("[run] applying diff");
  applyUnifiedDiff(diffText);
}

  }

  // 6) Stage, commit, test again
  sh("git add -A");
  // Commit even if no changes, so PR still opens with failing test
  try {
    sh(`git commit -m "test(agent): failing test for #${target.number} + minimal patch"`);
  } catch {
    console.log("[run] nothing to commit after applying diff; continuing");
  }

  let afterPass = false;
  try {
    sh(testCmd);
    afterPass = true;
  } catch {
    afterPass = false;
  }

  // 7) Push & PR
  sh(`git push origin ${branch}`);

  const prTitle = afterPass
    ? `[agent] fix: ${target.title} (#${target.number})`
    : `[agent] failing test for #${target.number}`;

  const prBody = [
    `Automated ${afterPass ? "fix" : "repro"} for #${target.number}.`,
    afterPass ? "- Tests passing locally in CI." : "- Tests currently failing; needs review.",
    fs.existsSync(".agent.diff") ? "\nAttached minimal diff proposed by agent." : "",
  ].join("\n");

  const pr = await octo.pulls.create({
    owner,
    repo,
    title: prTitle,
    head: branch,
    base: "main",
    body: prBody,
  });

  // 8) Label + comment back
  await octo.issues.addLabels({ owner, repo, issue_number: target.number, labels: ["has-pr"] });
  await octo.issues.createComment({
    owner,
    repo,
    issue_number: target.number,
    body: `Opened PR: ${pr.data.html_url}\n\nStatus: ${afterPass ? "✅ tests passing" : "❌ tests failing (intentional for repro)"}`
  });

  console.log(`[run] opened PR #${pr.data.number} (pass=${afterPass})`);
}

main().catch(e => {
  console.error("[run] FAILED:");
  console.error(e?.stack || e);
  process.exit(1);
});
