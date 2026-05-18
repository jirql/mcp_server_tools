export function ipInCIDR(ip, cidr) {
  if (!ip || !cidr || typeof ip !== 'string' || typeof cidr !== 'string') {
    return false;
  }

  const parts = cidr.split('/');
  if (parts.length === 1) {
    return ip === cidr;
  }
  if (parts.length !== 2) return false;
  const [network, prefixLength] = parts;
  const mask = parseInt(prefixLength, 10);
  if (isNaN(mask) || mask < 0 || mask > 32) return false;

  const ipInt = ipToInt(ip);
  const networkInt = ipToInt(network);
  if (ipInt === null || networkInt === null) return false;

  const maskInt = (0xFFFFFFFF << (32 - mask)) >>> 0;
  return (ipInt & maskInt) === (networkInt & maskInt);
}

function ipToInt(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const octets = ip.split('.');
  if (octets.length !== 4) return null;
  return octets.reduce((acc, octet) => {
    const n = parseInt(octet, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    return acc === null ? null : (acc << 8) + n;
  }, 0) >>> 0;
}

export function ipInAnyCIDR(ip, cidrs) {
  return cidrs.some(cidr => ipInCIDR(ip, cidr));
}

export function isAllowedIP(ip, allowedIPs) {
  if (!ip) return false;
  let cleanIP = ip;
  if (ip.startsWith('::ffff:')) {
    cleanIP = ip.substring(7);
  }
  return ipInAnyCIDR(cleanIP, allowedIPs);
}