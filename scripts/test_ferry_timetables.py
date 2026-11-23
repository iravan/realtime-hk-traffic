"""Run with: python3 -m unittest discover scripts"""

import unittest

import ferry_timetables as ft


class Clock(unittest.TestCase):
    def test_every_spelling_in_the_files(self):
        cases = {
            "12:30 a.m.": "00:30",
            "3:00 a.m.": "03:00",
            "12:30 p.m.": "12:30",
            "11:30 p.m.": "23:30",
            "12:00 noon": "12:00",
            "12:03 noon": "12:03",
            "6:30am": "06:30",
            "6.00 a.m.": "06:00",
            "7 a.m.": "07:00",
            "4 p.m": "16:00",
            "7.12 am": "07:12",
            "12:30:00 a.m.": "00:30",
            "7:00 p.m..": "19:00",
            "11:45 a.m. ": "11:45",
            "18:20": "18:20",
        }
        for value, expected in cases.items():
            self.assertEqual(ft.clock(value), expected, value)

    def test_rejects_non_times(self):
        for value in ("Daily", "To be operated according to demand", "25:00", "13:00 p.m."):
            self.assertIsNone(ft.clock(value), value)


class DayGroups(unittest.TestCase):
    def test_labels_split_into_weekday_saturday_and_sunday(self):
        W, S, H = ft.WEEKDAYS, ft.SATURDAY, ft.SUNDAY
        cases = {
            "Mondays to Saturdays except public holidays": [W, S],
            "Mon – Fri  (Except Public Holidays)": [W],
            "Mondays to Friday except public holidays": [W],
            "Saturdays except Public Holidays": [S],
            "Saturdays (except public holidays)": [S],
            "Sat, Sun & Public Holidays": [S, H],
            "Saturdays Sundays and public holidays": [S, H],
            "Sundays & public holidays": [H],
            "Monday to Saturday": [W, S],
            "Daily": [ft.DAILY],
            "Mondays to Fridays (School Days only)": [ft.SCHOOL_DAYS],
        }
        for label, expected in cases.items():
            self.assertEqual(ft.day_groups(label), expected, label)

    def test_unknown_label_stops_the_build(self):
        with self.assertRaises(ValueError):
            ft.day_groups("To be operated according to demand")


class Sun(unittest.TestCase):
    def test_pier_five_takes_only_the_three_am_mui_wo_sailing(self):
        mui_wo = ft.parse_sun(
            "Direction,Service Date,Service Hour,Remark\n"
            "Central to Mui Wo,Mondays to Fridays except public holidays,3:00 a.m.,\n"
            "Central to Mui Wo,Mondays to Fridays except public holidays,6:10 a.m.,1\n"
        )
        sessions = ft.sun_sessions([], mui_wo, [])
        self.assertEqual([(s["pier"], s["time"]) for s in sessions], [("101102", "03:00"), ("101108", "06:10")])

    def test_cheung_chau_remarks_pick_weekday_or_saturday(self):
        cheung_chau = ft.parse_sun(
            "Direction,Service Date,Service Hour,Remark\n"
            "Central to Cheung Chau,Mondays to Saturdays except public holidays,6:20 p.m.,\n"
            "Central to Cheung Chau,Mondays to Fridays except public holidays,6:30 p.m.,2\n"
            "Central to Cheung Chau,Mondays to Saturdays except public holidays,7:30 p.m.,3\n"
            "Central to Cheung Chau,Mondays to Saturdays except public holidays,7:40 p.m.,4\n"
        )
        sessions = ft.sun_sessions(cheung_chau, [], [])
        self.assertEqual(
            [(s["time"], s["day"]) for s in sessions],
            [
                ("18:20", ft.WEEKDAYS),
                ("18:20", ft.SATURDAY),
                ("18:30", ft.WEEKDAYS),
                ("19:30", ft.SATURDAY),
                ("19:40", ft.SATURDAY),
            ],
        )
        self.assertEqual(sessions[0]["destination"], "長洲 Cheung Chau")

    def test_island_origins_leave_their_own_pier(self):
        other = ft.parse_sun(
            "Direction,Service Date,Service Hour,Remark\n"
            "Chueung Chau to Mui Wo,Daily,6:00 a.m.,\n"
            "Mui Wo  to Chi Ma Wan,Daily,8:00 a.m.,\n"
            "Hung Hom to North Point,Daily,7:00 a.m.,\n"
        )
        sessions = ft.sun_sessions([], [], other)
        self.assertEqual(
            [(s["pier"], s["destination"]) for s in sessions],
            [("101101", "梅窩 Mui Wo"), ("101107", "芝麻灣 Chi Ma Wan"), ("101111", "北角 North Point")],
        )


