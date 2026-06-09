import { config } from './config.js';

export function moneyFromCents(cents) {
  return (Math.max(0, Number(cents) || 0) / 100).toFixed(2);
}

export function calculatePointsFromCents(cents) {
  return Math.floor((Math.max(0, Number(cents) || 0) / 100) * config.pointsPerEuro);
}

export function calculateRedeemable({ availablePoints, cartTotalCents }) {
  const pointsByStep = Math.floor(availablePoints / config.redeemStepPoints) * config.redeemStepPoints;
  const maxPointsForCart = Math.floor((cartTotalCents / 100) * config.pointsPerEuroDiscount / config.redeemStepPoints) * config.redeemStepPoints;
  const pointsUsed = Math.min(pointsByStep, maxPointsForCart);
  const discountCents = Math.floor((pointsUsed / config.pointsPerEuroDiscount) * 100);

  return {
    canRedeem: pointsUsed >= config.minRedeemPoints && discountCents > 0,
    pointsUsed,
    discountCents
  };
}

export function tierFromLifetimePoints(lifetimePoints) {
  if (lifetimePoints >= 3000) return 'Gold';
  if (lifetimePoints >= 1000) return 'Silver';
  return 'Bronze';
}
