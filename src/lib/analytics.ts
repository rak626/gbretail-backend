import { startOfDay, endOfDay } from "./utils.js";

export type Preset =
  | "today"
  | "yesterday"
  | "3d"
  | "7d"
  | "15d"
  | "1m"
  | "2m"
  | "3m"
  | "6m"
  | "1y"
  | "2y"
  | "3y"
  | "5y"
  | "custom";

export type Granularity = "hour" | "day" | "week" | "month";

export interface RangeBounds {
  start: Date;
  end: Date;
  granularity: Granularity;
  label: string;
  preset: Preset;
}

function clone(d: Date) { return new Date(d.getTime()); }
function addDays(d: Date, n: number) { const x = clone(d); x.setDate(x.getDate() + n); return x; }
function addMonths(d: Date, n: number) { const x = clone(d); x.setMonth(x.getMonth() + n); return x; }
function addYears(d: Date, n: number) { const x = clone(d); x.setFullYear(x.getFullYear() + n); return x; }

function startOfWeek(d: Date) {
  const x = startOfDay(d);
  const day = x.getDay(); // 0 Sun
  // Monday start
  const diff = (day + 6) % 7;
  x.setDate(x.getDate() - diff);
  return x;
}
function startOfMonth(d: Date) {
  const x = clone(d);
  x.setHours(0,0,0,0);
  x.setDate(1);
  return x;
}
function startOfYear(d: Date) {
  const x = clone(d);
  x.setHours(0,0,0,0);
  x.setMonth(0,1);
  return x;
}

const VALID_PRESETS = new Set<string>(["today","yesterday","3d","7d","15d","1m","2m","3m","6m","1y","2y","3y","5y","custom"]);

export function normalizePreset(p?: string): Preset {
  const v = (p ?? "7d").toLowerCase();
  if (VALID_PRESETS.has(v)) return v as Preset;
  return "7d";
}

export function resolveGranularity(preset: Preset, override?: string): Granularity {
  if (override && ["hour","day","week","month"].includes(override)) return override as Granularity;
  switch (preset) {
    case "today":
    case "yesterday": return "hour";
    case "3d":
    case "7d":
    case "15d": return "day";
    case "1m":
    case "2m": return "day";
    case "3m":
    case "6m": return "week";
    case "1y":
    case "2y":
    case "3y":
    case "5y": return "month";
    case "custom": return "day";
    default: return "day";
  }
}

