# EgyDead — Stremio Addon

إضافة Stremio لموقع EgyDead (`tv10.egydead.live`): أفلام ومسلسلات وأنمي مترجمة.

- **19 كتالوجاً**: 10 أفلام (أجنبية، مدبلجة، كرتون، آسيوية، وثائقية، هندية، تركية، أنمي، عربية…) و9 مسلسلات (أجنبية، عربية، تركية، آسيوية، أنمي، كرتون، هندية، مدبلجة، برامج).
- **بحث** داخل كل كتالوج، **صفحات تفاصيل** (قصة، سنة، تصنيفات، بوستر)، وقوائم حلقات كاملة للمسلسلات (المواسم من صفحات `/serie/`).
- **روابط مشاهدة مباشرة**: تُفتح صفحة المشاهدة بـ `POST View=1`، وتُقرأ قائمة مرايات MegaMax عبر Inertia partial reload (نفس آلية إضافة CloudStream المجرّبة)، ثم تُستخرج روابط `.m3u8` / `.mp4` مباشرة من سيرفرات VidMoly وStreamRuby وUqload وMixDrop وVidHide وغيرها، مع `Referer` خاص بكل سيرفر. السيرفرات التي لا تعطي رابطاً مباشراً (مثل Voe وDoodstream) تظهر كخيار "فتح في المتصفح".

## التشغيل المحلي

```bash
npm install
npm start          # http://localhost:7000/manifest.json
```

في Stremio على نفس الجهاز/الشبكة: Addons ← Add addon ← الصق رابط الـ manifest.

اختبار شامل على الموقع الحي (سيرفر شغال مطلوب):

```bash
node test/local-test.js http://localhost:7000
```

## النشر (مطلوب ليعمل على الهاتف/التلفاز)

الإضافة سيرفر يجب أن يكون متاحاً على الإنترنت طوال الوقت:

- **Render**: ارفع المشروع إلى GitHub ثم New Web Service واختر هذا المستودع — ملف `render.yaml` يضبط كل شيء (build: `npm install`، start: `npm start`).
- **Docker / أي VPS أو Hugging Face Spaces**: `docker build -t egydead-stremio . && docker run -p 7000:7000 egydead-stremio`
- بعد النشر، رابط التثبيت هو `https://<your-host>/manifest.json` ويُلصق في Stremio.

## ملاحظات

- دومين EgyDead يتغير أحياناً (بادئة tv10): غيّر `EGYDEAD_BASE` في بيئة التشغيل أو قيمة `BASE` في `src/egydead.js`.
- الروابط المباشرة مؤقتة (بتوكنات من السيرفرات) — الإضافة تجلبها طازجة عند كل طلب مشاهدة وتخزّنها 5 دقائق فقط.
