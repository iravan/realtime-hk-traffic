"""Static ferry timetables for every pier.

Operators publish files for the routes they run, and the Transport Department
publishes one file per licensed route. Every sailing becomes a row at the pier
it leaves from, filed under the place it goes to and one of a few day groups.
`build` returns those rows grouped per pier; `board` lists every place a pier
reaches, from the timetables first and the TD route stop list after.
"""

import ast
import csv
import io
import json
import re
from collections import defaultdict
from pathlib import Path

WEEKDAYS = "Mondays to Fridays except public holidays"
SATURDAY = "Saturdays except public holidays"
SUNDAY = "Sundays and public holidays"
DAILY = "Daily"
SCHOOL_DAYS = "Mondays to Fridays (school days only)"
DAY_ORDER = [WEEKDAYS, SATURDAY, SUNDAY, DAILY, SCHOOL_DAYS]

# English place names in the source files, as "Chinese English" labels. The
# labels match the keys of web/public/ferry-destination-colors.json where one
# exists, so the page can colour them.
PLACES = {
    "Aberdeen": "香港仔 Aberdeen",
    "Ap Chau": "鴨洲 Ap Chau",
    "Ap Lei Chau": "鴨脷洲 Ap Lei Chau",
    "Central": "中環 Central",
    "Chek Keng": "赤徑 Chek Keng",
    "Cheung Chau": "長洲 Cheung Chau",
    "Chueung Chau": "長洲 Cheung Chau",
    "Chi Ma Wan": "芝麻灣 Chi Ma Wan",
    "Discovery Bay": "愉景灣 Discovery Bay",
    "Discovery Bay North": "愉景灣北 Discovery Bay North",
    "Fo Tau Fan Chau": "伙頭墳洲 Fo Tau Fan Chau",
    "Hei Ling Chau": "喜靈洲 Hei Ling Chau",
    "Hung Hom": "紅磡 Hung Hom",
    "Kai Tak": "啟德 Kai Tak",
    "Kat O": "吉澳 Kat O",
    "Kau Sai": "滘西 Kau Sai",
    "Ko Lau Wan": "高流灣 Ko Lau Wan",
    "Kowloon City": "九龍城 Kowloon City",
    "Kwun Tong": "觀塘 Kwun Tong",
    "Lai Chi Chong": "荔枝莊 Lai Chi Chong",
    "Lai Chi Wo": "荔枝窩 Lai Chi Wo",
    "Lei Yue Mun": "鯉魚門 Lei Yue Mun",
    "Leung Shuen Wan": "糧船灣 Leung Shuen Wan",
    "Ma Liu Shui": "馬料水 Ma Liu Shui",
    "Ma Wan": "珀麗灣 Park Island",
    "Park Island": "珀麗灣 Park Island",
    "Mo Tat": "模達 Mo Tat",
    "Mui Wo": "梅窩 Mui Wo",
    "North Point": "北角 North Point",
    "Pak Kok Tsuen": "北角村 Pak Kok Tsuen",
    "Peng Chau": "坪洲 Peng Chau",
    "Po Toi": "蒲台 Po Toi",
    "Sai Kung": "西貢 Sai Kung",
    "Sai Wan Ho": "西灣河 Sai Wan Ho",
    "Sam Ka Tsuen": "三家村 Sam Ka Tsuen",
    "Sha Lo Wan": "沙螺灣 Sha Lo Wan",
    "Sha Tau Kok": "沙頭角 Sha Tau Kok",
    "Sham Chung": "深涌 Sham Chung",
    "Sok Kwu Wan": "南丫島 (索罟灣) Sok Kwu Wan",
    "Stanley": "赤柱 Stanley",
    "Tai O": "大澳 Tai O",
    "Tai Shui Hang": "大水坑 Tai Shui Hang",
    "Tap Mun": "塔門 Tap Mun",
    "Trappist Monastery": "聖母神樂院 Trappist Monastery",
    "Tsim Sha Tsui": "尖沙咀 Tsim Sha Tsui",
    "Tsim Sha Tsui East": "尖東 Tsim Sha Tsui East",
    "Tseung Kwan O South": "將軍澳南 Tseung Kwan O South",
    "Tsuen Wan": "荃灣 Tsuen Wan",
    "Tuen Mun": "屯門 Tuen Mun",
    "Tung Chung": "東涌 Tung Chung",
    "Tung Lung Chau": "東龍島 Tung Lung Chau",
    "Tung Ping Chau": "東平洲 Tung Ping Chau",
    "Wan Chai": "灣仔 Wan Chai",
    "Wanchai": "灣仔 Wan Chai",
    "West Kowloon": "西九 West Kowloon",
    "Wong Shek": "黃石 Wong Shek",
    "Yung Shue Wan": "南丫島 (榕樹灣) Yung Shue Wan",
}

