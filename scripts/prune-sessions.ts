import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prune expired/revoked sessions so Session doesn't grow unbounded.
// Run via cron: `npm run db:prune-sessions`
// Deletes: expiresAt < now-7d (grace for forensics), or revokedAt < now-30d.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  const now = new Date();
  const expiredCutoff = new Date(now.getTime() - 7 * 86_400_000);
  const revokedCutoff = new Date(now.getTime() - 30 * 86_400_000);
  const expired = await prisma.session.deleteMany({ where: { expiresAt: { lt: expiredCutoff } } });
  console.log(`[prune] expired sessions deleted: ${expired.count}`);
  const revoked = await prisma.session.deleteMany({ where: { revokedAt: { lt: revokedCutoff } } });
  console.log(`[prune] old revoked sessions deleted: ${revoked.count}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
