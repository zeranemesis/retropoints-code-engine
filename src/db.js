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

export async function saveInstallation(installation) {
  const db = await readDb();
  db.installations = db.installations || {};
  db.installations[installation.shop] = {
    ...installation,
    installedAt: new Date().toISOString()
  };
  await writeDb(db);
  return db.installations[installation.shop];
}

export async function getInstallation(shop) {
  const db = await readDb();
  return db.installations?.[shop] || null;
}

export async function getLatestInstallation() {
  const db = await readDb();
  const installations = Object.values(db.installations || {});

  return installations.sort((a, b) => {
    return new Date(b.installedAt || 0) - new Date(a.installedAt || 0);
  })[0] || null;
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
