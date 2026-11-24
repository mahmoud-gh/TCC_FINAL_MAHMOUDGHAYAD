-- Visões — PostgreSQL. Equivalentes às de src/db/schema-views.sql.

CREATE OR REPLACE VIEW vw_consentimento_atual AS
SELECT c.id AS contact_id, c.display_name, c.phone, c.perfil, c.interesse_declarado,
       c.nivel_engajamento, c.ultima_interacao, c.anonimizado,
       k.tipo AS consentimento_atual, k.data_hora AS consentimento_em, k.origem AS consentimento_origem,
       (SELECT COUNT(*) FROM consentimentos x WHERE x.contact_id = c.id) AS total_manifestacoes,
       CASE WHEN k.tipo = 'opt_in' AND c.anonimizado = 0 THEN 1 ELSE 0 END AS elegivel
FROM contacts c
LEFT JOIN LATERAL (
  SELECT tipo, data_hora, origem FROM consentimentos
  WHERE contact_id = c.id ORDER BY data_hora DESC, id DESC LIMIT 1
) k ON TRUE;

CREATE OR REPLACE VIEW vw_auditoria_consentimento AS
SELECT k.id, k.contact_id, c.display_name, c.phone, k.tipo, k.finalidade, k.origem,
       k.observacao, k.data_hora, u.name AS registrado_por
FROM consentimentos k
JOIN contacts c ON c.id = k.contact_id
LEFT JOIN users u ON u.id = k.registrado_por;

CREATE OR REPLACE VIEW vw_campanha_desempenho AS
SELECT base.*,
  ROUND((base.respostas::numeric  / NULLIF(base.enviados, 0)), 4)::float8 AS taxa_resposta,
  ROUND((base.cliques::numeric    / NULLIF(base.enviados, 0)), 4)::float8 AS taxa_clique,
  ROUND((base.conversoes::numeric / NULLIF(base.enviados, 0)), 4)::float8 AS taxa_conversao,
  ROUND((base.entregues::numeric  / NULLIF(base.enviados, 0)), 4)::float8 AS taxa_entrega,
  ROUND((base.lidos::numeric      / NULLIF(base.enviados, 0)), 4)::float8 AS taxa_leitura
FROM (
  SELECT c.id AS campanha_id, c.nome AS campanha, c.cenario, c.situacao,
    s.nome AS segmento, m.nome AS modelo, c.created_at,
    (SELECT COUNT(*) FROM envios e WHERE e.campanha_id = c.id AND e.situacao = 'enviado')::int AS enviados,
    (SELECT COUNT(*) FROM envios e WHERE e.campanha_id = c.id AND e.situacao = 'nao_elegivel')::int AS bloqueados_sem_consentimento,
    (SELECT COUNT(*) FROM envios e WHERE e.campanha_id = c.id AND e.situacao = 'falha')::int AS falhas,
    (SELECT COUNT(DISTINCT ev.envio_id) FROM eventos_interacao ev WHERE ev.campanha_id = c.id AND ev.tipo = 'entregue')::int AS entregues,
    (SELECT COUNT(DISTINCT ev.envio_id) FROM eventos_interacao ev WHERE ev.campanha_id = c.id AND ev.tipo = 'lido')::int AS lidos,
    (SELECT COUNT(DISTINCT ev.envio_id) FROM eventos_interacao ev WHERE ev.campanha_id = c.id AND ev.tipo = 'resposta')::int AS respostas,
    (SELECT COUNT(DISTINCT ev.envio_id) FROM eventos_interacao ev WHERE ev.campanha_id = c.id AND ev.tipo = 'clique')::int AS cliques,
    (SELECT COUNT(*) FROM conversoes cv WHERE cv.campanha_id = c.id)::int AS conversoes,
    (SELECT COALESCE(SUM(cv.valor), 0) FROM conversoes cv WHERE cv.campanha_id = c.id) AS valor_convertido,
    (SELECT ROUND(AVG(seg)::numeric, 2)::float8 FROM (
       SELECT EXTRACT(EPOCH FROM (MIN(ev.data_hora) - en.data_hora_envio)) AS seg
       FROM eventos_interacao ev
       JOIN envios en ON en.id = ev.envio_id
       WHERE ev.campanha_id = c.id AND ev.tipo = 'resposta' AND en.situacao = 'enviado'
       GROUP BY ev.envio_id, en.data_hora_envio) t) AS tempo_medio_resposta_seg
  FROM campanhas c
  JOIN segmentos s ON s.id = c.segmento_id
  JOIN modelos_mensagem m ON m.id = c.modelo_id
) base;

