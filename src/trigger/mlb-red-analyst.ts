// Red-team analyst: devil's advocate against ONE green-team pick.
// Aggregator dispatches this for the top 6 candidates after green-team scoring;
// adjustments are auto-applied to finalConfidence and used for re-ranking.

import { task } from "@trigger.dev/sdk/v3";
import Anthropic from "@anthropic-ai/sdk";
import {
  RED_TEAM_RULES_BLOCK, RED_TEAM_OUTPUT_SCHEMA, institutionalKnowledgeBlock, parseRedTeamJSON,
  type GamePickResult, type RedTeamReview,
} from "../lib/analysis-shared.js";
import type { CompiledGame } from "./mlb-fetch-data.js";
import type { TavilyResults } from "../lib/tavily.js";
import type { Lesson } from "../lib/notion.js";

export interface RedAnalystPayload {
  date: string;
  greenPick: GamePickResult;
  game: CompiledGame;
  tavilyResults: TavilyResults;
  lessons?: Lesson[];
}

export interface RedAnalystResult {
  review: RedTeamReview;
}

function buildRedTeamPrompt(p: RedAnalystPayload): string {
  const { greenPick, game, tavilyResults } = p;

  return `You are the RED TEAM analyst. Challenge the GREEN TEAM's pick below.

${RED_TEAM_RULES_BLOCK}

${RED_TEAM_OUTPUT_SCHEMA}

---

${institutionalKnowledgeBlock(p.lessons ?? [])}

When a lesson directly contradicts the green team's case, that is strong red-team evidence — cite the lesson title in caseAgainstAdditions.

---

## GREEN TEAM PICK (under review)
- Matchup: ${greenPick.matchup}
- Pick: ${greenPick.pickDescription}
- Final Confidence: ${greenPick.finalConfidence}%
- SP Matchup Rating: ${greenPick.spMatchupRating}

**Green Team's Case FOR:**
${greenPick.caseFor}

**Green Team's Case AGAINST (do NOT repeat these — find what they missed):**
${greenPick.caseAgainst}

**Green Team's Verdict:**
${greenPick.verdict}

**Green Team's Pillar Directions:**
${Object.entries(greenPick.pillars).map(([key, v]) => `- ${key}: ${v.direction} — ${v.notes}`).join("\n")}

**Green Team's Adjustments Applied:**
${greenPick.adjustments.map(a => `- ${a.reason} (${a.delta >= 0 ? "+" : ""}${a.delta})`).join("\n") || "(none)"}

---

## RAW GAME DATA
${JSON.stringify({ date: p.date, game }, null, 1)}

---

## WEB SEARCH RESULTS

### ODDS
${tavilyResults.odds || "No odds data available"}

### LINEUPS
${tavilyResults.lineups || "No lineup data available"}

### INJURIES
${tavilyResults.injuries || "No injury data available"}

### LINE MOVEMENT
${tavilyResults.lineMovement || "No line movement data available"}

---

Find what the green team missed. Cite specific stats. Return ONLY the JSON object — no markdown, no commentary.`;
}

export const mlbRedAnalystTask = task({
  id: "mlb-red-analyst",
  maxDuration: 180,
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 30000, factor: 2 },

  run: async (payload: RedAnalystPayload): Promise<RedAnalystResult> => {
    const { greenPick } = payload;
    console.log(`[red-analyst] Reviewing ${greenPick.matchup} — ${greenPick.pickDescription} @ ${greenPick.finalConfidence}%`);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = buildRedTeamPrompt(payload);

    let responseText = "";
    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
      messages: [{ role: "user", content: prompt }],
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        responseText += chunk.delta.text;
      }
    }

    const review = parseRedTeamJSON(responseText);
    console.log(`[red-analyst] ${greenPick.matchup}: adj=${review.confidenceAdjustment} veto=${review.vetoRecommended} evidence=${review.evidenceQuality}`);
    return { review };
  },
});
