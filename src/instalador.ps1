# Instalador gerado pelo ModpackForge.
# Roda no PowerShell que já vem no Windows. Não instala nada no sistema:
# só baixa os mods do pack e registra um perfil no launcher oficial.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$MANIFESTO_B64 = '@@MANIFESTO@@'
$pack = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($MANIFESTO_B64)) | ConvertFrom-Json

# ConvertFrom-Json no PowerShell 5.1 desembrulha listas de um item só. Forçamos array
# para que .Count e a indexação por fatia funcionem mesmo num pack com um mod só.
$mods = @($pack.mods)
$manuais = @($pack.manuais)
$totalMods = $mods.Count

# ---------------------------------------------------------------- apresentação

function Escrever($texto, $cor = 'Gray') { Write-Host $texto -ForegroundColor $cor }
function Titulo($texto) {
  Write-Host ''
  Write-Host "  $texto" -ForegroundColor White
  Write-Host ('  ' + ('-' * $texto.Length)) -ForegroundColor DarkGray
}
function Formatar-Tamanho($bytes) {
  if ($bytes -ge 1GB) { return '{0:N1} GB' -f ($bytes / 1GB) }
  if ($bytes -ge 1MB) { return '{0:N1} MB' -f ($bytes / 1MB) }
  return '{0:N0} KB' -f ($bytes / 1KB)
}

Clear-Host
Write-Host ''
Write-Host "  $($pack.nome)" -ForegroundColor Cyan
Write-Host "  Minecraft $($pack.minecraft) - $($pack.loaderNome) $($pack.loaderVersao)" -ForegroundColor DarkCyan
Write-Host "  $($totalMods) mods - $(Formatar-Tamanho $pack.tamanhoTotal)" -ForegroundColor DarkGray
if ($pack.autor) { Write-Host "  Montado por $($pack.autor)" -ForegroundColor DarkGray }
Write-Host ''

# ------------------------------------------------------------------- destino

$raizMinecraft = Join-Path $env:APPDATA '.minecraft'
if (-not (Test-Path $raizMinecraft)) {
  Escrever "Não encontrei o Minecraft em $raizMinecraft" 'Yellow'
  $resposta = Read-Host '  Caminho da pasta .minecraft (Enter para criar nesse lugar mesmo)'
  if ($resposta) { $raizMinecraft = $resposta }
  New-Item -ItemType Directory -Path $raizMinecraft -Force | Out-Null
}

$instanciaPadrao = Join-Path (Join-Path $raizMinecraft 'modpacks') $pack.slug
Titulo 'Onde instalar'
Escrever "  O pack fica numa pasta separada, então seu Minecraft normal continua intacto."
Escrever "  Padrao: $instanciaPadrao" 'DarkGray'
$escolha = Read-Host '  Enter para aceitar, ou digite outro caminho'
$instancia = if ($escolha) { $escolha } else { $instanciaPadrao }

New-Item -ItemType Directory -Path $instancia -Force | Out-Null
$pastaMods = Join-Path $instancia 'mods'
New-Item -ItemType Directory -Path $pastaMods -Force | Out-Null

# ---------------------------------------------------------------------- Java

function Achar-Java {
  $cmd = Get-Command java.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  # O próprio launcher do Minecraft baixa um Java. Serve perfeitamente.
  $runtime = Join-Path $raizMinecraft 'runtime'
  if (Test-Path $runtime) {
    $achado = Get-ChildItem -Path $runtime -Filter 'java.exe' -Recurse -Depth 6 -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($achado) { return $achado.FullName }
  }

  $bases = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
  $sufixos = @('Eclipse Adoptium', 'Java', 'Microsoft\jdk', 'Amazon Corretto', 'Programs\Eclipse Adoptium')
  $raizes = foreach ($base in $bases) { foreach ($s in $sufixos) { Join-Path $base $s } }

  foreach ($raiz in $raizes) {
    if (-not (Test-Path $raiz)) { continue }
    $achado = Get-ChildItem -Path (Join-Path $raiz '*\bin\java.exe') -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending | Select-Object -First 1
    if ($achado) { return $achado.FullName }
  }
  return $null
}

# ------------------------------------------------------------ cliente HTTP

Add-Type -AssemblyName System.Net.Http
$manipulador = New-Object System.Net.Http.HttpClientHandler
$manipulador.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
$http = New-Object System.Net.Http.HttpClient($manipulador)
$http.Timeout = [TimeSpan]::FromMinutes(10)
$http.DefaultRequestHeaders.Add('User-Agent', 'ModpackForge-Installer/1.0')

