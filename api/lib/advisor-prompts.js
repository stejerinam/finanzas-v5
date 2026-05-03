// ── advisor-prompts.js ────────────────────────────────────────────────
// Shared prompt builders for the AI financial advisor pipeline.
// All prompts ported verbatim from finanzas_prompt_eval_v6.ipynb
// ─────────────────────────────────────────────────────────────────────

// ── NUMBER FORMAT HELPER ──────────────────────────────────────────────
const fmt = n => Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const pct = (n, d) => (d > 0 ? (n / d * 100).toFixed(1) : '0.0');

// ── SYSTEM PROMPTS ────────────────────────────────────────────────────

export const ANALYSIS_SYSTEM_PROMPT = `You are an expert financial analyst.
Your job is to analyze a user's financial data using a structured problem-solving approach.
This output is internal — it is never shown to the user.
Be rigorous, data-grounded, and concise. Always respond with valid JSON only.`;

export const CRITIQUE_SYSTEM_PROMPT = `You are a rigorous financial advisor stress-tester.
Your job is to find flaws in proposed financial solutions — not validate them.
You evaluate solutions against the user's actual transaction data.
Be skeptical. Assumptions that aren't grounded in data must be flagged.
Respond in JSON only.`;

export const RECOMMENDATION_SYSTEM_PROMPT = `Eres un asesor financiero personal experto en finanzas mexicanas.
Tu estilo: profesional, directo y conciso. Sin relleno, sin frases motivacionales vacías.
Respuestas con números concretos del usuario. Tono de asesor experto, no de coach.
Nunca juzgas el gasto del usuario — identificas oportunidades y propones alternativas.
Siempre en español.`;

export const CHAT_SYSTEM_PROMPT = `Eres un asesor financiero personal experto en finanzas mexicanas.
El usuario recibió un análisis financiero y recomendaciones personalizadas.
Este chat es para que el usuario itere sobre esas recomendaciones hasta llegar a una solución con la que se sienta cómodo.

Tu objetivo: acompañar al usuario en ese proceso de decisión, no convencerlo de nada.

CÓMO RESPONDER:

1. RESPUESTAS CONVERSACIONALES (la mayoría de los casos):
   Responde directamente a lo que dice el usuario — preguntas, dudas, respuestas libres, comentarios.
   No necesitas buscar en internet para aclarar montos, explorar alternativas del análisis, o discutir opciones.
   Usa el contexto del análisis y las recomendaciones que ya tienes en el historial.

2. BÚSQUEDA WEB (solo cuando agrega valor real):
   Usa la herramienta de búsqueda ÚNICAMENTE cuando el usuario quiera confirmar información. Puedes usar una follow-up question al final del texto para ver si el usuario quiere que busques algo específico (Ej. Quieres que busque las mejores opciones de X? ), o el usuario puede pedirlo directamente en el chat
   específica del mundo real — precios actuales de servicios, disponibilidad en su ciudad, tasas vigentes.
   Ejemplos válidos: costos actuales de un servicio específico, tasas de consolidación de deuda hoy.
   NO la uses para respuestas conversacionales o aclaraciones sobre los datos del usuario.

3. PIVOTS — cuando el usuario rechaza algo:

   Si rechaza UNA SOLUCIÓN ESPECÍFICA ("no me convence", "hay otra opción", "eso no aplica"):
   → Propón la siguiente solución mejor rankeada dentro del MISMO problema.
   → "Entendido. Dentro del mismo tema, la siguiente opción disponible es..."
   → Explica brevemente qué la diferencia de la anterior.

   Si rechaza CAMBIAR ESE HÁBITO O ÁREA COMPLETA ("no voy a tocar ese gasto", "ese hábito no lo cambio"):
   → Cambia al siguiente problema en el análisis (siguiente rank).
   → "Entendido, dejamos ese tema. La siguiente oportunidad más grande es en..."

   Si rechaza todo:
   → "Hemos revisado todas las opciones de optimización de gastos identificadas.
      Si ninguna aplica, la alternativa es aumentar ingresos. ¿Quieres explorar eso?"

TONO:
- Directo y conciso, como un amigo experto — no un coach motivacional
- Máximo 250 palabras por respuesta
- Sin frases de relleno ("es importante que", "recuerda que", "considera que")
- Siempre en español
- Termina con una pregunta corta o próximo paso concreto. Aqui puede entrar la oportunidad de usar la búsqueda web para validar información específica del mundo real.`;

