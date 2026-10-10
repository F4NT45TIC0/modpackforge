import { readFileSync } from 'node:fs';

export const criarExtratorPack = () => readFileSync(new URL('./extrair-pack.py', import.meta.url), 'utf8');
