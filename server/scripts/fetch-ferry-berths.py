#!/usr/bin/env python3
"""Write web/public/ferry-services.json from the Hong Kong Ferry wiki pier pages.

Each row is a berth, a destination, and the first and last boat. The sheet
reads the file. Re-run this when a pier's published boats change.
"""

import json
import re
import ssl
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "web" / "public" / "ferry-services.json"
API = "https://hkferry.fandom.com/zh/api.php"

# Wiki page title to the stop id in server/data/stops.json. The combined
# Central piers page disagrees with the individual pier pages, so it is absent.
TITLE = {
    "中環2號碼頭": "ferry:101104",
    "中環3號碼頭": "ferry:101337",
    "中環4號碼頭": "ferry:101126",
    "中環5號碼頭": "ferry:101102",
    "中環6號碼頭": "ferry:101108",
    "中環8號碼頭": "ferry:101358",
    "中環9號及10號碼頭": "ferry:80000003",
    "中環天星碼頭": "ferry:101339",
    "尖沙咀天星碼頭": "ferry:101119",
    "灣仔渡輪碼頭": "ferry:101118",
    "長洲渡輪碼頭": "ferry:101101",
    "梅窩渡輪碼頭": "ferry:101107",
    "坪洲渡輪碼頭": "ferry:101109",
    "榕樹灣渡輪碼頭": "ferry:101123",
    "北角 (西) 碼頭": "ferry:101110",
    "北角 (東) 碼頭": "ferry:101349",
    "紅磡 (北) 碼頭": "ferry:101111",
    "紅磡 (南) 碼頭": "ferry:101357",
    "九龍城渡輪碼頭": "ferry:101112",
    "荃灣渡輪碼頭": "ferry:101105",
    "珀麗灣渡輪碼頭": "ferry:101103",
    "愉景灣渡輪碼頭": "ferry:101127",
    "愉景灣北碼頭": "ferry:80000019",
    "觀塘渡輪碼頭": "ferry:101320",
    "西灣河渡輪碼頭": "ferry:101321",
    "三家村渡輪碼頭": "ferry:101322",
    "東涌發展碼頭": "ferry:101114",
    "沙螺灣碼頭": "ferry:101117",
    "屯門渡輪碼頭": "ferry:101113",
    # Not in the pier category. The Central route ended in 2002; the kaito remains.
    "北角碼頭 (南丫島)": "ferry:101122",
    "索罟灣二號碼頭": "ferry:101348",
    "索罟灣公眾碼頭": "ferry:101124",
    "芝麻灣碼頭": "ferry:101115",
    "喜靈洲公眾碼頭": "ferry:101324",
    "大澳海濱長廊": "ferry:101120",
    "西九碼頭": "ferry:80000025",
    "啟德跑道公園碼頭": "ferry:101355",
    "坪洲公眾碼頭": "ferry:101356",
    "大水坑碼頭": "ferry:101340",
    "香港仔海濱公園": "ferry:101332",
}

