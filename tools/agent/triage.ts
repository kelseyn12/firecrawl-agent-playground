// tools/agent/triage.ts
import fs from "node:fs/promises";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import YAML from "yaml";   // <-- keep this one

type Cfg = {
  labels: Record<string,string[]>;
  priorities: Record<string,string[]>;
  areas: string[];
};

function pick<T extends string>(map: Record<T,string[]>, text: string): T[] {
  const hit = new Set<T>();
  const lower = (text || "").toLowerCase();
  for (const [label, words] of Object.entries(map) as [T,string[]][]) {
    for (const w of words) if (lower.includes(w.toLowerCase())) hit.add(label);
  }
  return [...hit];
}

async function readCfg(): Promise<Cfg> {
  const p = path.resolve(".firecrawl-agent.yml");
  const raw = await fs.readFile(p, "utf8");
  return YAML.parse(raw) as Cfg;   // <-- use the static import
}
