import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const dbPath = path.resolve(process.env.RETROPOINTS_DB_PATH || 'data/retropoints-db.json');
let storeTail = Promise.resolve();
const customerTails = new Map();

function emptyDb() {
  return { redemptions: [], processedOrders: {}, installations: {}, proxyReplays: {} };
}

async function readDb() {
  try {
    const value = JSON.parse(await fs.readFile(dbPath, 'utf8'));
    return { ...emptyDb(), ...value };
  } catch {
    return emptyDb();
  }
}

async function writeDb(db) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const tempPath = dbPath + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(tempPath, JSON.stringify(db, null, 2), 'utf8');
  await fs.rename(tempPath, dbPath);
}

export function withStoreLock(fn) {
  const run = storeTail.then(fn, fn);
  storeTail = run.catch(() => {});
  return run;
}

export function withCustomerLock(customerId, fn) {
  const key = String(customerId);
  const previous = customerTails.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  const tracked = run.catch(() => {});
  customerTails.set(key, tracked);
  return run.finally(() => {
    if (customerTails.get(key) === tracked) customerTails.delete(key);
  });
}

function isActiveRedemption(item, now = Date.now()) {
  return ['creating', 'reserved'].includes(item.status) && new Date(item.expiresAt).getTime() > now;
}

export async function cleanupExpiredRedemptions() {
  return withStoreLock(async () => {
    const db = await readDb();
    const now = Date.now();
    let changed = false;
    for (const item of db.redemptions) {
      if (isActiveRedemption(item, now)) continue;
      if (['creating', 'reserved'].includes(item.status)) {
        item.status = 'expired';
        item.releasedAt = new Date().toISOString();
        item.updatedAt = item.releasedAt;
        changed = true;
      }
    }
    if (changed) await writeDb(db);
    return changed;
  });
}

export async function getActiveReservedPoints(customerId) {
  return withStoreLock(async () => {
    const db = await readDb();
    const now = Date.now();
    return db.redemptions
      .filter(item => item.customerId === String(customerId) && isActiveRedemption(item, now))
      .reduce((sum, item) => sum + Number(item.pointsUsed || 0), 0);
  });
}

export async function findRedemptionByIdempotency(customerId, idempotencyKey) {
  return withStoreLock(async () => {
    const db = await readDb();
    return db.redemptions.find(item =>
      item.customerId === String(customerId) && item.idempotencyKey === idempotencyKey
    ) || null;
  });
}

export async function createRedemptionReservation(input) {
  return withStoreLock(async () => {
    const db = await readDb();
    const existing = db.redemptions.find(item =>
      item.customerId === String(input.customerId) && item.idempotencyKey === input.idempotencyKey
    );
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        const error = new Error('Cette cle idempotence a deja ete utilisee avec une autre demande.');
        error.code = 'IDEMPOTENCY_CONFLICT';
        throw error;
      }
      return { created: false, reservation: existing };
    }

    const now = Date.now();
    const activeReserved = db.redemptions
      .filter(item => item.customerId === String(input.customerId) && isActiveRedemption(item, now))
      .reduce((sum, item) => sum + Number(item.pointsUsed || 0), 0);

    if (Number(input.pointsUsed) > Number(input.availablePoints) - activeReserved) {
      const error = new Error('Le solde RetroPoints a change. Recharge la page puis reessaie.');
      error.code = 'BALANCE_CHANGED';
      throw error;
    }

    const nowIso = new Date(now).toISOString();
    const reservation = {
      reservationId: crypto.randomUUID(),
      customerId: String(input.customerId),
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      code: input.code,
      discountNodeId: null,
      pointsUsed: Number(input.pointsUsed),
      discountCents: Number(input.discountCents),
      cartTotalCents: Number(input.cartTotalCents),
      status: 'creating',
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: input.expiresAt
    };
    db.redemptions.push(reservation);
    await writeDb(db);
    return { created: true, reservation };
  });
}

