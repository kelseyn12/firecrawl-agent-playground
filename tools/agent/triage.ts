import { Octokit } from "octokit";
console.log("triage stub running");

const repo = process.env.GITHUB_REPOSITORY || "";
const [owner, name] = repo.split("/");
if (!owner || !name) {
  console.log("No GITHUB_REPOSITORY locally; exiting.");
  process.exit(0);
}

const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });
console.log(`Would triage latest issue in ${owner}/${name}`);
