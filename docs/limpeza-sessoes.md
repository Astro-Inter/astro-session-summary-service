# Resumos ativos e limpeza de sessões vazias

## Agendamento

O Cron `0 * * * *` pertence ao `astro-shared-scheduler`. Seu binding `SUMMARY`
chama `ScheduledJob.run()` no serviço de resumos uma vez por hora.
Esse método também chama `CLEANUP.run()` às 00h, 06h, 12h e 18h UTC
(21h, 03h, 09h e 15h em São Paulo). O binding `CLEANUP` aponta para o
entrypoint `CleanupJob` do novo `astro-session-cleanup-service`.
Não há segundo Cron: a conta já atingiu o limite gratuito de cinco agendas.
Os resumos e a limpeza executam independentemente; a falha de um não impede
a tentativa do outro, mas a chamada registra a falha ao final.

## O que a limpeza apaga

Somente documentos em `sessoes` com todos os critérios:

- `status=ativa`, `usuario_id` válido e `mensagens` como array realmente vazio;
- `iniciada_em` BSON Date estritamente anterior a agora menos 24 horas;
- sem resumo, ação pendente ou reserva ativa do chat/serviço de resumos;
- mesmos critérios revalidados na operação atômica de exclusão.

Não usa `atualizada_em` como idade e não apaga sessões com uma mensagem sequer.
Campos ausentes/nulos/malformados não são interpretados como array vazio.
São selecionadas até 100 sessões por execução, configuráveis entre 1 e 500.
O orçamento de tempo pode adiar parte do lote. Exclusão é permanente; não há lixeira.

## Mongo + Qdrant

A exclusão no Mongo e a inclusão de uma pendência em
`sessoes_limpeza_pendencias` acontecem na mesma transação. A credencial precisa
permitir transações e leitura/escrita nessa coleção, além de exclusão em `sessoes`.
O serviço não faz exclusão ampla de vetores: exige o UUID da sessão e o usuário
no payload (`id_user` ou `usuario_id`). Consulta a coleção de memória atual e a
legada `memoria_resumos`, sem tocar no FAQ nem nos vetores de outras sessões.
Uma coleção inexistente é tratada como sem vetores.

Falhas do Qdrant mantêm a pendência persistida para a próxima execução.
Mongo e Qdrant não possuem uma transação distribuída: pode haver um vetor
temporariamente órfão até a recuperação. Uma sessão recriada com o mesmo UUID
é preservada na drenagem, sem remover seus vetores novos. Como qualquer operação
entre dois bancos, essa checagem não fornece atomicidade contra recriações
simultâneas por sistemas externos; clientes devem usar UUIDs novos para novas sessões.

Logs contêm apenas contagens, códigos de erro e duração, sem mensagens ou chaves.
`vectors_failed>0` exige acompanhamento; a pendência não é descartada por falha.

## Compatibilidade da memória

Com `OPENROUTER_API_KEY`, os resumos usam OpenRouter e o índice usa
`openai/text-embedding-3-small`, 1536 dimensões e Cosine, na coleção configurada
em `QDRANT_MEMORY_COLLECTION` (padrão `memoria_resumos_openai_te3s_v1`).
A coleção antiga não é apagada/reconfigurada ao criar a nova. Sem OpenRouter,
o fluxo legado Groq/Mistral permanece disponível. Não misture modelos na mesma coleção.

## Configuração e publicação

Os arquivos versionados ficam desabilitados por segurança. A configuração real
publicada foi ativada explicitamente. Um deploy simples com os valores padrão
voltará a desabilitar o processamento; use o workflow manual ou os parâmetros abaixo.

Secrets de resumos: Mongo, Qdrant, `OPENROUTER_API_KEY` e cabeçalho OTLP.
Secrets de limpeza: `MONGODB_URI`, `MONGODB_DATABASE`, `QDRANT_URL`, `QDRANT_API_KEY`.
Configure esses secrets separadamente no Worker de limpeza e os secrets dos
resumos no Worker correspondente. Não cole secrets no repositório ou workflow.

Após configurar os secrets, publique a limpeza antes do serviço que a referencia:

```powershell
npm run deploy:cleanup -- --var CLEANUP_ENABLED:true --keep-vars
npm run deploy -- --var ENABLED:true --keep-vars
```

Ao configurar uma coleção customizada, repita `QDRANT_MEMORY_COLLECTION` nos
dois Workers. Nenhum endpoint HTTP público dispara resumos ou exclusões.
O agendador precisa manter seu binding `SUMMARY` ativo; desabilitá-lo para os
resumos também interrompe a chamada indireta da limpeza.

## Validação realizada

- TypeScript, testes automatizados e build dos dois Workers.
- Filtro executado no Mongo com nove documentos fictícios em memória, sem gravações:
  só o array vazio com mais de 24h e sem reserva foi selecionado.
- Resumo e embedding sintéticos no OpenRouter validaram 1536 dimensões.
- Chamadas RPC aos dois Workers reais retornaram sucesso e logs `completed`,
  com zero candidatos naquele momento. Nenhuma sessão real foi apagada no teste.

Essa execução sem candidatos não comprova uma exclusão transacional real nem a
recuperação de falha real do Qdrant. Esses cenários têm testes simulados e devem
ser acompanhados na primeira execução com sessões elegíveis.
