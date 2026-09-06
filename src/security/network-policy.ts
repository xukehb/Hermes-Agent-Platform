import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export interface ResolvedFetchTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

const blockedAddresses = new BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(address, prefix, 'ipv4');
}

for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(address, prefix, 'ipv6');
}

const metadataHosts = new Set([
  'metadata.google.internal',
  'metadata.google',
  'instance-data',
]);

function normalizedHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function allowlisted(host: string, allowHosts: readonly string[]): boolean {
  const normalized = normalizedHost(host);
  return allowHosts.some((entry) => {
    const candidate = normalizedHost(entry);
    if (candidate.startsWith('*.')) {
      const suffix = candidate.slice(1);
      return normalized.endsWith(suffix) && normalized !== suffix.slice(1);
    }
    return normalized === candidate;
  });
}

function mappedIpv4(address: string): string | undefined {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return match?.[1];
}

export function isBlockedNetworkAddress(address: string): boolean {
  const mapped = mappedIpv4(address);
  if (mapped !== undefined) return blockedAddresses.check(mapped, 'ipv4');
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, 'ipv4');
  if (family === 6) return blockedAddresses.check(address, 'ipv6');
  return true;
}

export async function assertFetchTarget(
  input: string | URL,
  allowHosts: readonly string[] = [],
): Promise<ResolvedFetchTarget> {
  const url = input instanceof URL ? new URL(input) : new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只允许 http/https URL');
  }
  if (url.username || url.password) throw new Error('URL 不允许包含用户凭据');

  const host = normalizedHost(url.hostname);
  if (host.length === 0) throw new Error('URL 缺少主机名');
  const explicitlyAllowed = allowlisted(host, allowHosts);
  if (!explicitlyAllowed && metadataHosts.has(host)) {
    throw new Error('已拒绝云元数据地址');
  }

  const literalFamily = isIP(host);
  const addresses = literalFamily === 0
    ? await lookup(host, { all: true, verbatim: true })
    : [{ address: host, family: literalFamily }];
  if (addresses.length === 0) throw new Error('目标主机没有可用地址');
  if (!explicitlyAllowed) {
    const blocked = addresses.find((entry) => isBlockedNetworkAddress(entry.address));
    if (blocked !== undefined) throw new Error('已拒绝非公网目标地址：' + blocked.address);
  }

  const selected = addresses[0]!;
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}
