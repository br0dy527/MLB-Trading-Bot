// Child task: Fetches all game data from MLB Stats API, Open-Meteo, and Tavily (4 searches)
// Returns a compiled payload for mlb-analyze to process

import { task } from "@trigger.dev/sdk/v3";
import {
  fetchSchedule, fetchPitcherStats, fetchStandings, fetchWeather,
  type ScheduledGame, type PitcherStats, type TeamRecord, type WeatherData,
} from "../lib/mlb-api.js";
import { fetchBatchedWebData, type TavilyResults } from "../lib/tavily.js";

export interface CompiledGame {
  gameId: number;
  matchup: string;
  venue: string;
  parkFactor: number;
  isDome: boolean;
  gameTimeUtc: string;
  seriesGameNumber: number;
  homeTeam: TeamRecord | null;
  awayTeam: TeamRecord | null;
  homePitcher: PitcherStats | null;
  awayPitcher: PitcherStats | null;
  weather: WeatherData | null;
}

export interface FetchDataPayload {
  date: string; // YYYY-MM-DD
}

export interface FetchDataResult {
  date: string;
  games: CompiledGame[];
  tavilyResults: TavilyResults;
  dataNotes: string[];
}

export const mlbFetchDataTask = task({
  id: "mlb-fetch-data",
  maxDuration: 600, // 10 minutes
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 30000, factor: 2 },

  run: async (payload: FetchDataPayload): Promise<FetchDataResult> => {
    const { date } = payload;
    const season = parseInt(date.split("-")[0] ?? "2026");
    const dataNotes: string[] = [];

    console.log(`[fetch-data] Fetching MLB data for ${date} (season ${season})`);

    // 1. Schedule
    const schedule: ScheduledGame[] = await fetchSchedule(date);
    console.log(`[fetch-data] ${schedule.length} games scheduled`);

    if (schedule.length === 0) {
      return { date, games: [], tavilyResults: { odds: "", lineups: "", injuries: "", lineMovement: "" }, dataNotes: ["No games scheduled."] };
    }

    // 2. Standings (one call covers all teams)
    let standingsMap = new Map<number, TeamRecord>();
    try {
      standingsMap = await fetchStandings(season);
      console.log(`[fetch-data] Standings loaded for ${standingsMap.size} teams`);
    } catch (err) {
      dataNotes.push(`Standings unavailable: ${String(err)}`);
    }

    // 3. Pitcher stats (parallel, one pair per game)
    const pitcherIds = new Set<number>();
    for (const g of schedule) {
      if (g.homePitcherId) pitcherIds.add(g.homePitcherId);
      if (g.awayPitcherId) pitcherIds.add(g.awayPitcherId);
    }

    const pitcherMap = new Map<number, PitcherStats>();
    const pitcherFetches = Array.from(pitcherIds).map(async (id) => {
      try {
        const stats = await fetchPitcherStats(id, season);
        pitcherMap.set(id, stats);
      } catch (err) {
        dataNotes.push(`Pitcher stats unavailable for ID ${id}: ${String(err)}`);
      }
    });
    await Promise.all(pitcherFetches);
    console.log(`[fetch-data] Pitcher stats loaded for ${pitcherMap.size}/${pitcherIds.size} pitchers`);

    // 4. Weather (parallel per venue, skip domes)
    const weatherMap = new Map<number, WeatherData | null>();
    const weatherFetches = schedule.map(async (g) => {
      if (g.isDome || !g.lat || !g.lon) {
        weatherMap.set(g.gameId, null);
        return;
      }
      try {
        const w = await fetchWeather(g.lat, g.lon, date, g.gameTimeUtc);
        weatherMap.set(g.gameId, w);
      } catch {
        weatherMap.set(g.gameId, null);
      }
    });
    await Promise.all(weatherFetches);

    // 5. Tavily batched searches
    let tavilyResults: TavilyResults = { odds: "", lineups: "", injuries: "", lineMovement: "" };
    try {
      tavilyResults = await fetchBatchedWebData(date);
    } catch (err) {
      dataNotes.push(`Tavily search failed: ${String(err)} — odds/lineup/injury data unavailable`);
    }

    // 6. Compile games
    const games: CompiledGame[] = schedule.map((g) => ({
      gameId: g.gameId,
      matchup: `${g.awayTeamAbbr} @ ${g.homeTeamAbbr}`,
      venue: g.venue,
      parkFactor: g.parkFactor,
      isDome: g.isDome,
      gameTimeUtc: g.gameTimeUtc,
      seriesGameNumber: g.seriesGameNumber,
      homeTeam: standingsMap.get(g.homeTeamId) ?? null,
      awayTeam: standingsMap.get(g.awayTeamId) ?? null,
      homePitcher: g.homePitcherId ? (pitcherMap.get(g.homePitcherId) ?? null) : null,
      awayPitcher: g.awayPitcherId ? (pitcherMap.get(g.awayPitcherId) ?? null) : null,
      weather: weatherMap.get(g.gameId) ?? null,
    }));

    console.log(`[fetch-data] Compiled ${games.length} games. Data notes: ${dataNotes.length}`);
    return { date, games, tavilyResults, dataNotes };
  },
});
