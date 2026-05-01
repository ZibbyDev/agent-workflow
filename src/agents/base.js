/**
 * Abstract base class for AI agent strategies.
 * All provider implementations must extend this class.
 *
 * @abstract
 */
export class AgentStrategy {
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
  async invoke(_prompt, _options = {}) {
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

  getName()        { return this.name; }
  getDescription() { return this.description; }
  getPriority()    { return this.priority; }
}

export default AgentStrategy;
