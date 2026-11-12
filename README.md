# Alien

Agente de código autônomo para o terminal. Lê, entende, altera e verifica código no seu projeto, com raciocínio ReAct (pensar → agir → observar), planejamento, autocorreção, portões determinísticos de verificação e de escopo, orquestração multiagente, RAG sobre o código e memória vetorial de longo prazo.

Roda **100% local** com [Ollama](https://ollama.com) ou com **Claude** (API da Anthropic).

```text
› Os testes estão falhando. Encontre a causa raiz e corrija.
⚙ read_file path=src/cart.js
⚙ bash command=npm test
Causa raiz: o laço começa em i = 1 e pula o primeiro item…
⚙ edit_file path=src/cart.js …
⚙ bash command=npm test        ✓ all tests passed
│ critic#1 ⚙ bash command=git diff   …
ℹ revisor aprovou o trabalho
```

## Requisitos

O mesmo núcleo roda no CLI e na extensão do VS Code, então os requisitos são os mesmos, com duas diferenças: o CLI precisa de **Node.js 22+**, e a extensão precisa de **VS Code 1.90+** (ela já leva o Node do próprio VS Code e o código do Alien dentro do `.vsix`, sem precisar de Node nem npm na máquina).

**Obrigatório**

- **Um modelo**, de uma destas formas:
  - **Ollama** instalado e rodando em `http://localhost:11434`. Para outro endereço, use `OLLAMA_HOST` no CLI ou *Settings → Alien → Ollama Host* na extensão. O modelo padrão, `glm-5.3-flash:cloud`, roda na nuvem do Ollama: é preciso entrar na conta com `ollama signin`. Modelos locais (`-m qwen3:8b`, por exemplo) não precisam de conta, só de `ollama pull`.
  - **Ou Claude**, com `ANTHROPIC_API_KEY` no ambiente. Na extensão, a variável precisa existir no ambiente em que o VS Code foi aberto.
- **`bash`, `git`, `grep` e `find` no PATH.** Linux e macOS já trazem. No Windows, use WSL ou Git Bash: a ferramenta de terminal do agente chama `bash` diretamente.

O Alien não depende do Claude Code: o modo multiagente (`--orchestrate`), as checagens de pronto (`--gate`) e a reescrita de harness (`src/rhi.ts`) usam o mesmo modelo configurado para o agente, por meio de um agente do próprio Alien só de leitura, que devolve as decisões em JSON validado.

**Opcional, por recurso**

| Recurso | Precisa de | Sem ele |
|---|---|---|
| Busca semântica no código e memória de longo prazo | `ollama pull qwen3-embedding:0.6b` | a busca usa só palavras-chave (BM25) |
| Ferramenta `run_code` | `python3` ou `node` no PATH, conforme a linguagem | a ferramenta falha só para a linguagem que faltar |
| Reverter edições que deixam erro de tipo | TypeScript instalado no projeto aberto | a checagem não roda e a edição é aplicada |

## Instalação

```bash
npm install
npm run build
npm link            # deixa o comando `alien` disponível no sistema
```

Provedor local (padrão quando não há chave da Anthropic):

```bash
ollama pull qwen3-embedding:0.6b  # embeddings para RAG e memória vetorial (melhor no benchmark)
# modelo de chat padrão: glm-5.3-flash:cloud (troque com -m, ex.: -m qwen3:8b)
```

Claude: exporte `ANTHROPIC_API_KEY` e o Alien passa a usar `claude-opus-5-5` (ou force com `-p anthropic`).

## Extensão do VS Code

Chat do Alien na barra lateral (ícone do alienígena), com o mesmo núcleo do CLI.

```bash
cd vscode
npm install
npm run package                                   # gera alien-0.1.0.vsix
code --install-extension alien-0.1.0.vsix --force
```

Configurações em *Settings → Alien*. Referências `arquivo:linha` abrem no editor; permissões aparecem como botões Permitir/Negar; a opção **multiagente** usa o pipeline planner → workers → revisor.

## Uso

```bash
alien                                   # modo interativo na pasta atual
alien "adicione paginação na listagem"  # executa e sai
alien -C ../meu-projeto --mode auto "corrija o build"
alien --orchestrate "crie o módulo de cupons com testes"
alien -p anthropic --effort xhigh "investigue o vazamento de memória"
```

| Opção | Descrição |
|---|---|
| `-p, --provider ollama\|anthropic` | provedor do modelo |
| `-m, --model <nome>` | modelo (`glm-5.3-flash:cloud`, `qwen3:8b`, `claude-opus-5-5`, …) |
| `--mode ask\|auto\|read-only` | `ask` pede confirmação para escrita e `bash` (comandos só de leitura, como `ls`, `grep` e `find`, passam direto); `auto` só confirma comandos destrutivos; `read-only` bloqueia tudo que altera |
| `-C, --cwd <dir>` | pasta de trabalho (o agente não acessa arquivos fora dela) |
| `--orchestrate` | pipeline planner → workers → revisor |
| `--review` | liga a revisão por um agente crítico (padrão: desligada; medido: mesmo acerto e 19–38% menos tokens sem ela, com a checagem de escopo e o portão de verificação sempre ativos) |
| `--max-steps <n>` | limite de passos por agente (padrão 50) |
| `--budget <tokens>` | para quando o consumo total passar do limite |
| `--effort <nível>` | esforço de raciocínio do Claude (`low` … `max`) |
| `--num-ctx <n>` | janela de contexto do Ollama (padrão 65536) |
| `--embed-model <nome>` | modelo de embedding (padrão `qwen3-embedding:0.6b`) |
| `--lang <idioma>` | idioma de tudo o que o agente escreve: `pt-BR` (padrão), `en`, `es`, `fr`, `de`, `it` ou `auto` (o da pergunta) |
| `--thinking` | mostra o raciocínio do modelo (por padrão aparece só "✻ pensando…") |
| `--no-log` | não grava o trace da sessão |
| `-c`, `--continue` | retoma a última conversa deste projeto |
| `-r`, `--resume <id>` | retoma uma conversa salva |
| `--fork` | com `-c` ou `-r`: continua numa cópia, sem alterar a original |

Comandos no modo interativo: `/plan`, `/mode`, `/review on|off`, `/lang <idioma>`, `/traduzir [idioma]`, `/thinking on|off`, `/orchestrate <tarefa>`, `/index`, `/memory`, `/usage`, `/sessions`, `/resume <id>`, `/fork`, `/clear`, `/exit`. **Ctrl+C** interrompe a tarefa em andamento sem sair.

Cada conversa é salva ao fim de cada tarefa em `~/.alien/projects/<projeto>/sessions/<id>.json` (histórico do agente, pedidos e respostas, plano e uso). A extensão do VS Code restaura a conversa aberta quando a janela recarrega; **Nova conversa** começa outra.

### Fazendo perguntas

```bash
alien -C ../meu-projeto --mode read-only
› Como funciona a consulta pública de protocolo? O que reutilizar para criar outra?
› /traduzir en          # a última resposta, em inglês
› /lang es              # daqui em diante, tudo em espanhol
```

Antes de responder, o agente investiga por vários ângulos: busca semântica, `grep` com sinônimos em português e inglês e a cadeia definição → chamadores → fluxo de dados. A resposta segue um formato fixo:

- **resposta direta** na primeira frase;
- **evidência** com `arquivo:linha` e só os trechos relevantes do código;
- **fato × dedução** separados, dizendo o que não foi verificado;
- **o que reutilizar**: a função, componente ou padrão existente, com exemplo de uso;
- **pegadinhas** só quando importam.

A saída é Markdown renderizado no terminal (títulos, listas, negrito, blocos de código).

## Arquitetura

```text
             ┌──────────────── Session ────────────────┐
 usuário ──▶ │  Agent (main) ── ReAct loop ──▶ Tools    │──▶ workspace
             │     │  ▲                         │        │
             │     │  └── observações / erros ◀─┘        │
             │     ├─ delegate ─▶ Agent (explorer|worker)│
             │     ├─ portões: verificação · escopo      │
             │     └─ review (--review) ─▶ Agent (critic)│
             │  Orchestrator: planner → workers → critic │
             │  Memory (vetorial) · CodeIndex (RAG)      │
             │  Provider: Ollama | Anthropic             │
             │  Trace JSONL · tokens · custo · travas    │
             └───────────────────────────────────────────┘
```

| Componente | Como está implementado | Onde |
|---|---|---|
| **1. Núcleo cognitivo** | Persona de engenheiro sênior, método de resolução (evidência → causa raiz → decisão → verificação → reflexão → aprendizado), guardrails (escopo, segredos, ações destrutivas) e um prompt por papel (main, worker, explorer, planner, critic). Instruções do projeto em `ALIEN.md`, `AGENTS.md` ou `CLAUDE.md` são carregadas automaticamente. | `src/prompts.ts` |
| **2. Memória** | **Curto prazo:** histórico da sessão, com compactação automática (resumo) quando a janela do modelo enche. **Longo prazo:** banco vetorial em `.alien/memory.jsonl` com *fatos*, *lições* e *episódios*; as lembranças relevantes são recuperadas no início de cada tarefa, os episódios são gravados automaticamente ao concluir e o agente consulta a memória com `recall`. | `src/memory.ts`, `src/providers/ollama.ts` |
| **3. Planejamento** | Laço ReAct; planner dedicado no modo `--orchestrate`; autocorreção (o erro volta como observação estruturada, e após 3 falhas seguidas o agente é instruído a mudar de estratégia); antes de concluir, **portão de verificação** (se mexeu em código e não rodou nada depois da última edição, pede uma vez para rodar testes/build) e **checagem de escopo** (áreas do diff que o pedido não menciona); revisor independente opcional (`--review`). | `src/agent.ts`, `src/orchestrator.ts` |
| **4. Ferramentas** | Agente principal: `bash`, `read_file`, `write_file`, `edit_file`, `semantic_search` (RAG), `web_fetch`, `delegate`, `recall`, `skill` (só quando há skills), `report_conflict` (encerra a tarefa relatando que um teste ou o código contradiz o pedido, em vez de contornar; só aceito depois de editar e rodar algo). Entradas validadas contra o schema; caminhos presos ao workspace (inclusive via symlink); permissões por modo; detecção de comandos destrutivos. Listar, buscar e rodar código ficam com o `bash`: na avaliação, as ferramentas dedicadas (`list_dir`, `glob`, `grep`, `run_code`, `update_plan`, `remember`) custavam ~40% mais passos e tokens sem ganho de acerto; os subagentes de pesquisa, que não têm `bash`, continuam com `list_dir`, `glob` e `grep`. | `src/tools.ts`, `src/validate.ts` |
| **5. Observabilidade** | Trace de cada passo (texto do modelo, chamadas, resultados, tokens e custo) em `~/.alien/sessions/*.jsonl`; contagem de tokens e custo estimado ao fim de cada tarefa; travas contra loop (limite de passos, chamada idêntica repetida, orçamento de tokens) e Ctrl+C para interromper. | `src/session.ts`, `src/agent.ts` |

**Multiagente.** O agente principal age como gerente: delega pesquisa ampla a *explorers* (somente leitura, rodam em paralelo) e subtarefas independentes a *workers*, e cada sub-agente começa com contexto limpo. No `--orchestrate`, o pipeline é fixo: planner → um worker por passo → revisor → correções.

**RAG.** `semantic_search` indexa o código em trechos de 60 linhas (com sobreposição) e ranqueia combinando similaridade de embeddings (peso 0,8) e BM25 (0,2). O agente escreve a busca como pergunta + identificadores prováveis em inglês, o que funciona como expansão de query. O índice é incremental e fica em `~/.alien/projects/`, fora do repositório. Sem modelo de embedding, cai para BM25 puro.

**Robustez com modelos locais.** Modelos menores às vezes escrevem a chamada de ferramenta como texto (`<tool_call>…`, bloco JSON). O provedor do Ollama reconhece esses formatos e executa a chamada mesmo assim. Números enviados como string são convertidos automaticamente.

## Skills

O Alien lê skills no formato do Claude Code (`SKILL.md` com `name` e `description` no frontmatter) em `.claude/skills/` e `.agents/skills/` do projeto e em `~/.claude/skills/`; com o mesmo nome, vale a do projeto. O prompt lista só nome e descrição; o agente carrega o texto completo (e os arquivos de apoio da pasta) com a ferramenta `skill` quando a tarefa combina. Sem skills, nada muda no prompt nem nas ferramentas. Na avaliação, com uma regra de projeto que só existe numa skill, o acerto foi de 12/20 para 19/20 e o agente carregou a skill nas 20 execuções.

## Edição de arquivos

- **Aviso de loop:** na 5ª edição do mesmo arquivo (e a cada 3 depois) o agente é avisado para reler o erro e mudar de abordagem.
- **Testes protegidos:** se o pedido não fala em mexer em testes, alterar ou remover uma asserção existente, ou acrescentar `skip`/`process.exit`, é recusado e o agente é orientado a usar `report_conflict`. Renomear símbolos e acrescentar testes novos continua livre.
- **Numeração:** criar `NNN_algo.sql` (ou `NNN-…`) numa pasta onde esse número já existe gera aviso com o próximo número livre.
- **Leia antes de editar:** `edit_file`/`write_file` recusam arquivo não lido ou alterado desde a leitura (por comando, usuário ou outro agente).
- **Casamento tolerante em cascata** (como aider/Codex): exato → ignorando espaços no fim → ignorando indentação (reindenta a substituição, inclusive tab ↔ espaços) → pontuação unicode. Arquivos CRLF são editados de forma transparente.
- **Erro que ensina:** trecho ambíguo lista as linhas de cada ocorrência; trecho não encontrado mostra as linhas mais parecidas ("Did you mean…").
- **Trava de sintaxe** (como SWE-agent): edição que quebraria JS/TS/TSX/JSON/Python válido é recusada, com a linha do erro.
- **Retorno com evidência:** cada edição devolve o trecho editado numerado para conferência.
- Arquivos grandes são paginados com cabeçalho e indicação de continuação; observações antigas são resumidas no histórico para poupar contexto; o timeout do `bash` mata o grupo de processos inteiro.

## Avaliação

```bash
npm run eval:sanity                                  # valida a bateria (cada checagem falha sem correção e passa com a referência)
npm run eval -- --suite hard --runs 3 --label teste  # roda os cenários e mede
npm run eval -- --model qwen3:8b                     # compara outro modelo
npm run eval:retrieval                               # benchmark do RAG sobre ../detrorjweb
```

17 cenários com testes escondidos (bugs, feature, refatoração, diff, CRLF/tabs, blocos duplicados, Python, escopo, perguntas). A suíte `skills` mede se o agente segue uma skill do projeto; a suíte `long` (fora de `all`) tem tarefas de várias partes com checagens escondidas, onde o modelo ainda erra; a suíte `impossible` (também fora de `all`) traz um teste visível que contradiz o pedido e mede se o agente trapaceia ou relata o conflito. Mede acerto, passos, tokens, tempo, falhas de ferramenta e inglês na prosa; resultados em `eval/results/`.

## Desenvolvimento

```bash
npm run dev -- "tarefa"   # roda direto do TypeScript
npm run check             # checagem de tipos
npm test                  # testes (laço ReAct, revisão, permissões, travas, RAG…)
npm run build
```

```text
src/
  index.ts          CLI e modo interativo
  session.ts        sessão: provedores, sub-agentes, revisão, custo, trace
  agent.ts          laço ReAct, execução de ferramentas, reflexão, travas
  orchestrator.ts   pipeline planner → workers → revisor
  prompts.ts        núcleo cognitivo por papel
  tools.ts          ferramentas e permissões
  rag.ts            embeddings, BM25, índice do código
  memory.ts         memória vetorial de longo prazo
  providers/        ollama.ts · anthropic.ts
  ui.ts             saída do terminal
```

## Segurança

- As ferramentas de arquivo não saem do workspace. O `bash` roda com as permissões do seu usuário: use `--mode ask` (padrão) em projetos importantes e `--mode auto` só onde confia no resultado.
- Comandos destrutivos (`rm -rf /`, `sudo`, `git push --force`, `git reset --hard`, `curl | sh`, …) sempre pedem confirmação, mesmo em `auto`.
- `.alien/` guarda o índice e a memória do projeto. Ela já está no `.gitignore` deste repositório; adicione-a também nos projetos em que usar o agente.
