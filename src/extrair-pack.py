# Executado pelo instalador: um ZIP aberto para todos os arquivos selecionados.
import os
import shutil
import stat
import sys
import zipfile
import zlib
from pathlib import Path


def caminho(root, nome):
    partes = nome.split('/')
    if not nome or nome.startswith('/') or '\\' in nome or any(p in ('', '.', '..') for p in partes):
        raise ValueError('Caminho invalido: ' + nome)
    destino = root.joinpath(*partes)
    if root not in destino.resolve().parents:
        raise ValueError('Caminho fora da pasta do servidor: ' + nome)
    return destino


def crc_igual(destino, entrada):
    if not destino.is_file() or destino.stat().st_size != entrada.file_size:
        return False
    crc = 0
    with destino.open('rb') as f:
        for bloco in iter(lambda: f.read(1024 * 1024), b''):
            crc = zlib.crc32(bloco, crc)
    return crc & 0xffffffff == entrada.CRC


def extrair(arquivo, pasta, backup, plano):
    root, copias = Path(pasta).resolve(), Path(backup).resolve()
    if root not in copias.parents:
        raise ValueError('Backup fora da pasta do servidor')
    selecionados = [linha.rstrip('\n').split('|') for linha in Path(plano).read_text(encoding='utf-8').splitlines() if linha]
    repetidos, pastas, reaproveitados = set(), set(), 0
    with zipfile.ZipFile(arquivo) as pack:
        if len(pack.namelist()) != len(set(pack.namelist())):
            raise ValueError('ZIP contem nomes duplicados')
        total = 0
        # Confira tudo antes de substituir o primeiro arquivo.
        for origem, nome in selecionados:
            destino = caminho(root, nome)
            if nome in repetidos:
                raise ValueError('Destino duplicado: ' + nome)
            repetidos.add(nome)
            entrada = pack.getinfo(origem)
            tipo = stat.S_IFMT(entrada.external_attr >> 16)
            if entrada.is_dir() or tipo not in (0, stat.S_IFREG) or entrada.flag_bits & 1:
                raise ValueError('Entrada ZIP nao e arquivo regular: ' + origem)
            total += entrada.file_size
            if entrada.file_size > 1024 ** 3 or total > 2 * 1024 ** 3:
                raise ValueError('Arquivos descompactados grandes demais')
        for numero, (origem, nome) in enumerate(selecionados, 1):
            entrada, destino = pack.getinfo(origem), caminho(root, nome)
            if crc_igual(destino, entrada):
                reaproveitados += 1
            else:
                if destino.parent not in pastas:
                    destino.parent.mkdir(parents=True, exist_ok=True)
                    pastas.add(destino.parent)
                parcial = destino.with_name(destino.name + '.parcial')
                try:
                    parcial.unlink(missing_ok=True)
                    with pack.open(entrada) as fonte, parcial.open('xb') as saida:
                        shutil.copyfileobj(fonte, saida, 1024 * 1024)
                    if destino.is_file() and not (nome.startswith('mods/') and nome.endswith('.jar')):
                        anterior = caminho(copias, nome)
                        if not anterior.exists():
                            anterior.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(destino, anterior)
                    os.replace(parcial, destino)
                except BaseException:
                    parcial.unlink(missing_ok=True)
                    raise
            if numero == 1 or numero % 100 == 0 or numero == len(selecionados):
                print(f'  Arquivos do pack: {numero}/{len(selecionados)} ({reaproveitados} reaproveitados)', flush=True)


try:
    extrair(*sys.argv[1:])
except Exception as erro:
    print('  Falha ao extrair o pack: ' + str(erro), file=sys.stderr)
    print('  Instalacao incompleta. Corrija o erro e rode novamente na mesma pasta.', file=sys.stderr)
    sys.exit(1)
