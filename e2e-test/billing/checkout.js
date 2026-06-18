'use strict';

/**
 * Checkout flow (e2e intensive-tier cross-file test).
 * Calls into pricing.js INCORRECTLY so the reviewer must read both files
 * (the deepen/clone path) to catch it.
 */

const { monthlyChargeCents } = require('./pricing');

/**
 * CROSS-FILE BUG: monthlyChargeCents(seats, discountPercent) expects the
 * discount as its SECOND argument. Here we pass the discount as the FIRST
 * argument and the seat count as the SECOND — the arguments are swapped.
 * So `checkout({ seats: 10, discountPercent: 20 })` computes
 * monthlyChargeCents(20, 10) = 20 seats minus a 10c "discount", which is both
 * the wrong seat count AND mis-wired. This is only visible by reading the
 * pricing.js signature — it is not apparent from checkout.js alone.
 */
function checkout({ seats, discountPercent = 0 }) {
  const cents = monthlyChargeCents(discountPercent, seats); // BUG: args swapped
  return { amountCents: cents, currency: 'usd' };
}

module.exports = { checkout };