export function getRangeBounds(presetRaw?: string, fromRaw?: string, toRaw?: string, granularityRaw?: string, tz: string = "Asia/Kolkata"): RangeBounds {
  const preset = normalizePreset(presetRaw);
  const now = new Date();
  // We use local server time but buckets are in IST — for JS aggregation we keep Dates as absolute,
  // but formatting uses IST. Since server likely UTC, we treat start/end as absolute IST midnight.
  // Simpler: compute in local time then return. For bucketing we use getBucketKey with IST formatting.
  let start: Date;
  let end: Date = endOfDay(now);
  let label: string = preset;

  const todayStart = startOfDay(now);
  // const todayEnd = endOfDay(now); // unused

  if (preset === "custom" && fromRaw && toRaw) {
    const f = new Date(fromRaw);
    const t = new Date(toRaw);
    if (!isNaN(f.getTime()) && !isNaN(t.getTime())) {
      start = startOfDay(f);
      end = endOfDay(t);
      label = `${formatISO(start)} to ${formatISO(end)}`;
    } else {
      start = startOfDay(addDays(now, -6));
    }
  } else {
    switch (preset) {
      case "today":
        start = todayStart;
        label = "Today";
        break;
      case "yesterday": {
        const y = addDays(todayStart, -1);
        start = y;
        end = endOfDay(y);
        label = "Yesterday";
        break;
      }
      case "3d":
        start = startOfDay(addDays(now, -2));
        label = "Last 3 days";
        break;
      case "7d":
        start = startOfDay(addDays(now, -6));
        label = "Last 7 days";
        break;
      case "15d":
        start = startOfDay(addDays(now, -14));
        label = "Last 15 days";
        break;
      case "1m":
        start = startOfDay(addMonths(now, -1));
        // keep original day? ensure start is 30 days ago approx. Use 30d? Use month start vs rolling.
        // Rolling 1 month = 30 days rolling is better for analytics. Keep addMonths logic but align to day start.
        label = "Last 1 month";
        break;
      case "2m":
        start = startOfDay(addMonths(now, -2));
        label = "Last 2 months";
        break;
      case "3m":
        start = startOfDay(addMonths(now, -3));
        label = "Last 3 months";
        break;
      case "6m":
        start = startOfDay(addMonths(now, -6));
        label = "Last 6 months";
        break;
      case "1y":
        start = startOfDay(addYears(now, -1));
        // inclusive: add 1 day
        start = startOfDay(addDays(start, 1));
        label = "Last 1 year";
        break;
      case "2y":
        start = startOfDay(addYears(now, -2));
        start = startOfDay(addDays(start, 1));
        label = "Last 2 years";
        break;
      case "3y":
        start = startOfDay(addYears(now, -3));
        start = startOfDay(addDays(start, 1));
        label = "Last 3 years";
        break;
      case "5y":
        start = startOfDay(addYears(now, -5));
        start = startOfDay(addDays(start, 1));
        label = "Last 5 years";
        break;
      default:
        start = startOfDay(addDays(now, -6));
    }
  }

  const granularity = resolveGranularity(preset, granularityRaw);
  return { start, end, granularity, label, preset };
}

export function formatISO(d: Date) { return d.toISOString().slice(0,10); }

export function getPrevRange(bounds: RangeBounds): { start: Date; end: Date } {
  const diffMs = bounds.end.getTime() - bounds.start.getTime();
  const prevEnd = new Date(bounds.start.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - diffMs);
  // normalize to startOfDay/endOfDay
  return { start: startOfDay(prevStart), end: endOfDay(prevEnd) };
}

// IST bucket key helpers
function formatInTZ(d: Date, tz: string) {
  // Use Intl to get IST date parts
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false });
  const parts = fmt.formatToParts(d);
  const map: Record<string,string> = {};
  for (const p of parts) map[p.type] = p.value;
  // en-CA gives YYYY-MM-DD
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
}

export function getBucketKey(d: Date, granularity: Granularity, tz: string = "Asia/Kolkata"): string {
  // Convert to IST date parts
  const ist = new Date(d.toLocaleString("en-US", { timeZone: tz }));
  const y = ist.getFullYear();
  const m = String(ist.getMonth()+1).padStart(2,"0");
  const day = String(ist.getDate()).padStart(2,"0");
  const h = String(ist.getHours()).padStart(2,"0");
  switch (granularity) {
    case "hour": return `${y}-${m}-${day} ${h}:00`;
    case "day": return `${y}-${m}-${day}`;
    case "week": {
      const wStart = startOfWeek(ist);
      const wy = wStart.getFullYear();
      const wm = String(wStart.getMonth()+1).padStart(2,"0");
      const wd = String(wStart.getDate()).padStart(2,"0");
      return `${wy}-${wm}-${wd}`; // week starting Monday
    }
    case "month": return `${y}-${m}`;
    default: return `${y}-${m}-${day}`;
  }
}

