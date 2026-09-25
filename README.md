# ModpackForge

Monte um modpack de Minecraft numa interface gráfica e gere um arquivo que seus
amigos abrem com dois cliques para ficar com exatamente o mesmo jogo que você.

Sem conta da Microsoft, sem login, sem instalar nada além do Node.js.

---

## Como usar

Dois cliques em **`ModpackForge.bat`**. Ele abre o navegador na interface.

1. Escolha o **modloader** (Fabric, NeoForge, Forge ou Quilt) e a **versão do Minecraft**.
   A versão do loader já vem preenchida com a recomendada.
2. Escolha **Mods**, **Shaders**, **Recursos** ou **Modpacks prontos** no catálogo. Mods são buscados na Modrinth e, se você configurar a chave, também na CurseForge. Os outros tipos vêm da Modrinth.
3. Para montar seu pack, clique em **Adicionar**. A partir daí a interface trabalha sozinha:
   - as **dependências entram junto** e aparecem marcadas com "exigido por";
   - os mods **incompatíveis ficam bloqueados**, com o motivo escrito ao lado.
4. Clique em **Gerar instalador**. Shaders entram em `shaderpacks/`, pacotes de recursos em `resourcepacks/`, e o instalador adiciona um carregador de shaders compatível quando necessário. No detalhe de cada shader ou pacote de recursos também há um link para baixar só o `.zip`.

Para baixar um **modpack pronto**, abra a aba correspondente, escolha uma versão e clique em **Baixar**. O ModpackForge entrega o `.mrpack` para importar no launcher e um `.sh` para instalar o lado servidor numa VPS Linux.

O resultado sai em `packs/<nome-do-pack>/`.

## O que é gerado

| Arquivo | Para quem |
|---|---|
| `Instalar <nome>.bat` | Qualquer amigo no Windows. É o principal. |
| `instalar-servidor-<nome>.sh` | Sua VPS Linux. Monta o servidor com os mesmos mods. |
| `<nome>.mrpack` | Quem usa Prism, ATLauncher ou o app da Modrinth. |
| `<nome> - lista.txt` | Só para conferir ou colar no grupo. |

Ao baixar um modpack publicado, o `.mrpack` original e o `.sh` gerado também ficam em `packs/<nome-do-modpack>/` no modo local.

### Serverpack de um modpack publicado

O `.sh` lê a versão e o modloader declarados no `.mrpack`, baixa os arquivos do servidor, confere SHA-1 e aplica `overrides/` e `server-overrides/` na ordem do formato. Ele exclui arquivos marcados como exclusivos do cliente e confere o lado servidor dos mods hospedados na Modrinth, pois alguns packs marcam todos os mods como necessários no servidor. Precisa de Java, `unzip`, `sha1sum` e `curl` ou `wget` na VPS. No primeiro uso, pergunta onde instalar e pede o aceite do EULA.

### O que o `.bat` faz na máquina do seu amigo

É um arquivo único, sem instalador e sem dependência. Ao abrir, ele:

1. Pergunta onde instalar e usa **uma pasta separada** — o Minecraft normal da
   pessoa continua intacto.
2. Procura o Java. Se não achar um instalado, usa o que o **próprio launcher do
   Minecraft já baixou**.
3. Instala o modloader pelo instalador oficial do projeto.
4. Baixa os mods **direto da API oficial** da Modrinth/CurseForge, seis por vez,
   e **confere o SHA-1 de cada um**.
5. Cria um perfil no launcher oficial, já apontando para a pasta certa e com a
   memória configurada.

Rodar de novo é seguro e serve para atualizar: arquivos que já estão certos são
reaproveitados, mods que saíram do pack são removidos, e só o que falta é baixado.

## Conferir um pack já instalado

```
node verificar.mjs "caminho para a pasta mods"
```

Lê cada `.jar` da pasta, monta a lista do que está realmente instalado — incluindo
as bibliotecas que vêm embutidas dentro de outros mods — e confere todas as
exigências do mesmo jeito que o Fabric faz ao abrir o jogo. Serve para saber se
um pack vai abrir sem precisar abrir, e para achar o culpado quando não abre.

Exemplos de onde fica a pasta:

```
%APPDATA%\PrismLauncher\instances\<instância>\minecraft\mods
%APPDATA%\.minecraft\modpacks\<pack>\mods
```

## CurseForge (opcional)

A Modrinth funciona sem configurar nada. A CurseForge exige uma chave de API,
que é gratuita:

