/**
 * IP 地理位置与网络归属地探测模块。
 */

export interface IpGeoInfo {
  ip: string;
  isPrivate: boolean;
  country?: string | undefined;
  countryCode?: string | undefined;
  region?: string | undefined;
  city?: string | undefined;
  isp?: string | undefined;
  asn?: string | undefined;
  timezone?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  formattedLocation: string;
}

/** 判断是否为私有局域网或保留 IP 地址 */
export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  const clean = ip.trim();
  if (clean === '127.0.0.1' || clean === 'localhost' || clean === '::1' || clean === '0.0.0.0') {
    return true;
  }
  // 10.0.0.0/8
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  // 172.16.0.0/12
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  // 192.168.0.0/16
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  // 100.64.0.0/10 (CGNAT)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  // 169.254.0.0/16 (Link-Local)
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;

  return false;
}

/** 国家代码到国旗 Emoji 转换 */
export function getCountryFlag(countryCode?: string): string {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  try {
    return String.fromCodePoint(...codePoints);
  } catch {
    return '🌐';
  }
}

/** 查询 IP 归属地与网络运营商（带中英文多源 Fallback 与超时兜底） */
export async function lookupIpGeo(targetIp?: string): Promise<IpGeoInfo> {
  const cleanIp = targetIp ? targetIp.trim() : '';

  // 1. 如果是私网 IP
  if (cleanIp && isPrivateIp(cleanIp)) {
    return {
      ip: cleanIp,
      isPrivate: true,
      country: '局域网',
      countryCode: 'LAN',
      formattedLocation: `🏠 局域网内网地址 (${cleanIp})`,
    };
  }

  // 2. 主源: ip-api.com (支持中文国家与省市，极速响应)
  try {
    const ipApiUrl = cleanIp
      ? `http://ip-api.com/json/${encodeURIComponent(cleanIp)}?lang=zh-CN`
      : `http://ip-api.com/json/?lang=zh-CN`;
    const res = await fetch(ipApiUrl, {
      signal: AbortSignal.timeout(3000),
      headers: { 'Accept': 'application/json' },
    });
    if (res.ok) {
      const data = await res.json() as Record<string, any>;
      if (data.status === 'success' || data.query) {
        const ip = data.query || cleanIp || '127.0.0.1';
        const country = data.country || '';
        const countryCode = data.countryCode || '';
        const region = data.regionName || data.region || '';
        const city = data.city || '';
        const isp = data.isp || data.org || '';
        const asn = data.as || '';
        const flag = getCountryFlag(countryCode);
        const locParts = [country, region, city].filter(Boolean);
        const locStr = [...new Set(locParts)].join(' · ') || '未知地区';
        const ispStr = isp ? ` (${isp})` : '';

        return {
          ip,
          isPrivate: isPrivateIp(ip),
          country,
          countryCode,
          region,
          city,
          isp,
          asn,
          timezone: data.timezone || '',
          latitude: typeof data.lat === 'number' ? data.lat : undefined,
          longitude: typeof data.lon === 'number' ? data.lon : undefined,
          formattedLocation: `${flag} ${locStr}${ispStr}`,
        };
      }
    }
  } catch {}

  // 3. 次选源: ipapi.co
  try {
    const queryUrl = cleanIp
      ? `https://ipapi.co/${encodeURIComponent(cleanIp)}/json/`
      : `https://ipapi.co/json/`;
    const res = await fetch(queryUrl, {
      signal: AbortSignal.timeout(3000),
      headers: {
        'User-Agent': 'CodexConnect-Diagnostics/1.0',
        'Accept': 'application/json',
      },
    });

    if (res.ok) {
      const data = await res.json() as Record<string, any>;
      const ip = data.ip || cleanIp || '127.0.0.1';
      const country = data.country_name || data.country || '';
      const countryCode = data.country_code || data.country || '';
      const region = data.region || '';
      const city = data.city || '';
      const isp = data.org || data.isp || '';
      const asn = data.asn || '';
      const flag = getCountryFlag(countryCode);
      const locParts = [country, region, city].filter(Boolean);
      const locStr = [...new Set(locParts)].join(' · ') || '未知地区';
      const ispStr = isp ? ` (${isp})` : '';

      return {
        ip,
        isPrivate: isPrivateIp(ip),
        country,
        countryCode,
        region,
        city,
        isp,
        asn,
        timezone: data.timezone || '',
        latitude: typeof data.latitude === 'number' ? data.latitude : undefined,
        longitude: typeof data.longitude === 'number' ? data.longitude : undefined,
        formattedLocation: `${flag} ${locStr}${ispStr}`,
      };
    }
  } catch {}

  // 4. 备用源: ipify + 简易解析
  try {
    const fallbackRes = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(2500),
    });
    if (fallbackRes.ok) {
      const json = await fallbackRes.json() as { ip?: string };
      if (json.ip) {
        return {
          ip: json.ip,
          isPrivate: false,
          formattedLocation: `🌐 公网 IP: ${json.ip}`,
        };
      }
    }
  } catch {}

  // 5. 离线/内网兜底
  const fallbackIp = cleanIp || '127.0.0.1';
  return {
    ip: fallbackIp,
    isPrivate: isPrivateIp(fallbackIp),
    formattedLocation: isPrivateIp(fallbackIp) ? `🏠 局域网内网 (${fallbackIp})` : `🌐 公网 IP (${fallbackIp})`,
  };
}
