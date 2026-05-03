// ── advisor.js ────────────────────────────────────────────────────────
// Handles 3 actions routed from vercel.json:
//   POST /api/analyze        → action: 'analyze'   (full analysis pipeline)
//   POST /api/analyze-answers → action: 'answers'  (recommendations after Q&A)
//   POST /api/chat           → action: 'chat'       (multi-turn chat turn)
// ─────────────────────────────────────────────────────────────────────

import { supabase, supabaseAnon } from './lib/supabase.js';
import {
  computeSummary,
  buildAnalysisPrompt,
  buildCritiquePrompt,
  buildRecommendationPrompt,
  buildFirstMessage,
  buildPriorSessionsContext,
  getUserLocation,
  ANALYSIS_SYSTEM_PROMPT,
  CRITIQUE_SYSTEM_PROMPT,
  RECOMMENDATION_SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
} from './lib/advisor-prompts.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

function parseJSON(raw) {
  let s = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

async function callClaude(apiKey, { model, system, messages, max_tokens, temperature, tools, extraHeaders }) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    ...(extraHeaders || {}),
  };
  const body = { model, max_tokens, temperature, messages };
  if (system) body.system = system;
  if (tools) body.tools = tools;

  const res = await fetch(ANTHROPIC_API, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data;
}

async function validateSession(accessToken) {
  const { data, error } = await supabaseAnon.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error('Invalid session');
  return data.user.id;
}

// ── CACHE HELPERS ──────────────────────────────────────────────────────
async function getCachedAnalysis(userId) {
  const { data } = await supabase
    .from('ai_analyses')
    .select('*')
    .eq('user_id', userId)
    .eq('is_latest', true)
    .single();
  return data;
}

function isCacheValid(cached, currentStatementIds) {
  if (!cached) return false;
  const age = Date.now() - new Date(cached.created_at).getTime();
  if (age > 7 * 24 * 60 * 60 * 1000) return false;
  const cachedIds = [...(cached.statement_ids || [])].sort();
  return JSON.stringify(cachedIds) === JSON.stringify(currentStatementIds);
}

