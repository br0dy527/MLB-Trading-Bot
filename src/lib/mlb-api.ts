// MLB Stats API — schedule, pitcher stats, standings, final scores, weather

export interface PitcherStats {
  id: number;
  name: string;
  hand: string;
  era: number | null;
  whip: number | null;
  k9: number | null;
  bb9: number | null;
  inningsPitched: number | null;
  recentEra: number | null; // ERA from last 5 starts
  last5Starts: Array<{ date: string; ip: number; er: number }>;
  vsLhbEra: number | null;
  vsRhbEra: number | null;
  vsLhbOps: number | null;
  vsRhbOps: number | null;
}

export interface TeamRecord {
  id: number;
  name: string;
  abbreviation: string;
  wins: number;
  losses: number;
  winPct: number;
  homeWins: number;
  homeLosses: number;
  awayWins: number;
  awayLosses: number;
  last10: string;
  streak: string;
  gamesBack: number;
  division: string;
}

export interface WeatherData {
  tempF: number;
  windSpeedMph: number;
  windDirectionDeg: number;
  humidity: number;
  windEffect: "strong_wind_blowing_out" | "strong_wind_blowing_in" | "light_wind_neutral" | "dome_irrelevant";
}

export interface ScheduledGame {
  gameId: number;
  date: string;
  gameTimeUtc: string;
  seriesGameNumber: number;
  venue: string;
  parkFactor: number;
  isDome: boolean;
  lat: number | null;
  lon: number | null;
  homeTeamId: number;
  homeTeamName: string;
  homeTeamAbbr: string;
  awayTeamId: number;
  awayTeamName: string;
  awayTeamAbbr: string;
  homePitcherId: number | null;
  homePitcherName: string | null;
  awayPitcherId: number | null;
  awayPitcherName: string | null;
}

export interface FinalScore {
  gameId: number;
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number;
  awayScore: number;
}

export interface TeamOffenseStats {
  teamId: number;
  gamesPlayed: number;
  runsPerGame: number;     // runs / gamesPlayed
  obp: number | null;
  ops: number | null;
  avg: number | null;
  kPct: number | null;     // strikeouts / plateAppearances
  bbPct: number | null;    // walks / plateAppearances
}

export interface TeamPitchingStats {
  teamId: number;
  era: number | null;
  whip: number | null;
  k9: number | null;
  bullpenEra: number | null; // derived from full-staff ERA (best proxy from this API)
}

/** Fetches season batting stats for all MLB teams in a single API call. */
export async function fetchAllTeamOffenseStats(season: number): Promise<Map<number, TeamOffenseStats>> {
  const url = `https://statsapi.mlb.com/api/v1/teams/stats?stats=season&group=hitting&season=${season}&gameType=R&sportId=1`;
  const res = await fetch(url);
  const map = new Map<number, TeamOffenseStats>();
  if (!res.ok) return map;

  const data = await res.json() as any;
  for (const split of (data.stats?.[0]?.splits ?? [])) {
    const teamId: number = split.team?.id;
    const s = split.stat;
    if (!teamId || !s) continue;

    const gamesPlayed = s.gamesPlayed ?? 1;
    const runs = s.runs ?? 0;
    const so = s.strikeOuts ?? 0;
    const pa = s.plateAppearances ?? 1;
    const bb = s.baseOnBalls ?? 0;

    map.set(teamId, {
      teamId,
      gamesPlayed,
      runsPerGame: gamesPlayed > 0 ? Math.round((runs / gamesPlayed) * 100) / 100 : 0,
      obp: s.obp != null ? parseFloat(s.obp) : null,
      ops: s.ops != null ? parseFloat(s.ops) : null,
      avg: s.avg != null ? parseFloat(s.avg) : null,
      kPct: pa > 0 ? Math.round((so / pa) * 1000) / 10 : null,
      bbPct: pa > 0 ? Math.round((bb / pa) * 1000) / 10 : null,
    });
  }
  return map;
}

/** Fetches season pitching stats for all MLB teams in a single API call. */
export async function fetchAllTeamPitchingStats(season: number): Promise<Map<number, TeamPitchingStats>> {
  const url = `https://statsapi.mlb.com/api/v1/teams/stats?stats=season&group=pitching&season=${season}&gameType=R&sportId=1`;
  const res = await fetch(url);
  const map = new Map<number, TeamPitchingStats>();
  if (!res.ok) return map;

  const data = await res.json() as any;
  for (const split of (data.stats?.[0]?.splits ?? [])) {
    const teamId: number = split.team?.id;
    const s = split.stat;
    if (!teamId || !s) continue;

    map.set(teamId, {
      teamId,
      era: s.era != null ? parseFloat(s.era) : null,
      whip: s.whip != null ? parseFloat(s.whip) : null,
      k9: s.strikeoutsPer9Inn != null ? parseFloat(s.strikeoutsPer9Inn) : null,
      bullpenEra: s.era != null ? parseFloat(s.era) : null, // team ERA is best available proxy
    });
  }
  return map;
}

