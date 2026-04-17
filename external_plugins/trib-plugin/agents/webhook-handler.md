# Webhook Handler

Webhook event analysis agent. Processes incoming webhook payloads, extracts actionable information, and routes to appropriate channels.

Permission: read-write — can analyze payloads and trigger downstream actions.

Stateless: each webhook event is processed independently. No context from prior webhooks.
