/**
 * Immutable-snapshot state container for workflow graph execution.
 * Similar in spirit to LangGraph's state annotation.
 */

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeKey(key) {
  if (UNSAFE_KEYS.has(key)) {
    throw new Error(`Invalid state key: "${key}"`);
  }
}

export class WorkflowState {
  constructor(initialState = {}) {
    this._state = Object.create(null);
    Object.assign(this._state, {
      messages: [],
      errors: [],
      artifacts: {},
      metadata: {},
      ...initialState
    });
    this._history = [];
  }

  get(key) {
    return this._state[key];
  }

  set(key, value) {
    assertSafeKey(key);
    this._history.push({ ...this._state });
    this._state[key] = value;
  }

  update(updates) {
    const keys = Object.getOwnPropertyNames(updates);
    for (const key of keys) assertSafeKey(key);
    this._history.push({ ...this._state });
    for (const key of keys) this._state[key] = updates[key];
  }

  append(key, value) {
    assertSafeKey(key);
    this._history.push({ ...this._state });
    if (!Array.isArray(this._state[key])) this._state[key] = [];
    this._state[key].push(value);
  }

  getAll() {
    return { ...this._state };
  }

  rollback() {
    if (this._history.length > 0) {
      this._state = this._history.pop();
    }
  }
}
