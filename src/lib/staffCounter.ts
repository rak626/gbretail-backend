import { prisma } from "./prisma.js";

export type StaffCounter = { id: string; name: string };

/**
 * Resolve the counter a STAFF member bills on:
 * 1. Their owner-assigned counter (if still active + not deleted).
 * 2. Fallback: the shop's active counter with the fewest assigned staff
 *    (session-scoped — never persisted, so the owner still sees them
 *    as unassigned and can give them a real home).
 * Returns null when the shop has no active counter at all.
 */
export async function resolveStaffCounter(userId: string, shopId: string): Promise<StaffCounter | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { counterId: true, counter: { select: { id: true, name: true, isActive: true, deletedAt: true } } },
  });
  const assigned = (u as any)?.counter;
  if (assigned && !(assigned as any).deletedAt && (assigned as any).isActive) {
    return { id: assigned.id, name: assigned.name };
  }

  const counters = await prisma.counter.findMany({
    where: { shopId, deletedAt: null, isActive: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  if (!counters.length) return null;

  const counts = await prisma.user.groupBy({
    by: ["counterId"],
    where: { shopId, role: "STAFF", deletedAt: null, counterId: { not: null } },
    _count: { counterId: true },
  });
  const load = new Map<string, number>(counts.map((x) => [x.counterId as string, (x._count as any).counterId as number]));
  const ranked = counters
    .map((c) => ({ ...c, n: load.get(c.id) ?? 0 }))
    .sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));
  return { id: ranked[0].id, name: ranked[0].name };
}
