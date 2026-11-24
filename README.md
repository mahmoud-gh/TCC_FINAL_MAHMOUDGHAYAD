# CRM WhatsApp — TCC (API oficial da Meta)

CRM de atendimento e marketing pelo **WhatsApp Business Cloud API** (oficial da Meta):
inbox da equipe, chatbot de estoque fora do horário, contatos com consentimento (LGPD),
segmentos, modelos aprovados pela Meta, campanhas agendadas e métricas
(entrega, leitura, resposta, clique e conversão).

## Requisitos

- Node.js 22.5 ou mais novo
- PostgreSQL 16 com o banco `crm` (dono: usuário `crm`)
- App na Meta com o produto WhatsApp e um número configurado
- Cloudflare Tunnel apontando um domínio para `http://localhost:3000`

## Instalação (uma vez)

No PowerShell, dentro desta pasta:

```powershell
npm install
npm run migrate
npm run sync-products
node scripts/create-user.js mahmoud SUA_SENHA "Mahmoud" admin
```

O `.env` já vem preenchido. Se precisar recriar, copie o `.env.example`
(`copy .env.example .env`) e preencha.

Se o banco ainda não existir, crie no pgAdmin ou no psql: `CREATE DATABASE crm OWNER crm;`

## Ligar

```powershell
npm run dev
cloudflared tunnel run crm-atendimento
```

- Atendimento: http://localhost:3000
- Marketing: http://localhost:3000/marketing.html

## Configurar o webhook na Meta (uma vez)

developers.facebook.com → seu App → **WhatsApp → Configuração → Webhook**:

| Campo | Valor |
|---|---|
| URL de callback | `https://SEU_DOMINIO/webhooks/meta` |
| Verificar token | o mesmo `META_VERIFY_TOKEN` do `.env` |
| Campos assinados | `messages` |

Use um **token permanente** de Usuário do Sistema em `WHATSAPP_ACCESS_TOKEN`
(o token temporário do painel expira em 24 h).

## Como funcionam as campanhas com a API oficial

1. Crie o modelo no **WhatsApp Manager** e espere a Meta aprovar.
2. No painel, aba **Modelos**, cadastre com **o mesmo nome** e o mesmo texto,
   usando `{{1}}`, `{{2}}`… nos campos personalizados.
3. Clique em **Sincronizar com a Meta**: a situação (aprovado, pendente, rejeitado)
   vem da sua conta. Só modelos aprovados disparam.
4. Crie a campanha. Ela só envia para contatos com **opt-in** registrado.
   Agendadas saem sozinhas; também dá para usar o botão **Disparar**.

Respostas do inbox e do chatbot são texto livre: a Meta só aceita dentro de
**24 h** desde a última mensagem do cliente. Fora disso, só modelos aprovados.

## Testar sem gastar mensagens

- Os testes automáticos não enviam nada à Meta e devem terminar com **Tudo certo** / sem falhas:
  ```powershell
  npm run test:chatbot
  npm run test:db
  ```
- Com `WHATSAPP_ACCESS_TOKEN` vazio, os envios só aparecem no terminal (modo simulado).
- Simular uma mensagem chegando (com o servidor ligado):
  `node scripts/simulate-whatsapp-webhook.js "tem iphone 17?" 5545999999999`

## Outros comandos

| Comando | Para quê |
|---|---|
| `npm run import-contacts -- contatos.csv` | Importa contatos (CSV ou .vcf), sem opt-in |
| `npm run importar-produtos -- produtos.csv` | Importa produtos de uma planilha |
| `npm run exportar` | Exporta os dados das campanhas em CSV |
| `npm run db:status` | Resumo do banco |
| `npm run testar-ia` | Testa a chave da Anthropic (chatbot com IA) |

## Cuidado

O `.env` tem as chaves da Meta e da Anthropic. Não envie esta pasta com o `.env`
para outras pessoas nem suba para o GitHub.
