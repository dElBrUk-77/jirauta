# Jirauta v3

Proyecto reorganizado en estructura estándar separando frontend, backend y capa de integraciones externas.

## Estructura

```text
.
├── frontend/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── backend/
│   └── server.js
├── apis/
│   ├── jira.js
│   └── llm.js
├── package.json
└── .gitignore
```

## Requisitos

- Node.js 18+

## Ejecutar

```bash
npm install
npm start
```

Abrir en navegador:

```text
http://localhost:3000
```

## Notas

- El frontend ya no llama directamente a Jira/LLMs: ahora usa `/api/chat` en el backend.
- Esto evita problemas de CORS del navegador en proveedores como Anthropic.
- Para producción, se recomienda mover credenciales a variables de entorno y no enviarlas desde el cliente.