class Hkkf(unittest.TestCase):
    def test_cell_keeps_every_clock_with_its_markers(self):
        cell = "['{ 03:00 }', '#🞁09:15', '# { 18:00 }', '     07:50', '^#{ 00:30}', '*06:30', '']"
        self.assertEqual(
            ft.hkkf_cell(cell),
            [("03:00", "{}"), ("09:15", "#🞁"), ("18:00", "#{}"), ("07:50", ""), ("00:30", "^#{}"), ("06:30", "*")],
        )

    def test_monday_to_saturday_column_fills_weekdays_and_saturday(self):
        text = (
            "\ufeffroute id,direction,origin_en,a,b,destination_en,c,d,remarks_en,e,f,"
            "Monday to Saturday/星期一至星期六,Sunday and Public Holidays/星期日及公眾假期\n"
            "1,outbound,Central,中環,中环,Sok Kwu Wan,索罟灣,索罟湾,\"x, y\",,,\"['07:20', '^23:30']\",\"['08:00']\"\n"
        )
        sessions = ft.hkkf_sessions(text, "101126", "Sok Kwu Wan")
        self.assertEqual(
            [(s["day"], s["time"], s["remark"]) for s in sessions],
            [
                (ft.WEEKDAYS, "07:20", ""),
                (ft.SATURDAY, "07:20", ""),
                (ft.WEEKDAYS, "23:30", "^"),
                (ft.SATURDAY, "23:30", "^"),
                (ft.SUNDAY, "08:00", ""),
            ],
        )

    def test_braces_mean_saturday_only_where_the_route_says_so(self):
        header = (
            "route id,direction,origin_en,a,b,destination_en,c,d,remarks_en,e,f,"
            "Monday to Saturday/星期一至星期六,Sunday and Public Holidays/星期日及公眾假期\n"
        )
        yung_shue_wan = header + "2,outbound,Central,,,Yung Shue Wan,,,\"{ } Only available on Saturdays\",,,\"['{02:30}', '07:00']\",\"[]\"\n"
        peng_chau = header + "3,outbound,Central,,,Peng Chau,,,\"{ } No freight is allowed\",,,\"['{ 03:00 }']\",\"[]\"\n"
        self.assertEqual(
            [(s["day"], s["time"]) for s in ft.hkkf_sessions(yung_shue_wan, "101126", "Yung Shue Wan")],
            [(ft.SATURDAY, "02:30"), (ft.WEEKDAYS, "07:00"), (ft.SATURDAY, "07:00")],
        )
        self.assertEqual(
            [s["day"] for s in ft.hkkf_sessions(peng_chau, "101108", "Peng Chau")],
            [ft.WEEKDAYS, ft.SATURDAY],
        )


class CodedOperators(unittest.TestCase):
    def test_tsui_wah_weekday_code_covers_saturday(self):
        text = "route_type,date_type,route_start,time\nL,W,A,6:00\nL,W,Y,6:40\nL,S,A,7:20\n"
        sessions = ft.coded_sessions(text, ft.TSUI_WAH_LEGS, ft.TSUI_WAH_DAYS, "tsuiwah")
        self.assertEqual(
            [(s["pier"], s["day"], s["time"], s["destination"]) for s in sessions],
            [
                ("101125", ft.WEEKDAYS, "06:00", "南丫島 (榕樹灣) Yung Shue Wan"),
                ("101125", ft.SATURDAY, "06:00", "南丫島 (榕樹灣) Yung Shue Wan"),
                ("101123", ft.WEEKDAYS, "06:40", "香港仔 Aberdeen"),
                ("101123", ft.SATURDAY, "06:40", "香港仔 Aberdeen"),
                ("101125", ft.SUNDAY, "07:20", "南丫島 (榕樹灣) Yung Shue Wan"),
            ],
        )

    def test_chuen_kee_extra_saturday_code(self):
        text = "route_type,date_type,route_start,time\nL,WW,A,19:05\n"
        sessions = ft.coded_sessions(text, ft.CHUEN_KEE_LEGS, ft.CHUEN_KEE_DAYS, "chuenkee")
        self.assertEqual([(s["pier"], s["day"]) for s in sessions], [("101125", ft.SATURDAY)])


