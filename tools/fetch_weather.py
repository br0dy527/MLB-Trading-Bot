"""
fetch_weather.py
Fetches weather forecast for each MLB park at game time using Open-Meteo API.
Free — no API key required.

Usage:
    python tools/fetch_weather.py "Fenway Park" "2026-04-03T19:10:00"
    python tools/fetch_weather.py "Coors Field" "2026-04-03T20:10:00"

Output: JSON to stdout with weather conditions and betting context.
"""

import sys
import json
import urllib.request
import urllib.error
from datetime import datetime


# ---------------------------------------------------------------------------
# Park coordinates and field orientation
# ---------------------------------------------------------------------------

PARK_DATA = {
    "Angel Stadium": {
        "lat": 33.8003, "lon": -117.8827,
        "is_dome": False,
        "orientation_deg": 225,  # Degrees the batter faces (approx)
        "notes": "Warm, low humidity. Slight hitter's park.",
    },
    "Chase Field": {
        "lat": 33.4453, "lon": -112.0667,
        "is_dome": True,
        "orientation_deg": None,
        "notes": "Retractable roof. Usually closed in extreme heat.",
    },
    "Camden Yards": {
        "lat": 39.2839, "lon": -76.6215,
        "is_dome": False,
        "orientation_deg": 60,
        "notes": "Right field power alley benefits LHB.",
    },
    "Fenway Park": {
        "lat": 42.3467, "lon": -71.0972,
        "is_dome": False,
        "orientation_deg": 95,
        "notes": "Green Monster (LF wall) benefits RHB. Marine air suppresses HR.",
    },
    "Wrigley Field": {
        "lat": 41.9484, "lon": -87.6553,
        "is_dome": False,
        "orientation_deg": 135,
        "notes": "Wind from Lake Michigan is critical. Blowing out = offense. Blowing in = pitchers.",
    },
    "Great American Ball Park": {
        "lat": 39.0979, "lon": -84.5082,
        "is_dome": False,
        "orientation_deg": 310,
        "notes": "Hitter-friendly. River air can affect ball flight.",
    },
    "GABP": {
        "lat": 39.0979, "lon": -84.5082,
        "is_dome": False,
        "orientation_deg": 310,
        "notes": "Hitter-friendly. River air can affect ball flight.",
    },
    "Progressive Field": {
        "lat": 41.4962, "lon": -81.6852,
        "is_dome": False,
        "orientation_deg": 45,
        "notes": "Pitcher-friendly. Lake Erie cold air suppresses offense.",
    },
    "Coors Field": {
        "lat": 39.7559, "lon": -104.9942,
        "is_dome": False,
        "orientation_deg": 315,
        "notes": "HIGH ALTITUDE (5280ft). Dramatically inflates totals. +1.5-2 runs vs sea level.",
    },
    "Comerica Park": {
        "lat": 42.3390, "lon": -83.0485,
        "is_dome": False,
        "orientation_deg": 10,
        "notes": "Large outfield. Pitcher-friendly.",
    },
    "Minute Maid Park": {
        "lat": 29.7573, "lon": -95.3555,
        "is_dome": True,
        "orientation_deg": None,
        "notes": "Retractable roof. Usually closed. Crawford Boxes (LF) very short — favors LHB.",
    },
    "Kauffman Stadium": {
        "lat": 39.0517, "lon": -94.4803,
        "is_dome": False,
        "orientation_deg": 45,
        "notes": "Pitcher-friendly. Large outfield. Low humidity.",
    },
    "Dodger Stadium": {
        "lat": 34.0739, "lon": -118.2400,
        "is_dome": False,
        "orientation_deg": 350,
        "notes": "Marine layer suppresses HR. Pitcher-friendly. Elevation helps slightly.",
    },
    "Nationals Park": {
        "lat": 38.8730, "lon": -77.0074,
        "is_dome": False,
        "orientation_deg": 350,
        "notes": "Hitter-friendly. Humid summers. Mid-range park.",
    },
    "Citi Field": {
        "lat": 40.7571, "lon": -73.8458,
        "is_dome": False,
        "orientation_deg": 45,
        "notes": "Pitcher-friendly since moved fences in. NYC weather variable.",
    },
    "Oakland Coliseum": {
        "lat": 37.7516, "lon": -122.2005,
        "is_dome": False,
        "orientation_deg": 320,
        "notes": "Pitcher-friendly. Notorious foul territory. Bay Area marine layer.",
    },
    "Sutter Health Park": {
        "lat": 38.5802, "lon": -121.5047,
        "is_dome": False,
        "orientation_deg": 320,
        "notes": "Athletics AAA park (temporary). Minor league dimensions. Check current capacity.",
    },
    "PNC Park": {
        "lat": 40.4468, "lon": -80.0058,
        "is_dome": False,
        "orientation_deg": 330,
        "notes": "Pitcher-friendly. Allegheny River air. Beautiful park.",
    },
    "Petco Park": {
        "lat": 32.7076, "lon": -117.1570,
        "is_dome": False,
        "orientation_deg": 315,
        "notes": "Very pitcher-friendly. Marine layer from Pacific. Deep center field.",
    },
    "T-Mobile Park": {
        "lat": 47.5914, "lon": -122.3325,
        "is_dome": True,
        "orientation_deg": None,
        "notes": "Retractable roof. Usually closed. Pitcher-friendly when open.",
    },
    "Oracle Park": {
        "lat": 37.7786, "lon": -122.3893,
        "is_dome": False,
        "orientation_deg": 305,
        "notes": "Strong marine layer off San Francisco Bay. Very pitcher-friendly. McCovey Cove (RF) very deep.",
    },
    "Busch Stadium": {
        "lat": 38.6226, "lon": -90.1928,
        "is_dome": False,
        "orientation_deg": 15,
        "notes": "Pitcher-friendly. Mississippi River humidity. Hot summers.",
    },
    "Tropicana Field": {
        "lat": 27.7683, "lon": -82.6534,
        "is_dome": True,
        "orientation_deg": None,
        "notes": "Permanent dome. Weather irrelevant. Artificial turf. Pitcher-friendly.",
    },
    "Globe Life Field": {
        "lat": 32.7512, "lon": -97.0832,
        "is_dome": True,
        "orientation_deg": None,
        "notes": "Retractable roof. Usually closed. New park — hitter-friendly dimensions.",
    },
    "Rogers Centre": {
        "lat": 43.6415, "lon": -79.3892,
        "is_dome": True,
        "orientation_deg": None,
        "notes": "Permanent dome. Artificial turf. Hitter-friendly.",
    },
    "Target Field": {
        "lat": 44.9817, "lon": -93.2784,
        "is_dome": False,
        "orientation_deg": 340,
        "notes": "Cold early season. Wind variable. Pitcher-friendly overall.",
    },
    "Citizens Bank Park": {
        "lat": 39.9057, "lon": -75.1665,
        "is_dome": False,
        "orientation_deg": 350,
        "notes": "Hitter-friendly. Short RF porch. Humid summers.",
    },
    "Truist Park": {
        "lat": 33.8908, "lon": -84.4678,
        "is_dome": False,
        "orientation_deg": 5,
        "notes": "Hitter-friendly. Hot humid Atlanta summers. Cozy dimensions.",
    },
    "Guaranteed Rate Field": {
        "lat": 41.8299, "lon": -87.6338,
        "is_dome": False,
        "orientation_deg": 340,
        "notes": "Pitcher-friendly. Lake Michigan effect. Short RF.",
    },
    "loanDepot park": {
        "lat": 25.7781, "lon": -80.2197,
        "is_dome": True,
        "orientation_deg": None,
        "notes": "Retractable roof. Almost always closed. Pitcher-friendly.",
    },
    "Yankee Stadium": {
        "lat": 40.8296, "lon": -73.9262,
        "is_dome": False,
        "orientation_deg": 30,
        "notes": "Short RF porch strongly favors LHB. Hitter-friendly.",
    },
    "American Family Field": {
        "lat": 43.0280, "lon": -87.9712,
        "is_dome": True,
        "orientation_deg": None,
        "notes": "Retractable roof. Usually closed early season. Hitter-friendly when open.",
    },
}