async function loadPriorSessions(userId, limit = 3) {
  const { data } = await supabase
    .from('ai_sessions')
    .select('summary, created_at, turn_count')
    .eq('user_id', userId)
    .not('summary', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}

// ── ACTION: analyze ────────────────────────────────────────────────────
async function handleAnalyze(req, res) {
  const { session } = req.body || {};
  if (!session?.access_token) return res.status(401).json({ error: 'No session' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const user_id = await validateSession(session.access_token);

  // Load profile + transactions + statements in parallel
  const [
    { data: profile, error: profileErr },
    { data: transactions, error: txnErr },
    { data: stmtRows },
  ] = await Promise.all([
    supabase.from('profiles')
      .select('country, currency, locale, financial_situation, primary_goal, savings_habit, debt_situation, rich_life_categories, ordinary_categories')
      .eq('id', user_id).single(),
    supabase.from('transactions')
      .select('date, description, amount, direction, final_category, type, calendar_month')
      .eq('user_id', user_id).order('date', { ascending: true }),
    supabase.from('statements')
      .select('id, period_start, period_end')
      .eq('user_id', user_id).order('period_start', { ascending: true }),
  ]);

  if (profileErr || !profile) return res.status(404).json({ error: 'Profile not found' });
  if (txnErr) return res.status(500).json({ error: 'Failed to load transactions' });
  if (!transactions || transactions.length === 0) {
    return res.status(400).json({ error: 'No transactions found. Upload a bank statement first.' });
  }

  // Build profileData
  const summary = computeSummary(transactions);
  const months_of_history = new Set(transactions.map(t => t.calendar_month).filter(Boolean)).size;
  const profileData = {
    survey: {
      richLifeCategories: profile.rich_life_categories || [],
      ordinaryCategories: profile.ordinary_categories || [],
      situation: profile.financial_situation || 'unknown',
      goal: profile.primary_goal || 'unknown',
      savings: profile.savings_habit || 'unknown',
      debt: profile.debt_situation || 'unknown',
    },
    summary,
    transactions: transactions.slice(0, 500),
    profile_meta: {
      country: profile.country || 'Mexico',
      currency: profile.currency || 'MXN',
      months_of_history,
    },
  };
  const trimmedProfileData = { ...profileData, transactions: transactions.slice(-100) };

  // Cache check
  const currentStatementIds = (stmtRows || []).map(s => s.id).sort();
  const cachedRow = await getCachedAnalysis(user_id);
  if (isCacheValid(cachedRow, currentStatementIds)) {
    return res.status(200).json({
      analysis: cachedRow.analysis,
      critique: cachedRow.critique,
      recommendations: cachedRow.recommendations,
      profileData: trimmedProfileData,
      questions: [],
      awaiting_answers: false,
      cached: true,
      analysis_id: cachedRow.id,
    });
  }

  // Step 1: Analysis — claude-sonnet-4-6
  const analysisData = await callClaude(apiKey, {
    model: 'claude-sonnet-4-6',
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildAnalysisPrompt(profileData) }],
    max_tokens: 8000,
    temperature: 0.1,
  });
  const analysis = parseJSON(analysisData.content?.[0]?.text || '{}');

  // Step 2: Critique — claude-haiku-4-5-20251001
  const critiqueData = await callClaude(apiKey, {
    model: 'claude-haiku-4-5-20251001',
    system: CRITIQUE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildCritiquePrompt(profileData, analysis) }],
    max_tokens: 8000,
    temperature: 0.0,
  });
  const critique = parseJSON(critiqueData.content?.[0]?.text || '{}');

  // Collect clarifying questions (max 3)
  const questions = [];
  for (const p of (critique.problems || [])) {
    for (const q of (p.clarifying_questions || [])) {
      if (questions.length < 3) questions.push(q);
    }
  }

  if (questions.length > 0) {
    return res.status(200).json({ analysis, critique, profileData: trimmedProfileData, questions, recommendations: null, awaiting_answers: true, cached: false });
  }

  // Step 3: Recommendations — claude-sonnet-4-6
  const recData = await callClaude(apiKey, {
    model: 'claude-sonnet-4-6',
    system: RECOMMENDATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildRecommendationPrompt(profileData, analysis, critique, {}) }],
    max_tokens: 1500,
    temperature: 0.3,
  });
  const recommendations = recData.content?.[0]?.text || '';

  // Save to cache
  const earliestPeriodStart = stmtRows?.[0]?.period_start || '';
  const latestPeriodEnd = stmtRows?.[stmtRows.length - 1]?.period_end || '';
  await supabase.from('ai_analyses').update({ is_latest: false }).eq('user_id', user_id);
  const { data: savedRow } = await supabase.from('ai_analyses').insert({
    user_id,
    is_latest: true,
    statement_ids: currentStatementIds,
    months_covered: `${earliestPeriodStart} to ${latestPeriodEnd}`,
    analysis,
    critique,
    recommendations,
    in_deficit: analysis.in_deficit ?? null,
    deficit_amount: analysis.deficit_amount ?? null,
    overall_confidence: critique.overall_confidence ?? null,
    data_quality: analysis.data_quality ?? null,
  }).select('id').single();

  return res.status(200).json({ analysis, critique, profileData: trimmedProfileData, questions: [], recommendations, awaiting_answers: false, cached: false, analysis_id: savedRow?.id || null });
}

// ── ACTION: answers ────────────────────────────────────────────────────
async function handleAnswers(req, res) {
  const { session, profileData, analysis, critique, answers } = req.body || {};
  if (!session?.access_token) return res.status(401).json({ error: 'No session' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const user_id = await validateSession(session.access_token);

  const recData = await callClaude(apiKey, {
    model: 'claude-sonnet-4-6',
    system: RECOMMENDATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildRecommendationPrompt(profileData, analysis, critique, answers || {}) }],
    max_tokens: 1500,
    temperature: 0.3,
  });
  const recommendations = recData.content?.[0]?.text || '';

  // Save to ai_analyses (this path is taken when clarifying questions were asked)
  const { data: stmtRows } = await supabase
    .from('statements')
    .select('id, period_start, period_end')
    .eq('user_id', user_id)
    .order('period_start', { ascending: true });
  const currentStatementIds = (stmtRows || []).map(s => s.id).sort();
  const earliestPeriodStart = stmtRows?.[0]?.period_start || '';
  const latestPeriodEnd = stmtRows?.[stmtRows?.length - 1]?.period_end || '';

  await supabase.from('ai_analyses').update({ is_latest: false }).eq('user_id', user_id);
  const { data: savedRow } = await supabase.from('ai_analyses').insert({
    user_id,
    is_latest: true,
    statement_ids: currentStatementIds,
    months_covered: `${earliestPeriodStart} to ${latestPeriodEnd}`,
    analysis,
    critique,
    recommendations,
    in_deficit: analysis.in_deficit ?? null,
    deficit_amount: analysis.deficit_amount ?? null,
    overall_confidence: critique.overall_confidence ?? null,
    data_quality: analysis.data_quality ?? null,
  }).select('id').single();

  return res.status(200).json({ recommendations, analysis_id: savedRow?.id || null });
}

