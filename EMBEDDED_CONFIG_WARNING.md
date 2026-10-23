# Configuração embutida

Este repositório foi preparado para não exigir variáveis secretas no painel do Render. Por isso, `src/app.js` contém o usuário administrativo, a senha inicial e o JWT secret. Mantenha o repositório privado e altere esses valores se houver qualquer exposição.

A persistência depende do Persistent Disk do Render montado em `/var/data`; configuração embutida não cria armazenamento persistente no plano Free.