PLACES = [
    ("南丫島 (索罟灣)", "Sok Kwu Wan"),
    ("南丫島 (榕樹灣)", "Yung Shue Wan"),
    ("索罟灣", "Sok Kwu Wan"),
    ("榕樹灣", "Yung Shue Wan"),
    ("中環天星碼頭", "Central Star Ferry Pier"),
    ("中環（6號碼頭）", "Central Pier 6"),
    ("中環（5號碼頭）", "Central Pier 5"),
    ("中環（4號碼頭）", "Central Pier 4"),
    ("中環（2號碼頭）", "Central Pier 2"),
    ("中環4號碼頭", "Central Pier 4"),
    ("中環8號碼頭", "Central Pier 8"),
    ("中環3號碼頭", "Central Pier 3"),
    ("尖沙咀天星碼頭", "Tsim Sha Tsui Star Ferry Pier"),
    ("灣仔渡輪碼頭", "Wan Chai Ferry Pier"),
    ("紅磡 (南)", "Hung Hom (South)"),
    ("紅磡 (北)", "Hung Hom (North)"),
    ("北角 (西)", "North Point (West)"),
    ("北角 (東)", "North Point (East)"),
    ("愉景灣北", "Discovery Bay North"),
    ("愉景灣", "Discovery Bay"),
    ("珀麗灣渡輪碼頭", "Park Island Ferry Pier"),
    ("尖東", "Tsim Sha Tsui East"),
    ("珀麗灣", "Park Island"),
    ("喜靈洲", "Hei Ling Chau"),
    ("芝麻灣", "Chi Ma Wan"),
    ("長洲", "Cheung Chau"),
    ("梅窩二號梯台", "Mui Wo Landing No. 2"),
    ("梅窩梯台", "Mui Wo Landing"),
    ("大水坑碼頭", "Tai Shui Hang Pier"),
    ("大水坑", "Tai Shui Hang"),
    ("稔樹灣登岸處", "Nim Shue Wan Landing"),
    ("稔樹灣", "Nim Shue Wan"),
    ("北角村", "Pak Kok Tsuen"),
    ("北角(東)", "North Point (East)"),
    ("模達", "Mo Tat"),
    ("蒲台", "Po Toi"),
    ("赤柱", "Stanley"),
    ("西貢", "Sai Kung"),
    ("屯門", "Tuen Mun"),
    ("梅窩", "Mui Wo"),
    ("坪洲公眾碼頭", "Peng Chau Public Pier"),
    ("坪洲", "Peng Chau"),
    ("尖沙咀", "Tsim Sha Tsui"),
    ("九龍城", "Kowloon City"),
    ("西灣河", "Sai Wan Ho"),
    ("三家村", "Sam Ka Tsuen"),
    ("馬料水", "Ma Liu Shui"),
    ("黃石", "Wong Shek"),
    ("筲箕灣避風塘", "Shau Kei Wan Typhoon Shelter"),
    ("東龍島", "Tung Lung Chau"),
    ("香港仔魚類批發市場", "Aberdeen Wholesale Fish Market"),
    ("香港仔行人隧道口", "Aberdeen pedestrian tunnel"),
    ("香港仔", "Aberdeen"),
    ("鴨脷洲悅海華庭", "Ap Lei Chau Marina Habitat"),
    ("東平洲", "Tung Ping Chau"),
    ("塔門", "Tap Mun"),
    ("伙頭墳洲", "Fo Tau Fan Chau"),
    ("企嶺下海", "Kei Ling Ha"),
    ("荔枝窩", "Lai Chi Wo"),
    ("糧船灣", "Leung Shuen Wan"),
    ("滘西村", "Kau Sai Village"),
    ("鹽田梓", "Yim Tin Tsai"),
    ("沙頭角", "Sha Tau Kok"),
    ("吉澳", "Kat O"),
    ("鴨洲", "Ap Chau"),
    ("將軍澳南", "Tseung Kwan O South"),
    ("大廟灣", "Tai Miu Wan"),
    ("沙螺灣", "Sha Lo Wan"),
    ("東涌", "Tung Chung"),
    ("大澳", "Tai O"),
    ("觀塘", "Kwun Tong"),
    ("荃灣", "Tsuen Wan"),
    ("啟德", "Kai Tak"),
    ("西九", "West Kowloon"),
    ("灣仔", "Wan Chai"),
    ("中環", "Central"),
    ("原點上落", "Same pier"),
    ("原地上落", "Same pier"),
]

PHRASES = [
    ("星期六、日及公眾假期", "Sat, Sun and public holidays"),
    ("星期日及公眾假期", "Sun and public holidays"),
    ("星期三至一及公眾假期", "Wed–Mon and public holidays"),
    ("星期六及假日", "Sat and holidays"),
    ("星期一至五學校假期", "School holidays Mon–Fri"),
    ("星期一、三、五", "Mon, Wed and Fri"),
    ("星期二（公眾假期除外）", "Tue except public holidays"),
    ("星期二不設服務", "No service on Tue"),
    ("星期二", "Tue"),
    ("其他日子", "Other days"),
    ("週末及假日", "Weekends and holidays"),
    ("週六及假日", "Sat and holidays"),
    ("平日及週六", "Weekdays and Sat"),
    ("週一至六", "Mon–Sat"),
    ("週一至五", "Mon–Fri"),
    ("星期一至五上課日", "School days Mon–Fri"),
    ("星期一至六", "Mon–Sat"),
    ("星期一至五", "Mon–Fri"),
    ("週二、四", "Tue and Thu"),
    ("只限核准人士乘搭", "Permit holders only"),
    ("年初一、二停航", "No service on Lunar New Year day 1 and 2"),
    ("每年農曆三月廿二和三月廿三服務", "Lunar 22–23 March only"),
    ("每日上下午繁忙時間服務", "Peak hours only"),
    ("不能於愉景灣渡輪碼頭落客", "no alighting at Discovery Bay Ferry Pier"),
    ("或原地上落", "or the same pier"),
    ("只供落客", "Drop-off only"),
    ("不設服務", "No service"),
    ("不適用", "Not applicable"),
    ("西面泊位", "West berth"),
    ("東面泊位", "East berth"),
    ("北面泊位", "North berth"),
    ("南面泊位", "South berth"),
    ("普通渡輪", "ordinary ferry"),
    ("高速船", "fast ferry"),
    ("設1個泊位", "1 berth"),
    ("設2個泊位", "2 berths"),
    ("1/2號泊位", "Berths 1 and 2"),
    ("特別班次", "special sailing"),
    ("公眾假期", "public holidays"),
    ("星期六", "Sat"),
    ("假日", "Holidays"),
    ("平日", "Weekdays"),
    ("週六", "Sat"),
    ("西橋", "West berth"),
    ("東橋", "East berth"),
    ("西翼", "West wing"),
    ("東翼", "East wing"),
    ("原點上落", "Same pier"),
    ("原地上落", "Same pier"),
]


