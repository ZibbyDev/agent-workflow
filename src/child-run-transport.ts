/**
 * Child-run transport — the seam a HOST fills so the engine can start and
 * follow child runs (`dispatchSubgraph`, `dispatchParticipant`,
 * `listParticipants`, the in-process fast path's begin/finalize).
 *
 * The engine owns the dispatch: validation, the depth cap, the in-process
 * path, budgets and deadlines (fetch-deadline.ts), the poll loop, and how each
 * answer is read (status codes, typed errors, fallbacks). What it does NOT
 * know is WHERE the control plane is, which project the run belongs to, or how
 * to authenticate: the host does. The host registers one transport; the engine
 * opens a connection for one dispatch and sends named calls over it.
 *
 *   transport.open(kind)  → a connection for one dispatch. `kind` is
 *     'in-process' (begin/finalize) or 'remote' (trigger/status/cancel/
 *     participants). Throws when the host cannot reach child runs from here;
 *     the message says what is missing. Opened ONCE per dispatch, so its
 *     address and credentials stay fixed for that dispatch.
 *   connection.send(call) → a fetch-style response ({ ok, status, json(),
 *     text() }). `call.signal` is the engine's deadline for that call and must
 *     reach the underlying request. A transport failure rejects; the engine
 *     reads timeouts and network errors exactly as it reads fetch's.
 *
 * Calls:
 *   begin        { body }                  start a child in this process
 *   finalize     { body }                  record an in-process child's end
 *   trigger      { workflow, body }        start a child as its own run
 *   status       { jobId }                 read a child run's record
 *   cancel       { jobId }                 cancel a child run (best effort)
 *   participants { body }                  list the run's collaboration roster
 *
 * The registry lives on globalThis (same reason as strategy-registry.ts): a
 * process can load this package more than once, and every copy must see the
 * transport the host registered through any of them.
 */

export type ChildRunCallName = 'begin' | 'finalize' | 'trigger' | 'status' | 'cancel' | 'participants';
export type ChildRunConnectionKind = 'in-process' | 'remote';

export interface ChildRunCall {
  call: ChildRunCallName;
  workflow?: string;
  jobId?: string;
  body?: any;
  signal: AbortSignal;
}

export interface ChildRunResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}

export interface ChildRunConnection {
  send(call: ChildRunCall): Promise<ChildRunResponse>;
}

export interface ChildRunTransport {
  open(kind: ChildRunConnectionKind): ChildRunConnection;
}

const TRANSPORT_KEY = Symbol.for('agent-workflow.childRunTransport');
const slot = globalThis as unknown as Record<symbol, ChildRunTransport | null | undefined>;

/** Register the host's child-run transport. `null` removes it. Re-registering replaces it. */
export function registerChildRunTransport(transport: ChildRunTransport | null): void {
  if (transport !== null && (!transport || typeof transport.open !== 'function')) {
    throw new Error('registerChildRunTransport expects { open(kind) => { send(call) } }');
  }
  slot[TRANSPORT_KEY] = transport;
}

export function getChildRunTransport(): ChildRunTransport | null {
  return slot[TRANSPORT_KEY] || null;
}

export const NO_CHILD_RUN_TRANSPORT = 'the host running this workflow provides no way to start child runs (registerChildRunTransport)';

/** The registered transport, or a typed error naming what is missing. */
export function requireChildRunTransport(what: string): ChildRunTransport {
  const transport = getChildRunTransport();
  if (transport) return transport;
  const e: any = new Error(`${what}: ${NO_CHILD_RUN_TRANSPORT}`);
  e.code = 'CHILD_RUN_TRANSPORT_MISSING';
  throw e;
}
