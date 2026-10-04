import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const source = join(process.cwd(), 'src', 'gui', 'renderer');
const target = join(process.cwd(), 'dist', 'src', 'gui', 'renderer');
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
copyFileSync(join(process.cwd(), 'build', 'icon.png'), join(target, 'app-icon.png'));
cpSync(join(process.cwd(), 'src', 'system', 'docker-runtime'), join(process.cwd(), 'dist', 'src', 'system', 'docker-runtime'), { recursive: true });
