---
description: מציג את ההגדרות והמדיניות הפעילה של model-council — מודלים, תקציבים, ניתוב, rubrics
---

קרא ל-`mcp__model-council__council_config` עם `section` מ: $ARGUMENTS
(`all` · `models` · `budget` · `routing` · `evaluation` · `privacy` · `rubrics`. ברירת מחדל: `all`.)

הצג בקצרה: המודלים הפעילים · תקציב יומי/חודשי ומה נוצל · ברירות המחדל של הניתוב · ספי ההכרעה · ה-rubrics המותקנים · האם GPT זמין.

אם `gpt_available` הוא `false` — הצג את הסיבה והפנה ל-`docs/WINDOWS-API-KEY.md`.

**לשינוי:** הכל נערך ב-`config/local.json` (לא ב-git, גובר על `config/default.json`), או ב-`.model-council.json` בשורש פרויקט ספציפי. **לעולם לא לשים מפתח באף אחד מהם** — המפתח חי רק במשתנה סביבה.


---

**אם הכלים `mcp__model-council__*` לא זמינים** — אל תגיד שהשיטה לא זמינה. אותו קוד רץ מהטרמינל:

```bash
cd {{COUNCIL_DIR}} && npx tsx scripts/cli.ts status
```

כל החוקים למעלה חלים גם שם.