# The place each pier serves, keyed by Transport Department STOP_ID.
PIER_PLACES = {
    "101101": "Cheung Chau",
    "101102": "Central",
    "101103": "Ma Wan",
    "101104": "Central",
    "101105": "Tsuen Wan",
    "101107": "Mui Wo",
    "101108": "Central",
    "101109": "Peng Chau",
    "101110": "North Point",
    "101111": "Hung Hom",
    "101112": "Kowloon City",
    "101113": "Tuen Mun",
    "101114": "Tung Chung",
    "101115": "Chi Ma Wan",
    "101117": "Sha Lo Wan",
    "101118": "Wan Chai",
    "101119": "Tsim Sha Tsui",
    "101120": "Tai O",
    "101122": "Pak Kok Tsuen",
    "101123": "Yung Shue Wan",
    "101124": "Sok Kwu Wan",
    "101125": "Aberdeen",
    "101126": "Central",
    "101127": "Discovery Bay",
    "101128": "Discovery Bay",
    "101130": "Wong Shek",
    "101131": "Chek Keng",
    "101132": "Tung Ping Chau",
    "101133": "Ma Liu Shui",
    "101134": "Tap Mun",
    "101136": "Sham Chung",
    "101137": "Lai Chi Chong",
    "101320": "Kwun Tong",
    "101321": "Sai Wan Ho",
    "101322": "Sam Ka Tsuen",
    "101323": "Mo Tat",
    "101324": "Hei Ling Chau",
    "101326": "Po Toi",
    "101327": "Tung Lung Chau",
    "101331": "Ap Lei Chau",
    "101332": "Aberdeen",
    "101333": "Aberdeen",
    "101336": "Stanley",
    "101337": "Central",
    "101339": "Central",
    "101340": "Trappist Monastery",
    "101342": "Kat O",
    "101343": "Sha Tau Kok",
    "101348": "Sok Kwu Wan",
    "101349": "North Point",
    "101350": "Mui Wo",
    "101351": "Sai Wan Ho",
    "101352": "Tung Lung Chau",
    "101354": "Lai Chi Wo",
    "101355": "Kai Tak",
    "101356": "Peng Chau",
    "101357": "Hung Hom",
    "101358": "Central",
    "80000002": "Tsim Sha Tsui East",
    "80000003": "Central",
    "80000006": "Sai Kung",
    "80000007": "Fo Tau Fan Chau",
    "80000008": "Ap Chau",
    "80000011": "Tai Shui Hang",
    "80000013": "Ko Lau Wan",
    "80000015": "Wan Chai",
    "80000016": "Kau Sai",
    "80000017": "Leung Shuen Wan",
    "80000019": "Discovery Bay North",
    "80000020": "Tseung Kwan O South",
    "80000023": "Ma Liu Shui",
    "80000025": "West Kowloon",
}

SUN = "https://www.sunferry.com.hk/eta/timetable/SunFerry_{}_timetable_eng.csv"
SUN_CENTRAL_CHEUNG_CHAU = SUN.format("central_cheungchau")
SUN_CENTRAL_MUI_WO = SUN.format("central_muiwo")
SUN_OTHER = [SUN.format(name) for name in ("interislands", "northpoint_hunghom", "northpoint_kowlooncity")]

