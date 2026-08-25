/**
 * Node — one agent execution step in a workflow graph.
 */

import Handlebars from 'handlebars';
import { OutputParser } from './output-parser.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from './logger.js';
import { timeline } from './timeline.js';
import { SESSION_INFO_FILE } from './constants.js';
import { createAttemptBudget, type AttemptDecision } from './failure-class.js';

/**
 * ONE place decides what a retry PRINTS and how long it waits — both of the
 * loops below call it, so the two paths can never describe the same policy
 * differently. Returns false when the budget is spent (the loop then returns
 * the last failure, exactly as it always did).
 *
 * The wording is deliberate on two counts:
 *   • it says WHICH CLASS the failure was judged to be, because a wrong verdict
 *     is the only way this feature can cost money and the log line is where a
 *     human catches it;
 *   • it says the workspace survives. On a transient retry the node re-runs in
 *     the SAME container, so every file the agent already wrote is still there —
 *     which is the difference between "redo the work" and "lose the work", and
 *     nobody reading the log should have to guess which one happened.
 */
async function awaitRetry(
  nodeName: string,
  decision: AttemptDecision,
  failure: unknown,
  aborted: () => boolean,
): Promise<boolean> {
  if (!decision.retry) return false;
  // A stopped run never retries, however the failure was classified.
  if (aborted()) {
    logger.info(`[workflow] node '${nodeName}': run aborted — not retrying`);
    return false;
  }
  const why = (failure as any)?.message ?? String(failure ?? '');
  if (decision.paidBy === 'transient') {
    logger.warn(
      `[workflow] node '${nodeName}': TRANSIENT provider failure — ${why}. `
      + `Retrying in ${Math.round(decision.delayMs / 1000)}s `
      + `(transient retry ${decision.index}/${decision.of}; the workspace is untouched, `
      + 'so files this node already wrote survive into the retry).',
    );
  } else {
    logger.info(
      `[workflow] node '${nodeName}' failed (${decision.failureClass}), `
      + `retrying (${decision.index}/${decision.of})…`,
    );
  }
  if (decision.delayMs > 0) {
    await new Promise((r) => setTimeout(r, decision.delayMs));
    if (aborted()) {
      logger.info(`[workflow] node '${nodeName}': run aborted during backoff — not retrying`);
      return false;
    }
  }
  return true;
}

// Common Handlebars helpers for declarative string prompts (idempotent, shared
// across every prompt-render path since Handlebars is a singleton):
//   {{inc @index}}        1-based numbering (@index is 0-based)
//   {{json someObject}}   pretty-printed JSON (e.g. env config)
//   {{#if (eq a b)}}      equality test
if (!Handlebars.helpers.inc) Handlebars.registerHelper('inc', (v) => Number(v) + 1);
if (!Handlebars.helpers.json) Handlebars.registerHelper('json', (v) => JSON.stringify(v, null, 2));
if (!Handlebars.helpers.eq) Handlebars.registerHelper('eq', (a, b) => a === b);

export class Node {
  _compiledPrompt?: any;
  config?: any;
  customExecute?: any;
  isZodSchema?: any;
  name?: any;
  onComplete?: any;
  outputSchema?: any;
  parser?: any;
  prompt?: any;
  retries?: any;
  constructor(config) {
    this.config = config;
    this.name = config.name;
    this.prompt = config.prompt;
    this.outputSchema = config.outputSchema;

    if (!this.outputSchema && !config._isCustomCode && !config._isRouter) {
      throw new Error(
        `Node '${this.name}' must define outputSchema (Zod schema). ` +
        `This defines the contract for what the node returns to state.`
      );
    }

    this.isZodSchema = this.outputSchema && typeof this.outputSchema._def !== 'undefined';
    this.parser = config.outputSchema && !this.isZodSchema ? new OutputParser(config.outputSchema) : null;
    this.retries = config.retries || 0;
    this.onComplete = config.onComplete;
    this.customExecute = config.execute;
  }