// Venue info lookup: park factor, dome status, coordinates for weather
const VENUE_INFO: Record<string, { parkFactor: number; isDome: boolean; lat: number | null; lon: number | null }> = {
  "Fenway Park":                   { parkFactor: 103, isDome: false, lat: 42.3467,  lon: -71.0972  },
  "Yankee Stadium":                { parkFactor: 106, isDome: false, lat: 40.8296,  lon: -73.9262  },
  "Wrigley Field":                 { parkFactor: 101, isDome: false, lat: 41.9484,  lon: -87.6553  },
  "Coors Field":                   { parkFactor: 119, isDome: false, lat: 39.7559,  lon: -104.9942 },
  "Oracle Park":                   { parkFactor: 93,  isDome: false, lat: 37.7786,  lon: -122.3893 },
  "Dodger Stadium":                { parkFactor: 95,  isDome: false, lat: 34.0739,  lon: -118.2400 },
  "Target Field":                  { parkFactor: 99,  isDome: false, lat: 44.9817,  lon: -93.2784  },
  "Citizens Bank Park":            { parkFactor: 107, isDome: false, lat: 39.9057,  lon: -75.1665  },
  "Truist Park":                   { parkFactor: 105, isDome: false, lat: 33.8908,  lon: -84.4678  },
  "Minute Maid Park":              { parkFactor: 100, isDome: true,  lat: 29.7573,  lon: -95.3555  },
  "Petco Park":                    { parkFactor: 93,  isDome: false, lat: 32.7076,  lon: -117.1570 },
  "Busch Stadium":                 { parkFactor: 97,  isDome: false, lat: 38.6226,  lon: -90.1928  },
  "Chase Field":                   { parkFactor: 100, isDome: true,  lat: 33.4453,  lon: -112.0667 },
  "Camden Yards":                  { parkFactor: 100, isDome: false, lat: 39.2839,  lon: -76.6215  },
  "Oriole Park at Camden Yards":   { parkFactor: 100, isDome: false, lat: 39.2839,  lon: -76.6215  },
  "Globe Life Field":              { parkFactor: 104, isDome: true,  lat: 32.7512,  lon: -97.0832  },
  "Kauffman Stadium":              { parkFactor: 98,  isDome: false, lat: 39.0517,  lon: -94.4803  },
  "Progressive Field":             { parkFactor: 95,  isDome: false, lat: 41.4962,  lon: -81.6852  },
  "Angel Stadium":                 { parkFactor: 102, isDome: false, lat: 33.8003,  lon: -117.8827 },
  "T-Mobile Park":                 { parkFactor: 94,  isDome: true,  lat: 47.5914,  lon: -122.3325 },
  "PNC Park":                      { parkFactor: 96,  isDome: false, lat: 40.4468,  lon: -80.0058  },
  "Tropicana Field":               { parkFactor: 94,  isDome: true,  lat: 27.7683,  lon: -82.6534  },
  "Rogers Centre":                 { parkFactor: 103, isDome: true,  lat: 43.6415,  lon: -79.3892  },
  "Great American Ball Park":      { parkFactor: 100, isDome: false, lat: 39.0979,  lon: -84.5082  },
  "Comerica Park":                 { parkFactor: 96,  isDome: false, lat: 42.3390,  lon: -83.0485  },
  "Citi Field":                    { parkFactor: 97,  isDome: false, lat: 40.7571,  lon: -73.8458  },
  "Nationals Park":                { parkFactor: 99,  isDome: false, lat: 38.8730,  lon: -77.0074  },
  "loanDepot park":                { parkFactor: 95,  isDome: false, lat: 25.7781,  lon: -80.2197  },
  "LoanDepot Park":                { parkFactor: 95,  isDome: false, lat: 25.7781,  lon: -80.2197  },
  "American Family Field":         { parkFactor: 100, isDome: false, lat: 43.0283,  lon: -87.9712  },
  "Sutter Health Park":            { parkFactor: 100, isDome: false, lat: 38.5815,  lon: -121.5071 }, // Oakland A's temp
};

function getVenueInfo(venueName: string) {
  if (VENUE_INFO[venueName]) return VENUE_INFO[venueName];
  for (const [key, val] of Object.entries(VENUE_INFO)) {
    if (venueName.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(venueName.toLowerCase())) {
      return val;
    }
  }
  return { parkFactor: 100, isDome: false, lat: null, lon: null };
}

