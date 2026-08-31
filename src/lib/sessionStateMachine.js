'use strict';

/**
 * Session lifecycle state machine for the Agentic Commerce Protocol.
 *
 * Happy path:
 *   CREATED -> CONFIRMED -> PAID -> FULFILLING -> COMPLETED
 *
 * Terminal states (no further transitions out, ever): CANCELLED, FAILED, EXPIRED
 *
 * Dependency-free. No I/O, no globals beyond the frozen constant maps below.
 */

const STATES = Object.freeze({
  CREATED: 'CREATED',
  CONFIRMED: 'CONFIRMED',
  PAID: 'PAID',
  FULFILLING: 'FULFILLING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
});

const TERMINAL_STATES = Object.freeze(
  new Set([STATES.COMPLETED, STATES.CANCELLED, STATES.FAILED, STATES.EXPIRED])
);

/**
 * Directed adjacency list of legal transitions, defined explicitly per
 * source state (rather than a global "anything can fail" rule) so the
 * whole graph stays auditable at a glance and each abort/timeout path
 * is a deliberate decision, not an accident of a wildcard rule.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.CREATED]: Object.freeze([STATES.CONFIRMED, STATES.CANCELLED, STATES.EXPIRED]),
  [STATES.CONFIRMED]: Object.freeze([
    STATES.PAID,
    STATES.CANCELLED,
    STATES.EXPIRED,
    STATES.FAILED,
  ]),
  [STATES.PAID]: Object.freeze([STATES.FULFILLING, STATES.FAILED, STATES.CANCELLED]),
  [STATES.FULFILLING]: Object.freeze([STATES.COMPLETED, STATES.FAILED]),
  [STATES.COMPLETED]: Object.freeze([]),
  [STATES.CANCELLED]: Object.freeze([]),
  [STATES.FAILED]: Object.freeze([]),
  [STATES.EXPIRED]: Object.freeze([]),
});

class InvalidStateTransitionError extends Error {
  constructor(fromState, toState) {
    super(
      `INVALID_STATE_TRANSITION: cannot transition session from "${fromState}" to "${toState}"`
    );
    this.name = 'InvalidStateTransitionError';
    this.code = 'INVALID_STATE_TRANSITION';
    this.fromState = fromState;
    this.toState = toState;
  }
}

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {keyof typeof STATES} state
 * @property {string} [created_at] - ISO 8601 timestamp.
 * @property {string} [updated_at] - ISO 8601 timestamp.
 */

/**
 * Pure function: validates and applies a session state transition.
 * Does NOT mutate `currentSession` — returns a brand-new session object.
 *
 * Rejects: unknown states on either side, any transition attempted from
 * an already-terminal state, and any (fromState -> nextState) pair not
 * explicitly present in ALLOWED_TRANSITIONS.
 *
 * @param {Session} currentSession
 * @param {string} nextState
 * @returns {Session} A new session object with the updated state and updated_at.
 * @throws {InvalidStateTransitionError} On any out-of-order or unrecognized transition.
 * @throws {TypeError} If currentSession is missing or malformed.
 */
function transitionSession(currentSession, nextState) {
  if (!currentSession || typeof currentSession.state !== 'string') {
    throw new TypeError('transitionSession: currentSession with a valid "state" is required');
  }

  const fromState = currentSession.state;

  const fromKnown = Object.prototype.hasOwnProperty.call(STATES, fromState);
  const toKnown = typeof nextState === 'string' && Object.prototype.hasOwnProperty.call(STATES, nextState);

  if (!fromKnown || !toKnown) {
    throw new InvalidStateTransitionError(fromState, nextState);
  }

  if (TERMINAL_STATES.has(fromState)) {
    // Terminal states never transition again, even to themselves.
    throw new InvalidStateTransitionError(fromState, nextState);
  }

  const allowedNextStates = ALLOWED_TRANSITIONS[fromState] || [];
  if (!allowedNextStates.includes(nextState)) {
    throw new InvalidStateTransitionError(fromState, nextState);
  }

  return {
    ...currentSession,
    state: nextState,
    updated_at: new Date().toISOString(),
  };
}

module.exports = {
  STATES,
  TERMINAL_STATES,
  ALLOWED_TRANSITIONS,
  InvalidStateTransitionError,
  transitionSession,
};