// ── LOCATION MAPS ─────────────────────────────────────────────────────
// Keys are full country names (as stored in profiles.country)

const TIMEZONE_MAP = {
  'Mexico':    'America/Mexico_City',
  'Colombia':  'America/Bogota',
  'Argentina': 'America/Argentina/Buenos_Aires',
  'Chile':     'America/Santiago',
  'Peru':      'America/Lima',
  'España':    'Europe/Madrid',
};

const COUNTRY_CODE_MAP = {
  'Mexico': 'MX', 'Colombia': 'CO', 'Argentina': 'AR',
  'Chile': 'CL', 'Peru': 'PE', 'España': 'ES',
};

// ── HELPERS ───────────────────────────────────────────────────────────

/**
 * Compute financial summary from raw transactions.
 * Excludes internal_transfer and excluded from ALL totals.
 */
export function computeSummary(transactions) {
  const EXCLUDED_CATS = new Set(['internal_transfer', 'excluded']);

  let total_income = 0;
  let total_expenses = 0;
  const spending_by_category = {};
  const installment_plans = [];

  for (const t of transactions) {
    if (EXCLUDED_CATS.has(t.final_category)) continue;
    const amt = Number(t.amount) || 0;
    if (t.direction === 'credit') {
      total_income += amt;
    } else {
      total_expenses += amt;
      const cat = t.final_category || 'unassigned';
      spending_by_category[cat] = (spending_by_category[cat] || 0) + amt;
    }
    if (t.type === 'Installment Plan') {
      installment_plans.push(t);
    }
  }

  const total_installment_debt = installment_plans.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const net_balance = total_income - total_expenses;

  return { total_income, total_expenses, net_balance, spending_by_category, installment_plans, total_installment_debt };
}

/**
 * Build web search location from profile_meta.
 * No city field in profiles — use country name as city fallback.
 */
export function getUserLocation(profileData) {
  const meta = profileData?.profile_meta || {};
  const country = meta.country || 'Mexico';
  return {
    type: 'approximate',
    city: country,  // No city column in profiles — fall back to country name
    country: COUNTRY_CODE_MAP[country] || 'MX',
    timezone: TIMEZONE_MAP[country] || 'America/Mexico_City',
  };
}

// ── PROMPT BUILDERS ───────────────────────────────────────────────────

/**
 * Build the financial analysis prompt (Cell 4).
 * Ported verbatim from finanzas_prompt_eval_v6.ipynb.
 */