export async function fetchSchedule(date: string): Promise<ScheduledGame[]> {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=team,venue,probablePitcher`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB schedule fetch failed: ${res.status}`);

  const data = await res.json() as any;
  const games: ScheduledGame[] = [];

  for (const dateEntry of (data.dates ?? [])) {
    for (const game of (dateEntry.games ?? [])) {
      if (game.status?.abstractGameState === "Final") continue;
      if (game.gameType !== "R") continue;

      const venueName: string = game.venue?.name ?? "Unknown";
      const venueInfo = getVenueInfo(venueName);

      games.push({
        gameId: game.gamePk,
        date,
        gameTimeUtc: game.gameDate ?? "",
        seriesGameNumber: game.seriesGameNumber ?? 1,
        venue: venueName,
        ...venueInfo,
        homeTeamId: game.teams?.home?.team?.id ?? 0,
        homeTeamName: game.teams?.home?.team?.name ?? "",
        homeTeamAbbr: game.teams?.home?.team?.abbreviation ?? "",
        awayTeamId: game.teams?.away?.team?.id ?? 0,
        awayTeamName: game.teams?.away?.team?.name ?? "",
        awayTeamAbbr: game.teams?.away?.team?.abbreviation ?? "",
        homePitcherId: game.teams?.home?.probablePitcher?.id ?? null,
        homePitcherName: game.teams?.home?.probablePitcher?.fullName ?? null,
        awayPitcherId: game.teams?.away?.probablePitcher?.id ?? null,
        awayPitcherName: game.teams?.away?.probablePitcher?.fullName ?? null,
      });
    }
  }

  return games;
}

export async function fetchPitcherStats(pitcherId: number, season: number): Promise<PitcherStats> {
  const baseUrl = `https://statsapi.mlb.com/api/v1/people/${pitcherId}`;

  const [personRes, seasonRes, gameLogRes, splitsRes] = await Promise.all([
    fetch(baseUrl),
    fetch(`${baseUrl}/stats?stats=season&group=pitching&season=${season}&gameType=R`),
    fetch(`${baseUrl}/stats?stats=gameLog&group=pitching&season=${season}&gameType=R`),
    fetch(`${baseUrl}/stats?stats=statSplits&group=pitching&season=${season}&gameType=R&sitCodes=vl,vr`),
  ]);

  const personData = await personRes.json() as any;
  const hand: string = personData.people?.[0]?.pitchHand?.code ?? "R";
  const name: string = personData.people?.[0]?.fullName ?? `Pitcher #${pitcherId}`;

  let era: number | null = null, whip: number | null = null;
  let k9: number | null = null, bb9: number | null = null;
  let inningsPitched: number | null = null;

  if (seasonRes.ok) {
    const sd = await seasonRes.json() as any;
    const stat = sd.stats?.[0]?.splits?.[0]?.stat;
    if (stat) {
      era = parseFloat(stat.era) || null;
      whip = parseFloat(stat.whip) || null;
      k9 = parseFloat(stat.strikeoutsPer9Inn) || null;
      bb9 = parseFloat(stat.walksPer9Inn) || null;
      inningsPitched = parseFloat(stat.inningsPitched) || null;
    }
  }

  const last5Starts: Array<{ date: string; ip: number; er: number }> = [];
  let recentEra: number | null = null;

  if (gameLogRes.ok) {
    const gld = await gameLogRes.json() as any;
    const splits = (gld.stats?.[0]?.splits ?? [])
      .filter((s: any) => parseFloat(s.stat?.inningsPitched ?? "0") >= 1.0)
      .slice(-5);

    let totalEr = 0, totalIp = 0;
    for (const s of splits) {
      const ip = parseFloat(s.stat.inningsPitched) || 0;
      const er = parseInt(s.stat.earnedRuns ?? "0") || 0;
      last5Starts.push({ date: s.date ?? "", ip, er });
      totalEr += er;
      totalIp += ip;
    }
    if (totalIp > 0) recentEra = Math.round((totalEr / totalIp) * 9 * 100) / 100;
  }

  let vsLhbEra: number | null = null, vsRhbEra: number | null = null;
  let vsLhbOps: number | null = null, vsRhbOps: number | null = null;

  if (splitsRes.ok) {
    const sd = await splitsRes.json() as any;
    for (const split of (sd.stats?.[0]?.splits ?? [])) {
      const code = split.split?.code;
      const stat = split.stat;
      if (code === "vl") { vsLhbEra = parseFloat(stat?.era) || null; vsLhbOps = parseFloat(stat?.ops) || null; }
      if (code === "vr") { vsRhbEra = parseFloat(stat?.era) || null; vsRhbOps = parseFloat(stat?.ops) || null; }
    }
  }

  return { id: pitcherId, name, hand, era, whip, k9, bb9, inningsPitched, recentEra, last5Starts, vsLhbEra, vsRhbEra, vsLhbOps, vsRhbOps };
}

