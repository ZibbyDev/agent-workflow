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

    if (typeof this.customExecute === 'function') {
      logger.debug(`[workflow] node '${this.name}': custom execute (skipping LLM)`);
      try {
        const result = await this.customExecute(context);

        if (typeof result === 'object' && result !== null && result.success === false) {
          return { success: false, error: result.error || 'Node execution failed', raw: result.raw || null };
        }

        if (this.isZodSchema) {
          logger.debug(`[workflow] node '${this.name}': validating output schema`);
          const validated = this.outputSchema.parse(result);
          return { success: true, output: validated, raw: null };
        }

        return { success: true, output: result, raw: null };
      } catch (error) {
        logger.error(`[workflow] node '${this.name}' failed: ${error.message}`);
        if (error.name === 'ZodError') {
          // Zod v3+ exposes .issues; older majors used .errors. Defensive
          // fallback so a downstream user pinned to an older Zod still
          // gets a real log line, not `undefined`.
          logger.error(`Schema errors: ${JSON.stringify(error.issues || error.errors, null, 2)}`);
        }
        return { success: false, error: error.message, raw: null };
      }
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

    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        logger.debug(`[workflow] node '${this.name}' attempt ${attempt}`);

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
          logger.info(`[workflow] node '${this.name}': output validated: ${JSON.stringify(extractedJson, null, 2)}`);

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
          logger.info(`[workflow] node '${this.name}': parsed output: ${JSON.stringify(parsed, null, 2)}`);
          timeline.step('Output parsed');
          return { success: true, output: parsed, raw: rawOutput };
        }

        return { success: true, output: rawOutput, raw: rawOutput };
      } catch (error) {
        lastError = error;
        if (attempt < this.retries) {
          logger.info(`[workflow] node '${this.name}' failed, retrying (${attempt + 1}/${this.retries})…`);
        }
      }
    }

    return { success: false, error: lastError.message, raw: null };
  }
}