export function buildAnalysisPrompt(profileData) {
  const survey = profileData.survey;
  const summary = profileData.summary;
  const transactions = profileData.transactions;
  const meta = profileData.profile_meta;

  const txnLines = [...transactions]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(t =>
      `- ${t.date} | ${t.description} | ${t.direction === 'credit' ? '+' : '-'}$${fmt(t.amount)} | ${t.final_category} | ${t.type}`
    );
  const txnText = txnLines.join('\n');

  const totalExp = summary.total_expenses;
  const catLines = Object.entries(summary.spending_by_category).map(
    ([cat, amt]) => `  - ${cat}: $${fmt(amt)} (${pct(amt, totalExp)}%)`
  );
  const catText = catLines.join('\n');

  return `Analyze this user's finances using a structured problem-solving approach.

<user_context>
Country: ${meta.country} | Currency: ${meta.currency}
Rich life (never cut): ${(survey.richLifeCategories || []).join(', ')}
Ordinary (ok to reduce): ${(survey.ordinaryCategories || []).join(', ')}
Situation: ${survey.situation} | Goal: ${survey.goal}
Savings habit: ${survey.savings} | Debt: ${survey.debt}
</user_context>

<financial_summary>
Income: $${fmt(summary.total_income)} | Expenses: $${fmt(summary.total_expenses)} | Net: $${fmt(summary.net_balance)}
In deficit: ${summary.net_balance < 0 ? 'YES — CRITICAL' : 'No'}
Expenses by category:
${catText}
MSI plans: ${summary.installment_plans.length} | Total MSI this month: $${fmt(summary.total_installment_debt)}
</financial_summary>

<transactions>
${txnText}
</transactions>

<instructions>
Follow these steps in order. Do NOT skip Step 0.

STEP 0 — DATA QUALITY PRE-CHECK (MANDATORY — run before anything else)
THIS STEP IS NOT OPTIONAL. The analysis is only valid if the income picture is correct.

Calculate these values from the raw data:
  income_months = number of distinct months that have ANY credit/income transactions (excluding internal transfers)
  expense_months = number of distinct months that have debit transactions
  monthly_avg_income = total_income / income_months (use this, NOT total_income)
  monthly_avg_expenses = total_expenses / expense_months (use this, NOT total_expenses)

Apply these rules WITHOUT EXCEPTION:

RULE 1 — If total_income = 0:
  → Credit-card-only data. No income baseline exists.
  → Set in_deficit = false. Do NOT calculate a deficit amount.
  → Focus ONLY on expense optimization — which categories to reduce/replace.
  → smart_problem must say: "Sin datos de ingreso disponibles, el análisis se enfoca en optimizar gastos."
  → so_what must end with: "Para un análisis completo, sube tu estado de débito o nómina."

RULE 2 — If income_months < expense_months:
  → Income is PARTIAL. Using raw totals will massively overstate the deficit.
  → MANDATORY: use monthly_avg_income vs monthly_avg_expenses for ALL comparisons.
  → NEVER use total_income vs total_expenses directly.
  → smart_problem must refer to the MONTHLY AVREAGE DEFICIT and the MONTHLY AVERAGE INCOME and the deficit must be normalized to a monthly figure.
  → in_deficit = true only if monthly_avg_income < monthly_avg_expenses.
  → deficit_amount = monthly_avg_expenses - monthly_avg_income (monthly figure, not cumulative).

RULE 3 — If months_of_history = 1:
  → Single-month snapshot. Avoid "consistently", "pattern", "siempre", "always".

RULE 4 — If transaction_count < 20:
  → Insufficient data. Limit conclusions to what is directly visible.

STEP 1 — SMART PROBLEM STATEMENT
Based on the financial summary and user survey, define the main problem to reach the user objective in one SMART sentence
Must be: Specific (what exactly), Measurable (with amounts),
Achievable (realistic), Relevant (connected to goal), Time-bound.
Example: How can the user reduce their monthly expenses by $5,000 MXN within 3 months to get out of deficit while preserving what they value most?
MANDATORY: Always consider the data quality rules from Step 0 when crafting the problem statement. Do NOT ignore them.

STEP 2 — ISSUE TREE
Decompose exhaustively: Income too low? Fixed costs too high? Variable spending too high?
Use monthly averages (not totals) in all amounts. Go 2 levels deep. Ensure MECE.

STEP 3 — PRIORITIZE AND SELECT SOLUTIONS
A) Apply 80/20: which 1-3 branches explain most of the problem?
   Include all branches that individually represent >10% of total expenses
   or >15% of the monthly gap.. MANDATORY: Select options that have high impact on the user's goal.

B) For each prioritized branch, identify NON-MONETARY BENEFITS of the current behavior.
   These are inferred from spending patterns — NOT user statements.
   Label them clearly as "inferred from data" not "user stated."

C) Generate exactly 4 solutions (ELIMINATE / REPLACE / OPTIMIZE / REDUCE).
   For each solution, BEFORE scoring it, ask yourself:
   - What key assumptions am I making that aren't directly in the transaction data?
   - If those assumptions are wrong, does the solution still work?
   - What critiques would a rigorous financial advisor stress-tester have? What flaws in the proposed financial solutions would they point out?

D) Iterate the solution until it is robust to those assumptions being wrong and the critiques a financial advisor would give.

E) Score them based on: savings, benefits_preserved, realistic_adoption.
   Realistic savings = net benefit after cost of replacement solution.

F) Select highest-scoring solution.
   quick_win = one action this week that has a SIGNIFICANT impact, minimal non-monetary sacrifice.
   habit_change = progressive adoption over weeks with high impact.

STEP 5 — VERIFY WITH DATA
Cite specific merchants, dates, amounts as evidence for selected solutions.
Note contradictions between survey answers and actual behavior.

</instructions>

Return this JSON:
{
  "smart_problem": "one SMART sentence",
  "in_deficit": true or false,
  "deficit_amount": 0,
  "issue_tree": [
    {
      "branch": "name",
      "is_driver": true or false,
      "explanation": "why it is or isn't driving the problem",
      "sub_issues": [
        {"name": "sub-issue", "is_driver": true or false, "evidence": "from data"}
      ]
    }
  ],
  "prioritized": [
    {
      "rank": 1,
      "problem": "what the issue is",
      "non_monetary_benefits": ["list of what user gets from this behavior"],
      "solutions_considered": [
        {
          "option": "description",
          "savings_mxn": 0,
          "benefits_preserved": 0,
          "feasibility": "easy|medium|hard",
          "realistic_adoption": 0,
          "score": 0
        }
      ],
      "selected_solution": {
        "option": "description",
        "type": "quick_win or habit_change",
        "why_selected": "why this beats the alternatives",
        "what_user_keeps": "non-monetary benefits preserved",
        "savings_mxn": 0,
        "evidence": "specific transactions proving the hypothesis",
        "week1": "first small step — must be easy enough that saying no is harder than saying yes",
        "week2": "second step, slightly larger",
        "week3": "full habit established"
      }
    }
  ],
  "non_negotiables": ["categories that must never be cut"],
  "so_what": "the single most important insight in 1-2 sentences",
  "data_quality": {
    "income_complete": true or false,
    "income_months": 0,
    "expense_months": 0,
    "monthly_avg_income": 0,
    "monthly_avg_expenses": 0,
    "limitation_note": "one sentence describing the data gap, or null if data is complete"
  }
}`;
}

