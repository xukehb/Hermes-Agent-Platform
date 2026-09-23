import { existsSync, rmSync } from 'node:fs';

if (existsSync('dist')) {
  rmSync('dist', { recursive: true, force: true });
}
