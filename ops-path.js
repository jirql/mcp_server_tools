/**
 * Path Context Operations Library
 * Enhanced directory navigation with context awareness
 * 
 * Features:
 * - Recursive directory tree (tree)
 * - Smart directory exploration with summary (explore)
 * - Path context tracking (context)
 * - Bookmarks for quick navigation (bookmark)
 * - File search (find)
 * - Directory statistics (stats)
 */

import { readdir, stat, readFile, writeFile, access } from 'fs/promises';
import { join, resolve, dirname, basename, extname, relative } from 'path';
import { createLogger } from './utils-logger.js';

const logger = createLogger('PATH-CTX');

const MAX_DEPTH = 5;
const MAX_FILES_PER_DIR = 100;
const MAX_TOTAL_FILES = 1000;

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', 
  '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'env', '.env', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.nyc_output', '.cache', 'tmp', 'temp'
]);

const IGNORED_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.gitignore', '.gitkeep',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'
]);

const INTERESTING_EXTENSIONS = new Map([
  ['.py', 'Python'],
  ['.js', 'JavaScript'],
  ['.ts', 'TypeScript'],
  ['.jsx', 'React'],
  ['.tsx', 'React+TS'],
  ['.go', 'Go'],
  ['.rs', 'Rust'],
  ['.java', 'Java'],
  ['.kt', 'Kotlin'],
  ['.rb', 'Ruby'],
  ['.php', 'PHP'],
  ['.c', 'C'],
  ['.cpp', 'C++'],
  ['.h', 'Header'],
  ['.sh', 'Shell'],
  ['.yaml', 'YAML'],
  ['.yml', 'YAML'],
  ['.json', 'JSON'],
  ['.xml', 'XML'],
  ['.toml', 'TOML'],
  ['.md', 'Markdown'],
  ['.txt', 'Text'],
  ['.sql', 'SQL'],
  ['.conf', 'Config'],
  ['.cfg', 'Config'],
  ['.ini', 'Config'],
  ['.env', 'Env'],
  ['.pem', 'Certificate'],
  ['.key', 'Key'],
  ['.pub', 'PublicKey'],
  ['.sh', 'Shell'],
  ['.bash', 'Bash'],
  ['.zsh', 'Zsh'],
]);

const pathContext = {
  currentPath: process.cwd(),
  history: [],
  bookmarks: new Map(),
  lastExplore: null,
  exploreHistory: [],
  maxHistory: 50
};

function recordVisit(path) {
  const normalized = resolve(path);
  pathContext.history = pathContext.history.filter(p => p.path !== normalized);
  pathContext.history.unshift({
    path: normalized,
    visitedAt: Date.now(),
    visitCount: 1
  });
  if (pathContext.history.length > pathContext.maxHistory) {
    pathContext.history = pathContext.history.slice(0, pathContext.maxHistory);
  }
}

function validatePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    return process.cwd();
  }
  try {
    return resolve(inputPath);
  } catch {
    return process.cwd();
  }
}

