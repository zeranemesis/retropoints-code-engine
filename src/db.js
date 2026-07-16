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
export async function startOrderProcessing(orderId, details = {}) {
  const db = await readDb();
  db.processedOrders = db.processedOrders || {};

  const key = String(orderId || '').trim();
  if (!key) throw new Error('Order id missing.');

  const current = db.processedOrders[key];
  const processingStartedAt = current?.startedAt ? new Date(current.startedAt).getTime() : 0;
  const processingExpired = current?.status === 'processing' && Date.now() - processingStartedAt > 15 * 60 * 1000;

  if (current && current.status !== 'failed' && !processingExpired) {
    return { started: false, record: current };
  }

  const record = {
    ...details,
    status: 'processing',
    startedAt: new Date().toISOString()
  };

  db.processedOrders[key] = record;
  await writeDb(db);

  return { started: true, record };
}

export async function finishOrderProcessing(orderId, details = {}) {
  const db = await readDb();
  db.processedOrders = db.processedOrders || {};

  const key = String(orderId || '').trim();
  const current = db.processedOrders[key] || {};
  db.processedOrders[key] = {
    ...current,
    ...details,
    status: 'processed',
    processedAt: new Date().toISOString()
  };

  await writeDb(db);
  return db.processedOrders[key];
}

export async function failOrderProcessing(orderId, error) {
  const db = await readDb();
  db.processedOrders = db.processedOrders || {};

  const key = String(orderId || '').trim();
  const current = db.processedOrders[key] || {};
  db.processedOrders[key] = {
    ...current,
    status: 'failed',
    failedAt: new Date().toISOString(),
    error: String(error?.message || error || 'Unknown error')
  };

  await writeDb(db);
  return db.processedOrders[key];
}
