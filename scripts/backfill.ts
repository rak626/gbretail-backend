import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
async function main(){
  const shop = await prisma.shop.findFirst({where:{ id:'shop_default'}});
  if(!shop){ console.log('no default shop'); return }
  const oCount = await prisma.order.count({where:{ shopId: null } as any});
  console.log('orders null shopId', oCount);
  if(oCount>0){
    const r = await prisma.order.updateMany({where:{ shopId: null } as any, data:{ shopId: shop.id }});
    console.log('backfilled orders', r.count);
  }
  const lCount = await prisma.ledgerEntry.count({where:{ shopId: null } as any});
  console.log('ledger null shopId', lCount);
  if(lCount>0){
    const r = await prisma.ledgerEntry.updateMany({where:{ shopId: null } as any, data:{ shopId: shop.id }});
    console.log('backfilled ledger', r.count);
  }
  await prisma.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
