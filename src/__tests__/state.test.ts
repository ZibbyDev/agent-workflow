/**
 * Tests for WorkflowState
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowState } from '../state.js';

describe('WorkflowState', () => {
  let state;

  beforeEach(() => {
    state = new WorkflowState();
  });

  describe('constructor', () => {
    it('should initialize with default state', () => {
      expect(state.get('messages')).toEqual([]);
      expect(state.get('errors')).toEqual([]);
      expect(state.get('artifacts')).toEqual({});
      expect(state.get('metadata')).toEqual({});
    });

    it('should merge initial state with defaults', () => {
      const customState = new WorkflowState({
        customField: 'value',
        messages: ['initial']
      });

      expect(customState.get('customField')).toBe('value');
      expect(customState.get('messages')).toEqual(['initial']);
      expect(customState.get('errors')).toEqual([]);
    });
  });

  describe('get', () => {
    it('should retrieve a value by key', () => {
      state.set('testKey', 'testValue');
      expect(state.get('testKey')).toBe('testValue');
    });

    it('should return undefined for non-existent keys', () => {
      expect(state.get('nonExistent')).toBeUndefined();
    });
  });

  describe('set', () => {
    it('should set a new key-value pair', () => {
      state.set('newKey', 'newValue');
      expect(state.get('newKey')).toBe('newValue');
    });

    it('should overwrite existing values', () => {
      state.set('key', 'value1');
      state.set('key', 'value2');
      expect(state.get('key')).toBe('value2');
    });

    it('should preserve history on set', () => {
      state.set('key', 'value1');
      state.set('key', 'value2');

      state.rollback();
      expect(state.get('key')).toBe('value1');
    });
  });

  describe('update', () => {
    it('should merge multiple key-value pairs', () => {
      state.update({
        key1: 'value1',
        key2: 'value2'
      });

      expect(state.get('key1')).toBe('value1');
      expect(state.get('key2')).toBe('value2');
    });

    it('should preserve existing keys not in update', () => {
      state.set('existingKey', 'existingValue');
      state.update({ newKey: 'newValue' });

      expect(state.get('existingKey')).toBe('existingValue');
      expect(state.get('newKey')).toBe('newValue');
    });

    it('should overwrite existing keys in update', () => {
      state.set('key', 'oldValue');
      state.update({ key: 'newValue' });

      expect(state.get('key')).toBe('newValue');
    });

    it('should preserve history on update', () => {
      state.set('key', 'value1');
      state.update({ key: 'value2' });

      state.rollback();
      expect(state.get('key')).toBe('value1');
    });
  });

  describe('append', () => {
    it('should append to an existing array', () => {
      state.set('list', ['item1']);
      state.append('list', 'item2');

      expect(state.get('list')).toEqual(['item1', 'item2']);
    });

    it('should create array if key does not exist', () => {
      state.append('newList', 'item1');

      expect(state.get('newList')).toEqual(['item1']);
    });

    it('should convert non-array to array and append', () => {
      state.set('notArray', 'value');
      state.append('notArray', 'newItem');

      expect(state.get('notArray')).toEqual(['newItem']);
    });

    it('should save history on append', () => {
      state.set('list', ['item1']);
      expect(state._history.length).toBe(1);

      state.append('list', 'item2');
      expect(state._history.length).toBe(2);
    });
  });

  describe('getAll', () => {
    it('should return a copy of entire state', () => {
      state.set('key1', 'value1');
      state.set('key2', 'value2');

      const allState = state.getAll();

      expect(allState).toHaveProperty('key1', 'value1');
      expect(allState).toHaveProperty('key2', 'value2');
      expect(allState).toHaveProperty('messages');
      expect(allState).toHaveProperty('errors');
    });

    it('should return a copy, not the original state', () => {
      const allState = state.getAll();
      allState.newKey = 'newValue';

      expect(state.get('newKey')).toBeUndefined();
    });
  });

  describe('rollback', () => {
    it('should restore previous state', () => {
      state.set('key', 'value1');
      state.set('key', 'value2');
      state.set('key', 'value3');

      state.rollback();
      expect(state.get('key')).toBe('value2');

      state.rollback();
      expect(state.get('key')).toBe('value1');
    });

    it('should handle rollback with no history gracefully', () => {
      state.rollback();

      expect(state.get('messages')).toEqual([]);
    });

    it('should allow multiple rollbacks', () => {
      state.set('key', 'v1');
      state.set('key', 'v2');
      state.set('key', 'v3');

      state.rollback();
      state.rollback();

      expect(state.get('key')).toBe('v1');
    });
  });

  describe('history tracking', () => {
    it('should track history for set operations', () => {
      state.set('a', 1);
      state.set('b', 2);
      state.set('c', 3);

      state.rollback();
      expect(state.get('c')).toBeUndefined();
      expect(state.get('b')).toBe(2);
      expect(state.get('a')).toBe(1);
    });

    it('should track history for update operations', () => {
      state.update({ a: 1 });
      state.update({ b: 2 });

      state.rollback();
      expect(state.get('b')).toBeUndefined();
      expect(state.get('a')).toBe(1);
    });

    it('should track history for primitive operations', () => {
      state.set('counter', 0);
      state.set('counter', 1);
      state.set('counter', 2);

      state.rollback();
      expect(state.get('counter')).toBe(1);

      state.rollback();
      expect(state.get('counter')).toBe(0);
    });
  });

  describe('complex scenarios', () => {
    it('should handle mixed operations with rollbacks', () => {
      state.set('counter', 0);
      state.update({ counter: 1, name: 'test' });
      state.set('status', 'pending');
      state.set('status', 'complete');

      state.rollback();
      expect(state.get('status')).toBe('pending');

      state.rollback();
      expect(state.get('status')).toBeUndefined();
      expect(state.get('counter')).toBe(1);
      expect(state.get('name')).toBe('test');
    });

    it('should preserve state immutability between rollbacks', () => {
      state.set('obj', { nested: 'value' });
      const snapshot1 = state.getAll();

      state.update({ obj: { nested: 'modified' } });
      const snapshot2 = state.getAll();

      expect(snapshot1.obj.nested).toBe('value');
      expect(snapshot2.obj.nested).toBe('modified');

      state.rollback();
      expect(state.get('obj').nested).toBe('value');
    });

    it('should work with multiple sequential sets', () => {
      state.set('version', 1);
      state.set('version', 2);
      state.set('version', 3);

      expect(state.get('version')).toBe(3);

      state.rollback();
      expect(state.get('version')).toBe(2);

      state.rollback();
      expect(state.get('version')).toBe(1);
    });
  });

  describe('prototype pollution protection', () => {
    it('should reject __proto__ in set()', () => {
      expect(() => state.set('__proto__', { polluted: true })).toThrow('Invalid state key');
    });

    it('should reject constructor in set()', () => {
      expect(() => state.set('constructor', () => {})).toThrow('Invalid state key');
    });

    it('should reject prototype in set()', () => {
      expect(() => state.set('prototype', {})).toThrow('Invalid state key');
    });

    it('should reject __proto__ in update() via JSON.parse payload', () => {
      const malicious = JSON.parse('{"__proto__": {"polluted": true}}');
      expect(() => state.update(malicious)).toThrow('Invalid state key');
    });

    it('should reject constructor in update()', () => {
      const malicious = JSON.parse('{"constructor": "evil"}');
      expect(() => state.update(malicious)).toThrow('Invalid state key');
    });

    it('should reject __proto__ in append()', () => {
      expect(() => state.append('__proto__', 'value')).toThrow('Invalid state key');
    });

    it('should not pollute Object.prototype', () => {
      const before = Object.prototype.polluted;

      try {
        state.set('__proto__', { polluted: true });
      } catch { /* expected */ }

      expect(Object.prototype.polluted).toBe(before);
    });

    it('should allow legitimate keys that are not dangerous', () => {
      state.set('proto', 'safe');
      state.set('_constructor', 'safe');
      state.set('__private__', 'safe');

      expect(state.get('proto')).toBe('safe');
      expect(state.get('_constructor')).toBe('safe');
      expect(state.get('__private__')).toBe('safe');
    });
  });

  describe('null-prototype internal state', () => {
    it('should not have inherited Object properties', () => {
      expect(state.get('toString')).toBeUndefined();
      expect(state.get('hasOwnProperty')).toBeUndefined();
      expect(state.get('valueOf')).toBeUndefined();
    });

    it('getAll should return a plain object copy', () => {
      state.set('key', 'value');
      const all = state.getAll();

      expect(all.key).toBe('value');
      expect(typeof all.toString).toBe('function');
    });
  });
});