export function formatBucketLabel(key: string, granularity: Granularity): string {
  // key is already bucket key, return friendly
  if (granularity === "hour") {
    // "2026-09-22 14:00" -> "14:00 22 Sep"
    const [d, t] = key.split(" ");
    const [y,m,day] = d.split("-");
    return `${t} ${day}/${m}`;
  }
  if (granularity === "day") {
    const [y,m,day] = key.split("-");
    const dt = new Date(Number(y), Number(m)-1, Number(day));
    return dt.toLocaleDateString("en-IN", { day:"2-digit", month:"short" });
  }
  if (granularity === "week") {
    const [y,m,day] = key.split("-");
    const dt = new Date(Number(y), Number(m)-1, Number(day));
    return `Wk ${dt.toLocaleDateString("en-IN", { day:"2-digit", month:"short" })}`;
  }
  if (granularity === "month") {
    const [y,m] = key.split("-");
    const dt = new Date(Number(y), Number(m)-1, 1);
    return dt.toLocaleDateString("en-IN", { month:"short", year:"2-digit" });
  }
  return key;
}

export function generateEmptyBuckets(start: Date, end: Date, granularity: Granularity, tz: string = "Asia/Kolkata"): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const cur = clone(start);
  // iterate by granularity step
  // To avoid timezone drift, iterate using IST date
  // Use a safe loop limit 2000
  let iter = 0;
  while (cur.getTime() <= end.getTime() && iter < 5000) {
    const k = getBucketKey(cur, granularity, tz);
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
    if (granularity === "hour") cur.setHours(cur.getHours()+1);
    else if (granularity === "day") cur.setDate(cur.getDate()+1);
    else if (granularity === "week") cur.setDate(cur.getDate()+7);
    else if (granularity === "month") cur.setMonth(cur.getMonth()+1);
    else cur.setDate(cur.getDate()+1);
    iter++;
  }
  return keys;
}

// Profit helpers
export interface ProfitInput {
  price: number;
  costPrice?: number | null;
  quantity?: number | null;
  weight?: number | null;
  lineTotal: number;
}

export function qtyForItem(it: ProfitInput): number {
  if (it.weight != null && it.weight > 0) return Number(it.weight);
  if (it.quantity != null) return Number(it.quantity);
  return 1;
}

export function grossProfitForItem(it: ProfitInput): number {
  const q = qtyForItem(it);
  const cost = it.costPrice != null ? Number(it.costPrice) : 0;
  // For custom items where costPrice null, treat cost as 0 => profit = lineTotal
  // But ideally costPrice mandatory. If null, profit = lineTotal (no loss)
  const revenue = Number(it.lineTotal);
  // revenue = price * qty, but use lineTotal as source of truth (may include discount? No, lineTotal is before order discount)
  // So gross profit = revenue - cost*q
  return revenue - cost * q;
}

export function allocateDiscountToItems(items: ProfitInput[], discount: number, gross: number) {
  if (!discount || gross <= 0) return items.map(() => 0);
  return items.map(it => (Number(it.lineTotal) / gross) * discount);
}

// Ledger aging
export function getLedgerAgingBucket(dueDate: Date, now: Date = new Date()): string {
  const start = new Date(dueDate); start.setHours(0,0,0,0);
  const n = new Date(now); n.setHours(0,0,0,0);
  const diffDays = Math.floor((n.getTime() - start.getTime()) / (1000*60*60*24));
  // diff negative => due in future, bucket "0-7" future but we separate as "due-future"? For simplicity, future counts as "0-7" pending not overdue.
  // But for pending ageing we want overdue buckets only. If diff <0 => "Not due"
  if (diffDays < 0) {
    const future = Math.abs(diffDays);
    if (future <= 7) return "Not due (0-7d)";
    if (future <= 15) return "Not due (8-15d)";
    return "Not due (15+d)";
  }
  if (diffDays <= 7) return "0-7";
  if (diffDays <= 15) return "7-15";
  if (diffDays <= 30) return "15-30";
  if (diffDays <= 60) return "30-60";
  return "60+";
}

export const LEDGER_AGING_BUCKETS = ["0-7","7-15","15-30","30-60","60+"] as const;
export const LEDGER_AGING_ALL = ["Not due (0-7d)","Not due (8-15d)","Not due (15+d)","0-7","7-15","15-30","30-60","60+"] as const;
