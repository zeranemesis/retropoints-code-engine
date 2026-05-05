import fs from 'node:fs/promises';
import path from 'node:path';

const dbPath = path.resolve('data/retropoints-db.json');

async function readDb() {
  try {
    return JSON.parse(await fs.readFile(dbPath, 'utf8'));
  } catch {
    return { redemptions: [] };
  }
}

async function writeDb(db) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
}

export async function saveRedemption(redemption) {
  const db = await readDb();
  db.redemptions = db.redemptions || [];
  db.redemptions.push(redemption);
  await writeDb(db);
  return redemption;
}

export async function findPendingRedemptionByCode(code) {
  const db = await readDb();
  return (db.redemptions || []).find((item) => item.code === code && item.status === 'pending');
}

export async function markRedemptionUsed(code, orderId) {
  const db = await readDb();
  const item = (db.redemptions || []).find((entry) => entry.code === code);
  if (item) {
    item.status = 'used';
    item.orderId = orderId;
    item.usedAt = new Date().toISOString();
  }
  await writeDb(db);
  return item;
}
