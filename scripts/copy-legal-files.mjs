import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const distDir = resolve(projectRoot, 'dist');
const legalFiles = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt'];

await mkdir(distDir, { recursive: true });
await Promise.all(
  legalFiles.map((fileName) => copyFile(resolve(projectRoot, fileName), resolve(distDir, fileName))),
);

console.info(`[City-Sim] copied legal files to dist: ${legalFiles.join(', ')}`);
