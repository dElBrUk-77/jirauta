const state = {
  config: null,
  history: [],
  modelsLoaded: false,
  currentChatId: null,
  chats: [],
};

const $ = (id) => document.getElementById(id);

function addMessage(role, text) {
  const area = $('chat-area');
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  area.appendChild(wrapper);
  area.scrollTop = area.scrollHeight;
}

function clearChatArea() {
  $('chat-area').innerHTML = '';
}

function toHistory(messages = []) {
  return messages
    .filter((m) => m?.role === 'user' || m?.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));
}

function renderChatList() {
  const list = $('chat-list');
  list.innerHTML = '';

  state.chats.forEach((chat) => {
    const btn = document.createElement('button');
    btn.className = `chat-item ${chat.id === state.currentChatId ? 'active' : ''}`;
    btn.textContent = chat.displayTitle || chat.title || 'Chat Jira';
    btn.title = chat.preview || '';
    btn.addEventListener('click', () => openChat(chat.id));
    list.appendChild(btn);
  });
}

async function refreshChats() {
  const response = await fetch('/api/chats');
  const data = await readJsonSafe(response);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || 'No se pudo cargar la lista de chats.');
  }
  state.chats = Array.isArray(data.chats) ? data.chats : [];
  renderChatList();
}

async function createNewChat() {
  const response = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Nuevo chat Jira' }),
  });

  const data = await readJsonSafe(response);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || 'No se pudo crear el chat.');
  }

  state.currentChatId = data.chat?.id || null;
  state.history = [];
  clearChatArea();
  addMessage('assistant', '🆕 Nuevo chat listo. ¿Qué necesitas en Jira?');
  await refreshChats();
}

async function openChat(chatId) {
  const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
  const data = await readJsonSafe(response);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || 'No se pudo abrir el chat.');
  }

  const messages = Array.isArray(data.chat?.messages) ? data.chat.messages : [];
  state.currentChatId = data.chat?.id || chatId;
  state.history = toHistory(messages);

  clearChatArea();
  messages.forEach((m) => {
    if (m?.role === 'user' || m?.role === 'assistant') {
      addMessage(m.role, m.content || '');
    }
  });
  renderChatList();
}

async function initChatPersistence() {
  try {
    await refreshChats();
    if (state.chats.length) {
      await openChat(state.chats[0].id);
    } else {
      await createNewChat();
    }
  } catch (error) {
    addMessage('assistant', `⚠️ No se pudo inicializar el historial de chats: ${error.message}`);
  }
}

function buildConfigFromForm() {
  return {
    domain: $('jira-domain').value.trim(),
    email: $('jira-email').value.trim(),
    token: $('jira-token').value.trim(),
    project: $('jira-project').value.trim().toUpperCase(),
    provider: $('llm-provider').value,
    apiKey: $('llm-api-key').value.trim(),
    model: $('llm-model').value,
  };
}

function validateConfig(config) {
  if (!config.domain || !config.email || !config.token) {
    return 'Debes completar dominio, email y token de Jira.';
  }
  if (!config.provider) {
    return 'Selecciona un proveedor LLM.';
  }
  if (!config.apiKey) {
    return 'Falta API Key del proveedor LLM.';
  }
  if (!config.model) {
    return 'Primero carga y selecciona un modelo.';
  }
  return null;
}

