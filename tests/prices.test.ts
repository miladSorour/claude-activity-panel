import { expect, test } from 'claude-code/testing'

import { costOf, parsePrices, usePrices } from '../hooks/lib'

const LIST = JSON.stringify({
  'claude-opus-5-5': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 8e-6,
    output_cost_per_token: 4e-5,
    cache_read_input_token_cost: 4e-7,
    cache_creation_input_token_cost: 1e-5,
  },
  'claude-opus-5': { litellm_provider: 'anthropic', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
  'bedrock/claude-opus-5-5': { litellm_provider: 'bedrock', input_cost_per_token: 1, output_cost_per_token: 1 },
  'gpt-x': { litellm_provider: 'openai', input_cost_per_token: 1, output_cost_per_token: 1 },
})

const MILLION_IN = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }

test('fetched prices replace the built-in table, matched by the longest model id', async () => {
  usePrices({})
  expect(costOf('claude-opus-5-5-20261101', MILLION_IN)).toBe(4)

  const prices = parsePrices(LIST)
  expect(Object.keys(prices).sort()).toEqual(['claude-opus-5', 'claude-opus-5-5'])
  expect(prices['claude-opus-5-5']).toEqual({ input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 })
  // A list without cache prices falls back to 0.1x and 1.25x input.
  expect(prices['claude-opus-5']?.cacheWrite).toBe(1.25)

  usePrices(prices)
  expect(costOf('claude-opus-5-5-20261101', MILLION_IN)).toBe(8)
  // A model the list leaves out still costs from the built-in table.
  expect(costOf('claude-haiku-5-5', MILLION_IN)).toBe(0.1)
  usePrices({})
})
