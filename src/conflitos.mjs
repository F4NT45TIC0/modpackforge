// As regras de conflito moram em web/compartilhado/ porque o navegador também
// as importa: a interface bloqueia um mod na hora, sem ir ao servidor, e o
// servidor confere de novo com exatamente o mesmo código.
//
// Ficando entre os arquivos estáticos, o mesmo arquivo é servido tanto pelo
// servidor local quanto pela Vercel, sem cópia e sem caso especial.

export * from '../web/compartilhado/conflitos.mjs';