def fetch_pages():
    context = ssl.create_default_context()
    cert = Path("/etc/ssl/cert.pem")
    if cert.exists():
        context = ssl.create_default_context(cafile=str(cert))
    query = urllib.parse.urlencode(
        {
            "action": "query",
            "generator": "categorymembers",
            "gcmtitle": "Category:渡輪碼頭",
            "gcmlimit": "50",
            "prop": "revisions",
            "rvprop": "content",
            "rvslots": "main",
            "format": "json",
        }
    )
    request = urllib.request.Request(
        f"{API}?{query}",
        headers={"User-Agent": "realtime-hk-traffic/1.0"},
    )
    with urllib.request.urlopen(request, context=context, timeout=60) as response:
        body = json.load(response)
    pages = list(body["query"]["pages"].values())
    have = {page.get("title") for page in pages}
    missing = [title for title in TITLE if title not in have]
    if not missing:
        return pages
    extra = urllib.parse.urlencode(
        {
            "action": "query",
            "titles": "|".join(missing),
            "prop": "revisions",
            "rvprop": "content",
            "rvslots": "main",
            "format": "json",
        }
    )
    request = urllib.request.Request(
        f"{API}?{extra}",
        headers={"User-Agent": "realtime-hk-traffic/1.0"},
    )
    with urllib.request.urlopen(request, context=context, timeout=60) as response:
        body = json.load(response)
    pages.extend(body["query"]["pages"].values())
    return pages


def clean(value):
    value = re.sub(r"<ref[^>]*>.*?</ref>", "", value, flags=re.S)
    value = re.sub(r"<ref[^>]*/>", "", value)
    value = re.sub(r"\{\{[Ll]\|[^|}]*\|([^}]*)\}\}", r"\1", value)
    value = re.sub(r"\[\[(?:[^|\]]+\|)?([^\]]+)\]\]", r"\1", value)
    value = value.replace("'''", "").replace("''", "")
    value = re.sub(r"<br\s*/?>", "\n", value, flags=re.I)
    value = re.sub(r"<hr\s*/?>", " / ", value, flags=re.I)
    value = re.sub(r"</?small>", "", value)
    value = re.sub(r"<[^>]+>", "", value)
    value = re.sub(r"style=\"[^\"]*\"", "", value)
    value = re.sub(r"rowspan=\"?\d+\"?", "", value)
    value = re.sub(r"colspan=\"?\d+\"?", "", value)
    value = re.sub(r"width=\"[^\"]*\"", "", value)
    value = value.replace("|", " ")
    value = value.replace("：", ":")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r" *\n *", "\n", value)
    return value.strip(" \n#")


def english(value):
    out = value
    for zh, en in PHRASES:
        out = out.replace(zh, en)
    return out.replace("（", " (").replace("）", ")")


def bilingual_place(value):
    pattern = re.compile("|".join(re.escape(zh) for zh, _en in PLACES))
    names = dict(PLACES)

    def replace(match):
        zh = match.group(0)
        return f"{zh} {names[zh]}"

    return pattern.sub(replace, value)


