// ── advisor.js ────────────────────────────────────────────────────────
// Handles 5 actions routed from vercel.json:
//   POST /api/analyze        → action: 'analyze'        (full analysis pipeline)
//   POST /api/analyze-answers → action: 'answers'       (recommendations after Q&A)
//   POST /api/analyze-delta  → action: 'analyze-delta'  (delta check on new statements)
//   POST /api/chat           → action: 'chat'            (multi-turn chat turn)
//   POST /api/chat/end-session → action: 'end-session'  (save session summary)
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

function isCacheValid(cached) {
  if (!cached) return false;
  const age = Date.now() - new Date(cached.created_at).getTime();
  return age <= 7 * 24 * 60 * 60 * 1000;
}

async function getAnalysisPending(userId) {
  const { data } = await supabase
    .from('statements')
    .select('id')
    .eq('user_id', userId)
    .is('included_in_analysis_id', null)
    .limit(1);
  return !!(data && data.length > 0);
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
  const cachedRow = await getCachedAnalysis(user_id);
  const analysisPending = await getAnalysisPending(user_id);
  if (isCacheValid(cachedRow)) {
    return res.status(200).json({
      analysis: cachedRow.analysis,
      critique: cachedRow.critique,
      recommendations: cachedRow.recommendations,
      profileData: trimmedProfileData,
      questions: [],
      awaiting_answers: false,
      cached: true,
      analysis_id: cachedRow.id,
      analysis_pending: analysisPending,
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

  // Save to cache — best-effort, never blocks the response
  let savedAnalysisId = null;
  try {
    const earliestPeriodStart = stmtRows?.[0]?.period_start || '';
    const latestPeriodEnd = stmtRows?.[stmtRows.length - 1]?.period_end || '';
    await supabase.from('ai_analyses').update({ is_latest: false }).eq('user_id', user_id);
    const { data: savedRow, error: saveErr } = await supabase.from('ai_analyses').insert({
      user_id,
      is_latest: true,
      months_covered: `${earliestPeriodStart} to ${latestPeriodEnd}`,
      analysis,
      critique,
      recommendations,
      in_deficit: analysis.in_deficit ?? null,
      deficit_amount: analysis.deficit_amount ?? null,
      overall_confidence: critique.overall_confidence != null ? String(critique.overall_confidence) : null,
      data_quality: analysis.data_quality ?? null,
    }).select('id').single();

    if (saveErr) console.error('advisor [analyze] save error:', saveErr);
    else {
      savedAnalysisId = savedRow?.id || null;
      if (savedAnalysisId) {
        await supabase.from('statements').update({ included_in_analysis_id: savedAnalysisId }).eq('user_id', user_id);
      }
    }
  } catch (saveEx) {
    console.error('advisor [analyze] save exception:', saveEx);
  }

  return res.status(200).json({ analysis, critique, profileData: trimmedProfileData, questions: [], recommendations, awaiting_answers: false, cached: false, analysis_id: savedAnalysisId, analysis_pending: false });
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

  // Save to ai_analyses — best-effort, never blocks the response
  let analysis_id = null;
  try {
    const { data: stmtRows } = await supabase
      .from('statements')
      .select('id, period_start, period_end')
      .eq('user_id', user_id)
      .order('period_start', { ascending: true });
    const earliestPeriodStart = stmtRows?.[0]?.period_start || '';
    const latestPeriodEnd = stmtRows?.[stmtRows?.length - 1]?.period_end || '';

    await supabase.from('ai_analyses').update({ is_latest: false }).eq('user_id', user_id);
    const { data: savedRow, error: saveErr } = await supabase.from('ai_analyses').insert({
      user_id,
      is_latest: true,
      months_covered: `${earliestPeriodStart} to ${latestPeriodEnd}`,
      analysis,
      critique,
      recommendations,
      in_deficit: analysis.in_deficit ?? null,
      deficit_amount: analysis.deficit_amount ?? null,
      overall_confidence: critique.overall_confidence != null ? String(critique.overall_confidence) : null,
      data_quality: analysis.data_quality ?? null,
    }).select('id').single();

    if (saveErr) console.error('advisor [answers] save error:', saveErr);
    else {
      analysis_id = savedRow?.id || null;
      if (analysis_id) {
        await supabase.from('statements').update({ included_in_analysis_id: analysis_id }).eq('user_id', user_id);
      }
    }
  } catch (saveEx) {
    console.error('advisor [answers] save exception:', saveEx);
  }

  return res.status(200).json({ recommendations, analysis_id });
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

// ── DELTA HELPERS ─────────────────────────────────────────────────────
const DELTA_SYSTEM_PROMPT = `Eres un analista financiero evaluando si las
recomendaciones previas de un usuario siguen siendo válidas,
dado un nuevo período de transacciones.
Responde en JSON únicamente.`;

function formatSessionSummaries(sessions) {
  if (!sessions || !sessions.length) return 'Sin sesiones previas.';
  return [...sessions].reverse().map(s => {
    const date = new Date(s.created_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
    const sum = s.summary;
    let text = `Sesión del ${date}:\n`;
    text += `  Síntesis: ${sum.synthesis}\n`;
    if (sum.agreed?.length) text += `  Acordado: ${sum.agreed.map(a => `${a.action} (${a.savings_mxn}/mes)`).join(', ')}\n`;
    if (sum.rejected?.length) text += `  Rechazado: ${sum.rejected.join(', ')}\n`;
    if (sum.open?.length) text += `  Pendiente: ${sum.open.join(', ')}\n`;
    return text;
  }).join('\n');
}

function formatCategoryBreakdown(transactions) {
  const byCategory = {};
  for (const t of transactions) {
    if (t.direction === 'debit' && t.final_category !== 'internal_transfer') {
      byCategory[t.final_category] = (byCategory[t.final_category] || 0) + Number(t.amount);
    }
  }
  return Object.entries(byCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([cat, amt]) => `  ${cat}: ${Math.round(amt).toLocaleString('es-MX')}`)
    .join('\n');
}

// ── ACTION: analyze-delta ──────────────────────────────────────────────
async function handleAnalyzeDelta(req, res) {
  const { session } = req.body || {};
  if (!session?.access_token) return res.status(401).json({ error: 'No session' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const user_id = await validateSession(session.access_token);

  // 1. Load prior analysis
  const { data: priorAnalysis } = await supabase
    .from('ai_analyses')
    .select('*')
    .eq('user_id', user_id)
    .eq('is_latest', true)
    .single();

  if (!priorAnalysis) return res.status(200).json({ signal: 'new_user' });

  // 2. Load new statements only (included_in_analysis_id IS NULL)
  const { data: newStatements } = await supabase
    .from('statements')
    .select('id, period_start, period_end, bank')
    .eq('user_id', user_id)
    .is('included_in_analysis_id', null)
    .order('period_start', { ascending: true });

  if (!newStatements || newStatements.length === 0) {
    return res.status(200).json({ signal: 'no_new_statements' });
  }

  // 3. Load transactions for new statements only
  const newStatementIds = newStatements.map(s => s.id);
  const { data: rawNew } = await supabase
    .from('transactions')
    .select('*')
    .in('statement_id', newStatementIds)
    .order('date', { ascending: true });

  const newSummary = computeSummary(rawNew || []);

  // 4. Load prior sessions
  const priorSessions = await loadPriorSessions(user_id, 3);

  // 5. Build and run Haiku delta check
  const newPeriodLabel = newStatements.map(s => `${s.period_start} → ${s.period_end}`).join(', ');

  const deltaPrompt = `Evalúa si las recomendaciones previas siguen vigentes dado el nuevo período de transacciones del usuario.

IMPORTANTE: Las nuevas transacciones representan SOLO el período nuevo, no el historial completo. Compara patrones nuevos vs el análisis previo.

<analisis_previo>
Problema: ${priorAnalysis.analysis?.smart_problem || ''}
Déficit mensual previo: ${priorAnalysis.deficit_amount || 0}/mes
Confianza: ${priorAnalysis.overall_confidence || ''}
Recomendaciones previas:
${(priorAnalysis.recommendations || '').slice(0, 800)}
</analisis_previo>

<sesiones_anteriores>
${formatSessionSummaries(priorSessions)}
</sesiones_anteriores>

<nuevas_transacciones>
Período nuevo: ${newPeriodLabel}
Total transacciones nuevas: ${(rawNew || []).length}
Ingreso nuevo período: ${newSummary.total_income}
Gasto nuevo período: ${newSummary.total_expenses}
Balance nuevo período: ${newSummary.net_balance}

Gastos por categoría (período nuevo únicamente):
${formatCategoryBreakdown(rawNew || [])}
</nuevas_transacciones>

Evalúa dos cosas:

1. SEGUIMIENTO: Para cada acuerdo en sesiones anteriores, busca evidencia en las NUEVAS transacciones de si se cumplió.
   Ejemplo: acordó cancelar suscripción X → ¿sigue apareciendo en nuevas txns?
   Ejemplo: acordó reducir Uber → ¿bajó el gasto en transport vs análisis previo?
   Si no hay suficiente evidencia en el período nuevo, marca no_evidence: true.

2. SEÑAL:
   - "on_track": patrones mejoraron o se mantienen, recs previas siguen aplicando
   - "needs_update": algo cambió pero recs base siguen siendo relevantes
   - "significant_change": cambio mayor en ingresos o estructura de gastos — requiere análisis completo nuevo

Retorna este JSON:
{
  "signal": "on_track | needs_update | significant_change",
  "metrics": {
    "deficit_prior": 0,
    "deficit_current": 0,
    "delta_amount": 0,
    "improved": true or false
  },
  "followthrough": [
    {
      "action": "acuerdo de sesión previa",
      "evidence": "qué muestran las nuevas transacciones",
      "completed": true or false,
      "no_evidence": true or false
    }
  ],
  "progress_summary": "2-3 oraciones en español sobre el progreso",
  "recommendations_still_valid": true or false,
  "what_changed": "descripción breve si algo cambió materialmente, o null"
}`;

  const deltaData = await callClaude(apiKey, {
    model: 'claude-haiku-4-5-20251001',
    system: DELTA_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: deltaPrompt }],
    max_tokens: 800,
    temperature: 0.3,
  });

  let deltaResult;
  try {
    const raw = deltaData.content?.[0]?.text || '{}';
    const sanitized = raw.replace(/[\r\n\t]/g, ' ');
    deltaResult = parseJSON(sanitized);
  } catch (e) {
    console.error('advisor [analyze-delta] parse error:', e);
    deltaResult = { signal: 'needs_update', metrics: {}, followthrough: [], progress_summary: 'No se pudo evaluar el progreso.', recommendations_still_valid: true, what_changed: null };
  }

  const signal = deltaResult.signal || 'needs_update';

  // 6a. on_track / needs_update — save delta, mark new statements, return cached recs
  if (signal === 'on_track' || signal === 'needs_update') {
    await supabase.from('ai_analyses')
      .update({ delta_check: deltaResult, delta_checked_at: new Date().toISOString() })
      .eq('id', priorAnalysis.id);

    await supabase.from('statements')
      .update({ included_in_analysis_id: priorAnalysis.id })
      .in('id', newStatementIds);

    return res.status(200).json({
      signal,
      metrics: deltaResult.metrics,
      followthrough: deltaResult.followthrough,
      progress_summary: deltaResult.progress_summary,
      recommendations: priorAnalysis.recommendations,
      cached: true,
    });
  }

  // 6b. significant_change — run full pipeline on ALL transactions
  const [
    { data: profile },
    { data: allTransactions },
    { data: allStmtRows },
  ] = await Promise.all([
    supabase.from('profiles').select('country, currency, locale, financial_situation, primary_goal, savings_habit, debt_situation, rich_life_categories, ordinary_categories').eq('id', user_id).single(),
    supabase.from('transactions').select('date, description, amount, direction, final_category, type, calendar_month').eq('user_id', user_id).order('date', { ascending: true }),
    supabase.from('statements').select('id, period_start, period_end').eq('user_id', user_id).order('period_start', { ascending: true }),
  ]);

  const allSummary = computeSummary(allTransactions || []);
  const months_of_history = new Set((allTransactions || []).map(t => t.calendar_month).filter(Boolean)).size;
  const profileData = {
    survey: {
      richLifeCategories: profile.rich_life_categories || [],
      ordinaryCategories: profile.ordinary_categories || [],
      situation: profile.financial_situation || 'unknown',
      goal: profile.primary_goal || 'unknown',
      savings: profile.savings_habit || 'unknown',
      debt: profile.debt_situation || 'unknown',
    },
    summary: allSummary,
    transactions: (allTransactions || []).slice(0, 500),
    profile_meta: { country: profile.country || 'Mexico', currency: profile.currency || 'MXN', months_of_history },
  };

  // Build seguimiento context from followthrough
  let seguimientoPrevio = null;
  if (deltaResult.followthrough?.length > 0) {
    seguimientoPrevio = `<seguimiento_previo>\nEl usuario tuvo los siguientes compromisos en sesiones anteriores:\n${
      deltaResult.followthrough.map(f =>
        `- ${f.action}: ${f.completed ? '✅ Completado' : f.no_evidence ? '❓ Sin evidencia aún' : '⏳ Pendiente'} — ${f.evidence}`
      ).join('\n')
    }\nConsidera este historial al formular nuevas recomendaciones.\nSi algo fue completado, no lo recomiendes de nuevo.\nSi algo está pendiente, considera mencionarlo como seguimiento.\n</seguimiento_previo>`;
  }

  const newAnalysisData = await callClaude(apiKey, {
    model: 'claude-sonnet-4-6',
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildAnalysisPrompt(profileData, seguimientoPrevio) }],
    max_tokens: 8000,
    temperature: 0.1,
  });
  const newAnalysis = parseJSON(newAnalysisData.content?.[0]?.text || '{}');

  const newCritiqueData = await callClaude(apiKey, {
    model: 'claude-haiku-4-5-20251001',
    system: CRITIQUE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildCritiquePrompt(profileData, newAnalysis) }],
    max_tokens: 8000,
    temperature: 0.0,
  });
  const newCritique = parseJSON(newCritiqueData.content?.[0]?.text || '{}');

  const newRecData = await callClaude(apiKey, {
    model: 'claude-sonnet-4-6',
    system: RECOMMENDATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildRecommendationPrompt(profileData, newAnalysis, newCritique, {}) }],
    max_tokens: 1500,
    temperature: 0.3,
  });
  const newRecommendations = newRecData.content?.[0]?.text || '';

  // Save new analysis row and mark ALL statements
  let newAnalysisId = null;
  try {
    const earliestPeriodStart = allStmtRows?.[0]?.period_start || '';
    const latestPeriodEnd = allStmtRows?.[allStmtRows.length - 1]?.period_end || '';
    await supabase.from('ai_analyses').update({ is_latest: false }).eq('user_id', user_id);
    const { data: savedRow, error: saveErr } = await supabase.from('ai_analyses').insert({
      user_id,
      is_latest: true,
      months_covered: `${earliestPeriodStart} to ${latestPeriodEnd}`,
      analysis: newAnalysis,
      critique: newCritique,
      recommendations: newRecommendations,
      in_deficit: newAnalysis.in_deficit ?? null,
      deficit_amount: newAnalysis.deficit_amount ?? null,
      overall_confidence: newCritique.overall_confidence != null ? String(newCritique.overall_confidence) : null,
      data_quality: newAnalysis.data_quality ?? null,
    }).select('id').single();
    if (saveErr) console.error('advisor [analyze-delta] save error:', saveErr);
    else newAnalysisId = savedRow?.id || null;
  } catch (saveEx) {
    console.error('advisor [analyze-delta] save exception:', saveEx);
  }

  if (newAnalysisId) {
    await supabase.from('statements').update({ included_in_analysis_id: newAnalysisId }).eq('user_id', user_id);
  }

  return res.status(200).json({
    signal,
    analysis: newAnalysis,
    critique: newCritique,
    recommendations: newRecommendations,
    followthrough: deltaResult.followthrough,
    progress_summary: deltaResult.progress_summary,
    cached: false,
  });
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

  let summaryJson = null;
  const rawSummary = summaryData.content?.[0]?.text || '';
  try {
    // Replace literal control characters (unescaped newlines/tabs inside strings break JSON.parse)
    const sanitized = rawSummary.replace(/[\r\n\t]/g, ' ');
    summaryJson = parseJSON(sanitized);
  } catch (parseErr) {
    console.error('advisor [end-session] summary parse error:', parseErr.message);
    // Fallback: store raw text so the session row is never empty
    summaryJson = { synthesis: rawSummary.slice(0, 1000), parse_error: true };
  }

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
  else if (url.includes('analyze-delta')) action = 'analyze-delta';
  else if (url.includes('end-session')) action = 'end-session';
  else if (url.includes('chat')) action = 'chat';
  else action = 'analyze';

  try {
    if (action === 'analyze') return await handleAnalyze(req, res);
    if (action === 'answers') return await handleAnswers(req, res);
    if (action === 'analyze-delta') return await handleAnalyzeDelta(req, res);
    if (action === 'chat') return await handleChat(req, res);
    if (action === 'end-session') return await handleEndSession(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(`advisor [${action}] error:`, err);
    return res.status(500).json({ error: err.message });
  }
}