class Star(unittest.TestCase):
    def test_bands_read_the_origin_pier_and_frequency_range(self):
        text = (
            "Ferry Service Details,,,\n"
            "Operator:,\"The \"\"Star\"\" Ferry\",,\n"
            "Boarding location:,\"Central: Central Pier No.7\nTsim Sha Tsui: Kowloon Point\",,\n"
            ",,,\n"
            "Direction,Service Date,Service Hour,\"Frequency\n(minutes)\"\n"
            "Central to Tsim Sha Tsui,Mon – Fri  (Except Public Holidays),6:30am-7:25am,10 -- 12\n"
            "Tsim Sha Tsui to Central,\"Sat, Sun & Public Holidays\",10:30pm-11:30pm,6 --8\n"
        )
        bands = ft.star_bands(text)
        self.assertEqual(
            [(b["pier"], b["destination"], b["day"], b["from"], b["to"], b["frequency"]) for b in bands],
            [
                ("101339", "尖沙咀 Tsim Sha Tsui", ft.WEEKDAYS, "06:30", "07:25", "10–12"),
                ("101119", "中環 Central", ft.SATURDAY, "22:30", "23:30", "6–8"),
                ("101119", "中環 Central", ft.SUNDAY, "22:30", "23:30", "6–8"),
            ],
        )


class TransportDepartment(unittest.TestCase):
    def test_direction_rows_leave_their_origin_pier(self):
        text = (
            "\ufeffDirection,Service Date,Service Hour,Remark\n"
            "Central to Discovery Bay North,Saturdays except Public Holidays,7:30:00 a.m.,\n"
            "Mui Wo to Discovery Bay via Peng Chau Public Pier,Mondays to Fridays (School Days only),7:20 a.m.,\n"
        )
        piers = {"Central": "101337", "Mui Wo": "101350"}
        sessions = ft.td_sessions(text, "dbtsl", piers)
        self.assertEqual(
            [(s["pier"], s["destination"], s["day"], s["time"]) for s in sessions],
            [
                ("101337", "愉景灣北 Discovery Bay North", ft.SATURDAY, "07:30"),
                ("101350", "愉景灣 Discovery Bay", ft.SCHOOL_DAYS, "07:20"),
            ],
        )

    def test_tai_o_rows_go_to_their_bound(self):
        text = (
            "\ufeffService Date,Bound,From,Time,Remarks\n"
            "Mondays to Fridays (except public holidays),Tai O,Tung Chung,  8:30 a.m.,\n"
        )
        sessions = ft.td_tai_o_sessions(text, "fortune", {"Tung Chung": "101114"})
        self.assertEqual([(s["pier"], s["destination"], s["time"]) for s in sessions], [("101114", "大澳 Tai O", "08:30")])

    def test_water_taxi_runs_go_to_the_next_call(self):
        loop = "Tsim Sha Tsui East – Central (via West Kowloon and Wan Chai) "
        text = (
            "\ufeffRoute,Direction,Service Date,Service Hour,Remark\n"
            f"{loop},From Tsim Sha Tsui East,Daily,10.40 am,1.0\n"
            f"{loop},From West Kowloon,Daily,10.55 am,1.0\n"
            f"{loop},From Wan Chai,Daily,11.25 am,1.0\n"
            f"{loop},From Central,Daily,11.40 am,1.0\n"
        )
        sessions = ft.td_water_taxi_sessions(text, "fortune", ft.TD_WATER_TAXI[2])
        self.assertEqual(
            [(s["pier"], s["destination"], s["remark"]) for s in sessions],
            [
                ("80000002", "西九 West Kowloon", "1"),
                ("80000025", "灣仔 Wan Chai", "1"),
                ("80000015", "中環 Central", "1"),
                ("80000003", "尖東 Tsim Sha Tsui East", "1"),
            ],
        )