def section(text):
    match = re.search(r"==\s*(?:航線資料|使用航線|泊岸航線|登岸設施)\s*==", text)
    if not match:
        return ""
    rest = text[match.end() :]
    stop = rest.find("曾使用")
    if stop != -1:
        rest = rest[:stop]
    return rest


def looks_time(value):
    return bool(re.search(r"\d{1,2}:\d{2}|不設服務|不適用|只供落客|繁忙|農曆", value))


def cells_of(line):
    found = []
    for bit in line.split("||"):
        span2 = bool(re.search(r"colspan\s*=\s*\"?2", bit))
        text = clean(re.sub(r"^[|\s]+", "", bit))
        if text:
            found.append((text, span2))
    return found


def useless(first, last):
    return first in {"不適用", "Not applicable"} and last in {"不適用", "Not applicable"}


def row(berth, destination, first, last):
    berth = berth.strip()
    return {
        "berth": {"zh": berth, "en": english(berth)},
        "destination": bilingual_place(destination),
        "first": {"zh": first, "en": english(first)},
        "last": {"zh": last, "en": english(last)},
    }


def services_for(text):
    berth = ""
    pending = []
    saw_row = False
    rows = []
    previous = None
    for line in section(text).splitlines():
        stripped = line.strip()
        if "background:orange" in stripped:
            text_berth = clean(stripped.split("|")[-1])
            pending = [text_berth] if saw_row else [*pending, text_berth]
            berth = "\n".join(part for part in pending if part)
            saw_row = False
            continue
        if stripped.startswith("|[[") and stripped.count("||") == 0:
            destination = clean(stripped[1:])
            if previous and destination:
                rows.append(row(previous["berth"]["zh"], destination, previous["first"]["zh"], previous["last"]["zh"]))
            continue
        if "||" not in stripped or any(word in stripped for word in ("停止服務", "停辦", "航線停止")):
            continue
        cells = cells_of(stripped)
        if len(cells) < 2:
            continue
        if cells[-1][1] and looks_time(cells[-1][0]):
            first = last = cells[-1][0]
            destination = cells[-2][0]
        elif looks_time(cells[-1][0]) and looks_time(cells[-2][0]):
            first, last = cells[-2][0], cells[-1][0]
            destination = cells[-3][0] if len(cells) >= 3 else ""
        elif looks_time(cells[-1][0]) and previous and not looks_time(cells[-2][0] if len(cells) > 1 else ""):
            first, last = cells[-1][0], previous["last"]["zh"]
            destination = cells[-2][0]
        else:
            continue
        if not destination or looks_time(destination) or re.search(r"\d{4}年", destination):
            continue
        if useless(first, last):
            continue
        made = row(berth, destination, first, last)
        rows.append(made)
        previous = made
        saw_row = True
    return rows


