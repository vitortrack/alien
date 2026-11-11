# TrackAI para VS Code

Chat com o agente de código autônomo TrackAI na barra lateral (ícone do alienígena).

- Pergunte sobre o código ou peça alterações: ele investiga, altera, verifica e passa por um revisor independente.
- Referências `arquivo:linha` nas respostas abrem o arquivo na linha.
- Pedidos de permissão (escrita, comandos) aparecem como botões **Permitir / Negar** (modo `ask`).
- Marque **multiagente** para rodar o pipeline planner → workers → revisor.

Configurações em *Settings → TrackAI*: provedor (Ollama local ou Claude), modelo, permissões, idioma, revisão e modelo de embedding.

Requer VS Code 1.90+, `bash`, `git`, `grep` e `find` no PATH (no Windows, WSL ou Git Bash) e um modelo: o [Ollama](https://ollama.com) rodando, com `ollama signin` para o modelo padrão `glm-5.3-flash:cloud`, ou `ANTHROPIC_API_KEY` no ambiente em que o VS Code foi aberto. A busca semântica usa `ollama pull qwen3-embedding:0.6b`; sem ele, cai para palavras-chave. Detalhes em *Requisitos* no README do projeto.