# Hong Kong & Kowloon Ferry publishes one file per route and direction.
# Outbound leaves the route origin, inbound returns to it.
HKKF = "https://www.hkkfeta.com/opendata/time_table/{route}/{direction}"
HKKF_LEGS = [
    ("101126", 1, "outbound", "Sok Kwu Wan"),
    ("101126", 2, "outbound", "Yung Shue Wan"),
    ("101348", 1, "inbound", "Central"),
    ("101123", 2, "inbound", "Central"),
    ("101108", 3, "outbound", "Peng Chau"),
    ("101109", 3, "inbound", "Central"),
    ("101109", 4, "outbound", "Hei Ling Chau"),
    ("101324", 4, "inbound", "Peng Chau"),
]

STAR = [
    "https://www.starferry.com.hk/sites/default/files/upload/open_data/csv/ferry_sf_central_tsimshatsui_timetable_eng.csv",
    "https://www.starferry.com.hk/sites/default/files/upload/open_data/csv/ferry_sf_wanchai_tsimshatsui_timetable_eng.csv",
]
STAR_PIERS = {"Central": "101339", "Tsim Sha Tsui": "101119", "Wanchai": "101118", "Wan Chai": "101118"}

# Tsui Wah (Aberdeen - Yung Shue Wan) and Chuen Kee (Aberdeen - Sok Kwu Wan via
# Mo Tat) list each sailing by the end it starts from. The day codes are not
# defined in the files; they are read by matching the TD timetables, where
# Tsui Wah `W` is Monday to Saturday and Chuen Kee `WW` is the extra Saturday
# sailing.
TSUI_WAH = "https://www.traway.com.hk/govdata/time.csv"
TSUI_WAH_LEGS = {"A": ("101125", "Yung Shue Wan"), "Y": ("101123", "Aberdeen")}
TSUI_WAH_DAYS = {"W": [WEEKDAYS, SATURDAY], "S": [SUNDAY], "H": [SUNDAY]}
CHUEN_KEE = "https://ferry.com.hk/opendataV/time.csv"
CHUEN_KEE_LEGS = {"A": ("101125", "Sok Kwu Wan"), "S": ("101124", "Aberdeen")}
CHUEN_KEE_DAYS = {"W": [WEEKDAYS, SATURDAY], "WW": [SATURDAY], "S": [SUNDAY]}

# Transport Department files for the routes no operator file covers. Rows
# whose origin is not named here are left to the operator files.
TD = "https://www.td.gov.hk/datagovhk_td/ferry-tt-ft/resources/en/ferry_{}_timetable_eng.csv"
TD_ROUTES = [
    ("central_db", "dbtsl", {"Central": "101337", "Discovery Bay": "101127", "Discovery Bay North": "80000019"}),
    ("mawan_c", "pitcl", {"Ma Wan": "101103", "Central": "101104"}),
    ("mawan_tw", "pitcl", {"Ma Wan": "101103", "Tsuen Wan": "101105"}),
    ("c_hh", "fortune", {"Central": "101358", "Hung Hom": "101357"}),
    ("np_ktak", "fortune", {"North Point": "101349", "Kwun Tong": "101320", "Kai Tak": "101355"}),
    ("swh_kt", "coralsea", {"Sai Wan Ho": "101321", "Kwun Tong": "101320"}),
    ("swh_skt", "coralsea", {"Sai Wan Ho": "101321", "Sam Ka Tsuen": "101322"}),
    ("db_mw", "pckaito", {"Discovery Bay": "101128", "Peng Chau": "101356", "Mui Wo": "101350"}),
    ("db_pc_tm", "tsuiwah", {"Peng Chau": "101356", "Discovery Bay": "101128", "Trappist Monastery": "101340"}),
    ("abd_ysw", "tsuiwah", {"Pak Kok Tsuen": "101122"}),
]
TD_TAI_O = ("tm_tc_slw_to", "fortune", {"Tuen Mun": "101113", "Tung Chung": "101114", "Sha Lo Wan": "101117", "Tai O": "101120"})
TD_WATER_TAXI = ("WaterTaxi", "fortune", {"Tsim Sha Tsui East": "80000002", "West Kowloon": "80000025", "Wan Chai": "80000015", "Central": "80000003"})

CLOCK = re.compile(r"(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*(?:([ap])\.?\s*m\b|(noon))?[.\s]*")