async function loadModels() {
  const provider = $('llm-provider').value;
  const apiKey = $('llm-api-key').value.trim();
  const btn = $('load-models-btn');
  const modelSelect = $('llm-model');

  if (!provider) {
    setConfigFeedback('Selecciona un proveedor LLM.', 'error');
    return;
  }
  if (!apiKey) {
    setConfigFeedback('Introduce la API key del proveedor para listar modelos.', 'error');
    return;
  }

  try {
    btn.disabled = true;
    btn.textContent = 'Cargando modelos...';
    modelSelect.disabled = true;
    modelSelect.innerHTML = '<option value="">Cargando...</option>';
    setConfigFeedback('Consultando modelos disponibles del proveedor...', 'info');

    const response = await fetch('/api/llm/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey }),
    });

    const data = await readJsonSafe(response);
    if (!response.ok || !data?.ok) {
      throw new Error(data?.details || data?.error || 'No se pudieron cargar modelos.');
    }

    const models = Array.isArray(data.models) ? data.models : [];
    if (!models.length) {
      throw new Error('La API respondió, pero no hay modelos disponibles para esta clave/proveedor.');
    }

    modelSelect.innerHTML = models
      .map((m, i) => `<option value="${m}" ${i === 0 ? 'selected' : ''}>${m}</option>`)
      .join('');
    modelSelect.disabled = false;
    state.modelsLoaded = true;
    setConfigFeedback(`✅ Modelos cargados: ${models.length}. Selecciona uno y continúa.`, 'success');
  } catch (error) {
    state.modelsLoaded = false;
    modelSelect.innerHTML = '<option value="">No se pudieron cargar modelos</option>';
    modelSelect.disabled = true;
    setConfigFeedback(`❌ ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Cargar modelos disponibles';
  }
}

function setConfigFeedback(message, type = 'info') {
  const el = $('config-feedback');
  el.textContent = message;
  el.classList.remove('hidden', 'error', 'success');
  if (type === 'error') el.classList.add('error');
  if (type === 'success') el.classList.add('success');
}

async function readJsonSafe(response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch (_e) {
    const snippet = raw.slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(`La API devolvió una respuesta no JSON: ${snippet}`);
  }
}

async function connect() {
  const config = buildConfigFromForm();
  const connectBtn = $('connect-btn');
  const validationError = validateConfig(config);

  if (validationError) {
    setConfigFeedback(validationError, 'error');
    return;
  }

  try {
    connectBtn.disabled = true;
    connectBtn.textContent = 'Validando credenciales...';
    setConfigFeedback('Comprobando conexión con Jira y LLM...', 'info');

    const response = await fetch('/api/validate-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    });

    const data = await readJsonSafe(response);
    if (!response.ok || !data?.ok) {
      throw new Error(data?.details || data?.error || 'No se pudieron validar las credenciales.');
    }
  } catch (error) {
    setConfigFeedback(`❌ ${error.message}`, 'error');
    connectBtn.disabled = false;
    connectBtn.textContent = 'Inicializar Agente →';
    return;
  }

  state.config = config;
  setConfigFeedback('✅ Credenciales verificadas correctamente.', 'success');
  $('active-model').textContent = `Model: ${config.provider.toUpperCase()} / ${config.model}`;

  setTimeout(() => {
    $('config-screen').classList.add('hidden');
    $('app-screen').classList.remove('hidden');
    initChatPersistence();
    connectBtn.disabled = false;
    connectBtn.textContent = 'Inicializar Agente →';
  }, 350);
}

async function sendMessage() {
  const input = $('chat-input');
  const text = input.value.trim();

  if (!text || !state.config) return;

  addMessage('user', text);
  input.value = '';

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: state.config,
        message: text,
        history: state.history,
        chatId: state.currentChatId,
      }),
    });

    const data = await readJsonSafe(response);
    if (!response.ok) {
      throw new Error(data?.details || data?.error || `Error HTTP ${response.status}`);
    }

    if (data?.chatId) {
      state.currentChatId = data.chatId;
    }

    if (data?.project && !state.config.project) {
      state.config.project = data.project;
      addMessage('assistant', `ℹ️ Tomo como Project Key: ${data.project}`);
    }

    const reply = data.reply || '(respuesta vacía)';
    addMessage('assistant', reply);
    state.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    refreshChats().catch(() => {});
  } catch (error) {
    addMessage('assistant', `❌ Error: ${error.message}`);
  }
}

function sendQuick(text) {
  $('chat-input').value = text;
  sendMessage();
}

function wireEvents() {
  $('load-models-btn').addEventListener('click', loadModels);
  $('llm-provider').addEventListener('change', () => {
    state.modelsLoaded = false;
    $('llm-model').innerHTML = '<option value="">Primero carga los modelos...</option>';
    $('llm-model').disabled = true;
  });
  $('connect-btn').addEventListener('click', connect);
  $('send-btn').addEventListener('click', sendMessage);
  document.querySelectorAll('.quick-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => sendQuick(e.currentTarget.dataset.text));
  });
  $('new-chat-btn').addEventListener('click', async () => {
    try {
      await createNewChat();
    } catch (error) {
      addMessage('assistant', `❌ Error creando chat: ${error.message}`);
    }
  });

  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

}

wireEvents();
