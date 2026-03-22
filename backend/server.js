const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const {
  validateJiraConnection,
  getRecentIssues,
  searchProjectIssues,
  getProjectStatuses,
  promoteIssueToNextStatus,
  updateIssueFields,
  deleteIssue,
  createJiraIssue,
} = require('../apis/jira');
const { listModels, callLlm } = require('../apis/llm');

const app = express();
const PORT = process.env.PORT || 3000;
const pendingBatches = new Map();
const CHAT_STORE_DIR = path.join(__dirname, '..', 'chat_store');

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/frontend', express.static(path.join(__dirname, '..', 'frontend')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'jirauta-api' });
});

function buildLlmConfig(config) {
  const provider = String(config.provider || config.llm || 'gemini').trim().toLowerCase();
  const model = String(config.model || '').trim();

  const apiKey = String(
    config.apiKey ||
      (provider === 'gemini' ? config.geminiKey : '') ||
      (provider === 'claude' ? config.claudeKey : '') ||
      (provider === 'openai' ? config.openaiKey : '') ||
      ''
  ).trim();

  return { provider, apiKey, model };
}

function extractProjectKeyFromText(text) {
  const input = String(text || '');

  const labeled = input.match(/(?:project\s*key|clave\s*de\s*proyecto)\s*(?:es|=|:)?\s*([A-Z][A-Z0-9]{1,9})/i);
  if (labeled?.[1]) return labeled[1].toUpperCase();

  const issueLike = input.match(/\b([A-Z][A-Z0-9]{1,9})-\d+\b/);
  if (issueLike?.[1]) return issueLike[1].toUpperCase();

  const shortAllCaps = input.trim().match(/^([A-Z][A-Z0-9]{1,9})$/);
  if (shortAllCaps?.[1]) return shortAllCaps[1].toUpperCase();

  return '';
}

function resolveProjectKey({ currentProject, message, history }) {
  if (currentProject) return currentProject;

  const fromCurrent = extractProjectKeyFromText(message);
  if (fromCurrent) return fromCurrent;

  const reversedHistory = [...(Array.isArray(history) ? history : [])].reverse();
  for (const item of reversedHistory) {
    if (item?.role !== 'user') continue;
    const found = extractProjectKeyFromText(item?.content);
    if (found) return found;
  }

  return '';
}

function batchOwnerKey(jiraConfig) {
  return `${jiraConfig.domain}|${jiraConfig.email}|${jiraConfig.project || '-'}`;
}

