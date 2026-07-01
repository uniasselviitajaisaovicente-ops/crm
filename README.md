# CRM · Follow-up de Rematrícula

Sistema simples de acompanhamento de contatos (kanban) para follow-up de rematrícula de alunos, com login de colaboradores, quadro por status, anotações, importação de CSV e exportação de relatório.

## Stack

- **Frontend**: HTML + CSS + JS puro (sem build), usando `@supabase/supabase-js` via CDN
- **Backend/DB/Auth**: Supabase (Postgres + Auth + RLS)

## Estrutura de arquivos

```
index.html    -> tela e estrutura da aplicação
Style.css     -> estilos
Script.js     -> lógica (auth, CRUD, kanban, import/export)
schema.sql    -> schema do banco (tabelas, triggers, RLS)
```

## 1. Criar o projeto no Supabase

1. Acesse [supabase.com](https://supabase.com) e crie um novo projeto (plano free).
2. Vá em **SQL Editor** e cole o conteúdo de `schema.sql`. Rode o script.
   - Ele cria as tabelas `profiles`, `contacts` e `notes`.
   - Cria a trigger que gera automaticamente um `profile` quando alguém se cadastra.
   - Ativa Row Level Security (RLS) com as regras de permissão descritas abaixo.
3. Vá em **Project Settings > API** e copie:
   - `Project URL`
   - `anon public key`

## 2. Configurar o frontend

Abra `Script.js` e edite o topo do arquivo:

```js
var SUPABASE_URL = 'https://SEU-PROJETO.supabase.co';
var SUPABASE_ANON_KEY = 'SUA_CHAVE_ANON_PUBLICA';
```

## 3. Criar o primeiro usuário administrador

1. Abra o `index.html` no navegador (ou publique — veja seção de deploy).
2. Clique em **Criar conta**, preencha nome/email/senha.
3. Se a confirmação de email estiver ativada no Supabase (padrão), confirme o email antes de logar.
4. No **SQL Editor** do Supabase, promova esse usuário a admin:

```sql
update public.profiles set role = 'admin' where email = 'seu-email@exemplo.com';
```

Colaboradores adicionais podem se cadastrar normalmente pela tela de login; por padrão eles entram como `colaborador` (só enxergam e editam os próprios contatos). Só um `admin` consegue ver/editar tudo e reatribuir responsáveis.

> Dica: em **Authentication > Settings** do Supabase, você pode desativar a confirmação por email durante os testes, para logar na hora.

## 4. Modelo de dados

### `profiles`
| coluna    | tipo      | descrição                                  |
|-----------|-----------|---------------------------------------------|
| id        | uuid (PK) | mesmo id do `auth.users`                    |
| nome      | text      | nome exibido                                |
| email     | text      | email do usuário                            |
| role      | text      | `admin` ou `colaborador`                    |
| criado_em | timestamptz | data de criação                          |

### `contacts`
| coluna         | tipo      | descrição                                          |
|----------------|-----------|-----------------------------------------------------|
| id             | uuid (PK) | identificador do contato                             |
| nome           | text      | nome do aluno/lead                                   |
| telefone       | text      | telefone (usado em link `tel:` e WhatsApp)           |
| email          | text      | email (usado em link `mailto:`)                      |
| status         | text      | uma das 7 colunas do kanban (veja abaixo)             |
| colaborador_id | uuid (FK) | responsável pelo contato (`profiles.id`)             |
| meta           | jsonb     | `curso`, `polo`, `tipo`, `status_aluno`, `turma`, `codigo_aluno` — vindos da importação CSV |
| criado_em      | timestamptz | data de criação                                    |
| atualizado_em  | timestamptz | atualizado automaticamente por trigger a cada UPDATE |

Status possíveis: `nao_contatado`, `contato_realizado`, `sem_resposta`, `retornou_positivo`, `retornou_negativo`, `rematriculado`, `perdido`.

### `notes`
| coluna     | tipo      | descrição                                |
|------------|-----------|---------------------------------------------|
| id         | uuid (PK) | identificador da anotação                   |
| contact_id | uuid (FK) | contato relacionado (`contacts.id`)         |
| autor_id   | uuid (FK) | quem escreveu (`profiles.id`)               |
| autor_nome | text      | nome do autor no momento da anotação        |
| texto      | text      | conteúdo da anotação                        |
| criado_em  | timestamptz | data/hora                                 |

## 5. Regras de permissão (RLS)

- **Leitura**: todo usuário autenticado enxerga todos os `profiles`, `contacts` e `notes` (necessário para o admin ter visão geral e para o quadro "Todos os atendimentos").
- **Contatos**: um colaborador só pode **editar/excluir** contatos onde `colaborador_id = seu próprio id`. Um `admin` pode editar/excluir qualquer contato, inclusive reatribuir o responsável.
- **Criação de contato**: qualquer autenticado pode criar; se não for admin, só pode criar atribuído a si mesmo (ou sem responsável).
- **Anotações**: só quem tem permissão de editar o contato (dono ou admin) pode adicionar anotações nele.
- **Perfis**: ninguém se autopromove a admin pela aplicação — isso só é feito manualmente via SQL Editor.

## 6. Importação de CSV

O botão **Importar CSV** aceita arquivos separados por vírgula, ponto-e-vírgula ou tabulação, com detecção automática de cabeçalhos (aceita variações como `NOME_ALUNO`, `FONE`, `EMAIL`, `NOME_CURSO`, `NOME_POLO`, etc.). Contatos duplicados (mesmo telefone ou email já cadastrado) são ignorados automaticamente.

## 7. Deploy

Como é um app 100% estático (HTML/CSS/JS), pode ser hospedado em qualquer serviço de arquivos estáticos:

- **Vercel** / **Netlify**: arraste a pasta do projeto ou conecte um repositório Git.
- **GitHub Pages**: publique os 3 arquivos (`index.html`, `Style.css`, `Script.js`) na branch de páginas.

Nenhum backend próprio é necessário — toda a lógica de dados passa direto pelo Supabase (Postgres + Auth + RLS) a partir do navegador.
