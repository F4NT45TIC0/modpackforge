import { readFileSync } from 'node:fs';

export const criarVerificador = () => readFileSync(new URL('./verificar-servidor.sh', import.meta.url), 'utf8');

export function textoVerificacao(relatorio) {
  return [
    `Estado: ${relatorio.status}`,
    `JARs conferidos: ${relatorio.verificados}/${relatorio.total}. Java minimo: ${relatorio.javaMinimo}.`,
    `Versoes permitidas de Java: ${relatorio.javaPermitidos.join(', ')}.`,
    'Esta verificacao confere declaracoes e dependencias. Use bash verificar-servidor.sh para testar o boot.',
    ...relatorio.bloqueios.map((p) => `BLOQUEIO: ${p.texto}`),
    ...relatorio.avisos.map((p) => `AVISO: ${p.texto}`),
  ].join('\n').replace(/[\r\n]+MPF_RELATORIO/g, '\n MPF_RELATORIO');
}
