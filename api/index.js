// Função da Vercel.
//
// Toda chamada a /api/* é reescrita para cá (ver vercel.json) e segue para o
// mesmo tratador que o servidor local usa. Não há lógica aqui de propósito:
// qualquer diferença entre o PC e o site mora em src/api.mjs, à vista.

import { tratarApi } from '../src/api.mjs';

export const GET = tratarApi;
export const POST = tratarApi;
