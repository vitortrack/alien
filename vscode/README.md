# Alien para VS Code

Chat com o agente de código autônomo Alien na barra lateral (ícone do alienígena).

- Pergunte sobre o código ou peça alterações: ele investiga, altera, verifica e passa por um revisor independente.
- Referências `arquivo:linha` nas respostas abrem o arquivo na linha.
- Pedidos de permissão (escrita, comandos) aparecem como botões **Permitir / Negar** (modo `ask`).
- Troque o modelo no seletor do chat (lista os modelos instalados no Ollama).
- Anexe prints e arquivos com 📎, Ctrl+V ou arrastando.
- Marque **multiagente** para dividir a tarefa em fatias com checagens de pronto e uma revisão final.

Configurações em *Settings → Alien*: provedor (Ollama local ou Claude), modelo, permissões, idioma, revisão e modelo de embedding.

**Sistemas:** Linux x64 e Windows pelo WSL. No Windows, instale o WSL, abra o projeto com *WSL: Connect to WSL* e use *Install in WSL*; o passo a passo, com os links oficiais, está em [Windows (WSL)](https://github.com/vitortrack/alien#windows-wsl). O Windows sem WSL não é suportado.

Requer VS Code 1.90+, `bash`, `git`, `grep` e `find` no PATH e um modelo: o [Ollama](https://ollama.com) rodando, com `ollama signin` para o modelo padrão `glm-5.3-flash:cloud`, ou `ANTHROPIC_API_KEY` no ambiente em que o VS Code foi aberto. A busca semântica usa `ollama pull qwen3-embedding:0.6b`; sem ele, cai para palavras-chave. Detalhes em *Requisitos* no [README do projeto](https://github.com/vitortrack/alien#requisitos).
