// Tavily Search — 4 batched queries per daily run (~4 credits/day, ~120/month on free plan)

export interface TavilyResults {
  odds: string;
  lineups: string;
  injuries: string;
  lineMovement: string;
}

interface TavilyResponse {
  results: Array<{ title: string; url: string; content: string }>;
  answer?: string;
}

async function tavilySearch(query: string): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      max_results: 5,
      include_answer: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tavily search error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json() as TavilyResponse;

  // Return the AI-generated answer + top result snippets for maximum context
  const parts: string[] = [];
  if (data.answer) parts.push(`Summary: ${data.answer}`);
  for (const r of data.results.slice(0, 3)) {
    parts.push(`[${r.title}]\n${r.content}`);
  }
  return parts.join("\n\n---\n\n");
}

export async function fetchBatchedWebData(date: string): Promise<TavilyResults> {
  // Format date as "Month DD YYYY" for search readability
  const dateObj = new Date(date + "T12:00:00Z");
  const dateStr = dateObj.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  console.log(`Running 4 Tavily searches for ${date}...`);

  // Run searches sequentially to avoid rate limit issues
  const odds = await tavilySearch(
    `MLB moneyline run line over under odds all games today ${dateStr} betting lines`
  );
  console.log("  ✓ Odds search complete");

  const lineups = await tavilySearch(
    `MLB confirmed starting lineups all games today ${dateStr} batting order`
  );
  console.log("  ✓ Lineups search complete");

  const injuries = await tavilySearch(
    `MLB injury report all teams today ${dateStr} IL scratches late changes`
  );
  console.log("  ✓ Injuries search complete");

  const lineMovement = await tavilySearch(
    `MLB line movement sharp money steam today ${dateStr} reverse line movement`
  );
  console.log("  ✓ Line movement search complete");

  return { odds, lineups, injuries, lineMovement };
}
