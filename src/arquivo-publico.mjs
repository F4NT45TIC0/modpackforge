// URLs dentro de modpacks publicados podem apontar para hospedagens externas.
// Valida e fixa o IP da conexao para impedir acesso a servicos da rede privada.
import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';

const privados = new BlockList();
for (const [rede, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) privados.addSubnet(rede, bits, 'ipv4');
for (const [rede, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) privados.addSubnet(rede, bits, 'ipv6');
const dns = new Map();
const conferir = (ip) => {
  if (!isIP(ip) || privados.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4')) throw new Error('O JAR aponta para endereco de rede privada.');
};

async function enderecos(host) {
  let item = dns.get(host);
  if (!item || item.expira < Date.now()) {
    item = { expira: Date.now() + 30000, promessa: lookup(host, { all: true }).then((lista) => {
      if (!lista.length) throw new Error('Endereco do JAR indisponivel');
      lista.forEach((r) => conferir(r.address));
      return lista;
    }) };
    dns.set(host, item);
    if (dns.size > 512) dns.delete(dns.keys().next().value);
  }
  return item.promessa;
}

export async function buscarArquivoPublico(url, opcoes = {}, redirecionamentos = 0) {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol !== 'https:' || u.username || u.password || /^(localhost|.*\.local)$/i.test(host)) throw new Error('Endereco publico de JAR invalido.');
  if (isIP(host)) conferir(host);
  const resposta = await new Promise((resolve, reject) => {
    const req = request(u, {
      method: opcoes.method ?? 'GET', headers: opcoes.headers, signal: opcoes.signal,
      lookup: (nome, opts, cb) => enderecos(nome).then((lista) => {
        const elegiveis = opts.family ? lista.filter((r) => r.family === opts.family) : lista;
        if (!elegiveis.length) throw new Error('Familia de IP indisponivel');
        if (opts.all) cb(null, elegiveis);
        else { const escolhido = elegiveis.find((r) => r.family === 4) ?? elegiveis[0]; cb(null, escolhido.address, escolhido.family); }
      }).catch((e) => cb(e)),
    }, (res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const semCorpo = opcoes.method === 'HEAD' || [204, 304].includes(res.statusCode);
      if (semCorpo) res.resume();
      resolve(new Response(semCorpo ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
    });
    req.on('error', reject); req.end();
  });
  if ([301, 302, 303, 307, 308].includes(resposta.status)) {
    await resposta.body?.cancel();
    if (redirecionamentos >= 5 || !resposta.headers.get('location')) throw new Error('Redirecionamento de JAR invalido');
    return buscarArquivoPublico(new URL(resposta.headers.get('location'), u).href, opcoes, redirecionamentos + 1);
  }
  return resposta;
}
