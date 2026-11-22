"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Mode } from "./stop-icon";

export type Locale = "zh-Hant" | "en";

// Every sentence the page can show lives here, so a new locale is one object
// rather than a sweep of the components. Values that carry a number are
// functions, because the two languages count differently and English needs a
// singular form.
export type Messages = {
  appTitle: string;
  brand: string;
  stopsInView: (count: number) => string;
  mode: Record<Mode, string>;
  switchLanguage: string;
  mtrClosedTitle: string;
  ferryClosedTitle: string;
  closedHours: (hours: string) => string;
  clock: (value: string) => string;
  nextDayHours: (from: string, to: string) => string;
  locate: {
    idle: string;
    locating: string;
    error: string;
  };
  locateHelp: {
    title: string;
    intro: string;
    unavailableIntro: string;
    browserLabel: string;
    browser: string[];
    ios: string[];
    android: string[];
    iosLabel: string;
    androidLabel: string;
    close: string;
  };
  report: string;
  sheet: {
    close: string;
    share: string;
    copy: string;
    copied: string;
    otherMaps: string;
    googleMaps: string;
    appleMaps: string;
    baiduMaps: string;
    amap: string;
    openStreetMap: string;
    taxiNote: string;
    hours: string;
    destination: string;
    firstBoat: string;
    lastBoat: string;
    taxiHours: string;
    taxiAllDay: string;
    delayed: string;
    timetable: string;
    ferryTimetable: string;
    everyMinutes: (frequency: string) => string;
    toilet: string;
    toiletLayout: string;
    noArrivals: string;
    origin: string;
    notDeparted: string;
    minutes: (minutes: number) => string;
    updated: (age: string) => string;
    gone: string;
    feedError: string;
    waiting: string;
    loading: string;
  };
  age: {
    seconds: (seconds: number) => string;
    minutes: (minutes: number) => string;
    hours: (hours: number) => string;
  };
};

function clockParts(value: string): { hour: number; minute: string } {
  const [hourText, minuteText] = value.split(":");
  let hour = Number(hourText);
  if (hour === 24) hour = 0;
  return { hour, minute: (minuteText ?? "00").slice(0, 2).padStart(2, "0") };
}

function duration(minutes: number, hour: string, minute: string, due: string): string {
  if (minutes <= 0) return due;
  if (minutes < 60) return `${minutes} ${minute}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${hours} ${hour}`;
  return `${hours} ${hour} ${rest} ${minute}`;
}

function englishClock(value: string): string {
  const { hour, minute } = clockParts(value);
  const suffix = hour < 12 ? "am" : "pm";
  const shown = hour % 12 || 12;
  return `${shown}:${minute} ${suffix}`;
}

function chineseClock(value: string): string {
  const { hour, minute } = clockParts(value);
  if (hour === 0) return `午夜12:${minute}`;
  if (hour < 6) return `凌晨${hour}:${minute}`;
  if (hour < 12) return `上午${hour}:${minute}`;
  if (hour === 12) return `中午12:${minute}`;
  if (hour < 18) return `下午${hour - 12}:${minute}`;
  return `晚上${hour - 12}:${minute}`;
}

