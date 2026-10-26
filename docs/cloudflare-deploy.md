# Deploy Cloudflare

O workflow deploy.yml valida tipos, testes e bundle antes de publicar a main. Também aceita execução manual na main. O ambiente production e suas regras existentes permanecem ativos.

CLOUDFLARE_API_TOKEN fica nos secrets do repositório; CLOUDFLARE_ACCOUNT_ID é uma variável pública. O token é restrito à conta Astro, com Workers Scripts: Edit, e expira em 25/10/2027. Os secrets de aplicação permanecem no Worker.

A configuração entra em vigor após a revisão e o merge desta PR; nenhum deploy é feito ao atualizar a branch da PR.
