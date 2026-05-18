/**
 * UA Pool Manager - 用户代理池管理
 * 提供真实浏览器 UA 模拟，支持多种浏览器和平台
 */

const UA_POOL = {
  chrome: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.817.75 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.7178.140 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.817.75 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.817.75 Safari/537.36',
  ],
  chrome_android: [
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.817.75 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.817.75 Mobile Safari/537.36',
  ],
  firefox: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  ],
  firefox_android: [
    'Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0',
  ],
  safari: [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  ],
  safari_ios: [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  ],
  edge: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.817.75 Safari/537.36 Edg/132.0.2345.65',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.817.75 Safari/537.36 Edg/132.0.2345.65',
  ],
  curl: [
    'curl/8.4.0',
  ],
};

const MOBILE_UA_TYPES = ['chrome_android', 'firefox_android', 'safari_ios'];

class UAPool {
  constructor() {
    this.lastUsed = {};
    for (const type of Object.keys(UA_POOL)) {
      this.lastUsed[type] = 0;
    }
  }

  get(type = 'chrome') {
    const pool = UA_POOL[type];
    if (!pool || pool.length === 0) {
      return UA_POOL.chrome[0];
    }
    const index = Math.floor(Math.random() * pool.length);
    return pool[index];
  }

  getRandom() {
    const types = Object.keys(UA_POOL);
    const type = types[Math.floor(Math.random() * types.length)];
    return this.get(type);
  }

  getRandomDesktop() {
    const desktopTypes = ['chrome', 'firefox', 'safari', 'edge'];
    const type = desktopTypes[Math.floor(Math.random() * desktopTypes.length)];
    return this.get(type);
  }

  getRandomMobile() {
    const type = MOBILE_UA_TYPES[Math.floor(Math.random() * MOBILE_UA_TYPES.length)];
    return this.get(type);
  }

  getByKeyword(keyword) {
    const lower = keyword.toLowerCase();
    
    if (lower.includes('mobile') || lower.includes('android') || lower.includes('ios')) {
      return this.getRandomMobile();
    }
    
    if (lower.includes('safari') && !lower.includes('chrome')) {
      return this.get('safari');
    }
    if (lower.includes('firefox') || lower.includes('ff')) {
      return this.get('firefox');
    }
    if (lower.includes('edge')) {
      return this.get('edge');
    }
    if (lower.includes('chrome')) {
      return this.get('chrome');
    }
    
    return this.getRandomDesktop();
  }

  getAllTypes() {
    return Object.keys(UA_POOL);
  }
}

export const uaPool = new UAPool();
export { UA_POOL };