def get_wind_effect(wind_direction_deg: int, wind_speed_mph: float, park_name: str) -> str:
    """
    Determines betting-relevant wind effect based on wind direction relative to park orientation.
    Wind blowing OUT toward CF/RF = offense boost.
    Wind blowing IN from CF = pitching boost.
    """
    park = PARK_DATA.get(park_name, {})
    if park.get("is_dome"):
        return "dome_weather_irrelevant"

    orientation = park.get("orientation_deg")
    if orientation is None or wind_direction_deg is None or wind_speed_mph is None:
        return "insufficient_data"

    if wind_speed_mph < 5:
        return "calm_neutral"

    # Relative wind angle: 0 = blowing out to CF (offense), 180 = blowing in (pitching)
    relative = (wind_direction_deg - orientation + 360) % 360

    if wind_speed_mph >= 15:
        if relative < 45 or relative > 315:
            return "strong_wind_blowing_out_offense"
        elif 135 < relative < 225:
            return "strong_wind_blowing_in_pitching"
        else:
            return "strong_crosswind_neutral"
    elif wind_speed_mph >= 8:
        if relative < 45 or relative > 315:
            return "moderate_wind_out_slight_offense"
        elif 135 < relative < 225:
            return "moderate_wind_in_slight_pitching"
        else:
            return "moderate_crosswind_neutral"
    else:
        return "light_wind_neutral"


