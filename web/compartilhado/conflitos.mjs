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
export function mesmoMod(a, b) {
  const hashA = a.arquivo?.sha1 ?? a.sha1, hashB = b.arquivo?.sha1 ?? b.sha1;
  if (hashA && hashB && hashA.toLowerCase() === hashB.toLowerCase()) return true;
  const idsA = a.meta?.idsPrincipais ?? [a.meta?.modId ?? a.modId].filter(Boolean);
  const idsB = b.meta?.idsPrincipais ?? [b.meta?.modId ?? b.modId].filter(Boolean);
  if (idsA.some((id) => idsB.includes(id))) return true;
  const projetoA = a.projetoId ?? a.id, projetoB = b.projetoId ?? b.id;
  if (a.fonte && a.fonte === b.fonte && projetoA && projetoB && String(projetoA) === String(projetoB)) return true;
  if (idsA.length && idsB.length) return false;
  // O catalogo nao expoe o mod ID na busca. Nome/slug servem como barreira
  // imediata; o servidor confirma a identidade dentro dos JARs.
  if (a.fonte !== b.fonte) {
    const nomesA = [a.nome, a.slug].map(normalizar).filter(Boolean);
    const nomesB = [b.nome, b.slug].map(normalizar).filter(Boolean);
    return nomesA.some((nome) => nomesB.includes(nome));
  }
  return false;
}

export function checarCandidato(candidato, jaEscolhidos) {
  const choques = [];
  const gruposCandidato = gruposDoMod(candidato);

  for (const atual of jaEscolhidos) {
    if ((atual.projetoId ?? atual.id) && atual.fonte === candidato.fonte && String(atual.projetoId ?? atual.id) === String(candidato.id ?? candidato.projetoId)) {
      continue; // é ele mesmo
    }

    // O mesmo mod vindo das duas lojas.
    if (mesmoMod(candidato, atual)) {
      choques.push({
        severidade: 'bloqueio',
        grupo: 'duplicado',
        titulo: 'Esse mod já está no pack',
        motivo: `${atual.nome} já está no pack (${atual.fonte === 'modrinth' ? 'Modrinth' : atual.fonte === 'curseforge' ? 'CurseForge' : 'arquivo original'}). Mantenha uma só cópia.`,
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
