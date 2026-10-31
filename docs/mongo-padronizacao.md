# Migração do esquema Mongo

## Estado e escopo

Código e catálogo preparados; nenhum documento remoto foi alterado. Não executar a migração com APIs antigas ou workers ativos. O produtor da fila de chat está em ChatPushOutbox, na main atualizada da API Java, e foi incluído na padronização.

| Origem | Destino |
| --- | --- |
| forms | formularios |
| nr_catalog_sql_sync | sincronizacoes_catalogo_nrs |
| chat_push_outbox | fila_entregas_chat |
| id_workspace / id_gestor / id_unidade | workspace_id / gestor_id / unidade_id |
| id_gestor_remetente / id_gestor_revisor | gestor_remetente_id / gestor_revisor_id |
| id_usuario / id_user | usuario_id, preservando o tipo e a identidade |
| id_conversa / id_remetente / participantes | conversa_id / remetente_id / participantes_ids |
| id_envia / id_recebe | remetente_id / destinatario_id |
| id_pergunta / id_opcao / id_imagem / id_envio | pergunta_id / opcao_id / imagem_id / envio_id |
| notificacoes.title / id_evento / event_id | titulo / evento_id |
| sessoes.mensagens[].role / content | papel / conteudo |
| sessoes.lock_token / lock_ate / resumo_job_* | reserva_token / reserva_ate / resumo_tarefa_* |
| fila: done / attempts / nextAttempt / expiresAt | concluida / tentativas / proxima_tentativa_em / expira_em |
| sincronização: nrId / createdAt | nr_id / criado_em |
| fila: payload / lease | evento / reserva_token |
| evento da fila: version / messageId / conversationId / senderId / recipientId / workspaceId | versao / mensagem_id / conversa_id / remetente_id / destinatario_id / workspace_id |
| evento da fila: recipientUid / senderName / preview / createdAt | destinatario_uid / nome_remetente / previa / criado_em |

Os campos nr de formulários passam a nr_id. Referências dentro de ações pendentes também seguem o sufixo _id. O migrador preserva _id, tipos BSON, metadados _class, respostas, revisões, anexos e chaves R2. Não consulta dados do Databricks e não altera hashes de identidade/idempotência.

## Procedimento

1. Executar simulação: `python mongo/migrations/padronizar_documentos.py --env-file CAMINHO_DO_ENV_DA_API`.
2. Resolver aliases com valores diferentes, nomes coexistentes de coleção ou marcadores de aparência desconhecidos. O preflight percorre todos os documentos antes de qualquer escrita.
3. Atualizar Java, web, astro-ai-api, resumo e notificações em uma janela coordenada; interromper também expurgo, integrações e demais escritores identificados no ambiente.
4. Com os escritores parados, repetir a simulação e aplicar com `--apply --writers-stopped --backup-dir DIRETORIO_VAZIO`.
5. O script salva JSON estendido por coleção, manifesto e definições de índices antes da primeira alteração. O diretório contém dados sensíveis: guardar fora do Git, com acesso restrito.
6. Renomeia coleções sem sobrescrever destinos; transforma documentos; recria índices cujos caminhos mudaram, preservando opções como unique, partialFilterExpression e TTL. Índices com nome explícito mantêm esse nome e são recriados com escritores parados; se a criação falhar, o script tenta restaurar a definição anterior.
7. Disponibilizar os consumidores compatíveis e verificar criação/listagem/edição de formulários, aparência, respostas/anexos, chat, histórico/resumos e notificações. Reexecutar a simulação para confirmar ausência de alterações restantes.

## Falhas e recuperação

A migração não é uma transação global. Se falhar, manter escritores interrompidos. Após corrigir a causa, o processamento pode ser retomado com novo backup vazio; coleções já renomeadas e documentos já convertidos são aceitos. Coexistência de origem e destino exige revisão manual. Antes de voltar às versões antigas dos serviços, restaurar os documentos, nomes de coleções e índices do backup; restaurar apenas o código quebra o contrato de persistência. A restauração não é executada automaticamente pelo script.

## Consumidores e exceções

Java usa nomes ingleses no código e em DTOs HTTP; @Field e queries usam nomes físicos portugueses. Na IA, role/content e id_user podem existir no contrato em memória/HTTP ou no payload Qdrant; o repositório converte as mensagens do Mongo sem alterar os blocos que já usam conteudo. O serviço de resumo lê diretamente papel/conteudo e converte para role/content ao chamar o provedor. Esses protocolos externos não são coleções Mongo e não são renomeados nesta tarefa.