/**
 * Build the stress-test / critique prompt (Cell 4.5).
 * Ported verbatim from finanzas_prompt_eval_v6.ipynb.
 */
export function buildCritiquePrompt(profileData, analysis) {
  const survey = profileData.survey;
  const summary = profileData.summary;

  let problemsText = '';
  for (const p of (analysis.prioritized || [])) {
    problemsText += `\nProblem ${p.rank}: ${p.problem}\n`;
    problemsText += `Non-monetary benefits identified: ${JSON.stringify(p.non_monetary_benefits)}\n`;
    problemsText += `Solutions to stress test:\n`;
    for (const s of (p.solutions_considered || [])) {
      const isSelected = s.option === p.selected_solution?.option;
      const marker = isSelected ? '★ SELECTED' : '  option';
      problemsText += `  [${marker}] ${s.option} (score=${s.score || 0})\n`;
      problemsText += `    savings_mxn=${s.savings_mxn}, benefits_preserved=${s.benefits_preserved}/5, realistic_adoption=${s.realistic_adoption}/5\n`;
    }
    const sol = p.selected_solution;
    problemsText += `Selected solution rationale: ${sol?.why_selected}\n`;
    problemsText += `Evidence used: ${sol?.evidence}\n`;
  }

  return `Stress test ALL solutions listed below against the user's actual financial data.

    <user_context>
    Rich life — never cut: ${(survey.richLifeCategories || []).join(', ')}
    Ordinary — ok to reduce: ${(survey.ordinaryCategories || []).join(', ')}
    Goal: ${survey.goal} | Situation: ${survey.situation}
    Income: $${fmt(summary.total_income)} | Expenses: $${fmt(summary.total_expenses)} | Net: $${fmt(summary.net_balance)}
    Months of data: ${profileData.profile_meta?.months_of_history || 1}
    Data quality: income may be incomplete — check analysis notes
    </user_context>

    <smart_problem>${analysis.smart_problem || ''}</smart_problem>

    <solutions_to_evaluate>
    ${problemsText}

    Important distinction:
    - non_monetary_benefits are inferred by the AI from transaction patterns — NOT stated by the user.
    - Only treat something as a user preference if it appears in richLifeCategories or ordinaryCategories
    - Do not cite inferred non-monetary benefits as user-stated constraints in your critique
    </solutions_to_evaluate>

    <CRITICAL DISTINCTION>
    CRITICAL DISTINCTION — read carefully:
    - non_monetary_benefits are hypotheses inferred by the AI from spending patterns — NOT user statements
    - NEVER based your argument based on non_monetary_benefits as if they were user-stated preferences
    - richLifeCategories and ordinaryCategories are the ONLY actual user preferences
    - Never write "user explicitly stated", "user listed", or "user values" when citing non_monetary_benefits
    </CRITICAL DISTINCTION>

    For EACH solution across ALL problems, evaluate:
    1. What assumptions does it make that aren't directly supported by transaction data?
    2. Does it have a fatal flaw — something that would make it fail or cause harm?
    3. Is there missing context from the user that would significantly change the recommendation?
    (e.g. we don't know if they eat lunch at the office, we don't know their commute pattern)
    4. Does the selected solution correctly preserve the non-monetary benefits listed?

    SELECTION RULE (apply after evaluating all solutions):
    1. Filter to only solutions with verdict "pass" or "rescuable"
    2. Among those, select the one with the HIGHEST score from Cell 3
    3. Set promoted_solution to that solution's option_summary
    4. Set selected_passes = true if that solution is "pass" OR "rescuable"
    (rescuable solutions are viable — they just need a minor adjustment)
    5. Set selected_passes = false ONLY if the original Cell 3 selected solution
    has verdict "fatal" or "flawed"
    6. If ALL solutions are "flawed" or "fatal", set promoted_solution = null

    Never select a "flawed" or "fatal" solution regardless of its score.
    The goal is the best viable option, not just the first one that passes.

    Maximum 3 clarifying questions total across ALL problems combined.
    Prioritize the questions whose answers most change which solution gets selected.
    Discard lower-priority questions even if there is missing context.

    Return this JSON:
    {
    "problems": [
        {
        "rank": 1,
        "solutions": [
            {
            "option_summary": "first 60 chars of option",
            "score": 0,
            "is_selected": true or false,
            "assumptions": ["assumption 1", "assumption 2"],
            "fatal_flaw": "description if fatal flaw exists, else null",
            "missing_context": "what we don't know that matters, else null",
            "verdict": "pass | rescuable | flawed | fatal",
            "rescue_adjustment": "if rescuable: one sentence describing the minor change needed to make this solution work, else null"
            }
        ],
        "selected_passes": true if selected solution verdict is "pass", false if "fatal" or "flawed". If selected solution is "rescuable", set selected_passes to true — rescuable solutions are viable,
        "promoted_solution": "option_summary of next-best if selected fails, else null",
        "clarifying_questions": [
            {
            "question": "question text in Spanish",
            "why_needed": "what this answer changes about the recommendation",
            "options": ["option a", "option b", "option c", "Otra respuesta..."]
            }
        ]
        }
    ],
    "overall_confidence": "high | medium | low",
    "critical_missing_context": "the single most important thing we don't know, or null"
    }`;
}