def main():
    services = {}
    for page in fetch_pages():
        stop = TITLE.get(page.get("title"))
        if not stop:
            continue
        revisions = page.get("revisions") or []
        text = ""
        if revisions:
            text = (revisions[0].get("slots") or {}).get("main", {}).get("*") or ""
        rows = services_for(text)
        if rows:
            services[stop] = rows
    # Piers whose own page has no first and last boat. Times are the departures
    # from that pier on the route page. On-demand boats are left out.
    extra = [
        ("ferry:101352", "三家村", "星期六、日及公眾假期:08:50\n平日:不設服務", "星期六、日及公眾假期:17:30\n平日:不設服務"),
        ("ferry:101352", "筲箕灣避風塘", "星期六、日及公眾假期:09:45\n平日:不設服務\n年初一、二停航", "星期六、日及公眾假期:17:30\n平日:不設服務\n年初一、二停航"),
        ("ferry:101131", "黃石", "10:20", "16:40"),
        ("ferry:101131", "馬料水", "10:45", "17:05"),
        ("ferry:101134", "黃石", "星期一至五:07:45\n星期六、日及公眾假期:08:00", "星期一至五:18:00\n星期六、日及公眾假期:18:05"),
        ("ferry:101134", "馬料水", "11:10", "17:30"),
        ("ferry:101130", "塔門", "08:30", "星期一至五:18:30\n星期六、日及公眾假期:18:35"),
        ("ferry:101130", "馬料水", "10:35", "16:55"),
        ("ferry:101133", "塔門", "08:30", "15:00"),
        ("ferry:101133", "黃石", "08:30", "15:00"),
        ("ferry:101133", "東平洲", "星期六:09:00\n星期日及公眾假期:09:00\n星期一至五:不設服務", "星期六:15:30\n星期日及公眾假期:09:00\n星期一至五:不設服務"),
        ("ferry:101132", "馬料水", "星期六、日及公眾假期:17:15\n平日:不設服務", "星期六、日及公眾假期:17:15\n平日:不設服務"),
        ("ferry:80000013", "黃石", "星期一至五:07:50\n星期六、日及公眾假期:08:05", "星期一至五:18:05\n星期六、日及公眾假期:18:10"),
        ("ferry:80000013", "塔門", "08:50", "星期一至五:18:50\n星期六、日及公眾假期:18:55"),
        ("ferry:101136", "塔門", "09:00", "15:30"),
        ("ferry:101136", "馬料水", "11:55", "18:15"),
        ("ferry:101136", "企嶺下海", "星期六、日及公眾假期:10:30\n平日:不設服務", "星期六、日及公眾假期:17:30\n平日:不設服務"),
        ("ferry:101137", "塔門", "09:15", "15:45"),
        ("ferry:101137", "馬料水", "11:40", "18:00"),
        ("ferry:101323", "香港仔", "06:08", "22:28"),
        ("ferry:101323", "索罟灣", "07:05", "23:25"),
        ("ferry:101326", "赤柱 / 香港仔", "週二、四:15:30\n星期六:12:40\n星期日及公眾假期:09:15\n星期一、三、五:不設服務", "週二、四:15:30\n星期六:16:00\n星期日及公眾假期:18:00\n星期一、三、五:不設服務"),
        ("ferry:101336", "蒲台", "週二、四:不設服務\n星期六:13:20\n星期日及公眾假期:10:00\n星期一、三、五:不設服務", "週二、四:不設服務\n星期六:13:20\n星期日及公眾假期:17:00\n星期一、三、五:不設服務"),
        ("ferry:101336", "香港仔", "週二、四:不設服務\n星期六:約14:30\n星期日及公眾假期:約18:30\n星期一、三、五:不設服務", "週二、四:不設服務\n星期六:約16:30\n星期日及公眾假期:約18:30\n星期一、三、五:不設服務"),
        ("ferry:101128", "坪洲公眾碼頭", "06:45", "23:20"),
        ("ferry:101128", "大水坑碼頭", "08:00", "平日:14:35\n週六:15:40\n假日:15:50"),
        ("ferry:101128", "梅窩梯台", "星期一至五上課日:15:15\n週六:07:15\n假日:08:45\n星期一至五學校假期:不設服務", "星期一至五上課日:15:15\n週六及假日:20:05\n星期一至五學校假期:不設服務"),
        ("ferry:101350", "坪洲公眾碼頭", "星期一至五上課日:07:20\n星期一至五學校假期:不設服務\n星期六、日及公眾假期:不設服務", "星期一至五上課日:07:20\n星期一至五學校假期:不設服務\n星期六、日及公眾假期:不設服務"),
        ("ferry:101350", "稔樹灣登岸處", "星期一至五上課日:07:20\n週六:07:45\n假日:09:15\n星期一至五學校假期:不設服務", "星期一至五上課日:07:20\n週六及假日:20:30\n星期一至五學校假期:不設服務"),
        ("ferry:101331", "香港仔行人隧道口", "07:00", "22:50"),
        ("ferry:101331", "香港仔魚類批發市場", "06:00", "23:45"),
        ("ferry:101333", "鴨脷洲悅海華庭", "06:10", "23:50"),
        ("ferry:101351", "東龍島", "星期六、日及公眾假期:09:00\n平日:不設服務\n年初一、二停航", "星期六、日及公眾假期:16:40\n平日:不設服務\n年初一、二停航"),
        ("ferry:101351", "將軍澳南", "星期六、日及公眾假期:09:30\n平日:不設服務", "星期六、日及公眾假期:18:15\n平日:不設服務"),
        ("ferry:80000020", "筲箕灣避風塘", "星期六、日及公眾假期:10:00\n平日:不設服務", "星期六、日及公眾假期:18:45\n平日:不設服務"),
        ("ferry:80000006", "糧船灣", "星期六、日及公眾假期:09:30\n平日:不設服務", "星期六、日及公眾假期:16:30\n平日:不設服務"),
        ("ferry:80000006", "伙頭墳洲", "星期一至六:09:00\n星期日及公眾假期:不設服務", "星期一至六:14:00\n星期日及公眾假期:不設服務"),
        ("ferry:80000006", "鹽田梓", "星期六、日及公眾假期:10:00\n平日:不設服務", "星期六、日及公眾假期:15:00\n平日:不設服務"),
        ("ferry:80000007", "西貢", "星期一至六:10:00\n星期日及公眾假期:不設服務", "星期一至六:15:30\n星期日及公眾假期:不設服務"),
        ("ferry:80000017", "西貢", "星期六、日及公眾假期:10:30\n平日:不設服務", "星期六、日及公眾假期:17:30\n平日:不設服務"),
        ("ferry:80000016", "糧船灣", "星期六、日及公眾假期:10:00\n平日:不設服務", "星期六、日及公眾假期:17:00\n平日:不設服務"),
        ("ferry:80000016", "西貢", "星期六、日及公眾假期:13:00\n平日:不設服務", "星期六、日及公眾假期:16:00\n平日:不設服務"),
        ("ferry:101343", "吉澳", "星期三至一及公眾假期:08:30\n星期二:不設服務", "星期三至一及公眾假期:17:00\n星期二:不設服務"),
        ("ferry:101342", "沙頭角", "星期三至一及公眾假期:09:15\n星期二:不設服務", "星期三至一及公眾假期:16:00\n星期二:不設服務"),
        ("ferry:101342", "鴨洲", "星期三至一及公眾假期:09:15\n星期二:11:10", "星期三至一及公眾假期:13:15\n星期二:11:10"),
        ("ferry:101342", "馬料水", "星期六、日及公眾假期:15:30\n平日:不設服務", "星期六、日及公眾假期:15:30\n平日:不設服務"),
        ("ferry:101342", "大水坑", "星期二（公眾假期除外）:15:10\n其他日子:不設服務", "星期二（公眾假期除外）:15:10\n其他日子:不設服務"),
        ("ferry:80000008", "沙頭角", "星期三至一及公眾假期:09:30\n星期二:不設服務", "星期三至一及公眾假期:13:30\n星期二:不設服務"),
        ("ferry:80000008", "吉澳", "星期三至一及公眾假期:11:00\n星期二:不設服務", "星期三至一及公眾假期:15:45\n星期二:不設服務"),
        ("ferry:80000008", "荔枝窩", "星期二（公眾假期除外）:12:45\n其他日子:不設服務", "星期二（公眾假期除外）:12:45\n其他日子:不設服務"),
        ("ferry:101354", "沙頭角", "星期三至一及公眾假期:11:30\n星期二:不設服務", "星期三至一及公眾假期:16:15\n星期二:不設服務"),
        ("ferry:101354", "吉澳", "星期三至一及公眾假期:09:00\n星期二:10:40", "星期三至一及公眾假期:13:00\n星期二:13:10"),
        ("ferry:101354", "馬料水", "星期六、日及公眾假期:15:30\n平日:不設服務", "星期六、日及公眾假期:15:30\n平日:不設服務"),
        ("ferry:101354", "大水坑", "星期二（公眾假期除外）:15:40\n其他日子:不設服務", "星期二（公眾假期除外）:15:40\n其他日子:不設服務"),
        ("ferry:80000023", "荔枝窩", "星期六、日及公眾假期:09:00\n平日:不設服務", "星期六、日及公眾假期:09:00\n平日:不設服務"),
        ("ferry:80000023", "吉澳", "星期六、日及公眾假期:09:00\n平日:不設服務", "星期六、日及公眾假期:09:00\n平日:不設服務"),
        ("ferry:80000011", "荔枝窩 / 吉澳 / 鴨洲", "星期二（公眾假期除外）:09:00\n其他日子:不設服務", "星期二（公眾假期除外）:09:00\n其他日子:不設服務"),
        ("ferry:80000002", "西九", "10:40", "17:55"),
        ("ferry:80000002", "灣仔", "11:10", "18:25"),
        ("ferry:80000015", "中環", "11:25", "18:40"),
        ("ferry:80000015", "尖東", "11:55", "19:10"),
    ]
    for stop, destination, first, last in extra:
        services.setdefault(stop, []).append(row("", destination, first, last))
    OUT.write_text(json.dumps(services, ensure_ascii=False, indent=2) + "\n")
    print(f"{len(services)} piers, {sum(len(rows) for rows in services.values())} sailings -> {OUT}")


if __name__ == "__main__":
    main()
