# Configuração embutida

Este repositório foi preparado para não exigir variáveis secretas no painel do Render. Por isso, `src/app.js` contém o usuário administrativo, a senha inicial e o JWT secret. Mantenha o repositório privado e altere esses valores se houver qualquer exposição.

Este perfil roda no Render Free sem Persistent Disk, mas o armazenamento é efêmero e não garante as keys após reinicializações.