/**
 * Build the recommendations prompt (Cell 5).
 * Ported verbatim from finanzas_prompt_eval_v6.ipynb.
 * @param {object} profileData
 * @param {object} analysis
 * @param {object} critique - from stress test step
 * @param {object} answers  - map of { qId: { question, answer } }
 */
export function buildRecommendationPrompt(profileData, analysis, critique, answers) {
  const survey = profileData.survey;
  const summary = profileData.summary;
  const meta = profileData.profile_meta;
  const prioritized = analysis.prioritized || [];

  const quickWin = prioritized.find(p => p.selected_solution?.type === 'quick_win')?.selected_solution
    || (prioritized[0]?.selected_solution);
  const habitChange = prioritized.find(p => p.selected_solution?.type === 'habit_change')?.selected_solution
    || (prioritized[1]?.selected_solution);
  void quickWin; void habitChange; // referenced for context

  let solutionsContext = '';
  for (const p of prioritized) {
    const sol = p.selected_solution;
    solutionsContext += `\nProblema: ${p.problem}\n`;
    solutionsContext += `Beneficios no monetarios del hábito: ${JSON.stringify(p.non_monetary_benefits)}\n`;
    solutionsContext += `Opciones evaluadas:\n`;
    for (const s of (p.solutions_considered || [])) {
      const selected = s.option === sol?.option ? '✓ SELECCIONADA' : ' ';
      solutionsContext += `  ${selected} ${s.option} (ahorro=$${fmt(s.savings_mxn)}, beneficios=${s.benefits_preserved}/5, adopción=${s.realistic_adoption}/5)\n`;
    }
    solutionsContext += `Por qué se seleccionó: ${sol?.why_selected}\n`;
    solutionsContext += `Qué conserva el usuario: ${sol?.what_user_keeps}\n`;
  }

  let prompt = `Genera un mensaje financiero personalizado para este usuario.

<contexto_usuario>
Moneda: ${meta.currency}
No tocar nunca: ${(analysis.non_negotiables || []).join(', ')}
Meta: ${survey.goal} | Situación: ${survey.situation}
Ingresos: $${fmt(summary.total_income)} | Gastos: $${fmt(summary.total_expenses)} | Balance: $${fmt(summary.net_balance)}
En déficit: ${analysis.in_deficit ? 'Sí' : 'No'}
</contexto_usuario>

<analisis>
Problema central: ${analysis.smart_problem}
La síntesis clave: ${analysis.so_what}
${solutionsContext}
</analisis>

<principios>
El objetivo es un mensaje que:
1. Conecte al usuario con su meta — no lo haga sentir juzgado
2. Le muestre una oportunidad concreta con números reales de sus transacciones
3. Proponga alternativas que preserven lo que valora, no que eliminen lo que disfruta
4. Dé un primer paso tan pequeño que sea imposible decir que no
5. Asegúrate que no mezcles 2 soluciones en una misma recomendación

Para el ahorro estimado, distingue claramente entre:
- Garantizado: ahorros que suceden automáticamente (ej. cancelar suscripción = monto exacto)
- Estimado: ahorros que dependen de un cambio de comportamiento (ej. cambiar hábito = variable)
Etiquétalos explícitamente para que el usuario sepa en qué confiar.

REGLA CRÍTICA — Sin referencias externas específicas:
- NO menciones nombres de productos, apps, servicios o empresas específicas
  (no HelloFresh, no Nu, no GBM, no Pujol, no nombres de restaurantes, no Workana, etc.)
- Deja claro la diference entre un ahorro estimado o seguro. Estimado = utilizaste supuestos o te falta información para confirmar el monto exacto. Seguro = es un monto que lo vez en las transacciones del usuario y que se eliminará completamente.
- NO asumas características de servicios externos (tasas, menús, precios, disponibilidad), esos datos podremos buscarlos en el follow-up, pero no los inventes en la recomendación.
- Sí puedes usar supuestos para estimaciones de ahorro, pero debes ser general y aclarar que es un estimado (ej. Muchos restaurantes ofrecen menús de comida a mitad de precio entre semana, así que si haces ese cambio podrías ahorrar hasta un 50% en cada visita, lo que sería un ahorro estimado de $X al mes).
- SÍ usa los datos reales de las transacciones del usuario (merchants, montos, frecuencias)
- SÍ describe el TIPO de solución (ej. "un servicio de meal kit") sin nombrar marcas
- SÍ puedes mencionar merchants que ya APARECEN en las transacciones del usuario

REGLA DE CIERRE — Follow-up hook:
Al final de CADA recomendación, añade una pregunta de seguimiento en este formato exacto:
💬 [Pregunta corta que invita al usuario a explorar la solución con más detalle, donde puedes confirmar algunas estimaciones o supuestos que hiciste]
Ejemplos:
- "💬 ¿Quieres que busque los mejores servicios de meal kit disponibles en tu zona?"
- "💬 ¿Te busco las opciones de consolidación de deuda con mejores tasas hoy?"
- "💬 ¿Quieres que compare las tarjetas sin anualidad con mayor cashback en México?"
- "💬 ¿Te busco los contadores freelance mejor calificados para tu perfil?"
La pregunta debe ser específica y accionable — que al responder "sí" se pueda hacer algo inmediato.

Diferencias entre una buena y mala recomendación:
- MALA: asume que el gasto desaparece completamente
  BUENA: propone una alternativa que preserve los beneficios no monetarios

- MALA: parte del problema ("gastas demasiado en X")
  BUENA: parte de la meta y la oportunidad ("para llegar a tu meta necesitas $X más al mes")

- MALA: cita precios de servicios externos que no están en los datos del usuario
  BUENA: usa solo montos de las transacciones reales para estimar el ahorro

- MALA: un primer paso grande que requiere cambio inmediato
  BUENA: un primer paso pequeño que construye el hábito gradualmente

- MALA: headers intermedios como "Por qué:", "Cómo:", "Impacto:"
  BUENA: fluye como prosa natural con pasos numerados solo cuando son necesarios

- MALA: Recomienda como quick win visitar restaurantes en un horario más barato Y topar las salidas a 4 al mes
  BUENA: SOLO Recomienda como quick win visitar restaurantes en un horario más barato y propone pasos actionables para ejecutarlo

Sobre el tono:
- Profesional y directo — como un asesor experto, no un coach motivacional
- Sin relleno: nunca uses "es importante", "recuerda que", "considera que"
- Sin mencionar metodologías, autores o frameworks por nombre
- Las categorías de no tocar son intocables — ni las menciones como área de mejora
</principios>

<example>
INPUT:
- Meta: entender a dónde va el dinero y empezar a ahorrar
- Déficit: $6,780/mes
- Quick win: gasto en OXXO $2,406/mes en 29 visitas
  Beneficios no monetarios: proximidad, inmediatez, sin planificación
  Solución: consolidar compras en supermercado donde ya va
- Hábito a construir: delivery $5,730/mes en 21 pedidos
  Beneficios no monetarios: sin cocinar, sin limpiar, buen sabor, inmediato
  Solución: reemplazar delivery entre semana con servicio de comida preparada

OUTPUT:
Para llegar a tu meta de controlar tus finanzas necesitas liberar $6,780 al mes.
Dos cambios — uno que puedes hacer esta semana y uno que construyes gradualmente —
cubren esa brecha por completo, sin tocar los restaurantes que disfrutas.

⚡ Victoria rápida: **Compra en el súper lo que hoy compras en la tienda de conveniencia**

Hay una oportunidad de ahorro estimado de ~$2,100 al mes sin dejar de comprar los mismos
productos. Con 29 visitas en marzo y un ticket promedio de $83, la tienda de conveniencia
se convirtió en tu tienda principal sin que lo notaras. Los mismos productos en supermercados
donde ya compras cuestan entre 30% y 50% menos por unidad.

1. Revisa tus últimas 10 transacciones en tiendas de conveniencia e identifica los 3-5
   productos que más compras.
2. En tu próxima compra en el súper, compara el precio por unidad — si la diferencia
   supera el 20%, cómpralo ahí en mayor volumen.

💬 ¿Quieres que busque qué supermercados en tu zona tienen los mejores precios en los productos que más compras?

Hay una oportunidad de liberar ~$2,400 al mes sin dejar de recibir comida en tu puerta, sin planear, sin desperdiciar ingredientes. Con 18 pedidos en abril, el delivery se convirtió en tu solución por default — y está corriendo en paralelo con $5,500 en despensa que no se está usando. El problema no es que pidas comida: es que no hay ningún sistema que lo reemplace cuando no tienes ganas de pensar.

Un servicio de meal kits cubre exactamente ese hueco: llega a tu puerta, viene porcionado, no requiere planear nada, y tarda 20–30 minutos. El costo ronda los $2,200–$2,500 al mes para cubrir cenas entre semana — versus los $5,140 que estás gastando hoy. Los fines de semana sigues pidiendo lo que quieras.

1. Esta semana busca dos opciones de meal kits o comida preparada disponibles en tu zona y compara el costo por porción vs tu ticket promedio de delivery ($285).
2. Contrata el plan más básico para una semana. El objetivo no es ahorrar desde el día 1, sino verificar que la conveniencia se mantiene.
3. Si funciona, escala a cobertura completa de lunes a viernes en la semana 3.

💬 ¿Quieres que busque y compare los servicios de comida preparada o meal kits disponibles en tu zona con sus precios actuales?

Con ambos cambios liberas ~$6,100 al mes estimados — prácticamente tu déficit completo.

REASONING BEHIND THIS EXAMPLE:
- No se menciona HelloFresh, OXXO, Walmart, ni ninguna marca específica no presente en datos
- El ahorro está etiquetado como "estimado" porque depende de cambio de comportamiento
- El follow-up hook al final de cada recomendación invita a una acción concreta de búsqueda
- La pregunta de seguimiento es específica (qué buscar) y accionable (se puede hacer inmediato)
- Los pasos son progresivos sin asumir información que no tenemos
</example>

Genera el mensaje para este usuario siguiendo los mismos principios.
No copies el ejemplo literalmente — adáptalo a su situación específica.
El ejemplo muestra el razonamiento y el espíritu, no una plantilla a seguir.
`;

  // Append critique notes (flawed/fatal selected solutions)
  let critiqueNotes = '';
  for (const p of (critique?.problems || [])) {
    for (const s of (p.solutions || [])) {
      if (['flawed', 'fatal'].includes(s.verdict) && s.is_selected) {
        const flaw = s.fatal_flaw || (s.assumptions?.[0] || '?');
        critiqueNotes += `\nADVERTENCIA: La solución seleccionada para el problema ${p.rank} tiene un problema: ${flaw}\n`;
      }
      if (s.missing_context && s.is_selected) {
        critiqueNotes += `\nCONTEXTO FALTANTE: ${s.missing_context}\n`;
      }
    }
  }

  // Append user answers
  let answersText = '';
  if (answers && Object.keys(answers).length > 0) {
    answersText = '\n<respuestas_usuario>\n';
    for (const [, val] of Object.entries(answers)) {
      if (val?.answer) {
        answersText += `Pregunta: ${val.question}\n`;
        answersText += `Respuesta: ${val.answer}\n\n`;
      }
    }
    answersText += '</respuestas_usuario>\n';
  }

  if (critiqueNotes || answersText) {
    prompt = prompt.trimEnd();
    prompt += `\n\n<notas_adicionales>${critiqueNotes}${answersText}</notas_adicionales>\n`;
  }

  return prompt;
}

