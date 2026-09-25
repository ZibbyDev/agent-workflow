/**
 * "THIS MEMBER IS NOT SET UP" — a dispatch refusal that is a FACT about the
 * member, not a failure of the run that asked for it.
 *
 * The platform refuses to start an agent that is not set up — a model node with
 * no model of its own, no key for a vendor it runs on, or a declared N-of-M
 * roster with too few members set up — before any row, container or model call
 * exists, and says so on the refusal: `notSetUp: true` next to its own code and
 * sentence. The platform owns that judgement (which codes mean "not set up"),
 * so this module reads the flag and never a list of codes.
 *
 * WHY IT IS TYPED. A step the template DECLARES optional (a dispatch node with
 * `minimumReadyChildren: 0`, or a seat in an N-of-M roster) reads this as
 * "skip, and say why", while every other dispatch failure stays a failure. Read
 * as a generic dispatch error it cost a parent one of its attempts and put a
 * platform error where a plain "Council is not set up" belonged.
 *
 * Both dispatch paths (in-process begin and the HTTP trigger) build the error
 * here, so the two cannot describe the same refusal differently.
 */

export const SUBGRAPH_NOT_SET_UP = 'SUBGRAPH_NOT_SET_UP';

/** Does this refusal body say the member is not set up? */
export function refusalSaysNotSetUp(body: any): boolean {
  return !!body && typeof body === 'object' && body.notSetUp === true;
}

/**
 * The typed error for a member the platform said is not set up. The message is
 * the platform's own sentence, prefixed with the member's name, never
 * rephrased (its words name the nodes / members and what each lacks).
 */
export function notSetUpError(workflowName: string, body: any, status?: number) {
  const said = String(body?.error || body?.message || '').trim();
  const e: any = new Error(`'${workflowName}' is not set up: ${said || 'the platform refused to start it'}`);
  e.code = SUBGRAPH_NOT_SET_UP;
  e.notSetUp = true;
  e.subgraph = workflowName;
  // The platform's sentence alone, for a parent that states the fact in its
  // own words ("Council not set up: …") without repeating the member's name.
  e.detail = said;
  if (typeof status === 'number') e.status = status;
  if (typeof body?.code === 'string' && body.code) e.platformCode = body.code;
  if (Array.isArray(body?.nodes)) e.nodes = body.nodes.filter((n: unknown) => typeof n === 'string');
  if (Array.isArray(body?.members)) e.members = body.members;
  // A member that is not set up stays not set up until a person sets it up —
  // never worth another attempt.
  e.retryable = false;
  return e;
}

/** Is this error a dispatch refused because the member is not set up? */
export function isNotSetUp(err: any): boolean {
  return !!err && typeof err === 'object' && (err.notSetUp === true || err.code === SUBGRAPH_NOT_SET_UP);
}
