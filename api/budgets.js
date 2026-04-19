import { supabase, supabaseAnon } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { session, action, categoryId, amount } = req.body;

  const { data: { user }, error: authError } =
    await supabaseAnon.auth.getUser(session.access_token);
  if (authError || !user)
    return res.status(401).json({ error: 'Unauthorized', detail: authError?.message });

  if (action === 'get') {
    const { data: budgets, error: budgetError } = await supabase
      .from('budgets')
      .select('*')
      .eq('user_id', user.id)
      .eq('month', 'rolling');

    if (budgetError)
      return res.status(500).json({ error: budgetError.message });

    // transactions has no user_id — join through statements
    const { data: statements } = await supabase
      .from('statements')
      .select('id')
      .eq('user_id', user.id);

    const statementIds = (statements || []).map(s => s.id);

    let averages = {};
    if (statementIds.length > 0) {
      const { data: txns, error: txnError } = await supabase
        .from('transactions')
        .select('final_category, amount, direction, calendar_month')
        .in('statement_id', statementIds)
        .neq('final_category', 'internal_transfer')
        .neq('final_category', 'excluded')
        .eq('direction', 'debit')
        .not('calendar_month', 'is', null)
        .order('calendar_month', { ascending: false })
        .limit(1000);

      if (txnError)
        return res.status(500).json({ error: txnError.message });

      const catMonthTotals = {};
      txns.forEach(t => {
        if (!catMonthTotals[t.final_category])
          catMonthTotals[t.final_category] = {};
        if (!catMonthTotals[t.final_category][t.calendar_month])
          catMonthTotals[t.final_category][t.calendar_month] = 0;
        catMonthTotals[t.final_category][t.calendar_month] += t.amount || 0;
      });

      Object.entries(catMonthTotals).forEach(([cat, months]) => {
        const totals = Object.values(months);
        averages[cat] = Math.round(totals.reduce((s, v) => s + v, 0) / totals.length);
      });
    }

    return res.status(200).json({ budgets, averages });
  }

  if (action === 'set') {
    // delete existing rolling budget for this category, then insert fresh
    await supabase
      .from('budgets')
      .delete()
      .eq('user_id', user.id)
      .eq('category_id', categoryId)
      .eq('month', 'rolling');

    const { error } = await supabase
      .from('budgets')
      .insert({ user_id: user.id, category_id: categoryId, amount, month: 'rolling' });

    if (error)
      return res.status(500).json({ error: error.message, detail: error.details, hint: error.hint });

    return res.status(200).json({ success: true });
  }

  if (action === 'delete') {
    const { error } = await supabase
      .from('budgets')
      .delete()
      .eq('user_id', user.id)
      .eq('category_id', categoryId)
      .eq('month', 'rolling');

    if (error)
      return res.status(500).json({ error: error.message });

    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: 'Invalid action' });
}
