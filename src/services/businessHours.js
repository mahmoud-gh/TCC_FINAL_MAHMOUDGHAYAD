const WEEKDAY_TO_ISO = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DIAS = ['', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo'];
const PASSO_MS = 5 * 60 * 1000; // resolução de 5 minutos
const LIMITE_PASSOS = (8 * 24 * 60) / 5; // procura até 8 dias

const config = () => ({
  timeZone: process.env.BUSINESS_TIMEZONE || 'America/Asuncion',
  days: (process.env.BUSINESS_DAYS || '1,2,3,4,5,6').split(',').map((d) => Number(d.trim())),
  start: process.env.BUSINESS_HOURS_START || '08:00',
  end: process.env.BUSINESS_HOURS_END || '16:00',
});

function getLocalParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    isoWeekday: WEEKDAY_TO_ISO[parts.weekday],
    hhmm: `${parts.hour}:${parts.minute}`,
    dia: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function isWithinBusinessHours(date = new Date()) {
  const { timeZone, days, start, end } = config();
  const { isoWeekday, hhmm } = getLocalParts(date, timeZone);
  if (!days.includes(isoWeekday)) return false;
  return hhmm >= start && hhmm < end;
}

// Primeiro instante (em passos de 5 min) em que a loja estará aberta.
function dataProximaAbertura(date = new Date()) {
  const base = new Date(Math.ceil(date.getTime() / PASSO_MS) * PASSO_MS);
  for (let i = 0; i <= LIMITE_PASSOS; i += 1) {
    const t = new Date(base.getTime() + i * PASSO_MS);
    if (isWithinBusinessHours(t)) return t;
  }
  return null;
}

// Instante em que a loja fechou pela última vez (início do período fechado).
function dataUltimoFechamento(date = new Date()) {
  const base = new Date(Math.floor(date.getTime() / PASSO_MS) * PASSO_MS);
  for (let i = 0; i <= LIMITE_PASSOS; i += 1) {
    const t = new Date(base.getTime() - i * PASSO_MS);
    if (isWithinBusinessHours(t)) return new Date(t.getTime() + PASSO_MS);
  }
  return new Date(date.getTime() - 24 * 3600 * 1000);
}

// Texto amigável: "hoje às 07:00", "amanhã às 07:00", "segunda-feira às 07:00".
function proximaAbertura(date = new Date()) {
  const t = dataProximaAbertura(date);
  if (!t) return 'no próximo horário de atendimento';
  const { timeZone } = config();
  const agora = getLocalParts(date, timeZone);
  const quando = getLocalParts(t, timeZone);
  const amanha = getLocalParts(new Date(date.getTime() + 24 * 3600 * 1000), timeZone);
  let dia = DIAS[quando.isoWeekday];
  if (quando.dia === agora.dia) dia = 'hoje';
  else if (quando.dia === amanha.dia) dia = 'amanhã';
  return `${dia} às ${quando.hhmm}`;
}
proximaAbertura.data = dataProximaAbertura;

// "segunda a sexta, das 07:00 às 15:30" — usado nas respostas do chatbot.
const NOMES_CURTOS = ['', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
function descreverHorario() {
  const { days, start, end } = config();
  const d = [...new Set(days)].filter((x) => x >= 1 && x <= 7).sort((a, b) => a - b);
  const seguidos = d.length > 1 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  let dias;
  if (!d.length) dias = 'sem dias definidos';
  else if (d.length === 7) dias = 'todos os dias';
  else if (seguidos) dias = `${NOMES_CURTOS[d[0]]} a ${NOMES_CURTOS[d[d.length - 1]]}`;
  else dias = d.map((x) => NOMES_CURTOS[x]).join(', ').replace(/, ([^,]*)$/, ' e $1');
  return `${dias}, das ${start} às ${end}`;
}

module.exports = { isWithinBusinessHours, proximaAbertura, dataProximaAbertura, dataUltimoFechamento, descreverHorario };