  async execute(context, state) {
    // Router passthrough. A router node does NO work of its own — it exists
    // so the branch point is a first-class, named step in the graph; the
    // actual routing decision lives on its conditional out-edges
    // (`addConditionalEdges(name, routeFn)`), which the graph engine
    // evaluates AFTER this node "completes". Created via
    // `graph.addNode(name, { description })` — a config with no execute,
    // no prompt and no outputSchema (graph.addNode marks it `_isRouter`).
    if (this.config._isRouter) {
      logger.debug(`[workflow] node '${this.name}': router passthrough (routing happens on its conditional edges)`);
      return { success: true, output: {}, raw: null };
    }

    const getAllState = () =>
      state && typeof state.getAll === 'function' ? state.getAll() : context;

    const _getState = (key) =>
      state && typeof state.get === 'function' ? state.get(key) : context?.[key];

    // The engine publishes its abort signal on state as `_signal` (graph.ts).
    // Read it through the same accessor every other state read uses, so a node
    // executed without a WorkflowState (unit tests, `zibby test`) is simply
    // never "aborted" rather than throwing.
    const _aborted = () => _getState('_signal')?.aborted === true;

    if (typeof this.customExecute === 'function') {
      logger.debug(`[workflow] node '${this.name}': custom execute (skipping LLM)`);
      // THE retry loop for custom-code nodes — same shape, same semantics as
      // the LLM path's loop below: `retries: N` means N RETRIES, i.e. N+1
      // total attempts (`attempt <= this.retries`).
      //
      // This loop used to not exist: the custom path returned on the FIRST
      // failure, and `retries` was honoured only by a second gate in
      // graph.ts — which never re-executed anything (it `continue`d the
      // scheduler loop, popping the NEXT ready node) and swallowed the
      // failure into `success: true`. So `retries` was a silent no-op for
      // every custom-code node, and — because graph.addNode() compiles a
      // `{ workflow: 'child' }` sub-graph node into a custom-execute node —
      // for every sub-graph dispatch too, which is exactly the case
      // addNode()'s own comment advertises as "LangGraph-style RetryPolicy
      // for free". One layer now, and it is this one.
      //
      // Both failure SHAPES retry, because both are what the deleted gate
      // reacted to (`result.success === false`): a throw, and a returned
      // `{ success: false }`.
      //
      // ⚠️ `success` IS THEREFORE RESERVED on a custom-code node's return, and
      // that collides with the very natural urge to ALSO use it as a domain
      // fact ("did this node produce a change?"). When it does, the node dies
      // on a perfectly good outcome and — because the old fallback message here
      // was the bare literal `'Node execution failed'` — it dies with no
      // diagnostic at all: no state written, no downstream node run, nothing to
      // read but the node's name. That shipped in `developer`'s `fix_code`,
      // whose "the model correctly changed nothing" branch returned
      // `{ success: false }` and killed the run (verified on a live box,
      // 2026-08-25). So the fallback below NAMES the collision instead of
      // describing nothing: the next node that trips it says why in its own
      // error line. (The LLM path has no such trap — a structured output
      // carrying `success:false` is returned as OUTPUT, never read as failure.)
      // ONE loop, TWO budgets — see createAttemptBudget. `retries` keeps its
      // exact old meaning (N retries on ANY failure, no delay); a failure
      // POSITIVELY identified as transient may buy extra attempts on top, with
      // backoff. `retries: 0` (the default) therefore still means "no retry on
      // a bug" and now also means "a dead stream does not destroy the work".
      const budget = createAttemptBudget(this.retries);
      let lastFailure: any = null;
      /**
       * The THROWN error, kept beside the flattened failure result. It carries
       * the strategy's structured provider fields (`providerErrorKind`, …) and
       * the classifier reads them in preference to sniffing text — so this must
       * not be flattened away. Null when the node RETURNED `{success:false}`
       * instead of throwing, in which case the error string is all there is.
       */
      let lastThrown: unknown = null;
      for (;;) {
        try {
          const result = await this.customExecute(context);

          if (typeof result === 'object' && result !== null && result.success === false) {
            lastThrown = null;
            lastFailure = {
              success: false,
              error: result.error
                || `node '${this.name}' returned { success: false } with no \`error\` field. On a custom-code `
                  + 'node `success` is RESERVED: the engine reads it as "this node failed" and stops the graph. '
                  + 'If it was meant as a DOMAIN fact (no diff to commit, a PR deliberately skipped), give that '
                  + 'fact its own field name and return the outcome — or set `error` to say what actually failed.',
              raw: result.raw || null,
            };
          } else if (this.isZodSchema) {
            logger.debug(`[workflow] node '${this.name}': validating output schema`);
            const validated = this.outputSchema.parse(result);
            return { success: true, output: validated, raw: null };
          } else {
            return { success: true, output: result, raw: null };
          }
        } catch (error) {
          logger.error(`[workflow] node '${this.name}' failed: ${error.message}`);
          if (error.name === 'ZodError') {
            // Zod v3+ exposes .issues; older majors used .errors. Defensive
            // fallback so a downstream user pinned to an older Zod still
            // gets a real log line, not `undefined`.
            logger.error(`Schema errors: ${JSON.stringify(error.issues || error.errors, null, 2)}`);
          }
          lastThrown = error;
          lastFailure = { success: false, error: error.message, raw: null };
        }
        // A returned `{success:false}` is classified off its `error` STRING; a
        // throw is classified off the Error itself (which carries the strategy's
        // structured provider fields). Either way ONE call, ONE decider.
        const evidence = lastThrown ?? lastFailure?.error;
        const decision = budget.next(evidence);
        if (!await awaitRetry(this.name, decision, evidence, _aborted)) break;
      }
      // How many attempts this node ACTUALLY made — the run's error line quotes
      // it, and `retries + 1` stopped being that number the moment a transient
      // failure could buy extra ones (see graph.ts).
      if (lastFailure) lastFailure.attempts = budget.attemptsMade;
      return lastFailure;
    }

    // Prompt sources (both supported):
    //   - function: `prompt: (state) => '…'` → called with state (dynamic, code).
    //   - string:   `prompt: '…{{testSpec}}…'` → a declarative Handlebars
    //     template, rendered here with the live state (editable in the UI, and
    //     overridable via nodeConfigOverrides). Strings without '{{' pass through.
    let prompt;
    if (typeof this.prompt === 'function') {
      prompt = this.prompt(getAllState());
    } else if (typeof this.prompt === 'string' && this.prompt.includes('{{')) {
      if (!this._compiledPrompt) this._compiledPrompt = Handlebars.compile(this.prompt, { noEscape: true });
      prompt = this._compiledPrompt(getAllState());
    } else {
      prompt = this.prompt;
    }

    const skillHints = _getState('_skillHints');
    if (skillHints) prompt = `${skillHints}\n\n${prompt}`;

    const allState = getAllState();
    const cwd = allState.cwd || process.cwd();
    const sessionPath = allState.sessionPath;

    try {
      if (sessionPath) {
        const perSessionInfoPath = join(sessionPath, SESSION_INFO_FILE);
        if (existsSync(perSessionInfoPath)) {
          const info = JSON.parse(readFileSync(perSessionInfoPath, 'utf-8'));
          info.currentNode = this.name;
          writeFileSync(perSessionInfoPath, JSON.stringify(info, null, 2), 'utf-8');
        }
        const sharedInfoPath = join(sessionPath, '..', SESSION_INFO_FILE);
        if (existsSync(sharedInfoPath)) {
          try {
            const info = JSON.parse(readFileSync(sharedInfoPath, 'utf-8'));
            info.currentNode = this.name;
            writeFileSync(sharedInfoPath, JSON.stringify(info, null, 2), 'utf-8');
          } catch { /* non-critical */ }
        }
      }
    } catch (err) {
      logger.debug(`[workflow] could not update session info: ${err.message}`);
    }

    // Same ONE budget as the custom-execute path above (createAttemptBudget).
    const llmBudget = createAttemptBudget(this.retries);
    let lastError = null;
    for (;;) {
      try {
        logger.debug(`[workflow] node '${this.name}' attempt ${llmBudget.attemptsMade - 1}`);

        const zibbyConfig = getAllState().config || {};
        // Per-node agent override. Precedence (highest first):
        //   node.config.agent  (graph-level: graph.addNode(n, { ..., agent: 'claude' }))
        //   config.agents[name]  (project-level mapping in .zibby.config.js)
        //   state.agentType  (project default selected by getAgentStrategy)
        const perNodeAgentMap = zibbyConfig.agents || {};
        const preferredAgent =
          this.config.agent ?? perNodeAgentMap[this.name] ?? null;
        const agentContext: any = { state: getAllState() };
        if (preferredAgent) agentContext.preferredAgent = preferredAgent;

        const agentOptions: any = {
          workspace: cwd,
          schema: this.isZodSchema ? this.outputSchema : null,
          skills: this.config.skills || [],
          // Per-node tool DENY list (least privilege, declaration-driven). A
          // node that only READS (a kb-sync fetch adapter) declares the write
          // tools it must never hold (`disallowedTools: ['mcp__gitlab__gitlab_accept_mr', …]`)
          // and the strategy passes them to the runtime's disallow layer.
          // Flows through invokeAgent options untouched; strategies that have
          // no disallow mechanism ignore it.
          disallowedTools: this.config.disallowedTools || [],
          // Native agent plugins declared on the node (e.g. Codex plugins:
          // `plugins: [{ name, marketplacePath }]`). Flows like `skills` →
          // the selected strategy decides what to do with it (the Codex
          // strategy installs them into CODEX_HOME; claude/gemini ignore it).
          plugins: this.config.plugins || [],
          sessionPath,
          config: zibbyConfig,
          nodeName: this.name,
          timeout: this.config?.timeout || 300000,
        };

        let _invokeAgent = context?._coreInvokeAgent;
        if (!_invokeAgent) {
          const mod = await import('./strategy-registry.js');
          _invokeAgent = mod.invokeAgent;
        }
        const result = await _invokeAgent(prompt, agentContext, agentOptions);

        let rawOutput, extractedJson;

        if (typeof result === 'string') {
          rawOutput = result;
          extractedJson = null;
        } else if (result.structured) {
          rawOutput = result.raw || JSON.stringify(result.structured, null, 2);
          extractedJson = result.structured;
        } else {
          rawOutput = result.raw || JSON.stringify(result, null, 2);
          extractedJson = result.extracted || null;
        }

        if (sessionPath) {
          try {
            const debugPath = join(sessionPath, this.name, 'raw_stream_output.txt');
            mkdirSync(dirname(debugPath), { recursive: true });
            writeFileSync(debugPath, typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput), 'utf-8');
          } catch (err) {
            logger.debug(`[workflow] could not save raw output: ${err.message}`);
          }
        }

        if (this.isZodSchema && extractedJson) {
          // debug, NOT info: this dumps the node's ENTIRE validated output as
          // pretty JSON. The CLI host now routes info → console.log, which the
          // per-node progress middleware captures into `nodes[].logs` and
          // re-ships the WHOLE buffer on every 500ms flush — so at info this
          // pays for a large blob repeatedly, to duplicate content the agent
          // already streamed on stdout and that is also written to
          // <sessionPath>/<node>/raw_stream_output.txt and the artifact.
          logger.debug(`[workflow] node '${this.name}': output validated: ${JSON.stringify(extractedJson, null, 2)}`);

          let finalOutput = extractedJson;
          if (typeof this.onComplete === 'function') {
            try {
              finalOutput = await this.onComplete(getAllState(), extractedJson);
            } catch (err) {
              logger.warn(`[workflow] onComplete hook failed: ${err.message}`);
            }
          }

          return { success: true, output: finalOutput, raw: rawOutput };
        }

        if (typeof this.onComplete === 'function') {
          try {
            const onCompleteResult = await this.onComplete(getAllState(), { raw: rawOutput });
            return { success: true, output: onCompleteResult, raw: rawOutput };
          } catch (err) {
            throw new Error(`onComplete failed: ${err.message}`, { cause: err });
          }
        }

        if (this.parser) {
          const parsed = this.parser.parse(rawOutput);
          // debug, NOT info — same reason as the validated-output dump above.
          logger.debug(`[workflow] node '${this.name}': parsed output: ${JSON.stringify(parsed, null, 2)}`);
          timeline.step('Output parsed');
          return { success: true, output: parsed, raw: rawOutput };
        }

        return { success: true, output: rawOutput, raw: rawOutput };
      } catch (error) {
        lastError = error;
        const decision = llmBudget.next(error);
        if (!await awaitRetry(this.name, decision, error, _aborted)) break;
      }
    }

    return {
      success: false, error: lastError.message, raw: null, attempts: llmBudget.attemptsMade,
    };
  }
}

