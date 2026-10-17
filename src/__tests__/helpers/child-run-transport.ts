/**
 * A fake host for the engine's child-run seam (child-run-transport.ts): it
 * addresses every call to a fixed example control plane over the global
 * `fetch`, so a test stubs `fetch` and asserts on the requests the engine's
 * calls became. A real host supplies its own addressing and credentials.
 */
import { registerChildRunTransport } from '../../child-run-transport.js';

export const TEST_HOST = {
  base: 'https://api.example.com',
  project: 'proj-1',
  token: 'tok-abc',
};

export function installTestChildRunTransport(over: Partial<typeof TEST_HOST> & { inProcessBase?: string } = {}) {
  const host = { ...TEST_HOST, ...over };
  const auth = `Bearer ${host.token}`;
  const json = { 'Content-Type': 'application/json', Authorization: auth };
  const trigger = (slug: string) => `${host.base}/projects/${encodeURIComponent(host.project)}/workflows/${encodeURIComponent(slug)}/trigger`;
  const status = (jobId: string) => `${host.base}/executions/${encodeURIComponent(jobId)}`;
  const inProcessBase = over.inProcessBase || host.base;
  const transport = {
    open(kind: string) {
      return {
        send({ call, workflow, jobId, body, signal }: any) {
          if (kind === 'in-process') {
            return fetch(`${inProcessBase}/internal/subgraph/${call}`, { method: 'POST', headers: json, body: JSON.stringify(body), signal });
          }
          switch (call) {
            case 'trigger':
              return fetch(trigger(body?.participantBindingId ? 'participant' : workflow), { method: 'POST', headers: json, body: JSON.stringify(body), signal });
            case 'status':
              return fetch(status(jobId), { headers: { Authorization: auth }, signal });
            case 'cancel':
              return fetch(`${status(jobId)}/cancel`, { method: 'POST', headers: { Authorization: auth }, signal });
            case 'participants':
              return fetch(trigger('participant'), { method: 'POST', headers: json, body: JSON.stringify({ participantOperation: 'list', ...body }), signal });
            default:
              throw new Error(`unknown call ${call}`);
          }
        },
      };
    },
  };
  registerChildRunTransport(transport as any);
  return transport;
}

export function removeTestChildRunTransport() {
  registerChildRunTransport(null);
}
