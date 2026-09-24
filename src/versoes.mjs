// Comparação de versões e faixas.
//
// Cada ecossistema escreve suas exigências de um jeito:
//   Fabric/Quilt — predicados estilo npm: "*", ">=0.6.0", "~1.2.3", "1.2.x"
//   Forge/NeoForge — faixas do Maven: "[1.0,2.0)", "[1.0,)", "(,1.0]"
// Os dois viram a mesma pergunta aqui: esta versão satisfaz esta exigência?

/** Quebra "0.8.13+mc1.21.1" em partes comparáveis. Metadado de build é ignorado. */
export function analisar(bruta) {
  if (bruta == null) return null;
  const texto = String(bruta).trim().replace(/^v/i, '');
  const semBuild = texto.split('+')[0];
  const [nucleo, ...pre] = semBuild.split('-');
  const partes = nucleo.split('.').map((n) => {
    const num = Number(n);
    return Number.isFinite(num) ? num : n;
  });
  return {
    texto,
    maior: typeof partes[0] === 'number' ? partes[0] : 0,
    menor: typeof partes[1] === 'number' ? partes[1] : 0,
    correcao: typeof partes[2] === 'number' ? partes[2] : 0,
    extras: partes.slice(3).filter((p) => typeof p === 'number'),
    prelancamento: pre.join('-') || null,
  };
}

function compararIdentificadoresPre(a, b) {
  // Sem pré-lançamento vence quem tem: 1.0.0 > 1.0.0-beta.
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    const xNum = Number.isFinite(nx);
    const yNum = Number.isFinite(ny);
    if (xNum && yNum) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // numérico é menor que alfanumérico
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1, 0 ou 1. */
export function comparar(a, b) {
  const va = typeof a === 'string' ? analisar(a) : a;
  const vb = typeof b === 'string' ? analisar(b) : b;
  if (!va || !vb) return 0;
  const camposA = [va.maior, va.menor, va.correcao, ...va.extras];
  const camposB = [vb.maior, vb.menor, vb.correcao, ...vb.extras];
  for (let i = 0; i < Math.max(camposA.length, camposB.length); i++) {
    const x = camposA[i] ?? 0;
    const y = camposB[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return compararIdentificadoresPre(va.prelancamento, vb.prelancamento);
}

export const maior = (a, b) => comparar(a, b) > 0;

// ------------------------------------------------------ predicados do Fabric

function satisfazPredicadoSimples(versao, predicado) {
  const p = predicado.trim();
  if (!p || p === '*' || p.toLowerCase() === 'any') return true;

  const casa = p.match(/^(>=|<=|>|<|\^|~|=)?\s*(.+)$/);
  if (!casa) return false;
  const operador = casa[1] ?? '=';
  const alvoTexto = casa[2].trim();

  // Curingas: 1.2.x, 1.x, 1.2.*
  if (/[x*]/i.test(alvoTexto)) {
    const partesAlvo = alvoTexto.split('.');
    const partesVersao = [versao.maior, versao.menor, versao.correcao];
    for (let i = 0; i < partesAlvo.length; i++) {
      const parte = partesAlvo[i];
      if (/^[x*]$/i.test(parte)) return true; // daqui pra frente vale tudo
      if (Number(parte) !== partesVersao[i]) return false;
    }
    return true;
  }

  const alvo = analisar(alvoTexto);
  if (!alvo) return false;
  const c = comparar(versao, alvo);

  switch (operador) {
    case '>=': return c >= 0;
    case '>': return c > 0;
    case '<=': return c <= 0;
    case '<': return c < 0;
    case '=': return c === 0;
    case '~': {
      // >=1.2.3 <1.3.0
      if (c < 0) return false;
      if (versao.maior !== alvo.maior) return false;
      return versao.menor === alvo.menor;
    }
    case '^': {
      // >=1.2.3 <2.0.0 — abaixo de 1.0.0 o Fabric trava também o "menor"
      if (c < 0) return false;
      if (versao.maior !== alvo.maior) return false;
      if (alvo.maior === 0) return versao.menor === alvo.menor;
      return true;
    }
    default: return c === 0;
  }
}

// -------------------------------------------------------- faixas do Maven

function satisfazFaixaMaven(versao, faixa) {
  const t = faixa.trim();
  if (!t || t === '*') return true;

  // Sem colchetes o Maven trata como "recomendada", que na prática é >=.
  if (!/^[[(]/.test(t)) return comparar(versao, analisar(t)) >= 0;

  // Uma exigência pode trazer várias faixas: "[1.0,2.0),[3.0,)"
  const blocos = t.match(/[[(][^\])]*[\])]/g) ?? [];
  for (const bloco of blocos) {
    const abreInclusivo = bloco[0] === '[';
    const fechaInclusivo = bloco[bloco.length - 1] === ']';
    const miolo = bloco.slice(1, -1);
    const [deTexto, ateTexto] = miolo.includes(',') ? miolo.split(',') : [miolo, miolo];

    let ok = true;
    if (deTexto && deTexto.trim()) {
      const c = comparar(versao, analisar(deTexto));
      ok = ok && (abreInclusivo ? c >= 0 : c > 0);
    }
    if (ateTexto && ateTexto.trim()) {
      const c = comparar(versao, analisar(ateTexto));
      ok = ok && (fechaInclusivo ? c <= 0 : c < 0);
    }
    if (ok) return true;
  }
  return false;
}

/**
 * A versão atende à exigência?
 * @param {string} versaoTexto versão do mod, como o próprio jar declara
 * @param {string|string[]} exigencia predicado do Fabric ou faixa do Maven
 * @param {'fabric'|'maven'} dialeto
 */
export function satisfaz(versaoTexto, exigencia, dialeto = 'fabric') {
  if (exigencia == null) return true;
  const versao = analisar(versaoTexto);
  if (!versao) return true; // sem versão legível, não dá para acusar conflito

  // Lista = "qualquer uma serve".
  if (Array.isArray(exigencia)) {
    return exigencia.length === 0 || exigencia.some((e) => satisfaz(versaoTexto, e, dialeto));
  }

  const texto = String(exigencia).trim();
  if (!texto || texto === '*') return true;

  if (dialeto === 'maven' || /^[[(]/.test(texto)) return satisfazFaixaMaven(versao, texto);

  // No Fabric, espaços dentro de um predicado são "e".
  return texto
    .split(/\s+/)
    .filter(Boolean)
    .every((p) => satisfazPredicadoSimples(versao, p));
}

/** Texto curto para mostrar na interface. */
export function descreverExigencia(exigencia) {
  if (exigencia == null) return 'qualquer versão';
  const lista = Array.isArray(exigencia) ? exigencia : [exigencia];
  const limpo = lista.map((e) => String(e).trim()).filter((e) => e && e !== '*');
  return limpo.length ? limpo.join(' ou ') : 'qualquer versão';
}
