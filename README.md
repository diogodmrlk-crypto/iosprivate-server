# IOSPRIVATE Server

API de gerenciamento de licenças com Node.js, Express e SQLite (`better-sqlite3`). O banco de produção é o único arquivo `/var/data/iosprivate.sqlite`, em Persistent Disk do Render. Não há Supabase, Firebase, MongoDB, PostgreSQL ou serviço externo de armazenamento.

## Executar localmente

Requer Node.js 20+. Copie `.env.example` para `.env`, defina uma senha forte em `ADMIN_PASSWORD` e um `JWT_SECRET` com pelo menos 32 caracteres. Depois:

```bash
npm ci
npm start
# http://localhost:10000/health
```

O banco local padrão fica em `data/iosprivate.sqlite`; em produção o código usa `/var/data/iosprivate.sqlite` mesmo se `SQLITE_PATH` não estiver presente. A aplicação compara o dispositivo do sistema de arquivos e interrompe a inicialização se o Persistent Disk não estiver realmente montado, evitando perder keys silenciosamente em um deploy. O primeiro administrador é configurado exclusivamente por variáveis de ambiente. Não existe credencial padrão segura embutida no código.

## Publicar no GitHub

```bash
git init
git add .
git commit -m "feat: initial IOSPRIVATE license API"
gh repo create iosprivate-api --public --source=. --remote=origin --push
```

Nunca faça commit de `.env`, tokens, senhas ou arquivos `.sqlite`.

## Render com Persistent Disk

O `render.yaml` declara um Web Service Node no plano `starter` (necessário para Persistent Disk), build `npm ci`, start `npm start`, health check `/health`, variável `SQLITE_PATH=/var/data/iosprivate.sqlite` e disco de 1 GB montado em `/var/data`. O plano Free não mantém disco persistente.

1. No Render, escolha **New > Blueprint** e conecte o repositório GitHub; ou crie um Web Service apontando para este repositório.
2. Confirme o nome `iosprivate-api`, plano pago compatível com Persistent Disk e a região desejada.
3. Se não usar Blueprint, configure Build Command `npm ci`, Start Command `npm start`, Health Check Path `/health` e adicione um Persistent Disk montado em `/var/data`.
4. Em Environment, configure `ADMIN_USERNAME`, `ADMIN_PASSWORD`, um `JWT_SECRET` aleatório forte e `KEYS_VIEW_CODE=20009` (ou outro código que você escolher). `SQLITE_PATH=/var/data/iosprivate.sqlite` não deve ser alterado. `CORS_ORIGIN` pode ser ajustado para a origem do seu site; use `*` somente quando necessário.
5. Faça o primeiro deploy. A URL será fornecida pelo Render como `https://<nome-do-servico>.onrender.com`; não há URL fixa neste repositório até que o serviço seja criado.
6. Teste: `curl https://<seu-servico>.onrender.com/health`.

A inicialização usa migrações idempotentes e nunca apaga o banco. Em atualizações, mantenha o mesmo Persistent Disk e não use scripts que removam `/var/data`.

## Servidor próprio/VPS com SQLite persistente

Para não depender do filesystem do Render, use um VPS Ubuntu com disco persistente e Docker. O arquivo `compose.yaml` monta o diretório do host `/var/lib/iosprivate` dentro do container como `/var/data`; commits e recriações do container não removem esse diretório.

No servidor:

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo systemctl enable --now docker
sudo mkdir -p /var/lib/iosprivate
sudo chown -R "$USER":"$USER" /var/lib/iosprivate
git clone https://github.com/diogodmrlk-crypto/ioslicence.git
cd ioslicence
cp .env.server.example .env.server
openssl rand -base64 48
nano .env.server
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:10000/health
```

Em `.env.server`, defina `ADMIN_PASSWORD`, cole um `JWT_SECRET` novo e ajuste `CORS_ORIGIN`. O banco ficará no host em `/var/lib/iosprivate/iosprivate.sqlite`, não dentro da camada descartável do container. Atualizações devem ser feitas com `git pull && docker compose up -d --build`; não use `docker compose down -v`, porque isso pode remover volumes nomeados. O volume deste projeto é um bind mount e fica fora do repositório.

Para backup no próprio VPS:

```bash
mkdir -p /var/backups/iosprivate
docker compose exec -T iosprivate-api node scripts/backup.js /var/backups/iosprivate
```

O VPS ainda precisa de backup em outro local para proteção contra falha do disco. Para HTTPS, coloque um proxy reverso como Caddy ou Nginx na frente e não exponha a porta 10000 diretamente à internet. A API foi preparada para reconhecer o volume Docker montado em `/var/data` e recusar a inicialização se o volume não estiver montado.

## API pública

`POST /v1/bind`, `POST /v1/validate` e `POST /v1/unbind` recebem `{ "key": "...", "device": "identificador-do-cliente" }`. O identificador é compatível com navegador/PWA, mas não é um HWID físico inviolável e pode ser falsificado; o servidor não confia em estado enviado pelo cliente.

Para permitir que outro projeto faça entrada automática sem pedir a key novamente, use `POST /v1/session` (ou o alias `POST /v1/auto-login`) com apenas `{ "device": "identificador-do-cliente" }`. O servidor só retorna `authenticated: true` e um token de cliente de 1 hora quando encontra exatamente uma licença existente, ativa, não expirada e já vinculada àquele dispositivo. Se a key não existir, estiver bloqueada/expirada, não estiver vinculada ou houver mais de uma licença no mesmo dispositivo, a entrada é recusada. O token retornado deve ser usado como `Authorization: Bearer <access_token>` pelo projeto cliente; ele não é um token administrativo.

Exemplo de entrada automática:

```bash
curl -X POST https://SEU-DOMINIO.onrender.com/v1/session \
  -H 'Content-Type: application/json' \
  -d '{"device":"pwa-device-id"}'
