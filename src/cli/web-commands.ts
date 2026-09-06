import { Command } from 'commander';
import { CliContext, emit, type GlobalOptions } from './context.js';
import { startWebServer, getLocalIpAddresses, type WebServerOptions } from '../web/server.js';

export function registerWebCommands(root: Command, globals: () => GlobalOptions): void {
  root
    .command('web')
    .description('启动局域网 Web 工作台 (Headless Web Workbench)')
    .option('-p, --port <port>', '监听端口', '3000')
    .option('-b, --bind <host>', '绑定地址 (默认仅本机；公网监听需配合 --auth)', '127.0.0.1')
    .option('--auth <token>', '开启访问凭据 Token 鉴权保护')
    .action(async (opts) => {
      const g = globals();
      const port = parseInt(opts.port, 10) || 3000;
      const bind = opts.bind || '127.0.0.1';
      const auth = opts.auth;

      const options: WebServerOptions = {
        port,
        bind,
      };
      if (auth) options.auth = auth;
      if (g.config) options.configPath = g.config;

      startWebServer(options);
    });
}