def clock(value):
    """`3:00 a.m.`, `6.30am`, `7 p.m`, `12:00 noon` and `18:20` become `HH:MM`."""
    match = CLOCK.fullmatch(value.strip().lower())
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2) or 0)
    period = match.group(3)
    if minute > 59:
        return None
    if period:
        if not 1 <= hour <= 12:
            return None
        if period == "a" and hour == 12:
            hour = 0
        elif period == "p" and hour != 12:
            hour += 12
    elif match.group(4):
        if hour != 12:
            return None
    elif hour > 23:
        return None
    return f"{hour:02}:{minute:02}"


def day_groups(label):
    """Every day label in the files maps onto the groups in DAY_ORDER."""
    text = " ".join(label.lower().replace("&", " and ").replace(",", " ").split())
    if text == "daily":
        return [DAILY]
    if "school" in text:
        return [SCHOOL_DAYS]
    if text.startswith("mon"):
        return [WEEKDAYS, SATURDAY] if re.search(r"\bsat", text) else [WEEKDAYS]
    if text.startswith("sat"):
        return [SATURDAY, SUNDAY] if re.search(r"\bsun", text) else [SATURDAY]
    if text.startswith("sun"):
        return [SUNDAY]
    raise ValueError(f"unknown ferry day label: {label!r}")


def place(name):
    name = " ".join(name.split())
    return PLACES.get(name, name)


def leg(direction):
    """`Mui Wo to Discovery Bay via Peng Chau Public Pier` is (Mui Wo, Discovery Bay)."""
    origin, _, destination = direction.partition(" to ")
    destination = re.split(r"\s+via\s+", destination)[0]
    return " ".join(origin.split()), " ".join(destination.split())


def rows(text):
    return list(csv.reader(io.StringIO(text.lstrip("\ufeff"))))


def remark_code(value):
    return re.sub(r"\.0$", "", value.strip())


def session(pier, destination, days, time, remark, operator):
    return [
        {"pier": pier, "destination": place(destination), "day": day, "time": time, "remark": remark, "operator": operator}
        for day in days
    ]


def parse_sun(text):
    sailings = []
    for record in rows(text)[1:]:
        if len(record) < 3:
            continue
        time = clock(record[2])
        if time:
            sailings.append((record[0].strip(), record[1].strip(), time, remark_code(record[3]) if len(record) > 3 else ""))
    return sailings


# Sun Ferry piers: all Central to Cheung Chau sailings and the 03:00 Central to
# Mui Wo sailing leave Central Pier No. 5, the other Central to Mui Wo sailings
# leave Pier No. 6, and the rest leave the pier of their origin.
SUN_PIERS = {
    "Cheung Chau": "101101",
    "Chueung Chau": "101101",
    "Mui Wo": "101107",
    "Peng Chau": "101109",
    "Chi Ma Wan": "101115",
    "North Point": "101110",
    "Hung Hom": "101111",
    "Kowloon City": "101112",
}


def sun_sessions(cheung_chau, mui_wo, other):
    out = []
    for direction, day, time, remark in cheung_chau + mui_wo + other:
        origin, destination = leg(direction)
        if origin == "Central":
            pier = "101108" if destination == "Mui Wo" and time != "03:00" else "101102"
        else:
            pier = SUN_PIERS.get(origin)
        if not pier:
            continue
        days = day_groups(day)
        # On the Cheung Chau sheet, remark 2 runs Monday to Friday only, and
        # remarks 3 and 4 (4 is 1 and 3 together) run on Saturdays only.
        if days == [WEEKDAYS, SATURDAY]:
            if remark == "2":
                days = [WEEKDAYS]
            elif remark in ("3", "4"):
                days = [SATURDAY]
        out += session(pier, destination, days, time, remark, "sun")
    return out


def hkkf_cell(cell):
    """`['{ 03:00 }', '#🞁09:15', '^#{ 00:30}', '']` keeps each clock with its markers."""
    try:
        tokens = ast.literal_eval(cell.strip())
    except (ValueError, SyntaxError):
        tokens = cell.strip("[]").split(",")
    out = []
    for token in tokens:
        token = str(token).strip().strip("'")
        match = re.search(r"\d{1,2}:\d{2}", token)
        time = clock(match.group(0)) if match else None
        if time:
            out.append((time, re.sub(r"[\d:\s]", "", token)))
    return out