const en: Messages = {
  appTitle: "Realtime HK public transport",
  brand: "Hong Kong public transport",
  stopsInView: (count) => `${count} stop${count === 1 ? "" : "s"} in view`,
  mode: { mtr: "MTR", bus: "Bus", minibus: "Minibus", ferry: "Ferry", taxi: "Taxi" },
  switchLanguage: "Switch language",
  mtrClosedTitle: "MTR has stopped for the night",
  ferryClosedTitle: "Ferries have stopped for the night",
  closedHours: (hours) => `Service hours ${hours}, Hong Kong time`,
  clock: englishClock,
  nextDayHours: (from, to) => `${from}–${to} (next day)`,
  locate: {
    idle: "Show my location",
    locating: "Finding your location…",
    error: "Could not get your location. Try again.",
  },
  locateHelp: {
    title: "Can't find your location",
    intro: "This site cannot use your location. Turn on location for your browser, then tap the location button again.",
    unavailableIntro: "No GPS position could be found. Check the steps below, then tap the location button again.",
    browserLabel: "Browser",
    browser: [
      "Allow location for this site in your browser's site settings.",
      "Chrome: tap ⋮, then Settings, Site settings, Location.",
      "Safari: tap aA, then Website Settings, Location.",
      "Stay outdoors or near a window for a better GPS signal.",
    ],
    ios: [
      "Open the Settings app.",
      "Go to Privacy & Security, then Location Services, and turn it on.",
      "Scroll down to your browser (Safari or Chrome) and choose While Using the App.",
      "Come back to this page and tap the location button again.",
    ],
    android: [
      "Make sure location is on in your phone's quick settings.",
      "Tap the lock or site icon in the address bar.",
      "Open Permissions or Site settings, then Location.",
      "Choose Allow.",
      "Come back to this page and tap the location button again.",
    ],
    iosLabel: "iPhone / iPad",
    androidLabel: "Android",
    close: "Close",
  },
  report: "Report a problem",
  sheet: {
    close: "Close",
    share: "Share",
    copy: "Copy",
    copied: "Copied",
    otherMaps: "Other maps",
    googleMaps: "Google Maps",
    appleMaps: "Apple Maps",
    baiduMaps: "Baidu Maps",
    amap: "Amap",
    openStreetMap: "OpenStreetMap",
    taxiNote: "A taxi stand has no arrival list.",
    hours: "Working hours",
    destination: "Destination",
    firstBoat: "First",
    lastBoat: "Last",
    taxiHours: "Working hours",
    taxiAllDay: "Open all day",
    delayed: "Delayed",
    timetable: "Not live. These are timetable times.",
    ferryTimetable: "Timetable",
    everyMinutes: (frequency) => `every ${frequency} min`,
    toilet: "Toilet",
    toiletLayout: "Layout",
    noArrivals: "No arrivals right now.",
    origin: "Origin",
    notDeparted: "Not yet departed",
    minutes: (minutes) => duration(minutes, "h", "min", "Due"),
    updated: (age) => `Updated ${age}`,
    gone: "The snapshot is gone.",
    feedError: "The arrivals feed did not answer.",
    waiting: "Waiting for the live feed…",
    loading: "Loading arrivals…",
  },
  age: {
    seconds: (seconds) => `${seconds}s ago`,
    minutes: (minutes) => `${minutes} min ago`,
    hours: (hours) => `${hours} h ago`,
  },
};