1. Entre em [console.curseforge.com](https://console.curseforge.com/#/api-keys).
2. Copie a chave.
3. No ModpackForge, clique em **Configurações** e cole.

A chave é validada na hora e fica em `%APPDATA%\ModpackForge\config.json` — fora
da pasta do app, então ela não vai junto se você compartilhar o ModpackForge.

Alguns mods da CurseForge têm o download automático desligado pelo autor. Esses
o ModpackForge não consegue baixar por ninguém: ele avisa antes de gerar e o
instalador abre as páginas certas para a pessoa baixar à mão.

## Servidor na VPS

Marque **Instalador de servidor (.sh)** ao gerar. Depois:

```
scp instalar-servidor-<nome>.sh usuario@sua-vps:~
ssh usuario@sua-vps
bash instalar-servidor-<nome>.sh
```

O script instala o modloader em modo servidor, baixa o Minecraft, baixa os mods,
pede que você aceite o EULA da Mojang e cria um `iniciar.sh`. Rodar de novo
atualiza o servidor sem perder o mundo.

**Mods de cliente ficam de fora automaticamente.** Sodium, Iris, minimapa,
shader — esses derrubam um servidor no boot. Quem decide é o campo `server_side`
da Modrinth, e o instalador lista o que excluiu.

Ele **não mexe no seu firewall**: isso é configuração de segurança da máquina.
No fim ele mostra os comandos para você liberar a porta, e lembra que na Oracle
Cloud também é preciso abrir a regra na Security List do painel — só o firewall
da máquina não basta.

## Como o pack é montado para realmente abrir

Escolher "a versão mais nova de cada mod" monta uma lista que parece certa e o
jogo recusa. Foi o que acontecia antes, e a causa é que as lojas não publicam a
informação que decide:

- **Faixas de versão.** A API diz "o Iris depende do Sodium", não "o Iris depende
  do Sodium 0.6.x". Instalar o Sodium mais novo quebra o jogo.
- **Dependências não cadastradas.** Muitos autores não preenchem o campo na loja.
  O Jewelry precisa do `structure_pool_api` e isso não aparece em lugar nenhum
  da API.

Essas duas coisas estão declaradas dentro do `.jar`, no `fabric.mod.json` (ou
`mods.toml`). O ModpackForge lê esses arquivos — sem baixar os jars inteiros:
um ZIP guarda o índice no fim, então dá para pedir por HTTP Range só o pedaço
que interessa, uns 4% de cada arquivo.

Com os dados na mão, [`compatibilidade.mjs`](src/compatibilidade.mjs) mexe no
pack até tudo fechar: acrescenta o que falta, troca versões, e quando um mod
está encurralado tenta fazer **quem o exige** ceder. Num caso real, o Iris novo
puxa o Sodium 0.8, que declara não funcionar com o Better End; como o Better End
não tem versão mais nova, a saída é o Sodium 0.6 — e é ele que o solucionador
troca. As trocas aparecem na interface com o motivo.

Quando não existe combinação possível, isso vira um bloqueio explícito com os
dois nomes, antes de gerar o arquivo — em vez de virar uma tela de erro na hora
de jogar.

Depois de tudo ajustado, uma **auditoria final** relê as exigências de todos os
jars e confere o pack do zero, como o Fabric faria ao abrir o jogo. Ela roda
sempre, mesmo quando o ajuste automático desiste no meio: um pack que não fecha
nunca pode ser entregue em silêncio como se estivesse bom.

### Por que o .mrpack marca tudo como "required" no cliente

O `env.client` do formato diz ao launcher se ele deve instalar aquele arquivo, e
o valor natural seria copiar o `client_side` da Modrinth. Não copiamos, e o
motivo é concreto: esse campo é preenchido à mão e descreve servidor dedicado
contra cliente. Mods de estrutura e de geração de mundo aparecem lá como
`unsupported` no cliente, embora o modo um jogador precise deles — no
singleplayer o cliente roda um servidor interno.

O Prism obedece o campo ao pé da letra e simplesmente não baixa o arquivo. O
resultado é um pack que sai correto do gerador e chega quebrado no jogo,
reclamando de um mod que a própria loja mandou pular. Tudo que entrou no pack
entrou porque o cliente precisa, então tudo vai como `required`.

Do lado do servidor o filtro existe, mas não confia só no rótulo: depois de
excluir os mods de cliente, qualquer um do qual um mod mantido ainda dependa
volta para dentro.

## Sobre os bloqueios

Duas coisas alimentam o bloqueio:

- **O que os autores declaram.** A Modrinth tem um campo de incompatibilidade e a
  CurseForge tem a relação equivalente. Isso é lido direto dos metadados.
- **Conflitos conhecidos que ninguém declara.** Dois motores de renderização
  (Sodium, Embeddium, OptiFine, Canvas), dois carregadores de shader, dois
  rewrites do sistema de luz. Essa lista fica em
  [`web/compartilhado/conflitos.mjs`](web/compartilhado/conflitos.mjs) e é fácil de ampliar.

Há dois níveis. **Bloqueio** é quando o jogo não abre — a interface impede.
**Aviso** é quando funciona mas é redundante, como JEI e REI juntos — a interface
deixa passar e só explica.

O mesmo arquivo de regras roda nos dois lados: o navegador importa
`web/compartilhado/conflitos.mjs` para bloquear na hora, sem esperar o servidor,
e o servidor usa o mesmo módulo para conferir antes de gerar o arquivo.

## Publicar como site na Vercel

O projeto já vem pronto para a Vercel: o mesmo código que roda no seu PC vira
uma função (`api/index.js`) e a interface é servida como site estático.

1. Em [vercel.com](https://vercel.com), **Add New → Project** e importe o
   repositório `modpackforge` do GitHub.
2. Não mude nada nas configurações de build — o `vercel.json` já define tudo.
   Clique em **Deploy**.
3. *(Opcional)* Para a CurseForge aparecer na busca: **Settings → Environment
   Variables**, crie `CURSEFORGE_API_KEY` com a sua chave e faça um **Redeploy**.

Depois disso, todo push na branch `main` publica sozinho.

Para conferir que o site subiu, abra `https://<seu-projeto>.vercel.app/api/inicio`:
tem que aparecer um JSON com `"modo":"nuvem"`.

Para ver a interface exatamente como o site mostra, sem publicar nada:

```
set SIMULAR_SITE=1 && node server.mjs
```

### O que muda no site

| | No seu PC | No site |
|---|---|---|
| Arquivos gerados | Gravados em `packs/` e oferecidos para download | Só para download — a Vercel não tem disco |
| Chave da CurseForge | Salva pela tela de Configurações | Variável `CURSEFORGE_API_KEY`, definida por quem hospeda |
| Limite por pack | 400 mods | 150 mods |

A chave da CurseForge nunca chega ao navegador de quem visita — nem o final
dela. Todo visitante usa a cota da sua chave.

### Limites a conhecer

- **Tempo de função.** O `vercel.json` pede 60 segundos por chamada. Um pack de
  15 mods leva uns 20 segundos na primeira vez; packs muito grandes podem
  passar disso. Se acontecer, aumente `maxDuration` no `vercel.json` — o teto
  depende do seu plano.
- **O site é público e não tem limite de uso por visitante.** Cada pack gasta
  tempo de função da sua conta e centenas de chamadas às lojas. Para uso entre
  amigos isso não pesa; se o link se espalhar, vale olhar o painel de uso da
  Vercel.

## Requisitos

- **Node.js 20+** para rodar o ModpackForge (só em quem monta o pack).
- **Windows** para o `.bat` gerado. Quem recebe não precisa de Node.
- **Java** em quem recebe — ou já instalado, ou o que o launcher do Minecraft baixa.

## Estrutura

```
ModpackForge.bat      abre o app no PC
server.mjs            servidor local: arquivos estáticos e ponte para a API
verificar.mjs         confere uma pasta de mods já instalada
api/index.js          a mesma API, como função da Vercel
vercel.json           configuração do site
src/
  api.mjs                rotas e validação — o mesmo código no PC e no site
  http.mjs               cache, fila por host e retry
  modrinth.mjs           provider da Modrinth
  curseforge.mjs         provider da CurseForge
  loaders.mjs            versões e instaladores dos modloaders (cliente e servidor)
  jarmeta.mjs            lê fabric.mod.json dentro do jar via HTTP Range
  versoes.mjs            comparação de versões e faixas (Fabric e Maven)
  compatibilidade.mjs    ajusta o pack até todas as exigências fecharem
  resolver.mjs           resolve dependências e cruza os conflitos
  exportar.mjs           monta o .bat, o .mrpack e a lista
  exportar-servidor.mjs  monta o instalador de servidor
  instalador.ps1         o que roda na máquina de quem recebe
  instalador-servidor.sh o que roda na VPS
  zip.mjs                escritor de ZIP para o .mrpack
web/                  a interface
  compartilhado/conflitos.mjs  regras de incompatibilidade (navegador e servidor)
packs/                os packs gerados no PC
```

Nenhuma dependência de npm. Não existe `npm install`.