def hkkf_sessions(text, pier, destination):
    records = rows(text)
    if not records:
        return []
    header = records[0]
    out = []
    for record in records[1:]:
        # Each route defines its own markers in `remarks_en`. On Yung Shue Wan
        # `{ }` is "Only available on Saturdays"; on Peng Chau it means no freight.
        remarks = record[8] if len(record) > 8 else ""
        braces_saturday = re.search(r"\{\s*\}\s*Only available on Saturdays", remarks, re.I) is not None
        # The last two columns are the Monday to Saturday and Sunday lists.
        for column in (11, 12):
            if column >= len(record) or column >= len(header):
                continue
            days = day_groups(header[column].split("/")[0])
            for time, remark in hkkf_cell(record[column]):
                on = [SATURDAY] if braces_saturday and "{}" in remark and SATURDAY in days else days
                out += session(pier, destination, on, time, remark, "hkkf")
    return out


def coded_sessions(text, legs, day_codes, operator):
    out = []
    for record in rows(text)[1:]:
        if len(record) < 4:
            continue
        _, date_type, route_start, value = (field.strip() for field in record[:4])
        time = clock(value)
        if route_start in legs and date_type in day_codes and time:
            pier, destination = legs[route_start]
            out += session(pier, destination, day_codes[date_type], time, "", operator)
    return out


def star_bands(text):
    records = rows(text)
    start = next((i for i, record in enumerate(records) if record and record[0] == "Direction"), None)
    if start is None:
        return []
    out = []
    for record in records[start + 1 :]:
        if len(record) < 4:
            continue
        direction, day, hours, frequency = record[:4]
        origin, destination = leg(direction)
        pier = STAR_PIERS.get(origin)
        start_clock, _, end_clock = hours.partition("-")
        start_time, end_time = clock(start_clock), clock(end_clock)
        if not pier or not start_time or not end_time:
            continue
        frequency = "–".join(part.strip() for part in frequency.split("--"))
        for group in day_groups(day):
            out.append({
                "pier": pier,
                "destination": place(destination),
                "day": group,
                "from": start_time,
                "to": end_time,
                "frequency": frequency,
                "operator": "star",
            })
    return out


def td_sessions(text, operator, piers):
    out = []
    for record in rows(text)[1:]:
        if len(record) < 3:
            continue
        origin, destination = leg(record[0])
        time = clock(record[2])
        if origin in piers and time:
            remark = remark_code(record[3]) if len(record) > 3 else ""
            out += session(piers[origin], destination, day_groups(record[1]), time, remark, operator)
    return out


def td_tai_o_sessions(text, operator, piers):
    """Columns: service date, bound (where the boat ends), from, time, remarks."""
    out = []
    for record in rows(text)[1:]:
        if len(record) < 4:
            continue
        day, bound, origin = record[0], " ".join(record[1].split()), " ".join(record[2].split())
        time = clock(record[3])
        if origin in piers and time:
            remark = remark_code(record[4]) if len(record) > 4 else ""
            out += session(piers[origin], bound, day_groups(day), time, remark, operator)
    return out


def td_water_taxi_sessions(text, operator, piers):
    """Columns: route, `From <place>`, service date, time, remark.

    The sheet lists each run of departures from one place, in the order the
    boat calls. A run goes to the place the next run on that route leaves
    from, wrapping round at the end.
    """
    runs = []
    for record in rows(text)[1:]:
        if len(record) < 4:
            continue
        route = " ".join(record[0].split())
        origin = " ".join(record[1].split()).removeprefix("From ").strip()
        key = (route, origin, record[2].strip())
        if not runs or runs[-1][0] != key:
            runs.append((key, []))
        runs[-1][1].append(record)
    out = []
    for index, ((route, origin, day), records) in enumerate(runs):
        later = runs[index + 1 :] + runs[:index]
        destination = next((key[1] for key, _ in later if key[0] == route and key[1] != origin), None)
        if origin not in piers or not destination:
            continue
        for record in records:
            time = clock(record[3])
            if time:
                remark = remark_code(record[4]) if len(record) > 4 else ""
                out += session(piers[origin], destination, day_groups(day), time, remark, operator)
    return out


