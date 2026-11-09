# TrackAI para VS Code

Chat com o agente de código autônomo TrackAI na barra lateral (ícone do alienígena).

- Pergunte sobre o código ou peça alterações: ele investiga, altera, verifica e passa por um revisor independente.
- Referências `arquivo:linha` nas respostas abrem o arquivo na linha.
- Pedidos de permissão (escrita, comandos) aparecem como botões **Permitir / Negar** (modo `ask`).
- Marque **multiagente** para rodar o pipeline planner → workers → revisor.

Configurações em *Settings → TrackAI*: provedor (Ollama local ou Claude), modelo, permissões, idioma, revisão e modelo de embedding.

Requer o [Ollama](https://ollama.com) rodando (`ollama pull qwen3-embedding:0.6b`) ou `ANTHROPIC_API_KEY` no ambiente.
