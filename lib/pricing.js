'use strict';
// USD per 1M tokens: [input, output, cacheRead, cacheWrite]. These are ESTIMATES used only when a
// source doesn't report its own cost. Override any entry in Settings -> pricing (settings.json).
const TABLE = [
  // Anthropic
  [/opus-4-?[5-9]|opus-5|fable/i,   [5, 25, 0.5, 6.25]],
  [/opus/i,                         [15, 75, 1.5, 18.75]],
  [/sonnet/i,                       [3, 15, 0.3, 3.75]],
  [/haiku-4|haiku-5/i,              [1, 5, 0.1, 1.25]],
  [/haiku/i,                        [0.8, 4, 0.08, 1]],
  // OpenAI
  [/gpt-5.*mini|codex-mini/i,       [0.25, 2, 0.025, 0]],
  [/gpt-5.*nano/i,                  [0.05, 0.4, 0.005, 0]],
  [/gpt-5\.[2-9]|gpt-5-?codex-max/i,[1.75, 14, 0.175, 0]],
  [/gpt-5|codex/i,                  [1.25, 10, 0.125, 0]],
  [/gpt-4\.1/i,                     [2, 8, 0.5, 0]],
  [/gpt-4o-mini/i,                  [0.15, 0.6, 0.075, 0]],
  [/gpt-4o/i,                       [2.5, 10, 1.25, 0]],
  [/o3|o4/i,                        [2, 8, 0.5, 0]],
  // Google
  [/gemini.*flash/i,                [0.3, 2.5, 0.075, 0]],
  [/gemini.*(3|pro)/i,              [2, 12, 0.2, 0]],
  [/gemini/i,                       [1.25, 10, 0.31, 0]],
  // xAI
  [/grok.*(fast|mini)/i,            [0.2, 0.5, 0.05, 0]],
  [/grok/i,                         [3, 15, 0.75, 0]],
  // Misc
  [/deepseek/i,                     [0.28, 0.42, 0.028, 0]],
  [/kimi|moonshot/i,                [0.6, 2.5, 0.15, 0]],
  [/glm/i,                          [0.6, 2.2, 0.11, 0]],
];

function priceFor(model, overrides) {
  const m = String(model || '');
  if (overrides) for (const k of Object.keys(overrides)) if (m.toLowerCase().includes(k.toLowerCase())) return overrides[k];
  if (/ollama|local|:latest|lmstudio|llama\.cpp/i.test(m)) return [0, 0, 0, 0];
  for (const [re, p] of TABLE) if (re.test(m)) return p;
  return null;
}

function estimateCost(e, overrides) {
  const p = priceFor(e.model, overrides);
  if (!p) return 0;
  return (e.input * p[0] + e.output * p[1] + e.cacheRead * p[2] + e.cacheWrite * p[3]) / 1e6;
}

module.exports = { priceFor, estimateCost };