```

No projeto cliente, execute essa chamada ao abrir a tela. Se retornar `authenticated: true`, abra diretamente o dashboard e guarde `access_token`; não peça a key nem chame `/v1/bind` novamente. Use `/v1/bind` somente no primeiro cadastro de uma instalação ainda sem vínculo. O HTML enviado anteriormente ainda chama `/v1/bind` em `activate()` e por isso continua mostrando o login; ele precisa trocar essa chamada por `/v1/session` para obter o comportamento automático.

Importante: em navegador, PWA e Scriptable, um HWID é apenas um identificador fornecido pelo cliente e pode ser copiado ou falsificado. Para operações realmente sensíveis, combine a sessão com autenticação própria do seu projeto e não trate o HWID como prova criptográfica de identidade física.

Exemplo:

```bash
curl -X POST https://SEU-DOMINIO.onrender.com/v1/bind \
  -H 'Content-Type: application/json' \
  -d '{"key":"IOSPRIVATE-DAILY-...","device":"pwa-device-id"}'
```

Clientes HTML/JavaScript, PWA, Node.js, Scriptable e outros clientes HTTP devem usar somente estes endpoints públicos. Nunca inclua o token administrativo em código cliente.

## Painel e endpoints administrativos

Abra `https://SEU-DOMINIO.onrender.com/`, entre com `ADMIN_USERNAME`/`ADMIN_PASSWORD` e gere, pesquise, bloqueie, reative, desvincule ou exclua licenças. O painel usa a API real, sem dados fictícios.

O painel começa em inglês e possui as abas **Home**, **Keys** e **Profile**. A aba **Profile** oferece English, Vietnamese e Português PT. A aba **Keys** não carrega o arquivo de licenças antes do desbloqueio: informe o código configurado em `KEYS_VIEW_CODE` (por padrão `20009`). O servidor valida o código e entrega um token temporário de visualização por 15 minutos; um bloqueio apenas no navegador não é usado como proteção.

Endpoints protegidos por `Authorization: Bearer <token>`: `GET /admin/keys`, `POST /admin/keys`, `GET /admin/keys/:id`, `PATCH /admin/keys/:id/status`, `POST /admin/keys/:id/unbind`, `DELETE /admin/keys/:id`, `GET /admin/stats`. O login é `POST /admin/auth/login`.

Criação: `{ "type":"daily", "duration":7, "username":"cliente" }`. Tipos: `hourly`, `daily`, `weekly`, `monthly` (30 dias) e `perm`. As keys usam `crypto.randomBytes`; expiração é calculada no servidor. A vinculação é protegida por transação SQLite, impedindo ativação concorrente em dispositivos diferentes.

## Backup e restauração

Faça backup com a aplicação parada, ou em janela controlada, para garantir um snapshot consistente:

```bash
npm run backup -- ./backups
# restauração: pare a aplicação, valide o arquivo e execute:
npm run restore -- ./backups/iosprivate-AAAA.sqlite
```

No Render, copie o arquivo de backup para armazenamento seguro fora do serviço. Nunca substitua o banco de produção durante uma escrita e nunca restaure sem manter uma cópia `.before-restore-*`. O Persistent Disk não substitui backups externos.

## Testes

Os testes usam `:memory:` e nunca o banco de produção:

```bash
npm test
```

Os testes cobrem inicialização, criação, validação, expiração, bloqueio/reativação, bind/unbind, autenticação, entradas inválidas, concorrência lógica e persistência dentro do ciclo do banco. Antes de cada deploy, execute a suíte e verifique `/health`.


## Deploy sem configurar variáveis no Render

Este repositório contém uma configuração embutida para o deploy inicial. Mantenha o repositório privado, conecte-o ao Render como Blueprint e confirme o Persistent Disk em `/var/data`. O usuário administrativo embutido é `admin`; a senha inicial foi gerada no momento da criação deste repositório e deve ser trocada no código antes de compartilhar o projeto. O código de visualização da aba Keys é `20009`.

Este perfil está ajustado para iniciar no plano Free sem Persistent Disk. O SQLite funciona em `/var/data`, mas o filesystem do Free é efêmero: as keys podem desaparecer em reinicializações ou novos deploys. Para persistência real, use um VPS com volume ou plano com disco.
