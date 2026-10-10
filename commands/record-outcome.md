---
description: רושם תוצאה עסקית אמיתית — CPL, המרה, סגירה — שגוברת על כל הערכת AI
---

קרא ל-`mcp__model-council__record_outcome` עם: $ARGUMENTS

צריך: `task_id` · `chosen_author` (claude/gpt) · `metric_type` · `metric_value` · `window` · `is_final`.

- **חסר `task_id`?** הרץ `routing_stats` והצג למשתמש את המשימות האחרונות עם התאריך והתקציר, שיזהה איזו. אל תמציא מזהה.
- מדדים אפשריים: `cpl` · `ctr` · `conversion_rate` · `lead_quality` · `close_rate` · `cancellations` · `time_to_complete` · `revisions_needed` · `tests_passed` · `manual_rating`.
- `is_final: false` לקריאת ביניים, `true` כשהחלון נסגר.

**אחרי הרישום:** אם `supersedes_evaluation.contradicted_evaluator` הוא `true` — תגיד את זה במפורש. זה בדיוק הסיגנל המעניין: המציאות לא הסכימה עם השופט, והמציאות מנצחת.

**שים לב:** ערך אחד בלבד לא מכריע השוואה — הוא רק מעיד שמועמד שומש. כדי שהתוצאה תכריע, צריך ערך לשני הצדדים באותו מדד.


---

**אם הכלים `mcp__model-council__*` לא זמינים** — אל תגיד שהשיטה לא זמינה. אותו קוד רץ מהטרמינל:

```bash
cd {{COUNCIL_DIR}} && npx tsx scripts/cli.ts outcome <task_id> --author gpt --metric cpl --value 42 --window "2026-09"
```

כל החוקים למעלה חלים גם שם.
