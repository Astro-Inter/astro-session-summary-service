# Astro — Resumos automáticos de sessões

Serviço independente da API de IA para gerar memória de conversas após **24 horas
completas de inatividade**. A tarefa pai é SCRUM-471; implementação dividida em
SCRUM-472 (seleção), SCRUM-473 (processamento) e SCRUM-474 (integração na API).

## Funcionamento

O `astro-shared-scheduler`, mantido no
[astro-notification-service](https://github.com/Astro-Inter/astro-notification-service),
executa `0 * * * *` e chama este Worker pelo Service Binding `SUMMARY`, entrypoint
`ScheduledJob`, método `run()`: uma vez por hora, no minuto zero, em UTC.
Este Worker mantém `triggers.crons=[]`; não deve receber uma segunda agenda.
Essa integração faz parte da SCRUM-557 e compartilha um único Cron Trigger com
as análises de notificações. O estado `ENABLED=false` permanece preservado.
Uma sessão normalmente fica elegível entre 24 e 25 horas após a última mensagem;
fila acumulada, falhas e limites do provedor podem aumentar esse intervalo.
São selecionadas até cinco sessões por execução (ajustável entre 1 e 10).
Não existe polling contínuo, temporizador em memória ou dependência do frontend.

O Worker conecta diretamente ao MongoDB, coleção `sessoes`, com driver Node,
TLS e `nodejs_compat`. Gera o resumo na Groq (`openai/gpt-oss-20b`), em trechos
cronológicos, salva no Mongo e indexa no Qdrant `memoria_resumos` com
`mistral-embed` (1024 dimensões, Cosine), compatível com a memória da API.
Não chama `/sessions/{id}/encerrar`, nem qualquer endpoint do chatbot.

**A sessão continua ativa:** não muda `status`, `mensagens`, `acao_pendente`,
`atualizada_em`, `ultima_mensagem_em` ou o lease do chat. O usuário pode voltar
a conversar com o mesmo UUID. Uma nova mensagem torna o resumo anterior
desatualizado; o Worker cria outra versão após novo período de inatividade.

O resumo é uma síntese assistida por IA, não comprovação de execução de ferramentas
nem documento oficial. O prompt separa relatos, propostas, pendências e resultados,
trata mensagens como dados não confiáveis e remove padrões comuns de credenciais.
Esse filtro não garante detectar todo dado sensível: as mensagens são enviadas
à Groq e o resumo à Mistral/Qdrant. Use as políticas de privacidade do projeto.

## Segurança e recuperação

- Seleção e claim atômico revalidam o limite de 24h, estado, leases e backoff.
- Lease `resumo_job_*` independente do lock do chat, com expiração de dez minutos.
- Gravações condicionais verificam dono, token, data e quantidade de mensagens;
  se chegar uma mensagem ou o lease expirar, o resultado não é marcado atual.
- Checkpoints permitem retomar uma conversa longa sem perder os trechos já lidos.
  Cada mensagem grande é dividida, não truncada; há limite de segurança de 1M
  caracteres / 1000 mensagens por sessão. A API atual limita a 240k / 200.
- Se o embedding falhar, o resumo fica salvo; a próxima tentativa só refaz o índice.
- Upsert usa o UUID estável da sessão, evitando duplicação dos pontos.
- Retentativas têm backoff até seis horas. Não há descarte definitivo de sessão.
- O lote para antes do orçamento de quatro minutos. Sessões adiadas serão retomadas
  no próximo Cron. O lote é sequencial para limitar conexões e consumo de cota.
- Não existe transação entre Mongo/Qdrant: pode haver vetor temporariamente antigo.
  A API deve revalidar o resumo no Mongo; o payload vetorial não concede acesso.
- Erros armazenados e logs usam códigos sanitizados; nunca imprimem URIs ou bodies.
- Não há endpoint HTTP para disparar processamento; `/health` é liveness local,
  não verifica banco/provedor. `workers_dev=false` evita rota pública por padrão.

## Contrato com a API (deploy SCRUM-474 primeiro)

`ultima_mensagem_em` deve ser BSON Date UTC e mudar **somente quando um turno é
persistido**. `atualizada_em` continua sendo a data geral de atualização da API.
O Worker usa `atualizada_em` como fallback para documentos legados sem o novo
campo, sem fazer migração destrutiva. Antes da adaptação da API, esse fallback
é menos preciso, pois updates internos também movem essa data.

Campos de saída: `resumo`, `resumo_gerado_em`, `resumo_origem=automatico`,
`resumo_mensagens`, `resumo_ultima_mensagem_em`, `resumo_indexado`.
Campos de checkpoint: `resumo_automatico_parcial`, `resumo_automatico_ate`,
`resumo_automatico_base_em`, `resumo_automatico_base_total`.
Campos de operação: `resumo_job_token`, `resumo_job_ate`, `resumo_job_tentativas`,
`resumo_job_proxima_tentativa`, `resumo_job_erro`.

Não apagar `ultima_mensagem_em` nem substituir mensagens já persistidas por fora
da API. A consistência pressupõe histórico append-only com data do turno atualizada
atomicamente. Novas mensagens invalidam a memória via data/quantidade, mesmo se
o vetor anterior ainda existir. A SCRUM-474 adapta a leitura para aceitar resumos
atuais de sessões ativas e cair para resumos recentes do Mongo sem índice disponível.
O encerramento manual permanece legado/deprecated por compatibilidade; não faz
parte deste serviço. Sessões `encerrando` não são processadas automaticamente.

Índices Mongo criados pela API adaptada no primeiro acesso:

```javascript
db.sessoes.createIndex({status: 1, ultima_mensagem_em: 1}, {name: 'sessoes_inatividade_resumo'})
db.sessoes.createIndex({status: 1, atualizada_em: 1}, {name: 'sessoes_inatividade_legado'})
```

O filtro de versão usa `$expr`; os índices reduzem candidatos por estado/data,
mas não cobrem todos os predicados. Monitore a duração em grandes bases.

## Executar e testar localmente

Node >= 22.18; os comandos funcionam no PowerShell mesmo em caminhos com `&`.

```powershell
npm ci
npm run check
npm test
npm run build
npm run configure:local -- "C:\caminho\astro-ai-api\.env"
npm run dev
```

`configure:local` copia somente as credenciais necessárias para `.dev.vars`,
ignorado pelo Git, sem mostrar valores e sem sobrescrever arquivo existente.
O serviço permanece `ENABLED=false`. Para testar o agendamento desativado:

```powershell
Invoke-WebRequest "http://localhost:8787/health"
Invoke-WebRequest "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

Os testes automatizados usam fixtures e HTTP mocks; não alteram Mongo/Qdrant real,
não consomem cota de IA e não exportam telemetria ao Grafana real.
Para testar ponta a ponta use **database e coleção Qdrant de homologação** com
sessão sintética: duas mensagens, `ultima_mensagem_em` há mais de 24h, `status=ativa`.
Habilite `ENABLED=true` apenas nessa configuração. Repita o Cron e confira que não
gera novamente. Acrescente um turno e confira que não é resumido antes de outras 24h.

## Publicar no Cloudflare

1. Publicar antes a adaptação SCRUM-474 na API e verificar os índices.
2. Criar usuário Mongo com acesso restrito ao database necessário e permissão de
   leitura/update em `sessoes`. Não é preciso dar permissão de apagar documentos.
3. Verificar Network Access do Atlas. As faixas de saída do Render não cobrem
   Workers. Não abrir `0.0.0.0/0` automaticamente; definir estratégia de rede e
   avaliar o risco se optar por acesso público com TLS e usuário restrito.
4. Autenticar no Wrangler (`node node_modules/wrangler/bin/wrangler.js login`).
5. Publicar desativado: `npm run deploy`.
6. Configurar os secrets no Worker com `npm run secrets:upload`. Esse comando
   envia somente Mongo, Groq, Mistral, Qdrant e cabeçalho OTLP de `.dev.vars`;
   não envia as credenciais de Firebase, Postgres, R2 ou DeepInfra.
7. Após validar em homologação, definir `ENABLED=true` em `wrangler.jsonc` e publicar.
   A agenda pertence ao disparador compartilhado; não adicione Cron neste Worker.
   Não habilite o processamento enquanto a rede e a integração na API não estiverem prontas.

O arquivo de entrada de produção é `src/entrypoint.ts`. Ele preserva os handlers
existentes de `src/worker.ts` e exporta o entrypoint interno `ScheduledJob`.
`status()` permite consultar a habilitação sem ler sessões; `run()` respeita
`ENABLED` e aguarda o mesmo processamento já usado pelo handler agendado.
Nenhum endpoint HTTP de execução foi adicionado.

O workflow `ci.yml` valida PRs sem secrets. `deploy.yml` é manual, somente `main`,
usa o environment `production` e exige GitHub secrets `CLOUDFLARE_API_TOKEN` e
`CLOUDFLARE_ACCOUNT_ID`. Configure aprovadores no environment se quiser autorização
humana para cada publicação. Secrets do Worker são configurados separadamente.
Nenhum deploy ocorre automaticamente ao enviar esta branch.

**Plano gratuito não é garantido:** Workers Free limita CPU a 10ms, mesmo em Cron;
Mongo/TLS, JSON e telemetria podem exceder. A configuração não contrata plano pago
nem aumenta limites de cobrança. Validar CPU na conta antes de ativar; avaliar
Workers Paid se necessário. Groq/Mistral/Qdrant/Grafana têm suas próprias cotas e
custos; Mistral embeddings não deve ser presumida gratuita. O bundle local não
comprova acesso à rede Atlas nem funcionamento em produção.

## Grafana / OpenTelemetry

`OTEL_EXPORTER_OTLP_ENDPOINT` aponta ao gateway fornecido. Configure o cabeçalho
como **secret**, por exemplo `Authorization=Basic%20...`; o serviço decodifica
`%20` antes de enviar. O token deve permitir ingestão de metrics, logs e traces.
Use token dedicado com privilégio mínimo e rotacione credenciais compartilhadas.

Nome do serviço: `astro-session-summary-service`. Envia um pequeno lote OTLP/HTTP
JSON por execução: `/otlp/v1/metrics`, `/otlp/v1/logs`, `/otlp/v1/traces`.
Para alto volume, migrar o exportador para OTLP protobuf; JSON é apropriado para
esta baixa frequência, conforme as orientações do Grafana.

Métricas são **gauges do último lote**, não contadores cumulativos:

| Métrica OTLP | Uso |
|---|---|
| `astro.summary.sessions` | selecionadas, concluídas, falhas, obsoletas e adiadas, atributo `result` |
| `astro.summary.llm_calls` | chamadas lógicas de resumo, sem contar tentativas de chave |
| `astro.summary.run_duration` | duração da execução em segundos |
| `astro.summary.last_run` | timestamp da última execução para detectar Cron parado |

Confira os nomes normalizados no Explore (pontos viram underscores; unidades podem
adicionar sufixos). Alertas sugeridos: nenhuma execução habilitada por mais de duas
horas; falhas no último lote; sessões sempre adiadas; duração perto do orçamento.
Logs em JSON e trace `summary.hourly_run` ajudam a correlacionar cada lote.
Falha de exportação é logada localmente e nunca desfaz um resumo já salvo.

## Referências verificadas

- [MongoDB em Workers](https://blog.cloudflare.com/full-stack-development-on-cloudflare-workers/)
- [Cron Triggers e UTC](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Limites de CPU](https://developers.cloudflare.com/workers/platform/limits/)
- [Grafana OTLP e encoding](https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/)

## Diagnóstico operacional

Consulte [os campos e limites dos novos diagnósticos](docs/observability-diagnostics.md) para investigar falhas por requisição ou execução no Grafana.