export async function fetchStandings(season: number): Promise<Map<number, TeamRecord>> {
  const url = `https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason&hydrate=team,record`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB standings fetch failed: ${res.status}`);

  const data = await res.json() as any;
  const map = new Map<number, TeamRecord>();

  for (const record of (data.records ?? [])) {
    const division: string = record.division?.name ?? "";

    for (const tr of (record.teamRecords ?? [])) {
      const teamId: number = tr.team?.id;
      if (!teamId) continue;

      let last10 = "N/A";
      let homeWins = 0, homeLosses = 0, awayWins = 0, awayLosses = 0;

      for (const split of (tr.records?.splitRecords ?? [])) {
        if (split.type === "lastTen") last10 = `${split.wins}-${split.losses}`;
        if (split.type === "home") { homeWins = split.wins; homeLosses = split.losses; }
        if (split.type === "away") { awayWins = split.wins; awayLosses = split.losses; }
      }

      const streakType = tr.streak?.streakType === "wins" ? "W" : "L";
      const streakNum = tr.streak?.streakNumber ?? 0;
      const streak = streakNum > 0 ? `${streakType}${streakNum}` : "N/A";
      const wins = tr.wins ?? 0;
      const losses = tr.losses ?? 0;

      map.set(teamId, {
        id: teamId,
        name: tr.team?.name ?? "",
        abbreviation: tr.team?.abbreviation ?? "",
        wins,
        losses,
        winPct: (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 1000) / 1000 : 0,
        homeWins,
        homeLosses,
        awayWins,
        awayLosses,
        last10,
        streak,
        gamesBack: parseFloat(tr.gamesBack ?? "0") || 0,
        division,
      });
    }
  }

  return map;
}

export async function fetchWeather(lat: number, lon: number, date: string, gameTimeUtc: string): Promise<WeatherData | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,windspeed_10m,winddirection_10m,relativehumidity_2m&temperature_unit=fahrenheit&windspeed_unit=mph&start_date=${date}&end_date=${date}&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json() as any;
    const gameHour = new Date(gameTimeUtc).getHours();
    const times: string[] = data.hourly?.time ?? [];
    let idx = times.findIndex(t => new Date(t).getHours() === gameHour);
    if (idx === -1) idx = 13;

    const tempF: number = data.hourly?.temperature_2m?.[idx] ?? 72;
    const windSpeedMph: number = data.hourly?.windspeed_10m?.[idx] ?? 0;
    const windDirectionDeg: number = data.hourly?.winddirection_10m?.[idx] ?? 0;
    const humidity: number = data.hourly?.relativehumidity_2m?.[idx] ?? 50;

    // Wind blowing out toward CF (~NE from home plate) = offense; blowing in from CF = pitching
    let windEffect: WeatherData["windEffect"] = "light_wind_neutral";
    if (windSpeedMph >= 15) {
      const norm = windDirectionDeg % 360;
      if (norm >= 315 || norm <= 45) windEffect = "strong_wind_blowing_out";
      else if (norm >= 135 && norm <= 225) windEffect = "strong_wind_blowing_in";
    }

    return { tempF, windSpeedMph, windDirectionDeg, humidity, windEffect };
  } catch {
    return null;
  }
}

export async function fetchFinalScores(date: string): Promise<FinalScore[]> {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,team&gameType=R`;
  const res = await fetch(url);
  if (!res.ok) return [];

  const data = await res.json() as any;
  const scores: FinalScore[] = [];

  for (const dateEntry of (data.dates ?? [])) {
    for (const game of (dateEntry.games ?? [])) {
      if (game.status?.abstractGameState !== "Final") continue;
      const homeScore = game.linescore?.teams?.home?.runs ?? game.teams?.home?.score;
      const awayScore = game.linescore?.teams?.away?.runs ?? game.teams?.away?.score;
      if (homeScore !== undefined && awayScore !== undefined) {
        scores.push({
          gameId: game.gamePk,
          homeTeamId: game.teams?.home?.team?.id,
          awayTeamId: game.teams?.away?.team?.id,
          homeScore: Number(homeScore),
          awayScore: Number(awayScore),
        });
      }
    }
  }

  return scores;
}
