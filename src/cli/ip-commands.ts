import { Command } from 'commander';
import { CliContext, emit, type GlobalOptions } from './context.js';
import { lookupIpGeo } from '../system/ip-lookup.js';
import { RemoteServerStore } from '../remote/index.js';

export function registerIpCommands(root: Command, globals: () => GlobalOptions): void {
  root
    .command('ip')
    .description('查询当前宿主机、远程服务器或指定 IP 的公网出口与地理位置/运营商信息')
    .argument('[target]', '要查询的目标 IP 地址或域名（省略则查询当前机器出口 IP）')
    .option('-s, --server <name>', '指定要查询的远程服务器 ID 或名称')
    .action(async (target, opts) => {
      const g = globals();
      const ctx = new CliContext(g);

      // 1. 如果指定了远程服务器
      if (opts.server) {
        const server = RemoteServerStore.getInstance().list().find(s =>
          s.id === opts.server || s.name === opts.server || s.host === opts.server
        );
        if (!server) {
          emit(ctx, `✗ 未找到指定的远程服务器 [${opts.server}]`, { error: 'Server not found' });
          return;
        }

        const geo = await lookupIpGeo(server.host);
        const lines = [
          `\n🌐 ════════════════════════════════════════════════════════════════════`,
          `   远程服务器 [${server.name}] IP 归属地与网络诊断`,
          `════════════════════════════════════════════════════════════════════`,
          `   服务器地址:  ${server.host}:${server.port}`,
          `   归属地位置:  ${geo.formattedLocation}`,
          geo.country ? `   国家 / 地区:  ${geo.country} · ${geo.region || ''} ${geo.city || ''}` : '',
          geo.isp ? `   网络运营商:  ${geo.isp}` : '',
          geo.asn ? `   ASN 自治域:  ${geo.asn}` : '',
          geo.timezone ? `   时区标识:    ${geo.timezone}` : '',
          `════════════════════════════════════════════════════════════════════\n`,
        ].filter(Boolean);

        emit(ctx, lines.join('\n'), geo);
        return;
      }

      // 2. 查询本地出口 IP 或指定 IP
      const geo = await lookupIpGeo(target);
      const lines = [
        `\n🌐 ════════════════════════════════════════════════════════════════════`,
        `   CodexConnect IP 归属地与网络定位诊断报告`,
        `════════════════════════════════════════════════════════════════════`,
        `   目标 IP:     ${geo.ip} ${geo.isPrivate ? '(局域网私网)' : '(公网出口)'}`,
        `   地理归属地:  ${geo.formattedLocation}`,
        geo.country ? `   国家 / 地区:  ${geo.country} · ${geo.region || ''} ${geo.city || ''}` : '',
        geo.isp ? `   网络运营商:  ${geo.isp}` : '',
        geo.asn ? `   ASN 自治域:  ${geo.asn}` : '',
        geo.timezone ? `   时区标识:    ${geo.timezone}` : '',
        geo.latitude && geo.longitude ? `   地理坐标:    经度 ${geo.longitude}, 纬度 ${geo.latitude}` : '',
        `════════════════════════════════════════════════════════════════════\n`,
      ].filter(Boolean);

      emit(ctx, lines.join('\n'), geo);
    });
}