const zhHant: Messages = {
  appTitle: "香港交通",
  brand: "香港交通",
  stopsInView: (count) => `畫面中有 ${count} 個站點`,
  mode: { mtr: "港鐵", bus: "巴士", minibus: "小巴", ferry: "渡輪", taxi: "的士" },
  switchLanguage: "切換語言",
  mtrClosedTitle: "港鐵已收車",
  ferryClosedTitle: "渡輪已收船",
  closedHours: (hours) => `服務時間 ${hours}（香港時間）`,
  clock: chineseClock,
  nextDayHours: (from, to) => `${from}–翌日${to}`,
  locate: {
    idle: "顯示我的位置",
    locating: "正在定位…",
    error: "無法取得你的位置，請再試一次。",
  },
  locateHelp: {
    title: "無法取得你的位置",
    intro: "此網站無法使用你的位置。請為瀏覽器開啟定位權限，然後再按一次定位按鈕。",
    unavailableIntro: "無法取得 GPS 定位。請參考以下步驟，然後再按一次定位按鈕。",
    browserLabel: "瀏覽器",
    browser: [
      "在瀏覽器的網站設定中，允許此網站使用位置。",
      "Chrome：點擊 ⋮，然後選擇設定、網站設定、位置。",
      "Safari：點擊 aA，然後選擇網站設定、位置。",
      "請到戶外或窗邊，GPS 訊號會較好。",
    ],
    ios: [
      "打開「設定」App。",
      "進入「私隱與安全性」，再進入「定位服務」，並將其開啟。",
      "向下找到你使用的瀏覽器（Safari 或 Chrome），選擇「使用 App 時」。",
      "返回此頁面，再按一次定位按鈕。",
    ],
    android: [
      "確保手機的定位功能已開啟（可於快速設定中開啟）。",
      "點擊網址列旁的鎖頭或網站圖示。",
      "選擇「權限」或「網站設定」，再進入「位置」。",
      "選擇「允許」。",
      "返回此頁面，再按一次定位按鈕。",
    ],
    iosLabel: "iPhone / iPad",
    androidLabel: "Android",
    close: "關閉",
  },
  report: "回報問題",
  sheet: {
    close: "關閉",
    share: "分享",
    copy: "複製",
    copied: "已複製",
    otherMaps: "其他地圖",
    googleMaps: "Google 地圖",
    appleMaps: "Apple 地圖",
    baiduMaps: "百度地圖",
    amap: "高德地圖",
    openStreetMap: "OpenStreetMap",
    taxiNote: "的士站沒有到站時間。",
    hours: "服務時間",
    destination: "目的地",
    firstBoat: "頭班",
    lastBoat: "尾班",
    taxiHours: "開放時間",
    taxiAllDay: "全日開放",
    delayed: "延誤",
    timetable: "非即時，以下為時間表班次。",
    ferryTimetable: "時間表",
    everyMinutes: (frequency) => `每 ${frequency} 分鐘`,
    toilet: "洗手間",
    toiletLayout: "平面圖",
    noArrivals: "暫無到站班次。",
    origin: "始站",
    notDeparted: "未開出",
    minutes: (minutes) => duration(minutes, "小時", "分鐘", "即將到站"),
    updated: (age) => `更新於 ${age}`,
    gone: "資料已失效。",
    feedError: "到站資料未能回應。",
    waiting: "正在等待即時資料…",
    loading: "正在載入到站資料…",
  },
  age: {
    seconds: (seconds) => `${seconds} 秒前`,
    minutes: (minutes) => `${minutes} 分鐘前`,
    hours: (hours) => `${hours} 小時前`,
  },
};

const messages: Record<Locale, Messages> = { en, "zh-Hant": zhHant };

// The static export is prerendered in this locale, and `layout.tsx` declares the
// same one on <html>, so the server and the first client render agree.
const defaultLocale: Locale = "zh-Hant";
const storageKey = "hk-traffic.locale";

function storedLocale(): Locale | null {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === "en" || value === "zh-Hant" ? value : null;
  } catch {
    return null;
  }
}

// Readers in Hong Kong usually run a Chinese browser; everyone else opens in
// English. An explicit choice always wins over the browser hint.
function preferredLocale(): Locale {
  const stored = storedLocale();
  if (stored) return stored;
  const language = typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
  return language.startsWith("zh") ? "zh-Hant" : "en";
}

// A layout effect applies the stored language before the first paint, so a
// visitor who picked English never sees a frame of Chinese. On the server it
// degrades to a plain effect.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type I18nValue = {
  locale: Locale;
  t: Messages;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);

  useIsomorphicLayoutEffect(() => {
    setLocaleState(preferredLocale());
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
  }, []);

  const toggleLocale = useCallback(() => {
    setLocaleState((current) => {
      const next: Locale = current === "en" ? "zh-Hant" : "en";
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        // Private mode: the choice lasts for this page only.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = messages[locale].appTitle;
  }, [locale]);

  const value = useMemo<I18nValue>(
    () => ({ locale, t: messages[locale], setLocale, toggleLocale }),
    [locale, setLocale, toggleLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside <I18nProvider>");
  return value;
}
