'use strict';

/**
 * Ticket classification.
 *
 * Deliberately a transparent keyword model rather than an LLM call: the
 * classifier runs on every ticket, and spending a subscription-billed request
 * to decide how to spend a subscription-billed request is a bad trade. The
 * orchestrator can always override with an explicit `class`.
 */

const CLASSES = Object.freeze(['read', 'edit', 'debug', 'hard', 'review']);

/** Ordered: the first rule that matches wins, so put the specific ones first. */
const RULES = [
  {
    // Weighted above every other class on purpose. "review the schema
    // migration" names an ACTION (review) applied to a SUBJECT (migration).
    // The action decides who gets the ticket; letting the subject win would
    // route reviews to whoever the subject matter suggests and quietly break
    // the cross-family independence rule, which is the point of the plugin.
    cls: 'review',
    weight: 5,
    patterns: [
      /\breview\b/i, /\baudit\b/i, /\bcritique\b/i, /\bsanity[- ]check\b/i,
      /\bsecond opinion\b/i, /\bverify\b/i, /\bdouble[- ]check\b/i,
    ],
  },
  {
    cls: 'debug',
    weight: 3,
    patterns: [
      /\bbug\b/i, /\bdebug\b/i, /\bfix(es|ing)?\b/i, /\bbroken\b/i, /\bfail(s|ing|ure)?\b/i,
      /\bregression\b/i, /\bcrash(es|ing)?\b/i, /\bstack ?trace\b/i, /\berror\b/i,
      /\bflak(y|e)\b/i, /\bhang(s|ing)?\b/i, /\bleak\b/i,
    ],
  },
  {
    cls: 'hard',
    weight: 4,
    patterns: [
      /\barchitect(ure|ural)?\b/i, /\bdesign\b/i, /\bredesign\b/i, /\brefactor\b/i,
      /\bmigrat(e|ion)\b/i, /\btrade[- ]?offs?\b/i, /\bstrateg(y|ic)\b/i,
      /\bconcurren(cy|t)\b/i, /\brace condition\b/i, /\bdata model\b/i,
      /\bschema\b/i, /\bperformance\b/i, /\bscal(e|ing|ability)\b/i, /\bsecurity\b/i,
    ],
  },
  {
    cls: 'read',
    weight: 2,
    patterns: [
      /\bexplain\b/i, /\bsummar(y|ise|ize)\b/i, /\bwhat (is|does|are)\b/i, /\bwhere (is|are)\b/i,
      /\bhow does\b/i, /\bdocument\b/i, /\bfind\b/i, /\blocate\b/i, /\bsearch\b/i,
      /\bread\b/i, /\binvestigate\b/i, /\btrace\b/i, /\bwhy does\b/i,
    ],
  },
  {
    cls: 'edit',
    weight: 1,
    patterns: [
      /\badd\b/i, /\bimplement\b/i, /\bwrite\b/i, /\bcreate\b/i, /\bupdate\b/i,
      /\brename\b/i, /\bremove\b/i, /\bdelete\b/i, /\bwire (up|in)\b/i, /\bsupport\b/i,
      /\btest(s)?\b/i, /\bport\b/i,
    ],
  },
];

/**
 * Score every class and take the highest. Weighted so that "fix the flaky test
 * in the auth refactor" lands on 'hard' rather than 'edit' — the expensive
 * signal should win, because under-classifying is what produces bad work.
 */
function classify(ticket) {
  if (typeof ticket === 'string') ticket = { title: ticket };
  if (ticket && CLASSES.includes(ticket.class)) {
    return { class: ticket.class, confidence: 1, explicit: true, scores: {} };
  }

  const text = [ticket?.title, ticket?.description, ticket?.body].filter(Boolean).join('\n');
  if (!text.trim()) return { class: 'edit', confidence: 0, explicit: false, scores: {} };

  const scores = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) scores[rule.cls] += rule.weight;
    }
  }

  let best = 'edit';
  let bestScore = 0;
  for (const cls of CLASSES) {
    if (scores[cls] > bestScore) {
      best = cls;
      bestScore = scores[cls];
    }
  }

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  return {
    class: bestScore === 0 ? 'edit' : best,
    confidence: total === 0 ? 0 : Number((bestScore / total).toFixed(2)),
    explicit: false,
    scores,
  };
}

module.exports = { CLASSES, RULES, classify };
