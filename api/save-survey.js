import { supabase } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { session, answers } = req.body;

  // If no session, return success without saving
  // (answers are stored in localStorage on frontend)
  if (!session) {
    return res.status(200).json({ success: true, saved: false });
  }

  const { data: { user }, error: authError } =
    await supabase.auth.getUser(session.access_token);
  if (authError || !user)
    return res.status(401).json({ error: 'Unauthorized' });

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

  if (error)
    return res.status(500).json({ error: error.message });

  return res.status(200).json({ success: true, saved: true });
}
