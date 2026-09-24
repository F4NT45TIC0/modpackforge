// Configuração persistida fora da pasta do projeto, para que a chave da CurseForge
// não vá junto se você compartilhar o ModpackForge com alguém.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PASTA = path.join(process.env.APPDATA || path.join(homedir(), '.config'), 'ModpackForge');
const ARQUIVO = path.join(PASTA, 'config.json');

const PADRAO = {
  chaveCurseforge: '',
  ultimoLoader: 'fabric',
  ultimaVersaoJogo: '',
  pastaDeSaida: '',
};

let memoria = null;

export async function lerConfig() {
  if (memoria) return memoria;
  try {
    memoria = { ...PADRAO, ...JSON.parse(await readFile(ARQUIVO, 'utf8')) };
  } catch {
    memoria = { ...PADRAO };
  }
  return memoria;
}

export async function gravarConfig(mudancas) {
  const atual = await lerConfig();
  memoria = { ...atual, ...mudancas };
  await mkdir(PASTA, { recursive: true });
  await writeFile(ARQUIVO, JSON.stringify(memoria, null, 2), 'utf8');
  return memoria;
}

export const caminhoDaConfig = ARQUIVO;
