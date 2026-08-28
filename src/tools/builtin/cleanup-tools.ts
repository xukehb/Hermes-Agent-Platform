import { z } from 'zod';
import { defineTool } from '../define.js';
import { scanLocalDisk, cleanLocalDisk } from '../../system/disk-cleaner.js';
import { lookupIpGeo } from '../../system/ip-lookup.js';
import { formatBytes } from '../../system/host-info.js';
import { RemoteClientManager, RemoteServerStore } from '../../remote/index.js';

export const diskCleanupTool = defineTool({
  name: 'disk_cleanup',
  description: '执行本地主机或远程服务器的 AI 智能磁盘分析与安全清理（清理包管理器缓存、构建产物、过期日志、Docker 悬空镜像等）。',
  schema: z.object({
    server: z.string().optional().describe('可选的远程服务器名称或 ID。若省略则分析本地宿主机磁盘'),
    dryRun: z.boolean().optional().describe('是否仅体检分析而不实际删除文件（默认 true）'),
    level: z.enum(['safe', 'all']).optional().describe('清理级别：safe（仅清理安全缓存与日志）或 all（包含构建产物）'),
  }),
  run: async (args, ctx) => {
    const dryRun = args.dryRun !== false; // 默认 true，防误删
    const level = args.level || 'safe';

    // 1. 如果指定了远程服务器
    if (args.server) {
      const server = RemoteServerStore.getInstance().list().find(s =>
        s.id === args.server || s.name === args.server || s.host === args.server
      );
      if (!server) {
        return { content: `未找到指定的远程服务器 [${args.server}]`, isError: true };
      }

      const client = RemoteClientManager.getInstance();
      if (dryRun) {
        const cmd = 'df -h / && du -sh /var/log /tmp ~/.cache ~/.npm 2>/dev/null || true';
        const res = await client.execCommand(server, cmd);
        return {
          content: `### 远程服务器 [${server.name}] 磁盘体检报告 (Dry-Run 模式)\n\`\`\`text\n${res.stdout || res.stderr}\n\`\`\`\n> 提示：若需执行清理，请设置参数 \`dryRun: false\`。`,
          isError: false,
        };
      } else {
        const cleanCmd = 'sudo apt-get clean -y 2>/dev/null; sudo journalctl --vacuum-size=100M 2>/dev/null; sudo docker system prune -f 2>/dev/null; rm -rf /tmp/* 2>/dev/null; df -h /';
        const res = await client.execCommand(server, cleanCmd);
        return {
          content: `### 远程服务器 [${server.name}] 磁盘安全清理完成！\n\`\`\`text\n${res.stdout || res.stderr}\n\`\`\``,
          isError: false,
        };
      }
    }

    // 2. 本地宿主机磁盘扫描
    const report = await scanLocalDisk({
      workspace: ctx.agent.workspace,
    });

    if (dryRun) {
      const formattedItems = report.items.map(item => {
        const tag = item.safety === 'safe' ? '🟢 [安全]' : '🟡 [建议确认]';
        return `- ${tag} **${item.name}** (\`${formatBytes(item.sizeBytes)}\`)\n  路径: \`${item.path}\`\n  说明: ${item.description}`;
      }).join('\n');

      const summary = [
        `### 🖥️ 本地宿主机磁盘体检报告 (Dry-Run 模式)`,
        `- **可释放空间总计**: **${formatBytes(report.totalCleanableBytes)}**`,
        `- **安全可清 (Safe)**: \`${formatBytes(report.safeCleanableBytes)}\``,
        `- **建议确认 (Review)**: \`${formatBytes(report.reviewCleanableBytes)}\``,
        ``,
        `#### 扫描发现的垃圾与缓存项 (${report.items.length} 项):`,
        formattedItems || '（未扫描到可清理的冗余垃圾文件）',
        ``,
        `> 💡 **提示**: 当前为仅扫描预览模式。若确认清理，请执行 \`disk_cleanup(dryRun=false)\`。`,
      ].join('\n');

      return { content: summary, isError: false };
    }

    // 3. 执行实际清理
    const targetIds = level === 'all'
      ? ['all']
      : report.items.filter(i => i.safety === 'safe').map(i => i.id);

    const cleanResult = await cleanLocalDisk(targetIds, report);

    const resultSummary = [
      `### 🧹 本地宿主机磁盘清理完成！`,
      `- **成功释放空间**: **${formatBytes(cleanResult.cleanedBytes)}**`,
      `- **已清理项目清单**:`,
      ...cleanResult.deletedItems.map(i => `  ✓ ${i}`),
      cleanResult.errors.length > 0 ? `\n- **清理异常**: ${cleanResult.errors.map(e => `${e.id}: ${e.error}`).join('; ')}` : '',
    ].filter(Boolean).join('\n');

    return { content: resultSummary, isError: false };
  },
});

export const ipLookupTool = defineTool({
  name: 'ip_lookup',
  description: '查询当前宿主机、远程服务器或指定 IP 地址的公网出口 IP、国家/城市地理位置、网络运营商 (ISP) 与 ASN 归属地。',
  schema: z.object({
    ip: z.string().optional().describe('要查询的目标 IP 地址（例如 8.8.8.8）。若省略则查询当前机器的公网出口 IP'),
    server: z.string().optional().describe('可选的目标远程服务器 ID 或名称'),
  }),
  run: async (args) => {
    // 1. 如果指定了远程服务器
    if (args.server) {
      const server = RemoteServerStore.getInstance().list().find(s =>
        s.id === args.server || s.name === args.server || s.host === args.server
      );
      if (!server) {
        return { content: `未找到指定的远程服务器 [${args.server}]`, isError: true };
      }

      const geo = await lookupIpGeo(server.host);
      return {
        content: [
          `### 🌐 远程服务器 [${server.name}] IP 归属地与网络诊断`,
          `- **服务器地址**: \`${server.host}:${server.port}\``,
          `- **地理位置**: **${geo.formattedLocation}**`,
          geo.country ? `- **国家/城市**: ${geo.country} · ${geo.region || ''} ${geo.city || ''}` : '',
          geo.isp ? `- **网络运营商 (ISP)**: ${geo.isp}` : '',
          geo.asn ? `- **ASN 自治域**: \`${geo.asn}\`` : '',
          geo.timezone ? `- **时区**: \`${geo.timezone}\`` : '',
        ].filter(Boolean).join('\n'),
        isError: false,
      };
    }

    // 2. 本地或指定 IP 查询
    const geo = await lookupIpGeo(args.ip);

    const summary = [
      `### 🌐 IP 归属地与网络诊断报告`,
      `- **IP 地址**: \`${geo.ip}\` ${geo.isPrivate ? '(局域网私网)' : '(公网出口)'}`,
      `- **归属地位置**: **${geo.formattedLocation}**`,
      geo.country ? `- **国家/地区**: ${geo.country} · ${geo.region || ''} ${geo.city || ''}` : '',
      geo.isp ? `- **网络运营商 (ISP)**: ${geo.isp}` : '',
      geo.asn ? `- **ASN 自治域**: \`${geo.asn}\`` : '',
      geo.timezone ? `- **时区**: \`${geo.timezone}\`` : '',
      geo.latitude && geo.longitude ? `- **地理经纬度**: \`${geo.latitude}, ${geo.longitude}\`` : '',
    ].filter(Boolean).join('\n');

    return { content: summary, isError: false };
  },
});