function Baixar-Bytes($url) {
  return $http.GetByteArrayAsync($url).GetAwaiter().GetResult()
}
function Sha1-De($bytes) {
  $algoritmo = [Security.Cryptography.SHA1]::Create()
  try { return (($algoritmo.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $algoritmo.Dispose() }
}

# ------------------------------------------------------------ modloader

$pastaVersao = Join-Path (Join-Path $raizMinecraft 'versions') $pack.loaderInstalador.versionId

if (Test-Path (Join-Path $pastaVersao "$($pack.loaderInstalador.versionId).json")) {
  Titulo 'Modloader'
  Escrever "  $($pack.loaderNome) $($pack.loaderVersao) ja esta instalado." 'Green'
} else {
  Titulo 'Modloader'
  $java = Achar-Java
  if (-not $java) {
    Escrever '  Java nao encontrado.' 'Red'
    Escrever '  Abra o Minecraft uma vez (o launcher baixa o Java sozinho) e rode este arquivo de novo,'
    Escrever '  ou instale o Java 21 em https://adoptium.net'
    Write-Host ''
    Read-Host '  Enter para sair'
    exit 1
  }
  Escrever "  Java: $java" 'DarkGray'

  # O instalador do Forge exige que esse arquivo exista antes de rodar.
  $perfis = Join-Path $raizMinecraft 'launcher_profiles.json'
  if (-not (Test-Path $perfis)) {
    '{"profiles":{},"version":3}' | Set-Content -Path $perfis -Encoding UTF8
  }

  $jarTemp = Join-Path $env:TEMP $pack.loaderInstalador.arquivo
  Escrever "  Baixando o instalador do $($pack.loaderNome)..."
  [IO.File]::WriteAllBytes($jarTemp, (Baixar-Bytes $pack.loaderInstalador.url))

  $argumentos = @($pack.loaderInstalador.argumentos | ForEach-Object { $_ -replace '\{MC_DIR\}', $raizMinecraft })
  Escrever "  Instalando..."

  # Capturar a saida de um .exe nativo com 2>&1 vira erro terminante enquanto
  # ErrorActionPreference for Stop. Soltamos a preferencia so durante a chamada.
  $preferenciaAnterior = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'

  # Os instaladores do Forge e do NeoForge escrevem um .log na pasta de trabalho.
  # Entramos no TEMP antes de chamar para nao sujar a pasta de onde o arquivo foi aberto.
  Push-Location $env:TEMP
  try {
    $saida = & $java '-jar' $jarTemp @argumentos 2>&1
    $codigo = $LASTEXITCODE

    # NeoForge trocou o nome do parametro entre versoes. Se falhou, tenta a outra grafia.
    if ($codigo -ne 0 -and $pack.loaderInstalador.tipo -eq 'neoforge') {
      $alternativos = @($argumentos | ForEach-Object { $_ -replace '^--installClient$', '--install-client' })
      $saida = & $java '-jar' $jarTemp @alternativos 2>&1
      $codigo = $LASTEXITCODE
    }
  } finally {
    Pop-Location
    $ErrorActionPreference = $preferenciaAnterior
  }

  Get-ChildItem (Join-Path $env:TEMP '*-installer.jar.log') -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

  Remove-Item $jarTemp -Force -ErrorAction SilentlyContinue

  if ($codigo -ne 0) {
    Escrever '  O instalador do modloader falhou:' 'Red'
    $saida | Select-Object -Last 12 | ForEach-Object { Escrever "    $_" 'DarkRed' }
    Write-Host ''
    Read-Host '  Enter para sair'
    exit 1
  }
  Escrever "  $($pack.loaderNome) $($pack.loaderVersao) instalado." 'Green'
}

# ---------------------------------------------------------------------- mods

Titulo "Mods ($($totalMods))"

$registro = Join-Path $instancia '.modpackforge.json'
$anteriores = @()
if (Test-Path $registro) {
  try { $anteriores = (Get-Content $registro -Raw | ConvertFrom-Json).arquivos } catch { $anteriores = @() }
}

$esperados = @($pack.mods | ForEach-Object { $_.arquivo })
$baixados = 0
$reaproveitados = 0
$falhas = @()
$indice = 0
# Nomes de variavel no PowerShell nao diferenciam maiusculas, entao um contador
# e uma fatia so podem ter nomes que difiram por mais do que a caixa das letras.
$porVez = 6

for ($inicio = 0; $inicio -lt $totalMods; $inicio += $porVez) {
  $fatia = $mods[$inicio..([Math]::Min($inicio + $porVez - 1, $totalMods - 1))]
  $pendentes = @()

  foreach ($mod in $fatia) {
    $destino = Join-Path $pastaMods $mod.arquivo
    $indice++

    if (Test-Path $destino) {
      $existente = [IO.File]::ReadAllBytes($destino)
      if (-not $mod.sha1 -or (Sha1-De $existente) -eq $mod.sha1) {
        Write-Host ("  [{0,3}/{1}] " -f $indice, $totalMods) -NoNewline -ForegroundColor DarkGray
        Write-Host $mod.nome -NoNewline
        Write-Host '  ja estava aqui' -ForegroundColor DarkGray
        $reaproveitados++
        continue
      }
    }
    $pendentes += [pscustomobject]@{
      mod     = $mod
      destino = $destino
      posicao = $indice
      tarefa  = $http.GetByteArrayAsync($mod.url)
    }
  }

  foreach ($p in $pendentes) {
    Write-Host ("  [{0,3}/{1}] " -f $p.posicao, $totalMods) -NoNewline -ForegroundColor DarkGray
    Write-Host $p.mod.nome -NoNewline
    try {
      $bytes = $p.tarefa.GetAwaiter().GetResult()
      if ($p.mod.sha1) {
        $obtido = Sha1-De $bytes
        if ($obtido -ne $p.mod.sha1) { throw "arquivo corrompido (sha1 $obtido)" }
      }
      [IO.File]::WriteAllBytes($p.destino, $bytes)
      Write-Host '  ok' -ForegroundColor Green
      $baixados++
    } catch {
      Write-Host '  falhou' -ForegroundColor Red
      $falhas += [pscustomobject]@{ nome = $p.mod.nome; motivo = $_.Exception.Message; pagina = $p.mod.pagina }
    }
  }
}

# Tira da pasta o que este instalador colocou antes e o pack nao usa mais.
$removidos = 0
foreach ($antigo in $anteriores) {
  if ($esperados -notcontains $antigo) {
    $caminho = Join-Path $pastaMods $antigo
    if (Test-Path $caminho) { Remove-Item $caminho -Force -ErrorAction SilentlyContinue; $removidos++ }
  }
}

@{
  pack     = $pack.nome
  versao   = $pack.versaoDoPack
  gerado   = $pack.criadoEm
  aplicado = (Get-Date).ToString('o')
  arquivos = $esperados
} | ConvertTo-Json -Depth 5 | Set-Content -Path $registro -Encoding UTF8

# -------------------------------------------------------- perfil no launcher

Titulo 'Perfil no launcher'
$arquivoPerfis = Join-Path $raizMinecraft 'launcher_profiles.json'
try {
  $perfis = if (Test-Path $arquivoPerfis) {
    Get-Content $arquivoPerfis -Raw -Encoding UTF8 | ConvertFrom-Json
  } else {
    [pscustomobject]@{ profiles = [pscustomobject]@{}; version = 3 }
  }
  if (-not $perfis.profiles) {
    $perfis | Add-Member -NotePropertyName 'profiles' -NotePropertyValue ([pscustomobject]@{}) -Force
  }

  $idPerfil = 'modpackforge-' + $pack.slug
  $agora = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $perfil = [pscustomobject]@{
    name          = $pack.nome
    type          = 'custom'
    created       = $agora
    lastUsed      = $agora
    lastVersionId = $pack.loaderInstalador.versionId
    gameDir       = $instancia
    javaArgs      = "-Xmx$($pack.memoriaMb)M -Xms1024M -XX:+UseG1GC"
    icon          = 'Crafting_Table'
  }
  $perfis.profiles | Add-Member -NotePropertyName $idPerfil -NotePropertyValue $perfil -Force
  $perfis | ConvertTo-Json -Depth 20 | Set-Content -Path $arquivoPerfis -Encoding UTF8
  Escrever "  Perfil `"$($pack.nome)`" criado no launcher." 'Green'
  Escrever "  Se o launcher estiver aberto, feche e abra de novo para ele aparecer." 'DarkGray'
} catch {
  Escrever "  Nao consegui escrever o perfil: $($_.Exception.Message)" 'Yellow'
  Escrever "  Crie um perfil manualmente com a versao $($pack.loaderInstalador.versionId)" 'Yellow'
  Escrever "  e a pasta de jogo $instancia" 'Yellow'
}

# ------------------------------------------------------------------- resumo

Titulo 'Pronto'
Escrever "  $baixados baixados, $reaproveitados ja estavam na pasta, $removidos removidos." 'Green'
Escrever "  Pasta do pack: $instancia" 'DarkGray'

if ($falhas.Count) {
  Write-Host ''
  Escrever "  $($falhas.Count) mods falharam:" 'Red'
  foreach ($f in $falhas) {
    Escrever "    $($f.nome) - $($f.motivo)" 'DarkRed'
    if ($f.pagina) { Escrever "      $($f.pagina)" 'DarkGray' }
  }
  Escrever '  Rode este arquivo de novo: ele so tenta os que faltaram.' 'Yellow'
}

if ($manuais.Count -gt 0) {
  Write-Host ''
  Escrever "  $($manuais.Count) mods precisam de download manual." 'Yellow'
  Escrever '  O autor desativou o download automatico na CurseForge.' 'DarkGray'
  Escrever "  Baixe o .jar de cada pagina abaixo e jogue em $pastaMods" 'DarkGray'
  foreach ($m in $manuais) {
    Escrever "    $($m.nome)" 'White'
    Escrever "      $($m.pagina)" 'DarkGray'
  }
  Write-Host ''
  $abrir = Read-Host '  Abrir essas paginas no navegador? (s/N)'
  if ($abrir -match '^[sSyY]') { foreach ($m in $manuais) { Start-Process $m.pagina } }
}

Write-Host ''
Escrever '  Abra o launcher do Minecraft e escolha o perfil ' -cor 'White'
Escrever "  $($pack.nome)" 'Cyan'
Write-Host ''
$http.Dispose()
Read-Host '  Enter para fechar'
