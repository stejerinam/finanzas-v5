import { supabase, supabaseAnon } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── SURVEY SAVE (shared endpoint) ────────────────────────────────────
  if (req.body?.surveyOnly === true) {
    const { session, answers } = req.body;
    if (!session) return res.status(200).json({ success: true, saved: false });
    const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(session.access_token);
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });
    const { error } = await supabase
      .from('profiles')
      .update({
        survey_completed: true,
        survey_completed_at: new Date().toISOString(),
        rich_life_vision: answers.richLife,
        financial_situation: answers.situation,
        primary_goal: answers.goal,
        savings_habit: answers.savings,
        debt_situation: answers.debt,
      })
      .eq('id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true, saved: true });
  }

  const { session, parsedData, categorizedData, selectedCountry, selectedAcctType, contentHash } = req.body;

  console.log('save.js received:', JSON.stringify({
    bank: parsedData?.bank,
    periodStart: parsedData?.periodStart,
    periodEnd: parsedData?.periodEnd,
    country: parsedData?.country,
    currency: parsedData?.currency,
    transactionCount: parsedData?.transactions?.length,
  }));

  console.log('save.js called', {
    hasSession: !!session,
    hasAccessToken: !!session?.access_token,
    hasParsedData: !!parsedData,
    txnCount: parsedData?.transactions?.length,
    catCount: Array.isArray(categorizedData) ? categorizedData.length : 'not array',
    selectedAcctType,
  });

  // Verify the user session
  const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(session.access_token);
  if (authError || !user) {
    console.error('Auth error:', authError?.message);
    return res.status(401).json({ error: 'Unauthorized', detail: authError?.message });
  }
  console.log('Auth OK, user:', user.id);

  const currency = parsedData.currency || selectedCountry?.currency || 'MXN';
  const transactions = parsedData.transactions || [];
  const cats = categorizedData || [];
  const country = parsedData.country || selectedCountry?.name || null;

  console.log('parsedData fields:', {
    bank: parsedData.bank,
    periodStart: parsedData.periodStart,
    periodEnd: parsedData.periodEnd,
    country: parsedData.country,
    currency: parsedData.currency,
  });

  // Calculate totals
  const totalIncome = cats.reduce((sum, c, i) => {
    const t = transactions[i];
    if (t?.direction === 'credit' && c.finalCategory !== 'internal_transfer') {
      return sum + (t.amount || 0);
    }
    return sum;
  }, 0);

  const totalExpenses = cats.reduce((sum, c, i) => {
    const t = transactions[i];
    if (t?.direction === 'debit' && c.finalCategory !== 'internal_transfer') {
      return sum + (t.amount || 0);
    }
    return sum;
  }, 0);

  console.log('Inserting statement:', { currency, totalIncome, totalExpenses, txnCount: transactions.length });

  // Insert statement
  const { data: statement, error: stmtError } = await supabase
    .from('statements')
    .insert({
      user_id: user.id,
      bank: parsedData.bank || null,
      account_type: selectedAcctType || null,
      period_start: parsedData.periodStart || null,
      period_end: parsedData.periodEnd || null,
      currency,
      country,
      total_income: totalIncome,
      total_expenses: totalExpenses,
      transaction_count: transactions.length,
      content_hash: contentHash || null,
    })
    .select()
    .single();

  if (stmtError) {
    console.error('Statement insert error:', stmtError);
    return res.status(500).json({ error: stmtError.message, detail: stmtError });
  }
  console.log('Statement inserted, id:', statement.id);

  // Update profile with country/currency from this statement
  // Prefer the user-selected country code over what the AI detected in the PDF
  await supabase
    .from('profiles')
    .update({
      country: selectedCountry?.code || parsedData.country,
      currency,
      locale: selectedCountry?.locale || 'es-MX',
    })
    .eq('id', user.id);

  // Insert transactions
  const txnRows = transactions.map((t, i) => {
    const c = cats[i] || {};
    return {
      statement_id: statement.id,
      user_id: user.id,
      date: t.date,
      description: t.description,
      amount: t.amount,
      direction: t.direction,
      type: t.type,
      reference: t.reference,
      merchant_hint: t.merchantHint,
      counterparty: t.counterpartyName,
      ai_category: c.category,
      final_category: c.finalCategory,
      confidence: c.confidence,
      tier: c.tier,
      manually_edited: false,
      calendar_month: t.date ? t.date.slice(0, 7) : null,
    };
  });

  console.log('Inserting', txnRows.length, 'transactions, sample:', txnRows[0]);

  const { error: txnError } = await supabase
    .from('transactions')
    .insert(txnRows);

  if (txnError) {
    console.error('Transactions insert error:', txnError);
    return res.status(500).json({ error: txnError.message, detail: txnError });
  }
  console.log('Transactions inserted OK');

  // Build merchant memory entries from all categorized transactions
  const merchantRows = [];
  const seenMerchants = new Set();

  txnRows.forEach((t) => {
    const merchantKey = t.description?.toLowerCase().trim() || '';

    if (!merchantKey || seenMerchants.has(merchantKey)) return;
    if (!t.final_category || t.final_category === 'unassigned') return;
    if (t.final_category === 'internal_transfer') return;

    seenMerchants.add(merchantKey);
    merchantRows.push({
      user_id: user.id,
      merchant_name: merchantKey,
      ai_category: t.final_category,
      user_category: null,
      times_seen: 1,
      times_corrected: 0,
      country,
      last_seen_at: new Date().toISOString(),
    });
  });

  if (merchantRows.length > 0) {
    for (const row of merchantRows) {
      const { data: existing } = await supabase
        .from('merchant_memory')
        .select('id, times_seen')
        .eq('user_id', user.id)
        .eq('merchant_name', row.merchant_name)
        .eq('country', row.country)
        .single();

      if (existing) {
        await supabase
          .from('merchant_memory')
          .update({
            ai_category: row.ai_category,
            times_seen: existing.times_seen + 1,
            last_seen_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('merchant_memory')
          .insert(row);
      }
    }

    // Update global merchant consensus (1 vote per user per merchant)
    for (const row of merchantRows) {
      const { data: existingMemory } = await supabase
        .from('merchant_memory')
        .select('ai_category, user_category')
        .eq('user_id', user.id)
        .eq('merchant_name', row.merchant_name)
        .eq('country', row.country)
        .single();

      const previousVote = existingMemory?.user_category || existingMemory?.ai_category;

      const { data: consensus } = await supabase
        .from('merchant_consensus')
        .select('*')
        .eq('merchant_name', row.merchant_name)
        .eq('country', row.country)
        .single();

      if (consensus) {
        const votes = consensus.category_votes || {};

        if (previousVote && votes[previousVote] > 0) {
          votes[previousVote] = votes[previousVote] - 1;
          if (votes[previousVote] === 0) delete votes[previousVote];
        }

        votes[row.ai_category] = (votes[row.ai_category] || 0) + 1;

        const totalVotes = Object.values(votes).reduce((s, v) => s + v, 0);
        const topCategory = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] || row.ai_category;

        await supabase
          .from('merchant_consensus')
          .update({
            category_votes: votes,
            top_category: topCategory,
            total_votes: totalVotes,
            confidence: totalVotes > 0 ? votes[topCategory] / totalVotes : 1,
            last_updated_at: new Date().toISOString(),
          })
          .eq('merchant_name', row.merchant_name)
          .eq('country', row.country);
      } else {
        await supabase
          .from('merchant_consensus')
          .insert({
            merchant_name: row.merchant_name,
            country: row.country,
            category_votes: { [row.ai_category]: 1 },
            top_category: row.ai_category,
            total_votes: 1,
            confidence: 1.0,
          });
      }
    }
    // Don't fail the whole save if merchant memory fails
  }

  return res.status(200).json({ success: true, statementId: statement.id });
}
