// Child task: Fetches all game data from MLB Stats API, Open-Meteo, and Tavily (4 searches)
// Returns a compiled payload for mlb-analyze to process

import { task } from "@trigger.dev/sdk/v3";
import {
  fetchSchedule, fetchPitcherStats, fetchStandings, fetchWeather,
  fetchAllTeamOffenseStats, fetchAllTeamPitchingStats,
  type ScheduledGame, type PitcherStats, type TeamRecord, type WeatherData,
  type TeamOffenseStats, type TeamPitchingStats,
} from "../lib/mlb-api.js";
import { fetchBatchedWebData, type TavilyResults } from "../lib/tavily.js";

export interface TotalsContext {
  homeRpg: number | null;
  awayRpg: number | null;
  rawExpectedTotal: number | null;
  spAdjustment: number;
  parkAdjustment: number;
  weatherAdjustment: number;
  expectedTotal: number | null;
  lean: "compare_to_posted_line";
  offenseContext: {
    homeObp: number | null;
    awayObp: number | null;
    homeOps: number | null;
    awayOps: number | null;
    homeKPct: number | null;
    awayKPct: number | null;
    homeBullpenEra: number | null;
    awayBullpenEra: number | null;
  };
  notes: string[];
}

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
  homeOffense: TeamOffenseStats | null;
  awayOffense: TeamOffenseStats | null;
  homePitching: TeamPitchingStats | null;
  awayPitching: TeamPitchingStats | null;
  homePitcher: PitcherStats | null;
  awayPitcher: PitcherStats | null;
  weather: WeatherData | null;
  totalsContext: TotalsContext | null;
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

    // 4. Team offense + pitching stats (2 bulk calls for all teams)
    let teamOffenseMap = new Map<number, TeamOffenseStats>();
    let teamPitchingMap = new Map<number, TeamPitchingStats>();
    try {
      [teamOffenseMap, teamPitchingMap] = await Promise.all([
        fetchAllTeamOffenseStats(season),
        fetchAllTeamPitchingStats(season),
      ]);
      console.log(`[fetch-data] Team stats loaded: ${teamOffenseMap.size} offense, ${teamPitchingMap.size} pitching`);
    } catch (err) {
      dataNotes.push(`Team stats unavailable: ${String(err)}`);
    }

    // 5. Weather (parallel per venue, skip domes)
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

    // 6. Tavily batched searches
    let tavilyResults: TavilyResults = { odds: "", lineups: "", injuries: "", lineMovement: "" };
    try {
      tavilyResults = await fetchBatchedWebData(date);
    } catch (err) {
      dataNotes.push(`Tavily search failed: ${String(err)} — odds/lineup/injury data unavailable`);
    }

    // 7. Compile games
    const games: CompiledGame[] = schedule.map((g) => {
      const homeOffense = teamOffenseMap.get(g.homeTeamId) ?? null;
      const awayOffense = teamOffenseMap.get(g.awayTeamId) ?? null;
      const homePitching = teamPitchingMap.get(g.homeTeamId) ?? null;
      const awayPitching = teamPitchingMap.get(g.awayTeamId) ?? null;
      const homePitcher = g.homePitcherId ? (pitcherMap.get(g.homePitcherId) ?? null) : null;
      const awayPitcher = g.awayPitcherId ? (pitcherMap.get(g.awayPitcherId) ?? null) : null;
      const weather = weatherMap.get(g.gameId) ?? null;

      return {
        gameId: g.gameId,
        matchup: `${g.awayTeamAbbr} @ ${g.homeTeamAbbr}`,
        venue: g.venue,
        parkFactor: g.parkFactor,
        isDome: g.isDome,
        gameTimeUtc: g.gameTimeUtc,
        seriesGameNumber: g.seriesGameNumber,
        homeTeam: standingsMap.get(g.homeTeamId) ?? null,
        awayTeam: standingsMap.get(g.awayTeamId) ?? null,
        homeOffense,
        awayOffense,
        homePitching,
        awayPitching,
        homePitcher,
        awayPitcher,
        weather,
        totalsContext: computeTotalsContext({
          homeOffense, awayOffense, homePitching, awayPitching,
          homePitcher, awayPitcher, parkFactor: g.parkFactor,
          isDome: g.isDome, weather,
          homeAbbr: g.homeTeamAbbr, awayAbbr: g.awayTeamAbbr,
        }),
      };
    });

    console.log(`[fetch-data] Compiled ${games.length} games. Data notes: ${dataNotes.length}`);
    return { date, games, tavilyResults, dataNotes };
  },
});

