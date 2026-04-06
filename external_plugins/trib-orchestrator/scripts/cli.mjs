#!/usr/bin/env node

import OpenAI from 'openai';

const args = process.argv.slice(2);
const command = args[0];

const PRESETS = {
  ollama: { baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' },
  openai: { baseURL: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY || '' },
  groq: { baseURL: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY || '' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY || '' },
  xai: { baseURL: 'https://api.x.ai/v1', apiKey: process.env.XAI_API_KEY || '' },
  lmstudio: { baseURL: 'http://localhost:1234/v1', apiKey: 'lmstudio' },
};

function line(char = '─', len = 44) { return char.repeat(len); }

if (command === 'ask') {
  const provider = args[1];
  const model = args[2];
  const prompt = args.slice(3).join(' ');

  if (!provider || !model || !prompt) {
    process.stdout.write('Usage: ask <provider> <model> <prompt>\n');
    process.exit(1);
  }

  const preset = PRESETS[provider];
  if (!preset) {
    process.stdout.write(`Unknown provider: ${provider}\n`);
    process.exit(1);
  }

  try {
    const start = Date.now();
    const client = new OpenAI({ baseURL: preset.baseURL, apiKey: preset.apiKey });
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.choices[0]?.message?.content || '';
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const inTok = response.usage?.prompt_tokens ?? '?';
    const outTok = response.usage?.completion_tokens ?? '?';

    process.stdout.write([
      `${line()}`,
      `  ${provider}/${response.model}  (${elapsed}s)`,
      `${line()}`,
      '',
      content,
      '',
      `${line('─', 20)}`,
      `  ${inTok} in / ${outTok} out`,
      '',
    ].join('\n'));
  } catch (err) {
    process.stdout.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

} else if (command === 'models') {
  const provider = args[1] || 'ollama';
  const preset = PRESETS[provider];
  if (!preset) {
    process.stdout.write(`Unknown provider: ${provider}\nAvailable: ${Object.keys(PRESETS).join(', ')}\n`);
    process.exit(1);
  }

  try {
    const client = new OpenAI({ baseURL: preset.baseURL, apiKey: preset.apiKey });
    const list = await client.models.list();
    const models = [];
    for await (const m of list) models.push(m.id);
    process.stdout.write([
      `${line()}`,
      `  ${provider} — ${models.length} models`,
      `${line()}`,
      '',
      ...models.map(m => `  ${m}`),
      '',
    ].join('\n'));
  } catch (err) {
    process.stdout.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

} else {
  process.stdout.write('Commands: ask, models\n');
}
