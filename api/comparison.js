import { supabase, supabaseAnon } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { session } = req.body;

  const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(session.access_token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: statements, error: stmtError } = await supabase
    .from('statements')
    .select('*')
    .eq('user_id', user.id)
    .order('period_start', { ascending: false });

  if (stmtError) return res.status(500).json({ error: stmtError.message });

  const { data: transactions, error: txnError } = await supabase
    .from('transactions')
    .select('calendar_month, final_category, direction, amount')
    .eq('user_id', user.id)
    .not('calendar_month', 'is', null)
    .order('calendar_month', { ascending: false });

  if (txnError) return res.status(500).json({ error: txnError.message });

  // Group transactions by calendar_month
  const byMonth = {};
  transactions.forEach(t => {
    if (!byMonth[t.calendar_month]) byMonth[t.calendar_month] = [];
    byMonth[t.calendar_month].push(t);
  });

  const calendarMonths = Object.keys(byMonth).sort().reverse();

  // Find consecutive run of months from most recent
  const consecutiveMonths = calendarMonths.filter((m, i, arr) => {
    if (i === 0) return true;
    const prev = new Date(arr[i-1] + '-01');
    const curr = new Date(m + '-01');
    const diff = (prev.getFullYear() - curr.getFullYear()) * 12
               + prev.getMonth() - curr.getMonth();
    return diff === 1;
  });

  const useCalendarMode = consecutiveMonths.length >= 3;

  // Calculate totals per month
  const monthTotals = {};
  Object.entries(byMonth).forEach(([month, txns]) => {
    const income = txns
      .filter(t => t.direction === 'credit' && t.final_category !== 'internal_transfer')
      .reduce((s, t) => s + (t.amount || 0), 0);
    const expenses = txns
      .filter(t => t.direction === 'debit' && t.final_category !== 'internal_transfer')
      .reduce((s, t) => s + (t.amount || 0), 0);
    const byCategory = {};
    txns.forEach(t => {
      if (t.final_category === 'internal_transfer') return;
      if (!byCategory[t.final_category]) byCategory[t.final_category] = 0;
      byCategory[t.final_category] += t.amount || 0;
    });
    monthTotals[month] = { income, expenses, byCategory };
  });

  // Get transactions grouped by statement_id for statement mode
  const { data: txnsByStatement, error: txnStmtError } = await supabase
    .from('transactions')
    .select('statement_id, final_category, direction, amount')
    .eq('user_id', user.id);

  if (txnStmtError) return res.status(500).json({ error: txnStmtError.message });

  // Build statement totals keyed by statement_id
  const statementTotals = {};
  txnsByStatement.forEach(t => {
    if (!statementTotals[t.statement_id]) {
      statementTotals[t.statement_id] = { income: 0, expenses: 0, byCategory: {} };
    }
    const s = statementTotals[t.statement_id];
    if (t.final_category === 'internal_transfer') return;
    if (t.final_category === 'excluded') return;

    if (t.direction === 'credit') {
      s.income += t.amount || 0;
    } else {
      s.expenses += t.amount || 0;
    }

    if (!s.byCategory[t.final_category]) s.byCategory[t.final_category] = 0;
    s.byCategory[t.final_category] += t.amount || 0;
  });

  return res.status(200).json({
    useCalendarMode,
    calendarMonths,
    consecutiveMonths,
    statements,
    monthTotals,
    statementTotals,
  });
}