def fetch_weather(park_name: str, game_time_utc: str) -> dict:
    """Fetch weather forecast from Open-Meteo for given park and time."""
    park = PARK_DATA.get(park_name)

    if not park:
        # Try partial match
        for pname, pdata in PARK_DATA.items():
            if park_name.lower() in pname.lower() or pname.lower() in park_name.lower():
                park = pdata
                park_name = pname
                break

    if not park:
        return {
            "error": f"Park '{park_name}' not found in park database",
            "known_parks": list(PARK_DATA.keys()),
        }

    if park.get("is_dome"):
        return {
            "park": park_name,
            "is_dome": True,
            "weather_relevant": False,
            "wind_effect": "dome_weather_irrelevant",
            "betting_note": "Indoor stadium — weather has no impact on game.",
            "park_notes": park.get("notes", ""),
        }

    lat, lon = park["lat"], park["lon"]

    # Parse game time
    try:
        if "T" in game_time_utc:
            game_dt = datetime.fromisoformat(game_time_utc.replace("Z", "+00:00"))
        else:
            game_dt = datetime.strptime(game_time_utc, "%Y-%m-%d %H:%M:%S")
        date_str = game_dt.strftime("%Y-%m-%d")
        game_hour = game_dt.hour
    except Exception:
        date_str = game_time_utc[:10]
        game_hour = 19  # Default to 7 PM

    url = (
        f"https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat}&longitude={lon}"
        f"&hourly=temperature_2m,windspeed_10m,winddirection_10m,relativehumidity_2m,precipitation_probability"
        f"&temperature_unit=fahrenheit&windspeed_unit=mph"
        f"&start_date={date_str}&end_date={date_str}"
        f"&timezone=auto"
    )

    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        return {"error": f"Weather API fetch failed: {e}"}

    hourly = data.get("hourly", {})
    times = hourly.get("time", [])

    # Find closest hour to game time
    best_idx = 0
    for i, t in enumerate(times):
        try:
            t_hour = int(t.split("T")[1][:2])
            if abs(t_hour - game_hour) < abs(int(times[best_idx].split("T")[1][:2]) - game_hour):
                best_idx = i
        except Exception:
            pass

    def get_hour(key, idx):
        vals = hourly.get(key, [])
        return vals[idx] if idx < len(vals) else None

    temp_f = get_hour("temperature_2m", best_idx)
    wind_mph = get_hour("windspeed_10m", best_idx)
    wind_dir = get_hour("winddirection_10m", best_idx)
    humidity = get_hour("relativehumidity_2m", best_idx)
    precip_pct = get_hour("precipitation_probability", best_idx)

    wind_effect = get_wind_effect(wind_dir, wind_mph or 0, park_name)

    # Temperature effect on ball flight (rough approximation)
    temp_note = ""
    if temp_f is not None:
        if temp_f < 45:
            temp_note = "Cold air suppresses ball carry. Pitcher-friendly conditions."
        elif temp_f < 60:
            temp_note = "Cool air. Slightly suppressed ball carry."
        elif temp_f > 80:
            temp_note = "Warm air expands ball flight slightly. Mild offense boost."
        else:
            temp_note = "Comfortable temperature. Neutral ball flight."

    return {
        "park": park_name,
        "is_dome": False,
        "weather_relevant": True,
        "game_time_utc": game_time_utc,
        "temperature_f": round(temp_f, 1) if temp_f else None,
        "wind_mph": round(wind_mph, 1) if wind_mph else None,
        "wind_direction_deg": wind_dir,
        "humidity_pct": humidity,
        "precipitation_chance_pct": precip_pct,
        "wind_effect": wind_effect,
        "temperature_note": temp_note,
        "park_notes": park.get("notes", ""),
        "altitude_note": "HIGH ALTITUDE" if "Coors" in park_name else None,
        "data_source": "open_meteo",
    }


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print(json.dumps({"usage": "python tools/fetch_weather.py 'Park Name' 'YYYY-MM-DDTHH:MM:SSZ'"}))
        print(json.dumps({"known_parks": list(PARK_DATA.keys())}, indent=2))
        return

    park = args[0]
    game_time = args[1]
    result = fetch_weather(park, game_time)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