function generateBatchToken() {
  return `LOT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function parseUpdatesString(raw = '') {
  const updates = {};
  String(raw)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx <= 0) return;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) updates[k] = v;
    });
  return updates;
}

function parseBulkCreate(reply = '') {
  const match = reply.match(/\[BULK_CREATE:\s*([\s\S]*?)\]/);
  if (!match) return [];
  return match[1]
    .split(';;')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((row) => {
      const [summary, description] = row.split('|').map((p) => (p || '').trim());
      return { summary, description };
    })
    .filter((i) => i.summary && i.description);
}

function parseBulkUpdate(reply = '') {
  const match = reply.match(/\[BULK_UPDATE:\s*([\s\S]*?)\]/);
  if (!match) return [];
  return match[1]
    .split(';;')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((row) => {
      const [issueKey, updatesRaw] = row.split('|').map((p) => (p || '').trim());
      return {
        issueKey: String(issueKey || '').toUpperCase(),
        updates: parseUpdatesString(updatesRaw),
      };
    })
    .filter((i) => i.issueKey && Object.keys(i.updates).length > 0);
}

async function ensureChatStoreDir() {
  await fs.promises.mkdir(CHAT_STORE_DIR, { recursive: true });
}

function sanitizeChatId(chatId) {
  return String(chatId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '');
}

function chatFilePath(chatId) {
  return path.join(CHAT_STORE_DIR, `${sanitizeChatId(chatId)}.json`);
}

function newChatId() {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeChatMessage(role, content) {
  return {
    role,
    content: String(content || ''),
    timestamp: new Date().toISOString(),
  };
}

function buildChatSummary(messages = []) {
  const candidate = messages.find((m) => m?.role === 'user' && m?.content) || messages.find((m) => m?.content);
  if (!candidate) return 'Sin resumen';
  return String(candidate.content).replace(/\s+/g, ' ').trim().slice(0, 72);
}

function formatChatDateLabel(isoDate) {
  const date = isoDate ? new Date(isoDate) : new Date();
  return date.toLocaleString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function readChat(chatId) {
  const file = chatFilePath(chatId);
  const raw = await fs.promises.readFile(file, 'utf-8');
  const chat = JSON.parse(raw);
  chat.messages = Array.isArray(chat.messages) ? chat.messages : [];
  return chat;
}

async function writeChat(chat) {
  await ensureChatStoreDir();
  const now = new Date().toISOString();
  const createdAt = chat.createdAt || now;
  const summary = buildChatSummary(chat.messages || []);
  const normalized = {
    id: sanitizeChatId(chat.id),
    title: summary,
    createdAt,
    updatedAt: now,
    messages: Array.isArray(chat.messages) ? chat.messages : [],
  };
  await fs.promises.writeFile(chatFilePath(normalized.id), JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}

async function createChat(title = 'Chat Jira') {
  const id = newChatId();
  return writeChat({ id, title, messages: [] });
}

async function appendMessagesToChat(chatId, messages = []) {
  let chat;
  try {
    chat = await readChat(chatId);
  } catch (_e) {
    chat = await createChat('Chat Jira');
    if (chat.id !== chatId) {
      chat.id = sanitizeChatId(chatId);
      await writeChat(chat);
    }
  }

  chat.messages.push(...messages);
  if ((!chat.title || chat.title === 'Chat Jira') && messages.length) {
    chat.title = buildChatSummary(chat.messages);
  }
  return writeChat(chat);
}

async function listChats() {
  await ensureChatStoreDir();
  const files = await fs.promises.readdir(CHAT_STORE_DIR);
  const chats = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.promises.readFile(path.join(CHAT_STORE_DIR, file), 'utf-8');
      const chat = JSON.parse(raw);
      const messages = Array.isArray(chat.messages) ? chat.messages : [];
      chats.push({
        id: chat.id,
        title: chat.title || 'Sin resumen',
        displayTitle: `${formatChatDateLabel(chat.createdAt)} · ${chat.title || 'Sin resumen'}`,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        messageCount: messages.length,
        preview: messages[messages.length - 1]?.content?.slice(0, 80) || '',
      });
    } catch (_e) {
      // Ignore corrupted files in listing
    }
  }

  return chats.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

async function persistConversationTurn({ chatId, userMessage, assistantMessage }) {
  const safeChatId = sanitizeChatId(chatId);
  let chat = null;

  if (safeChatId) {
    try {
      chat = await readChat(safeChatId);
    } catch (_e) {
      chat = null;
    }
  }

  if (!chat) {
    chat = await createChat('Chat Jira');
  }

  const messages = [];
  if (userMessage) messages.push(normalizeChatMessage('user', userMessage));
  if (assistantMessage) messages.push(normalizeChatMessage('assistant', assistantMessage));

  await appendMessagesToChat(chat.id, messages);
  return chat.id;
}

app.get('/api/chats', async (_req, res) => {
  try {
    const chats = await listChats();
    return res.json({ ok: true, chats });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/chats', async (req, res) => {
  try {
    const title = String(req.body?.title || 'Chat Jira').trim() || 'Chat Jira';
    const chat = await createChat(title);
    return res.json({ ok: true, chat });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/chats/:chatId', async (req, res) => {
  try {
    const chatId = sanitizeChatId(req.params.chatId);
    if (!chatId) return res.status(400).json({ ok: false, error: 'chatId inválido' });
    const chat = await readChat(chatId);
    return res.json({ ok: true, chat });
  } catch (_error) {
    return res.status(404).json({ ok: false, error: 'Chat no encontrado' });
  }
});

app.post('/api/llm/models', async (req, res) => {
  try {
    const { provider, apiKey } = req.body || {};
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const normalizedApiKey = String(apiKey || '').trim();

    if (!normalizedProvider) {
      return res.status(400).json({ ok: false, error: 'El proveedor es obligatorio.' });
    }
    if (!normalizedApiKey) {
      return res.status(400).json({ ok: false, error: 'La API key es obligatoria.' });
    }

    const models = await listModels({ provider: normalizedProvider, apiKey: normalizedApiKey });
    return res.json({ ok: true, models });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: 'No se pudieron cargar los modelos del proveedor.',
      details: error.message,
    });
  }
});

app.post('/api/validate-config', async (req, res) => {
  try {
    const { config } = req.body || {};

    if (!config || typeof config !== 'object') {
      return res.status(400).json({ ok: false, error: 'Falta configuración.' });
    }

    const jiraConfig = {
      domain: String(config.domain || '').trim(),
      email: String(config.email || '').trim(),
      token: String(config.token || '').trim(),
      project: String(config.project || '').trim().toUpperCase(),
    };

    const llmConfig = buildLlmConfig(config);

    if (!jiraConfig.domain || !jiraConfig.email || !jiraConfig.token) {
      return res.status(400).json({ ok: false, error: 'Faltan credenciales de Jira.' });
    }

    if (!llmConfig.apiKey) {
      return res.status(400).json({ ok: false, error: 'Falta API key del proveedor LLM.' });
    }
    if (!llmConfig.model) {
      return res.status(400).json({ ok: false, error: 'Selecciona un modelo LLM.' });
    }

    await validateJiraConnection(jiraConfig);

    if (jiraConfig.project) {
      await getRecentIssues(jiraConfig, 1);
    }

    await callLlm({
      ...llmConfig,
      systemPrompt: 'Responde de forma breve y solo con la palabra OK.',
      userText: 'Ping de validación de credenciales',
      history: [],
    });

    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: 'La validación de credenciales falló.',
      details: error.message,
    });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { config, message, history = [], chatId } = req.body || {};

    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'Falta configuración.' });
    }
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'El mensaje es obligatorio.' });
    }

    const jiraConfig = {
      domain: String(config.domain || '').trim(),
      email: String(config.email || '').trim(),
      token: String(config.token || '').trim(),
      project: String(config.project || '').trim().toUpperCase(),
    };

    jiraConfig.project = resolveProjectKey({
      currentProject: jiraConfig.project,
      message,
      history,
    });

    const llmConfig = buildLlmConfig(config);

    if (!jiraConfig.domain || !jiraConfig.email || !jiraConfig.token) {
      return res.status(400).json({ error: 'Faltan credenciales de Jira.' });
    }

    if (!llmConfig.apiKey) {
      return res.status(400).json({ error: 'Falta API key del proveedor LLM.' });
    }
    if (!llmConfig.model) {
      return res.status(400).json({ error: 'Falta modelo LLM seleccionado.' });
    }

    const confirmBatchMatch = String(message || '').match(/CONFIRMAR\s+LOTE\s+([A-Z0-9-]+)/i);
    if (confirmBatchMatch) {
      const token = confirmBatchMatch[1].toUpperCase();
      const pending = pendingBatches.get(token);
      if (!pending) {
        const reply = `⚠️ No encontré ningún lote pendiente con token ${token}.`;
        const finalChatId = await persistConversationTurn({
          chatId,
          userMessage: message,
          assistantMessage: reply,
        });
        return res.json({
          reply,
          chatId: finalChatId,
          ticket: null,
          readResults: null,
          statuses: null,
          promoted: null,
          updated: null,
          deleted: null,
          project: jiraConfig.project || null,
        });
      }

      if (pending.owner !== batchOwnerKey(jiraConfig)) {
        const reply = `⚠️ El lote ${token} no corresponde al contexto actual (dominio/usuario/proyecto).`;
        const finalChatId = await persistConversationTurn({
          chatId,
          userMessage: message,
          assistantMessage: reply,
        });
        return res.json({
          reply,
          chatId: finalChatId,
          ticket: null,
          readResults: null,
          statuses: null,
          promoted: null,
          updated: null,
          deleted: null,
          project: jiraConfig.project || null,
        });
      }

      const created = [];
      const updatedItems = [];
      const errors = [];

      for (const item of pending.creates) {
        try {
          const t = await createJiraIssue(jiraConfig, {
            summary: item.summary,
            description: item.description,
          });
          created.push(t.key);
        } catch (e) {
          errors.push(`CREATE ${item.summary.slice(0, 40)}: ${e.message}`);
        }
      }

      for (const item of pending.updates) {
        try {
          await updateIssueFields(jiraConfig, item.issueKey, item.updates);
          updatedItems.push(item.issueKey);
        } catch (e) {
          errors.push(`UPDATE ${item.issueKey}: ${e.message}`);
        }
      }

      pendingBatches.delete(token);

      const reply =
        `✅ Lote ${token} ejecutado.\n` +
        `- Creados: ${created.length}\n` +
        `- Actualizados: ${updatedItems.length}\n` +
        `- Errores: ${errors.length}` +
        (errors.length ? `\n\nDetalles:\n- ${errors.join('\n- ')}` : '');
      const finalChatId = await persistConversationTurn({
        chatId,
        userMessage: message,
        assistantMessage: reply,
      });

      return res.json({
        reply,
        chatId: finalChatId,
        ticket: null,
        readResults: null,
        statuses: null,
        promoted: null,
        updated: null,
        deleted: null,
        project: jiraConfig.project || null,
      });
    }

    const recent = await getRecentIssues(jiraConfig, 5);
    const contextStr = JSON.stringify(
      recent.map((i) => ({
        key: i.key,
        summary: i.summary,
        description: i.description || '',
        status: i.status || '',
        assignee: i.assignee || '',
        issueType: i.issueType || '',
        priority: i.priority || '',
        reporter: i.reporter || '',
        labels: i.labels || [],
        components: i.components || [],
        created: i.created || null,
        updated: i.updated || null,
        fullRawIssue: i.raw || null,
      }))
    );

    const projectGuidance = jiraConfig.project
      ? `Project Key activo: ${jiraConfig.project}. Usa SIEMPRE consultas JQL acotadas al proyecto y rango temporal reciente.`
      : 'No hay Project Key configurado. Antes de buscar o crear tickets, pide al usuario de forma natural el Project Key (por ejemplo: SCRUM).';

    const systemPrompt = `Eres Jirauta, un asistente técnico experto en Jira.
Contexto actual de tickets: ${contextStr}.
${projectGuidance}
Si el usuario pide LEER / LISTAR / CONSULTAR tickets, añade al final EXACTAMENTE:
[READ_TICKETS: texto_busqueda | maxResultados]
Si el usuario pide ver estados del workflow del proyecto, añade al final EXACTAMENTE:
[LIST_STATUSES]
Si el usuario pide mover/promocionar una tarjeta al siguiente estado natural, añade al final EXACTAMENTE:
[PROMOTE_TICKET: ISSUE-KEY]
Si el usuario pide actualizar etiquetas/labels de una tarjeta, añade al final EXACTAMENTE:
[UPDATE_LABELS: ISSUE-KEY | label1,label2,label3]
Si el usuario pide actualizar campos de una tarjeta (excepto título/summary y descripción), añade al final EXACTAMENTE:
[UPDATE_FIELDS: ISSUE-KEY | campo1=valor1;campo2=valor2]
Campos permitidos: labels, priority, assignee, reporter, duedate, environment, components, fixversions, parent, storypoints, epiclink, sprint
Si el usuario pide operaciones MASIVAS de creación/actualización, NO ejecutes una a una directamente:
- genera un plan con marcador [BULK_CREATE: titulo1|descripcion1;;titulo2|descripcion2]
- y/o [BULK_UPDATE: ISSUE-1|campo=valor;campo2=valor2;;ISSUE-2|campo=valor]
- el usuario debe confirmar después con: CONFIRMAR LOTE <TOKEN>
Si el usuario pide eliminar una tarjeta:
- primero pide confirmación explícita al usuario (no borres aún),
- solo cuando el usuario confirme claramente, añade EXACTAMENTE:
[DELETE_TICKET: ISSUE-KEY | CONFIRM]
Si el usuario pide crear un ticket, responde de forma natural y añade al final EXACTAMENTE:
[CREATE_TICKET: Titulo | Descripcion]`;

    let reply = await callLlm({
      ...llmConfig,
      systemPrompt,
      userText: message,
      history,
    });

    let ticket = null;
    let readResults = null;
    let statuses = null;
    let promoted = null;
    let updated = null;
    let deleted = null;

    const bulkCreates = parseBulkCreate(reply);
    const bulkUpdates = parseBulkUpdate(reply);

    if (bulkCreates.length || bulkUpdates.length) {
      const token = generateBatchToken();
      pendingBatches.set(token, {
        owner: batchOwnerKey(jiraConfig),
        creates: bulkCreates,
        updates: bulkUpdates,
        createdAt: Date.now(),
      });

      reply +=
        `\n\n🧾 Resumen del lote propuesto (sin ejecutar):\n` +
        `- Crear: ${bulkCreates.length} tarjetas\n` +
        `- Actualizar: ${bulkUpdates.length} tarjetas\n` +
        `\nPara ejecutar el lote, confirma en el chat con: **CONFIRMAR LOTE ${token}**`;

      const finalChatId = await persistConversationTurn({
        chatId,
        userMessage: message,
        assistantMessage: reply,
      });

      return res.json({
        reply,
        chatId: finalChatId,
        ticket,
        readResults,
        statuses,
        promoted,
        updated,
        deleted,
        project: jiraConfig.project || null,
      });
    }

    if (reply.includes('[LIST_STATUSES]')) {
      if (!jiraConfig.project) {
        reply += '\n\n⚠️ No puedo listar estados porque falta Project Key.';
      } else {
        statuses = await getProjectStatuses(jiraConfig);
        if (!statuses.length) {
          reply += '\n\n📭 No encontré estados para el proyecto.';
        } else {
          const statusLines = statuses.map((s) => `- ${s.name} (${s.category})`).join('\n');
          reply += `\n\n🧭 Estados del proyecto:\n${statusLines}`;
        }
      }
    }

    const promoteRegex = /\[PROMOTE_TICKET:\s*([A-Z][A-Z0-9]{1,9}-\d+)\s*\]/;
    const promoteMatch = reply.match(promoteRegex);
    if (promoteMatch) {
      const issueKey = promoteMatch[1].toUpperCase();
      promoted = await promoteIssueToNextStatus(jiraConfig, issueKey);
      reply += `\n\n🚀 ${issueKey} pasó de **${promoted.fromStatus}** a **${promoted.toStatus}**.`;
    }

    const updateLabelsRegex = /\[UPDATE_LABELS:\s*([A-Z][A-Z0-9]{1,9}-\d+)\s*\|\s*([^\]]*?)\s*\]/;
    const updateLabelsMatch = reply.match(updateLabelsRegex);
    if (updateLabelsMatch) {
      const issueKey = updateLabelsMatch[1].toUpperCase();
      const labelsCsv = updateLabelsMatch[2].trim();
      updated = await updateIssueFields(jiraConfig, issueKey, {
        labels: labelsCsv,
      });
      reply += `\n\n🏷️ Labels actualizadas en ${issueKey}: ${(updated?.updates?.labels || []).join(', ') || '(vacías)'}`;
    }

    const updateFieldsRegex = /\[UPDATE_FIELDS:\s*([A-Z][A-Z0-9]{1,9}-\d+)\s*\|\s*([^\]]*?)\s*\]/;
    const updateFieldsMatch = reply.match(updateFieldsRegex);
    if (updateFieldsMatch) {
      const issueKey = updateFieldsMatch[1].toUpperCase();
      const rawPairs = updateFieldsMatch[2].trim();

      const updates = {};
      rawPairs
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((pair) => {
          const idx = pair.indexOf('=');
          if (idx <= 0) return;
          const k = pair.slice(0, idx).trim();
          const v = pair.slice(idx + 1).trim();
          if (k) updates[k] = v;
        });

      if (!Object.keys(updates).length) {
        reply += '\n\n⚠️ No se pudo actualizar: formato inválido de campos.';
      } else {
        updated = await updateIssueFields(jiraConfig, issueKey, updates);
        reply += `\n\n🛠️ Campos actualizados en ${issueKey}: ${(updated?.updatedFields || []).join(', ')}`;
      }
    }

    const deleteRegex = /\[DELETE_TICKET:\s*([A-Z][A-Z0-9]{1,9}-\d+)\s*\|\s*(.*?)\s*\]/;
    const deleteMatch = reply.match(deleteRegex);
    if (deleteMatch) {
      const issueKey = deleteMatch[1].toUpperCase();
      const confirmFlag = deleteMatch[2].trim().toUpperCase();

      if (confirmFlag !== 'CONFIRM') {
        reply += `\n\n⚠️ No se eliminó ${issueKey}. Falta confirmación explícita.`;
      } else {
        deleted = await deleteIssue(jiraConfig, issueKey);
        reply += `\n\n🗑️ Ticket eliminado: ${issueKey}`;
      }
    }

    const readMarkerRegex = /\[READ_TICKETS:\s*(.*?)\s*\|\s*(\d+)\s*\]/;
    const readMatch = reply.match(readMarkerRegex);
    if (readMatch) {
      const searchText = readMatch[1].trim();
      const maxResults = Number(readMatch[2]) || 10;

      if (!jiraConfig.project) {
        reply += '\n\n⚠️ No puedo leer tickets porque falta Project Key.';
      } else {
        readResults = await searchProjectIssues(jiraConfig, {
          text: searchText,
          maxResults,
        });

        if (!readResults.length) {
          reply += '\n\n📭 No encontré tickets con esos criterios en el proyecto.';
        } else {
          const lines = readResults
            .map(
              (i) =>
                `- ${i.key} | ${i.issueType} | ${i.status} | ${i.assignee} | Prioridad: ${
                  i.priority || 'N/A'
                }\n  Título: ${i.summary}\n  Descripción: ${
                  i.description || '(sin descripción)'
                }\n  Reporter: ${i.reporter || 'N/A'} | Labels: ${(i.labels || []).join(', ') || 'N/A'} | Components: ${(i.components || []).join(', ') || 'N/A'}`
            )
            .join('\n');
          reply += `\n\n📚 Tickets encontrados:\n${lines}`;
        }
      }
    }

    const markerRegex = /\[CREATE_TICKET:\s*(.+?)\s*\|\s*([\s\S]*?)\]/;
    const match = reply.match(markerRegex);

    if (match) {
      const summary = match[1].trim();
      const description = match[2].trim();

      if (!jiraConfig.project) {
        reply += '\n\n⚠️ No se creó ticket porque falta Project Key.';
      } else {
        ticket = await createJiraIssue(jiraConfig, { summary, description });
        reply += `\n\n✅ Ticket creado: ${ticket.key}`;
      }
    }

    const finalChatId = await persistConversationTurn({
      chatId,
      userMessage: message,
      assistantMessage: reply,
    });

    return res.json({
      reply,
      chatId: finalChatId,
      ticket,
      readResults,
      statuses,
      promoted,
      updated,
      deleted,
      project: jiraConfig.project || null,
    });
  } catch (error) {
    let finalChatId = sanitizeChatId(req.body?.chatId || '');
    try {
      finalChatId = await persistConversationTurn({
        chatId: finalChatId,
        userMessage: req.body?.message,
        assistantMessage: `❌ ${error.message}`,
      });
    } catch (_e) {
      // ignore persistence errors in error path
    }
    return res.status(500).json({
      error: 'Error procesando la solicitud.',
      details: error.message,
      chatId: finalChatId || null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Jirauta escuchando en http://localhost:${PORT}`);
});
