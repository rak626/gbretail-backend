export function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function addDays(date: Date, days: number) {
  const x = new Date(date);
  x.setDate(x.getDate() + days);
  return x;
}

export function computeDueDate(days: number): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  now.setDate(now.getDate() + days);
  return now;
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const count = await prisma.order.count({
    where: { createdAt: { gte: today }, deletedAt: null } as any,
  });
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const seq = String(count + 1).padStart(3, "0");
  return `ORD-${yyyy}${mm}${dd}-${seq}`;
}