class Grouping(unittest.TestCase):
    def test_sessions_sorted_by_service_day_and_days_in_order(self):
        sessions = (
            ft.session("101102", "Cheung Chau", [ft.SUNDAY], "08:00", "", "sun")
            + ft.session("101102", "Cheung Chau", [ft.WEEKDAYS], "00:30", "", "sun")
            + ft.session("101102", "Cheung Chau", [ft.WEEKDAYS], "06:10", "1", "sun")
            + ft.session("101102", "Cheung Chau", [ft.WEEKDAYS], "06:10", "1", "sun")
        )
        timetable = ft.group(sessions, [])["101102"]
        self.assertEqual(timetable[0]["destination"], "長洲 Cheung Chau")
        self.assertEqual([day["day"] for day in timetable[0]["days"]], [ft.WEEKDAYS, ft.SUNDAY])
        self.assertEqual([s["time"] for s in timetable[0]["days"][0]["sessions"]], ["06:10", "00:30"])

    def test_board_adds_route_stops_after_timetable_places(self):
        timetables = ft.group(ft.session("101337", "Discovery Bay", [ft.DAILY], "07:00", "", "dbtsl"), [])
        route_stops = [
            ("7000023", "1", "1", "101337", "2"),
            ("7000023", "1", "2", "101127", "1"),
            ("7000023", "1", "3", "80000019", "1"),
            ("7001", "1", "1", "101326", "2"),
            ("7001", "1", "2", "101336", "3"),
            ("7001", "1", "3", "101125", "1"),
        ]
        boards = ft.board(timetables, route_stops)
        self.assertEqual(boards["101337"], ["愉景灣 Discovery Bay", "愉景灣北 Discovery Bay North"])
        self.assertEqual(boards["101326"], ["赤柱 Stanley", "香港仔 Aberdeen"])
        self.assertEqual(boards["101336"], ["香港仔 Aberdeen"])
        self.assertNotIn("101125", boards)


class Overrides(unittest.TestCase):
    def write(self, data):
        import json
        import tempfile

        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(data, handle, ensure_ascii=False)
        handle.close()
        self.addCleanup(lambda: __import__("os").unlink(handle.name))
        return handle.name

    def test_missing_file_means_no_patches(self):
        self.assertEqual(ft.load_overrides("/nonexistent/ferry-overrides.json"), {})

    def test_comments_are_skipped_and_fields_normalised(self):
        path = self.write({
            "_about": "note",
            "ferry:101104": {
                "name": " 民光街中環二號碼頭 Central Pier No. 2 ",
                "latitude": 22.288,
                "longitude": 114.156,
                "destinations": ["Park Island", "珀麗灣 Park Island"],
                "timetable": [{
                    "destination": "Ma Wan",
                    "days": [{
                        "day": ft.WEEKDAYS,
                        "sessions": [{"time": "18:20"}, {"time": "07:00", "remark": "1", "operator": "pitcl"}],
                        "bands": [{"from": "06:30", "to": "08:00", "frequency": "10"}],
                    }],
                }],
            },
        })
        patch = ft.load_overrides(path)["101104"]
        self.assertEqual(patch["name"], "民光街中環二號碼頭 Central Pier No. 2")
        self.assertEqual((patch["latitude"], patch["longitude"]), (22.288, 114.156))
        self.assertEqual(patch["destinations"], ["珀麗灣 Park Island", "珀麗灣 Park Island"])
        day = patch["timetable"][0]["days"][0]
        self.assertEqual([s["time"] for s in day["sessions"]], ["07:00", "18:20"])
        self.assertEqual(day["sessions"][1]["operator"], "manual")
        self.assertEqual(day["bands"][0]["operator"], "manual")
        self.assertEqual(patch["timetable"][0]["destination"], "珀麗灣 Park Island")

    def test_bad_entries_stop_the_run(self):
        cases = {
            "wrong key": {"101104": {"name": "x"}},
            "unknown field": {"ferry:101104": {"colour": "red"}},
            "bad latitude": {"ferry:101104": {"latitude": 1.0, "longitude": 114.1}},
            "bad day": {"ferry:101104": {"timetable": [{"destination": "Central", "days": [{"day": "Weekends", "sessions": []}]}]}},
            "bad time": {"ferry:101104": {"timetable": [{"destination": "Central", "days": [{"day": ft.DAILY, "sessions": [{"time": "6:30"}]}]}]}},
            "empty name": {"ferry:101104": {"name": "  "}},
        }
        for label, data in cases.items():
            with self.subTest(label), self.assertRaises(SystemExit):
                ft.load_overrides(self.write(data))


if __name__ == "__main__":
    unittest.main()
