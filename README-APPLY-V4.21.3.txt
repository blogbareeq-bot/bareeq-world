تحديث بريق V4.21.3 فوق V4.21.2

1. فك ضغط الحزمة.
2. انسخ كل الملفات والمجلدات الظاهرة داخلها إلى جذر مشروع bareeq-world.
3. اختر Replace files in the destination عند ظهور السؤال.
4. احذف الملف القديم التالي فقط إن بقي موجودًا:
   scripts\capture-header-screens.mjs

لا تحذف مجلد المشروع، ولا مجلد .git، ولا ملفات .env الخاصة بك.

بعد الاستبدال يجب أن يعرض package.json الإصدار 4.21.3.
Commit المقترح:
fix: release V4.21.3 approved header rebuild
