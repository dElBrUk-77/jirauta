async function listGeminiModels(apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  );
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.error?.message || `Gemini API error (${response.status})`);
  }

  return (data.models || [])
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => (m.name || '').replace('models/', ''))
    .filter(Boolean)
    .sort();
}

async function listClaudeModels(apiKey) {
  const response = await fetch('https://api.anthropic.com/v1/models', {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.error?.message || `Claude API error (${response.status})`);
  }

  return (data.data || []).map((m) => m.id).filter(Boolean);
}

async function listOpenAiModels(apiKey) {
  const response = await fetch('https://api.openai.com/v1/models', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI API error (${response.status})`);
  }

  return (data.data || [])
    .map((m) => m.id)
    .filter((id) => /^gpt-|^o\d|^o\d-mini|^o\d-pro/.test(id))
    .sort();
}

async function listModels({ provider, apiKey }) {
  if (provider === 'gemini') return listGeminiModels(apiKey);
  if (provider === 'claude') return listClaudeModels(apiKey);
  if (provider === 'openai') return listOpenAiModels(apiKey);
  if (provider === 'copilot') {
    throw new Error('La carga automática de modelos para Copilot no está soportada todavía en esta versión.');
  }
  throw new Error('Proveedor LLM no soportado.');
}

function normalizeHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim())
    .slice(-20);
}

async function callGemini({ apiKey, model, systemPrompt, userText, history = [] }) {
  const selectedModel = model || 'gemini-2.0-flash';
  const normalizedHistory = normalizeHistory(history);
  const contents = [
    ...normalizedHistory.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    { role: 'user', parts: [{ text: userText }] },
  ];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Gemini API error (${response.status})`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini devolvió respuesta vacía.');
  }
  return text;
}

async function callClaude({ apiKey, model, systemPrompt, userText, history = [] }) {
  const selectedModel = model || 'claude-3-5-sonnet-20240620';
  const normalizedHistory = normalizeHistory(history);
  const messages = [
    ...normalizedHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: selectedModel,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Claude API error (${response.status})`);
  }

  const text = data?.content?.[0]?.text;
  if (!text) {
    throw new Error('Claude devolvió respuesta vacía.');
  }
  return text;
}

async function callOpenAi({ apiKey, model, systemPrompt, userText, history = [] }) {
  const selectedModel = model || 'gpt-4o-mini';
  const normalizedHistory = normalizeHistory(history);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...normalizedHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: selectedModel,
      messages,
      temperature: 0.3,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI API error (${response.status})`);
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('OpenAI devolvió respuesta vacía.');
  }
  return text;
}

async function callLlm({ provider, apiKey, model, systemPrompt, userText, history = [] }) {
  if (provider === 'claude') {
    return callClaude({ apiKey, model, systemPrompt, userText, history });
  }
  if (provider === 'openai') {
    return callOpenAi({ apiKey, model, systemPrompt, userText, history });
  }
  if (provider === 'copilot') {
    throw new Error('Copilot aún no está soportado para ejecución en esta versión.');
  }
  return callGemini({ apiKey, model, systemPrompt, userText, history });
}

module.exports = {
  listModels,
  callLlm,
};