// ── ACTION: chat ───────────────────────────────────────────────────────
async function handleChat(req, res) {
  const { session, message, history, profileData, analysis, recommendations } = req.body || {};
  if (!session?.access_token) return res.status(401).json({ error: 'No session' });
  if (!message) return res.status(400).json({ error: 'message required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const user_id = await validateSession(session.access_token);

  let messages;
  if (!history || history.length === 0) {
    const priorSessions = await loadPriorSessions(user_id);
    const sessionContext = buildPriorSessionsContext(priorSessions);
    messages = [{ role: 'user', content: buildFirstMessage(message, profileData, analysis, recommendations || '', sessionContext) }];
  } else {
    messages = [...history, { role: 'user', content: message }];
  }

  const chatData = await callClaude(apiKey, {
    model: 'claude-sonnet-4-6',
    system: CHAT_SYSTEM_PROMPT,
    messages,
    max_tokens: 1500,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 3,
      user_location: getUserLocation(profileData),
    }],
    extraHeaders: { 'anthropic-beta': 'web-search-2025-03-05' },
  });

  const textBlocks = (chatData.content || []).filter(b => b.type === 'text');
  const response = textBlocks.map(b => b.text).join('');
  const updatedHistory = [...messages, { role: 'assistant', content: chatData.content }];

  return res.status(200).json({ response, history: updatedHistory });
}

// ── ACTION: end-session ────────────────────────────────────────────────
const SUMMARY_SYSTEM_PROMPT = `You are summarizing a financial advisor chat session.
Extract structured information about what was discussed and decided.
Respond in JSON only.`;

function formatHistoryForSummary(history) {
  return history
    .filter(msg => msg.role === 'user' || msg.role === 'assistant')
    .map(msg => {
      const role = msg.role === 'user' ? 'Usuario' : 'Asesor';
      const text = Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('')
        : msg.content;
      return `${role}: ${text}`;
    })
    .join('\n\n');
}

async function handleEndSession(req, res) {
  const { session, analysis_id, history, turn_count } = req.body || {};
  if (!session?.access_token) return res.status(401).json({ error: 'No session' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const user_id = await validateSession(session.access_token);

  // Skip summary generation for very short sessions
  if (!history || history.length === 0 || (turn_count || 0) < 2) {
    await supabase.from('ai_sessions').insert({
      user_id,
      analysis_id: analysis_id || null,
      ended_at: new Date().toISOString(),
      turn_count: turn_count || 0,
      summary: null,
    });
    return res.status(200).json({ success: true, summary: null });
  }

  const summaryPrompt = `Summarize this financial advisory chat session.

<conversation>
${formatHistoryForSummary(history)}
</conversation>

Return this JSON:
{
  "synthesis": "2-3 sentences describing what was discussed and the overall outcome",
  "agreed": [
    { "action": "specific action the user committed to", "savings_mxn": 0, "deadline": "timeframe if mentioned or null" }
  ],
  "rejected": ["topic or solution the user explicitly declined"],
  "open": ["topics raised but not resolved — needs follow-up"],
  "user_sentiment": "engaged | skeptical | overwhelmed | satisfied"
}

Rules:
- Only include in agreed[] actions the user explicitly confirmed
- Only include in rejected[] things the user explicitly declined
- If unclear, put in open[]
- Respond in Spanish for synthesis, agreed, rejected, open fields`;

  const summaryData = await callClaude(apiKey, {
    model: 'claude-haiku-4-5-20251001',
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: summaryPrompt }],
    max_tokens: 500,
    temperature: 0.3,
  });

  const summaryJson = parseJSON(summaryData.content?.[0]?.text || '{}');

  await supabase.from('ai_sessions').insert({
    user_id,
    analysis_id: analysis_id || null,
    ended_at: new Date().toISOString(),
    turn_count: turn_count || 0,
    summary: summaryJson,
  });

  return res.status(200).json({ success: true, summary: summaryJson });
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Determine action from URL path
  const url = req.url || '';
  let action;
  if (url.includes('analyze-answers')) action = 'answers';
  else if (url.includes('end-session')) action = 'end-session';
  else if (url.includes('chat')) action = 'chat';
  else action = 'analyze';

  try {
    if (action === 'analyze') return await handleAnalyze(req, res);
    if (action === 'answers') return await handleAnswers(req, res);
    if (action === 'chat') return await handleChat(req, res);
    if (action === 'end-session') return await handleEndSession(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(`advisor [${action}] error:`, err);
    return res.status(500).json({ error: err.message });
  }
}
