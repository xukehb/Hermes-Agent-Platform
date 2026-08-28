import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const source = join(process.cwd(), 'src', 'gui', 'renderer');
const target = join(process.cwd(), 'dist', 'src', 'gui', 'renderer');
mkdirSync(target, { recursive: true });
for (const file of readdirSync(source)) {
  copyFileSync(join(source, file), join(target, file));
}