export async function attachDiscountToRedemption(reservationId, { discountNodeId }) {
  return withStoreLock(async () => {
    const db = await readDb();
    const item = db.redemptions.find(entry => entry.reservationId === reservationId);
    if (!item) throw new Error('Reservation introuvable.');
    if (['released', 'expired', 'confirmed'].includes(item.status)) return item;
    item.discountNodeId = discountNodeId;
    item.status = 'reserved';
    item.updatedAt = new Date().toISOString();
    await writeDb(db);
    return item;
  });
}

export async function failRedemptionCreation(reservationId, reason) {
  return withStoreLock(async () => {
    const db = await readDb();
    const item = db.redemptions.find(entry => entry.reservationId === reservationId);
    if (!item) return null;
    item.status = 'failed';
    item.failureReason = String(reason || 'creation_failed').slice(0, 200);
    item.updatedAt = new Date().toISOString();
    await writeDb(db);
    return item;
  });
}

export async function findRedemptionByCode(code) {
  return withStoreLock(async () => {
    const db = await readDb();
    return db.redemptions.find(item => item.code === String(code)) || null;
  });
}

export async function releaseRedemption({ reservationId, code, customerId }) {
  return withStoreLock(async () => {
    const db = await readDb();
    const item = db.redemptions.find(entry =>
      entry.customerId === String(customerId) &&
      ((reservationId && entry.reservationId === reservationId) || (code && entry.code === code))
    );
    if (!item) {
      const error = new Error('Reservation RetroPoints introuvable.');
      error.code = 'RESERVATION_NOT_FOUND';
      throw error;
    }
    if (['released', 'expired', 'failed'].includes(item.status)) return item;
    if (item.status === 'confirmed') {
      const error = new Error('Cette reduction a deja ete confirmee par une commande.');
      error.code = 'RESERVATION_CONFIRMED';
      throw error;
    }
    item.status = 'released';
    item.releasedAt = new Date().toISOString();
    item.updatedAt = item.releasedAt;
    await writeDb(db);
    return item;
  });
}

export async function confirmRedemption({ code, customerId, orderId }) {
  return withStoreLock(async () => {
    const db = await readDb();
    const item = db.redemptions.find(entry => entry.code === String(code));
    if (!item) return null;
    if (item.customerId !== String(customerId)) throw new Error('Le code RetroPoints appartient a un autre client.');
    if (item.status === 'confirmed') return item;
    if (!['reserved', 'creating'].includes(item.status)) return null;
    item.status = 'confirmed';
    item.orderId = String(orderId);
    item.confirmedAt = new Date().toISOString();
    item.updatedAt = item.confirmedAt;
    await writeDb(db);
    return item;
  });
}

export async function getCustomerRedemptionState(customerId) {
  return withStoreLock(async () => {
    const db = await readDb();
    const now = Date.now();
    const active = db.redemptions
      .filter(item => item.customerId === String(customerId) && isActiveRedemption(item, now))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
    return active;
  });
}

export async function claimProxyReplay({ key, customerId, endpoint, idempotencyKey, requestHash, expiresAt }) {
  return withStoreLock(async () => {
    const db = await readDb();
    const now = Date.now();
    for (const [replayKey, item] of Object.entries(db.proxyReplays)) {
      if (new Date(item.expiresAt).getTime() <= now) delete db.proxyReplays[replayKey];
    }
    const existing = db.proxyReplays[key];
    if (existing) {
      if (existing.customerId !== String(customerId) || existing.requestHash !== requestHash ||
          existing.idempotencyKey !== idempotencyKey) {
        const error = new Error('Rejeu de requete detecte.');
        error.code = 'REPLAY_DETECTED';
        throw error;
      }
      await writeDb(db);
      return { replayed: true };
    }
    db.proxyReplays[key] = {
      customerId: String(customerId),
      endpoint,
      idempotencyKey,
      requestHash,
      expiresAt
    };
    await writeDb(db);
    return { replayed: false };
  });
}

