// Regras de incompatibilidade.
//
// Duas fontes de verdade se somam aqui:
//   1. O que os próprios autores declaram nos metadados (dependência "incompatible"
//      na Modrinth, relationType 5 na CurseForge). Isso o resolver lê direto.
//   2. Conflitos conhecidos da comunidade que ninguém declara — dois motores de
//      renderização no mesmo pack, dois rewrites do sistema de luz, e assim por diante.
//      É essa lista curada que mora neste arquivo.
//
// Severidade:
//   bloqueio — o jogo trava ou nem abre. A interface impede a seleção.
//   aviso    — funciona, mas é redundante ou instável. A interface deixa passar.

export const GRUPOS = [
  {
    id: 'motor-de-renderizacao',
    severidade: 'bloqueio',
    titulo: 'Dois motores de renderização',
    motivo: 'Cada um reescreve o renderizador inteiro. Juntos, o jogo não abre.',
    membros: ['sodium', 'embeddium', 'rubidium', 'magnesium', 'canvas', 'canvas-renderer', 'optifine', 'xenon'],
  },
  {
    id: 'shaders',
    severidade: 'bloqueio',
    titulo: 'Dois carregadores de shader',
    motivo: 'Iris, Oculus e OptiFine disputam o mesmo pipeline de shaders.',
    membros: ['iris', 'oculus', 'optifine'],
  },
  {
    id: 'motor-de-luz',
    severidade: 'bloqueio',
    titulo: 'Dois motores de iluminação',
    motivo: 'Starlight e Phosphor reescrevem o mesmo sistema de luz.',
    membros: ['starlight', 'phosphor'],
  },
  {
    id: 'cache-de-entidades',
    severidade: 'bloqueio',
    titulo: 'Culling de entidades duplicado',
    motivo: 'Os dois interceptam o mesmo ponto de renderização de entidades.',
    membros: ['entityculling', 'entity-culling', 'cull-leaves'],
  },
  {
    id: 'renderizacao-distante',
    severidade: 'aviso',
    titulo: 'Distant Horizons com Nvidium',
    motivo: 'A combinação costuma dar artefato visual e travar em algumas versões.',
    membros: ['distanthorizons', 'distant-horizons', 'nvidium'],
  },
  {
    id: 'mapas',
    severidade: 'aviso',
    titulo: 'Mais de um mod de mapa',
    motivo: 'Funcionam juntos, mas você vai acabar com dois minimapas na tela.',
    membros: ['journeymap', 'xaeros-minimap', 'xaeros-world-map', 'voxelmap', 'antique-atlas', 'ftb-chunks'],
  },
  {
    id: 'zoom',
    severidade: 'aviso',
    titulo: 'Mais de um mod de zoom',
    motivo: 'Os atalhos de teclado vão colidir.',
    membros: ['zoomify', 'ok-zoomer', 'okzoomer', 'logical-zoom', 'wi-zoom', 'just-zoom'],
  },
  {
    id: 'inventario',
    severidade: 'aviso',
    titulo: 'Mais de um organizador de inventário',
    motivo: 'Os dois capturam o mesmo clique do mouse.',
    membros: ['inventory-profiles-next', 'mouse-tweaks', 'itemscroller', 'inventory-tweaks'],
  },
  {
    id: 'receitas',
    severidade: 'aviso',
    titulo: 'Mais de um visualizador de receitas',
    motivo: 'JEI, REI e EMI fazem a mesma coisa e ocupam a mesma lateral da tela.',
    membros: ['jei', 'roughly-enough-items', 'rei', 'emi', 'nei'],
  },
];

/** Reduz um nome ou slug a uma forma comparável entre as duas lojas. */
export function normalizar(texto) {
  if (!texto) return '';
  return String(texto)
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(fabric|forge|neoforge|quilt|edition|mod|unofficial|continuation|reforged|port|refabricated)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

const indice = new Map(); // membro normalizado -> grupos
for (const grupo of GRUPOS) {
  for (const membro of grupo.membros) {
    const chave = normalizar(membro);
    if (!indice.has(chave)) indice.set(chave, []);
    indice.get(chave).push(grupo);
  }
}

/** Grupos curados aos quais um mod pertence, olhando slug e nome. */
export function gruposDoMod(mod) {
  const chaves = new Set([normalizar(mod.slug), normalizar(mod.nome)].filter(Boolean));
  const achados = new Set();
  for (const chave of chaves) for (const g of indice.get(chave) ?? []) achados.add(g);
  return [...achados];
}

/**
 * Compara um candidato contra os mods já escolhidos.
 * Devolve a lista de choques, do mais grave para o menos.
 */
export function checarCandidato(candidato, jaEscolhidos) {
  const choques = [];
  const gruposCandidato = gruposDoMod(candidato);
  const normCandidato = normalizar(candidato.nome) || normalizar(candidato.slug);

  for (const atual of jaEscolhidos) {
    if (atual.fonte === candidato.fonte && String(atual.projetoId ?? atual.id) === String(candidato.id ?? candidato.projetoId)) {
      continue; // é ele mesmo
    }

    // O mesmo mod vindo das duas lojas.
    const normAtual = normalizar(atual.nome) || normalizar(atual.slug);
    if (normCandidato && normCandidato === normAtual) {
      choques.push({
        severidade: 'bloqueio',
        grupo: 'duplicado',
        titulo: 'Esse mod já está no pack',
        motivo: `${atual.nome} já foi adicionado pela ${atual.fonte === 'modrinth' ? 'Modrinth' : 'CurseForge'}.`,
        outro: atual,
      });
      continue;
    }

    // Conflito declarado pelo próprio autor, nos dois sentidos.
    if (atual.incompativeis?.some((i) => i.fonte === candidato.fonte && String(i.projetoId) === String(candidato.id ?? candidato.projetoId))) {
      choques.push({
        severidade: 'bloqueio',
        grupo: 'declarado',
        titulo: 'Incompatível segundo o autor',
        motivo: `${atual.nome} declara que não funciona junto com este mod.`,
        outro: atual,
      });
      continue;
    }

    // Regras curadas.
    for (const g of gruposCandidato) {
      if (gruposDoMod(atual).includes(g)) {
        choques.push({
          severidade: g.severidade,
          grupo: g.id,
          titulo: g.titulo,
          motivo: g.motivo,
          outro: atual,
        });
      }
    }
  }

  const peso = { bloqueio: 0, aviso: 1 };
  return choques.sort((a, b) => peso[a.severidade] - peso[b.severidade]);
}
