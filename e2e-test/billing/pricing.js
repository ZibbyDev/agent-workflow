'use strict';

/**
 * Pricing helpers (e2e intensive-tier critical-path test).
 * Path intentionally under billing/ so triage routes this to the intensive tier.
 */

// Per-seat monthly rate in CENTS.
const PER_SEAT_CENTS = 1500; // $15.00

/**
 * Compute the monthly charge for a subscription.
 *
 * SUBTLE BUG: `discountPercent` is applied as a raw subtraction of the percent
 * value from the cents total (e.g. 10 cents off), instead of scaling the total
 * by (1 - discountPercent/100). A 10% discount on a $150 (15000c) bill should
 * be 13500c, but this returns 15000 - 10 = 14990c. The units are wrong:
 * a *percent* is being subtracted as if it were *cents*.
 *
 * Returns the total in cents.
 */
function monthlyChargeCents(seats, discountPercent = 0) {
  const gross = seats * PER_SEAT_CENTS;
  return gross - discountPercent; // BUG: should be Math.round(gross * (1 - discountPercent / 100))
}

module.exports = { PER_SEAT_CENTS, monthlyChargeCents };
