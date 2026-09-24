// Função da Vercel.
//
// Toda chamada a /api/* é reescrita para cá (ver vercel.json) e segue para o
// mesmo tratador que o servidor local usa. A única coisa que este arquivo decide
// é dizer que está no site — sem depender de nenhuma variável de ambiente que a
// configuração do projeto possa desligar.
//
// A Vercel chama GET(request, contexto). O contexto não interessa ao tratador,
// por isso a função intermediária: repassá-lo direto o confundiria com as opções.

import { tratarApi } from '../src/api.mjs';

const noSite = (request) => tratarApi(request, { nuvem: true });

export const GET = noSite;
export const POST = noSite;
