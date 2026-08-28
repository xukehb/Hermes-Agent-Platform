import { describe, it, expect } from 'vitest';
import { isPrivateIp, getCountryFlag, lookupIpGeo } from '../src/system/ip-lookup.js';
import { ipLookupTool } from '../src/tools/builtin/cleanup-tools.js';

describe('IP Lookup & Geo-Location', () => {
  it('identifies private and loopback IP addresses correctly', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('localhost')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('10.0.1.20')).toBe(true);
    expect(isPrivateIp('192.168.1.100')).toBe(true);
    expect(isPrivateIp('172.20.144.1')).toBe(true);
    expect(isPrivateIp('169.254.10.10')).toBe(true);
    expect(isPrivateIp('100.64.0.5')).toBe(true);

    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('114.114.114.114')).toBe(false);
  });

  it('converts country codes to flag emojis', () => {
    expect(getCountryFlag('CN')).toBe('🇨🇳');
    expect(getCountryFlag('US')).toBe('🇺🇸');
    expect(getCountryFlag('JP')).toBe('🇯🇵');
    expect(getCountryFlag('invalid')).toBe('🌐');
  });

  it('lookupIpGeo returns structured info for private IP without network', async () => {
    const geo = await lookupIpGeo('192.168.1.1');
    expect(geo.isPrivate).toBe(true);
    expect(geo.ip).toBe('192.168.1.1');
    expect(geo.formattedLocation).toContain('局域网内网地址');
  });

  it('ipLookupTool executes successfully and outputs markdown diagnostics', async () => {
    const res = await ipLookupTool.handler({ ip: '127.0.0.1' }, {} as any);
    expect(res.isError).toBe(false);
    expect(res.content).toContain('IP 归属地与网络诊断报告');
    expect(res.content).toContain('127.0.0.1');
  });
});
