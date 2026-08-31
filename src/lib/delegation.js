'use strict';

/**
 * Agent Circle — Delegation Engine
 * ---------------------------------
 * Pure, dependency-free module that decides whether an agent-initiated
 * transaction may execute autonomously, or must be routed to a human
 * for an explicit ApprovalMandate.
 *
 * Design contract:
 *  - 'full'    delegation: autonomous execution is allowed IFF the
 *              transaction amount is within the granted cap.
 *  - 'partial' delegation: autonomous execution is NEVER allowed.
 *              A human ApprovalMandate is strictly required, regardless
 *              of how small the transaction is or how large the cap is.
 *
 * The function is pure: no I/O, no mutation, no randomness — same
 * inputs always produce the same output.
 */

const DELEGATION_MODES = Object.freeze({
  FULL: 'full',
  PARTIAL: 'partial',
});

/**
 * @typedef {Object} DelegationDecision
 * @property {boolean} allowed - Whether the agent may execute the transaction autonomously right now.
 * @property {boolean} requiresApprovalMandate - Whether a human ApprovalMandate must be obtained before execution.
 * @property {string} reason - Human-readable explanation of the decision, for audit logging.
 */

/**
 * Evaluate whether an agent transaction can proceed under a given
 * delegation mode.
 *
 * @param {'full'|'partial'} delegationMode
 * @param {number} transactionPaise - Transaction amount in paise (integer, >= 0).
 * @param {number} capPaise - Autonomous spend cap in paise (integer, >= 0).
 * @returns {DelegationDecision}
 * @throws {TypeError} if amounts are not valid non-negative finite numbers.
 * @throws {RangeError} if delegationMode is not a recognized mode.
 */
function evaluateDelegation(delegationMode, transactionPaise, capPaise) {
  assertNonNegativeFiniteNumber(transactionPaise, 'transactionPaise');
  assertNonNegativeFiniteNumber(capPaise, 'capPaise');

  switch (delegationMode) {
    case DELEGATION_MODES.FULL:
      return evaluateFullDelegation(transactionPaise, capPaise);

    case DELEGATION_MODES.PARTIAL:
      // Strict rule: partial delegation NEVER self-executes. The amount
      // and the cap are irrelevant to this outcome — a human must issue
      // an ApprovalMandate before the transaction can proceed.
      return {
        allowed: false,
        requiresApprovalMandate: true,
        reason:
          'Partial delegation mode requires an explicit human ApprovalMandate ' +
          'before execution, regardless of transaction amount or cap.',
      };

    default:
      throw new RangeError(
        `Unknown delegationMode "${String(delegationMode)}". Expected "full" or "partial".`
      );
  }
}

function evaluateFullDelegation(transactionPaise, capPaise) {
  const withinCap = transactionPaise <= capPaise;

  return {
    allowed: withinCap,
    requiresApprovalMandate: !withinCap,
    reason: withinCap
      ? `Transaction of ${transactionPaise}p is within the full-delegation cap of ${capPaise}p; autonomous execution allowed.`
      : `Transaction of ${transactionPaise}p exceeds the full-delegation cap of ${capPaise}p; a human ApprovalMandate is required.`,
  };
}

function assertNonNegativeFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number (received: ${String(value)})`);
  }
}

module.exports = {
  evaluateDelegation,
  DELEGATION_MODES,
};
