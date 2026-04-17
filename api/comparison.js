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

  // Find consecutive run of calendar months from most recent (for calendar-mode dropdowns)
  const consecutiveMonths = calendarMonths.filter((m, i, arr) => {
    if (i === 0) return true;
    const prev = new Date(arr[i-1] + '-01');
    const curr = new Date(m + '-01');
    const diff = (prev.getFullYear() - curr.getFullYear()) * 12
               + prev.getMonth() - curr.getMonth();
    return diff === 1;
  });

  // Calendar mode requires 3+ consecutive statement months (not just transaction months)
  // A single statement spanning two months must not count as two periods
  const uniqueStmtMonths = [...new Set(
    statements.filter(s => s.period_start).map(s => s.period_start.slice(0, 7))
  )].sort().reverse();

  const consecutiveStmtMonths = uniqueStmtMonths.filter((m, i, arr) => {
    if (i === 0) return true;
    const prev = new Date(arr[i-1] + '-01');
    const curr = new Date(m + '-01');
    const diff = (prev.getFullYear() - curr.getFullYear()) * 12
               + prev.getMonth() - curr.getMonth();
    return diff === 1;
  });

  const useCalendarMode = consecutiveStmtMonths.length >= 3;

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

  // Detect which calendar months are incomplete
  // A month is complete if at least one statement covers >= 20 days of it
  function getDaysInMonth(yearMonth) {
    const [year, month] = yearMonth.split('-').map(Number);
    return new Date(year, month, 0).getDate();
  }

  function getOverlapDays(yearMonth, periodStart, periodEnd) {
    if (!periodStart || !periodEnd) return 0;
    const [year, month] = yearMonth.split('-').map(Number);
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);
    const stmtStart = new Date(periodStart);
    const stmtEnd = new Date(periodEnd);
    const overlapStart = stmtStart > monthStart ? stmtStart : monthStart;
    const overlapEnd = stmtEnd < monthEnd ? stmtEnd : monthEnd;
    if (overlapEnd < overlapStart) return 0;
    return Math.round((overlapEnd - overlapStart) / (1000 * 60 * 60 * 24)) + 1;
  }

  const incompleteMonths = new Set();
  calendarMonths.forEach(month => {
    const totalDays = getDaysInMonth(month);
    const maxOverlap = Math.max(
      ...statements.map(s => getOverlapDays(month, s.period_start, s.period_end))
    );
    if (maxOverlap < 20 || maxOverlap < totalDays * 0.65) {
      incompleteMonths.add(month);
    }
  });

  return res.status(200).json({
    useCalendarMode,
    calendarMonths,
    consecutiveMonths,
    statements,
    monthTotals,
    statementTotals,
    incompleteMonths: [...incompleteMonths],
  });
}