// ─── Pre-compute expected run total for a game ───────────────────────────────

function computeTotalsContext(args: {
  homeOffense: TeamOffenseStats | null;
  awayOffense: TeamOffenseStats | null;
  homePitching: TeamPitchingStats | null;
  awayPitching: TeamPitchingStats | null;
  homePitcher: PitcherStats | null;
  awayPitcher: PitcherStats | null;
  parkFactor: number;
  isDome: boolean;
  weather: WeatherData | null;
  homeAbbr: string;
  awayAbbr: string;
}): TotalsContext | null {
  const { homeOffense, awayOffense, homePitcher, awayPitcher, parkFactor, isDome, weather, homeAbbr, awayAbbr } = args;

  if (!homeOffense || !awayOffense) return null;

  const notes: string[] = [];

  // Step 1: Offensive baseline
  const homeRpg = homeOffense.runsPerGame;
  const awayRpg = awayOffense.runsPerGame;
  const rawTotal = homeRpg + awayRpg;
  notes.push(`Offensive baseline: ${homeAbbr} ${homeRpg} R/G + ${awayAbbr} ${awayRpg} R/G = ${Math.round(rawTotal * 100) / 100} raw`);

  // Step 2: SP ERA/K9 suppression
  let spAdj = 0;
  for (const [sp, side] of [[homePitcher, homeAbbr], [awayPitcher, awayAbbr]] as const) {
    if (!sp) continue;
    const spNotes: string[] = [];
    if (sp.era !== null && sp.era < 3.50) { spAdj -= 0.4; spNotes.push(`ERA ${sp.era} (<3.50, -0.4)`); }
    if (sp.k9 !== null && sp.k9 > 9.5)   { spAdj -= 0.3; spNotes.push(`K/9 ${sp.k9} (>9.5, -0.3)`); }
    if (spNotes.length) notes.push(`${sp.name ?? side + " SP"}: ${spNotes.join(", ")}`);
  }
  spAdj = Math.round(spAdj * 100) / 100;

  // Step 3: Park factor
  let parkAdj = 0;
  if (parkFactor >= 115)      { parkAdj = 1.75;  notes.push(`Park ${parkFactor} (extreme hitter, +1.75)`); }
  else if (parkFactor >= 105) { parkAdj = 0.5;   notes.push(`Park ${parkFactor} (hitter-friendly, +0.5)`); }
  else if (parkFactor <= 94)  { parkAdj = -0.75; notes.push(`Park ${parkFactor} (strong pitcher-friendly, -0.75)`); }
  else if (parkFactor <= 97)  { parkAdj = -0.5;  notes.push(`Park ${parkFactor} (pitcher-friendly, -0.5)`); }

  // Step 4: Weather
  let weatherAdj = 0;
  if (isDome) {
    notes.push("Dome — weather neutral");
  } else if (weather) {
    if (weather.windEffect === "strong_wind_blowing_out") { weatherAdj += 0.75; notes.push("Wind blowing out (+0.75)"); }
    else if (weather.windEffect === "strong_wind_blowing_in") { weatherAdj -= 0.75; notes.push("Wind blowing in (-0.75)"); }
    if (weather.tempF < 50) { weatherAdj -= 0.5; notes.push(`Cold (${weather.tempF}°F, -0.5)`); }
    else if (weather.tempF > 80) { weatherAdj += 0.25; notes.push(`Hot (${weather.tempF}°F, +0.25)`); }
  }
  weatherAdj = Math.round(weatherAdj * 100) / 100;

  const expectedTotal = Math.round((rawTotal + spAdj + parkAdj + weatherAdj) * 100) / 100;

  return {
    homeRpg,
    awayRpg,
    rawExpectedTotal: Math.round(rawTotal * 100) / 100,
    spAdjustment: spAdj,
    parkAdjustment: parkAdj,
    weatherAdjustment: weatherAdj,
    expectedTotal,
    lean: "compare_to_posted_line",
    offenseContext: {
      homeObp: homeOffense.obp,
      awayObp: awayOffense.obp,
      homeOps: homeOffense.ops,
      awayOps: awayOffense.ops,
      homeKPct: homeOffense.kPct,
      awayKPct: awayOffense.kPct,
      homeBullpenEra: args.homePitching?.bullpenEra ?? null,
      awayBullpenEra: args.awayPitching?.bullpenEra ?? null,
    },
    notes,
  };
}