async function safeStat(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function safeReaddir(path, options = {}) {
  try {
    return await readdir(path, options);
  } catch {
    return [];
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function getFileType(name, isDir) {
  if (isDir) return 'directory';
  const ext = extname(name).toLowerCase();
  return INTERESTING_EXTENSIONS.get(ext) || 'file';
}

function isInteresting(name, isDir) {
  if (isDir) return !IGNORED_DIRS.has(name);
  if (IGNORED_FILES.has(name)) return false;
  const ext = extname(name).toLowerCase();
  return INTERESTING_EXTENSIONS.has(ext) || name.startsWith('.');
}

export const pathOps = {
  async tree(rootPath, options = {}) {
    const {
      maxDepth = 3,
      showHidden = false,
      dirsOnly = false,
      maxFiles = 200,
      includeSize = true,
      filter = null
    } = options;

    const path = validatePath(rootPath);
    const rootStat = await safeStat(path);
    
    if (!rootStat) {
      return { success: false, error: `Path not found: ${path}` };
    }
    
    if (!rootStat.isDirectory()) {
      return { success: false, error: `Not a directory: ${path}` };
    }

    recordVisit(path);

    const result = {
      success: true,
      root: path,
      tree: {},
      stats: {
        totalDirs: 0,
        totalFiles: 0,
        totalSize: 0,
        truncated: false
      }
    };

    let fileCount = 0;

    async function buildTree(currentPath, depth, prefix = '') {
      if (depth > maxDepth) return null;
      if (fileCount > maxFiles) {
        result.stats.truncated = true;
        return null;
      }

      const entries = await safeReaddir(currentPath, { withFileTypes: true });
      const filtered = entries
        .filter(e => showHidden || !e.name.startsWith('.'))
        .filter(e => !IGNORED_DIRS.has(e.name))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

      const node = {
        name: basename(currentPath),
        type: 'directory',
        children: []
      };

      for (const entry of filtered) {
        if (fileCount > maxFiles) {
          result.stats.truncated = true;
          break;
        }

        const fullPath = join(currentPath, entry.name);
        
        if (filter && !entry.name.toLowerCase().includes(filter.toLowerCase())) {
          continue;
        }

        fileCount++;

        if (entry.isDirectory()) {
          result.stats.totalDirs++;
          const childNode = await buildTree(fullPath, depth + 1, prefix + '  ');
          if (childNode) {
            childNode.name = entry.name;
            childNode.type = 'directory';
            node.children.push(childNode);
          }
        } else if (!dirsOnly) {
          result.stats.totalFiles++;
          const s = await safeStat(fullPath);
          const size = s ? s.size : 0;
          result.stats.totalSize += size;
          
          node.children.push({
            name: entry.name,
            type: getFileType(entry.name, false),
            size: includeSize ? formatSize(size) : undefined,
            ext: extname(entry.name).toLowerCase() || null
          });
        }
      }

      return node;
    }

    result.tree = await buildTree(path, 0);
    result.stats.formattedSize = formatSize(result.stats.totalSize);

    return result;
  },

  async explore(rootPath, options = {}) {
    const {
      depth = 2,
      showHidden = false,
      groupByType = true,
      showInteresting = true,
      maxItems = 100
    } = options;

    const path = validatePath(rootPath);
    const rootStat = await safeStat(path);
    
    if (!rootStat) {
      return { success: false, error: `Path not found: ${path}` };
    }
    
    if (!rootStat.isDirectory()) {
      return { success: false, error: `Not a directory: ${path}` };
    }

    recordVisit(path);
    pathContext.currentPath = path;

    const result = {
      success: true,
      path: path,
      parent: dirname(path),
      summary: {
        dirs: 0,
        files: 0,
        totalSize: 0,
        byType: {},
        interesting: []
      },
      contents: {
        directories: [],
        files: []
      },
      suggestions: []
    };

    const entries = await safeReaddir(path, { withFileTypes: true });
    const filtered = entries.filter(e => showHidden || !e.name.startsWith('.'));

    for (const entry of filtered) {
      const fullPath = join(path, entry.name);
      const s = await safeStat(fullPath);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        result.summary.dirs++;
        result.contents.directories.push({
          name: entry.name,
          path: fullPath,
          type: 'directory'
        });
      } else {
        if (IGNORED_FILES.has(entry.name)) continue;
        result.summary.files++;
        const size = s ? s.size : 0;
        result.summary.totalSize += size;
        
        const ext = extname(entry.name).toLowerCase();
        const fileType = getFileType(entry.name, false);
        
        if (!result.summary.byType[fileType]) {
          result.summary.byType[fileType] = { count: 0, size: 0 };
        }
        result.summary.byType[fileType].count++;
        result.summary.byType[fileType].size += size;

        if (showInteresting && isInteresting(entry.name, false)) {
          result.summary.interesting.push({
            name: entry.name,
            path: fullPath,
            type: fileType,
            size: formatSize(size)
          });
        }

        result.contents.files.push({
          name: entry.name,
          path: fullPath,
          type: fileType,
          size: formatSize(size),
          ext: ext || null
        });
      }
    }

    result.summary.formattedSize = formatSize(result.summary.totalSize);
    result.summary.interesting = result.summary.interesting.slice(0, 20);

    if (groupByType) {
      const grouped = {};
      for (const file of result.contents.files) {
        const type = file.type;
        if (!grouped[type]) grouped[type] = [];
        grouped[type].push(file);
      }
      result.contents.groupedByType = grouped;
    }

    const readmePath = join(path, 'README.md');
    const packagePath = join(path, 'package.json');
    const requirementsPath = join(path, 'requirements.txt');
    const makefilePath = join(path, 'Makefile');
    const dockerfilePath = join(path, 'Dockerfile');

    if (await safeStat(readmePath)) {
      result.suggestions.push({ type: 'doc', file: 'README.md', hint: 'Project documentation' });
    }
    if (await safeStat(packagePath)) {
      result.suggestions.push({ type: 'config', file: 'package.json', hint: 'Node.js project' });
    }
    if (await safeStat(requirementsPath)) {
      result.suggestions.push({ type: 'config', file: 'requirements.txt', hint: 'Python dependencies' });
    }
    if (await safeStat(makefilePath)) {
      result.suggestions.push({ type: 'build', file: 'Makefile', hint: 'Build automation' });
    }
    if (await safeStat(dockerfilePath)) {
      result.suggestions.push({ type: 'container', file: 'Dockerfile', hint: 'Docker configuration' });
    }

    pathContext.lastExplore = {
      path: path,
      timestamp: Date.now(),
      summary: result.summary
    };
    pathContext.exploreHistory.unshift(pathContext.lastExplore);
    if (pathContext.exploreHistory.length > 20) {
      pathContext.exploreHistory.pop();
    }

    return result;
  },

  async context(action, options = {}) {
    switch (action) {
      case 'get':
        return {
          success: true,
          currentPath: pathContext.currentPath,
          history: pathContext.history.slice(0, 10),
          bookmarks: Array.from(pathContext.bookmarks.entries()).map(([name, path]) => ({ name, path })),
          lastExplore: pathContext.lastExplore
        };

      case 'set':
        const newPath = validatePath(options.path);
        const s = await safeStat(newPath);
        if (!s || !s.isDirectory()) {
          return { success: false, error: `Invalid directory: ${newPath}` };
        }
        pathContext.currentPath = newPath;
        recordVisit(newPath);
        return {
          success: true,
          previousPath: pathContext.history[1]?.path || null,
          currentPath: newPath
        };

      case 'back':
        if (pathContext.history.length < 2) {
          return { success: false, error: 'No previous path in history' };
        }
        const prevPath = pathContext.history[1].path;
        pathContext.currentPath = prevPath;
        return {
          success: true,
          currentPath: prevPath,
          history: pathContext.history.slice(0, 5)
        };

      case 'history':
        return {
          success: true,
          history: pathContext.history.slice(0, options.limit || 20),
          total: pathContext.history.length
        };

      case 'clear':
        pathContext.history = [];
        pathContext.currentPath = process.cwd();
        return { success: true, message: 'Context cleared' };

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },

  async bookmark(action, options = {}) {
    switch (action) {
      case 'add':
        if (!options.name || !options.path) {
          return { success: false, error: 'name and path required' };
        }
        const bmPath = validatePath(options.path);
        const bmStat = await safeStat(bmPath);
        if (!bmStat) {
          return { success: false, error: `Path not found: ${bmPath}` };
        }
        pathContext.bookmarks.set(options.name, bmPath);
        return {
          success: true,
          bookmark: { name: options.name, path: bmPath },
          total: pathContext.bookmarks.size
        };

      case 'remove':
        if (!options.name) {
          return { success: false, error: 'name required' };
        }
        const removed = pathContext.bookmarks.delete(options.name);
        return {
          success: removed,
          message: removed ? `Bookmark '${options.name}' removed` : `Bookmark '${options.name}' not found`
        };

      case 'get':
        if (!options.name) {
          return { success: false, error: 'name required' };
        }
        const bm = pathContext.bookmarks.get(options.name);
        if (!bm) {
          return { success: false, error: `Bookmark '${options.name}' not found` };
        }
        return { success: true, name: options.name, path: bm };

      case 'list':
        return {
          success: true,
          bookmarks: Array.from(pathContext.bookmarks.entries()).map(([name, path]) => ({ name, path })),
          total: pathContext.bookmarks.size
        };

      case 'clear':
        pathContext.bookmarks.clear();
        return { success: true, message: 'All bookmarks cleared' };

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },

  async find(rootPath, options = {}) {
    const {
      pattern = '',
      type = 'all',
      maxDepth = 5,
      maxResults = 50,
      caseSensitive = false
    } = options;

    const path = validatePath(rootPath);
    const rootStat = await safeStat(path);
    
    if (!rootStat || !rootStat.isDirectory()) {
      return { success: false, error: `Invalid directory: ${path}` };
    }

    const results = [];
    let searched = 0;
    const startTime = Date.now();

    const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();

    async function searchDir(currentPath, depth) {
      if (depth > maxDepth) return;
      if (results.length >= maxResults) return;

      const entries = await safeReaddir(currentPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (IGNORED_DIRS.has(entry.name)) continue;

        searched++;
        const entryName = caseSensitive ? entry.name : entry.name.toLowerCase();
        const matches = !pattern || entryName.includes(searchPattern);

        if (matches) {
          if (type === 'all' || 
              (type === 'dir' && entry.isDirectory()) || 
              (type === 'file' && !entry.isDirectory())) {
            
            const fullPath = join(currentPath, entry.name);
            const s = await safeStat(fullPath);
            
            results.push({
              name: entry.name,
              path: fullPath,
              relativePath: relative(path, fullPath),
              type: entry.isDirectory() ? 'directory' : 'file',
              size: s && !entry.isDirectory() ? formatSize(s.size) : null,
              ext: entry.isDirectory() ? null : extname(entry.name).toLowerCase()
            });
          }
        }

        if (entry.isDirectory() && depth < maxDepth) {
          await searchDir(join(currentPath, entry.name), depth + 1);
        }
      }
    }

    await searchDir(path, 0);

    return {
      success: true,
      root: path,
      pattern: pattern,
      results: results,
      stats: {
        searched: searched,
        found: results.length,
        truncated: results.length >= maxResults,
        duration: Date.now() - startTime
      }
    };
  },

  async stats(rootPath, options = {}) {
    const path = validatePath(rootPath);
    const rootStat = await safeStat(path);
    
    if (!rootStat || !rootStat.isDirectory()) {
      return { success: false, error: `Invalid directory: ${path}` };
    }

    const result = {
      success: true,
      path: path,
      summary: {
        totalDirs: 0,
        totalFiles: 0,
        totalSize: 0,
        maxDepth: 0,
        largestFiles: [],
        byExtension: {},
        byType: {},
        recentFiles: []
      },
      breakdown: {
        topDirs: [],
        emptyDirs: []
      }
    };

    async function scan(currentPath, depth) {
      if (depth > 10) return;
      
      result.summary.maxDepth = Math.max(result.summary.maxDepth, depth);
      
      const entries = await safeReaddir(currentPath, { withFileTypes: true });
      
      if (entries.length === 0) {
        result.breakdown.emptyDirs.push(currentPath);
        return;
      }

      let dirSize = 0;
      const dirInfo = { path: currentPath, files: 0, size: 0 };

      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (IGNORED_FILES.has(entry.name)) continue;

        const fullPath = join(currentPath, entry.name);
        const s = await safeStat(fullPath);

        if (entry.isDirectory()) {
          result.summary.totalDirs++;
          await scan(fullPath, depth + 1);
        } else {
          result.summary.totalFiles++;
          const size = s ? s.size : 0;
          dirSize += size;
          result.summary.totalSize += size;

          const ext = extname(entry.name).toLowerCase();
          if (ext) {
            if (!result.summary.byExtension[ext]) {
              result.summary.byExtension[ext] = { count: 0, size: 0 };
            }
            result.summary.byExtension[ext].count++;
            result.summary.byExtension[ext].size += size;
          }

          const type = getFileType(entry.name, false);
          if (!result.summary.byType[type]) {
            result.summary.byType[type] = { count: 0, size: 0 };
          }
          result.summary.byType[type].count++;
          result.summary.byType[type].size += size;

          if (s) {
            result.summary.largestFiles.push({
              name: entry.name,
              path: fullPath,
              size: size,
              formattedSize: formatSize(size)
            });

            result.summary.recentFiles.push({
              name: entry.name,
              path: fullPath,
              modified: s.mtime
            });
          }

          dirInfo.files++;
          dirInfo.size += size;
        }
      }

      if (dirInfo.files > 0) {
        result.breakdown.topDirs.push(dirInfo);
      }
    }

    await scan(path, 0);

    result.summary.formattedSize = formatSize(result.summary.totalSize);
    result.summary.largestFiles.sort((a, b) => b.size - a.size);
    result.summary.largestFiles = result.summary.largestFiles.slice(0, 10);
    result.summary.recentFiles.sort((a, b) => b.modified - a.modified);
    result.summary.recentFiles = result.summary.recentFiles.slice(0, 10);
    result.breakdown.topDirs.sort((a, b) => b.size - a.size);
    result.breakdown.topDirs = result.breakdown.topDirs.slice(0, 10);
    result.breakdown.emptyDirs = result.breakdown.emptyDirs.slice(0, 20);

    const sortedExts = Object.entries(result.summary.byExtension)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 15);
    result.summary.byExtension = Object.fromEntries(sortedExts);

    return result;
  },

  async quickView(filePath, options = {}) {
    const path = validatePath(filePath);
    const s = await safeStat(path);
    
    if (!s) {
      return { success: false, error: `File not found: ${path}` };
    }

    if (s.isDirectory()) {
      return this.explore(path, options);
    }

    const ext = extname(path).toLowerCase();
    const maxSize = options.maxSize || 100 * 1024;
    
    if (s.size > maxSize) {
      return {
        success: true,
        path: path,
        type: 'file',
        size: formatSize(s.size),
        ext: ext,
        fileType: getFileType(basename(path), false),
        modified: s.mtime,
        truncated: true,
        message: `File too large (${formatSize(s.size)}), use file read for full content`
      };
    }

    try {
      const content = await readFile(path, 'utf8');
      const lines = content.split('\n');
      
      return {
        success: true,
        path: path,
        type: 'file',
        size: formatSize(s.size),
        ext: ext,
        fileType: getFileType(basename(path), false),
        modified: s.mtime,
        lines: lines.length,
        preview: lines.slice(0, 50).join('\n'),
        truncated: lines.length > 50
      };
    } catch (e) {
      return {
        success: true,
        path: path,
        type: 'file',
        size: formatSize(s.size),
        ext: ext,
        fileType: getFileType(basename(path), false),
        modified: s.mtime,
        binary: true,
        message: 'Binary or unreadable file'
      };
    }
  }
};

export { pathContext };
