(function () {
  'use strict';

  // ================= CONFIGURAÇÃO DO SUPABASE =================
  // Troque pelos dados do SEU projeto (Supabase > Project Settings > API)
  const SUPABASE_URL = 'https://khcurhrumyiiyvdaamqg.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtoY3VyaHJ1bXlpaXl2ZGFhbXFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NjMwMzYsImV4cCI6MjA5NDMzOTAzNn0.Pw0UJUVs5Qzvc3cz-Z_h_Q09H8nS5H4s8L9i_YHQkqI';
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  // ===============================================================

  // ---------- Config de status (workflow interno do CRM) ----------
  const STATUS_COLS = [
    { id: 'nao_contatado',      label: 'Não Contatado',              color: '#9CA3AF' },
    { id: 'contato_realizado',  label: 'Contato Realizado',          color: '#3B82F6' },
    { id: 'sem_resposta',       label: 'Sem Resposta',               color: '#EAB308' },
    { id: 'retornou_positivo',  label: 'Retornou · Interessado',     color: '#10B981' },
    { id: 'retornou_negativo',  label: 'Retornou · Não Interessado', color: '#F97316' },
    { id: 'rematriculado',      label: 'Rematriculado ✓',            color: '#059669' },
    { id: 'perdido',            label: 'Perdido ✕',                  color: '#DC2626' }
  ];
  const STATUS_MAP = {};
  STATUS_COLS.forEach(function (s) { STATUS_MAP[s.id] = s; });

  // ---------- State ----------
  const state = {
    profile: null,        // {id, nome, email, role}
    profiles: [],          // todos os colaboradores
    contacts: [],           // TODOS os contatos visíveis (RLS libera leitura geral)
    activeTab: 'board',
    filterColaborador: '__todos__',
    search: '',
    activeContactId: null,
    appBound: false,
    messages: [],           // chat geral da equipe
    notesChannel: null      // canal realtime das notas do contato aberto no modal
  };

  // ---------- Utils ----------
  function nowISO() { return new Date().toISOString(); }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function onlyDigits(s) { return (s || '').replace(/\D/g, ''); }
  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._tm);
    showToast._tm = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }
  function isAdmin() { return !!state.profile && state.profile.role === 'admin'; }
  function canEdit(c) { return !!state.profile && (isAdmin() || c.colaborador_id === state.profile.id); }
  function colabName(id) {
    if (!id) return 'Não atribuído';
    const p = state.profiles.find(function (x) { return x.id === id; });
    return p ? p.nome : 'Ex-colaborador';
  }

  // ================= AUTENTICAÇÃO =================
  function showAuthError(msg) {
    const el = document.getElementById('authError');
    el.textContent = msg; el.classList.add('show');
    document.getElementById('authMsg').classList.remove('show');
  }
  function showAuthMsg(msg) {
    const el = document.getElementById('authMsg');
    el.textContent = msg; el.classList.add('show');
    document.getElementById('authError').classList.remove('show');
  }
  function clearAuthMsgs() {
    document.getElementById('authError').classList.remove('show');
    document.getElementById('authMsg').classList.remove('show');
  }

  function bindAuthEvents() {
    document.querySelectorAll('[data-authtab]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('[data-authtab]').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        const target = tab.getAttribute('data-authtab');
        document.getElementById('formLogin').classList.toggle('active', target === 'login');
        document.getElementById('formSignup').classList.toggle('active', target === 'signup');
        clearAuthMsgs();
      });
    });

    document.getElementById('formLogin').addEventListener('submit', async function (e) {
      e.preventDefault();
      clearAuthMsgs();
      const email = document.getElementById('loginEmail').value.trim();
      const senha = document.getElementById('loginSenha').value;
      const { error } = await sb.auth.signInWithPassword({ email: email, password: senha });
      if (error) showAuthError('Não foi possível entrar: ' + error.message);
    });

    document.getElementById('formSignup').addEventListener('submit', async function (e) {
      e.preventDefault();
      clearAuthMsgs();
      const nome = document.getElementById('suNome').value.trim();
      const email = document.getElementById('suEmail').value.trim();
      const senha = document.getElementById('suSenha').value;
      const { data, error } = await sb.auth.signUp({
        email: email, password: senha, options: { data: { nome: nome } }
      });
      if (error) { showAuthError('Não foi possível criar a conta: ' + error.message); return; }
      if (data.session) {
        showToast('Conta criada com sucesso!');
      } else {
        showAuthMsg('Conta criada! Verifique seu email para confirmar o cadastro e depois faça login.');
      }
    });

    document.getElementById('btnLogout').addEventListener('click', async function () {
      sb.removeAllChannels();
      state.notesChannel = null;
      await sb.auth.signOut();
    });
  }

  function showAuthScreen() {
    document.getElementById('authScreen').style.display = 'flex';
    document.getElementById('authApp').style.display = 'none';
    document.getElementById('formLogin').reset();
    document.getElementById('formSignup').reset();
    clearAuthMsgs();
  }

  async function afterLogin(user) {
    // Busca (ou aguarda) o perfil criado pela trigger no cadastro
    const profile = await fetchProfileWithRetry(user.id);
    if (!profile) {
      showAuthError('Não foi possível carregar seu perfil. Tente novamente em instantes.');
      await sb.auth.signOut();
      return;
    }
    state.profile = profile;
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('authApp').style.display = 'block';
    document.getElementById('meNome').textContent = profile.nome;
    const roleChip = document.getElementById('meRole');
    roleChip.textContent = profile.role === 'admin' ? 'admin' : 'colaborador';
    roleChip.classList.toggle('admin', profile.role === 'admin');
    document.getElementById('tabBoard').textContent = isAdmin() ? 'Quadro (todos)' : 'Meu quadro';

    if (!state.appBound) { bindAppEvents(); state.appBound = true; }

    await loadProfiles();
    await loadContactsAndNotes();
    await loadMessages();
    subscribeTeamChat();
  }

  async function fetchProfileWithRetry(userId) {
    for (let i = 0; i < 5; i++) {
      const { data, error } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
      if (data) return data;
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    return null;
  }

  // ================= CARREGAMENTO DE DADOS =================
  async function loadProfiles() {
    const { data, error } = await sb.from('profiles').select('*').order('nome');
    if (error) { showToast('Erro ao carregar equipe: ' + error.message); return; }
    state.profiles = data || [];
  }

  async function loadContactsAndNotes() {
    const { data: contacts, error } = await sb.from('contacts').select('*').order('criado_em', { ascending: false });
    if (error) { showToast('Erro ao carregar contatos: ' + error.message); return; }
    const { data: notes, error: notesErr } = await sb.from('notes').select('*').order('criado_em', { ascending: true });
    if (notesErr) { showToast('Erro ao carregar anotações: ' + notesErr.message); }
    const notesMap = {};
    (notes || []).forEach(function (n) {
      (notesMap[n.contact_id] = notesMap[n.contact_id] || []).push(n);
    });
    state.contacts = (contacts || []).map(function (c) {
      c.notas = (notesMap[c.id] || []).map(function (n) {
        return { id: n.id, texto: n.texto, data: n.criado_em, autor: n.autor_nome, autor_id: n.autor_id };
      });
      return c;
    });
    renderAll();
  }

  // ================= CHAT GERAL DA EQUIPE =================
  async function loadMessages() {
    const { data, error } = await sb.from('messages').select('*').order('criado_em', { ascending: true });
    if (error) { showToast('Erro ao carregar chat: ' + error.message); return; }
    state.messages = data || [];
    renderTeamChat();
  }

  async function sendTeamMessage(texto) {
    const { error } = await sb.from('messages').insert({
      autor_id: state.profile.id, autor_nome: state.profile.nome, texto: texto
    });
    if (error) {
      showToast('Não foi possível enviar a mensagem: ' + error.message);
      console.error('sendTeamMessage error:', error);
      return false;
    }
    return true;
  }

  function renderTeamChat() {
    const wrap = document.getElementById('teamChatMessages');
    if (!wrap) return;
    const html = state.messages.length ? state.messages.map(function (m) {
      const mine = state.profile && m.autor_id === state.profile.id;
      return '<div class="chat-msg' + (mine ? ' mine' : '') + '">' +
        '<div class="chat-msg-meta">' + esc(m.autor_nome || 'Sem autor') + ' · ' + fmtDate(m.criado_em) + '</div>' +
        '<div class="chat-msg-text">' + esc(m.texto) + '</div>' +
      '</div>';
    }).join('') : '<div style="font-size:12px;color:var(--text-soft);">Nenhuma mensagem ainda. Diga oi para a equipe!</div>';
    wrap.innerHTML = html;
    wrap.scrollTop = wrap.scrollHeight;
  }

  function subscribeTeamChat() {
    sb.channel('team-chat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, function (payload) {
        const exists = state.messages.some(function (m) { return m.id === payload.new.id; });
        if (!exists) state.messages.push(payload.new);
        renderTeamChat();
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, function (payload) {
        state.messages = state.messages.filter(function (m) { return m.id !== payload.old.id; });
        renderTeamChat();
      })
      .subscribe(function (status, err) {
        // Se a tabela "messages" não estiver com Realtime habilitado no Supabase,
        // ou o RLS bloquear SELECT, o status virá diferente de "SUBSCRIBED".
        if (status !== 'SUBSCRIBED') {
          console.warn('[team-chat] status da assinatura realtime:', status, err || '');
        }
      });
  }

  // ---------- Notas ao vivo (realtime por contato aberto) ----------
  function subscribeContactNotes(contactId) {
    if (state.notesChannel) {
      sb.removeChannel(state.notesChannel);
      state.notesChannel = null;
    }
    state.notesChannel = sb.channel('notes-' + contactId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notes', filter: 'contact_id=eq.' + contactId }, function (payload) {
        const c = state.contacts.find(function (x) { return x.id === contactId; });
        if (!c) return;
        const n = payload.new;
        const already = (c.notas || []).some(function (existing) { return existing.id === n.id; });
        if (already) return;
        c.notas = (c.notas || []).concat([{ id: n.id, texto: n.texto, data: n.criado_em, autor: n.autor_nome, autor_id: n.autor_id }]);
        if (state.activeContactId === contactId) renderNotes(c);
      })
      .subscribe();
  }

  function unsubscribeContactNotes() {
    if (state.notesChannel) {
      sb.removeChannel(state.notesChannel);
      state.notesChannel = null;
    }
  }

  // ================= AÇÕES (Supabase) =================
  async function insertContact(obj) {
    const { error } = await sb.from('contacts').insert(obj);
    if (error) { showToast('Erro ao criar contato: ' + error.message); return false; }
    return true;
  }
  async function updateContact(id, patch) {
    patch = Object.assign({}, patch, { atualizado_em: nowISO() });
    const { error } = await sb.from('contacts').update(patch).eq('id', id);
    if (error) { showToast('Sem permissão para editar este contato.'); return false; }
    return true;
  }
  async function deleteContactRemote(id) {
    const { error } = await sb.from('contacts').delete().eq('id', id);
    if (error) { showToast('Sem permissão para excluir este contato.'); return false; }
    return true;
  }
  async function addNoteRemote(contactId, texto) {
    const { error } = await sb.from('notes').insert({
      contact_id: contactId, autor_id: state.profile.id, autor_nome: state.profile.nome, texto: texto
    });
    if (error) { showToast('Sem permissão para anotar neste contato.'); return false; }
    return true;
  }

  // ================= IMPORTAÇÃO (CSV e XLSX) =================
  // Ambos os formatos convergem para a mesma matriz [cabecalho, ...linhas]
  // e passam pelo mesmo mapeamento de colunas (buildRowsFromMatrix).

  function detectDelimiter(headerLine) {
    const candidates = ['\t', ';', ','];
    let best = ',', bestCount = -1;
    candidates.forEach(function (d) {
      const count = headerLine.split(d).length;
      if (count > bestCount) { bestCount = count; best = d; }
    });
    return best;
  }
  function parseCSVLine(line, delim) {
    const result = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === delim && !inQuotes) { result.push(cur); cur = ''; }
      else { cur += ch; }
    }
    result.push(cur);
    return result.map(function (s) { return s.trim(); });
  }
  function normalizeHeader(h) {
    return String(h || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
      .replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  }

  // Aliases de cabeçalho reconhecidos. "status_origem" cobre a coluna "STATUS"
  // da planilha de renovação (ex.: "Não Renovado") — é a situação de origem do
  // aluno, e é guardada em contacts.meta.status_origem. Ela NÃO substitui o
  // status de workflow do quadro (esse sempre começa como "nao_contatado").
  const HEADER_ALIASES = {
    nome: ['NOME_ALUNO', 'NOME', 'ALUNO', 'CLIENTE', 'NAME'],
    telefone: ['FONE', 'TELEFONE', 'CELULAR', 'WHATSAPP', 'PHONE', 'TEL'],
    email: ['EMAIL', 'E_MAIL'],
    curso: ['NOME_CURSO', 'CURSO'],
    polo: ['NOME_POLO', 'POLO'],
    tipo: ['TIPO'],
    status_aluno: ['STATUS_ALUNO'],
    status_origem: ['STATUS', 'SITUACAO', 'SITUACAO_MATRICULA', 'SITUACAO_ATUAL'],
    turma: ['TURMA'],
    codigo_aluno: ['CODIGO_ALUNO', 'CODIGO', 'MATRICULA']
  };
  function mapHeaders(rawHeaders) {
    const norm = rawHeaders.map(normalizeHeader);
    const map = {};
    Object.keys(HEADER_ALIASES).forEach(function (field) {
      const aliases = HEADER_ALIASES[field];
      for (let i = 0; i < norm.length; i++) {
        if (aliases.indexOf(norm[i]) !== -1) { map[field] = i; break; }
      }
    });
    return map;
  }

  // Monta os objetos "row" a partir de uma matriz genérica [header, ...linhas].
  // Usado tanto pelo caminho CSV quanto pelo caminho XLSX.
  function buildRowsFromMatrix(headerRow, dataRows) {
    const map = mapHeaders(headerRow || []);
    if (map.nome === undefined || (map.telefone === undefined && map.email === undefined)) {
      return { rows: [], map: map, error: 'Não encontrei colunas de nome e telefone/email no arquivo.' };
    }
    const get = function (cols, idx) {
      if (idx === undefined) return '';
      const v = cols[idx];
      return (v === undefined || v === null) ? '' : String(v).trim();
    };
    const rows = [];
    (dataRows || []).forEach(function (cols) {
      if (!cols || cols.length === 0) return;
      const row = {
        nome: get(cols, map.nome),
        telefone: get(cols, map.telefone),
        email: get(cols, map.email),
        curso: get(cols, map.curso),
        polo: get(cols, map.polo),
        tipo: get(cols, map.tipo),
        status_aluno: get(cols, map.status_aluno),
        status_origem: get(cols, map.status_origem),
        turma: get(cols, map.turma),
        codigo_aluno: get(cols, map.codigo_aluno)
      };
      if (row.nome) rows.push(row);
    });
    return { rows: rows, map: map, error: null };
  }

  function parseCSV(text) {
    const lines = text.split(/\r\n|\n|\r/).filter(function (l) { return l.trim().length > 0; });
    if (lines.length === 0) return { rows: [], map: {}, error: 'Arquivo vazio.' };
    const delim = detectDelimiter(lines[0]);
    const headerRow = parseCSVLine(lines[0], delim);
    const dataRows = lines.slice(1).map(function (line) { return parseCSVLine(line, delim); });
    return buildRowsFromMatrix(headerRow, dataRows);
  }

  // Carrega o SheetJS (biblioteca "xlsx") sob demanda, só quando o usuário
  // realmente importa um arquivo .xlsx/.xls — evita peso extra no carregamento inicial.
  function ensureXLSXLib() {
    return new Promise(function (resolve, reject) {
      if (window.XLSX) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Não foi possível carregar o leitor de XLSX. Verifique sua conexão.')); };
      document.head.appendChild(s);
    });
  }

  async function parseXLSX(arrayBuffer) {
    await ensureXLSXLib();
    const wb = window.XLSX.read(arrayBuffer, { type: 'array' });
    const firstSheetName = wb.SheetNames[0];
    if (!firstSheetName) return { rows: [], map: {}, error: 'A planilha não tem nenhuma aba.' };
    const sheet = wb.Sheets[firstSheetName];
    // header:1 => matriz de arrays (não objetos), preservando a ordem das colunas
    const matrix = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: false });
    if (!matrix.length) return { rows: [], map: {}, error: 'Planilha vazia.' };
    const headerRow = matrix[0];
    const dataRows = matrix.slice(1);
    return buildRowsFromMatrix(headerRow, dataRows);
  }

  async function importRows(rows, colaboradorId) {
    let added = 0, skipped = 0;
    const existingKeys = {};
    state.contacts.forEach(function (c) {
      if (c.telefone) existingKeys['t:' + onlyDigits(c.telefone)] = true;
      if (c.email) existingKeys['e:' + c.email.toLowerCase()] = true;
      if (c.meta && c.meta.codigo_aluno) existingKeys['c:' + String(c.meta.codigo_aluno)] = true;
    });
    const toInsert = [];
    rows.forEach(function (r) {
      const tKey = r.telefone ? 't:' + onlyDigits(r.telefone) : null;
      const eKey = r.email ? 'e:' + r.email.toLowerCase() : null;
      const cKey = r.codigo_aluno ? 'c:' + r.codigo_aluno : null;
      if ((tKey && existingKeys[tKey]) || (eKey && existingKeys[eKey]) || (cKey && existingKeys[cKey])) { skipped++; return; }
      toInsert.push({
        nome: r.nome, telefone: r.telefone || null, email: r.email || null,
        status: 'nao_contatado', colaborador_id: colaboradorId || null,
        meta: {
          curso: r.curso || '',
          polo: r.polo || '',
          tipo: r.tipo || '',
          status_aluno: r.status_aluno || '',
          status_origem: r.status_origem || '',
          turma: r.turma || '',
          codigo_aluno: r.codigo_aluno || ''
        }
      });
      if (tKey) existingKeys[tKey] = true;
      if (eKey) existingKeys[eKey] = true;
      if (cKey) existingKeys[cKey] = true;
      added++;
    });
    if (toInsert.length) {
      const { error } = await sb.from('contacts').insert(toInsert);
      if (error) { showToast('Erro ao importar: ' + error.message); return { added: 0, skipped: skipped }; }
    }
    return { added: added, skipped: skipped };
  }

  // ---------- Derived / filters ----------
  function baseListForBoard() {
    if (isAdmin()) return state.contacts;
    return state.contacts.filter(function (c) { return c.colaborador_id === state.profile.id; });
  }
  function applyFilters(list) {
    const q = state.search.trim().toLowerCase();
    return list.filter(function (c) {
      if (state.filterColaborador !== '__todos__' && c.colaborador_id !== state.filterColaborador) return false;
      if (q) {
        const hay = (c.nome + ' ' + (c.telefone || '') + ' ' + (c.email || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  // ---------- Rendering ----------
  function renderSelects() {
    const selFilter = document.getElementById('selFilterColab');
    selFilter.innerHTML = '<option value="__todos__">Todos</option>' +
      state.profiles.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.nome) + '</option>'; }).join('');
    selFilter.value = state.filterColaborador;

    ['cColab', 'nColab', 'iColab'].forEach(function (id) {
      const el = document.getElementById(id);
      const prev = el.value;
      el.innerHTML = '<option value="">Não atribuído</option>' +
        state.profiles.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.nome) + '</option>'; }).join('');
      el.value = prev;
    });

    const selStatus = document.getElementById('cStatus');
    selStatus.innerHTML = STATUS_COLS.map(function (s) { return '<option value="' + s.id + '">' + esc(s.label) + '</option>'; }).join('');
  }

  function renderStats() {
    const list = applyFilters(state.activeTab === 'board' ? baseListForBoard() : state.contacts);
    const total = list.length;
    let html = '<div class="stat-card"><div class="n">' + total + '</div><div class="l">Contatos na visão atual</div></div>';
    STATUS_COLS.forEach(function (s) {
      const n = list.filter(function (c) { return c.status === s.id; }).length;
      html += '<div class="stat-card"><div class="n" style="color:' + s.color + '">' + n + '</div><div class="l">' + esc(s.label) + '</div></div>';
    });
    document.getElementById('statsBar').innerHTML = html;
  }

  function contactCardHTML(c) {
    let tags = '';
    if (c.meta && c.meta.curso) tags += '<span class="tag">' + esc(c.meta.curso) + '</span>';
    if (c.meta && c.meta.tipo) tags += '<span class="tag gray">' + esc(c.meta.tipo) + '</span>';
    if (c.meta && c.meta.status_origem) tags += '<span class="tag gray">' + esc(c.meta.status_origem) + '</span>';
    const colabTag = '<span class="tag gray">👤 ' + esc(colabName(c.colaborador_id)) + '</span>';
    const statusOptions = STATUS_COLS.map(function (st) {
      return '<option value="' + st.id + '"' + (st.id === c.status ? ' selected' : '') + '>' + esc(st.label) + '</option>';
    }).join('');
    return '' +
      '<div class="card" draggable="true" data-id="' + c.id + '">' +
        '<div class="name">' + esc(c.nome) + '</div>' +
        (c.telefone ? '<div class="meta-line">📞 ' + esc(c.telefone) + '</div>' : '') +
        (c.email ? '<div class="meta-line">✉️ ' + esc(c.email) + '</div>' : '') +
        '<div class="tags">' + colabTag + tags + '</div>' +
        '<div class="foot">' +
          '<select class="statusSelect" data-id="' + c.id + '">' + statusOptions + '</select>' +
        '</div>' +
        (c.notas && c.notas.length ? '<div class="notes-badge">📝 ' + c.notas.length + ' anotação(ões)</div>' : '') +
      '</div>';
  }

  function renderBoard() {
    const list = applyFilters(baseListForBoard());
    const board = document.getElementById('board');
    board.innerHTML = STATUS_COLS.map(function (s) {
      const items = list.filter(function (c) { return c.status === s.id; });
      const cardsHTML = items.length ? items.map(contactCardHTML).join('') : '<div class="empty-col">Nenhum contato aqui</div>';
      return '' +
        '<div class="column" data-status="' + s.id + '">' +
          '<div class="col-head">' +
            '<div class="title"><span class="col-dot" style="background:' + s.color + '"></span>' + esc(s.label) + '</div>' +
            '<div class="col-count">' + items.length + '</div>' +
          '</div>' +
          '<div class="cards" data-status="' + s.id + '">' + cardsHTML + '</div>' +
        '</div>';
    }).join('');
    wireBoardEvents();
  }

  function renderTable() {
    const list = applyFilters(state.contacts);
    const wrap = document.getElementById('tableWrap');
    if (!list.length) {
      wrap.innerHTML = '<div class="empty-col">Nenhum atendimento encontrado.</div>';
      return;
    }
    const rows = list.map(function (c) {
      const s = STATUS_MAP[c.status] || STATUS_COLS[0];
      return '<tr data-id="' + c.id + '">' +
        '<td><b>' + esc(c.nome) + '</b></td>' +
        '<td>' + esc(c.telefone || '—') + '</td>' +
        '<td>' + esc(c.email || '—') + '</td>' +
        '<td><span class="status-pill" style="background:' + s.color + '">' + esc(s.label) + '</span></td>' +
        '<td>' + esc(colabName(c.colaborador_id)) + '</td>' +
        '<td>' + (c.notas ? c.notas.length : 0) + '</td>' +
        '<td>' + fmtDate(c.atualizado_em) + '</td>' +
      '</tr>';
    }).join('');
    wrap.innerHTML = '<table class="data-table"><thead><tr>' +
      '<th>Nome</th><th>Telefone</th><th>Email</th><th>Status</th><th>Responsável</th><th>Notas</th><th>Atualizado em</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
    wrap.querySelectorAll('tr[data-id]').forEach(function (tr) {
      tr.addEventListener('click', function () { openContactModal(tr.getAttribute('data-id')); });
    });
  }

  function renderAll() {
    renderSelects();
    const teamChatEl = document.getElementById('teamChat');
    if (state.activeTab === 'chat') {
      document.getElementById('board').style.display = 'none';
      document.getElementById('tableWrap').style.display = 'none';
      document.getElementById('statsBar').style.display = 'none';
      if (teamChatEl) teamChatEl.style.display = 'flex';
      return;
    }
    if (teamChatEl) teamChatEl.style.display = 'none';
    document.getElementById('statsBar').style.display = 'flex';
    renderStats();
    if (state.activeTab === 'board') { renderBoard(); document.getElementById('board').style.display = 'flex'; document.getElementById('tableWrap').style.display = 'none'; }
    else { renderTable(); document.getElementById('board').style.display = 'none'; document.getElementById('tableWrap').style.display = 'block'; }
  }

  // ---------- Drag and drop (só faz sentido no quadro, onde tudo é editável) ----------
  function wireBoardEvents() {
    document.querySelectorAll('.card').forEach(function (card) {
      card.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/plain', card.getAttribute('data-id'));
      });
      card.addEventListener('click', function (e) {
        if (e.target.classList.contains('statusSelect')) return;
        openContactModal(card.getAttribute('data-id'));
      });
    });
    document.querySelectorAll('.statusSelect').forEach(function (sel) {
      sel.addEventListener('click', function (e) { e.stopPropagation(); });
      sel.addEventListener('change', async function () {
        const ok = await updateContact(sel.getAttribute('data-id'), { status: sel.value });
        if (ok) await loadContactsAndNotes();
      });
    });
    document.querySelectorAll('.column').forEach(function (col) {
      col.addEventListener('dragover', function (e) { e.preventDefault(); col.classList.add('dragover'); });
      col.addEventListener('dragleave', function () { col.classList.remove('dragover'); });
      col.addEventListener('drop', async function (e) {
        e.preventDefault();
        col.classList.remove('dragover');
        const id = e.dataTransfer.getData('text/plain');
        const ok = await updateContact(id, { status: col.getAttribute('data-status') });
        if (ok) await loadContactsAndNotes();
      });
    });
  }

  // ---------- Contact modal ----------
  function openContactModal(id) {
    const c = state.contacts.find(function (x) { return x.id === id; });
    if (!c) return;
    state.activeContactId = id;
    renderSelects();
    const editable = canEdit(c);
    const admin = isAdmin();

    document.getElementById('cName').textContent = c.nome;
    document.getElementById('cReadonlyBanner').style.display = editable ? 'none' : 'block';
    document.getElementById('cStatus').value = c.status;
    document.getElementById('cColab').value = c.colaborador_id || '';
    document.getElementById('cPhone').value = c.telefone || '';
    document.getElementById('cEmail').value = c.email || '';

    document.getElementById('cStatus').disabled = !editable;
    document.getElementById('cColab').disabled = !admin;
    document.getElementById('cPhone').disabled = !editable;
    document.getElementById('cEmail').disabled = !editable;
    document.getElementById('cActions').style.display = editable ? 'flex' : 'none';
    document.getElementById('noteAddBox').style.display = editable ? 'block' : 'none';

    let links = '';
    if (c.telefone) {
      const digits = onlyDigits(c.telefone);
      links += '<a href="tel:' + digits + '">📞 Ligar</a>';
      links += '<a href="https://wa.me/55' + digits + '" target="_blank" rel="noopener">💬 WhatsApp</a>';
    }
    if (c.email) links += '<a href="mailto:' + esc(c.email) + '">✉️ Email</a>';
    document.getElementById('cLinks').innerHTML = links;

    const m = c.meta || {};
    let metaHTML = '';
    [
      ['Curso', m.curso],
      ['Polo', m.polo],
      ['Tipo', m.tipo],
      ['Situação de origem', m.status_origem],
      ['Status aluno', m.status_aluno],
      ['Turma', m.turma],
      ['Código', m.codigo_aluno]
    ].forEach(function (pair) {
      if (pair[1]) metaHTML += '<div><b>' + pair[0] + ':</b> ' + esc(pair[1]) + '</div>';
    });
    metaHTML += '<div><b>Criado em:</b> ' + fmtDate(c.criado_em) + '</div>';
    metaHTML += '<div><b>Atualizado em:</b> ' + fmtDate(c.atualizado_em) + '</div>';
    document.getElementById('cMetaGrid').innerHTML = metaHTML;

    renderNotes(c);
    document.getElementById('noteInput').value = '';
    subscribeContactNotes(c.id);
    openOverlay('overlayContact');
  }

  function renderNotes(c) {
    const list = (c.notas || []).slice().reverse();
    const html = list.length ? list.map(function (n) {
      return '<div class="note-item"><div class="note-meta">' + esc(n.autor || 'Sem autor') + ' · ' + fmtDate(n.data) + '</div>' + esc(n.texto) + '</div>';
    }).join('') : '<div style="font-size:12px;color:var(--text-soft);">Nenhuma anotação ainda.</div>';
    document.getElementById('notesList').innerHTML = html;
  }

  // ---------- Overlays ----------
  function openOverlay(id) { document.getElementById(id).classList.add('open'); }
  function closeOverlay(id) { document.getElementById(id).classList.remove('open'); }

  // ---------- Bind app events (uma única vez) ----------
  function bindAppEvents() {
    document.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', function () { closeOverlay(btn.getAttribute('data-close')); });
    });
    document.querySelectorAll('.overlay').forEach(function (ov) {
      ov.addEventListener('click', function (e) { if (e.target === ov) closeOverlay(ov.id); });
    });

    // Encerra a assinatura de notas ao vivo quando o modal do contato fecha
    document.getElementById('overlayContact').addEventListener('click', function (e) {
      if (e.target === this || (e.target.hasAttribute('data-close') && e.target.getAttribute('data-close') === 'overlayContact')) {
        unsubscribeContactNotes();
      }
    });

    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        state.activeTab = btn.getAttribute('data-tab');
        renderAll();
        if (state.activeTab === 'chat') renderTeamChat();
      });
    });

    // Chat geral da equipe
    document.getElementById('formTeamChat').addEventListener('submit', async function (e) {
      e.preventDefault();
      const input = document.getElementById('teamChatInput');
      const txt = input.value.trim();
      if (!txt) return;
      input.value = '';
      const before = state.messages.length;
      const ok = await sendTeamMessage(txt);
      if (ok) {
        // Fallback: se o Realtime não estiver habilitado na tabela "messages"
        // (Database > Replication no Supabase), o INSERT nunca chega de volta
        // pelo canal "team-chat" e a mensagem "some". Isso recarrega na marra
        // depois de um tempo curto, caso o evento realtime não tenha chegado.
        setTimeout(async function () {
          if (state.messages.length === before) await loadMessages();
        }, 1200);
      }
    });

    document.getElementById('selFilterColab').addEventListener('change', function () {
      state.filterColaborador = this.value;
      renderAll();
    });
    document.getElementById('searchInput').addEventListener('input', function () {
      state.search = this.value;
      renderStats();
      if (state.activeTab === 'board') renderBoard(); else renderTable();
    });

    // Contact modal actions
    document.getElementById('btnSaveContact').addEventListener('click', async function () {
      const id = state.activeContactId;
      const c = state.contacts.find(function (x) { return x.id === id; });
      if (!c || !canEdit(c)) { showToast('Você não tem permissão para editar este contato.'); return; }
      const patch = {
        status: document.getElementById('cStatus').value,
        telefone: document.getElementById('cPhone').value.trim(),
        email: document.getElementById('cEmail').value.trim()
      };
      if (isAdmin()) patch.colaborador_id = document.getElementById('cColab').value || null;
      const ok = await updateContact(id, patch);
      if (ok) {
        await loadContactsAndNotes();
        closeOverlay('overlayContact');
        showToast('Contato atualizado.');
      }
    });
    document.getElementById('btnDeleteContact').addEventListener('click', async function () {
      const id = state.activeContactId;
      const c = state.contacts.find(function (x) { return x.id === id; });
      if (!c || !canEdit(c)) { showToast('Você não tem permissão para excluir este contato.'); return; }
      if (!confirm('Excluir este contato definitivamente?')) return;
      const ok = await deleteContactRemote(id);
      if (ok) {
        await loadContactsAndNotes();
        closeOverlay('overlayContact');
        showToast('Contato excluído.');
      }
    });
    document.getElementById('btnAddNote').addEventListener('click', async function () {
      const txt = document.getElementById('noteInput').value.trim();
      if (!txt) return;
      const ok = await addNoteRemote(state.activeContactId, txt);
      if (ok) {
        await loadContactsAndNotes();
        const c = state.contacts.find(function (x) { return x.id === state.activeContactId; });
        if (c) renderNotes(c);
        document.getElementById('noteInput').value = '';
      }
    });

    // New contact modal
    document.getElementById('btnAddContact').addEventListener('click', function () {
      document.getElementById('nNome').value = '';
      document.getElementById('nFone').value = '';
      document.getElementById('nEmail').value = '';
      renderSelects();
      document.getElementById('nColab').value = isAdmin() ? '' : state.profile.id;
      document.getElementById('nColab').disabled = !isAdmin();
      openOverlay('overlayNew');
    });
    document.getElementById('btnSaveNew').addEventListener('click', async function () {
      const nome = document.getElementById('nNome').value.trim();
      if (!nome) { showToast('Informe o nome do contato.'); return; }
      const colab = isAdmin() ? (document.getElementById('nColab').value || null) : state.profile.id;
      const ok = await insertContact({
        nome: nome,
        telefone: document.getElementById('nFone').value.trim(),
        email: document.getElementById('nEmail').value.trim(),
        status: 'nao_contatado', colaborador_id: colab, meta: {}
      });
      if (ok) {
        await loadContactsAndNotes();
        closeOverlay('overlayNew');
        showToast('Contato adicionado.');
      }
    });

    // Import CSV/XLSX modal
    document.getElementById('btnImport').addEventListener('click', function () {
      document.getElementById('importSummary').textContent = '';
      document.getElementById('iFile').value = '';
      renderSelects();
      document.getElementById('iColab').value = isAdmin() ? '' : state.profile.id;
      document.getElementById('iColab').disabled = !isAdmin();
      openOverlay('overlayImport');
    });
    document.getElementById('iFile').addEventListener('change', function (e) {
      const file = e.target.files[0];
      if (!file) return;
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const colab = isAdmin() ? (document.getElementById('iColab').value || null) : state.profile.id;
      const summaryEl = document.getElementById('importSummary');

      async function finishImport(result) {
        if (result.error) {
          summaryEl.innerHTML = '<span style="color:#DC2626;">' + esc(result.error) + '</span>';
          return;
        }
        const r = await importRows(result.rows, colab);
        summaryEl.innerHTML =
          '<span style="color:#059669;">' + r.added + ' contato(s) importado(s).</span>' +
          (r.skipped ? ' <span style="color:#6B7280;">' + r.skipped + ' duplicado(s) ignorado(s).</span>' : '');
        await loadContactsAndNotes();
        showToast(r.added + ' contato(s) importado(s) com sucesso.');
      }

      if (ext === 'xlsx' || ext === 'xls') {
        summaryEl.textContent = 'Lendo planilha...';
        const reader = new FileReader();
        reader.onload = async function (ev) {
          try {
            const result = await parseXLSX(ev.target.result);
            await finishImport(result);
          } catch (err) {
            summaryEl.innerHTML = '<span style="color:#DC2626;">' + esc(err.message || 'Erro ao ler o XLSX.') + '</span>';
          }
        };
        reader.onerror = function () {
          summaryEl.innerHTML = '<span style="color:#DC2626;">Não foi possível ler o arquivo.</span>';
        };
        reader.readAsArrayBuffer(file);
      } else {
        const reader = new FileReader();
        reader.onload = async function (ev) {
          const result = parseCSV(ev.target.result);
          await finishImport(result);
        };
        reader.onerror = function () {
          summaryEl.innerHTML = '<span style="color:#DC2626;">Não foi possível ler o arquivo.</span>';
        };
        reader.readAsText(file, 'UTF-8');
      }
    });

    // Equipe modal
    document.getElementById('btnManageColab').addEventListener('click', function () {
      renderColabList();
      openOverlay('overlayColab');
    });

    // Export CSV
    document.getElementById('btnExport').addEventListener('click', exportCSV);
  }

  function renderColabList() {
    const html = state.profiles.map(function (p) {
      const count = state.contacts.filter(function (x) { return x.colaborador_id === p.id; }).length;
      const roleTag = p.role === 'admin' ? '<span class="role-chip admin" style="margin-left:6px;">admin</span>' : '';
      return '<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg);border-radius:7px;padding:7px 10px;font-size:13px;">' +
        '<span>' + esc(p.nome) + roleTag + '</span>' +
        '<span style="color:var(--text-soft);font-size:11.5px;">' + count + ' atendimento(s)</span>' +
      '</div>';
    }).join('') || '<div style="font-size:12.5px;color:var(--text-soft);">Nenhum colaborador cadastrado ainda.</div>';
    document.getElementById('colabList').innerHTML = html;
  }

  function exportCSV() {
    const list = state.activeTab === 'board' ? applyFilters(baseListForBoard()) : applyFilters(state.contacts);
    const rows = [['Nome', 'Telefone', 'Email', 'Status', 'Responsavel', 'Curso', 'Polo', 'Tipo', 'Situacao_Origem', 'Ultima_Atualizacao', 'Anotacoes']];
    list.forEach(function (c) {
      const statusLabel = (STATUS_MAP[c.status] || {}).label || c.status;
      const notas = (c.notas || []).map(function (n) { return n.texto; }).join(' | ');
      rows.push([
        c.nome, c.telefone, c.email, statusLabel, colabName(c.colaborador_id),
        c.meta && c.meta.curso, c.meta && c.meta.polo, c.meta && c.meta.tipo,
        c.meta && c.meta.status_origem, fmtDate(c.atualizado_em), notas
      ]);
    });
    const csv = rows.map(function (r) {
      return r.map(function (cell) {
        let v = (cell === undefined || cell === null) ? '' : String(cell);
        if (v.indexOf(',') !== -1 || v.indexOf('"') !== -1 || v.indexOf('\n') !== -1) {
          v = '"' + v.replace(/"/g, '""') + '"';
        }
        return v;
      }).join(',');
    }).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'crm_contatos_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ================= INIT =================
  async function init() {
    bindAuthEvents();
    const { data: { session } } = await sb.auth.getSession();
    if (session) { await afterLogin(session.user); }
    else { showAuthScreen(); }

    sb.auth.onAuthStateChange(function (event, session) {
      if (event === 'SIGNED_IN') afterLogin(session.user);
      if (event === 'SIGNED_OUT') showAuthScreen();
    });
  }

  init();
})();
