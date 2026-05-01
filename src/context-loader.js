import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class ContextLoader {
  static async loadContext(specPath, cwd, config = {}) {
    const context = {};
    const filenames = config.filenames || ['CONTEXT.md', 'AGENTS.md'];

    if (specPath) {
      const specDir = dirname(join(cwd, specPath));
      for (const filename of filenames) {
        const content = await this.findAndMergeContextFiles(filename, specDir, cwd);
        if (content) {
          const key = filename.replace(/\.[^.]+$/, '').toLowerCase();
          context[key] = content;
        }
      }
    }

    const discovery = config.discovery || {};
    for (const [key, pathTemplate] of Object.entries(discovery)) {
      try {
        const resolvedPath = join(cwd, pathTemplate);
        if (existsSync(resolvedPath)) {
          context[key] = await this.loadFile(resolvedPath);
        }
      } catch (err) {
        console.warn(`[workflow] could not load context '${key}' from '${pathTemplate}': ${err.message}`);
      }
    }

    return context;
  }

  static async findAndMergeContextFiles(filename, startDir, rootDir) {
    const contents = [];
    let currentDir = startDir;

    while (currentDir.startsWith(rootDir)) {
      const contextPath = join(currentDir, filename);
      if (existsSync(contextPath)) {
        try {
          contents.unshift(await this.loadFile(contextPath));
        } catch (err) {
          console.warn(`[workflow] could not load ${filename} from ${contextPath}: ${err.message}`);
        }
      }
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }

    if (contents.length === 0) return null;
    if (contents.every(c => typeof c === 'string')) return contents.join('\n\n---\n\n');
    if (contents.every(c => typeof c === 'object')) return Object.assign({}, ...contents);
    return contents[contents.length - 1];
  }

  static async loadFile(filePath) {
    const content = readFileSync(filePath, 'utf-8');
    if (filePath.endsWith('.json')) return JSON.parse(content);
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
      const { pathToFileURL } = await import('url');
      const module = await import(pathToFileURL(filePath).href);
      return module.default || module;
    }
    return content;
  }
}