def service_minutes(time):
    hour, minute = map(int, time.split(":"))
    minutes = hour * 60 + minute
    # Sailings after midnight and before 04:00 close the service day.
    return minutes + 1440 if minutes < 240 else minutes


def group(sessions, bands):
    """Pier -> [{destination, days: [{day, sessions, bands}]}]."""
    piers = defaultdict(dict)
    for item in sessions + bands:
        destinations = piers[item["pier"]]
        days = destinations.setdefault(item["destination"], {})
        days.setdefault(item["day"], {"sessions": {}, "bands": []})
    for item in sessions:
        slot = piers[item["pier"]][item["destination"]][item["day"]]["sessions"]
        slot.setdefault((item["time"], item["operator"]), {
            "time": item["time"],
            "remark": item["remark"],
            "operator": item["operator"],
        })
    for item in bands:
        piers[item["pier"]][item["destination"]][item["day"]]["bands"].append(
            {key: item[key] for key in ("from", "to", "frequency", "operator")}
        )
    out = {}
    for pier, destinations in piers.items():
        out[pier] = [
            {
                "destination": destination,
                "days": [
                    {
                        "day": day,
                        "sessions": sorted(days[day]["sessions"].values(), key=lambda s: (service_minutes(s["time"]), s["operator"])),
                        "bands": days[day]["bands"],
                    }
                    for day in sorted(days, key=DAY_ORDER.index)
                ],
            }
            for destination, days in destinations.items()
        ]
    return out


def build(fetch_text):
    """Fetch every source with `fetch_text(url) -> str` and group the sailings by pier."""
    sessions = sun_sessions(
        parse_sun(fetch_text(SUN_CENTRAL_CHEUNG_CHAU)),
        parse_sun(fetch_text(SUN_CENTRAL_MUI_WO)),
        [sailing for url in SUN_OTHER for sailing in parse_sun(fetch_text(url))],
    )
    for pier, route, direction, destination in HKKF_LEGS:
        sessions += hkkf_sessions(fetch_text(HKKF.format(route=route, direction=direction)), pier, destination)
    sessions += coded_sessions(fetch_text(TSUI_WAH), TSUI_WAH_LEGS, TSUI_WAH_DAYS, "tsuiwah")
    sessions += coded_sessions(fetch_text(CHUEN_KEE), CHUEN_KEE_LEGS, CHUEN_KEE_DAYS, "chuenkee")
    for name, operator, piers in TD_ROUTES:
        sessions += td_sessions(fetch_text(TD.format(name)), operator, piers)
    name, operator, piers = TD_TAI_O
    sessions += td_tai_o_sessions(fetch_text(TD.format(name)), operator, piers)
    name, operator, piers = TD_WATER_TAXI
    sessions += td_water_taxi_sessions(fetch_text(TD.format(name)), operator, piers)
    bands = [band for url in STAR for band in star_bands(fetch_text(url))]
    return group(sessions, bands)


OVERRIDE_FIELDS = {"name", "latitude", "longitude", "destinations", "timetable"}


def load_overrides(path):
    """Read the hand-maintained patch file. A missing file means no patches.

    Keys starting with `_` are comments. Every other key is a pier id such as
    `ferry:101337`. Each pier entry may set:

    - `name`, `latitude`, `longitude`: replace the TD or CSDI values, or supply
      coordinates for a pier the CSDI layer does not have.
    - `destinations`: replace the generated board.
    - `timetable`: replace the generated timetable. Same shape as the generated
      one: a list of `{destination, days: [{day, sessions, bands}]}`.
      Sessions are `{time, remark, operator}`, bands are
      `{from, to, frequency, operator}`. Without `destinations`, the board is
      the destinations of this timetable.
    """
    path = Path(path)
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise SystemExit(f"{path}: top level must be an object")
    out = {}
    for key, entry in raw.items():
        if key.startswith("_"):
            continue
        where = f"{path}: {key}"
        if not re.fullmatch(r"ferry:\d+", key):
            raise SystemExit(f"{where}: key must look like ferry:101337")
        if not isinstance(entry, dict):
            raise SystemExit(f"{where}: must be an object")
        unknown = set(entry) - OVERRIDE_FIELDS
        if unknown:
            raise SystemExit(f"{where}: unknown fields {sorted(unknown)}")
        out[key.split(":", 1)[1]] = validate_override(entry, where)
    return out