export async function saveInstallation(installation) {
  return withStoreLock(async () => {
    const db = await readDb();
    db.installations[installation.shop] = { ...installation, installedAt: new Date().toISOString() };
    await writeDb(db);
    return db.installations[installation.shop];
  });
}

export async function getInstallation(shop) {
  return withStoreLock(async () => (await readDb()).installations?.[shop] || null);
}

export async function getLatestInstallation() {
  return withStoreLock(async () => {
    const values = Object.values((await readDb()).installations || {});
    return values.sort((a, b) => new Date(b.installedAt || 0) - new Date(a.installedAt || 0))[0] || null;
  });
}

export async function startOrderProcessing(orderId, details = {}) {
  return withStoreLock(async () => {
    const db = await readDb();
    db.processedOrders = db.processedOrders || {};
    const key = String(orderId || '').trim();
    if (!key) throw new Error('Order id missing.');
    const current = db.processedOrders[key];
    if (current && current.status !== 'failed') return { started: false, record: current };
    const record = { ...details, status: 'processing', startedAt: new Date().toISOString() };
    db.processedOrders[key] = record;
    await writeDb(db);
    return { started: true, record };
  });
}

export async function finishOrderProcessing(orderId, details = {}) {
  return withStoreLock(async () => {
    const db = await readDb();
    db.processedOrders = db.processedOrders || {};
    const key = String(orderId || '').trim();
    db.processedOrders[key] = {
      ...(db.processedOrders[key] || {}),
      ...details,
      status: 'processed',
      processedAt: new Date().toISOString()
    };
    await writeDb(db);
    return db.processedOrders[key];
  });
}

export async function failOrderProcessing(orderId, error) {
  return withStoreLock(async () => {
    const db = await readDb();
    db.processedOrders = db.processedOrders || {};
    const key = String(orderId || '').trim();
    const current = db.processedOrders[key] || {};
    db.processedOrders[key] = {
      ...current,
      status: current.pointsUpdated ? 'manual_review' : 'failed',
      failedAt: new Date().toISOString(),
      error: String(error?.message || error || 'Unknown error').slice(0, 200)
    };
    await writeDb(db);
    return db.processedOrders[key];
  });
}


export async function markOrderPointsUpdated(orderId, details = {}) {
  return withStoreLock(async () => {
    const db = await readDb();
    db.processedOrders = db.processedOrders || {};
    const key = String(orderId || '').trim();
    db.processedOrders[key] = {
      ...(db.processedOrders[key] || {}),
      ...details,
      pointsUpdated: true,
      updatedAt: new Date().toISOString()
    };
    await writeDb(db);
    return db.processedOrders[key];
  });
}




export async function getProcessedOrder(orderId) {
  return withStoreLock(async () => {
    const db = await readDb();
    return db.processedOrders?.[String(orderId)] || null;
  });
}

export async function claimOrderAdjustment(adjustmentId, details = {}) {
  return withStoreLock(async () => {
    const db = await readDb();
    db.adjustments = db.adjustments || {};
    const key = String(adjustmentId);
    if (db.adjustments[key]) return { claimed: false, record: db.adjustments[key] };
    const record = { ...details, status: 'processing', startedAt: new Date().toISOString() };
    db.adjustments[key] = record;
    await writeDb(db);
    return { claimed: true, record };
  });
}

export async function finishOrderAdjustment(adjustmentId, details = {}) {
  return withStoreLock(async () => {
    const db = await readDb();
    db.adjustments = db.adjustments || {};
    const key = String(adjustmentId);
    db.adjustments[key] = {
      ...(db.adjustments[key] || {}),
      ...details,
      status: 'processed',
      processedAt: new Date().toISOString()
    };
    await writeDb(db);
    return db.adjustments[key];
  });
}