/**
 * Build the first chat message with full context (Cell 6).
 * Ported verbatim from finanzas_prompt_eval_v6.ipynb.
 * Subsequent messages are just the user's text (history carries context).
 */
export function buildPriorSessionsContext(sessions) {
  if (!sessions || !sessions.length) return '';
  let ctx = '<sesiones_anteriores>\n';
  for (const s of [...sessions].reverse()) {
    const date = new Date(s.created_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
    const sum = s.summary;
    ctx += `Sesión del ${date}:\n`;
    ctx += `  Síntesis: ${sum.synthesis}\n`;
    if (sum.agreed?.length) ctx += `  Acordado: ${sum.agreed.map(a => a.action).join(', ')}\n`;
    if (sum.rejected?.length) ctx += `  Rechazado: ${sum.rejected.join(', ')}\n`;
    if (sum.open?.length) ctx += `  Pendiente: ${sum.open.join(', ')}\n`;
    ctx += '\n';
  }
  ctx += '</sesiones_anteriores>\n\n';
  return ctx;
}

export function buildFirstMessage(userQuestion, profileData, analysis, recText, sessionContext = '') {
  const survey = profileData.survey;
  const summary = profileData.summary;
  const meta = profileData.profile_meta;

  let msg = `<perfil_usuario>\n`;
  msg += `Ciudad: ${meta.country || 'México'} | País: ${meta.country || 'México'} | Moneda: ${meta.currency || 'MXN'}\n`;
  msg += `Ingreso mensual: $${fmt(summary.total_income)} ${meta.currency || 'MXN'}\n`;
  msg += `Gasto mensual: $${fmt(summary.total_expenses)} ${meta.currency || 'MXN'}\n`;
  msg += `Balance: $${fmt(Math.abs(summary.net_balance))} ${meta.currency || 'MXN'} de ${analysis.in_deficit ? 'déficit' : 'superávit'}\n`;
  msg += `Meta: ${survey.goal} | Situación: ${survey.situation}\n`;
  msg += `</perfil_usuario>\n\n`;

  if (sessionContext) msg += sessionContext;

  msg += `<analisis_financiero>\n`;
  msg += `Problema: ${analysis.smart_problem}\n`;
  msg += `Síntesis: ${analysis.so_what}\n`;
  msg += `</analisis_financiero>\n\n`;

  msg += `<recomendaciones_recibidas>\n`;
  msg += `${recText}\n`;
  msg += `</recomendaciones_recibidas>\n\n`;

  msg += `<pregunta_usuario>\n`;
  msg += `${userQuestion}\n`;
  msg += `</pregunta_usuario>\n\n`;

  msg += `<soluciones_disponibles_para_pivots>\n`;
  msg += `Soluciones ordenadas por score para cada problema:\n`;

  for (const p of (analysis.prioritized || [])) {
    msg += `Problema ${p.rank}: ${(p.problem || '').slice(0, 80)}\n`;
    const sorted = [...(p.solutions_considered || [])].sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const s of sorted) {
      const isSel = s.option === p.selected_solution?.option ? '★' : ' ';
      msg += `  ${isSel} score=${s.score || 0} ${(s.option || '').slice(0, 70)}\n`;
    }
    msg += `\n`;
  }

  msg += `</soluciones_disponibles_para_pivots>\n\n`;
  msg += `Responde a la pregunta del usuario. Usa búsqueda web solo si necesitas `;
  msg += `confirmar información real y actual que no está en los datos del usuario.\n\n`;
  msg += `<transacciones_completas>\n`;

  const sorted = [...(profileData.transactions || [])].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const t of sorted) {
    msg += `- ${t.date} | ${t.description} | ${t.direction === 'credit' ? '+' : '-'}$${fmt(t.amount)} | ${t.final_category}\n`;
  }

  msg += `</transacciones_completas>`;

  return msg;
}
