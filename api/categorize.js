import { supabase } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transactions, country, accountType, categories, userName, userId } = req.body;
  if (!transactions || !Array.isArray(transactions) || transactions.length === 0)
    return res.status(400).json({ error: 'transactions array required' });
  if (!categories || !Array.isArray(categories) || categories.length === 0)
    return res.status(400).json({ error: 'categories array required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const CONFIDENCE_THRESHOLD = 0.80;
  const CHUNK_SIZE = 50;
  const MERCHANT_MEMORY_ENABLED = false;

  // ── MERCHANT MEMORY HELPERS ────────────────────────────────────────
  function normalizeMerchant(description) {
    return description?.toLowerCase().trim() || '';
  }

  function getThreshold(timesSeen) {
    if (timesSeen < 3) return null;  // not enough data, always use AI
    if (timesSeen < 10) return 0.90;
    if (timesSeen < 25) return 0.85;
    return 0.80;
  }

  // ── RETRY WRAPPER ──────────────────────────────────────────────────
  async function callWithRetry(payload, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (data.error?.type === 'overloaded_error') {
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
          continue;
        }
        return { error: { message: 'Anthropic API temporarily overloaded — please retry', type: 'overloaded_error' } };
      }
      return data;
    }
  }

  const SYSTEM_PROMPT = `You are a personal finance transaction categorizer. Your ONLY job is to assign each transaction to a category from the provided list and return a confidence score. Output valid JSON only — no markdown, no explanation.`;

  // ── PROMPT BUILDER ─────────────────────────────────────────────────
  function buildPrompt(chunk, chunkIndex, categories, country, accountType, userName) {
    const categoryList = categories.map(c => {
      const examples = c.examples ? ` Examples: ${c.examples}.` : '';
      return `- ${c.id}: ${c.label} — ${c.description}.${examples}`;
    }).join('\n');

    const formatted = chunk.map((t, i) => {
      const parts = [`${chunkIndex + i + 1}. description: "${t.description}"`];
      if (t.type)             parts.push(`type: "${t.type}"`);
      if (t.reference)        parts.push(`reference: "${t.reference}"`);
      if (t.merchantHint)     parts.push(`merchant: "${t.merchantHint}"`);
      if (t.counterpartyName) parts.push(`counterparty: "${t.counterpartyName}"`);
      parts.push(`amount: ${t.amount}`);
      parts.push(`direction: ${t.direction}`);
      return parts.join(', ');
    }).join('\n');

    return `Categorize these transactions from:
<context>
Country: ${country || 'unknown'}
Account type: ${accountType || 'unknown'}
${userName ? `Account holder name: ${userName}` : ''}
</context>

<categories>
${categoryList}

Special categories always available:
- internal_transfer: movement between the user's own accounts or credit card bill payments. Assign this when:
  - The description or reference contains typical credit card payment keywords (PAGO TARJETA, PAGO TDC, etc.)
  - OR the counterpartyName matches or closely resembles the account holder name (${userName || 'provided in context'}) — transfers to/from yourself are internal transfers even if the description is not obvious.
- excluded: transactions the user wants to exclude from analysis (fees, taxes, adjustments, duplicates)
- unassigned: use when you genuinely cannot determine the category even with all context
</categories>

<categorization_strategy>
1. Use ALL available fields together — description + type + reference + merchantHint + counterpartyName + amount + direction
2. Transaction mechanism (the "type" field) is highly informative:
   - Debit card purchase → categorize by what the merchant sells
   - Bank transfer with a purpose note → use the note/reference to determine category
   - Transfer to/from an individual with no clear purpose → reimbursement or unassigned
   - Automatic/system entry → likely income (interest) or internal_transfer (fee)
3. The reference/memo/note field beats the description when they conflict — it is the human-written intent
4. merchantHint contains the actual merchant name when available — prioritize it
5. If the merchant is unfamiliar, search for it to determine what kind of business it is before defaulting to unassigned
6. Confidence scoring:
   - 0.9+: clear well-known merchant, or explicit purpose in reference field
   - 0.8-0.9: strong contextual clues, reasonable inference
   - 0.5-0.8: some signal but meaningful uncertainty
   - below 0.5 → set category to "unassigned" regardless of best guess
</categorization_strategy>

<transactions>
${formatted}
</transactions>

Return a JSON array, one object per transaction in the same order:
[{"index": 1, "category": "groceries", "confidence": 0.95, "reasoning": "max 10 words"}]

Return ONLY the JSON array.`;
  }

  // ── JSON PARSER ────────────────────────────────────────────────────
  function parseJsonArray(raw) {
    let jsonStr = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const firstBracket = jsonStr.indexOf('[');
    if (firstBracket > 0) jsonStr = jsonStr.slice(firstBracket);
    const lastBracket = jsonStr.lastIndexOf(']');
    if (lastBracket !== -1) jsonStr = jsonStr.slice(0, lastBracket + 1);
    return JSON.parse(jsonStr);
  }

  // ── TIER 1: HAIKU ──────────────────────────────────────────────────
  async function runHaiku(txns, startIndex) {
    const prompt = buildPrompt(txns, startIndex, categories, country, accountType, userName);
    const data = await callWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    if (data.error) throw new Error(data.error.message);
    const raw = data.content?.[0]?.text || '[]';
    try {
      return parseJsonArray(raw);
    } catch(e) {
      console.error('Haiku JSON parse failed for chunk, raw:', raw.slice(0, 200));
      throw new Error('JSON parse failed: ' + e.message);
    }
  }

  // ── TIER 2: SONNET + WEB SEARCH ───────────────────────────────────
  async function runSonnetWithSearch(txns, startIndex) {
    const prompt = buildPrompt(txns, startIndex, categories, country, accountType, userName);
    const data = await callWithRetry({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: Math.min(txns.length, 10),
      }],
      messages: [{ role: 'user', content: prompt }],
    });
    if (data.error) throw new Error(data.error.message);

    // Extract only text blocks — response may include tool_use and tool_result blocks
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    const raw = textBlocks.map(b => b.text).join('');
    return parseJsonArray(raw || '[]');
  }

  // ── MAIN WATERFALL ─────────────────────────────────────────────────
  try {
    // ── STEP 1: MERCHANT MEMORY LOOKUP ────────────────────────────────
    const preResolved = {};   // index → result
    let needsAI = transactions.map((txn, i) => ({ originalIndex: i, txn }));

    if (MERCHANT_MEMORY_ENABLED && userId) {
      const uniqueMerchants = [...new Set(
        transactions.map(t => normalizeMerchant(t.description))
      )].filter(Boolean);

      const { data: memoryRows } = await supabase
        .from('merchant_memory')
        .select('merchant_name, ai_category, user_category, times_seen')
        .eq('user_id', userId)
        .in('merchant_name', uniqueMerchants);

      const memoryMap = {};
      (memoryRows || []).forEach(row => {
        memoryMap[row.merchant_name] = row;
      });

      needsAI = [];
      transactions.forEach((t, i) => {
        const key = normalizeMerchant(t.description);
        const memory = memoryMap[key];

        if (memory) {
          // Manual user correction — always trusted immediately
          if (memory.user_category) {
            preResolved[i] = {
              index: i + 1,
              category: memory.user_category,
              finalCategory: memory.user_category,
              confidence: 1.0,
              reasoning: 'user correction from memory',
              tier: 'memory-user',
              autoUnassigned: false,
            };
            return;
          }

          // AI-based memory — apply dynamic threshold based on times_seen
          const threshold = getThreshold(memory.times_seen);
          if (threshold && memory.ai_category) {
            preResolved[i] = {
              index: i + 1,
              category: memory.ai_category,
              finalCategory: memory.ai_category,
              confidence: memory.times_seen >= 10 ? 0.88 : 0.90,
              reasoning: 'ai category from memory',
              tier: 'memory-ai',
              autoUnassigned: false,
            };
            return;
          } else {
            needsAI.push({ originalIndex: i, txn: t });
            return;
          }
        }

        needsAI.push({ originalIndex: i, txn: t });
      });
    }

    // ── STEP 2: AI WATERFALL (only for needsAI transactions) ──────────
    const waterfallResults = new Map(); // originalIndex → result

    if (needsAI.length > 0) {
      // Re-index needsAI transactions for prompting (sequential for the AI)
      const aiTxns = needsAI.map(n => n.txn);
      const chunks = [];
      for (let i = 0; i < aiTxns.length; i += CHUNK_SIZE) {
        chunks.push({ txns: aiTxns.slice(i, i + CHUNK_SIZE), startIndex: i });
      }

      // Tier 1: Haiku
      const haikuResults = [];
      for (const { txns, startIndex } of chunks) {
        let chunkResults;
        try {
          chunkResults = await runHaiku(txns, startIndex);
        } catch(e) {
          console.error(`Haiku chunk failed at ${startIndex}, retrying once:`, e.message);
          await new Promise(r => setTimeout(r, 2000));
          try {
            chunkResults = await runHaiku(txns, startIndex);
          } catch(e2) {
            console.error(`Haiku chunk retry also failed at ${startIndex}:`, e2.message);
            chunkResults = txns.map((_, i) => ({
              index: startIndex + i + 1,
              category: 'unassigned',
              confidence: 0,
              reasoning: 'chunk failed',
            }));
          }
        }
        haikuResults.push(...chunkResults);
      }

      // Force-escalate chunk failures
      haikuResults.forEach(r => {
        if (r.reasoning === 'chunk failed') r.confidence = 0;
      });

      // Identify uncertain transactions for escalation
      const toEscalate = [];
      haikuResults.forEach((r, i) => {
        if (r.confidence < CONFIDENCE_THRESHOLD) {
          toEscalate.push({ localIndex: i, originalIndex: needsAI[i].originalIndex, txn: needsAI[i].txn });
        }
      });

      // Tier 2: Sonnet + Web Search for uncertain ones
      const escalatedMap = new Map(); // localIndex → result
      if (toEscalate.length > 0) {
        const escalateChunks = [];
        for (let i = 0; i < toEscalate.length; i += CHUNK_SIZE) {
          escalateChunks.push(toEscalate.slice(i, i + CHUNK_SIZE));
        }
        for (const chunk of escalateChunks) {
          const txns = chunk.map(e => e.txn);
          const startIndex = chunk[0].localIndex;
          let chunkResults;
          try {
            chunkResults = await runSonnetWithSearch(txns, startIndex);
          } catch(e) {
            console.error('Sonnet escalation failed, using Haiku fallback:', e.message);
            chunkResults = chunk.map(e => haikuResults[e.localIndex]);
          }
          chunkResults.forEach((r, i) => {
            escalatedMap.set(chunk[i].localIndex, r);
          });
        }
      }

      // Merge Haiku + Sonnet results, map back to originalIndex
      haikuResults.forEach((haiku, localIdx) => {
        const originalIndex = needsAI[localIdx].originalIndex;
        const escalated = escalatedMap.get(localIdx);
        const final = escalated || haiku;
        waterfallResults.set(originalIndex, {
          ...final,
          finalCategory: final.confidence >= CONFIDENCE_THRESHOLD ? final.category : 'unassigned',
          autoUnassigned: final.confidence < CONFIDENCE_THRESHOLD && final.category !== 'unassigned',
          tier: escalated ? 'sonnet+search' : (haiku.reasoning === 'chunk failed' ? 'error' : 'haiku'),
        });
      });
    }

    // ── STEP 3: MERGE BACK IN ORIGINAL ORDER ──────────────────────────
    const allResults = transactions.map((_, i) => {
      if (preResolved[i]) return preResolved[i];
      return waterfallResults.get(i) || {
        index: i + 1,
        category: 'unassigned',
        finalCategory: 'unassigned',
        confidence: 0,
        reasoning: 'not found',
        tier: 'haiku',
        autoUnassigned: false,
      };
    });

    const escalatedCount = needsAI.length > 0
      ? [...waterfallResults.values()].filter(r => r.tier === 'sonnet+search').length
      : 0;

    return res.status(200).json({
      results: allResults,
      stats: {
        total: transactions.length,
        fromMemory: Object.keys(preResolved).length,
        haikuOnly: needsAI.length - escalatedCount,
        escalated: escalatedCount,
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
