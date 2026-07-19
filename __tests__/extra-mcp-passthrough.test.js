import { describe, it, expect } from 'vitest';
import { registerStrategy, invokeAgent } from '../src/strategy-registry.js';

describe('invokeAgent passes extraMcpServers to the strategy', () => {
  it('row-data extraMcpServers reaches finalOptions', async () => {
    let seen = null;
    registerStrategy({
      name: 'capture', getName: () => 'capture',
      canHandle: () => true,
      invoke: async (_p, opts) => { seen = opts.extraMcpServers; return 'ok'; },
    });
    const extra = [{ serverName: 'custom-mcp-X', def: { transport: 'http', url: 'https://m/rpc' } }];
    await invokeAgent('hi', { state: { agentType: 'capture', extraMcpServers: extra } }, {});
    expect(seen).toEqual(extra);
  });
  it('absent → empty array (backward compatible)', async () => {
    let seen = 'unset';
    registerStrategy({ name: 'cap2', getName: () => 'cap2', canHandle: () => true, invoke: async (_p, o) => { seen = o.extraMcpServers; return 'ok'; } });
    await invokeAgent('hi', { state: { agentType: 'cap2' } }, {});
    expect(seen).toEqual([]);
  });
});
