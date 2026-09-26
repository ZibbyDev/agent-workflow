/**
 * Abstract base class for AI agent strategies.
 * All provider implementations must extend this class.
 *
 * @abstract
 */
export class AgentStrategy {
  description?: any;
  name?: any;
  priority?: any;
  /**
   * @param {string} name        - Provider identifier (e.g. 'claude', 'openai')
   * @param {string} description - Human-readable description
   * @param {number} [priority]  - Selection priority (higher = preferred)
   */
  constructor(name, description, priority = 0) {
    this.name = name;
    this.description = description;
    this.priority = priority;
  }

  /**
   * Execute a prompt against this agent.
   *
   * @abstract
   * @param {string} prompt
   * @param {AgentInvokeOptions} options
   * @returns {Promise<string | AgentStructuredResult>}
   *   - Without schema: returns raw string
   *   - With schema:    returns { raw: string, structured: object }
   *   - On failure:     throws Error
   *
   * @typedef {Object} AgentInvokeOptions
   * @property {string}  [model]       - Model name or alias
   * @property {string}  [workspace]   - Working directory
   * @property {object}  [schema]      - Zod schema for structured output
   * @property {Array}   [skills]      - Skill IDs available to the agent
   * @property {Array}   [images]      - Image attachments (provider-specific)
   * @property {string}  [sessionPath] - Session artifact directory
   * @property {number}  [timeout]     - Execution timeout in ms
   * @property {object}  [config]      - Full workflow config
   *
   * @typedef {Object} AgentStructuredResult
   * @property {string} raw        - Raw agent output
   * @property {object} structured - Parsed and validated output
   */
  /**
   * The repository rule files this engine reads BY ITSELF from its working
   * directory's chain (the repository root down to the working directory) —
   * names from REPOSITORY_RULE_FILES (repository-rules.ts). invokeAgent sends
   * every other rule file of the run's working tree in the prompt, and names
   * these without repeating them. Default: none — the engine gets every rule
   * file in the prompt. Declare a name ONLY when the engine is started so that
   * it really loads that file (an engine run with its project settings off
   * does not).
   */
  get nativeRuleFiles(): string[] { return []; }

  async invoke(_prompt, _options: any = {}) {
    throw new Error(`${this.constructor.name}.invoke() must be implemented`);
  }

  /**
   * Return true if this strategy can run in the current environment.
   * @abstract
   * @param {object} [context]
   * @returns {boolean}
   */
  canHandle(_context) {
    throw new Error(`${this.constructor.name}.canHandle() must be implemented`);
  }

  /**
   * Do whatever ASYNCHRONOUS work this strategy needs before canHandle() can
   * answer truthfully. Called by invokeAgent() on the REQUESTED strategy, once,
   * immediately before the canHandle() gate.
   *
   * WHY THIS HOOK EXISTS
   * ────────────────────
   * canHandle() is a synchronous gate and must stay one — it is called from
   * getAgentStrategy(), which is synchronous public API used by templates and
   * tests. But a strategy whose engine is DELIVERED rather than installed (a
   * sha256-pinned binary fetched on demand instead of baked into an image)
   * cannot answer "am I available" without doing async work first. Splitting it
   * — async prepare, then sync gate — is what lets a lazily-delivered engine
   * pass the same gate, unchanged, instead of making every caller of
   * getAgentStrategy() async.
   *
   * CONTRACT
   *   - Default is a NO-OP. A strategy with nothing to prepare overrides nothing.
   *   - Idempotent: called on every invocation, must be cheap when already done.
   *   - THROWS rather than returning false. A preparation that fails means this
   *     agent cannot run, and the error must say why — it must never be
   *     swallowed into "unavailable", because the next thing a caller does with
   *     "unavailable" could be to run a DIFFERENT engine, which for an agent
   *     pinned to a vendor is a silently wrong answer rather than a failure.
   *
   * @param {object} [context]
   * @returns {Promise<void>}
   */
  async prepare(_context: any = {}) { /* no-op by default */ }

  /**
   * Can this engine load a node's declared PLUGIN BUNDLE natively?
   *
   * A node may declare `plugins: [{ name, marketplacePath }]` — a vendored
   * bundle of SKILL.md skills (plus references/scripts). Each engine that can
   * load such a bundle does it in ITS OWN native way (Codex: a local
   * marketplace install into CODEX_HOME; Claude: a local plugin directory
   * handed to the Agent SDK) and says so by overriding this to `true`. An
   * engine left at `false` is REFUSED a node that declares plugins
   * (refuseUnloadablePlugins) — it never runs without the method the node
   * was written to follow.
   */
  get loadsPlugins(): boolean { return false; }

  getName()        { return this.name; }
  getDescription() { return this.description; }
  getPriority()    { return this.priority; }
}

export default AgentStrategy;