def validate_override(entry, where):
    patch = {}
    if "name" in entry:
        if not isinstance(entry["name"], str) or not entry["name"].strip():
            raise SystemExit(f"{where}: name must be a non-empty string")
        patch["name"] = entry["name"].strip()
    for field, low, high in (("latitude", 22.1, 22.6), ("longitude", 113.8, 114.5)):
        if field in entry:
            value = entry[field]
            if not isinstance(value, (int, float)) or not low <= value <= high:
                raise SystemExit(f"{where}: {field} must be a number between {low} and {high}")
            patch[field] = float(value)
    if "destinations" in entry:
        values = entry["destinations"]
        if not isinstance(values, list) or not all(isinstance(v, str) and v.strip() for v in values):
            raise SystemExit(f"{where}: destinations must be a list of strings")
        patch["destinations"] = [place(v) if v in PLACES else v.strip() for v in values]
    if "timetable" in entry:
        patch["timetable"] = validate_timetable(entry["timetable"], where)
    return patch


def validate_timetable(value, where):
    if not isinstance(value, list):
        raise SystemExit(f"{where}: timetable must be a list")
    out = []
    for destination in value:
        if not isinstance(destination, dict) or not isinstance(destination.get("destination"), str):
            raise SystemExit(f"{where}: each timetable entry needs a destination string")
        name = destination["destination"].strip()
        days = []
        for day in destination.get("days", []):
            label = day.get("day")
            if label not in DAY_ORDER:
                raise SystemExit(f"{where}: unknown day {label!r}; use one of {DAY_ORDER}")
            sessions = []
            for item in day.get("sessions", []):
                time = item.get("time", "")
                if clock(time) != time:
                    raise SystemExit(f"{where}: session time {time!r} must be HH:MM")
                sessions.append({
                    "time": time,
                    "remark": str(item.get("remark", "")),
                    "operator": str(item.get("operator", "manual")),
                })
            bands = []
            for item in day.get("bands", []):
                start, end = item.get("from", ""), item.get("to", "")
                if clock(start) != start or clock(end) != end:
                    raise SystemExit(f"{where}: band {start!r}-{end!r} must be HH:MM")
                bands.append({
                    "from": start,
                    "to": end,
                    "frequency": str(item.get("frequency", "")),
                    "operator": str(item.get("operator", "manual")),
                })
            days.append({
                "day": label,
                "sessions": sorted(sessions, key=lambda s: (service_minutes(s["time"]), s["operator"])),
                "bands": bands,
            })
        days.sort(key=lambda d: DAY_ORDER.index(d["day"]))
        out.append({"destination": place(name), "days": days})
    return out


def board(timetables, route_stops):
    """Pier -> every place it reaches.

    `route_stops` is a list of (route id, route seq, stop seq, stop id,
    STOP_PICK_DROP) from RSTOP_FERRY.xml, where 2 is boarding only, 1 is
    alighting only and 3 is both. Places from the timetables come first.
    """
    out = defaultdict(list)
    for pier, destinations in timetables.items():
        for destination in destinations:
            if destination["destination"] not in out[pier]:
                out[pier].append(destination["destination"])
    sequences = defaultdict(list)
    for route, route_seq, stop_seq, stop, pick_drop in route_stops:
        sequences[(route, route_seq)].append((int(stop_seq), stop, pick_drop))
    for stops in sequences.values():
        stops.sort()
        for index, (_, pier, pick_drop) in enumerate(stops):
            if pick_drop not in ("2", "3") or pier not in PIER_PLACES:
                continue
            here = place(PIER_PLACES[pier])
            for _, later, later_drop in stops[index + 1 :]:
                if later_drop not in ("1", "3") or later not in PIER_PLACES:
                    continue
                there = place(PIER_PLACES[later])
                if there != here and there not in out[pier]:
                    out[pier].append(there)
    return dict(out)