CREATE OR REPLACE VIEW vw_comparativo_cenario AS
SELECT ag.*,
  ROUND((ag.respostas::numeric  / NULLIF(ag.enviados, 0)), 4)::float8 AS taxa_resposta,
  ROUND((ag.cliques::numeric    / NULLIF(ag.enviados, 0)), 4)::float8 AS taxa_clique,
  ROUND((ag.conversoes::numeric / NULLIF(ag.enviados, 0)), 4)::float8 AS taxa_conversao
FROM (
  SELECT cenario, COUNT(*)::int AS campanhas,
    SUM(enviados)::int AS enviados, SUM(entregues)::int AS entregues, SUM(lidos)::int AS lidos,
    SUM(respostas)::int AS respostas, SUM(cliques)::int AS cliques, SUM(conversoes)::int AS conversoes,
    SUM(valor_convertido) AS valor_convertido,
    ROUND(AVG(tempo_medio_resposta_seg)::numeric, 2)::float8 AS tempo_medio_resposta_seg
  FROM vw_campanha_desempenho GROUP BY cenario
) ag;

CREATE OR REPLACE VIEW vw_envio_detalhe AS
SELECT e.id AS envio_id, e.campanha_id, ca.nome AS campanha, ca.cenario, e.contact_id,
  c.display_name AS contato, c.perfil, c.nivel_engajamento, e.situacao, e.motivo, e.id_api,
  e.data_hora_envio,
  (SELECT MIN(ev.data_hora) FROM eventos_interacao ev WHERE ev.envio_id = e.id AND ev.tipo = 'entregue') AS entregue_em,
  (SELECT MIN(ev.data_hora) FROM eventos_interacao ev WHERE ev.envio_id = e.id AND ev.tipo = 'lido') AS lido_em,
  (SELECT MIN(ev.data_hora) FROM eventos_interacao ev WHERE ev.envio_id = e.id AND ev.tipo = 'resposta') AS respondido_em,
  (SELECT COUNT(*) FROM eventos_interacao ev WHERE ev.envio_id = e.id AND ev.tipo = 'clique')::int AS cliques,
  (SELECT ROUND(EXTRACT(EPOCH FROM (MIN(ev.data_hora) - e.data_hora_envio))::numeric, 2)::float8
     FROM eventos_interacao ev WHERE ev.envio_id = e.id AND ev.tipo = 'resposta') AS tempo_resposta_seg,
  cv.valor AS valor_conversao, cv.origem AS origem_conversao
FROM envios e
JOIN campanhas ca ON ca.id = e.campanha_id
JOIN contacts c ON c.id = e.contact_id
LEFT JOIN conversoes cv ON cv.envio_id = e.id;

CREATE OR REPLACE VIEW vw_conversa_resumo AS
SELECT cv.id AS conversation_id, cv.platform, cv.status, cv.unread_count, cv.last_message_at,
  cv.window_expires_at,
  CASE WHEN cv.window_expires_at > now() THEN 1 ELSE 0 END AS janela_aberta,
  ct.id AS contact_id, ct.display_name AS contato, ct.phone, u.name AS responsavel,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cv.id)::int AS total_mensagens,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'in')::int AS recebidas,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'out')::int AS enviadas,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cv.id AND m.origin = 'bot')::int AS enviadas_bot,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cv.id AND m.origin = 'ai')::int AS enviadas_ia,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cv.id AND m.origin = 'human')::int AS enviadas_humano,
  (SELECT string_agg(t.name, ', ') FROM conversation_tags ctg JOIN tags t ON t.id = ctg.tag_id
    WHERE ctg.conversation_id = cv.id) AS etiquetas
FROM conversations cv
JOIN contacts ct ON ct.id = cv.contact_id
LEFT JOIN users u ON u.id = cv.assigned_user_id;

CREATE OR REPLACE VIEW vw_base_contatos AS
SELECT COUNT(*)::int AS total_contatos,
  SUM(CASE WHEN elegivel = 1 THEN 1 ELSE 0 END)::int AS elegiveis,
  SUM(CASE WHEN consentimento_atual = 'opt_out' THEN 1 ELSE 0 END)::int AS revogados,
  SUM(CASE WHEN consentimento_atual IS NULL THEN 1 ELSE 0 END)::int AS sem_manifestacao,
  SUM(CASE WHEN anonimizado = 1 THEN 1 ELSE 0 END)::int AS anonimizados,
  SUM(CASE WHEN ultima_interacao >= now() - interval '15 days' THEN 1 ELSE 0 END)::int AS ativos_15_dias
FROM vw_consentimento_atual;
