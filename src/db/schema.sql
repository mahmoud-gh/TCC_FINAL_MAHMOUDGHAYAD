-- ===========================================================================
-- Esquema completo — PostgreSQL 16
-- Equivalente a src/db/schema.sql + schema-marketing.sql (dialeto SQLite).
-- Aplicado por `npm run migrate` quando DB_CLIENT=postgres.
--
-- Os domínios restritos usam TEXT + CHECK, e não tipos ENUM: a semântica é a
-- mesma, mas CHECK aceita parâmetros não tipados nas consultas da aplicação
-- (ex.: `situacao = COALESCE($1, situacao)`), mantendo uma única versão do SQL
-- para os dois bancos. Os sinalizadores booleanos são INTEGER (0/1) pelo mesmo
-- motivo de paridade.
-- ===========================================================================

-- ------------------------------------------------------------ atendimento --
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin','agent')),
  color         TEXT NOT NULL DEFAULT '#999999',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id                  SERIAL PRIMARY KEY,
  platform            TEXT NOT NULL CHECK (platform IN ('whatsapp','instagram')),
  platform_user_id    TEXT NOT NULL,
  display_name        TEXT,
  phone               TEXT,
  profile_pic_url     TEXT,
  perfil              TEXT,
  interesse_declarado TEXT,
  nivel_engajamento   TEXT,
  ultima_interacao    TIMESTAMPTZ,
  anonimizado         INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id                SERIAL PRIMARY KEY,
  contact_id        INTEGER NOT NULL REFERENCES contacts(id),
  platform          TEXT NOT NULL CHECK (platform IN ('whatsapp','instagram')),
  status            TEXT NOT NULL DEFAULT 'novo'
                    CHECK (status IN ('novo','em_conversa','orcamento_enviado','fechado','perdido')),
  unread_count      INTEGER NOT NULL DEFAULT 0,
  last_message_at   TIMESTAMPTZ,
  window_expires_at TIMESTAMPTZ,
  assigned_user_id  INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id                  SERIAL PRIMARY KEY,
  conversation_id     INTEGER NOT NULL REFERENCES conversations(id),
  direction           TEXT NOT NULL CHECK (direction IN ('in','out')),
  platform_message_id TEXT,
  message_type        TEXT NOT NULL DEFAULT 'text',
  content             TEXT,
  media_url           TEXT,
  status              TEXT DEFAULT 'received',
  origin              TEXT CHECK (origin IN ('human','bot','ai')),
  raw_payload         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notes (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tags (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#999999'
);

CREATE TABLE IF NOT EXISTS conversation_tags (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  tag_id          INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (conversation_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_assigned ON conversations(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_platform_id ON messages(platform_message_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status, last_message_at DESC);

-- --------------------------------------------------- automação e catálogo --
CREATE TABLE IF NOT EXISTS flows (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 0,
  trigger_type   TEXT NOT NULL DEFAULT 'first_message'
                 CHECK (trigger_type IN ('first_message','manual')),
  trigger_config TEXT,
  graph_json     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flow_runs (
  id              SERIAL PRIMARY KEY,
  flow_id         INTEGER NOT NULL REFERENCES flows(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  current_node_id TEXT,
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','waiting_reply','paused','stopped','completed','failed')),
  resume_at       TIMESTAMPTZ,
  context_json    TEXT NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flow_run_events (
  id            SERIAL PRIMARY KEY,
  flow_run_id   INTEGER NOT NULL REFERENCES flow_runs(id),
  node_id       TEXT NOT NULL,
  node_type     TEXT NOT NULL,
  event         TEXT NOT NULL,
  branch_output TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY,
  codigo          TEXT,
  name            TEXT NOT NULL,
  price           DOUBLE PRECISION,
  wholesale_price DOUBLE PRECISION,
  stock           INTEGER,
  category_name   TEXT,
  brand_name      TEXT,
  description     TEXT,
  image_url       TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_runs_conversa ON flow_runs(conversation_id, status);

-- --------------------------------------------------------- RF02 consentimento
CREATE TABLE IF NOT EXISTS consentimentos (
  id             SERIAL PRIMARY KEY,
  contact_id     INTEGER NOT NULL REFERENCES contacts(id),
  tipo           TEXT NOT NULL CHECK (tipo IN ('opt_in','opt_out')),
  finalidade     TEXT NOT NULL,
  origem         TEXT NOT NULL,
  observacao     TEXT,
  registrado_por INTEGER REFERENCES users(id),
  data_hora      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consentimentos_contato
  ON consentimentos(contact_id, data_hora DESC);

-- Imutabilidade do histórico de consentimento (auditoria da cadeia de opt-in).
CREATE OR REPLACE FUNCTION fn_consentimento_imutavel() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Consentimento e imutavel: registre uma nova manifestacao.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_consentimentos_imutavel ON consentimentos;
CREATE TRIGGER trg_consentimentos_imutavel
BEFORE UPDATE OR DELETE ON consentimentos
FOR EACH ROW EXECUTE FUNCTION fn_consentimento_imutavel();

-- ------------------------------------------------------- RF03 segmentação --
CREATE TABLE IF NOT EXISTS segmentos (
  id         SERIAL PRIMARY KEY,
  nome       TEXT NOT NULL UNIQUE,
  descricao  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS regras_segmentacao (
  id               SERIAL PRIMARY KEY,
  segmento_id      INTEGER NOT NULL REFERENCES segmentos(id),
  atributo         TEXT NOT NULL,
  operador         TEXT NOT NULL,
  valor_referencia TEXT,
  ordem            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_regras_segmento ON regras_segmentacao(segmento_id);

-- ------------------------------------------------------------ RF04 modelos --
CREATE TABLE IF NOT EXISTS modelos_mensagem (
  id                 SERIAL PRIMARY KEY,
  nome               TEXT NOT NULL UNIQUE,
  idioma             TEXT NOT NULL DEFAULT 'pt_BR',
  corpo              TEXT NOT NULL,
  parametros         TEXT NOT NULL DEFAULT '[]',
  situacao_aprovacao TEXT NOT NULL DEFAULT 'rascunho'
                     CHECK (situacao_aprovacao IN ('rascunho','pendente','aprovado','rejeitado')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------- RF05 campanhas --
CREATE TABLE IF NOT EXISTS campanhas (
  id          SERIAL PRIMARY KEY,
  nome        TEXT NOT NULL,
  segmento_id INTEGER NOT NULL REFERENCES segmentos(id),
  modelo_id   INTEGER NOT NULL REFERENCES modelos_mensagem(id),
  cenario     TEXT NOT NULL CHECK (cenario IN ('manual','automatizado')),
  agendamento TIMESTAMPTZ,
  url_destino TEXT,
  situacao    TEXT NOT NULL DEFAULT 'rascunho'
              CHECK (situacao IN ('rascunho','agendada','em_execucao','concluida','cancelada')),
  criado_por  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campanhas_agendamento ON campanhas(situacao, agendamento);

-- -------------------------------------------------------------- RF08 envios --
CREATE TABLE IF NOT EXISTS envios (
  id              SERIAL PRIMARY KEY,
  campanha_id     INTEGER NOT NULL REFERENCES campanhas(id),
  contact_id      INTEGER NOT NULL REFERENCES contacts(id),
  message_id      INTEGER REFERENCES messages(id),
  id_api          TEXT UNIQUE,
  conteudo        TEXT,
  situacao        TEXT NOT NULL CHECK (situacao IN ('enviado','falha','nao_elegivel')),
  motivo          TEXT,
  data_hora_envio TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campanha_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_envios_campanha ON envios(campanha_id, situacao);
CREATE INDEX IF NOT EXISTS idx_envios_contato ON envios(contact_id, data_hora_envio DESC);

CREATE TABLE IF NOT EXISTS links_rastreados (
  id          SERIAL PRIMARY KEY,
  envio_id    INTEGER NOT NULL REFERENCES envios(id),
  token       TEXT NOT NULL UNIQUE,
  url_destino TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_links_envio ON links_rastreados(envio_id);

-- -------------------------------------------------------------- RF09 eventos --
CREATE TABLE IF NOT EXISTS eventos_interacao (
  id            SERIAL PRIMARY KEY,
  envio_id      INTEGER REFERENCES envios(id),
  campanha_id   INTEGER REFERENCES campanhas(id),
  contact_id    INTEGER NOT NULL REFERENCES contacts(id),
  link_id       INTEGER REFERENCES links_rastreados(id),
  tipo          TEXT NOT NULL
                CHECK (tipo IN ('enviado','entregue','lido','resposta','clique','falha','opt_out')),
  id_evento_api TEXT NOT NULL UNIQUE,
  payload       TEXT,
  data_hora     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eventos_campanha ON eventos_interacao(campanha_id, tipo);
CREATE INDEX IF NOT EXISTS idx_eventos_envio ON eventos_interacao(envio_id, tipo);

CREATE TABLE IF NOT EXISTS conversoes (
  id             SERIAL PRIMARY KEY,
  envio_id       INTEGER NOT NULL UNIQUE REFERENCES envios(id),
  campanha_id    INTEGER NOT NULL REFERENCES campanhas(id),
  contact_id     INTEGER NOT NULL REFERENCES contacts(id),
  valor          DOUBLE PRECISION,
  origem         TEXT NOT NULL CHECK (origem IN ('manual','resposta_qualificada')),
  observacao     TEXT,
  registrado_por INTEGER REFERENCES users(id),
  data_hora      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversoes_campanha ON conversoes(campanha_id);

-- ------------------------------------------------------------- RF10 métricas --
CREATE TABLE IF NOT EXISTS metricas_campanha (
  campanha_id          INTEGER PRIMARY KEY REFERENCES campanhas(id),
  total_elegiveis      INTEGER NOT NULL DEFAULT 0,
  total_enviados       INTEGER NOT NULL DEFAULT 0,
  total_entregues      INTEGER NOT NULL DEFAULT 0,
  total_lidos          INTEGER NOT NULL DEFAULT 0,
  total_respostas      INTEGER NOT NULL DEFAULT 0,
  total_cliques        INTEGER NOT NULL DEFAULT 0,
  total_conversoes     INTEGER NOT NULL DEFAULT 0,
  taxa_resposta        DOUBLE PRECISION NOT NULL DEFAULT 0,
  taxa_clique          DOUBLE PRECISION NOT NULL DEFAULT 0,
  taxa_conversao       DOUBLE PRECISION NOT NULL DEFAULT 0,
  tempo_medio_resposta DOUBLE PRECISION,
  calculado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ RF11 execuções --
CREATE TABLE IF NOT EXISTS registros_execucao_fluxo (
  id          SERIAL PRIMARY KEY,
  fluxo       TEXT NOT NULL,
  campanha_id INTEGER REFERENCES campanhas(id),
  inicio      TIMESTAMPTZ NOT NULL DEFAULT now(),
  fim         TIMESTAMPTZ,
  resultado   TEXT,
  detalhe     TEXT
);
CREATE INDEX IF NOT EXISTS idx_registros_campanha
  ON registros_execucao_fluxo(campanha_id, inicio DESC);

-- ----------------------------------------------------- gatilhos de updated_at
CREATE OR REPLACE FUNCTION fn_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contacts_updated ON contacts;
CREATE TRIGGER trg_contacts_updated BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_conversations_updated ON conversations;
CREATE TRIGGER trg_conversations_updated BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_segmentos_updated ON segmentos;
CREATE TRIGGER trg_segmentos_updated BEFORE UPDATE ON segmentos
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_modelos_updated ON modelos_mensagem;
CREATE TRIGGER trg_modelos_updated BEFORE UPDATE ON modelos_mensagem
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_campanhas_updated ON campanhas;
CREATE TRIGGER trg_campanhas_updated BEFORE UPDATE ON campanhas
  FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- Contato anonimizado não recebe envio novo.
CREATE OR REPLACE FUNCTION fn_bloqueia_envio_anonimizado() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.situacao = 'enviado'
     AND (SELECT anonimizado FROM contacts WHERE id = NEW.contact_id) = 1 THEN
    RAISE EXCEPTION 'Contato anonimizado nao pode receber envios.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_envio_contato_anonimizado ON envios;
CREATE TRIGGER trg_envio_contato_anonimizado
BEFORE INSERT ON envios FOR EACH ROW EXECUTE FUNCTION fn_bloqueia_envio_anonimizado();

-- -------------------------------------------------- interesses dos contatos --
-- Catálogo de interesses criado pelo lojista e marcação por contato. O texto
-- contacts.interesse_declarado ("câmeras, iPhone") é gerado a partir daqui
-- (src/services/interesses.js), para a segmentação e os modelos continuarem iguais.
CREATE TABLE IF NOT EXISTS interesses (
  id         SERIAL PRIMARY KEY,
  nome       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_interesses_nome ON interesses (lower(nome));
CREATE TABLE IF NOT EXISTS contato_interesses (
  contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  interesse_id INTEGER NOT NULL REFERENCES interesses(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, interesse_id)
);
CREATE INDEX IF NOT EXISTS idx_contato_interesses_interesse ON contato_interesses (interesse_id);
