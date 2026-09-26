// All shop-facing day bounds are Asia/Kolkata (no DST, fixed +5:30).
// Server/Workers run UTC — server-local setHours() would shift billing days.
// These helpers return absolute Dates for IST midnight / end-of-day.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istParts(d: Date): { y: number; m: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return { y: Number(map.year), m: Number(map.month), day: Number(map.day) };
}

export function startOfDay(d: Date) {
  const { y, m, day } = istParts(d);
  // IST midnight = UTC (midnight - 5:30)
  return new Date(Date.UTC(y, m - 1, day, 0, 0, 0, 0) - IST_OFFSET_MS);
}

export function endOfDay(d: Date) {
  const { y, m, day } = istParts(d);
  return new Date(Date.UTC(y, m - 1, day, 23, 59, 59, 999) - IST_OFFSET_MS);
}

export function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 86_400_000);
}

export function computeDueDate(days: number): Date {
  const base = startOfDay(new Date());
  return new Date(base.getTime() + days * 86_400_000);
}

export function generateOrderNumber(date = new Date()) {
  const d = date;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  const time = Date.now().toString(36).toUpperCase().slice(-4);
  return `ORD-${yyyy}${mm}${dd}-${random}${time}`;
}

export async function getNextOrderNumber(prisma: { order: { count: (a: unknown) => Promise<number> } }) {
  const today = startOfDay(new Date());
  const count = await prisma.order.count({
    where: { createdAt: { gte: today }, deletedAt: null } as any,
  });
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const seq = String(count + 1).padStart(3, "0");
  return `ORD-${yyyy}${mm}${dd}-${seq}`;
}
